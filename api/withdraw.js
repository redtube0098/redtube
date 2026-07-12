// api/withdraw.js
const { getDb } = require("./_db");

// 20 WTC = $0.001  ->  1 WTC = $0.00005
const WTC_TO_USD = 0.00005;
const WITHDRAW_FEE_PERCENT = 20; // 20% fee deducted from every withdrawal
const MIN_ADS_REQUIRED = 5;    // user must have watched at least this many ads before withdrawing

const METHODS = {
  binance: { min: 2000, label: "Binance UID" },
  tonkeeper: { min: 1600, label: "Tonkeeper Address" },
  bkash: { min: 5000, label: "bKash Number" },
};

module.exports = async (req, res) => {
  const db = await getDb();
  const users = db.collection("users");
  const withdraws = db.collection("withdraws");

  if (req.method === "GET") {
    const uid = Number(req.query.uid);
    if (!uid) return res.status(400).json({ error: "uid required" });

    const history = await withdraws
      .find({ telegramId: uid })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(
      history.map((w) => ({
        id: w._id,
        method: w.method,
        address: w.address,
        amount: w.amount,
        fee: w.fee,
        payout: w.payout,
        usdValue: +(w.payout * WTC_TO_USD).toFixed(4),
        status: w.status,
        createdAt: w.createdAt,
      }))
    );
  }

  if (req.method === "POST") {
    const { uid, method, address, amount } = req.body;
    if (!uid || !method || !address || !amount) {
      return res.status(400).json({ error: "missing fields" });
    }
    if (!METHODS[method]) return res.status(400).json({ error: "invalid method" });

    const min = METHODS[method].min;
    if (amount < min) {
      return res.status(400).json({ error: `Minimum withdraw for ${method} is ${min} WTC` });
    }

    const user = await users.findOne({ telegramId: uid });
    if (!user) return res.status(404).json({ error: "user not found" });
    if (user.balance < amount) return res.status(400).json({ error: "insufficient balance" });
   const adLogs = db.collection("ad_logs");
    const totalAdsWatched = await adLogs.countDocuments({ telegramId: uid });
    if (totalAdsWatched < MIN_ADS_REQUIRED) {
      return res.status(400).json({
        error: `You need to watch at least ${MIN_ADS_REQUIRED} ads before withdrawing (you've watched ${totalAdsWatched}).`,
      });
    }

    const fee = +(amount * (WITHDRAW_FEE_PERCENT / 100)).toFixed(2);
    const payout = +(amount - fee).toFixed(2);

    await users.updateOne({ telegramId: uid }, { $inc: { balance: -amount } });

    const doc = {
      telegramId: uid,
      username: user.username,
      method,
      address,
      amount,
      fee,
      payout,
      usdValue: +(payout * WTC_TO_USD).toFixed(4),
      status: "pending",
      createdAt: new Date(),
    };
    const result = await withdraws.insertOne(doc);

    return res.status(200).json({ success: true, id: result.insertedId, fee, payout });
  }

  return res.status(405).end();
};
