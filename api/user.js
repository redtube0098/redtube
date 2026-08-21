const { getDb } = require("./_db");
const { isMember, tgCall, notifyIfValidReferral, maybeRewardStep2Task } = require("./_telegram");
const { getClientIp, isSameDevice, isPlausibleIp } = require("./_utils");
const { verifyInitData } = require("./_verifyInitData");

const CHANNEL_1 = "@redtubecommunity";
const CHANNEL_2 = "@redtubeofficial00";
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

// ---------- MULTI-ACCOUNT / IP LOCK GUARD ----------
// One IP can only have ONE "active" account at a time. The first account
// ever seen on an IP claims it (ipLocks collection). Any other Telegram
// account opening the app from that same IP is reported as "blocked" so
// the frontend (guard.js) can show the lock screen instead of the app.
async function checkIpLock(db, uid, ip) {
  if (!isPlausibleIp(ip) || ip === "unknown") {
    // Can't reliably identify the IP — never block on unreliable data.
    return { blocked: false };
  }
  const ipLocks = db.collection("ipLocks");
  // Atomic: only the first caller for a brand-new IP wins the claim,
  // even under concurrent requests.
  await ipLocks.updateOne(
    { _id: ip },
    { $setOnInsert: { activeTelegramId: uid, updatedAt: new Date() } },
    { upsert: true }
  );
  const lock = await ipLocks.findOne({ _id: ip });
  if (!lock || lock.activeTelegramId === uid) {
    return { blocked: false };
  }
  const users = db.collection("users");
  const activeUser = await users.findOne({ telegramId: lock.activeTelegramId });
  return {
    blocked: true,
    activeAccount: {
      telegramId: lock.activeTelegramId,
      name: (activeUser && activeUser.firstName) || "User",
      username: activeUser ? activeUser.username : null,
    },
  };
}

module.exports = async (req, res) => {
  try {
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
