'use strict';

const Subaccount = require('../../models/Subaccount');
const Course = require('../../models/Course');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const fw = require('../../services/flutterwave.service');
const { platform } = require('../../config/platform');

const mask = (n) => (n ? `****${String(n).slice(-4)}` : null);

/** Never expose secrets; mask the account number. */
const shape = (s) => (s ? {
  id: s._id,
  flwSubaccountId: s.flwSubaccountId,
  status: s.status,
  bankCode: s.bankCode,
  bankName: s.bankName || null,
  accountNumber: mask(s.accountNumber),
  accountName: s.accountName || null,
  businessName: s.businessName,
  businessEmail: s.businessEmail || null,
  country: s.country,
  splitType: s.splitType,
  splitValue: s.splitValue,
  createdAt: s.createdAt,
} : null);

const validateBody = (b) => {
  const missing = ['businessName', 'businessEmail', 'businessContact', 'bankCode', 'accountNumber'].filter((k) => !b[k]);
  return missing.length ? `Missing required field(s): ${missing.join(', ')}.` : null;
};

/** GET /admin/payouts */
const getPayoutStatus = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const sub = await Subaccount.findOne({ adminId }).lean();
  const courses = await Course.find({ owner: adminId }).select('title status price').lean();
  const active = !!(sub && sub.status === 'active' && sub.flwSubaccountId);

  sendSuccess(res, {
    connected: active,
    subaccount: shape(sub),
    courses: courses.map((c) => ({ id: c._id, title: c.title, status: c.status, attached: active })),
    instructions: [
      'Add the bank account where you want your earnings paid.',
      'We verify the account name before creating your Flutterwave subaccount.',
      `You keep ${Math.round((1 - platform.platformPercent) * 100)}% of each sale; W3Skool keeps ${Math.round(platform.platformPercent * 100)}%.`,
    ],
  });
});

/** GET /admin/payouts/subaccount */
const getSubaccount = asyncHandler(async (req, res) => {
  const sub = await Subaccount.findOne({ adminId: req.user.id }).lean();
  sendSuccess(res, { subaccount: shape(sub) });
});

/** GET /admin/payouts/banks?country=NG */
const getBanks = asyncHandler(async (req, res) => {
  const country = req.query.country || 'NG';
  try {
    const banks = await fw.listBanks(country);
    return sendSuccess(res, banks);
  } catch (err) {
    // Flutterwave bank lookup failed (most likely placeholder/invalid secret key).
    // The admin UI has its own curated NG fallback, so surface the real reason.
    return sendError(res, err.message, err.statusCode || 502, err.code || 'PAYOUT_RESOLVE_FAILED');
  }
});

/** GET /admin/payouts/resolve?bankCode=&accountNumber= */
const resolveAccountCtrl = asyncHandler(async (req, res) => {
  const { bankCode, accountNumber } = req.query;
  if (!bankCode || !accountNumber) {
    return sendError(res, 'bankCode and accountNumber are required.', 422, 'VALIDATION_ERROR');
  }
  try {
    const result = await fw.resolveAccount({ bankCode, accountNumber });
    return sendSuccess(res, result);
  } catch (err) {
    return sendError(res, err.message, err.statusCode || 502, err.code || 'PAYOUT_RESOLVE_FAILED');
  }
});

/** POST /admin/payouts/subaccount */
const createSubaccountCtrl = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const err = validateBody(req.body);
  if (err) return sendError(res, err, 422, 'VALIDATION_ERROR');

  const existing = await Subaccount.findOne({ adminId });
  if (existing && existing.status === 'active' && existing.flwSubaccountId) {
    return sendError(res, 'You already have an active payout account. Update it instead.', 409, 'ALREADY_EXISTS');
  }

  const {
    businessName, businessEmail, businessContact, businessMobile,
    country = 'NG', bankCode, accountNumber, accountName, bankName,
  } = req.body;

  // Verify the account name with Flutterwave before creating the subaccount.
  // If the caller supplied `accountName` manually (mobile-money banks that the
  // resolve endpoint may not cover), accept it instead of hard-failing when
  // Flutterwave itself is unreachable or rejects the key.
  let resolvedName = accountName || null;
  try {
    const r = await fw.resolveAccount({ bankCode, accountNumber });
    resolvedName = r.accountName || resolvedName;
  } catch (e) {
    if (!resolvedName) return sendError(res, e.message, e.statusCode || 502, e.code || 'PAYOUT_RESOLVE_FAILED');
  }

  let created;
  try {
    created = await fw.createSubaccount({
      accountBank: bankCode,
      accountNumber,
      businessName,
      businessEmail,
      businessContact,
      businessContactMobile: businessMobile,
      country,
      splitType: 'percentage',
      splitValue: 1 - platform.platformPercent, // 0.9 → owner keeps 90%
    });
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 502, e.code || 'PAYOUT_CREATE_FAILED');
  }

  const doc = await Subaccount.findOneAndUpdate(
    { adminId },
    {
      $set: {
        flwSubaccountId: created.subaccountId,
        status: 'active',
        bankCode, bankName: bankName || null, accountNumber,
        accountName: resolvedName,
        businessName, businessEmail, businessContact, businessMobile,
        country,
        splitType: 'percentage',
        splitValue: 1 - platform.platformPercent,
      },
    },
    { upsert: true, new: true }
  );

  sendSuccess(res, { connected: true, subaccount: shape(doc) }, 201);
});

/** PATCH /admin/payouts/subaccount */
const updateSubaccountCtrl = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const doc = await Subaccount.findOne({ adminId });
  if (!doc) return sendError(res, 'No payout account found. Create one first.', 404, 'PAYOUT_NOT_FOUND');

  const { businessName, businessContact, businessMobile } = req.body;

  if (doc.flwSubaccountId) {
    try {
      await fw.updateSubaccount(doc.flwSubaccountId, {
        businessName: businessName || doc.businessName,
        businessContact: businessContact || doc.businessContact,
        businessContactMobile: businessMobile || doc.businessMobile,
        splitValue: 1 - platform.platformPercent,
      });
    } catch (e) {
      return sendError(res, e.message, e.statusCode || 502, e.code || 'PAYOUT_CREATE_FAILED');
    }
  }

  if (businessName !== undefined) doc.businessName = businessName;
  if (businessContact !== undefined) doc.businessContact = businessContact;
  if (businessMobile !== undefined) doc.businessMobile = businessMobile;
  doc.splitValue = 1 - platform.platformPercent;
  await doc.save();

  sendSuccess(res, { connected: doc.status === 'active', subaccount: shape(doc) });
});

module.exports = {
  getPayoutStatus,
  getSubaccount,
  getBanks,
  resolveAccountCtrl,
  createSubaccountCtrl,
  updateSubaccountCtrl,
};