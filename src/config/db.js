const mongoose = require('mongoose');
const dns = require('dns');

const OPTIONS = { serverSelectionTimeoutMS: 20000, maxPoolSize: 10 };

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set. Add it to .env (see .env.example) before starting the API.');
  }

  const tryConnect = () => mongoose.connect(process.env.MONGO_URI, OPTIONS);

  try {
    const conn = await tryConnect();
    console.log(`[MongoDB] Connected: ${conn.connection.host}`);
    return conn;
  } catch (firstErr) {
    // Atlas SRV lookups fail on networks whose DNS resolver can't resolve
    // `_mongodb._tcp.<cluster>`. Retrying with a public resolver fixes most of
    // those (and cloud sandboxes with restricted resolvers).
    console.warn(`[MongoDB] Connect failed (${firstErr.message.split('\n')[0]}) - retrying with public DNS...`);
    dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

    try {
      const conn = await tryConnect();
      console.log(`[MongoDB] Connected (public DNS): ${conn.connection.host}`);
      return conn;
    } catch (retryErr) {
      console.error(`[MongoDB] Connection error: ${retryErr.message}`);
      console.error('[MongoDB] Check MONGO_URI, the IP allowlist on Atlas, and network/DNS access.');
      throw retryErr;
    }
  }
};

module.exports = connectDB;
