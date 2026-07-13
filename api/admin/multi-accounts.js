// api/admin/multi-accounts.js
const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).end();

  const db = await getDb();
  const users = db.collection("users");

  // Group users by lastIp; only IPs shared by 2+ accounts are suspicious
  const groups = await users
    .aggregate([
      { $match: { lastIp: { $ne: null, $exists: true, $ne: "unknown" } } },
      {
        $group: {
          _id: "$lastIp",
          count: { $sum: 1 },
          accounts: {
            $push: {
              telegramId: "$telegramId",
              username: "$username",
              firstName: "$firstName",
              referralsCount: "$referralsCount",
              referredBy: "$referredBy",
            },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  return res.status(200).json(
    groups.map((g) => ({
      ip: g._id,
      accountCount: g.count,
      accounts: g.accounts,
    }))
  );
};
