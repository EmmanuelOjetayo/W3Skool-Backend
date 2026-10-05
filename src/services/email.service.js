'use strict';

const axios = require('axios');
const EmailLog = require('../models/EmailLog');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const sender = () => ({
  email: process.env.BREVO_SENDER_EMAIL || 'no-reply@w3skool.com',
  name: process.env.BREVO_SENDER_NAME || 'W3Skool',
});

const layout = (title, bodyHtml, ctaUrl, ctaLabel) => `
<!doctype html><html><body style="margin:0;background:#F8FDF8;font-family:Figtree,Arial,sans-serif;color:#0B2E2C">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="text-align:center;padding:8px 0">
      <span style="font-size:20px;font-weight:800;color:#15A06B">W3Skool</span>
    </div>
    <div style="background:#fff;border:1px solid #D8EBE0;border-radius:14px;padding:24px">
      <h1 style="margin:0 0 12px;font-size:20px;color:#011110">${title}</h1>
      <div style="font-size:15px;line-height:1.6;color:#0B2E2C">${bodyHtml}</div>
      ${ctaUrl ? `<p style="margin:24px 0 0"><a href="${ctaUrl}" style="display:inline-block;background:#97F75F;color:#011110;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${ctaLabel || 'Open W3Skool'}</a></p>` : ''}
    </div>
    <p style="text-align:center;color:#5B6B66;font-size:12px;margin-top:16px">© ${new Date().getFullYear()} W3Skool · learn tech with structure and real teachers.</p>
  </div>
</body></html>`;

/**
 * Send a transactional email exactly once per eventKey.
 * Idempotent: a second call with the same eventKey is a no-op.
 *
 * @param {Object} p
 * @param {string} p.eventKey  - unique logical key, e.g. 'welcome:<userId>'
 * @param {string} p.type      - EmailLog type
 * @param {string} p.to
 * @param {string} p.subject
 * @param {string} p.html
 * @returns {Promise<{ sent: boolean, skipped?: boolean, messageId?: string }>}
 */
const sendOnce = async ({ eventKey, type, to, subject, html }) => {
  // Reserve the eventKey atomically — the unique index guarantees one winner.
  let log;
  try {
    log = await EmailLog.create({ eventKey, type, to, status: 'pending' });
  } catch (err) {
    if (err.code === 11000) return { sent: false, skipped: true };
    throw err;
  }

  if (!process.env.BREVO_API_KEY) {
    console.error('[Email] BREVO_API_KEY not configured — cannot send mail.');
    await EmailLog.findByIdAndUpdate(log._id, { status: 'failed', error: 'BREVO_API_KEY not configured' });
    return { sent: false, skipped: false, error: 'BREVO_API_KEY not configured' };
  }

  try {
    const { data } = await axios.post(
      BREVO_URL,
      { sender: sender(), to: [{ email: to }], subject, htmlContent: html },
      { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    await EmailLog.findByIdAndUpdate(log._id, {
      status: 'sent',
      messageId: data?.messageId || null,
      sentAt: new Date(),
    });
    return { sent: true, messageId: data?.messageId || null };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'send failed';
    await EmailLog.findByIdAndUpdate(log._id, { status: 'failed', error: String(msg) });
    // Surface provider errors (e.g. Brevo IP authorisation) in the server log —
    // otherwise a failed send is only visible by querying the emaillogs collection.
    console.error(`[Email] ${type} to ${to} failed: ${msg}`);
    return { sent: false, error: String(msg) };
  }
};

/** Fire-and-forget wrapper so callers never block on email. */
const sendOnceAsync = (params) => {
  sendOnce(params).catch((e) => console.error('[Email] Unhandled:', e.message));
};

// ── Templated senders ─────────────────────────────────────────────────────────

const sendWelcome = ({ userId, name, email }) => sendOnceAsync({
  eventKey: `welcome:${userId}`,
  type: 'welcome',
  to: email,
  subject: 'Welcome to W3Skool',
  html: layout(
    `Welcome, ${name.split(' ')[0]}!`,
    '<p>You’re all set. Browse courses, preview free lessons, and learn step by step.</p>',
    `${process.env.CLIENT_URL || ''}/courses`,
    'Browse courses'
  ),
});

const sendPurchase = ({ paymentId, name, email, courseTitle, amount, currency }) => sendOnceAsync({
  eventKey: `purchase:${paymentId}`,
  type: 'purchase',
  to: email,
  subject: `You're enrolled: ${courseTitle}`,
  html: layout(
    'Payment confirmed 🎉',
    `<p>Hi ${name.split(' ')[0]}, your payment of <b>${currency} ${amount}</b> was successful and you’re now enrolled in <b>${courseTitle}</b>.</p>`,
    `${process.env.CLIENT_URL || ''}/my-courses`,
    'Start learning'
  ),
});

const sendCertificate = ({ certId, name, email, courseTitle, code, verifyUrl, pdfUrl }) => sendOnceAsync({
  eventKey: `certificate:${certId}`,
  type: 'certificate',
  to: email,
  subject: `Your certificate for ${courseTitle} is ready`,
  html: layout(
    'Congratulations! 🏆',
    `<p>Hi ${name.split(' ')[0]}, you completed <b>${courseTitle}</b>.</p>
     <p>Certificate ID: <b>${code}</b><br/>Verify at <a href="${verifyUrl}">${verifyUrl}</a></p>
     ${pdfUrl ? `<p><a href="${pdfUrl}">Download your certificate (PDF)</a></p>` : ''}`,
    verifyUrl,
    'View certificate'
  ),
});

const sendLiveSession = ({ sessionId, revision, email, name, title, courseTitle, startsAt, platform, joinUrl }) => sendOnceAsync({
  eventKey: `live:${sessionId}:${revision}`,
  type: 'live_session',
  to: email,
  subject: `Live class: ${title}`,
  html: layout(
    'New live class scheduled 📅',
    `<p>Hi ${name.split(' ')[0]}, a live class for <b>${courseTitle}</b> has been scheduled.</p>
     <p><b>${title}</b><br/>${new Date(startsAt).toLocaleString('en-NG')}<br/>Platform: ${platform}</p>`,
    joinUrl,
    'Join class'
  ),
});

const sendPasswordReset = ({ userId, token, name, email, resetUrl }) => sendOnceAsync({
  eventKey: `password_reset:${userId}:${token.slice(0, 12)}`,
  type: 'password_reset',
  to: email,
  subject: 'Reset your W3Skool password',
  html: layout(
    'Reset your password',
    `<p>Hi ${name.split(' ')[0]}, we received a request to reset your password. This link expires in 30 minutes.</p>
     <p>If you didn’t request this, you can safely ignore this email.</p>`,
    resetUrl,
    'Reset password'
  ),
});

module.exports = {
  sendOnce,
  sendOnceAsync,
  layout,
  sendWelcome,
  sendPurchase,
  sendCertificate,
  sendLiveSession,
  sendPasswordReset,
};