const fetch = require("node-fetch");
const { getDb } = require("./_db");
const { isMember, tgCall, notifyIfValidReferral, maybeRewardStep2Task, isBotAdminOf, enqueueBroadcast } = require("./_telegram");
const { getClientIp, isSameDevice, isPlausibleIp, checkIpLock } = require("./_utils");
const { verifyInitData } = require("./_verifyInitData");

const CHANNEL_1 = "@redtubecommunity";
const CHANNEL_2 = "@redtubeofficial00";
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

// checkIpLock now lives in ./_utils.js (shared with earn.js) — see that
// file for the implementation and why it was moved.

// ---------- 🔑 KEY STORE (buy Key Coins with real TON via TonAPI/TON Console) ----------
// Key Coins are the same currency minted 1-per-valid-referral in
// notifyIfValidReferral (api/_telegram.js) and spent 1-per-withdrawal in
// api/withdraw.js. This lets anyone who can't easily get referrals just buy
// their withdraw allowance instead. Kept in this file (not a new serverless
// function) per the project's "extend existing routes" convention.
//
// HOW DEPOSITS ARE DETECTED (no polling, scales to any number of concurrent
// buyers on the TonAPI free plan's 1 req/sec limit):
// 1. Every order gets a unique short "comment" (memo). The buyer is asked to
//    send exactly `priceTon` TON to TON_DEPOSIT_ADDRESS with that comment
//    attached (we build a ton:// / Tonkeeper deep link that pre-fills it).
// 2. We subscribe TON_DEPOSIT_ADDRESS ONCE to TonAPI's Webhooks API (see the
//    one-time curl setup — not done per request, done once ever). From then
//    on, ANY transaction touching that single address — whether 1 buyer or
//    100,000 buyers pay at the same second — makes TonAPI push ONE POST to
//    our /api/user?ton_webhook=1 endpoint per transaction. We never poll.
// 3. That webhook body is NOT cryptographically signed by TonAPI, so it's
//    treated as a hint only, never as truth: on receiving it we re-fetch the
//    real transaction straight from TonAPI by tx_hash (1 authenticated GET,
//    using our own TON_API_KEY) and only credit Key Coins based on THAT
//    verified data (destination address, exact comment, value) — so a
//    forged POST to our webhook URL can never credit anything on its own.
const KEY_PRICE_TON = 0.015; // price per single Key Coin, in TON
const KEY_PACKAGES = {
  pack_1: { quantity: 1 },
  pack_2: { quantity: 2 },
  pack_5: { quantity: 5 },
  pack_10: { quantity: 10 },
};
function keyPackagePrice(quantity) {
  // Round to 6 decimals to avoid binary-float dust like 0.030000000000000002
  return Math.round(quantity * KEY_PRICE_TON * 1e6) / 1e6;
}
function tonToNano(ton) {
  return Math.round(ton * 1e9); // TON's on-chain unit is nanoton (1 TON = 1e9 nanoton)
}

// ---------- UNIQUE-AMOUNT ORDER MATCHING ----------
// Each order's actual on-chain amount = base package price PLUS a small
// random nanoton offset (0.000001–0.000999 TON), so no two pending orders
// ever expect the exact same nanoton amount. This means matching an
// incoming payment back to an order needs only (destination address +
// exact nanoton amount) — no text comment/memo required at all. That
// matters because TonConnect's sendTransaction (unlike the ton:// deep
// link's plain "text=" param) needs a comment encoded as a binary cell/BOC
// to attach one, which needs a real TON cell-building library we don't
// otherwise depend on — skipping comments entirely avoids that whole
// category of bugs for zero real downside (the offset is invisible to the
// buyer; the wallet just shows "0.015893 TON" instead of "0.015 TON").
function addUniqueOffset(baseTon) {
  const offsetNano = 1000 + Math.floor(Math.random() * 999000); // 0.000001–0.001 TON
  return tonToNano(baseTon) + offsetNano;
}

// ---------- 📢 POST TASK (self-serve, pay-to-post tasks) ----------
// Lets any regular user pay TON to post their own task (either "join my
// channel/group" or "visit my bot/website link") into the SAME
// special_tasks collection/UI admin-created tasks already use (see
// api/task.js's completeSpecialTask and api/admin/tasks.js) — just with
// three extra fields: postedBy (who paid), maxCompletions (the paid-for
// cap), and completedCount (how many users have completed it so far).
// Admin-created tasks are completely unaffected: they simply never set
// maxCompletions, so the cap/auto-close logic in api/task.js is a no-op
// for them (see the comment there).
//
// ⚠️ ADJUSTABLE: these 4 tiers and the flat per-completion reward are
// placeholder numbers — tune them to your actual economics. Price is in
// TON (paid the same way as the Key Store above); reward is in RDC, paid
// out of the same balance pool as every other task.
const TASK_POST_TIERS = [
  { id: "tier_100", maxCompletions: 100, priceTon: 0.15 },
  { id: "tier_200", maxCompletions: 200, priceTon: 0.3 },
  { id: "tier_500", maxCompletions: 500, priceTon: 0.75 },
  { id: "tier_1000", maxCompletions: 1000, priceTon: 1.5 },
];
const TASK_POST_REWARD_PER_COMPLETION = 10; // RDC paid to each user who completes a posted task

// Shown first in the "new task added" broadcast, before the "Added New
// task ✅" caption text — see creditTaskPostOrder() below.
const TASK_POST_ANNOUNCE_IMAGE_URL =
  "https://i.postimg.cc/T1p81mYp/Gemini-Generated-Image-gain77gain77gain.jpg";
// "OPEN TASK" button under that broadcast — a Mini App deep link with
// ?startapp=task, which the frontend (public/app.js, see enterApp())
// reads as start_param === "task" and routes straight to the Task tab.
const TASK_SECTION_DEEP_LINK = "https://t.me/redtube12_bot/earn?startapp=task";

// Very deliberately permissive (accepts any http(s) URL, or a bare
// @username / t.me link for a bot) — this is a "did you paste something
// URL-shaped at all" sanity check, not a content/safety filter. Its whole
// job is to stop an obviously-broken/empty link from reaching a real
// payment step, per the "warn before deposit if invalid" requirement.
function isPlausibleTaskLink(link) {
  if (typeof link !== "string") return false;
  const trimmed = link.trim();
  if (!trimmed) return false;
  if (/^https?:\/\/.+/i.test(trimmed)) return true;
  if (/^(https?:\/\/)?t\.me\/\w+/i.test(trimmed)) return true;
  return false;
}

function findTaskPostTier(tierId) {
  return TASK_POST_TIERS.find((t) => t.id === tierId) || null;
}

const TON_API_KEY = process.env.TON_API_KEY; // from tonconsole.com -> TON API -> API Keys
const TON_DEPOSIT_ADDRESS = process.env.TON_DEPOSIT_ADDRESS; // the single wallet all Key Store payments go to
const TONAPI_BASE = "https://tonapi.io/v2";

// ---------- WEBHOOK DEADLINE GUARD ----------
// TonAPI's Webhooks API gives up waiting for OUR response after a fairly
// short window and — critically — counts that as a "failed_attempts" strike
// against the subscription (visible via GET /webhooks/{id}/account-tx/
// subscriptions and GET /webhooks/{id}/logs). Enough consecutive strikes and
// TonAPI SUSPENDS the webhook outright (it then needs a manual POST
// /webhooks/{id}/back-online to resume) — after that, delivery stops
// completely and silently, with zero error on our side, which is exactly
// the "only the cron works" symptom. Our try/catch below already turns any
// THROWN error into a fast 200, but it does nothing if a step just hangs
// (Mongo cold start, a slow TonAPI lookup, socketTimeoutMS is 45s in
// _db.js) — that's slower than TonAPI is willing to wait, so it never even
// reaches our catch block before TonAPI's own client gives up. WITH_DEADLINE
// races the real work against a hard local timeout so we ALWAYS answer
// TonAPI well inside its window; if we lose the race we still return 200
// (so no failed_attempts strike) and simply leave the order "pending" —
// handleReconcilePendingPayments (the cron) picks up anything the webhook
// didn't finish in time, same as it already does for missed deliveries.
const WEBHOOK_DEADLINE_MS = 8000;
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[DEADLINE] ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// node-fetch v2 has no built-in timeout — a slow/stuck TonAPI response would
// otherwise hang until the platform's own request limit, well past
// WEBHOOK_DEADLINE_MS. AbortController bounds it explicitly.
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------- ADDRESS-FORMAT-SAFE MATCHING ----------
// TonAPI transaction payloads report in_msg.destination in RAW form
// ("0:9f9a...be97"), while TON_DEPOSIT_ADDRESS is normally set as the
// FRIENDLY, base64url form ("UQCfk1W0..." — what wallets/explorers show).
// These are two different string encodings of the exact same account, not
// just a casing difference, so a plain (even case-insensitive) string
// compare between them can NEVER match — which silently made every real,
// on-chain payment look like "wrong destination, ignore" to both
// handleTonWebhook and handleReconcilePendingPayments, no matter how many
// TON actually arrived. Resolving TON_DEPOSIT_ADDRESS to its raw form once
// (via TonAPI's own /accounts lookup, which accepts either format and
// always echoes back the raw one) and comparing against THAT closes the
// gap. Cached per warm container since the deposit address never changes
// mid-deployment.
let cachedDepositRawAddress = null;
async function getDepositRawAddress() {
  if (cachedDepositRawAddress) return cachedDepositRawAddress;
  if (!TON_API_KEY || !TON_DEPOSIT_ADDRESS) return null;
  try {
    const res = await fetch(`${TONAPI_BASE}/accounts/${encodeURIComponent(TON_DEPOSIT_ADDRESS)}`, {
      headers: { Authorization: `Bearer ${TON_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`[TONAPI] Could not resolve TON_DEPOSIT_ADDRESS to raw form: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data && typeof data.address === "string") {
      cachedDepositRawAddress = data.address;
      console.log(`[TONAPI] Resolved TON_DEPOSIT_ADDRESS -> raw form ${cachedDepositRawAddress}`);
    }
  } catch (e) {
    console.error("[TONAPI] Failed to resolve TON_DEPOSIT_ADDRESS to raw form:", e.message);
  }
  return cachedDepositRawAddress;
}

// Matches a tx's in_msg.destination against our deposit wallet in WHICHEVER
// form TonAPI happened to hand back (raw or friendly), instead of assuming
// one. rawDepositAddress should come from getDepositRawAddress() above.
function isOurDepositAddress(destination, rawDepositAddress) {
  if (typeof destination !== "string") return false;
  if (destination === TON_DEPOSIT_ADDRESS || destination.toUpperCase() === TON_DEPOSIT_ADDRESS.toUpperCase()) {
    return true;
  }
  if (rawDepositAddress && destination.toLowerCase() === rawDepositAddress.toLowerCase()) {
    return true;
  }
  return false;
}

module.exports = async (req, res) => {
  try {
    // ---------- TONAPI WEBHOOK (no Telegram session — server-to-server) ----------
    // TonAPI calls this URL whenever a transaction touches TON_DEPOSIT_ADDRESS,
    // so it must be reachable BEFORE the verifyInitData() gate below (TonAPI
    // never sends Telegram initData). This exact URL is what gets registered
    // once via the one-time Webhooks API setup (see setup notes given
    // separately) — https://<your-domain>/api/user?ton_webhook=1
    if (req.method === "POST" && req.query && req.query.ton_webhook === "1") {
      return handleTonWebhook(req, res);
    }

    // ---------- 🔑 KEY STORE: PAYMENT RECONCILIATION CRON (safety net) ----------
    // handleTonWebhook above only ever fires if TonAPI's Webhooks API
    // actually delivers a POST to us — that's an external subscription
    // (address -> our URL) set up once, outside this codebase, and it CAN
    // silently stop working (subscription never created, expired, or still
    // pointed at an old/stale Vercel domain after a redeploy) with zero
    // error on our side, because we simply never hear from it. The buyer's
    // TON is on-chain and irreversible either way — only OUR crediting step
    // is missing. See handleReconcilePendingPayments below for the fix:
    // same source of truth (an authenticated TonAPI lookup), same matching
    // logic (destination + exact expectedNano) and same idempotent
    // status:"pending"->"paid" guard as handleTonWebhook, just pulled by us
    // on a timer instead of pushed by TonAPI — so it can never double-credit
    // an order the webhook already caught, and it catches anything the
    // webhook ever misses.
    // GET https://YOUR_DOMAIN/api/user?cron=check-payments&secret=YOUR_CRON_SECRET
    // (same CRON_SECRET env var / auth pattern as api/bot.js's ?cron=reset-notify
    // — set up an external pinger, e.g. cron-job.org, hitting this URL every
    // 1-5 minutes.)
    if (req.method === "GET" && req.query && req.query.cron === "check-payments") {
      return handleReconcilePendingPayments(req, res);
    }

    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    // uid always comes from verified data now — the client can no longer
    // request or modify another user's profile by passing a different uid
    const uid = verifiedUser.id;

    // SECURITY FIX: username/firstName must come from the verified,
    // Telegram-signed initData — not from req.body. The client body is
    // unauthenticated and can be freely edited (e.g. via devtools), so
    // trusting it here would let a user store an arbitrary fake name/
    // username in the DB (shown later to admins and other users) even
    // though their identity (uid) is verified. The signed values are the
    // source of truth for what to display/store.
    const verifiedUsername = typeof verifiedUser.username === "string" ? verifiedUser.username.slice(0, 64) : null;
    const verifiedFirstName = typeof verifiedUser.first_name === "string" ? verifiedUser.first_name.slice(0, 128) : null;

    const db = await getDb();
    const users = db.collection("users");

    if (req.method === "GET") {
      let user = await users.findOne({ telegramId: uid });
      if (!user) return res.status(404).json({ error: "not found" });

      // ---------- REFERRAL SELF-HEALING / BACKFILL (runs on every home
      // page load, since app.js's refreshUser() calls this GET endpoint on
      // every renderHome()) ----------
      // Why this is needed here, on a READ path, and not just on the write
      // paths in user.js/task.js/earn.js: maybeRewardStep2Task and
      // notifyIfValidReferral both early-return the instant their own flag
      // is already set, so each of them only ever gets ONE real chance to
      // fire per referred user — whichever write request happens to be the
      // one that completes their own tier. If a referred user's 10-task
      // tier was actually completed via ADMIN MANUAL APPROVAL (in
      // api/admin/tasks.js) rather than auto-approve or a special-task
      // claim, maybeRewardStep2Task is never invoked at all for that
      // completion — so step2Rewarded can sit at false forever even though
      // the real approved-submission count in the DB already crossed 10,
      // and that referral can never become "valid" no matter how many more
      // ads they watch or tasks they do afterward. Same story for any
      // referral whose steps finished in an order where the tier that
      // finished LAST had its own endpoint already mark step complete
      // before an earlier tier's flag caught up — that endpoint's own
      // "already done, skip" guard means it never re-checks the other two
      // tiers or re-fires the notification.
      //
      // Re-running both here, every time this user's own profile loads,
      // closes that gap for every existing referred user (old or current)
      // the next time they simply open the app — no migration script, no
      // new serverless function needed. Both calls are cheap, fully
      // idempotent, and no-ops for the vast majority of requests (anyone
      // without a referrer, or already fully processed).
      if (user.referredBy) {
        await maybeRewardStep2Task(db, users, uid);
        const freshUser = await users.findOne({ telegramId: uid });
        if (freshUser) {
          await notifyIfValidReferral(users, freshUser);
          user = freshUser;
        }
      }

      // ---------- 🔑 KEY COIN ONE-TIME MIGRATION ----------
      // The old withdraw-allowance system tracked unused valid referrals as
      // (validReferralsCount - referralsConsumed) instead of a spendable
      // balance. Now that Key Coins exist, fold every user's still-unused
      // old allowance into keyCoinBalance exactly once, the next time their
      // profile loads — same self-healing-on-read pattern as the referral
      // backfill above, no separate migration script needed. The
      // keyCoinMigrated flag guarantees this only ever runs once per user,
      // so it can never double-credit on repeated GETs.
      if (!user.keyCoinMigrated) {
        const leftoverOldAllowance = Math.max(
          0,
          (user.validReferralsCount || 0) - (user.referralsConsumed || 0)
        );
        const claim = await users.updateOne(
          { telegramId: uid, keyCoinMigrated: { $ne: true } },
          {
            $inc: { keyCoinBalance: leftoverOldAllowance },
            $set: { keyCoinMigrated: true },
          }
        );
        if (claim.modifiedCount > 0) {
          const freshUser = await users.findOne({ telegramId: uid });
          if (freshUser) user = freshUser;
        }
      }

      let tasksAvailable = 0;
      try {
        const tasks = db.collection("tasks");
        tasksAvailable = await tasks.countDocuments({ active: true });
      } catch (e) {
        console.error("[WARN] tasksAvailable lookup failed:", e.message);
      }

      const videosToWatch = user.videosToWatch || 0;

      // ---------- PENDING GIFT (admin "Gift" panel) ----------
      // Oldest unclaimed gift for this user, if any — the frontend shows
      // this as a full-screen claim card the moment the app loads. Kept as
      // a lightweight lookup here (not a separate endpoint) since this GET
      // already fires on every app open/refreshUser() call — see
      // api/admin/users.js "send_gift" for how these get created and
      // POST action:"claim_gift" below for how they get paid out.
      let pendingGift = null;
      try {
        const gifts = db.collection("gifts");
        const gift = await gifts.findOne(
          { telegramId: uid, status: "pending" },
          { sort: { createdAt: 1 } }
        );
        if (gift) {
          pendingGift = { id: gift._id, amount: gift.amount, reason: gift.reason || "Just a gift 🎁" };
        }
      } catch (e) {
        console.error("[WARN] pendingGift lookup failed:", e.message);
      }

      return res.status(200).json({
        pendingGift,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        balance: user.balance,
        usdtBalance: user.usdtBalance || 0,
        lifetimeEarned: user.lifetimeEarned,
        adsWatchedToday: user.adsWatchedToday,
        tasksDoneToday: user.tasksDoneToday,
        referralsCount: user.referralsCount || 0,
        validReferralsCount: user.validReferralsCount || 0,
        keyCoinBalance: user.keyCoinBalance || 0,
        joined: user.joined || false,
        tasksCompleted: user.tasksCompleted || 0,
        tasksAvailable,
        videosToWatch,
      });
    }

    if (req.method === "POST") {
      const { action, refBy: rawRefBy } = req.body || {};
      const ip = getClientIp(req);

      let refBy = Number(rawRefBy);
      if (!Number.isFinite(refBy) || !Number.isInteger(refBy) || refBy <= 0 || refBy === uid) {
        refBy = null;
      }

      // ---------- ATOMIC USER CREATION (race-condition fix) ----------
      // WAS: `findOne` to check if the user exists, then a separate
      // `insertOne` if not. Those two steps are NOT atomic — two
      // concurrent POSTs for the same brand-new uid (e.g. a script firing
      // rapid/parallel requests via devtools, or just two legitimate
      // near-simultaneous app-opens) could BOTH pass the findOne check
      // (both see "no user yet") and BOTH insertOne, creating two separate
      // `users` documents for the same telegramId. That's exactly how a
      // duplicate account got created in production — see the [DB INDEX
      // ERROR] duplicate-key failure on uniq_users_telegramId (api/_db.js)
      // this surfaced as, and scripts/resolve-duplicate-user.js for the
      // cleanup tool.
      //
      // NOW: findOneAndUpdate with upsert:true is a SINGLE atomic
      // operation — MongoDB guarantees at most one document is created
      // for this filter even under concurrent requests, AS LONG AS a
      // unique index exists on telegramId (uniq_users_telegramId in
      // api/_db.js) to back it — upsert alone, without that index, can
      // still rarely race. The try/catch below is the belt-and-suspenders
      // fallback for that documented rare edge case: if two upserts
      // somehow still collide, MongoDB itself will reject the loser with
      // a duplicate-key error (E11000) instead of silently creating a
      // second document, and we just re-fetch the winner's doc.
      let user;
      let wasNewUser = false;
      let validRefBy = null;
      if (refBy) {
        // Confirm the referrer actually exists before trusting it — stops
        // referral-farming with made-up ids. Safe to run unconditionally
        // (harmless no-op read) before we know yet whether uid is new.
        const refUser = await users.findOne({ telegramId: refBy });
        if (refUser) validRefBy = refBy;
      }

      // ---------- CREATION LOCK (closes the race regardless of whether
      // uniq_users_telegramId has actually finished building) ----------
      // The atomic upsert below is only FULLY race-proof once
      // uniq_users_telegramId (api/_db.js) has successfully built — see
      // that upsert's own comment. That index requires the ENTIRE `users`
      // collection to be duplicate-free before MongoDB will finish
      // building it, which created a vicious cycle in production: any
      // still-unresolved duplicate blocked the index from building, and
      // with the index not actually present yet, concurrent upserts for a
      // BRAND NEW telegramId could still both succeed and create a fresh
      // duplicate — which then blocked the index from building. Manually
      // resolving duplicates one at a time in the admin panel could never
      // fully catch up while that loop kept generating new ones (see the
      // recurring "[DB INDEX ERROR] ... dup key: { telegramId: ... }"
      // logs, a different telegramId each time).
      //
      // This lock collection breaks that dependency entirely. `_id` is
      // ALWAYS uniquely indexed by MongoDB the instant a collection is
      // created — there is no separate index-build step that can ever be
      // blocked by pre-existing data, unlike a secondary index such as
      // uniq_users_telegramId. Using telegramId AS the lock document's
      // `_id` means only ONE concurrent request can ever win the
      // insertOne below for a given telegramId, guaranteed, from the very
      // first request onward — completely independent of whatever state
      // uniq_users_telegramId is currently in. The loser gets an E11000
      // immediately (typically in milliseconds) and just waits briefly
      // then reads back the winner's document, instead of racing all the
      // way to its own insert like before.
      const creationLocks = db.collection("user_creation_locks");
      try {
        await creationLocks.insertOne({ _id: uid, lockedAt: new Date() });
      } catch (e) {
        if (e && e.code === 11000) {
          // Someone else is creating this exact telegramId RIGHT NOW.
          // Briefly wait for them to finish, then just read their result —
          // never attempt our own insert in this case.
          console.warn(`[USER] Creation lock contention for telegramId ${uid} — waiting for the winner.`);
          await new Promise((r) => setTimeout(r, 400));
          const winner = await users.findOne({ telegramId: uid });
          if (winner) {
            user = winner;
            wasNewUser = false;
          }
        } else {
          console.error("[USER] Creation lock insert failed (non-duplicate error):", e.message);
        }
      }

      if (!user) {
        try {
          const upsertResult = await users.findOneAndUpdate(
            { telegramId: uid },
            {
              $setOnInsert: {
                telegramId: uid,
                username: verifiedUsername,
                firstName: verifiedFirstName,
                balance: 0,
                usdtBalance: 0,
                lifetimeEarned: 0,
                adsWatchedToday: 0,
                tasksDoneToday: 0,
                tasksCompleted: 0,
                totalAdsWatched: 0,
                referralsCount: 0,
                referralEarnings: 0,
                referredBy: validRefBy,
                joined: false,
                createdAt: new Date(),
              },
              $set: { lastIp: ip },
            },
            { upsert: true, returnDocument: "after", includeResultMetadata: true }
          );
          user = upsertResult.value;
          wasNewUser = !!(upsertResult.lastErrorObject && upsertResult.lastErrorObject.upserted);
        } catch (e) {
          if (e && e.code === 11000) {
            // Lost a genuine race to another concurrent request — that
            // request's document is the real one; just read it back.
            console.warn(`[USER] Upsert race for telegramId ${uid} — another request won, re-fetching.`);
            user = await users.findOne({ telegramId: uid });
            wasNewUser = false;
          } else {
            throw e;
          }
        }
      }

      if (wasNewUser) {
        if (ADMIN_ID) {
          const refText = validRefBy ? `\nReferred by: ${validRefBy}` : "";
          tgCall("sendMessage", {
            chat_id: ADMIN_ID,
            text: `🆕 New user joined REDTUBE!\nUID: ${uid}\nUsername: @${user.username || "none"}\nName: ${user.firstName || "unknown"}${refText}`,
          }).catch((e) => console.error("[WARN] Admin notify failed:", e.message));
        }
      } else if (user) {
        // Keep username/firstName in sync with Telegram in case the user
        // changed their name/username since we last saw them — always from
        // verified data, never from the client body. (lastIp was already
        // set unconditionally by the $set above, for both branches.)
        const updates = {};
        if (verifiedUsername !== null && verifiedUsername !== user.username) updates.username = verifiedUsername;
        if (verifiedFirstName !== null && verifiedFirstName !== user.firstName) updates.firstName = verifiedFirstName;
        if (Object.keys(updates).length > 0) {
          await users.updateOne({ telegramId: uid }, { $set: updates });
          user = { ...user, ...updates };
        }
      }

      // ---------- CLAIM GIFT (admin "Gift" panel payout) ----------
      // Always operates on the caller's OWN verified uid and the OLDEST
      // pending gift for them — the client never gets to pick a gift id or
      // another user's uid. The status:"pending" filter inside
      // findOneAndUpdate is the atomic guard: if the same gift somehow got
      // claimed twice in a race (double-tap, two tabs), only the first
      // update actually matches and pays out; the second finds nothing
      // left to claim.
      if (action === "claim_gift") {
        const gifts = db.collection("gifts");
        const gift = await gifts.findOne({ telegramId: uid, status: "pending" }, { sort: { createdAt: 1 } });
        if (!gift) {
          return res.status(404).json({ error: "no pending gift" });
        }
        const claimed = await gifts.findOneAndUpdate(
          { _id: gift._id, status: "pending" },
          { $set: { status: "claimed", claimedAt: new Date() } },
          { returnDocument: "after" }
        );
        const claimedDoc = claimed && typeof claimed === "object" && "value" in claimed ? claimed.value : claimed;
        if (!claimedDoc) {
          return res.status(409).json({ error: "gift already claimed" });
        }
        await users.updateOne(
          { telegramId: uid },
          { $inc: { balance: claimedDoc.amount, lifetimeEarned: claimedDoc.amount } }
        );
        console.log(`[GIFT] ${uid} claimed gift of ${claimedDoc.amount} RDC`);
        return res.status(200).json({ success: true, amount: claimedDoc.amount });
      }

      // ---------- 🔑 KEY STORE: buy_key ----------
      // Creates a pending TON payment order for a Key Coin package and hands
      // back a ready-to-open wallet deep link (Tonkeeper/ton:// universal
      // link) with the address, exact amount, and unique comment pre-filled.
      // Price/quantity are always looked up server-side from
      // KEY_PACKAGES/KEY_PRICE_TON — never trust a client-supplied amount
      // for a real payment. Coins are credited later by handleTonWebhook
      // once the TON transfer is actually seen on-chain, never here (this
      // only opens the checkout).
      if (action === "buy_key") {
        if (!TON_API_KEY || !TON_DEPOSIT_ADDRESS) {
          return res.status(503).json({ error: "Key Store is not configured yet — please contact support." });
        }
        const packageId = req.body && req.body.packageId;
        const pkg = KEY_PACKAGES[packageId];
        if (!pkg) {
          return res.status(400).json({ error: "invalid key package" });
        }
        const priceTon = keyPackagePrice(pkg.quantity);
        const orderId = `KEY-${uid}-${Date.now()}`;
        const keyOrders = db.collection("key_orders");

        // Collision retry: extremely unlikely (1-in-999000 odds per pending
        // order) but cheap to guard properly rather than assume.
        let expectedNano = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = addUniqueOffset(priceTon);
          const clash = await keyOrders.findOne({ expectedNano: candidate, status: "pending" });
          if (!clash) { expectedNano = candidate; break; }
        }
        if (expectedNano === null) {
          return res.status(503).json({ error: "Key Store is busy — please try again in a moment." });
        }

        const priceTonExact = expectedNano / 1e9;
        await keyOrders.insertOne({
          orderId,
          telegramId: uid,
          packageId,
          quantity: pkg.quantity,
          priceTon: priceTonExact,
          expectedNano,
          status: "pending",
          createdAt: new Date(),
        });
        console.log(`[KEYSTORE] Created pending order ${orderId} — uid ${uid}, expectedNano ${expectedNano} (${priceTonExact} TON)`);

        // No comment/memo needed — expectedNano alone (matched against
        // TON_DEPOSIT_ADDRESS) uniquely identifies this order, both for the
        // TonConnect path (plain address+amount, no cell-encoded payload
        // required) and the ton:// deep-link fallback below.
        const tonDeepLink = `ton://transfer/${TON_DEPOSIT_ADDRESS}?amount=${expectedNano}&text=${encodeURIComponent("Key Coin purchase")}`;
        const tonkeeperLink = `https://app.tonkeeper.com/transfer/${TON_DEPOSIT_ADDRESS}?amount=${expectedNano}&text=${encodeURIComponent("Key Coin purchase")}`;

        return res.status(200).json({
          success: true,
          orderId,
          quantity: pkg.quantity,
          priceTon: priceTonExact,
          amountNano: expectedNano,
          address: TON_DEPOSIT_ADDRESS,
          tonDeepLink,
          tonkeeperLink,
        });
      }

      // ---------- 🔑 KEY STORE: check_order (front-end status poll) ----------
      // Lets the "Waiting for payment" screen ask "has this specific order
      // been paid yet?" without needing a websocket/push channel. Scoped to
      // (orderId + the caller's own verified uid) so one buyer can never
      // read another buyer's order status. Read-only — this NEVER credits
      // anything itself; crediting only ever happens in handleTonWebhook /
      // handleReconcilePendingPayments above. Safe to poll as often as the
      // client likes.
      if (action === "check_order") {
        const orderId = req.body && req.body.orderId;
        if (!orderId) {
          return res.status(400).json({ error: "orderId required" });
        }
        const keyOrders = db.collection("key_orders");
        const order = await keyOrders.findOne({ orderId, telegramId: uid });
        if (!order) {
          return res.status(404).json({ error: "order not found" });
        }
        return res.status(200).json({
          success: true,
          status: order.status, // "pending" | "paid"
          quantity: order.quantity,
        });
      }

      // ---------- 📢 POST TASK: task_post_tiers (pricing lookup) ----------
      // Static, but served from an endpoint (not hardcoded in the frontend)
      // so the 4 tiers/prices above can be tuned without touching app.js.
      if (action === "task_post_tiers") {
        return res.status(200).json({
          success: true,
          tiers: TASK_POST_TIERS,
          rewardPerCompletion: TASK_POST_REWARD_PER_COMPLETION,
        });
      }

      // ---------- 📢 POST TASK: check_channel_admin ----------
      // Live "Verify" button in the Post Task form — lets someone check
      // whether the bot actually has admin rights in their channel/group
      // BEFORE they fill out the rest of the form or pay anything. This is
      // a UX convenience only: create_task_post_order below re-checks this
      // itself server-side right before creating a real payment order, so
      // this endpoint being informational-only (never trusted for the
      // actual payment/task-creation decision) is safe.
      if (action === "check_channel_admin") {
        const chatId = typeof req.body?.chatId === "string" ? req.body.chatId.trim() : "";
        if (!chatId) {
          return res.status(400).json({ error: "channel username is required" });
        }
        const isAdmin = await isBotAdminOf(chatId);
        return res.status(200).json({ success: true, isAdmin });
      }

      // ---------- 📢 POST TASK: create_task_post_order ----------
      // Same shape/flow as buy_key above: validates the draft task fields,
      // computes the tier's exact TON price (server-side only — never trust
      // a client-supplied price), stashes the whole draft on the pending
      // order itself (so nothing needs to be re-submitted after payment),
      // and hands back a payment-screen-ready deep link. The special_tasks
      // document itself is only ever created once payment is actually
      // confirmed — see creditTaskPostOrder() below, called from both
      // processVerifiedWebhookTx (webhook) and handleReconcilePendingPayments
      // (cron backup) via the shared matchAndCreditPayment() helper.
      if (action === "create_task_post_order") {
        if (!TON_API_KEY || !TON_DEPOSIT_ADDRESS) {
          return res.status(503).json({ error: "Post Task is not configured yet — please contact support." });
        }
        const { taskType, title, link, chatId, tierId } = req.body || {};

        if (!["channel_join", "link"].includes(taskType)) {
          return res.status(400).json({ error: "invalid task type" });
        }
        const trimmedTitle = typeof title === "string" ? title.trim() : "";
        if (!trimmedTitle || trimmedTitle.length > 100) {
          return res.status(400).json({ error: "title is required (max 100 characters)" });
        }
        const tier = findTaskPostTier(tierId);
        if (!tier) {
          return res.status(400).json({ error: "invalid tier selected" });
        }

        let finalLink = "";
        let finalChatId = null;
        if (taskType === "channel_join") {
          const trimmedChatId = typeof chatId === "string" ? chatId.trim() : "";
          if (!trimmedChatId) {
            return res.status(400).json({ error: "channel/group username is required" });
          }
          // Re-verify server-side right before creating a real payment order
          // — the earlier check_channel_admin call is only ever a UI hint,
          // never trusted for the actual gate.
          const isAdmin = await isBotAdminOf(trimmedChatId);
          if (!isAdmin) {
            return res.status(400).json({
              error: "The bot must be an admin of that channel/group before you can post this task. Please add it as admin and try again.",
            });
          }
          finalChatId = trimmedChatId.slice(0, 200);
          // Auto-derive the public join link from the username so the
          // poster doesn't have to separately paste one — this only works
          // for a public @username; a private channel's own invite link
          // would need a real "link" field, which is exactly what the
          // "link" task type below is for instead.
          finalLink = `https://t.me/${trimmedChatId.replace(/^@/, "")}`;
        } else {
          if (!isPlausibleTaskLink(link)) {
            return res.status(400).json({ error: "Please enter a valid link (starting with https:// or t.me/) before continuing." });
          }
          finalLink = link.trim().slice(0, 500);
        }

        const taskOrders = db.collection("task_post_orders");
        let expectedNano = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = addUniqueOffset(tier.priceTon);
          const clashKey = await db.collection("key_orders").findOne({ expectedNano: candidate, status: "pending" });
          const clashTask = await taskOrders.findOne({ expectedNano: candidate, status: "pending" });
          if (!clashKey && !clashTask) { expectedNano = candidate; break; }
        }
        if (expectedNano === null) {
          return res.status(503).json({ error: "Post Task is busy — please try again in a moment." });
        }

        const orderId = `TASKPOST-${uid}-${Date.now()}`;
        const priceTonExact = expectedNano / 1e9;
        await taskOrders.insertOne({
          orderId,
          telegramId: uid,
          expectedNano,
          priceTon: priceTonExact,
          status: "pending",
          draft: {
            type: taskType,
            title: trimmedTitle,
            link: finalLink,
            chatId: finalChatId,
            maxCompletions: tier.maxCompletions,
          },
          createdAt: new Date(),
        });
        console.log(`[POST TASK] Created pending order ${orderId} — uid ${uid}, tier ${tier.id}, expectedNano ${expectedNano} (${priceTonExact} TON)`);

        const tonDeepLink = `ton://transfer/${TON_DEPOSIT_ADDRESS}?amount=${expectedNano}&text=${encodeURIComponent("Post Task payment")}`;
        const tonkeeperLink = `https://app.tonkeeper.com/transfer/${TON_DEPOSIT_ADDRESS}?amount=${expectedNano}&text=${encodeURIComponent("Post Task payment")}`;

        return res.status(200).json({
          success: true,
          orderId,
          maxCompletions: tier.maxCompletions,
          priceTon: priceTonExact,
          amountNano: expectedNano,
          address: TON_DEPOSIT_ADDRESS,
          tonDeepLink,
          tonkeeperLink,
        });
      }

      // ---------- 📢 POST TASK: check_task_post_order (status poll) ----------
      if (action === "check_task_post_order") {
        const orderId = req.body && req.body.orderId;
        if (!orderId) {
          return res.status(400).json({ error: "orderId required" });
        }
        const order = await db.collection("task_post_orders").findOne({ orderId, telegramId: uid });
        if (!order) {
          return res.status(404).json({ error: "order not found" });
        }
        return res.status(200).json({ success: true, status: order.status });
      }

      // ---------- 📢 POST TASK: my_posted_tasks (History tab) ----------
      // Shows the poster's own tasks — active ones (still collecting
      // completions) and any that finished within the last 24h (see the
      // ttl_special_tasks_completed_24h index in api/_db.js, which is what
      // actually removes a finished task from here after that window, not
      // this query). Sorted newest first.
      if (action === "my_posted_tasks") {
        const list = await db
          .collection("special_tasks")
          .find({ postedBy: uid })
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray();
        return res.status(200).json({
          success: true,
          tasks: list.map((t) => ({
            id: t._id,
            title: t.title,
            type: t.chatId ? "channel_join" : "link",
            completedCount: t.completedCount || 0,
            maxCompletions: t.maxCompletions || null,
            active: !!t.active,
            createdAt: t.createdAt,
            completedAt: t.completedAt || null,
          })),
        });
      }

      // ---------- MULTI-ACCOUNT / IP LOCK: claim action ----------
      // Frontend's "Switch account (resets my balance)" button. Resets
      // every OTHER account seen on this IP to zero balance, then hands
      // this IP's "active" slot to the current account.
      if (action === "claim_ip") {
        if (!isPlausibleIp(ip) || ip === "unknown") {
          return res.status(200).json({ success: false, error: "ip_undetectable" });
        }
        await users.updateMany(
          { lastIp: ip, telegramId: { $ne: uid } },
          { $set: { balance: 0, usdtBalance: 0 } }
        );
        await db.collection("ipLocks").updateOne(
          { _id: ip },
          { $set: { activeTelegramId: uid, updatedAt: new Date() } },
          { upsert: true }
        );
        return res.status(200).json({ success: true });
      }

      const ipLockResult = await checkIpLock(db, uid, ip);

      if (action === "check_join") {
        const m1 = await isMember(CHANNEL_1, uid);
        const m2 = await isMember(CHANNEL_2, uid);
        const bothJoined = m1 && m2;

        // BUGFIX: previously the referral step1 reward was nested INSIDE
        // "if (bothJoined && !user.joined)" — meaning it only ever ran the
        // very first time a user transitioned from not-joined to joined.
        // Any user who was ALREADY joined=true before getting a referrer
        // (or before this reward logic existed) could never trigger step1,
        // permanently blocking their referrer's "valid referral" tier even
        // if tiers 2 and 3 were later completed. Now the "set joined=true"
        // write and the "check referral step1" logic are independent —
        // the referral check runs on every check_join call as long as
        // bothJoined is true and step1Rewarded hasn't been set yet, so an
        // already-joined user with a pending referral reward self-heals
        // the next time the app calls check_join (which happens on every
        // app open, see initApp() in app.js).
        if (bothJoined) {
          if (!user.joined) {
            await users.updateOne({ telegramId: uid }, { $set: { joined: true } });
          }

          if (user.referredBy) {
            if (!user.step1Rewarded) {
              // Atomic guard against double-rewarding step1 if check_join is
              // ever called twice in quick succession before step1Rewarded commits
              const claim = await users.updateOne(
                { telegramId: uid, step1Rewarded: { $ne: true } },
                { $set: { step1Rewarded: true } }
              );
              if (claim.modifiedCount > 0) {
                // MULTI-ACCOUNT GUARD: if this referred account shares the same
                // device/IP as the referrer, it's the same person creating
                // extra accounts to farm their own referral rewards. The
                // referral still gets COUNTED (referralsCount) so the admin
                // panel accurately shows how many "referrals" came in, but no
                // RDC (balance/lifetimeEarned/referralEarnings) is paid out
                // for it. Referrals from a genuinely different device pay out
                // exactly as before.
                const referrerUser = await users.findOne({ telegramId: user.referredBy });
                const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, ip);

                if (sameDeviceAsReferrer) {
                  await users.updateOne(
                    { telegramId: user.referredBy },
                    { $inc: { referralsCount: 1 } }
                  );
                } else {
                  await users.updateOne(
                    { telegramId: user.referredBy },
                    { $inc: { balance: 30, lifetimeEarned: 30, referralsCount: 1, referralEarnings: 30 } }
                  );
                }
              }
            }

            // BACKFILL / SELF-HEALING CHECK for "valid referral" (all 3
            // tiers): unlike the step1-reward block above, this call is
            // made UNCONDITIONALLY whenever the referred user has a
            // referrer and bothJoined is true — not only when step1 was
            // just newly claimed this call. This matters for any referred
            // user whose step1/step2/step3 flags were all ALREADY true
            // before the validReferralsCount system existed (or completed
            // across different app sessions) — those users would otherwise
            // never re-enter the "if (claim.modifiedCount > 0)" branch
            // above ever again, so notifyIfValidReferral would never run
            // for them and their referrer's valid-referral count would
            // stay stuck at 0 forever. notifyIfValidReferral itself is
            // cheap and fully idempotent — it checks step1Rewarded /
            // step2Rewarded / step3Rewarded / validReferralNotified and
            // no-ops instantly if any aren't met or it already fired — so
            // calling it here on every check_join (i.e. every app open,
            // see initApp() in app.js) safely and automatically catches up
            // every pre-existing qualifying referral the next time that
            // referred user opens the app, with no separate migration
            // script needed.
            const freshReferredUser = await users.findOne({ telegramId: uid });
            await notifyIfValidReferral(users, freshReferredUser);
          }
        }
        return res.status(200).json({ joined: bothJoined, ...ipLockResult });
      }

      return res.status(200).json({ joined: user.joined, ...ipLockResult });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] user.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ---------- TONAPI WEBHOOK HANDLER ----------
// TonAPI's webhook body is a bare, UNSIGNED hint — {account_id, lt, tx_hash}
// — so it is never trusted on its own. On receiving it, we make ONE
// authenticated GET back to TonAPI for the real transaction (by tx_hash)
// using our own TON_API_KEY, and only ever credit Key Coins based on THAT
// verified response (destination address, exact comment, exact value). A
// forged POST to this URL from anywhere else can, at worst, make us look up
// a real (or nonexistent) tx_hash — it can never fabricate a payment.
//
// Idempotency: a key_orders doc only ever flips "pending" -> "paid" once
// (atomic updateOne with a status:"pending" filter), so a duplicate webhook
// delivery for the same order — TonAPI's own retries, or replaying an old
// tx_hash — can never credit Key Coins twice.
async function handleTonWebhook(req, res) {
  try {
    if (!TON_API_KEY || !TON_DEPOSIT_ADDRESS) {
      console.error("[TONAPI] Webhook received but TON_API_KEY/TON_DEPOSIT_ADDRESS not configured");
      return res.status(503).json({ error: "not configured" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    // Log every single delivery, unconditionally, before any early return —
    // this is the ONLY way to see the real shape TonAPI actually sends
    // (docs/examples can be stale or incomplete), and every no-op path
    // below logs WHY it bailed, so a payment that silently fails to credit
    // is always traceable from the Vercel function logs afterward.
    console.log("[TONAPI] webhook received, raw body:", JSON.stringify(body));

    // Tolerate a few plausible field-name variants for the tx hash rather
    // than assuming one exact shape.
    const txHash = body.tx_hash || body.hash || body.txHash || (body.data && (body.data.tx_hash || body.data.hash));
    if (!txHash) {
      console.log("[TONAPI] no tx_hash found in payload — ignoring this delivery");
      return res.status(200).json({ ok: true });
    }

    return await withDeadline(
      processVerifiedWebhookTx(txHash, res),
      WEBHOOK_DEADLINE_MS,
      `handleTonWebhook tx=${txHash}`
    );
  } catch (err) {
    // Covers both a thrown error from processVerifiedWebhookTx AND a
    // withDeadline timeout (its rejection message is prefixed
    // "[DEADLINE]") — either way we still ack 200 so TonAPI does not count
    // this delivery as a failure/strike against the subscription, and the
    // reconcile cron will pick up any order this attempt didn't finish.
    console.error("[ERROR] TonAPI webhook:", err.message || err);
    if (!res.headersSent) {
      return res.status(200).json({ ok: false, timedOut: /^\[DEADLINE\]/.test(String(err.message)) });
    }
  }
}

// ---------- GENERIC ORDER MATCHING (shared: webhook + reconcile cron) ----------
// Both key_orders (Key Coin purchases) and task_post_orders (self-serve
// "Post Task" payments) are matched the exact same way — a verified
// on-chain payment arrives with (destination address, exact nanoton
// amount), and whichever collection currently has a "pending" order
// expecting that precise amount is the one that gets credited.
// addUniqueOffset() makes every order's amount effectively unique across
// the WHOLE app (not just within one collection — create_task_post_order
// above checks both collections for a clash before settling on an
// expectedNano), so checking key_orders first and only falling through to
// task_post_orders if nothing matched there can never double-credit or
// cross-match the wrong thing.
// Returns a short string describing what was credited (for logging), or
// null if the amount matched no pending order in either collection.
async function matchAndCreditPayment(db, receivedNano, txHash, creditedBy) {
  const keyOrders = db.collection("key_orders");
  const users = db.collection("users");

  const keyOrder = await keyOrders.findOne({ expectedNano: receivedNano, status: "pending" });
  if (keyOrder) {
    const claim = await keyOrders.updateOne(
      { orderId: keyOrder.orderId, status: "pending" },
      { $set: { status: "paid", paidAt: new Date(), txHash, creditedBy } }
    );
    if (claim.modifiedCount === 0) return null; // lost the race to another delivery
    await users.updateOne(
      { telegramId: keyOrder.telegramId },
      { $inc: { keyCoinBalance: keyOrder.quantity } }
    );
    tgCall("sendMessage", {
      chat_id: keyOrder.telegramId,
      text: `✅ Payment received! ${keyOrder.quantity} 🔑 Key Coin${keyOrder.quantity > 1 ? "s" : ""} added to your account.`,
    }).catch((e) => console.error("[PAYMENT] key-order notify failed:", e.message));
    console.log(`[PAYMENT] Key order ${keyOrder.orderId} paid — credited ${keyOrder.quantity} Key Coin(s) to uid ${keyOrder.telegramId}`);
    return `key_order:${keyOrder.orderId}`;
  }

  const taskOrder = await db.collection("task_post_orders").findOne({ expectedNano: receivedNano, status: "pending" });
  if (taskOrder) {
    const credited = await creditTaskPostOrder(db, taskOrder, txHash, creditedBy);
    return credited ? `task_post_order:${taskOrder.orderId}` : null;
  }

  return null;
}

// Turns a paid task_post_orders doc into a real, live special_tasks
// document — this is the ONLY place a self-serve posted task is ever
// actually created, guaranteeing it only ever happens once real payment
// is confirmed. Broadcasts the "new task added" announcement to everyone
// and DMs the poster a payment confirmation. Returns true if this call
// was the one that actually credited it (false if another concurrent
// delivery already claimed this exact order — safe no-op).
async function creditTaskPostOrder(db, order, txHash, creditedBy) {
  const taskOrders = db.collection("task_post_orders");
  const claim = await taskOrders.updateOne(
    { orderId: order.orderId, status: "pending" },
    { $set: { status: "paid", paidAt: new Date(), txHash, creditedBy } }
  );
  if (claim.modifiedCount === 0) return false; // lost the race to another delivery

  const d = order.draft;
  const specialTasks = db.collection("special_tasks");
  const insertResult = await specialTasks.insertOne({
    title: d.title,
    description: "",
    reward: TASK_POST_REWARD_PER_COMPLETION,
    link: d.link,
    chatId: d.type === "channel_join" ? d.chatId : null,
    verificationType: d.type === "channel_join" ? "verified" : "normal",
    active: true,
    // These 3 fields are what distinguishes a self-serve posted task from
    // an admin-created one — see api/task.js's completeSpecialTask for the
    // cap/auto-close logic that only ever triggers when maxCompletions is
    // actually set (admin-created tasks never set it, so they're
    // completely unaffected).
    postedBy: order.telegramId,
    maxCompletions: d.maxCompletions,
    completedCount: 0,
    pricePaidTon: order.priceTon,
    createdAt: new Date(),
  });

  console.log(
    `[POST TASK] Order ${order.orderId} paid — task "${d.title}" created (${insertResult.insertedId}) for uid ${order.telegramId}, cap ${d.maxCompletions}`
  );

  // Announce to everyone: image first, "Added New task ✅" caption below
  // it, then an OPEN TASK button that deep-links straight into the app's
  // Task tab (see enterApp() in public/app.js for the ?startapp=task
  // routing). English per requirement — every broadcast is.
  //
  // Deliberately NOT doing an immediate head-start drain here (unlike
  // broadcastPromoCodeToUsers() in api/bot.js) — this function runs
  // inside the payment webhook/reconcile-cron path, which already has a
  // tight time budget (WEBHOOK_DEADLINE_MS above is only 8s, and Vercel's
  // default function timeout is ~10s on the Hobby plan), so a 20s+ drain
  // here risked the payment-crediting response itself getting cut off
  // mid-send. This matches the same enqueue-only pattern already used by
  // every OTHER non-promo broadcast in this codebase (see api/admin/
  // promo.js, api/admin/withdraws.js) — delivery happens on the next
  // external ?cron=reset-notify tick, same as those.
  await enqueueBroadcast(db, {
    text: "Added New task ✅",
    parseMode: "Markdown",
    photoUrl: TASK_POST_ANNOUNCE_IMAGE_URL,
    keyboard: { inline_keyboard: [[{ text: "OPEN TASK", url: TASK_SECTION_DEEP_LINK }]] },
  });

  tgCall("sendMessage", {
    chat_id: order.telegramId,
    text: `✅ Payment received! Your task "${d.title}" is now live and visible to all users.`,
  }).catch((e) => console.error("[POST TASK] poster notify failed:", e.message));

  return true;
}

async function processVerifiedWebhookTx(txHash, res) {
  // Split out from handleTonWebhook so the deadline race in withDeadline can
  // wrap just the network/DB work (TonAPI lookup + Mongo), not response
  // plumbing. Writes the res itself so the winning branch of the race is the
  // one that actually replies.
  // No try/catch here on purpose: this function's whole call is wrapped in
  // withDeadline(...) back in handleTonWebhook, and that call is awaited
  // inside handleTonWebhook's own try/catch — so any error OR timeout
  // thrown from anywhere below is handled in exactly one place, not two.
  {
    // Authenticated lookup — the only data we actually trust.
    const txRes = await fetchWithTimeout(
      `${TONAPI_BASE}/blockchain/transactions/${txHash}`,
      { headers: { Authorization: `Bearer ${TON_API_KEY}` } },
      WEBHOOK_DEADLINE_MS - 1000
    );
    if (!txRes.ok) {
      const errText = await txRes.text().catch(() => "");
      console.error(`[TONAPI] Transaction lookup failed for ${txHash}: HTTP ${txRes.status} — ${errText}`);
      // 200 anyway — a transient TonAPI/network hiccup shouldn't make TonAPI
      // give up retrying this webhook delivery forever; but we also can't
      // credit anything without verified data, so just no-op this attempt.
      return res.status(200).json({ ok: true, verified: false });
    }
    const tx = await txRes.json();
    console.log("[TONAPI] tx lookup result:", JSON.stringify(tx));
    const inMsg = tx && tx.in_msg;
    if (!inMsg) {
      console.log(`[TONAPI] tx ${txHash} has no in_msg — ignoring`);
      return res.status(200).json({ ok: true });
    }

    // Only internal transfers actually landing on OUR deposit wallet count.
    // TonAPI addresses can come back in either raw ("0:hex...") or
    // user-friendly ("UQ..."/"EQ...") form depending on context — see
    // isOurDepositAddress()/getDepositRawAddress() above for why a plain
    // string compare against TON_DEPOSIT_ADDRESS alone isn't enough.
    const destination = inMsg.destination && (inMsg.destination.address || inMsg.destination);
    const rawDepositAddress = await getDepositRawAddress();
    const destinationMatches = isOurDepositAddress(destination, rawDepositAddress);
    if (!destinationMatches) {
      console.log(`[TONAPI] tx ${txHash} destination "${destination}" does not match TON_DEPOSIT_ADDRESS "${TON_DEPOSIT_ADDRESS}" — ignoring`);
      return res.status(200).json({ ok: true });
    }

    const receivedNano = Number(inMsg.value || 0);

    const db = await getDb();
    // Matched purely by (destination address, already checked above) +
    // exact nanoton amount — see addUniqueOffset for why this needs no
    // text comment/memo at all. Checks BOTH key_orders (Key Coin
    // purchases) and task_post_orders (self-serve Post Task payments) —
    // see matchAndCreditPayment() above.
    const credited = await matchAndCreditPayment(db, receivedNano, txHash, "webhook");
    if (!credited) {
      // Log every pending order's expected amount alongside what we
      // actually received — this is the #1 place a silent mismatch shows
      // up (e.g. fees deducted from the amount, float/rounding drift, or
      // an already-processed order).
      const stillPendingKey = await db.collection("key_orders").find({ status: "pending" }).project({ orderId: 1, expectedNano: 1 }).limit(20).toArray();
      const stillPendingTask = await db.collection("task_post_orders").find({ status: "pending" }).project({ orderId: 1, expectedNano: 1 }).limit(20).toArray();
      console.log(
        `[TONAPI] tx ${txHash} received ${receivedNano} nanoton but no PENDING order expects exactly that amount. Pending key orders:`,
        JSON.stringify(stillPendingKey),
        "Pending task-post orders:",
        JSON.stringify(stillPendingTask)
      );
      return res.status(200).json({ ok: true });
    }

    console.log(`[TONAPI] tx ${txHash} matched and credited: ${credited}`);
    return res.status(200).json({ ok: true });
  }
}


// ---------- KEY STORE PAYMENT RECONCILIATION (cron/manual safety net) ----------
// Does the exact same job as handleTonWebhook above — verify against TonAPI,
// match by (destination address, exact expectedNano), atomically flip
// status:"pending"->"paid", credit keyCoinBalance, notify the buyer — except
// instead of waiting for TonAPI to push a webhook for a single tx, this
// pulls TON_DEPOSIT_ADDRESS's recent transaction history and sweeps every
// still-pending order against it. Safe to call as often as you like: the
// same status:"pending" filter on the update is the idempotency guard, so
// re-scanning a transaction the webhook (or a previous cron tick) already
// credited just finds nothing left to claim and moves on.
async function handleReconcilePendingPayments(req, res) {
  try {
    const CRON_SECRET = process.env.CRON_SECRET;
    if (!CRON_SECRET) {
      console.error("[CONFIG ERROR] CRON_SECRET is not set — refusing to run check-payments.");
      return res.status(500).json({ error: "server not configured" });
    }
    const authHeader = req.headers.authorization;
    const validVercelAuth = authHeader === `Bearer ${CRON_SECRET}`;
    const validManualSecret = req.query && req.query.secret === CRON_SECRET;
    if (!validVercelAuth && !validManualSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!TON_API_KEY || !TON_DEPOSIT_ADDRESS) {
      console.error("[RECONCILE] TON_API_KEY/TON_DEPOSIT_ADDRESS not configured — skipping.");
      return res.status(200).json({ ok: true, skipped: "not configured" });
    }

    const db = await getDb();
    const keyOrders = db.collection("key_orders");
    const taskOrders = db.collection("task_post_orders");

    // Cheap early-out: don't bother calling TonAPI at all if nothing is
    // actually waiting to be matched, across EITHER order collection.
    const pendingKeyCount = await keyOrders.countDocuments({ status: "pending" });
    const pendingTaskCount = await taskOrders.countDocuments({ status: "pending" });
    const pendingCount = pendingKeyCount + pendingTaskCount;
    if (pendingCount === 0) {
      return res.status(200).json({ ok: true, pending: 0, credited: 0 });
    }

    // Same authenticated source of truth handleTonWebhook uses for a single
    // tx_hash, just the account-level "recent transactions" list instead —
    // covers however many payments landed since the last tick in one call.
    const txRes = await fetch(
      `${TONAPI_BASE}/blockchain/accounts/${encodeURIComponent(TON_DEPOSIT_ADDRESS)}/transactions?limit=100`,
      { headers: { Authorization: `Bearer ${TON_API_KEY}` } }
    );
    if (!txRes.ok) {
      const errText = await txRes.text().catch(() => "");
      console.error(`[RECONCILE] TonAPI account-transactions lookup failed: HTTP ${txRes.status} — ${errText}`);
      return res.status(200).json({ ok: true, error: "tonapi lookup failed" });
    }
    const data = await txRes.json();
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    const rawDepositAddress = await getDepositRawAddress();

    let credited = 0;
    let checked = 0;
    for (const tx of transactions) {
      const inMsg = tx && tx.in_msg;
      if (!inMsg) continue;

      // Same address-format-safe comparison as handleTonWebhook (TonAPI
      // returns destination in raw "0:hex..." form here, not the friendly
      // "UQ.../EQ..." form TON_DEPOSIT_ADDRESS is normally set to).
      const destination = inMsg.destination && (inMsg.destination.address || inMsg.destination);
      const destinationMatches = isOurDepositAddress(destination, rawDepositAddress);
      if (!destinationMatches) continue;

      checked++;
      const receivedNano = Number(inMsg.value || 0);
      const txHash = tx.hash || tx.tx_hash || null;

      // Checks BOTH key_orders and task_post_orders — see
      // matchAndCreditPayment() above.
      const wasCredited = await matchAndCreditPayment(db, receivedNano, txHash, "reconcile-cron");
      if (wasCredited) {
        console.log(`[RECONCILE] tx ${txHash} matched and credited: ${wasCredited}`);
        credited++;
      }
    }

    console.log(`[RECONCILE] tick done — ${pendingCount} pending order(s), ${checked} matching-destination tx checked, ${credited} newly credited`);
    return res.status(200).json({ ok: true, pending: pendingCount, checked, credited });
  } catch (err) {
    console.error("[ERROR] check-payments cron:", err);
    return res.status(200).json({ ok: false });
  }
}
