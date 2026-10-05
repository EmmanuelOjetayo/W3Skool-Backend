'use strict';

const Course = require('../models/Course');
const Payment = require('../models/Payment');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/response');
const { initiateStandardPayment, verifyTransaction } = require('../services/flutterwave.service');
const { createEnrollment, isEnrolled } = require('../services/enrollment.service');
const { buildCheckout, fulfillPayment, isAllowedRedirect, resolveOwnerSubaccount, buildSubaccounts } = require('../services/payment.service');
const { amountBreakdown, revenueSplit } = require('../config/platform');

// ─── Helpers ─────────────────────────────────────────────────────────────────
// isAllowedRedirect is imported from services/payment.service.

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /payments/checkout
 * Body: { courseId, redirectUrl }
 * Returns the trusted Flutterwave window-checkout config + amount summary.
 * The client never supplies amount, fee, split or txRef.
 */
const checkoutPayment = asyncHandler(async (req, res) => {
  const { courseId, redirectUrl } = req.body;
  const userId = req.user.id;

  if (!courseId) return sendError(res, 'courseId is required.', 400, 'VALIDATION_ERROR');
  if (!redirectUrl) return sendError(res, 'redirectUrl is required.', 400, 'VALIDATION_ERROR');
  if (!isAllowedRedirect(redirectUrl)) {
    return sendError(res, 'Invalid redirectUrl. Must point to the client origin.', 400, 'VALIDATION_ERROR');
  }

  const alreadyEnrolled = await isEnrolled(userId, courseId);
  if (alreadyEnrolled) {
    return sendError(res, 'You are already enrolled in this course.', 409, 'ALREADY_ENROLLED');
  }

  const result = await buildCheckout({ userId, courseId, redirectUrl });

  if (!result.paymentRequired) {
    return sendSuccess(res, { paymentRequired: false, courseId });
  }

  return sendSuccess(res, {
    paymentRequired: true,
    txRef: result.txRef,
    currency: result.currency,
    summary: result.summary,
    config: result.config,
  });
});

/**
 * POST /payments/initiate
 * Body: { courseId, redirectUrl }
 */
const initiatePayment = asyncHandler(async (req, res) => {
  const { courseId, redirectUrl } = req.body;
  const userId = req.user.id;

  if (!courseId) {
    return sendError(res, 'courseId is required.', 400, 'VALIDATION_ERROR');
  }
  if (!redirectUrl) {
    return sendError(res, 'redirectUrl is required.', 400, 'VALIDATION_ERROR');
  }
  if (!isAllowedRedirect(redirectUrl)) {
    return sendError(res, 'Invalid redirectUrl. Must point to the client origin.', 400, 'VALIDATION_ERROR');
  }

  const course = await Course.findOne({ _id: courseId, status: 'published' }).lean();
  if (!course) {
    return sendError(res, 'Course not found or not available.', 404, 'NOT_FOUND');
  }

  const alreadyEnrolled = await isEnrolled(userId, courseId);
  if (alreadyEnrolled) {
    return sendError(res, 'You are already enrolled in this course.', 409, 'ALREADY_ENROLLED');
  }

  // Free course — enroll immediately
  if (!course.price || course.price === 0) {
    await createEnrollment({ userId, courseId, paymentId: null });
    return sendSuccess(res, { paymentRequired: false, courseId });
  }

  // Paid course — same trusted amount/split math as POST /payments/checkout.
  const price = course.discountPrice != null && course.discountPrice < course.price ? course.discountPrice : course.price;
  const breakdown = amountBreakdown(price);

  // Discounted-to-free course — enroll immediately (mirrors buildCheckout).
  if (!breakdown.coursePrice) {
    await createEnrollment({ userId, courseId, paymentId: null });
    return sendSuccess(res, { paymentRequired: false, courseId });
  }

  // The owner must have an active payout subaccount or the money cannot be routed.
  const { ownerId, subaccount } = await resolveOwnerSubaccount(course);
  if (ownerId && !subaccount) {
    return sendError(res, 'This course is not accepting payments yet. Please try again later.', 409, 'PAYOUT_NOT_SETUP');
  }

  const user = await User.findById(userId).lean();

  const txRef = `w3s_${courseId}_${userId}_${Date.now()}`;
  const currency = course.currency || 'NGN';
  const split = revenueSplit(breakdown.coursePrice);
  const subaccounts = buildSubaccounts(subaccount, breakdown.flutterwaveFee);

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

  let paymentResult;
  try {
    paymentResult = await initiateStandardPayment({
      txRef,
      amount: breakdown.total,
      currency,
      customerEmail: user.email,
      customerName: user.name,
      customerPhone: user.phone,
      courseTitle: course.title,
      redirectUrl,
      subaccounts,
    });
  } catch (err) {
    await Payment.findByIdAndDelete(payment._id);
    return sendError(res, 'Could not initiate payment. Please try again.', 502, 'PAYMENT_INIT_FAILED');
  }

  return sendSuccess(res, {
    paymentRequired: true,
    paymentLink: paymentResult.paymentLink,
    txRef,
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY,
    amount: breakdown.total,
    currency,
    customer: {
      email: user.email,
      name: user.name,
      phone: user.phone || '',
    },
    customizations: {
      title: 'W3Skool',
      description: course.title,
    },
  });
});

/**
 * GET /payments/verify?txRef=...&transactionId=...
 */
const verifyPayment = asyncHandler(async (req, res) => {
  const { txRef, transactionId } = req.query;
  const userId = req.user.id;

  if (!txRef) {
    return sendError(res, 'txRef query parameter is required.', 400, 'VALIDATION_ERROR');
  }

  const payment = await Payment.findOne({ txRef }).lean();

  if (!payment) {
    return sendError(res, 'Payment record not found.', 404, 'NOT_FOUND');
  }

  if (payment.userId.toString() !== userId.toString()) {
    return sendError(res, 'You are not authorised to verify this payment.', 403, 'FORBIDDEN');
  }

  const course = await Course.findById(payment.courseId).lean();
  const courseTitle = course?.title || '';

  // Already resolved
  if (payment.status === 'verified') {
    return sendSuccess(res, { status: 'verified', courseId: payment.courseId, courseTitle });
  }
  if (payment.status === 'failed') {
    return sendSuccess(res, { status: 'failed', courseId: payment.courseId, courseTitle, message: 'Payment was unsuccessful.' });
  }

  if (!transactionId) {
    return sendError(res, 'transactionId query parameter is required.', 400, 'VALIDATION_ERROR');
  }

  // Verify with Flutterwave
  let fwData;
  try {
    fwData = await verifyTransaction(transactionId);
  } catch (err) {
    return sendError(res, 'Could not verify transaction with payment provider.', 502, 'PAYMENT_VERIFY_FAILED');
  }

  const isValid =
    fwData.txRef === payment.txRef &&
    Number(fwData.amount) >= Number(payment.amount) &&
    fwData.currency === payment.currency &&
    fwData.status === 'successful';

  if (!isValid) {
    await Payment.findByIdAndUpdate(payment._id, { status: 'failed' });
    return sendSuccess(res, { status: 'failed', courseId: payment.courseId, courseTitle, message: 'Payment was unsuccessful.' });
  }

  // Idempotent fulfillment: mark verified once, enroll once, email once
  await fulfillPayment(payment, { ...fwData, id: fwData.id || transactionId });

  return sendSuccess(res, { status: 'verified', courseId: payment.courseId, courseTitle });
});

module.exports = { initiatePayment, verifyPayment, checkoutPayment };
