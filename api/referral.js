// api/referral.js
const { getDb } = require("./_db");

const BOT_USERNAME = process.env.BOT_USERNAME || "RedTube_bot";

module.exports = async (req, res) => {
  const db = await getDb();
  const users = db.collection("users");

  if (req.method === "GET") {
    const uid = Number(req.query.uid);

    if (req.query.top === "1") {
      const top = await users
        .find({ referralsCount: { $gt: 0 } })
        .sort({ referralsCount: -1 })
        .limit(20)
        .toArray();

      return res.status(200).json(
        top.map((u, i) => ({
          rank: i + 1,
          name: u.firstName || u.username || "User",
          refs: u.referralsCount || 0,
        }))
      );
    }

    if (!uid) return res.status(400).json({ error: "uid required" });
    const user = await users.findOne({ telegramId: uid });
    if (!user) return res.status(404).json({ error: "not found" });

    return res.status(200).json({
      link: `https://t.me/${BOT_USERNAME}?start=${uid}`,
      totalReferrals: user.referralsCount || 0,
      referralEarnings: user.referralEarnings || 0,
    });
  }

  return res.status(405).end();
};
