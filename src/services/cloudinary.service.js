'use strict';

const crypto = require('crypto');
const axios = require('axios');
const cloudinaryConfig = require('../config/cloudinary');
const AppError = require('../utils/AppError');

const FOLDER_MAP = {
  video: 'w3skool/videos',
  image: 'w3skool/images',
  raw: 'w3skool/files',
};

/**
 * Generate upload signature for direct browser-to-Cloudinary uploads.
 *
 * The signature covers `folder` and `timestamp`. The browser POSTs:
 *   file, api_key, timestamp, signature, folder
 * directly to https://api.cloudinary.com/v1_1/<cloudName>/<resource_type>/upload
 *
 * @param {'video'|'image'|'raw'} kind
 * @returns {{ cloudName: string, apiKey: string, timestamp: number, signature: string, folder: string }}
 */
const generateUploadSignature = (kind) => {
  if (!FOLDER_MAP[kind]) {
    throw new AppError('Invalid upload kind. Must be video, image, or raw.', 400, 'INVALID_UPLOAD_KIND');
  }

  const { cloudName, apiKey, apiSecret } = cloudinaryConfig;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError('Cloudinary credentials are not configured.', 500, 'CLOUDINARY_CONFIG_MISSING');
  }

  const folder = FOLDER_MAP[kind];
  const timestamp = Math.round(Date.now() / 1000);

  // Cloudinary direct upload signature: alphabetical order of params to sign + api_secret, SHA1
  const serialized = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(serialized).digest('hex');

  return {
    cloudName,
    apiKey,
    timestamp,
    signature,
    folder,
  };
};

/**
 * Generate a signed / delivery URL for a Cloudinary asset if needed.
 * Note: When media is uploaded to Cloudinary, `secure_url` is stored in the DB.
 */
const getDeliveryUrl = (publicId, resourceType = 'video') => {
  const { cloudName } = cloudinaryConfig;
  if (!cloudName || !publicId) return null;
  return `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/${publicId}`;
};

/**
 * Server-side upload of a generated PDF buffer to Cloudinary (resource_type: raw).
 * Returns { url, publicId }. Throws AppError if Cloudinary is not configured.
 *
 * @param {Buffer} buffer
 * @param {string} folder
 * @param {string} [publicId]
 */
const uploadPdfBuffer = async (buffer, folder = 'w3skool/certificates', publicId) => {
  const { cloudName, apiKey, apiSecret } = cloudinaryConfig;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError('Cloudinary credentials are not configured.', 500, 'CLOUDINARY_CONFIG_MISSING');
  }

  const timestamp = Math.round(Date.now() / 1000);
  const params = { folder, timestamp };
  if (publicId) params.public_id = publicId;

  // Signature: params sorted alphabetically, joined as k=v&k=v, + api_secret, SHA1
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = crypto.createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');

  const form = new FormData();
  form.append('file', `data:application/pdf;base64,${buffer.toString('base64')}`);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  if (publicId) form.append('public_id', publicId);

  let data;
  try {
    // axios handles spec-compliant FormData and sets the multipart boundary.
    ({ data } = await axios.post(
      `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
      form,
      { timeout: 30000 }
    ));
  } catch (err) {
    throw new AppError(err.response?.data?.error?.message || 'Could not store the certificate PDF.', 502, 'CERT_STORAGE_FAILED');
  }

  return { url: data.secure_url, publicId: data.public_id };
};

/**
 * Delivery probe cache — an asset that is broken now is almost never fixed
 * within a page view, so re-checking on every request is pure waste.
 */
const DELIVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const deliveryCache = new Map();

/** 'video' | 'image' | 'raw' from a Cloudinary delivery URL. */
const resourceTypeFromUrl = (url) => {
  const m = String(url || '').match(/res\.cloudinary\.com\/[^/]+\/([^/]+)\//);
  const type = m ? m[1] : '';
  return ['video', 'image', 'raw'].includes(type) ? type : 'raw';
};

/**
 * Ask the CDN for two bytes of an asset — exactly what a browser will do, but
 * without pulling the whole file. This is the only honest test of "will this
 * load for a student?": it catches missing assets (404) and assets the CDN
 * refuses to serve (401/403).
 *
 * Fails OPEN on network trouble: a DNS/proxy hiccup must never mark a
 * perfectly good file as broken.
 *
 * @returns {Promise<{ok: boolean, status: number, contentType: string|null}>}
 */
const probeDelivery = async (url, { timeoutMs = 8000, ttlMs = DELIVERY_CACHE_TTL_MS } = {}) => {
  if (!url) return { ok: false, status: 0, contentType: null };
  const cached = deliveryCache.get(url);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.value;

  let value;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    const status = res.status;
    value = {
      ok: status === 200 || status === 206,
      status,
      contentType: res.headers.get('content-type'),
    };
    try { await res.arrayBuffer(); } catch { /* body already consumed/irrelevant */ }
  } catch (e) {
    // Timeout or DNS failure: unknown, not broken.
    value = { ok: true, status: 0, contentType: null, uncertain: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  }

  deliveryCache.set(url, { ts: Date.now(), value });
  if (deliveryCache.size > 500) deliveryCache.delete(deliveryCache.keys().next().value);
  return value;
};

/** Is this asset actually servable right now? (true when we can't be sure) */
const isAssetAvailable = async (url) => (await probeDelivery(url)).ok;

/**
 * Verify a freshly uploaded asset before it is attached to course content.
 * Two independent checks, because either one alone misses real failures:
 *   1. delivery  — the CDN must hand back the bytes (catches 404 / 401)
 *   2. account   — the asset must be registered (catches orphaned uploads)
 *
 * @returns {Promise<{ok: boolean, status: number, reason: string}>}
 */
const verifyUploadedAsset = async ({ publicId, url }) => {
  const { cloudName, apiKey, apiSecret } = cloudinaryConfig;

  const delivery = await probeDelivery(url, { ttlMs: 0 });
  if (!delivery.ok) return { ok: false, status: delivery.status, reason: 'DELIVERY_FAILED' };

  if (!publicId || !cloudName || !apiKey || !apiSecret) return { ok: true, status: delivery.status, reason: 'DELIVERY_OK' };

  try {
    const resourceType = resourceTypeFromUrl(url);
    const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/upload/${encodeURIComponent(publicId)}`,
      { headers: { Authorization: auth } }
    );
    if (res.status === 404) return { ok: false, status: 404, reason: 'NOT_IN_ACCOUNT' };
  } catch {
    // Admin API unreachable — the delivery check already passed, so accept.
  }

  return { ok: true, status: delivery.status, reason: 'OK' };
};

module.exports = {
  generateUploadSignature,
  getDeliveryUrl,
  uploadPdfBuffer,
  probeDelivery,
  isAssetAvailable,
  verifyUploadedAsset,
  resourceTypeFromUrl,
};
