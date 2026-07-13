// api/admin/users.js
const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

  const db = await getDb();
  const users = db.collection("users");

  if (req.method === "GET") {
    const q = req.query.q; // search by UID or username
    if (!q) return res.status(400).json({ error: "query required" });

    const asNumber = Number(q);
    const filter = !isNaN(asNumber)
      ? { telegramId: asNumber }
      : { username: q.replace("@", "") };

    const user = await users.findOne(filter);
    if (!user) return res.status(404).json({ error: "not found" });

    return res.status(200).json(user);
  }

  if (req.method === "POST") {
    // Adjust balance: amount can be positive or negative
    const { uid, amount } = req.body;
    if (!uid || amount === undefined) return res.status(400).json({ error: "missing fields" });

    const result = await users.updateOne(
      { telegramId: Number(uid) },
      { $inc: { balance: Number(amount) } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: "user not found" });

    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
};
