const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

const BOT_USERNAME = process.env.BOT_USERNAME || "RedTube_bot";

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const db = await getDb();
    const users = db.collection("users");

    // Public leaderboard — no auth required, but sanitize what's exposed
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

    return res.status(200).json({
      link: `https://t.me/${BOT_USERNAME}?start=${uid}`,
      totalReferrals: user.referralsCount || 0,
      referralEarnings: user.referralEarnings || 0,
    });
  } catch (err) {
    console.error("[ERROR] referral.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
