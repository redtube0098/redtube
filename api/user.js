const { getDb } = require("./_db");
const { isMember, tgCall } = require("./_telegram");
const { getClientIp } = require("./_utils");
const { verifyInitData } = require("./_verifyInitData");

const CHANNEL_1 = "@redtubecommunity";
const CHANNEL_2 = "@redtubeofficial00";
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

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

      let tasksAvailable = 0;
      try {
        const tasks = db.collection("tasks");
        tasksAvailable = await tasks.countDocuments({ active: true });
      } catch (e) {
        console.error("[WARN] tasksAvailable lookup failed:", e.message);
      }

      const videosToWatch = user.videosToWatch || 0;

      return res.status(200).json({
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        balance: user.balance,
        usdtBalance: user.usdtBalance || 0,
        lifetimeEarned: user.lifetimeEarned,
        adsWatchedToday: user.adsWatchedToday,
        tasksDoneToday: user.tasksDoneToday,
        referralsCount: user.referralsCount || 0,
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

      if (action === "check_join") {
        const m1 = await isMember(CHANNEL_1, uid);
        const m2 = await isMember(CHANNEL_2, uid);
        const bothJoined = m1 && m2;

        if (bothJoined && !user.joined) {
          await users.updateOne({ telegramId: uid }, { $set: { joined: true } });

          if (user.referredBy && !user.step1Rewarded) {
            // Atomic guard against double-rewarding step1 if check_join is
            // ever called twice in quick succession before step1Rewarded commits
            const claim = await users.updateOne(
              { telegramId: uid, step1Rewarded: { $ne: true } },
              { $set: { step1Rewarded: true } }
            );
            if (claim.modifiedCount > 0) {
              await users.updateOne(
                { telegramId: user.referredBy },
                { $inc: { balance: 30, lifetimeEarned: 30, referralsCount: 1, referralEarnings: 30 } }
              );
            }
          }
        }
        return res.status(200).json({ joined: bothJoined });
      }

      return res.status(200).json({ joined: user.joined });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] user.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
