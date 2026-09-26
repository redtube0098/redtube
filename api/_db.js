// api/_db.js
// Shared MongoDB connection helper. Reuses connection across serverless invocations.
const { MongoClient } = require("mongodb");

let cachedClient = null;
let cachedDb = null;
let connectingPromise = null; // prevents race condition on concurrent cold starts
let indexesEnsured = false; // ensures we only try to create indexes once per warm container

// Runs ONE createIndex() call in its own try/catch and just logs on
// failure instead of throwing.
//
// WHY THIS EXISTS: ensureIndexes() used to run every createIndex() call
// below inside a single shared try/catch. If MongoDB rejected any ONE of
// them (most commonly IndexOptionsConflict — the same key pattern already
// exists with different options from an older deploy), that throw
// immediately aborted the whole function, which meant every index defined
// AFTER the failing one in the list was SILENTLY NEVER CREATED — not just
// on that request, but forever, because indexesEnsured is only set true
// on a full clean run, so every future request in the same warm container
// re-ran the list from the top and hit the exact same conflict at the
// exact same spot again. This file's comments already document one past
// occurrence of this (wal_logs/ad_logs/spin_logs duplicate definitions
// blocking key_orders' TTL from ever being created) — and since
// promocodes' TTL index is the very LAST one defined below, it is exactly
// as exposed to this failure mode as key_orders was.
//
// Wrapping each createIndex() individually means a conflict/failure on
// ANY one index (old or new, TTL or not) can only ever affect that one
// index — every other index in the list, no matter where it sits, still
// gets created normally. Check server logs for "[DB INDEX ERROR]" to see
// exactly which index (if any) is currently failing and why.
async function safeCreateIndex(db, collectionName, keys, options) {
  try {
    await db.collection(collectionName).createIndex(keys, options);
  } catch (e) {
    console.error(
      `[DB INDEX ERROR] Failed to create index "${options && options.name}" on "${collectionName}":`,
      e.message
    );
  }
}

// Drops an index by name before we recreate it with different options
// (e.g. a shorter TTL). MongoDB rejects a second index on the SAME key
// pattern with different options even if the name differs — so shrinking
// an existing TTL value requires dropping the old named index first, then
// safeCreateIndex() below (re)creates it fresh. Safe/idempotent: if the
// index doesn't exist yet (brand-new deploy) or was already dropped by a
// previous cold start, this just logs nothing and moves on.
async function safeDropIndex(db, collectionName, indexName) {
  try {
    await db.collection(collectionName).dropIndex(indexName);
  } catch (e) {
    if (e.codeName !== "IndexNotFound" && !/index not found/i.test(e.message || "")) {
      console.error(
        `[DB INDEX ERROR] Failed to drop old index "${indexName}" on "${collectionName}":`,
        e.message
      );
    }
  }
}

async function ensureIndexes(db) {
  if (indexesEnsured) return;

  // CRITICAL: unique index on normalized address.
  // One address can only ever belong to one account — MongoDB itself
  // rejects a second insert for the same address, so no client-side
  // tooling or replayed/parallel requests can bypass this.
  await safeCreateIndex(db, "locked_withdraw_addresses",
    { address: 1 },
    { unique: true, name: "uniq_locked_address" }
  );
  // CRITICAL: unique index on userId.
  // One account can only ever be locked to one address — this is what
  // stops a user from later switching to a second address after their
  // first one is set.
  await safeCreateIndex(db, "locked_withdraw_addresses",
    { userId: 1 },
    { unique: true, name: "uniq_locked_userId" }
  );
  // Speeds up the pending-gift lookup that runs on every GET /api/user
  // (see api/user.js) — not unique, a user can have multiple gifts over
  // time, just never more than one usually-pending at once in practice.
  await safeCreateIndex(db, "gifts",
    { telegramId: 1, status: 1, createdAt: 1 },
    { name: "gifts_uid_status_created" }
  );
  // Speeds up the viewSpecialTask -> completeSpecialTask lookup in
  // api/task.js. One view record per (user, task) pair, upserted on
  // every view, so this is also effectively unique.
  await safeCreateIndex(db, "special_task_views",
    { telegramId: 1, taskId: 1 },
    { unique: true, name: "uniq_special_task_view" }
  );
  // Speeds up the WAL (Withdraw Address Lock attempts) admin tab, which
  // reads the most recent attempts across all users.
  await safeCreateIndex(db, "wal_logs",
    { createdAt: -1 },
    { name: "wal_logs_created_desc" }
  );
  // "all_users" broadcast mode pages through the users collection ordered
  // by telegramId using a { $gt: cursor } filter every cron tick (see
  // _telegram.js enqueueBroadcast/drainBroadcastQueue) — this index makes
  // that pagination an index scan instead of a full collection scan.
  await safeCreateIndex(db, "users",
    { telegramId: 1 },
    { unique: true, name: "uniq_users_telegramId" }
  );
  // Lets drainBroadcastQueue's "find the oldest pending job" query
  // (status: "pending", sort createdAt asc) use an index instead of
  // scanning every job document on every cron tick.
  await safeCreateIndex(db, "broadcast_jobs",
    { status: 1, createdAt: 1 },
    { name: "broadcast_jobs_status_created" }
  );
  // Speeds up the promo-code admin tab / redemption lookup (find by
  // uppercased code — see api/promo.js, api/admin/promo.js).
  await safeCreateIndex(db, "promocodes",
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
  // IndexOptionsConflict. That failure mode is now isolated per-index by
  // safeCreateIndex() above, but keep to one definition per field below
  // regardless — a rejected index still means THAT index's cleanup won't
  // run, even though it can no longer take any other index down with it.

  // wal_logs: security log of rejected withdraw-address-lock attempts.
  // Disposable 24h after being logged, no matter whether an admin ever
  // looked at it.
  await safeCreateIndex(db, "wal_logs",
    { createdAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60, name: "ttl_wal_logs_24h" }
  );

  // ad_logs: every ad view. Was kept 15 days; shrunk to 7 days (weekly
  // auto-clear, per product decision — MongoDB free-tier storage) since
  // nothing anywhere ever reads a log older than "today" (see
  // api/earn.js's watchedToday/_todayEarned/cooldown checks and
  // api/withdraw.js's daily-ads-watched eligibility check — confirmed
  // ad_logs isn't touched by the admin panel or any script either). The
  // old 15d-named index is dropped first (see safeDropIndex above) since
  // it can't coexist with a differently-configured index on the same
  // watchedAt field, then recreated here at 7d under a matching new name.
  await safeDropIndex(db, "ad_logs", "ttl_ad_logs_15d");
  await safeCreateIndex(db, "ad_logs",
    { watchedAt: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, name: "ttl_ad_logs_7d" }
  );

  // spin_logs: every spin. This 15-DAY time-based TTL is only a backstop
  // for users who stop spinning entirely (so a long-inactive user's old
  // spins don't sit forever) — the actual "keep only the last 15 spins"
  // requirement is enforced per-user, right after each insert, in
  // api/earn.js's POST /spin handler (MongoDB TTL can only expire by AGE,
  // not "keep the newest N per user", so that part can't live in an index
  // at all). Nothing anywhere reads a spin_logs doc beyond the single most
  // recent one (the per-spin cooldown calc), so both layers together are
  // safe — confirmed spin_logs isn't touched by the admin panel either.
  await safeCreateIndex(db, "spin_logs",
    { spunAt: 1 },
    { expireAfterSeconds: 15 * 24 * 60 * 60, name: "ttl_spin_logs_15d" }
  );
  // Speeds up BOTH the per-spin cooldown lookup (find latest spin for a
  // user) AND the new last-15-per-user prune query below — without this,
  // either query has to scan every spin_logs doc for a matching
  // telegramId instead of seeking directly via the index.
  await safeCreateIndex(db, "spin_logs",
    { telegramId: 1, spunAt: -1 },
    { name: "idx_spin_logs_uid_spunAt" }
  );

  // special_task_views: "I opened this task link" proof. Only ever
  // checked within ~30 minutes of being written (see api/task.js) — 24h
  // is a generous safety margin before auto-delete. Instantly
  // re-created (it's an upsert) if the link is opened again after that.
  await safeCreateIndex(db, "special_task_views",
    { viewedAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60, name: "ttl_special_task_views_24h" }
  );

  // Gifts — "pending" gifts have no claimedAt field, so they're
  // untouched/kept forever until claimed. Once claimed, the record is
  // never read again anywhere — auto-deletes 24h after the claim (not
  // after creation).
  await safeCreateIndex(db, "gifts",
    { claimedAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60, name: "ttl_gifts_claimed_24h" }
  );

  // Broadcast jobs — "pending" jobs have finishedAt: null, so they're
  // untouched. Once a job finishes it's never read again — kept 14 days,
  // then auto-deleted.
  await safeCreateIndex(db, "broadcast_jobs",
    { finishedAt: 1 },
    { expireAfterSeconds: 14 * 24 * 60 * 60, name: "ttl_broadcast_jobs_finished_14d" }
  );

  // Task submissions — ONLY "rejected" ones ever get a processedAt field
  // (see api/admin/tasks.js reject branch). "pending"/"approved" are
  // NEVER touched regardless of age — approved ones feed the lifetime
  // task count used for withdraw eligibility (api/withdraw.js), so they
  // must survive forever. Kept 30 days after rejection, then auto-deleted.
  await safeCreateIndex(db, "task_submissions",
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
  await safeCreateIndex(db, "task_submissions",
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
  await safeCreateIndex(db, "key_orders",
    { createdAt: 1 },
    {
      expireAfterSeconds: 24 * 60 * 60,
      name: "ttl_key_orders_pending_24h",
      partialFilterExpression: { status: "pending" },
    }
  );

  // CRITICAL PERFORMANCE FIX: every payment-matching lookup — the reconcile
  // cron's matchAndCreditPayment() (run once per matching-destination TonAPI
  // transaction, up to 100 times per tick), handleTonWebhook's single-tx
  // path, AND the expectedNano clash-check loop when a NEW order is created —
  // all query key_orders by exactly { expectedNano, status }. With no index
  // on expectedNano, every one of those findOne() calls was a FULL
  // COLLECTION SCAN. Paid orders are kept forever (never TTL'd — see the
  // comment above), so this collection only ever grows, and the scan cost
  // grows with it — this is exactly what was making the reconcile cron's
  // "matching-loop" stage take 6+ seconds and blow past CRON_DEADLINE_MS.
  // This index turns every one of those lookups into a fast index seek.
  await safeCreateIndex(db, "key_orders",
    { expectedNano: 1, status: 1 },
    { name: "idx_key_orders_expectedNano_status" }
  );

  // Promo codes — every code is disposable exactly 24h after an admin
  // creates it, regardless of usedCount/limit. Once the TTL sweep
  // deletes it, redemption naturally fails with "code not found" (see
  // api/promo.js) — no extra expiry-check logic needed anywhere else.
  await safeCreateIndex(db, "promocodes",
    { createdAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60, name: "ttl_promocodes_24h" }
  );

  // user_creation_locks — see api/user.js. Each lock document only needs
  // to live for the few hundred milliseconds it takes to resolve a
  // concurrent signup race; auto-deleting after 60s is a generous safety
  // margin (never read again after that) that keeps this tiny collection
  // from growing unbounded as new users sign up over time. Uses `_id`
  // (telegramId) as the lock key, so this TTL index is on a DIFFERENT
  // field (lockedAt) — `_id`'s own uniqueness (which is what actually
  // makes the lock work) is automatic and untouched by this.
  await safeCreateIndex(db, "user_creation_locks",
    { lockedAt: 1 },
    { expireAfterSeconds: 60, name: "ttl_user_creation_locks_60s" }
  );

  // special_tasks — a self-serve "Post Task" (see creditTaskPostOrder() in
  // api/user.js) only ever gets `completedAt` set once, by api/task.js,
  // the moment its paid-for completedCount cap is reached. Admin-created
  // special tasks (via the admin panel) never set this field at all, so
  // they're completely untouched by this — this only ever removes a
  // finished, capped-out POSTER task from the poster's own "History" tab
  // (GET action=my_posted_tasks) 24h after it finished, exactly matching
  // the "keep history visible for 24h after completion" requirement. Only
  // the document is deleted — the task's own effects (rewards already
  // paid out, referral counts, etc.) are all already durably recorded
  // elsewhere and are never touched by this cleanup.
  await safeCreateIndex(db, "special_tasks",
    { completedAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60, name: "ttl_special_tasks_completed_24h" }
  );

  // task_post_orders — same disposable-pending-payment pattern as
  // key_orders' own TTL just above: an unpaid "Post Task" checkout auto-
  // clears 24h after being created (via partialFilterExpression, so a
  // PAID order — which flips out of "pending" the instant payment is
  // confirmed, see creditTaskPostOrder() — is kept forever as a permanent
  // record). CAUTION: same as key_orders, if someone opens checkout and
  // actually sends the TON payment more than 24h later, the order will
  // already be gone and that payment can no longer auto-match by
  // expectedNano — widen this if that turns out to happen in practice.
  await safeCreateIndex(db, "task_post_orders",
    { createdAt: 1 },
    {
      expireAfterSeconds: 24 * 60 * 60,
      name: "ttl_task_post_orders_pending_24h",
      partialFilterExpression: { status: "pending" },
    }
  );

  // Same critical fix as key_orders above — task_post_orders is queried by
  // { expectedNano, status } from the exact same three call sites
  // (matchAndCreditPayment, handleTonWebhook, and the clash-check loop) and
  // had the same missing index / full-scan problem.
  await safeCreateIndex(db, "task_post_orders",
    { expectedNano: 1, status: 1 },
    { name: "idx_task_post_orders_expectedNano_status" }
  );

  // users — DORMANT ACCOUNT AUTO-DELETE. Per product decision: a user who
  // hasn't opened the app in 60 days (2 months) has their ENTIRE account
  // document — balance, usdtBalance, lifetimeEarned, referral history,
  // everything on the doc — permanently deleted. If the same Telegram
  // account opens the app again after that, api/user.js's normal
  // "create if not found" flow just makes a brand-new doc for that
  // telegramId, starting completely fresh (0 balance, no referral
  // history) — exactly the requested behavior.
  // CAUTION (explicitly confirmed by the site owner): this deletes real
  // RDC/USDT balance with no exception for users who have a nonzero
  // balance — an account sitting on a large balance is deleted just the
  // same as an empty one if its owner doesn't open the app for 60
  // straight days. There is no grace period, warning message, or
  // balance-based exemption. lastActiveAt is refreshed on every GET
  // /api/user (i.e. every time the app is opened — see api/user.js), so
  // genuinely active users are never at risk.
  // NOTE: only the `users` doc itself is deleted by this index. A few
  // OTHER collections that also reference this telegramId are
  // deliberately left untouched by this cleanup: `withdraws` (payment/
  // payout audit trail) and `locked_withdraw_addresses` (the anti-farming
  // "one address per account" lock) are kept forever regardless, same as
  // before — so if the same person returns after being auto-deleted,
  // their old withdraw address lock (if any) still applies to their fresh
  // account. `task_submissions`/`special_task_logs` similarly aren't
  // auto-deleted by this index. Everything else per-user (ad_logs,
  // spin_logs, wal_logs, special_task_views) already has its own,
  // separate, much-shorter TTL above and will already be long gone well
  // before the 60-day mark either way.
  await safeCreateIndex(db, "users",
    { lastActiveAt: 1 },
    { expireAfterSeconds: 60 * 24 * 60 * 60, name: "ttl_users_dormant_60d" }
  );

  // Marked true even if one or more individual indexes above failed
  // (each failure was already logged by safeCreateIndex) — retrying the
  // WHOLE list on every request would just re-hit the same persistent
  // conflicts forever without fixing anything; a real fix requires
  // resolving that specific index in the database. This only skips
  // re-attempting for the rest of this warm container's lifetime, not
  // permanently — a fresh cold start (new deploy, or the container
  // recycling) will retry everything again.
  indexesEnsured = true;
  console.log("[DB] Indexes ensured (see any [DB INDEX ERROR] lines above for individual failures)");
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

      // IMPORTANT: do NOT await this. createIndex() blocks (from the
      // driver's side) until the server finishes building the index — for
      // a BRAND NEW index on an existing, non-trivial collection (like the
      // expectedNano/status index just added to key_orders/task_post_orders,
      // both of which keep every paid order forever), that build can take
      // far longer than a few seconds. Awaiting it here means EVERY cold
      // container — not just the reconcile cron, literally any request
      // that hits a fresh container — would block on getDb() until the
      // index finishes building, which is almost certainly why the
      // reconcile cron was seen hanging the FULL 30s with zero response
      // right after this index was added (a cold start hit the collection
      // mid-build). MongoDB's index builds have been non-blocking for
      // concurrent reads/writes since 4.2 (the "hybrid" build), so there is
      // no correctness reason to make every cold start wait for this to
      // finish — queries just run unindexed (slower) until the build
      // completes, then speed up automatically. Errors are still logged by
      // safeCreateIndex()'s own try/catch either way.
      ensureIndexes(cachedDb).catch((e) =>
        console.error("[DB] Background ensureIndexes failed:", e.message)
      );

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
