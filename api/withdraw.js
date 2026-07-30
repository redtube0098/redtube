const { getDb } = require("./_db");
const RDC_TO_USD = 0.00004;
const MIN_ADS_REQUIRED = 5;

// Withdraw methods — minimums are now in USD (converted from the old RDC minimums using RDC_TO_USD)
const METHODS = {
  binance: { min: +(2000 * RDC_TO_USD).toFixed(4), label: "Binance UID" },
  tonkeeper: { min: +(1600 * RDC_TO_USD).toFixed(4), label: "Tonkeeper Address" },
  bkash: { min: +(5000 * RDC_TO_USD).toFixed(4), label: "bKash Number" },
};

// Convert (RDC -> USDT) settings
const CONVERT_FEE_PERCENT = 25;
const MIN_CONVERT = 500;

// NOTE: No fee is charged on withdraw anymore.
// The 25% fee is already deducted once, at the time of RDC -> USDT conversion (see "convert" action below).
// Withdrawals are now paid out in full, in USDT, from the user's already-converted usdtBalance.

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
        usdValue: w.usdValue,
        status: w.status,
        createdAt: w.createdAt,
      }))
    );
  }

  if (req.method === "POST") {
    // ---- CONVERT (RDC -> USDT), merged here to stay under the Hobby plan's
    // 12-serverless-function limit instead of having a separate api/convert.js ----
    if (req.body.action === "convert") {
      const conversions = db.collection("conversions");
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
    }

    // ---- WITHDRAW (now in USDT, no fee — the 25% fee was already taken at convert time) ----
    const { uid, method, address, amount } = req.body;
    if (!uid || !method || !address || !amount) {
      return res.status(400).json({ error: "missing fields" });
    }
    if (!METHODS[method]) return res.status(400).json({ error: "invalid method" });
    const min = METHODS[method].min;
    if (amount < min) {
      return res.status(400).json({ error: `Minimum withdraw for ${method} is $${min}` });
    }
    const user = await users.findOne({ telegramId: uid });
    if (!user) return res.status(404).json({ error: "user not found" });
    if ((user.usdtBalance || 0) < amount) {
      return res.status(400).json({ error: "insufficient USDT balance" });
    }
    const adLogs = db.collection("ad_logs");
    const totalAdsWatched = await adLogs.countDocuments({ telegramId: uid });
    if (totalAdsWatched < MIN_ADS_REQUIRED) {
      return res.status(400).json({
        error: `You need to watch at least ${MIN_ADS_REQUIRED} ads before withdrawing (you've watched ${totalAdsWatched}).`,
      });
    }
    const fee = 0; // No withdraw fee — 25% is already deducted during RDC -> USDT conversion
    const payout = amount;
    const usdValue = amount;
    await users.updateOne({ telegramId: uid }, { $inc: { usdtBalance: -amount } });
    const doc = {
      telegramId: uid,
      username: user.username,
      method,
      address,
      amount,
      fee,
      payout,
      usdValue,
      status: "pending",
      createdAt: new Date(),
    };
    const result = await withdraws.insertOne(doc);
    return res.status(200).json({ success: true, id: result.insertedId, fee, payout, usdValue });
  }

  return res.status(405).end();
};
