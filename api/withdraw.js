const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

const RDC_TO_USD = 0.00004;
const MIN_ADS_REQUIRED = 5;

const METHODS = {
  binance: { min: +(2000 * RDC_TO_USD).toFixed(4), label: "Binance UID" },
  tonkeeper: { min: +(1600 * RDC_TO_USD).toFixed(4), label: "Tonkeeper Address" },
};

const CONVERT_FEE_PERCENT = 25;
const MIN_CONVERT = 500;
const MAX_CONVERT = 10_000_000; // sanity ceiling against typo/overflow-style abuse
const MAX_WITHDRAW = 100_000; // USD sanity ceiling

function isValidAddress(addr) {
  return typeof addr === "string" && addr.trim().length >= 3 && addr.trim().length <= 200;
}

module.exports = async (req, res) => {
  try {
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    const uid = verifiedUser.id;

    const db = await getDb();
    const users = db.collection("users");
    const withdraws = db.collection("withdraws");

    if (req.method === "GET") {
      const history = await withdraws
        .find({ telegramId: uid })
        .sort({ createdAt: -1 })
        .limit(200)
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
      // ---- CONVERT (RDC -> USDT) ----
      if (req.body?.action === "convert") {
        const conversions = db.collection("conversions");
        const amount = Number(req.body.amount);

        if (!Number.isFinite(amount) || amount < MIN_CONVERT || amount > MAX_CONVERT) {
          return res.status(400).json({
            error: `Amount must be between ${MIN_CONVERT} and ${MAX_CONVERT} RDC`,
          });
        }

        const grossUsd = +(amount * RDC_TO_USD).toFixed(4);
        const fee = +(grossUsd * (CONVERT_FEE_PERCENT / 100)).toFixed(4);
        const receivedUsdt = +(grossUsd - fee).toFixed(4);

        // Atomic balance-check-and-deduct: the $gte condition is evaluated by
        // MongoDB at update time, so two simultaneous convert requests can't
        // both pass a stale "balance >= amount" check done in application code.
        // Only one can actually decrement past zero.
        const updateResult = await users.updateOne(
          { telegramId: uid, balance: { $gte: amount } },
          { $inc: { balance: -amount, usdtBalance: receivedUsdt } }
        );

        if (updateResult.matchedCount === 0) {
          // Either user doesn't exist, or balance was insufficient at the atomic check
          const exists = await users.findOne({ telegramId: uid });
          if (!exists) return res.status(404).json({ error: "user not found" });
          return res.status(400).json({ error: "insufficient RDC balance" });
        }

        const user = await users.findOne({ telegramId: uid });
        const doc = {
          telegramId: uid,
          username: user?.username || null,
          rdcAmount: amount,
          grossUsd,
          fee,
          receivedUsdt,
          createdAt: new Date(),
        };
        const result = await conversions.insertOne(doc);

        console.log(`[CONVERT] ${uid} converted ${amount} RDC -> ${receivedUsdt} USDT`);
        return res.status(200).json({ success: true, id: result.insertedId, grossUsd, fee, receivedUsdt });
      }

      // ---- WITHDRAW ----
      const { method, address, amount: rawAmount } = req.body || {};
      const amount = Number(rawAmount);

      if (!method || !address || !Number.isFinite(amount)) {
        return res.status(400).json({ error: "missing fields" });
      }
      if (!METHODS[method]) {
        return res.status(400).json({ error: "invalid method" });
      }
      if (!isValidAddress(address)) {
        return res.status(400).json({ error: "invalid address/UID format" });
      }
      const min = METHODS[method].min;
      if (amount < min || amount > MAX_WITHDRAW) {
        return res.status(400).json({ error: `Minimum withdraw for ${method} is $${min}` });
      }

      const user = await users.findOne({ telegramId: uid });
      if (!user) return res.status(404).json({ error: "user not found" });

      // Ads required TODAY (calendar day, midnight-to-midnight) — every
      // withdraw, on whichever day it's requested, needs its own fresh
      // MIN_ADS_REQUIRED ad watches from that same day. Ads watched on a
      // previous day don't carry over, and this only counts entries in
      // ad_logs (Adsgram/Monetag/GigaPub — the "Ads" section) — Special
      // Tasks and regular Task submissions are separate collections and
      // are never counted here.
      const adLogs = db.collection("ad_logs");
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const adsWatchedToday = await adLogs.countDocuments({
        telegramId: uid,
        watchedAt: { $gte: startOfToday },
      });
      if (adsWatchedToday < MIN_ADS_REQUIRED) {
        return res.status(400).json({
          error: `You need to watch at least ${MIN_ADS_REQUIRED} ads today before withdrawing (you've watched ${adsWatchedToday} today).`,
        });
      }

      // Atomic balance-check-and-deduct — same race-condition protection as convert above.
      // Prevents a user firing two withdraw requests in parallel and draining
      // more than their actual usdtBalance before either update commits.
      const updateResult = await users.updateOne(
        { telegramId: uid, usdtBalance: { $gte: amount } },
        { $inc: { usdtBalance: -amount } }
      );

      if (updateResult.matchedCount === 0) {
        return res.status(400).json({ error: "insufficient USDT balance" });
      }

      const fee = 0;
      const payout = amount;
      const usdValue = amount;
      const doc = {
        telegramId: uid,
        username: user.username,
        method,
        address: address.trim(),
        amount,
        fee,
        payout,
        usdValue,
        status: "pending",
        createdAt: new Date(),
      };
      const result = await withdraws.insertOne(doc);

      console.log(`[WITHDRAW] ${uid} requested $${amount} via ${method}`);
      return res.status(200).json({ success: true, id: result.insertedId, fee, payout, usdValue });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] withdraw.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
