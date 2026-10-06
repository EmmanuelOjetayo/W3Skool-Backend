'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_super_secure_key_12345';
process.env.CLIENT_URL = 'http://localhost:3000';
process.env.FLUTTERWAVE_PUBLIC_KEY = 'FLWPUBK-test';
process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK-test';
process.env.FLUTTERWAVE_WEBHOOK_HASH = 'test_webhook_hash';
process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
process.env.CLOUDINARY_API_KEY = 'test_api_key';
process.env.CLOUDINARY_API_SECRET = 'test_api_secret';

let passCount = 0;
let failCount = 0;

const assert = (condition, msg) => {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failCount++;
  }
};

console.log('=== [1] Verifying Models ===');
const models = [
  'User', 'Course', 'Module', 'Unit', 'Resource',
  'Quiz', 'QuizAttempt', 'Enrollment', 'Progress',
  'Payment', 'LiveSession', 'Certificate',
];

for (const m of models) {
  try {
    const Model = require(`../src/models/${m}`);
    assert(typeof Model === 'function' && Model.modelName === m, `Model ${m} loaded with schema`);
  } catch (err) {
    assert(false, `Model ${m} failed to load: ${err.message}`);
  }
}

console.log('\n=== [2] Verifying Services ===');
const services = [
  'flutterwave.service', 'enrollment.service', 'progress.service',
  'unlock.service', 'certificate.service', 'cloudinary.service',
];

for (const s of services) {
  try {
    const service = require(`../src/services/${s}`);
    assert(typeof service === 'object' && Object.keys(service).length > 0, `Service ${s} exports ${Object.keys(service).join(', ')}`);
  } catch (err) {
    assert(false, `Service ${s} failed to load: ${err.message}`);
  }
}

console.log('\n=== [3] Verifying Business Logic ===');
const { generateCode } = require('../src/services/certificate.service');
const code = generateCode();
assert(/^W3S-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `Certificate code format: ${code}`);

const { getUnitCompletion } = require('../src/services/progress.service');
const unitVideoDone = getUnitCompletion(
  { video: { url: 'https://v.mp4', requiredWatchPercent: 90 }, quizId: null },
  { videoCompleted: true },
  []
);
assert(unitVideoDone.completed === true && unitVideoDone.canMarkComplete === false, 'Unit completed when video watch requirement met');

const unitQuizPending = getUnitCompletion(
  { video: null, quizId: 'fakeid' },
  { videoCompleted: true },
  [{ passed: false }]
);
assert(unitQuizPending.completed === false, 'Unit incomplete when quiz not passed');

const guideOnlyUnit = getUnitCompletion({ video: null, quizId: null }, null, []);
assert(guideOnlyUnit.canMarkComplete === true, 'Guide-only unit allows self-completion');

const { sanitizeGuideHtml } = require('../src/utils/sanitize');
const sanitized = sanitizeGuideHtml('<h3>Lesson</h3><script>alert("xss")</script><p>Clean content</p>');
assert(!sanitized.includes('<script>') && sanitized.includes('<h3>Lesson</h3>'), 'Guide HTML sanitized (scripts stripped, tags preserved)');

console.log('\n=== [4] Verifying Controllers & Routes ===');
const routeFiles = [
  'auth.routes', 'course.routes', 'admin.routes',
  'student.routes', 'payment.routes', 'webhook.routes', 'certificate.routes',
];

for (const r of routeFiles) {
  try {
    const router = require(`../src/routes/${r}`);
    assert(typeof router === 'function' && router.name === 'router', `Route ${r} initialized cleanly`);
  } catch (err) {
    assert(false, `Route ${r} failed to load: ${err.message}`);
  }
}

console.log('\n=== [5] Verifying Express Application ===');
let app = null;
try {
  app = require('../src/app');
  assert(typeof app === 'function', 'Express app created successfully');
} catch (err) {
  assert(false, `Express app failed to load: ${err.message}`);
}

const runHttpChecks = async () => {
  console.log('\n=== [6] HTTP Smoke Tests (no database required) ===');
  if (!app) return;
  const request = require('supertest');

  try {
    const health = await request(app).get('/health');
    assert(health.status === 200 && health.body?.data?.status === 'ok', 'GET /health returns ok (used by Render health check)');
  } catch (err) {
    assert(false, `GET /health failed: ${err.message}`);
  }

  try {
    const missing = await request(app).get('/api/v1/definitely-not-a-route');
    assert(missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND', 'Unknown route returns 404 NOT_FOUND');
  } catch (err) {
    assert(false, `404 handling failed: ${err.message}`);
  }

  try {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    assert(res.status >= 400 || !res.headers['access-control-allow-origin'], 'CORS rejects a disallowed origin');
  } catch (err) {
    assert(false, `CORS guard failed: ${err.message}`);
  }

  try {
    const res = await request(app).get('/health');
    assert(Boolean(res.headers['x-content-type-options'] || res.headers['content-security-policy']), 'Security headers present (helmet)');
  } catch (err) {
    assert(false, `Security headers check failed: ${err.message}`);
  }

  console.log('\n=== [7] Production Readiness ===');
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert(Boolean(pkg.engines?.node), `package.json declares Node engine (${pkg.engines?.node})`);
    assert(pkg.scripts?.start === 'node server.js', 'package.json start script runs the server (Render entrypoint)');
  } catch (err) {
    assert(false, `package.json check failed: ${err.message}`);
  }

  for (const f of ['.env.example', '../render.yaml', '../.gitignore']) {
    try {
      fs.accessSync(path.join(root, f));
      assert(true, `Deployment file present: ${f.replace('../', '')}`);
    } catch {
      assert(false, `Deployment file missing: ${f.replace('../', '')}`);
    }
  }

  try {
    const ignore = fs.readFileSync(path.join(root, '..', '.gitignore'), 'utf8');
    // Tolerate CRLF: .gitignore files are commonly written on Windows.
    assert(/(^|\n)\.env\r?\n/.test(ignore), '.gitignore excludes .env (secrets never committed)');
    assert(/node_modules/.test(ignore), '.gitignore excludes node_modules');
  } catch (err) {
    assert(false, `.gitignore check failed: ${err.message}`);
  }

  try {
    const allowed = require('../src/models/Resource').schema.path('type').enumValues;
    const needed = ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'zip', 'txt', 'link'];
    const missingTypes = needed.filter((t) => !allowed.includes(t));
    assert(missingTypes.length === 0, `Resource.type enum covers every uploadable extension${missingTypes.length ? ` (missing: ${missingTypes.join(', ')})` : ''}`);
  } catch (err) {
    assert(false, `Resource type enum check failed: ${err.message}`);
  }

  console.log('\n=== [8] Cloudinary Delivery Helpers ===');
  const cloudinary = require('../src/services/cloudinary.service');
  try {
    assert(cloudinary.resourceTypeFromUrl('https://res.cloudinary.com/demo/raw/upload/v1/a/b.pdf') === 'raw', 'resourceTypeFromUrl: raw');
    assert(cloudinary.resourceTypeFromUrl('https://res.cloudinary.com/demo/video/upload/v1/a/b.mp4') === 'video', 'resourceTypeFromUrl: video');
    assert(cloudinary.resourceTypeFromUrl('https://res.cloudinary.com/demo/image/upload/v1/a/b.png') === 'image', 'resourceTypeFromUrl: image');
  } catch (err) {
    assert(false, `resourceTypeFromUrl checks failed: ${err.message}`);
  }

  try {
    const unreachable = await cloudinary.probeDelivery('http://127.0.0.1:9/nothing.pdf', { timeoutMs: 2000 });
    assert(unreachable.ok === true, 'probeDelivery fails OPEN on network errors (never marks a good file broken)');
  } catch (err) {
    assert(false, `probeDelivery network-tolerance check failed: ${err.message}`);
  }

  try {
    const empty = await cloudinary.probeDelivery('');
    assert(empty.ok === false, 'probeDelivery rejects an empty URL');
  } catch (err) {
    assert(false, `probeDelivery empty-URL check failed: ${err.message}`);
  }

  try {
    let threw = false;
    try { cloudinary.generateUploadSignature('document'); } catch { threw = true; }
    assert(threw, 'generateUploadSignature rejects invalid upload kinds');
  } catch (err) {
    assert(false, `upload signature validation failed: ${err.message}`);
  }

  console.log('\n=== [9] Publish Gate (paid course needs payout subaccount) ===');
  try {
    const adminRoutesSrc = fs.readFileSync(path.join(root, 'src', 'controllers', 'admin', 'course.admin.js'), 'utf8');
    // Every live-producing path runs the shared publish checks.
    const runsChecks = (adminRoutesSrc.match(/runPublishChecks\(course\)/g) || []).length;
    assert(runsChecks >= 3, `runPublishChecks enforced on status, publish and check paths (${runsChecks} call sites)`);
    // Issuing PAYOUT_NOT_SETUP when the owner has no active subaccount...
    assert(
      /PAYOUT_NOT_SETUP/.test(adminRoutesSrc) && /hasActiveSubaccount\(course\.owner\)/.test(adminRoutesSrc),
      'runPublishChecks flags PAYOUT_NOT_SETUP for paid courses without an active owner subaccount'
    );
    // ...but free courses stay exempt...
    assert(
      /Number\(course\.price \|\| 0\) > 0/.test(adminRoutesSrc),
      'Publish gate only applies to paid courses (free courses exempt)'
    );
    // ...and no bypass via the generic metadata PATCH: status writes there are rejected...
    assert(
      /USE_PUBLISH_ENDPOINT/.test(adminRoutesSrc),
      'PATCH /admin/courses/:id rejects direct status changes (USE_PUBLISH_ENDPOINT)'
    );
    // ...nor by flipping a published course from free to paid without payout setup.
    assert(
      /status === 'published' && !\(await hasActiveSubaccount\(course\.owner\)\)/.test(adminRoutesSrc),
      'Price edit cannot keep a paid course live without a payout subaccount'
    );
    // The subaccount check itself is the real record: active status + Flutterwave id.
    assert(
      /Subaccount\.findOne\(\{ adminId, status: 'active' \}\)/.test(adminRoutesSrc) && /flwSubaccountId/.test(adminRoutesSrc),
      'Subaccount check verifies the real stored record (active + Flutterwave id)'
    );
    // Frontend blocks + explains the blocked state instead of implying success.
    const builder = fs.readFileSync(path.join(root, '..', 'Frontend', 'src', 'pages', 'admin', 'CourseBuilder.jsx'), 'utf8');
    assert(
      /disabled=\{!published && !q\.data\?\.canPublish\}/.test(builder) && /PAYOUT_NOT_SETUP/.test(builder) && /\/admin\/payouts/.test(builder),
      'CourseBuilder disables publish when blocked and links PAYOUT_NOT_SETUP to payouts setup'
    );
  } catch (err) {
    assert(false, `publish gate checks failed: ${err.message}`);
  }
};

runHttpChecks()
  .catch((err) => {
    assert(false, `Smoke test runner crashed: ${err.message}`);
  })
  .finally(() => {
    console.log(`\n================================`);
    console.log(`Results: ${passCount} Passed, ${failCount} Failed`);
    console.log(`================================`);

    if (failCount > 0) {
      process.exit(1);
    } else {
      console.log('ALL VERIFICATION CHECKS PASSED!');
      process.exit(0);
    }
  });
