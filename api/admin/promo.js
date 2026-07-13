const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");
module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = await getDb();
  const promos = db.collection("promocodes");
  const claims = db.collection("promo_claims");
  if (req.method === "GET") {
    if (req.query.code) {
      const list = await claims
        .find({ code: req.query.code.trim().toUpperCase() })
        .sort({ claimedAt: -1 })
        .toArray();
      return res.status(200).json(list);
    }
    const list = await promos.find({}).sort({ createdAt: -1 }).toArray();
    return res.status(200).json(list);
  }
  if (req.method === "POST") {
    const { code, reward, limit } = req.body;
    if (!code || reward === undefined || !limit) {
      return res.status(400).json({ error: "missing fields" });
    }
    const upperCode = code.trim().toUpperCase();
    const exists = await promos.findOne({ code: upperCode });
    if (exists) return res.status(400).json({ error: "code already exists" });
    await promos.insertOne({
      code: upperCode,
      reward: Number(reward),
      limit: Number(limit),
      usedCount: 0,
      createdAt: new Date(),
    });
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
};
