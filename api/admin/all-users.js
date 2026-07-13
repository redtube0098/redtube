// api/admin/all-users.js
const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).end();

  const db = await getDb();
  const users = db.collection("users");

  // Most recently joined first. Limited to latest 200 to keep the response light.
  const list = await users
    .find({})
    .project({
      telegramId: 1,
      username: 1,
      firstName: 1,
      balance: 1,
      lifetimeEarned: 1,
      referralsCount: 1,
      joined: 1,
      createdAt: 1,
    })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  return res.status(200).json(list);
};
