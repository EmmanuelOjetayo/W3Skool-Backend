'use strict';

/**
 * Platform / business configuration — the single place business numbers live.
 *
 * Verified Flutterwave semantics (see BACKEND_IMPLEMENTATION_PLAN.md §7):
 *  - Subaccount `split_type: 'percentage'` + `split_value` is the fraction that
 *    goes to the SUBACCOUNT (the course owner). So owner 90% => split_value 0.9.
 *  - The remainder (1 - split_value) stays with the platform/merchant account.
 *  - Flutterwave deducts its own transaction fee from the merchant side; the
 *    student also bears the fee here, so we add it to the amount charged
 *    (see FLUTTERWAVE_PLATFORM_FEE_PCT).
 */

const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

const OWNER_SPLIT = 1 - num(process.env.PLATFORM_SPLIT_PERCENT, 0.1); // 0.90

const platform = {
  currency: 'NGN',
  /** Fraction of the course price that goes to the course owner via subaccount. */
  ownerPercent: OWNER_SPLIT,
  /** Fraction that stays with the platform. */
  platformPercent: 1 - OWNER_SPLIT,
  /** Flutterwave transaction fee percent assumed to be borne by the student. */
  flutterwaveFeePercent: num(process.env.FLUTTERWAVE_PLATFORM_FEE_PCT, 0),
  /** Where certificate PDFs are stored. */
  certStorage: (process.env.CERT_STORAGE || 'cloudinary').toLowerCase(),
};

/**
 * Compute the amount breakdown for a course price.
 * The student bears the Flutterwave fee, so:
 *   fee   = round(price * feePercent / 100)
 *   total = price + fee
 *
 * @param {number} price
 * @returns {{ coursePrice:number, flutterwaveFee:number, total:number, feeInclusive:boolean }}
 */
const amountBreakdown = (price) => {
  const base = Math.max(0, Number(price) || 0);
  const fee = Math.round((base * platform.flutterwaveFeePercent) / 100);
  return {
    coursePrice: base,
    flutterwaveFee: fee,
    total: base + fee,
    feeInclusive: false,
  };
};

/**
 * Split a charged total between owner and platform according to platform split.
 * Flutterwave applies the split to the settled amount.
 *
 * @param {number} base - the course price (before the FW fee)
 */
const revenueSplit = (base) => {
  const amount = Math.max(0, Number(base) || 0);
  const ownerShare = Math.round(amount * platform.ownerPercent);
  const platformShare = amount - ownerShare;
  return {
    ownerShare,
    platformShare,
    ownerPercent: platform.ownerPercent,
    platformPercent: platform.platformPercent,
  };
};

module.exports = {
  platform,
  amountBreakdown,
  revenueSplit,
};