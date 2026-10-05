'use strict';

const Course = require('../models/Course');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Subaccount = require('../models/Subaccount');
const { amountBreakdown, revenueSplit } = require('../config/platform');
const { createEnrollment } = require('./enrollment.service');
const { sendPurchase } = require('./email.service');
const AppError = require('../utils/AppError');

/** Resolve the course owner's active Flutterwave subaccount (or null). */
const resolveOwnerSubaccount = async (course) => {
  if (!course.owner) return { ownerId: null, subaccount: null };
  const sub = await Subaccount.findOne({ adminId: course.owner, status: 'active' }).lean();
  return { ownerId: course.owner, subaccount: sub || null };
};

/** Is a redirect URL on the allowed client origin? */
const isAllowedRedirect = (redirectUrl) => {
  try {
    const clientUrl = process.env.CLIENT_URL || '';
    if (redirectUrl.startsWith(clientUrl)) return true;
    const parsed = new URL(redirectUrl);
    const clientParsed = new URL(clientUrl);
    return parsed.hostname === clientParsed.hostname;
  } catch (_) {
    return false;
  }
};

/**
 * Build the Flutterwave `subaccounts` split payload for checkout/initiation.
 * Verified semantics (BACKEND_IMPLEMENTATION_PLAN.md §12): transaction_split_ratio
 * is RELATIVE — one owner subaccount with ratio 9 plus the merchant remainder 1
 * gives the owner 90% and W3Skool/platform 10%. transaction_charge_type
 * 'flat_subaccount' puts the Flutterwave fee on the subaccount (owner) side.
 *
 * @param {Object|null} subaccount - lean Subaccount doc (owner's payout account)
 * @param {number} feeFallback - fee used when FLUTTERWAVE_SUBACCOUNT_FEE is unset
 * @returns {Array<Object>|null} null when the owner has no active subaccount
 */
const buildSubaccounts = (subaccount, feeFallback) => {
  if (!subaccount?.flwSubaccountId) return null;
  const feeAll = Number(process.env.FLUTTERWAVE_SUBACCOUNT_FEE || feeFallback) || 0;
  return [
    {
      id: subaccount.flwSubaccountId,
      transaction_split_ratio: 9,
      transaction_charge: feeAll,
      transaction_charge_type: 'flat_subaccount',
    },
  ];
};

/**
 * Prepare a trusted Flutterwave window-checkout configuration + amount summary.
 * Creates a pending Payment. The client never supplies amount/split/txRef.
 *
 * @returns {Promise<Object>} { paymentRequired, ... } or { paymentRequired:false, courseId }
 */
const buildCheckout = async ({ userId, courseId, redirectUrl }) => {
  const course = await Course.findOne({ _id: courseId, status: 'published' }).lean();
  if (!course) throw new AppError('Course not found or not available.', 404, 'NOT_FOUND');

  const price = course.discountPrice != null && course.discountPrice < course.price ? course.discountPrice : course.price;
  const breakdown = amountBreakdown(price);

  if (!breakdown.coursePrice || breakdown.coursePrice === 0) {
    await createEnrollment({ userId, courseId, paymentId: null });
    return { paymentRequired: false, courseId };
  }

  const { ownerId, subaccount } = await resolveOwnerSubaccount(course);
  if (ownerId && !subaccount) {
    throw new AppError('This course is not accepting payments yet. Please try again later.', 409, 'PAYOUT_NOT_SETUP');
  }

  const user = await User.findById(userId).select('name email phone').lean();
  const txRef = `w3s_${courseId}_${userId}_${Date.now()}`;
  const currency = course.currency || 'NGN';
  const split = revenueSplit(breakdown.coursePrice);

  const payment = await Payment.create({
    userId,
    courseId,
    txRef,
    amount: breakdown.total,
    baseAmount: breakdown.coursePrice,
    feeAmount: breakdown.flutterwaveFee,
    totalAmount: breakdown.total,
    currency,
    status: 'pending',
    ownerId,
    subaccountId: subaccount?.flwSubaccountId || null,
    ownerShare: ownerId ? split.ownerShare : null,
    platformShare: ownerId ? split.platformShare : breakdown.coursePrice,
    ownerPercent: ownerId ? split.ownerPercent : null,
    platformPercent: ownerId ? split.platformPercent : 1,
  });

  const config = {
    public_key: process.env.FLUTTERWAVE_PUBLIC_KEY,
    tx_ref: txRef,
    amount: breakdown.total,
    currency,
    payment_options: 'card,banktransfer,ussd',
    redirect_url: redirectUrl,
    customer: { email: user?.email || '', name: user?.name || '', phonenumber: user?.phone || '' },
    customizations: {
      title: 'W3Skool',
      description: course.title,
      logo: `${process.env.API_PUBLIC_URL || ''}/assets/logo.png`,
    },
    meta: { courseId: String(courseId), userId: String(userId) },
  };

  // Owner 90% / platform 10% split — shared with POST /payments/initiate.
  const subaccounts = buildSubaccounts(subaccount, breakdown.flutterwaveFee);
  if (subaccounts) config.subaccounts = subaccounts;

  return {
    paymentRequired: true,
    paymentId: payment._id,
    currency,
    txRef,
    summary: breakdown,
    config,
  };
};

/**
 * Idempotently fulfill a verified payment: mark verified once, create enrollment
 * once, send the purchase email once. Safe under duplicate webhook/verify calls.
 *
 * @returns {Promise<{ fulfilled: boolean }>}
 */
const fulfillPayment = async (payment, fwData) => {
  // Atomic claim — only one caller flips fulfilledAt from null.
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, fulfilledAt: null },
    {
      $set: {
        status: 'verified',
        flwTransactionId: fwData?.id || payment.flwTransactionId,
        paidAt: new Date(),
        metadata: fwData || null,
        fulfilledAt: new Date(),
      },
    },
    { new: true }
  );

  if (!claimed) {
    // Someone else already fulfilled (or it was already verified).
    const fresh = await Payment.findById(payment._id).lean();
    if (fresh?.status !== 'verified') {
      await Payment.findByIdAndUpdate(payment._id, { status: 'verified', paidAt: fresh?.paidAt || new Date() });
    }
    return { fulfilled: false };
  }

  await createEnrollment({ userId: claimed.userId, courseId: claimed.courseId, paymentId: claimed._id });

  // Purchase email (idempotent on payment id)
  try {
    const [user, course] = await Promise.all([
      User.findById(claimed.userId).select('name email').lean(),
      Course.findById(claimed.courseId).select('title').lean(),
    ]);
    if (user?.email) {
      sendPurchase({
        paymentId: claimed._id.toString(),
        name: user.name,
        email: user.email,
        courseTitle: course?.title || 'W3Skool Course',
        amount: claimed.totalAmount ?? claimed.amount,
        currency: claimed.currency,
      });
    }
  } catch (e) {
    console.error('[Payment] purchase email failed:', e.message);
  }

  return { fulfilled: true };
};

module.exports = {
  buildCheckout,
  buildSubaccounts,
  fulfillPayment,
  resolveOwnerSubaccount,
  isAllowedRedirect,
};