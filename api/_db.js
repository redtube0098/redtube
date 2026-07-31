// api/_db.js
// Shared MongoDB connection helper. Reuses connection across serverless invocations.
const { MongoClient } = require("mongodb");

let cachedClient = null;
let cachedDb = null;
let connectingPromise = null; // prevents race condition on concurrent cold starts

async function getDb() {
  // If we have a live cached connection, verify it's still usable
  if (cachedDb && cachedClient) {
    try {
      await cachedClient.db().command({ ping: 1 });
      return cachedDb;
    } catch (e) {
      // Connection died (e.g. serverless container reused after long idle) — reset and reconnect
      console.warn("[DB] Cached connection stale, reconnecting:", e.message);
      cachedClient = null;
      cachedDb = null;
    }
  }

  // If a connection attempt is already in flight (concurrent requests during cold start),
  // reuse the same promise instead of opening multiple connections
  if (connectingPromise) {
    return connectingPromise;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("[CONFIG ERROR] MONGODB_URI env var is missing");
  }

  connectingPromise = (async () => {
    try {
      const client = new MongoClient(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000, // fail fast instead of hanging forever
        socketTimeoutMS: 45000,
      });
      await client.connect();
      cachedClient = client;
      cachedDb = client.db("redtube"); // database name
      return cachedDb;
    } catch (err) {
      console.error("[DB ERROR] Failed to connect to MongoDB:", err.message);
      cachedClient = null;
      cachedDb = null;
      throw err; // let caller handle — don't silently return undefined
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

module.exports = { getDb };
