'use strict';

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    // Format: 'w3s_<courseId>_<userId>_<timestamp>'
    txRef: {
      type: String,
      required: true,
      unique: true,
    },
    // Flutterwave's transaction id — populated after webhook / verification
    flwTransactionId: {
      type: String,
      default: null,
    },
    amount: {
      type: Number,
      required: true,
    },
    // Audit breakdown (all server-computed; the client never supplies these)
    baseAmount: { type: Number, default: null },     // course price
    feeAmount: { type: Number, default: 0 },          // Flutterwave transaction fee borne by the student
    totalAmount: { type: Number, default: null },     // baseAmount + feeAmount = what the student is charged
    currency: {
      type: String,
      default: 'NGN',
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    subaccountId: { type: String, default: null },    // Flutterwave subaccount id used for the split
    platformShare: { type: Number, default: null },
    ownerShare: { type: Number, default: null },
    platformPercent: { type: Number, default: null },  // e.g. 0.10
    ownerPercent: { type: Number, default: null },     // e.g. 0.90
    // Guards fulfillment exactly once (webhook + verify races)
    fulfilledAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['pending', 'verified', 'failed'],
      default: 'pending',
    },
    // Raw Flutterwave verification response payload
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

paymentSchema.index({ userId: 1 });
paymentSchema.index({ courseId: 1 });
paymentSchema.index({ status: 1 });

paymentSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Payment', paymentSchema);
