require('dotenv').config();
const app = require('./src/app');
const connectDB = require('./src/config/db');

const PORT = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Fail fast, and loudly, when a production deploy is missing configuration.
 * A half-configured server that boots and then 500s on every request is far
 * harder to diagnose than one that refuses to start.
 */
const REQUIRED_IN_PROD = [
  ['MONGO_URI', 'database connection string'],
  ['JWT_SECRET', 'token signing secret'],
  ['CLIENT_URL', 'allowed frontend origin(s)'],
  ['CLOUDINARY_CLOUD_NAME', 'Cloudinary cloud name'],
  ['CLOUDINARY_API_KEY', 'Cloudinary API key'],
  ['CLOUDINARY_API_SECRET', 'Cloudinary API secret'],
];

const validateEnv = () => {
  const missing = REQUIRED_IN_PROD.filter(([key]) => !process.env[key]).map(([key, what]) => `${key} (${what})`);

  if (IS_PROD && process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    missing.push('JWT_SECRET (must be at least 32 characters in production)');
  }

  if (missing.length && IS_PROD) {
    // Production: refuse to boot rather than serve broken responses.
    throw new Error(`Missing required environment variables:\n  - ${missing.join('\n  - ')}`);
  }
  if (missing.length) {
    // Development: warn, because local setups often run with dummy credentials.
    console.warn(`[Config] Missing environment variables (ignored outside production):\n  - ${missing.join('\n  - ')}`);
  }

  if (process.env.NODE_ENV !== 'test') {
    console.log(`[Config] NODE_ENV=${process.env.NODE_ENV || 'development'} PORT=${PORT}`);
    console.log(`[Config] CLIENT_URL=${process.env.CLIENT_URL || 'http://localhost:3000'}`);
  }
};

let server;

const start = async () => {
  validateEnv();
  await connectDB();

  // Render/Heroku-style platforms sit behind a proxy; rate limiting and
  // req.ip only work correctly when Express trusts it.
  app.set('trust proxy', 1);

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[W3Skool API] Running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });

  // Long uploads (videos) must not be cut off mid-transfer.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 11 * 60 * 1000;
};

/** Drain in-flight requests, then close the DB, then exit. */
const shutdown = (signal) => {
  console.log(`[W3Skool API] ${signal} received - shutting down gracefully`);
  const done = () => process.exit(0);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  if (server) server.close(done);
  else done();
};

['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

process.on('unhandledRejection', (reason) => {
  console.error('[W3Skool API] Unhandled rejection:', reason);
});

start().catch((err) => {
  console.error('Startup error:', err.message);
  process.exit(1);
});
