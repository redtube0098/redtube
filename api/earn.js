// api/earn.js
const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

const AD_NETWORKS = {
  adsgram_daily: { reward: 10, limit: 15, cooldown: 20 },
  adsgram_special: { reward: 15, limit: 5, cooldown: 20 },
  monetag: { reward: 10, limit: 20, cooldown: 60 },
  gigapub: { reward: 15, limit: 20, cooldown: 20 },
};

const inFlightRequests = new Set();

function getStartOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getSecondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return Math.ceil((midnight - now) / 1000);
}

module.exports = async (req, res) => {
  try {
    // --- Verify the request genuinely came from Telegram, for a real user ---
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);

    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }

    // uid now comes ONLY from verified data — never trust client-supplied uid
    const uid = verifiedUser.id;

    const db = await getDb();
    const users = db.collection("users");
    const adLogs = db.collection("ad_logs");

    if (req.method === "GET") {
      const startOfDay = getStartOfDay();
      const result = {};
      for (const [key, cfg] of Object.entries(AD_NETWORKS)) {
        const countToday = await adLogs.countDocuments({
          telegramId: uid,
          network: key,
          watchedAt: { $gte: startOfDay },
        });
        const lastLog = await adLogs
          .find({ telegramId: uid, network: key })
          .sort({ watchedAt: -1 })
          .limit(1)
          .toArray();
        let secondsLeft = 0;
        if (lastLog.length) {
          const elapsed = (Date.now() - new Date(lastLog[0].watchedAt).getTime()) / 1000;
          secondsLeft = Math.max(0, Math.ceil(cfg.cooldown - elapsed));
        }
        result[key] = {
          watchedToday: countToday,
          limit: cfg.limit,
          reward: cfg.reward,
          cooldownSecondsLeft: secondsLeft,
          limitReached: countToday >= cfg.limit,
          resetInSeconds: countToday >= cfg.limit ? getSecondsUntilMidnight() : null,
        };
      }
      return res.status(200).json(result);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { network } = req.body || {};
    if (!network || typeof network !== "string" || !AD_NETWORKS[network]) {
      return res.status(400).json({ error: "invalid request" });
    }

    const lockKey = `${uid}:${network}`;
    if (inFlightRequests.has(lockKey)) {
      return res.status(429).json({ error: "request already in progress" });
    }
    inFlightRequests.add(lockKey);

    try {
      const user = await users.findOne({ telegramId: uid });
      if (!user) return res.status(404).json({ error: "user not found" });

      const cfg = AD_NETWORKS[network];
      const startOfDay = getStartOfDay();

      const lastLog = await adLogs
        .find({ telegramId: uid, network })
        .sort({ watchedAt: -1 })
        .limit(1)
        .toArray();
      if (lastLog.length) {
        const elapsed = (Date.now() - new Date(lastLog[0].watchedAt).getTime()) / 1000;
        if (elapsed < cfg.cooldown) {
          return res.status(400).json({
            error: "cooldown",
            secondsLeft: Math.ceil(cfg.cooldown - elapsed),
          });
        }
      }

      const countToday = await adLogs.countDocuments({
        telegramId: uid,
        network,
        watchedAt: { $gte: startOfDay },
      });
      if (countToday >= cfg.limit) {
        return res.status(400).json({
          error: "limit",
          watchedToday: countToday,
          limit: cfg.limit,
          resetInSeconds: getSecondsUntilMidnight(),
        });
      }

      await adLogs.insertOne({ telegramId: uid, network, watchedAt: new Date() });

      await users.updateOne(
        { telegramId: uid },
        {
          $inc: {
            balance: cfg.reward,
            lifetimeEarned: cfg.reward,
            adsWatchedToday: 1,
            adsWatchedTotal: 1,
          },
        }
      );

      const newCount = countToday + 1;

      const updatedUser = await users.findOne({ telegramId: uid });
      if (
        updatedUser &&
        updatedUser.referredBy &&
        !updatedUser.step3Rewarded &&
        (updatedUser.adsWatchedTotal || 0) >= 25
      ) {
        await users.updateOne(
          { telegramId: updatedUser.referredBy },
          { $inc: { balance: 130, lifetimeEarned: 130, referralEarnings: 130 } }
        );
        await users.updateOne({ telegramId: uid }, { $set: { step3Rewarded: true } });
      }

      return res.status(200).json({
        success: true,
        reward: cfg.reward,
        watchedToday: newCount,
        limit: cfg.limit,
        cooldownSeconds: cfg.cooldown,
        limitReached: newCount >= cfg.limit,
        resetInSeconds: newCount >= cfg.limit ? getSecondsUntilMidnight() : null,
      });
    } finally {
      inFlightRequests.delete(lockKey);
    }
  } catch (err) {
    console.error("[ERROR] earn.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
