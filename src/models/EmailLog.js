'use strict';

const mongoose = require('mongoose');

/**
 * Transactional email log + idempotency guard.
 * `eventKey` is a unique, deterministic key per logical email (e.g.
 *   `welcome:<userId>`, `purchase:<paymentId>`, `certificate:<certId>`,
 *   `live:<sessionId>:<updatedAtMs>`). Sending checks/creates this record first,
 * so retries never send duplicates.
 */
const emailLogSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ['welcome', 'purchase', 'certificate', 'live_session', 'password_reset', 'other'],
      required: true,
    },
    to: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending',
    },
    provider: { type: String, default: 'brevo' },
    messageId: { type: String, default: null },
    error: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

emailLogSchema.index({ type: 1, createdAt: -1 });

emailLogSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('EmailLog', emailLogSchema);
