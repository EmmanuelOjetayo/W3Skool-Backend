const mongoose = require('mongoose');
const dns = require('dns');

const OPTIONS = { serverSelectionTimeoutMS: 20000, maxPoolSize: 10 };

/** Host of an Atlas SRV connection string (no hardcoded cluster names). */
const srvHost = (uri = '') => {
  const m = String(uri).match(/^mongodb\+srv:\/\/[^@/]+@([^/?]+)/);
  return m ? m[1] : null;
};

/**
 * Atlas SRV lookups fail on networks whose resolver can't handle
 * `_mongodb._tcp.<cluster>`. Check first (fast) and only then fall back to a
 * public resolver, instead of discovering the problem via a 20s timeout.
 */
const useWorkingDns = async (uri) => {
  const host = srvHost(uri);
  if (!host) return;
  try {
    await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
  } catch {
    dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
    console.log('[MongoDB] SRV lookup failed on the system resolver - using public DNS');
  }
};

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set. Add it to .env (see .env.example) before starting the API.');
  }

  await useWorkingDns(process.env.MONGO_URI);

  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, OPTIONS);
    console.log(`[MongoDB] Connected: ${conn.connection.host}`);
    return conn;
  } catch (err) {
    console.error(`[MongoDB] Connection error: ${err.message}`);
    console.error('[MongoDB] Check MONGO_URI, the IP allowlist on Atlas, and network/DNS access.');
    throw err;
  }
};

module.exports = connectDB;
