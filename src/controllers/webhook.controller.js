'use strict';

const Payment = require('../models/Payment');
const { verifyWebhookHash, verifyTransaction } = require('../services/flutterwave.service');
const { fulfillPayment } = require('../services/payment.service');

/**
 * POST /webhooks/flutterwave
 *
 * IMPORTANT: req.body is a raw Buffer (express.raw middleware applied in app.js
 * before this route). Do NOT apply express.json() to this route.
 */
const flutterwaveWebhook = async (req, res) => {
  try {
    // ── 1. Hash verification ─────────────────────────────────────────────────
    const hash = req.headers['verif-hash'];

    if (!hash) {
      return res.status(401).json({ error: 'Missing verif-hash header.' });
    }

    if (!verifyWebhookHash(hash)) {
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    // ── 2. Parse raw body ────────────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(req.body.toString());
    } catch (_) {
      return res.status(400).json({ error: 'Invalid JSON payload.' });
    }

    // ── 3. Only handle charge.completed ─────────────────────────────────────
    if (payload.event !== 'charge.completed') {
      return res.status(200).json({ received: true });
    }

    const data = payload.data || {};
    const txRef = data.tx_ref;
    const transactionId = data.id;

    if (!txRef || !transactionId) {
      return res.status(200).json({ received: true });
    }

    // ── 4. Find our payment record ───────────────────────────────────────────
    const payment = await Payment.findOne({ txRef });

    if (!payment) {
      // Unknown transaction — not ours; acknowledge silently
      return res.status(200).json({ received: true });
    }

    // ── 5. Idempotency guard (fulfilled => nothing left to do) ───────────────
    if (payment.status === 'verified' && payment.fulfilledAt) {
      return res.status(200).json({ received: true });
    }

    // ── 6. Re-verify with Flutterwave API ────────────────────────────────────
    let fwData;
    try {
      fwData = await verifyTransaction(transactionId);
    } catch (err) {
      // Cannot confirm — do not update, let Flutterwave retry
      console.error('[Webhook] FW verify failed:', err.message);
      return res.status(500).json({ error: 'Verification failed. Will retry.' });
    }

    const isValid =
      fwData.txRef === payment.txRef &&
      Number(fwData.amount) >= Number(payment.amount) &&
      fwData.currency === payment.currency &&
      fwData.status === 'successful';

    if (!isValid) {
      await Payment.findByIdAndUpdate(payment._id, { status: 'failed' });
      return res.status(200).json({ received: true });
    }

    // ── 7. Idempotent fulfillment (verify → enroll → email, exactly once) ────
    await fulfillPayment(payment, fwData);

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Webhook] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

module.exports = { flutterwaveWebhook };
