const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

const BOT_USERNAME = process.env.BOT_USERNAME || "RedTube_bot";
const WEEKLY_CONTEST_THRESHOLD = 10;
const WEEKLY_CONTEST_TOP_N = 10;

// Weekly Referral Contest: NOT a calendar-week auto-reset. It runs
// continuously from whenever the admin last reset it (from the admin
// panel) until they reset it again. "startedAt" in the settings doc marks
// the start of the current contest window — any referral (users.createdAt)
// on/after that timestamp counts. If no settings doc exists yet (very first
// run), we seed one with the epoch so nothing crashes and the contest is
// effectively "always running" until the first real reset.
async function getContestStart(db) {
  const settings = db.collection("settings");
  let doc = await settings.findOne({ _id: "weekly_contest" });
  if (!doc) {
    // Upsert (not plain insert) so a race between two cold-start requests
    // can't throw a duplicate-key error — whichever wins, the read-back
    // below is correct either way.
    await settings.updateOne(
      { _id: "weekly_contest" },
      { $setOnInsert: { startedAt: new Date(0) } },
      { upsert: true }
    );
    doc = await settings.findOne({ _id: "weekly_contest" });
  }
  return doc.startedAt;
}

// Aggregates "users" (not a separate referral-log collection) to find who
// referred the most NEW accounts since contestStart, joins back to those
// referrers' own user docs to get displayable name/username.
async function getWeeklyTopN(db, contestStart, limit) {
  return db
    .collection("users")
    .aggregate([
      { $match: { referredBy: { $ne: null, $exists: true }, createdAt: { $gte: contestStart } } },
      { $group: { _id: "$referredBy", weeklyRefs: { $sum: 1 } } },
      { $sort: { weeklyRefs: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "telegramId",
          as: "referrer",
        },
      },
      { $unwind: { path: "$referrer", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          telegramId: "$_id",
          username: "$referrer.username",
          firstName: "$referrer.firstName",
          weeklyRefs: 1,
        },
      },
    ])
    .toArray();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const db = await getDb();
    const users = db.collection("users");

    // Public all-time leaderboard — unchanged from before
    if (req.query.top === "1") {
      const top = await users
        .find({ referralsCount: { $gt: 0 } })
        .sort({ referralsCount: -1 })
        .limit(20)
        .toArray();
      return res.status(200).json(
        top.map((u, i) => ({
          rank: i + 1,
          // Never leak telegramId/username on the public leaderboard — first name only
          name: (u.firstName || "User").slice(0, 40),
          refs: u.referralsCount || 0,
        }))
      );
    }

    // Public WEEKLY CONTEST leaderboard — no auth required. Shows @username
    // (matches the reference design), capped to exactly the top N — anyone
    // ranked below that simply isn't listed, per the contest rules.
    if (req.query.weekly === "1") {
      const contestStart = await getContestStart(db);
      const topWeekly = await getWeeklyTopN(db, contestStart, WEEKLY_CONTEST_TOP_N);
      return res.status(200).json(
        topWeekly.map((r, i) => ({
          rank: i + 1,
          username: r.username ? `@${r.username}` : (r.firstName || "User").slice(0, 40),
          refs: r.weeklyRefs,
        }))
      );
    }

    // Personal referral info requires proof of identity —
    // otherwise anyone could enumerate other users' referral stats by uid
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    const uid = verifiedUser.id;

    const user = await users.findOne({ telegramId: uid });
    if (!user) return res.status(404).json({ error: "not found" });

    const contestStart = await getContestStart(db);
    const weeklyReferrals = await users.countDocuments({
      referredBy: uid,
      createdAt: { $gte: contestStart },
    });

    return res.status(200).json({
      link: `https://t.me/${BOT_USERNAME}?start=${uid}`,
      totalReferrals: user.referralsCount || 0,
      referralEarnings: user.referralEarnings || 0,
      // Lifetime total of the 10% withdrawal-commission system (see
      // api/admin/withdraws.js's approve branch, where this is actually
      // credited) — separate from referralEarnings (the fixed milestone
      // bonuses) since it's an ongoing, uncapped stream rather than a
      // one-time-per-friend payout.
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
