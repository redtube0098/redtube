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

const TON_API_KEY = process.env.TON_API_KEY; // from tonconsole.com -> TON API -> API Keys
const TON_DEPOSIT_ADDRESS = process.env.TON_DEPOSIT_ADDRESS; // the single wallet all Key Store payments go to
const TONAPI_BASE = "https://tonapi.io/v2";

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
    const txHash = body.tx_hash;
    if (!txHash) {
      // Not a tx event we recognize — ack with 200 so TonAPI doesn't retry,
      // but change nothing.
      return res.status(200).json({ ok: true });
    }

    // Authenticated lookup — the only data we actually trust.
    const txRes = await fetch(`${TONAPI_BASE}/blockchain/transactions/${txHash}`, {
      headers: { Authorization: `Bearer ${TON_API_KEY}` },
    });
    if (!txRes.ok) {
      console.error(`[TONAPI] Transaction lookup failed for ${txHash}: HTTP ${txRes.status}`);
      // 200 anyway — a transient TonAPI/network hiccup shouldn't make TonAPI
      // give up retrying this webhook delivery forever; but we also can't
      // credit anything without verified data, so just no-op this attempt.
      return res.status(200).json({ ok: true, verified: false });
    }
    const tx = await txRes.json();
    const inMsg = tx && tx.in_msg;
    if (!inMsg) {
      return res.status(200).json({ ok: true });
    }

    // Only internal transfers actually landing on OUR deposit wallet count.
    // TonAPI addresses can come back in either raw ("0:hex...") or
    // user-friendly ("UQ..."/"EQ...") form depending on context, so compare
    // loosely rather than assume one format.
    const destination = inMsg.destination && (inMsg.destination.address || inMsg.destination);
    const destinationMatches =
      typeof destination === "string" &&
      (destination === TON_DEPOSIT_ADDRESS || destination.toUpperCase() === TON_DEPOSIT_ADDRESS.toUpperCase());
    if (!destinationMatches) {
      // A transaction on some OTHER account we happen to be subscribed to
      // (shouldn't normally happen since we only subscribe our own wallet)
      // — safe to ignore.
      return res.status(200).json({ ok: true });
    }

    const receivedNano = Number(inMsg.value || 0);

    const db = await getDb();
    const keyOrders = db.collection("key_orders");
    const users = db.collection("users");
    // Matched purely by (destination address, already checked above) +
    // exact nanoton amount — see addUniqueOffset in the buy_key handler for
    // why this needs no text comment/memo at all.
    const order = await keyOrders.findOne({ expectedNano: receivedNano, status: "pending" });
    if (!order) {
      // Either already processed, or an incoming amount that doesn't match
      // any pending order (unrelated transfer, wrong amount, expired
      // order, etc.) — nothing to credit.
      return res.status(200).json({ ok: true });
    }

    const claim = await keyOrders.updateOne(
      { orderId: order.orderId, status: "pending" },
      { $set: { status: "paid", paidAt: new Date(), txHash } }
    );
    if (claim.modifiedCount === 0) {
      // Lost the race to another concurrent webhook delivery — safe no-op.
      return res.status(200).json({ ok: true });
    }

    await users.updateOne(
      { telegramId: order.telegramId },
      { $inc: { keyCoinBalance: order.quantity } }
    );

    tgCall("sendMessage", {
      chat_id: order.telegramId,
      text: `✅ Payment received! ${order.quantity} 🔑 Key Coin${order.quantity > 1 ? "s" : ""} added to your account.`,
    }).catch((e) => console.error("[TONAPI] notify failed:", e.message));

    console.log(`[TONAPI] Order ${order.orderId} paid — credited ${order.quantity} Key Coin(s) to uid ${order.telegramId}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[ERROR] TonAPI webhook:", err);
    // Ack with 200 anyway — an unexpected exception here shouldn't cause
    // TonAPI to hammer us with retries; the order simply stays "pending"
    // and can be investigated/replayed manually via key_orders.
    return res.status(200).json({ ok: false });
  }
}
