const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");
const { applyCors } = require("./_utils");
const { getContestData, getContestState } = require("./_contest");

const BOT_USERNAME = process.env.BOT_USERNAME || "RedTube_bot";
const WEEKLY_CONTEST_THRESHOLD = 10;
const WEEKLY_CONTEST_TOP_N = 20;

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const db = await getDb();
    const users = db.collection("users");

    // Public all-time leaderboard
    if (req.query.top === "1") {
      const top = await users
        .find({ referralsCount: { $gt: 0 } })
        .sort({ referralsCount: -1 })
        .limit(20)
        .toArray();
      return res.status(200).json(
        top.map((u, i) => ({
          rank: i + 1,
          name: (u.firstName || "User").slice(0, 40),
          refs: u.referralsCount || 0,
        }))
      );
    }

    // Weekly Contest endpoint (This Week & Previous Week, Top 20, Prizes)
    if (req.query.contest === "1") {
      let uid = null;
      const initDataRaw = req.headers["x-telegram-init-data"];
      if (initDataRaw) {
        const verifiedUser = verifyInitData(initDataRaw);
        if (verifiedUser) uid = verifiedUser.id;
      }
      const contestData = await getContestData(db, uid);
      return res.status(200).json(contestData);
    }

    // Legacy weekly endpoint (for backward compatibility)
    if (req.query.weekly === "1") {
      const contestData = await getContestData(db);
      return res.status(200).json(
        contestData.thisWeek.rankings.slice(0, 10).map((r) => ({
          rank: r.rank,
          username: r.displayName,
          refs: r.refs,
        }))
      );
    }

    // Personal referral info requires proof of identity
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    const uid = verifiedUser.id;

    const user = await users.findOne({ telegramId: uid });
    if (!user) return res.status(404).json({ error: "not found" });

    const contestState = await getContestState(db);
    const weeklyReferrals = await users.countDocuments({
      referredBy: uid,
      createdAt: { $gte: contestState.startedAt, $lt: contestState.endsAt },
    });

    return res.status(200).json({
      link: `https://t.me/${BOT_USERNAME}?start=${uid}`,
      totalReferrals: user.referralsCount || 0,
      referralEarnings: user.referralEarnings || 0,
      withdrawalCommissionEarnings: user.withdrawalCommissionEarnings || 0,
      weeklyReferrals,
      weeklyThreshold: WEEKLY_CONTEST_THRESHOLD,
      weeklyQualified: weeklyReferrals >= WEEKLY_CONTEST_THRESHOLD,
    });
  } catch (err) {
    console.error("[ERROR] referral.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

