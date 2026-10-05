'use strict';

const axios = require('axios');
const crypto = require('crypto');
const AppError = require('../utils/AppError');

const BASE_URL = 'https://api.flutterwave.com/v3';

/** Constant-time string comparison (avoids timing side-channels on secrets). */
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/**
 * A key is "configured" only when it is present AND not an obvious placeholder.
 * This turns the confusing Flutterwave "Invalid authorization key" into a clear
 * server-side message before we ever call their API.
 */
const looksLikePlaceholder = (key) =>
  !key || /x{4,}/i.test(key) || /your[_-]?key|replace[_-]?with|example|test-sandboxdemo/i.test(key);

/**
 * Returns the Flutterwave secret key from environment variables.
 * Evaluated lazily so tests can inject the env var after module load.
 */
const getSecretKey = () => {
  const key = process.env.FLUTTERWAVE_SECRET_KEY;
  if (looksLikePlaceholder(key)) {
    throw new AppError(
      'Flutterwave is not configured yet (missing or placeholder FLUTTERWAVE_SECRET_KEY). Set a real LIVE secret key from your Flutterwave dashboard.',
      503,
      'FLUTTERWAVE_NOT_CONFIGURED'
    );
  }
  return key;
};

/**
 * Initiate a Flutterwave Standard (hosted) payment.
 *
 * @param {Object} params
 * @param {string} params.txRef           - Unique transaction reference (generate before calling)
 * @param {number} params.amount          - Amount to charge
 * @param {string} params.currency        - ISO 4217 currency code, e.g. 'NGN'
 * @param {string} params.customerEmail   - Customer's email address
 * @param {string} params.customerName    - Customer's full name
 * @param {string} [params.customerPhone] - Customer's phone number (optional)
 * @param {string} params.courseTitle     - Used in the payment modal description
 * @param {string} params.redirectUrl     - URL Flutterwave redirects to after payment
 * @param {Array<Object>} [params.subaccounts] - Split config: owner subaccount ratio 9 / platform remainder 1 => 90/10.
 * @returns {Promise<{ paymentLink: string }>}
 */
const initiateStandardPayment = async ({
  txRef,
  amount,
  currency,
  customerEmail,
  customerName,
  customerPhone,
  courseTitle,
  redirectUrl,
  subaccounts,
}) => {
  const secretKey = getSecretKey();

  let response;
  try {
    const { data } = await axios.post(
      `${BASE_URL}/payments`,
      {
        tx_ref: txRef,
        amount,
        currency,
        redirect_url: redirectUrl,
        customer: {
          email: customerEmail,
          name: customerName,
          phonenumber: customerPhone || '',
        },
        customizations: {
          title: 'W3Skool',
          description: courseTitle,
        },
        // Route the owner's share (90%) to their subaccount at charge time —
        // same split semantics as the window checkout (see payment.service).
        ...(Array.isArray(subaccounts) && subaccounts.length ? { subaccounts } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    response = data;
  } catch (err) {
    throw new AppError(fwMessage(err, 'Payment initiation failed.'), 502, fwCode(err, 'PAYMENT_INIT_FAILED'));
  }

  if (response.status === 'success' && response.data?.link) {
    return { paymentLink: response.data.link };
  }

  throw new AppError('Payment initiation failed.', 502, 'PAYMENT_INIT_FAILED');
};

/**
 * Verify a Flutterwave transaction by its transaction ID.
 *
 * @param {string|number} transactionId - Flutterwave transaction ID
 * @returns {Promise<{
 *   status: string,
 *   amount: number,
 *   currency: string,
 *   txRef: string,
 *   customerEmail: string
 * }>}
 */
const verifyTransaction = async (transactionId) => {
  const secretKey = getSecretKey();

  let responseData;
  try {
    const { data } = await axios.get(
      `${BASE_URL}/transactions/${transactionId}/verify`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      }
    );
    responseData = data;
  } catch (err) {
    throw new AppError(fwMessage(err, 'Payment verification failed.'), 502, fwCode(err, 'PAYMENT_VERIFY_FAILED'));
  }

  const tx = responseData?.data;
  if (!tx) {
    throw new AppError('Payment verification failed.', 502, 'PAYMENT_VERIFY_FAILED');
  }

  return {
    status: tx.status,
    amount: tx.amount,
    currency: tx.currency,
    txRef: tx.tx_ref,
    customerEmail: tx.customer?.email,
  };
};

/**
 * Validate an incoming Flutterwave webhook by comparing the verif-hash header
 * against the pre-shared secret configured in FLUTTERWAVE_WEBHOOK_HASH.
 *
 * @param {string} receivedHash - The value of the 'verif-hash' request header
 * @returns {boolean}
 */
const verifyWebhookHash = (receivedHash) => {
  const expectedHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
  if (!expectedHash) return false;
  return safeEqual(receivedHash, expectedHash);
};

/**
 * Extract the most useful human message from a Flutterwave Axios failure.
 */
const fwMessage = (err, fallback) =>
  err.response?.data?.message || err.response?.data?.error || err.message || fallback;

const fwCode = (err, fallback) => {
  const message = String(err.response?.data?.message || '').toLowerCase();
  if (message.includes('authorization') || message.includes('unauthor') || err.response?.status === 401) {
    return 'FLUTTERWAVE_UNAUTHORIZED';
  }
  return fallback;
};

/**
 * List supported banks for a country (e.g. 'NG'). Returns [{ code, name }].
 */
const listBanks = async (country = 'NG') => {
  const secretKey = getSecretKey();
  let data;
  try {
    ({ data } = await axios.get(`${BASE_URL}/banks/${encodeURIComponent(country)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    }));
  } catch (err) {
    throw new AppError(fwMessage(err, 'Could not load banks.'), 502, fwCode(err, 'PAYOUT_RESOLVE_FAILED'));
  }
  const banks = Array.isArray(data?.data) ? data.data : [];
  return banks.map((b) => ({ code: String(b.code), name: b.name }));
};

/**
 * Resolve (validate) a bank account name.
 */
const resolveAccount = async ({ accountNumber, bankCode }) => {
  const secretKey = getSecretKey();
  let data;
  try {
    ({ data } = await axios.post(
      `${BASE_URL}/accounts/resolve`,
      { account_number: accountNumber, account_bank: bankCode },
      { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } }
    ));
  } catch (err) {
    throw new AppError(fwMessage(err, 'Could not verify this account number.'), 502, fwCode(err, 'PAYOUT_RESOLVE_FAILED'));
  }
  if (data?.status !== 'success' || !data?.data) {
    throw new AppError('Could not verify this account number.', 502, 'PAYOUT_RESOLVE_FAILED');
  }
  return { accountName: data.data.account_name, accountNumber: data.data.account_number };
};

/**
 * Create a Flutterwave subaccount for an admin's payouts.
 * split_type 'percentage' + split_value => fraction paid to the OWNER.
 */
const createSubaccount = async ({
  accountBank,
  accountNumber,
  businessName,
  businessEmail,
  businessContact,
  businessContactMobile,
  country = 'NG',
  splitType = 'percentage',
  splitValue = 0.9,
}) => {
  const secretKey = getSecretKey();
  let data;
  try {
    ({ data } = await axios.post(
      `${BASE_URL}/subaccounts`,
      {
        account_bank: accountBank,
        account_number: accountNumber,
        business_name: businessName,
        business_email: businessEmail,
        business_contact: businessContact,
        business_contact_mobile: businessContactMobile,
        country,
        split_type: splitType,
        split_value: splitValue,
      },
      { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } }
    ));
  } catch (err) {
    const msg = fwMessage(err, '');
    // Flutterwave returns 400 when a subaccount already exists for this account+bank.
    // Recover gracefully: look up the existing subaccount instead of throwing.
    if (msg.toLowerCase().includes('already exists')) {
      try {
        const existing = await axios.get(`${BASE_URL}/subaccounts`, {
          params: { account_number: accountNumber },
          headers: { Authorization: `Bearer ${secretKey}` },
        });
        const records = existing.data?.data;
        const rec = Array.isArray(records) ? records.find(r => String(r.account_number) === String(accountNumber)) || records[0] : null;
        if (rec) {
          return {
            subaccountId: String(rec.subaccount_id || rec.id || ''),
            status: 'active',
            raw: rec,
          };
        }
      } catch (_) {
        // Fall through to the original error
      }
    }
    throw new AppError(fwMessage(err, 'Could not create your payout account.'), 502, fwCode(err, 'PAYOUT_CREATE_FAILED'));
  }
  if (data?.status !== 'success' || !data?.data) {
    throw new AppError('Could not create your payout account.', 502, 'PAYOUT_CREATE_FAILED');
  }
  return {
    subaccountId: String(data.data.subaccount_id || data.data.id || ''),
    status: data.data.status || 'active',
    raw: data.data,
  };
};

/**
 * Update an existing Flutterwave subaccount (business name / split).
 */
const updateSubaccount = async (subaccountId, { businessName, businessContact, businessContactMobile, splitValue }) => {
  const secretKey = getSecretKey();
  let data;
  try {
    ({ data } = await axios.put(
      `${BASE_URL}/subaccounts/${subaccountId}`,
      {
        business_name: businessName,
        business_contact: businessContact,
        business_contact_mobile: businessContactMobile,
        split_value: splitValue,
      },
      { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } }
    ));
  } catch (err) {
    throw new AppError(fwMessage(err, 'Could not update your payout account.'), 502, fwCode(err, 'PAYOUT_CREATE_FAILED'));
  }
  if (data?.status !== 'success') {
    throw new AppError('Could not update your payout account.', 502, 'PAYOUT_CREATE_FAILED');
  }
  return { status: 'active', raw: data.data };
};

module.exports = {
  initiateStandardPayment,
  verifyTransaction,
  verifyWebhookHash,
  listBanks,
  resolveAccount,
  createSubaccount,
  updateSubaccount,
};
