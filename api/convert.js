const { getDb } = require("./_db");

const RDC_TO_USD = 0.00004;
const CONVERT_FEE_PERCENT = 25;
const MIN_CONVERT = 500;

module.exports = async (req, res) => {
  const db = await getDb();
  const users = db.collection("users");
  const conversions = db.collection("conversions");

  if (req.method !== "POST") return res.status(405).end();

  const { uid, amount } = req.body;
  if (!uid || !amount) return res.status(400).json({ error: "missing fields" });

  if (amount < MIN_CONVERT) {
    return res.status(400).json({ error: `Minimum convert amount is ${MIN_CONVERT} RDC` });
  }

  const user = await users.findOne({ telegramId: uid });
  if (!user) return res.status(404).json({ error: "user not found" });
  if (user.balance < amount) return res.status(400).json({ error: "insufficient RDC balance" });

  const grossUsd = +(amount * RDC_TO_USD).toFixed(4);
  const fee = +(grossUsd * (CONVERT_FEE_PERCENT / 100)).toFixed(4);
  const receivedUsdt = +(grossUsd - fee).toFixed(4);

  await users.updateOne(
    { telegramId: uid },
    { $inc: { balance: -amount, usdtBalance: receivedUsdt } }
  );

  const doc = {
    telegramId: uid,
    username: user.username,
    rdcAmount: amount,
    grossUsd,
    fee,
    receivedUsdt,
    createdAt: new Date(),
  };
  const result = await conversions.insertOne(doc);

  return res.status(200).json({ success: true, id: result.insertedId, grossUsd, fee, receivedUsdt });
};
