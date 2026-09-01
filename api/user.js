const crypto = require("crypto");
const fetch = require("node-fetch");
const { getDb } = require("./_db");
const { isMember, tgCall, notifyIfValidReferral, maybeRewardStep2Task } = require("./_telegram");
const { getClientIp, isSameDevice, isPlausibleIp, checkIpLock } = require("./_utils");
const { verifyInitData } = require("./_verifyInitData");

const CHANNEL_1 = "@redtubecommunity";
const CHANNEL_2 = "@redtubeofficial00";
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

// checkIpLock now lives in ./_utils.js (shared with earn.js) — see that
// file for the implementation and why it was moved.

// ---------- 🔑 KEY STORE (buy Key Coins with real TON via ArcPay) ----------
// Key Coins are the same currency minted 1-per-valid-referral in
// notifyIfValidReferral (api/_telegram.js) and spent 1-per-withdrawal in
// api/withdraw.js. This lets anyone who can't easily get referrals just buy
// their withdraw allowance instead. Kept in this file (not a new serverless
// function) per the project's "extend existing routes" convention.
//
// HOW DEPOSITS ARE DETECTED — two independent paths, so a payment is never
// stuck on just one of them working:
// 1. FAST PATH (webhook): ArcPay calls our /api/user?arcpay_webhook=1 the
//    moment an order is paid. Its body is signed (X-Signature, HMAC-SHA256
//    keyed with ARC_PRIVATE_KEY) — we verify that signature before trusting
//    anything in it, so a forged POST to this URL can never credit Key
//    Coins on its own.
// 2. SAFETY NET (cron): every 1-5 minutes, an external pinger hits
//    /api/user?cron=check-payments, which asks ArcPay directly (an
//    AUTHENTICATED GET using our own ARC_KEY — never trusts the webhook
//    body) whether each still-pending order has actually been paid, and
//    credits it if so. This is the AUTHORITATIVE path: it works even if the
//    webhook's signature format ever turns out to be mis-guessed, ArcPay's
//    delivery is delayed/dropped, or a redeploy briefly changes the domain.
// Both paths write through the exact same atomic status:"pending"->"paid"
// guard on the order doc, so whichever gets there first wins and the other
// is always a safe no-op — never a double-credit.
const KEY_PRICE_TON = 0.015; // price per single Key Coin, in TON
// ---------- 🔑 KEY STORE MAINTENANCE SWITCH ----------
// Temporary kill-switch for NEW purchases only, while the ArcPay webhook/
// signature issue is being sorted out. Does NOT touch anything else:
// - check_order, the webhook (handleArcPayWebhook), and the reconcile cron
//   (handleReconcilePendingPayments) are all untouched, so any order that
//   was already created before this was flipped on can still be credited
//   normally the moment ArcPay confirms it.
// - Every other feature in this file (earn, tasks, referrals, withdraw
//   gating, etc.) is unaffected.
// Flip back to `false` to reopen the store once everything is confirmed
// working end-to-end.
const KEY_STORE_MAINTENANCE = true;
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

const ARC_KEY = process.env.ARC_KEY; // merchant key from @ArcPayBot, sent as the "ArcKey" header on every request TO ArcPay
const ARC_PRIVATE_KEY = process.env.ARC_PRIVATE_KEY; // verifies the "X-Signature" header ArcPay sends US on webhook calls
const ARC_API_BASE = "https://arcpay.online/api/v1/arcpay";

// ---------- WEBHOOK DEADLINE GUARD ----------
// Same reasoning as the previous TonAPI integration: a payment webhook
// provider that gives up waiting for our response after N seconds may count
// that as a delivery failure and, after enough consecutive failures,
// suspend the webhook entirely — which then fails completely silently (zero
// error on our side) until someone manually notices credits have stopped.
// Racing our own work against a hard local timeout means we ALWAYS answer
// well inside any reasonable provider deadline; if we lose the race we
// still return 200 and simply leave the order "pending" — the
// check-payments cron (handleReconcilePendingPayments) picks up anything a
// slow/timed-out webhook attempt didn't finish, exactly like it already
// does for any webhook delivery that never arrives at all.
const WEBHOOK_DEADLINE_MS = 8000;
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[DEADLINE] ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// node-fetch v2 has no built-in timeout — a slow/stuck ArcPay response would
// otherwise hang until the platform's own request limit, well past
// WEBHOOK_DEADLINE_MS. AbortController bounds it explicitly.
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------- RAW BODY CAPTURE (fixes ArcPay signature verification) ----------
// BUG THIS FIXES: this route used to let the platform auto-parse the JSON
// body into req.body, then re-serialize it with JSON.stringify(req.body)
// to compute the webhook's HMAC signature. That re-serialization is NOT
// guaranteed to byte-for-byte match what ArcPay originally sent (key order,
// spacing, number formatting can all differ) — and ArcPay's own SDK example
// signs the exact raw bytes it sent. Any mismatch = signatureValid stays
// false = the fast-path webhook silently never credits, EVERY time, which
// is exactly the "TON sent, key never added, stuck on Waiting for payment"
// symptom this was rewritten to fix. Reading the raw bytes ourselves (with
// the platform's automatic body parser turned off via `config` at the
// bottom of this file) and hashing those exact bytes makes the signature
// check actually reliable instead of a coin flip.
// req.body is then set to the parsed object here, once, so every other
// action handler below (buy_key, check_order, claim_ip, etc.) keeps working
// exactly as before via req.body.xxx — nothing else in this file changes.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      // Body already parsed/consumed by the platform despite bodyParser:
      // false (e.g. a local dev server that ignores the config) — fall
      // back to re-serializing rather than hanging forever waiting for
      // stream data that will never arrive. Keeps local `vercel dev`
      // working even though it's not the byte-exact path.
      resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));
      return;
    }
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      const rawBody = await readRawBody(req);
      req.rawBody = rawBody; // exact bytes, used by the ArcPay signature check below
      try {
        req.body = rawBody ? JSON.parse(rawBody) : {};
      } catch (e) {
        req.body = {};
      }
    }
    // ---------- ARCPAY WEBHOOK (no Telegram session — server-to-server) ----------
    // ArcPay calls this URL the moment an order is paid, so it must be
    // reachable BEFORE the verifyInitData() gate below (ArcPay never sends
    // Telegram initData). This is the exact URL already configured in the
    // ArcPay merchant dashboard from the original setup —
    // https://<your-domain>/api/user?arcpay_webhook=1 — unchanged, so no
    // dashboard reconfiguration is needed for this switch back from TonAPI.
    if (req.method === "POST" && req.query && req.query.arcpay_webhook === "1") {
      return handleArcPayWebhook(req, res);
    }

    // ---------- 🔑 KEY STORE: PAYMENT RECONCILIATION CRON (safety net) ----------
    // See the big comment above KEY_PRICE_TON for the full fast-path/safety-
    // net design. This is the safety net: pulls every still-pending order
    // and asks ArcPay directly (authenticated GET, our own ARC_KEY) whether
    // it's actually been paid — independent of whether the webhook ever
    // fires or its signature format guess turns out right. Same
    // CRON_SECRET / query-param wiring as before (nothing to change in the
    // external pinger, e.g. cron-job.org, that's already hitting this URL
    // every 1-5 minutes):
    // GET https://YOUR_DOMAIN/api/user?cron=check-payments&secret=YOUR_CRON_SECRET
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

      let user = await users.findOne({ telegramId: uid });

      if (!user) {
        // Confirm the referrer actually exists before trusting it —
        // stops referral-farming with made-up ids
        let validRefBy = null;
        if (refBy) {
          const refUser = await users.findOne({ telegramId: refBy });
          if (refUser) validRefBy = refBy;
        }

        const newUser = {
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
          lastIp: ip,
          createdAt: new Date(),
        };
        await users.insertOne(newUser);
        user = newUser;

        if (ADMIN_ID) {
          const refText = validRefBy ? `\nReferred by: ${validRefBy}` : "";
          tgCall("sendMessage", {
            chat_id: ADMIN_ID,
            text: `🆕 New user joined REDTUBE!\nUID: ${uid}\nUsername: @${user.username || "none"}\nName: ${user.firstName || "unknown"}${refText}`,
          }).catch((e) => console.error("[WARN] Admin notify failed:", e.message));
        }
      } else {
        // Keep username/firstName in sync with Telegram in case the user
        // changed their name/username since we last saw them — always from
        // verified data, never from the client body.
        const updates = { lastIp: ip };
        if (verifiedUsername !== null && verifiedUsername !== user.username) updates.username = verifiedUsername;
        if (verifiedFirstName !== null && verifiedFirstName !== user.firstName) updates.firstName = verifiedFirstName;
        await users.updateOne({ telegramId: uid }, { $set: updates });
        user = { ...user, ...updates };
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
      // Creates a pending order in ArcPay and hands back their hosted
      // checkout URL (ArcPay's own page handles wallet selection/TonConnect
      // on their end — we don't need to build that ourselves). Price/
      // quantity are always looked up server-side from KEY_PACKAGES/
      // KEY_PRICE_TON — never trust a client-supplied amount for a real
      // payment. Coins are credited later by handleArcPayWebhook (fast
      // path) or handleReconcilePendingPayments (safety-net cron), never
      // here — this only opens the checkout.
      if (action === "buy_key") {
        if (KEY_STORE_MAINTENANCE) {
          return res.status(503).json({ error: "Store is updating......" });
        }
        if (!ARC_KEY) {
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

        await keyOrders.insertOne({
          orderId,
          telegramId: uid,
          packageId,
          quantity: pkg.quantity,
          priceTon,
          status: "pending",
          createdAt: new Date(),
        });
        console.log(`[KEYSTORE] Created pending order ${orderId} — uid ${uid}, ${pkg.quantity} key(s), ${priceTon} TON`);

        try {
          const arcRes = await fetchWithTimeout(
            `${ARC_API_BASE}/order`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ArcKey: ARC_KEY },
              body: JSON.stringify({
                title: `${pkg.quantity} Key Coin${pkg.quantity > 1 ? "s" : ""}`,
                orderId,
                currency: "TON",
                items: [
                  {
                    title: "Key Coin",
                    description: `${pkg.quantity} Key Coin${pkg.quantity > 1 ? "s" : ""} for RedTube`,
                    price: KEY_PRICE_TON,
                    count: pkg.quantity,
                    itemId: packageId,
                  },
                ],
                meta: { telegram_id: uid },
                captured: false,
              }),
            },
            8000
          );
          const arcText = await arcRes.text();
          let arcData = null;
          try { arcData = JSON.parse(arcText); } catch (e) { /* leave null, log raw below */ }
          console.log(`[KEYSTORE] ArcPay order-create response for ${orderId}: HTTP ${arcRes.status} — ${arcText}`);

          if (!arcRes.ok || !arcData) {
            return res.status(502).json({ error: "Could not start payment — please try again shortly." });
          }
          const paymentUrl = arcData.paymentUrl || arcData.payment_url || arcData.url || null;
          if (!paymentUrl) {
            console.error(`[KEYSTORE] ArcPay response had no recognizable payment URL for ${orderId}`);
            return res.status(502).json({ error: "Could not start payment — please try again shortly." });
          }

          // FIXED (confirmed via live Vercel logs of an actual ArcPay
          // order-create response): ArcPay's own internal id for this order
          // is the `uuid` field. The response's `orderId` field is NOT a
          // new id — it's just OUR custom orderId echoed straight back
          // (they're always identical, e.g. both "KEY-8816681468-...").
          // The old code preferred `arcData.orderId`, which meant
          // arcOrderId ended up saved as our OWN id — not a real UUID — so
          // the reconcile cron's GET /order/{arcOrderId} call kept 422'ing
          // ("Input should be a valid UUID"), exactly matching the bug
          // reported. `id` is kept only as a last-resort fallback in case
          // ArcPay's shape ever differs.
          const arcOrderUuid = arcData.uuid || arcData.id || null;
          if (arcOrderUuid) {
            await keyOrders.updateOne({ orderId }, { $set: { arcOrderId: arcOrderUuid } });
          } else {
            console.error(`[KEYSTORE] ArcPay order-create response had no 'uuid' field for ${orderId} — reconcile-cron won't be able to poll this order, only the webhook can credit it`);
          }

          return res.status(200).json({
            success: true,
            orderId,
            quantity: pkg.quantity,
            priceTon,
            paymentUrl,
          });
        } catch (e) {
          console.error(`[KEYSTORE] ArcPay order-create request failed for ${orderId}:`, e.message);
          return res.status(502).json({ error: "Could not reach the payment provider — please try again shortly." });
        }
      }

      // ---------- 🔑 KEY STORE: check_order (front-end status poll) ----------
      // Lets the "Waiting for payment" screen ask "has this specific order
      // been paid yet?" without needing a websocket/push channel. Scoped to
      // (orderId + the caller's own verified uid) so one buyer can never
      // read another buyer's order status. Read-only — this NEVER credits
      // anything itself; crediting only ever happens in handleArcPayWebhook /
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

// ---------- ARCPAY WEBHOOK HANDLER ----------
// Verifies the X-Signature header (HMAC-SHA256 of the raw request body,
// keyed with ARC_PRIVATE_KEY) before trusting anything in the payload — a
// forged POST to this URL fails the signature check and is dropped, never
// credited. IMPORTANT HONESTY NOTE: ArcPay's exact webhook payload shape
// and signature scheme could not be fully confirmed against their live docs
// (the docs site is a JS app that couldn't be rendered for verification) —
// this is a best-effort implementation. That's WHY handleReconcilePending
// Payments (the cron) exists as the authoritative path: it asks ArcPay
// directly via an authenticated GET (our own ARC_KEY, not anything ArcPay
// sent us) whether an order is paid, so a wrong guess about the webhook's
// exact shape here can delay a credit by up to one cron interval, but can
// never cause a payment to be lost or a fake one to be credited.
//
// Idempotency: a key_orders doc only ever flips "pending" -> "paid" once
// (atomic updateOne with a status:"pending" filter), so a duplicate webhook
// delivery — or the cron catching the same order the webhook already did —
// can never credit Key Coins twice.
async function handleArcPayWebhook(req, res) {
  try {
    if (!ARC_PRIVATE_KEY) {
      console.error("[ARCPAY] Webhook received but ARC_PRIVATE_KEY is not configured");
      return res.status(503).json({ error: "not configured" });
    }

    // FIXED: now the exact raw bytes ArcPay sent (captured in module.exports
    // above, before any JSON reformatting) — see the big comment on
    // readRawBody() for why the old JSON.stringify(req.body) approach broke
    // signature verification. req.rawBody is always set for POST requests;
    // the req.body fallback below only matters if readRawBody ever hits its
    // own already-parsed-by-the-platform fallback.
    const rawBody = typeof req.rawBody === "string"
      ? req.rawBody
      : (typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));
    console.log("[ARCPAY] webhook received, raw body:", rawBody);

    const signature = req.headers["x-signature"];
    let signatureValid = false;
    let expected = null;
    if (signature && ARC_PRIVATE_KEY) {
      expected = crypto.createHmac("sha256", ARC_PRIVATE_KEY).update(rawBody).digest("hex");
      try {
        const sigBuf = Buffer.from(String(signature));
        const expBuf = Buffer.from(expected);
        signatureValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      } catch (e) {
        signatureValid = false;
      }
    }
    console.log(`[ARCPAY] signature present: ${!!signature}, valid: ${signatureValid}`);
    // ---------- TEMPORARY DEBUG (remove once signatures verify) ----------
    // Logs everything needed to tell apart the two possible remaining
    // causes without guessing again: (a) rawBody still isn't the exact
    // bytes ArcPay signed (byteLength/charCodes would look off), or (b)
    // ARC_PRIVATE_KEY itself doesn't match what ArcPay is signing with
    // (e.g. copy-pasted with a trailing newline/space, or it's simply the
    // wrong secret). Nothing secret is printed — keyLength is a count, not
    // the key; expected/received are one-way HMAC digests, not the key
    // itself, so this is safe to leave in logs while debugging.
    console.log(`[ARCPAY:DEBUG] rawBody byteLength=${Buffer.byteLength(rawBody, "utf8")} first40=${JSON.stringify(rawBody.slice(0, 40))} last40=${JSON.stringify(rawBody.slice(-40))}`);
    console.log(`[ARCPAY:DEBUG] ARC_PRIVATE_KEY set=${!!ARC_PRIVATE_KEY} length=${ARC_PRIVATE_KEY ? ARC_PRIVATE_KEY.length : 0}`);
    console.log(`[ARCPAY:DEBUG] received signature="${signature}" (len ${signature ? String(signature).length : 0})`);
    console.log(`[ARCPAY:DEBUG] expected  signature="${expected}" (len ${expected ? expected.length : 0})`);
    if (!signatureValid) {
      // Don't credit anything off an unverified body — but still 200 so
      // ArcPay doesn't hammer retries; handleReconcilePendingPayments will
      // pick this order up on its own via an authenticated GET regardless.
      console.warn("[ARCPAY] Webhook signature missing/invalid — relying on the reconcile cron for this order instead");
      return res.status(200).json({ ok: true, verified: false });
    }

    const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    // FIXED: ArcPay's real payload nests the useful fields under `data.data`
    // — { event: "order.status.changed", data: { status: "received" |
    // "captured", orderId / order: {...} } } (confirmed against ArcPay's
    // published Python SDK example: `data["event"]` + `data["data"]["status"]`).
    // The previous code only ever looked at the top level (data.event /
    // data.status / data.orderId), which is empty for this shape — so
    // `event` came back undefined, isPaid never matched, and no credit ever
    // happened. The top-level checks are kept as a fallback in case ArcPay
    // sends a flatter shape for some other event type.
    const inner = data && data.data && typeof data.data === "object" ? data.data : null;
    const event = data && ((inner && inner.status) || data.event || data.status);
    const orderId = data && (
      (inner && (inner.orderId || (inner.order && inner.order.orderId))) ||
      data.orderId ||
      (data.order && data.order.orderId)
    );
    if (!orderId) {
      console.log("[ARCPAY] webhook body had no orderId — ignoring");
      return res.status(200).json({ ok: true });
    }

    return await withDeadline(
      creditArcPayOrderIfPaid(orderId, event, "webhook"),
      WEBHOOK_DEADLINE_MS,
      `handleArcPayWebhook order=${orderId}`
    ).then((result) => res.status(200).json(result || { ok: true }));
  } catch (err) {
    console.error("[ERROR] ArcPay webhook:", err.message || err);
    if (!res.headersSent) {
      return res.status(200).json({ ok: false, timedOut: /^\[DEADLINE\]/.test(String(err.message)) });
    }
  }
}

// Shared by both the webhook (fast path) and the reconcile cron (safety
// net): flips a specific order "pending" -> "paid" and credits Key Coins,
// IF (and only if) it's actually still pending AND the caller has already
// established the order is genuinely paid. `source` is just for logging —
// it never affects the credit decision itself.
async function creditArcPayOrderIfPaid(orderId, eventOrStatus, source) {
  // FIXED: added "received" — ArcPay's docs/SDK example show the paid
  // status as `data.data.status === "received"` (sometimes "captured"),
  // and "received" was never in this list, so even a correctly-parsed
  // webhook/reconcile payload would still fail this check and skip the
  // credit.
  const isPaid = typeof eventOrStatus === "string" && /paid|success|completed|captured|received/i.test(eventOrStatus);
  if (!isPaid) {
    console.log(`[ARCPAY:${source}] order ${orderId} event/status "${eventOrStatus}" is not a paid-style value — no credit`);
    return { ok: true };
  }

  const db = await getDb();
  const keyOrders = db.collection("key_orders");
  const users = db.collection("users");

  const order = await keyOrders.findOne({ orderId });
  if (!order) {
    console.warn(`[ARCPAY:${source}] webhook/cron referenced unknown orderId ${orderId}`);
    return { ok: true };
  }

  const claim = await keyOrders.updateOne(
    { orderId, status: "pending" },
    { $set: { status: "paid", paidAt: new Date(), creditedBy: source } }
  );
  if (claim.modifiedCount === 0) {
    // Already credited by the other path (webhook vs cron) — safe no-op.
    return { ok: true };
  }

  await users.updateOne(
    { telegramId: order.telegramId },
    { $inc: { keyCoinBalance: order.quantity } }
  );

  tgCall("sendMessage", {
    chat_id: order.telegramId,
    text: `✅ Payment received! ${order.quantity} 🔑 Key Coin${order.quantity > 1 ? "s" : ""} added to your account.`,
  }).catch((e) => console.error(`[ARCPAY:${source}] notify failed:`, e.message));

  console.log(`[ARCPAY:${source}] Order ${orderId} paid — credited ${order.quantity} Key Coin(s) to uid ${order.telegramId}`);
  return { ok: true, credited: true };
}

// ---------- KEY STORE PAYMENT RECONCILIATION (cron/manual safety net) ----------
// The authoritative path — see the big comment above KEY_PRICE_TON. Sweeps
// every still-pending order and asks ArcPay directly (GET, our own ARC_KEY)
// whether it's been paid, independent of the webhook ever firing correctly.
// IMPORTANT HONESTY NOTE: same caveat as the webhook — ArcPay's exact
// "get order status" endpoint/response shape could not be confirmed against
// their live docs, so the URL below is a best-effort guess at their REST
// convention. The first real run's [RECONCILE] logs will show either real
// order data or a 404/error that pinpoints exactly what needs adjusting.
// Only checks orders at least 20s old, so a payment that's mid-flight isn't
// spuriously logged as "not yet paid" on every single cron tick.
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

    if (!ARC_KEY) {
      console.error("[RECONCILE] ARC_KEY not configured — skipping.");
      return res.status(200).json({ ok: true, skipped: "not configured" });
    }

    const db = await getDb();
    const keyOrders = db.collection("key_orders");

    const cutoff = new Date(Date.now() - 20 * 1000);
    const pending = await keyOrders
      .find({ status: "pending", createdAt: { $lte: cutoff } })
      .sort({ createdAt: 1 })
      .limit(25) // cap per tick — plenty for normal volume, keeps one run fast
      .toArray();

    if (pending.length === 0) {
      return res.status(200).json({ ok: true, pending: 0, credited: 0 });
    }

    let credited = 0;
    for (const order of pending) {
      try {
        // FIXED (confirmed via live Vercel logs — ArcPay returned HTTP 422
        // "uuid_parsing... expected... found 'K' at 1" for input like
        // "KEY-5697990319-1788173758808"): ArcPay's GET /order/{id} endpoint
        // requires ITS OWN UUID as the path id, not our custom orderId
        // string. That UUID is exactly what buy_key already saves as
        // order.arcOrderId (from the order-create response's
        // arcData.orderId/arcData.id) — it just wasn't being used here.
        // If an order somehow never got an arcOrderId saved (e.g. the
        // create-order response didn't include one), there's no valid id to
        // poll with — skip it and let the webhook (fast path) be the only
        // way that particular order gets credited, instead of hammering
        // ArcPay with a request we already know will 422.
        const lookupId = order.arcOrderId || order.orderId;
        if (!order.arcOrderId) {
          console.warn(`[RECONCILE] order ${order.orderId} has no arcOrderId saved — skipping GET (would 422), relying on webhook only`);
          continue;
        }
        const arcRes = await fetchWithTimeout(
          `${ARC_API_BASE}/order/${encodeURIComponent(lookupId)}`,
          { headers: { ArcKey: ARC_KEY } },
          5000
        );
        const arcText = await arcRes.text();
        console.log(`[RECONCILE] order ${order.orderId} (arc:${lookupId}): HTTP ${arcRes.status} — ${arcText}`);
        if (!arcRes.ok) continue;
        let arcData = null;
        try { arcData = JSON.parse(arcText); } catch (e) { continue; }
        // FIXED: same nested-shape fix as the webhook — check arcData.data.status
        // first (ArcPay's confirmed shape), falling back to the flatter guesses.
        const arcInner = arcData && arcData.data && typeof arcData.data === "object" ? arcData.data : null;
        const status = arcData && (
          (arcInner && arcInner.status) ||
          arcData.status ||
          arcData.event ||
          (arcData.captured === true ? "paid" : null)
        );
        const result = await creditArcPayOrderIfPaid(order.orderId, status, "reconcile-cron");
        if (result && result.credited) credited++;
      } catch (e) {
        console.error(`[RECONCILE] check failed for order ${order.orderId}:`, e.message);
      }
    }

    console.log(`[RECONCILE] tick done — ${pending.length} order(s) checked, ${credited} newly credited`);
    return res.status(200).json({ ok: true, checked: pending.length, credited });
  } catch (err) {
    console.error("[ERROR] check-payments cron:", err);
    return res.status(200).json({ ok: false });
  }
}

// ---------- REQUIRED FOR THE RAW-BODY FIX ABOVE ----------
// Tells Vercel not to auto-parse the request body for this function, so
// readRawBody() can read the exact original bytes ArcPay signed (needed for
// the HMAC check in handleArcPayWebhook). module.exports itself parses
// req.body back into a normal object right at the top of the handler, so
// every other action (buy_key, check_order, claim_ip, GET profile, etc.)
// behaves exactly as before — this only changes how/when the JSON parsing
// happens, not what ends up in req.body.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
