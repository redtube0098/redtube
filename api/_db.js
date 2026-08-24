// api/_db.js
// Shared MongoDB connection helper. Reuses connection across serverless invocations.
const { MongoClient } = require("mongodb");

let cachedClient = null;
let cachedDb = null;
let connectingPromise = null; // prevents race condition on concurrent cold starts
let indexesEnsured = false; // ensures we only try to create indexes once per warm container

async function ensureIndexes(db) {
  if (indexesEnsured) return;
  try {
    // CRITICAL: unique index on normalized address.
    // One address can only ever belong to one account — MongoDB itself
    // rejects a second insert for the same address, so no client-side
    // tooling or replayed/parallel requests can bypass this.
    await db.collection("locked_withdraw_addresses").createIndex(
      { address: 1 },
      { unique: true, name: "uniq_locked_address" }
    );
    // CRITICAL: unique index on userId.
    // One account can only ever be locked to one address — this is what
    // stops a user from later switching to a second address after their
    // first one is set.
    await db.collection("locked_withdraw_addresses").createIndex(
      { userId: 1 },
      { unique: true, name: "uniq_locked_userId" }
    );
    // Speeds up the pending-gift lookup that runs on every GET /api/user
    // (see api/user.js) — not unique, a user can have multiple gifts over
    // time, just never more than one usually-pending at once in practice.
    await db.collection("gifts").createIndex(
      { telegramId: 1, status: 1, createdAt: 1 },
      { name: "gifts_uid_status_created" }
    );
    // Speeds up the viewSpecialTask -> completeSpecialTask lookup in
    // api/task.js. One view record per (user, task) pair, upserted on
    // every view, so this is also effectively unique.
    await db.collection("special_task_views").createIndex(
      { telegramId: 1, taskId: 1 },
      { unique: true, name: "uniq_special_task_view" }
    );
    // Speeds up the WAL (Withdraw Address Lock attempts) admin tab, which
    // reads the most recent attempts across all users.
    await db.collection("wal_logs").createIndex(
      { createdAt: -1 },
      { name: "wal_logs_created_desc" }
    );
    indexesEnsured = true;
    console.log("[DB] Indexes ensured (locked_withdraw_addresses)");
  } catch (e) {
    // Don't crash the request over index creation — log and continue.
    console.error("[DB ERROR] Failed to ensure indexes:", e.message);
  }
}

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

      await ensureIndexes(cachedDb);

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
