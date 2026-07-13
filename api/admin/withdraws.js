const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");
const { ObjectId } = require("mongodb");
module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = await getDb();
  const withdraws = db.collection("withdraws");
  const users = db.collection("users");
  if (req.method === "GET") {
    const filter = req.query.status ? { status: req.query.status } : {};
    const list = await withdraws.find(filter).sort({ createdAt: -1 }).toArray();
    return res.status(200).json(list);
  }
  if (req.method === "POST") {
    const { id, action } = req.body;
    const w = await withdraws.findOne({ _id: new ObjectId(id) });
    if (!w) return res.status(404).json({ error: "not found" });
    if (w.status !== "pending") return res.status(400).json({ error: "already processed" });
    if (action === "approve") {
      await withdraws.updateOne({ _id: w._id }, { $set: { status: "approved", processedAt: new Date() } });
    } else if (action === "reject") {
      await users.updateOne({ telegramId: w.telegramId }, { $inc: { balance: w.amount } });
      await withdraws.updateOne({ _id: w._id }, { $set: { status: "rejected", processedAt: new Date() } });
    } else {
      return res.status(400).json({ error: "invalid action" });
    }
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
};
