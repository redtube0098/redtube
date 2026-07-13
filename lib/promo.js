const { getDb } = require("./_db");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const db = await getDb();
  const promos = db.collection("promocodes");
  const users = db.collection("users");
  const claims = db.collection("promo_claims");
  const { uid, code } = req.body;
  if (!uid || !code) return res.status(400).json({ error: "missing fields" });
  const promo = await promos.findOne({ code: code.trim().toUpperCase() });
  if (!promo) return res.status(404).json({ error: "Invalid code" });
  if (promo.usedCount >= promo.limit) {
    return res.status(400).json({ error: "This code has reached its claim limit" });
  }
  const alreadyClaimed = await claims.findOne({ telegramId: uid, code: promo.code });
  if (alreadyClaimed) return res.status(400).json({ error: "You already claimed this code" });
  const user = await users.findOne({ telegramId: uid });
  await claims.insertOne({
    telegramId: uid,
    username: user ? user.username : null,
    firstName: user ? user.firstName : null,
    code: promo.code,
    reward: promo.reward,
    claimedAt: new Date(),
  });
  await promos.updateOne({ _id: promo._id }, { $inc: { usedCount: 1 } });
  await users.updateOne(
    { telegramId: uid },
    { $inc: { balance: promo.reward, lifetimeEarned: promo.reward } }
  );
  return res.status(200).json({ success: true, reward: promo.reward });
};
