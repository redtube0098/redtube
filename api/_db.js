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
    // "all_users" broadcast mode pages through the users collection ordered
    // by telegramId using a { $gt: cursor } filter every cron tick (see
    // _telegram.js enqueueBroadcast/drainBroadcastQueue) — this index makes
    // that pagination an index scan instead of a full collection scan.
    await db.collection("users").createIndex(
      { telegramId: 1 },
      { unique: true, name: "uniq_users_telegramId" }
    );
    // Lets drainBroadcastQueue's "find the oldest pending job" query
    // (status: "pending", sort createdAt asc) use an index instead of
    // scanning every job document on every cron tick.
    await db.collection("broadcast_jobs").createIndex(
      { status: 1, createdAt: 1 },
      { name: "broadcast_jobs_status_created" }
    );
    // Speeds up the promo-code admin tab / redemption lookup (find by
    // uppercased code — see api/promo.js, api/admin/promo.js).
    await db.collection("promocodes").createIndex(
      { code: 1 },
      { unique: true, name: "uniq_promocodes_code" }
    );

    // ================= AUTO-CLEANUP (TTL) INDEXES =================
    // MongoDB's TTL background thread sweeps every ~60s and deletes any
    // document whose indexed Date field is older than expireAfterSeconds.
    // A document where that field doesn't exist (or isn't a Date) is left
    // completely alone — that's what lets a single collection have a mix
    // of "keep forever" and "disposable" documents, by only ever setting
    // the TTL field for the disposable ones (partialFilterExpression is a
    // second, belt-and-braces guard on top of that where used below).
    //
    // IMPORTANT — exactly ONE TTL index per (collection, field) pair:
    // MongoDB rejects a second index with the same key pattern but
    // different options (name/expireAfterSeconds/etc.) — it throws
    // IndexOptionsConflict. This file previously had wal_logs, ad_logs,
    // and spin_logs each defined TWICE (a leftover from an earlier
    // refactor), with spin_logs's two copies disagreeing (24h vs 48h).
    // Because ensureIndexes() runs inside one try/catch and never sets
    // indexesEnsured on failure, that conflict threw on EVERY single
    // request in a warm container, was swallowed by the catch below, and
    // silently prevented every index listed AFTER spin_logs from ever
    // being created (including the key_orders pending-order TTL) — not
    // just once, but forever, since the retry hit the exact same conflict
    // every time. Consolidated to one definition per field below; there
    // must never be two createIndex() calls on the same field of the same
    // collection again.

    // wal_logs: security log of rejected withdraw-address-lock attempts.
    // Disposable 24h after being logged, no matter whether an admin ever
    // looked at it.
    await db.collection("wal_logs").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 24 * 60 * 60, name: "ttl_wal_logs_24h" }
    );

    // ad_logs: every ad view. Kept 15 days (per product decision) before
    // auto-delete — well past the only thing that ever reads it (the
    // "how many ads watched today" check in api/earn.js/api/withdraw.js,
    // which only ever looks at the current ad-day).
    await db.collection("ad_logs").createIndex(
      { watchedAt: 1 },
      { expireAfterSeconds: 15 * 24 * 60 * 60, name: "ttl_ad_logs_15d" }
    );

    // spin_logs: every spin. Kept 15 days (per product decision) before
    // auto-delete — well past the only thing that ever reads it (the most
    // recent spin, for the cooldown calc in api/earn.js).
    await db.collection("spin_logs").createIndex(
      { spunAt: 1 },
      { expireAfterSeconds: 15 * 24 * 60 * 60, name: "ttl_spin_logs_15d" }
    );

    // special_task_views: "I opened this task link" proof. Only ever
    // checked within ~30 minutes of being written (see api/task.js) — 24h
    // is a generous safety margin before auto-delete. Instantly
    // re-created (it's an upsert) if the link is opened again after that.
    await db.collection("special_task_views").createIndex(
      { viewedAt: 1 },
      { expireAfterSeconds: 24 * 60 * 60, name: "ttl_special_task_views_24h" }
    );

    // Gifts — "pending" gifts have no claimedAt field, so they're
    // untouched/kept forever until claimed. Once claimed, the record is
    // never read again anywhere — auto-deletes 24h after the claim (not
    // after creation).
    await db.collection("gifts").createIndex(
      { claimedAt: 1 },
      { expireAfterSeconds: 24 * 60 * 60, name: "ttl_gifts_claimed_24h" }
    );

    // Broadcast jobs — "pending" jobs have finishedAt: null, so they're
    // untouched. Once a job finishes it's never read again — kept 14 days,
    // then auto-deleted.
    await db.collection("broadcast_jobs").createIndex(
      { finishedAt: 1 },
      { expireAfterSeconds: 14 * 24 * 60 * 60, name: "ttl_broadcast_jobs_finished_14d" }
    );

    // Task submissions — ONLY "rejected" ones ever get a processedAt field
    // (see api/admin/tasks.js reject branch). "pending"/"approved" are
    // NEVER touched regardless of age — approved ones feed the lifetime
    // task count used for withdraw eligibility (api/withdraw.js), so they
    // must survive forever. Kept 30 days after rejection, then auto-deleted.
    await db.collection("task_submissions").createIndex(
      { processedAt: 1 },
      {
        expireAfterSeconds: 30 * 24 * 60 * 60,
        name: "ttl_task_submissions_rejected_30d",
        partialFilterExpression: { status: "rejected" },
      }
    );

    // Task submissions — "approved" ones, per product decision, auto-delete
    // 7 days after approval (approvedAt is set both on manual admin
    // approval and on the auto-approve/code-match path — see
    // api/admin/tasks.js and api/task.js). SAFE to delete despite this
    // being the "proof of task completion" record: withdraw eligibility
    // (MIN_LIFETIME_TASKS_REQUIRED in api/withdraw.js) no longer counts
    // these documents directly — it reads the durable, never-decremented
    // user.tasksCompleted counter instead, which survives this cleanup.
    // Different field (approvedAt) than the rejected-TTL above (processedAt)
    // and a disjoint partialFilterExpression (status "approved" vs
    // "rejected"), so this is a separate index with no key-pattern
    // conflict with it.
    await db.collection("task_submissions").createIndex(
      { approvedAt: 1 },
      {
        expireAfterSeconds: 7 * 24 * 60 * 60,
        name: "ttl_task_submissions_approved_7d",
        partialFilterExpression: { status: "approved" },
      }
    );

    // Key Coin purchase orders — ONLY "pending" (unpaid/abandoned deposit)
    // orders are eligible, via partialFilterExpression. The instant an
    // order flips to "paid" (see handleTonWebhook / the reconcile-cron
    // path in api/user.js) it stops matching this filter and is kept
    // forever as a permanent payment record.
    // Per product decision: an unpaid deposit auto-clears 24h after being
    // created. CAUTION: if a buyer opens checkout and then actually sends
    // the TON payment MORE than 24h later, the order will already be gone
    // and that payment can no longer auto-match by expectedNano — widen
    // this if that turns out to happen in practice.
    await db.collection("key_orders").createIndex(
      { createdAt: 1 },
      {
        expireAfterSeconds: 24 * 60 * 60,
        name: "ttl_key_orders_pending_24h",
        partialFilterExpression: { status: "pending" },
      }
    );

    // Promo codes — every code is disposable exactly 24h after an admin
    // creates it, regardless of usedCount/limit. Once the TTL sweep
    // deletes it, redemption naturally fails with "code not found" (see
    // api/promo.js) — no extra expiry-check logic needed anywhere else.
    await db.collection("promocodes").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 24 * 60 * 60, name: "ttl_promocodes_24h" }
    );

    indexesEnsured = true;
    console.log("[DB] Indexes ensured (including TTL auto-cleanup indexes)");
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
