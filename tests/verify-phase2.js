'use strict';

/**
 * Phase 2 smoke verification — no DB required.
 * Run: node tests/verify-phase2.js
 */

require('dotenv').config();
const assert = require('assert');

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name} ${extra}`); }
};

(async () => {
  console.log('\n[1] Platform amount + split math');
  const { amountBreakdown, revenueSplit, platform } = require('../src/config/platform');
  const b = amountBreakdown(25000);
  ok('breakdown total = price + fee', b.total === b.coursePrice + b.flutterwaveFee, JSON.stringify(b));
  ok('owner percent is 90%', Math.round(platform.ownerPercent * 100) === 90, String(platform.ownerPercent));
  const s = revenueSplit(25000);
  ok('owner + platform = base', s.ownerShare + s.platformShare === 25000, JSON.stringify(s));
  ok('owner gets 90%', s.ownerShare === 22500, String(s.ownerShare));
  ok('platform gets 10%', s.platformShare === 2500, String(s.platformShare));

  console.log('\n[2] Flutterwave service surface');
  const fw = require('../src/services/flutterwave.service');
  ['initiateStandardPayment', 'verifyTransaction', 'verifyWebhookHash', 'listBanks', 'resolveAccount', 'createSubaccount', 'updateSubaccount']
    .forEach((fn) => ok(`exports ${fn}`, typeof fw[fn] === 'function'));
  ok('webhook hash rejects wrong value', fw.verifyWebhookHash('nope') === false);

  console.log('\n[3] Certificate PDF generation');
  const { buildCertificatePdf } = require('../src/services/certificatePdf.service');
  const pdf = await buildCertificatePdf({
    studentName: 'Chidi Student',
    courseTitle: 'Modern JavaScript & Node.js Mastery',
    instructorName: 'Alex Ekwueme',
    issuedAt: new Date(),
    code: 'W3S-ABCD-2345',
    verifyUrl: 'http://localhost:5173/verify/W3S-ABCD-2345',
  });
  ok('returns a Buffer', Buffer.isBuffer(pdf));
  ok('is a valid PDF (%PDF header)', pdf.slice(0, 4).toString() === '%PDF');
  ok('has meaningful size (>2KB)', pdf.length > 2048, `${pdf.length} bytes`);

  console.log('\n[4] Email service surface (DB-free)');
  const email = require('../src/services/email.service');
  ['sendOnce', 'sendOnceAsync', 'sendWelcome', 'sendPurchase', 'sendCertificate', 'sendLiveSession', 'sendPasswordReset']
    .forEach((fn) => ok(`exports ${fn}`, typeof email[fn] === 'function'));

  console.log('\n[5] Payment service surface');
  const ps = require('../src/services/payment.service');
  ['buildCheckout', 'fulfillPayment', 'resolveOwnerSubaccount', 'isAllowedRedirect'].forEach((fn) => ok(`exports ${fn}`, typeof ps[fn] === 'function'));

  console.log('\n[6] Completion service surface');
  const cs = require('../src/services/completion.service');
  ['checkAndHandleCourseCompletion', 'isCourseFullyCompleted', 'verifyUrlFor'].forEach((fn) => ok(`exports ${fn}`, typeof cs[fn] === 'function'));

  console.log('\n[7] Route wiring (express router stack)');
  const adminRoutes = require('../src/routes/admin.routes');
  const paymentRoutes = require('../src/routes/payment.routes');
  const authRoutes = require('../src/routes/auth.routes');
  const paths = (r) => r.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods).join('').toUpperCase() + ' ' + l.route.path);
  ok('admin has GET /payouts', paths(adminRoutes).includes('GET /payouts'));
  ok('admin has POST /payouts/subaccount', paths(adminRoutes).includes('POST /payouts/subaccount'));
  ok('payment has POST /checkout', paths(paymentRoutes).includes('POST /checkout'));
  ok('auth has POST /forgot-password', paths(authRoutes).includes('POST /forgot-password'));
  ok('auth has POST /reset-password', paths(authRoutes).includes('POST /reset-password'));

  console.log('\n[8] Ownership service');
  const os = require('../src/services/ownership.service');
  ['isOwnedBy', 'ownedCourseFilter', 'requireOwnedCourse', 'ownedCourseIds']
    .forEach((fn) => ok(`exports ${fn}`, typeof os[fn] === 'function'));
  ok('null owner is manageable by any admin', os.isOwnedBy({ owner: null }, 'admin-1') === true);
  ok('matching owner passes', os.isOwnedBy({ owner: 'admin-1' }, 'admin-1') === true);
  ok('foreign owner is rejected', os.isOwnedBy({ owner: 'admin-2' }, 'admin-1') === false);
  const of = os.ownedCourseFilter('admin-1');
  ok('filter scopes to owned + legacy null-owner',
    Array.isArray(of.$or) && of.$or.length === 2 &&
    of.$or[0].owner === 'admin-1' && of.$or[1].owner === null,
    JSON.stringify(of));

  console.log(`\n──────────────────────────────\n  ${passed} passed, ${failed} failed\n──────────────────────────────\n`);
  process.exit(failed ? 1 : 0);
})();