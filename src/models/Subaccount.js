'use strict';

const mongoose = require('mongoose');

/**
 * An admin's Flutterwave payout subaccount.
 * One per admin (owner). Never stores Flutterwave secret credentials — only the
 * public subaccount id Flutterwave returns.
 */
const subaccountSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    // Flutterwave subaccount id (from POST /v3/subaccounts)
    flwSubaccountId: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'failed'],
      default: 'pending',
    },
    bankCode: { type: String, required: true },
    bankName: { type: String },
    accountNumber: { type: String, required: true },
    accountName: { type: String },
    businessName: { type: String, required: true },
    businessEmail: { type: String },
    businessContact: { type: String },
    businessMobile: { type: String },
    country: { type: String, default: 'NG' },
    // Flutterwave split semantics. See BACKEND_IMPLEMENTATION_PLAN.md §7.
    splitType: { type: String, enum: ['percentage', 'flat'], default: 'percentage' },
    // 0.9 => owner keeps 90%. (percentage mode)
    splitValue: { type: Number, default: 0.9 },
  },
  { timestamps: true }
);

subaccountSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.adminId;
    return ret;
  },
});

module.exports = mongoose.model('Subaccount', subaccountSchema);
