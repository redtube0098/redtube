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
    // NEW: broadcast queue support (see _telegram.js enqueueBroadcast/
    // drainBroadcastQueue). "all_users" mode broadcasts page through the
    // users collection ordered by telegramId using a { $gt: cursor } filter
    // every cron tick — this index makes that pagination an index scan
    // instead of a full collection scan on every single drain call, which
    // matters a lot once there are tens of thousands of users.
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

    // ================= AUTO-CLEANUP (TTL) INDEXES =================
    // These stop pure "log"/"one-shot" collections from growing forever.
    // MongoDB's TTL background thread sweeps every ~60s and deletes any
    // document whose indexed date field is older than expireAfterSeconds.
    // This also retroactively cleans up whatever backlog already exists
    // the first time each index is created — that's intended.

    // wal_logs: security log of rejected withdraw-address-lock attempts.
    // Per product decision, every entry is disposable 24h after being
    // logged — regardless of whether an admin ever looked at it. Direct
    // TTL on createdAt, no conditional logic needed.
    await db.collection("wal_logs").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24, name: "ttl_wal_logs_24h" }
    );

    // ad_logs: every ad view. Only ever queried for "how many watched
    // TODAY" (see api/earn.js, api/withdraw.js) — nothing reads an entry
    // older than the current calendar day. 3 days = safety margin over
    // that (covers timezone/server-clock edge cases) before auto-delete.
    await db.collection("ad_logs").createIndex(
      { watchedAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24 * 3, name: "ttl_ad_logs_3d" }
    );

    // spin_logs: every spin. Only ever queried for the MOST RECENT spin
    // (cooldown calc) — see api/earn.js. SPIN_BATCH_COOLDOWN_HOURS is 10h;
    // 24h gives a safe margin before auto-delete.
    await db.collection("spin_logs").createIndex(
      { spunAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24, name: "ttl_spin_logs_24h" }
    );

    // special_task_views: "I opened this task link" proof. Only ever
    // checked within NORMAL_TASK_VIEW_MAX_AGE_MS (30 min) of being
    // written — see api/task.js. 24h gives a safe margin before
    // auto-delete; irrelevant either way once the task is claimed
    // (specialTasksDone blocks re-claiming it).
    await db.collection("special_task_views").createIndex(
      { viewedAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24, name: "ttl_special_task_views_24h" }
    );

    // --- Conditional TTLs: these collections have documents that must be
    // kept FOREVER (pending gifts, paid key orders, approved/pending
    // submissions, in-flight broadcast jobs) alongside documents that are
    // disposable once a specific lifecycle transition happens (claimed,
    // paid, rejected, finished). A single blanket TTL on createdAt would
    // wrongly delete the "keep forever" ones too, so instead each of
    // these uses an `expireAt` field that the app code ONLY sets at the
    // moment a document becomes disposable (see the matching call sites
    // in api/user.js, api/admin/tasks.js, api/_telegram.js). A document
    // that never gets `expireAt` set never expires. expireAfterSeconds:0
    // means "delete as soon as expireAt is in the past" — the actual
    // delay is baked into the expireAt value itself, not this index.
    await db.collection("gifts").createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0, name: "ttl_gifts_expireAt" }
    );
    await db.collection("broadcast_jobs").createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0, name: "ttl_broadcast_jobs_expireAt" }
    );
    await db.collection("task_submissions").createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0, name: "ttl_task_submissions_expireAt" }
    );
    await db.collection("key_orders").createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0, name: "ttl_key_orders_expireAt" }
    );

    // ---------------------------------------------------------------
    // AUTO-CLEANUP (TTL) INDEXES
    // ---------------------------------------------------------------
    // MongoDB's TTL background thread sweeps every ~60s and deletes any
    // document whose indexed field holds a Date older than
    // expireAfterSeconds. A document where that field doesn't exist (or
    // isn't a Date) is left completely alone — that's what lets us TTL
    // only ONE status of a collection (e.g. only "rejected" submissions,
    // only "claimed" gifts) by only ever setting the date field for that
    // status, optionally reinforced with partialFilterExpression below.
    // No cron job / application code needed — cleanup runs on its own,
    // even if the app isn't invoked for a while.

    // WAL (Withdraw Address Lock) attempt logs — pure security log.
    // Auto-deletes 24h after creation, no matter what an admin does or
    // doesn't do with it.
    await db.collection("wal_logs").createIndex(
      { createdAt: 1 },
      { name: "wal_logs_ttl", expireAfterSeconds: 24 * 60 * 60 }
    );

    // Ad-watch logs — only ever queried for "how many ads TODAY" (see
    // earn.js / withdraw.js). Kept 3 days as a safety buffer past the
    // daily-reset boundary, then auto-deleted.
    await db.collection("ad_logs").createIndex(
      { watchedAt: 1 },
      { name: "ad_logs_ttl", expireAfterSeconds: 3 * 24 * 60 * 60 }
    );

    // Spin logs — only ever queried for "when was the most recent spin"
    // (per-spin + batch cooldown checks). Longest lookback that matters is
    // the 10h batch cooldown (SPIN_BATCH_COOLDOWN_HOURS in earn.js) — kept
    // 2 days for safety margin, then auto-deleted.
    await db.collection("spin_logs").createIndex(
      { spunAt: 1 },
      { name: "spin_logs_ttl", expireAfterSeconds: 2 * 24 * 60 * 60 }
    );

    // Gifts — "pending" gifts have no claimedAt field, so they're
    // untouched/kept forever until claimed. Once claimed, the record is
    // never read again anywhere — auto-deletes exactly 24h after the
    // claim (not after creation).
    await db.collection("gifts").createIndex(
      { claimedAt: 1 },
      { name: "gifts_claimed_ttl", expireAfterSeconds: 24 * 60 * 60 }
    );

    // Broadcast jobs — "pending" jobs have finishedAt: null, so they're
    // untouched. Once a job finishes it's never read again — kept 14 days,
    // then auto-deleted.
    await db.collection("broadcast_jobs").createIndex(
      { finishedAt: 1 },
      { name: "broadcast_jobs_finished_ttl", expireAfterSeconds: 14 * 24 * 60 * 60 }
    );

    // Task submissions — ONLY "rejected" ones ever get a processedAt field
    // (see api/admin/tasks.js reject branch). "pending"/"approved" are
    // NEVER touched regardless of age — approved ones feed the lifetime
    // task count used for withdraw eligibility (api/withdraw.js), so they
    // must survive forever. partialFilterExpression is a second, belt-and-
    // braces guard on top of "the field is only ever set for rejected
    // docs". Kept 30 days after rejection, then auto-deleted.
    await db.collection("task_submissions").createIndex(
      { processedAt: 1 },
      {
        name: "task_submissions_rejected_ttl",
        expireAfterSeconds: 30 * 24 * 60 * 60,
        partialFilterExpression: { status: "rejected" },
      }
    );

    // Key Coin purchase orders — ONLY "pending" (unpaid/abandoned
    // checkout) orders are eligible, via partialFilterExpression. The
    // instant an order flips to "paid" (see handleTonWebhook / the
    // reconcile-cron path in api/user.js) it stops matching this filter
    // and is kept forever as a permanent payment record.
    // CAUTION: if a buyer opens checkout and then actually sends the TON
    // payment more than 3 days later, the order will already be gone and
    // that payment can no longer auto-match by expectedNano. 3 days is a
    // generous window for a checkout that normally completes in minutes —
    // widen this value if that ever happens in practice.
    await db.collection("key_orders").createIndex(
      { createdAt: 1 },
      {
        name: "key_orders_pending_ttl",
        expireAfterSeconds: 3 * 24 * 60 * 60,
        partialFilterExpression: { status: "pending" },
      }
    );

    // Special-task "view" logs — proof a task link was opened, used only
    // to verify a claim made shortly afterward. Nothing ever reads these
    // more than a few minutes after they're written. Kept 30 days, then
    // auto-deleted — instantly re-created (it's an upsert) if the user
    // opens the link again after that.
    await db.collection("special_task_views").createIndex(
      { viewedAt: 1 },
      { name: "special_task_views_ttl", expireAfterSeconds: 30 * 24 * 60 * 60 }
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
