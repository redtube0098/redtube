// api/earn.js
const { getDb } = require("./_db");
// Ad networks and their per-watch reward + daily limit
const AD_NETWORKS = {
  adsgram_special: { reward: 15, limit: 5, cooldown: 20 },
  monetag: { reward: 10, limit: 20, cooldown: 60 },
  gigapub: { reward: 15, limit: 20, cooldown: 20 },
};
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
  const db = await getDb();
  const users = db.collection("users");
  const adLogs = db.collection("ad_logs");
  const uid = Number(req.query.uid || (req.body && req.body.uid));
  if (!uid) return res.status(400).json({ error: "uid required" });
  if (req.method === "GET") {
    // Returns current watch count + cooldown status for every network, for the frontend to render on page load
    const startOfDay = getStartOfDay();
    const result = {};
    for (const [key, cfg] of Object.entries(AD_NETWORKS)) {
      const countToday = await adLogs.countDocuments({
        telegramId: uid,
        network: key,
        watchedAt: { $gte: startOfDay },
      });
      const lastLog = await adLogs.find({ telegramId: uid, network: key }).sort({ watchedAt: -1 }).limit(1).toArray();
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
  if (req.method !== "POST") return res.status(405).end();
  const { network } = req.body;
  if (!network || !AD_NETWORKS[network]) {
    return res.status(400).json({ error: "invalid request" });
  }
  const user = await users.findOne({ telegramId: uid });
  if (!user) return res.status(404).json({ error: "user not found" });
  const cfg = AD_NETWORKS[network];
  const startOfDay = getStartOfDay();
  // Check cooldown since the last watch of this network
  const lastLog = await adLogs.find({ telegramId: uid, network }).sort({ watchedAt: -1 }).limit(1).toArray();
  if (lastLog.length) {
    const elapsed = (Date.now() - new Date(lastLog[0].watchedAt).getTime()) / 1000;
    if (elapsed < cfg.cooldown) {
      return res.status(400).json({
        error: "cooldown",
        secondsLeft: Math.ceil(cfg.cooldown - elapsed),
      });
    }
  }
  // Check today's daily limit
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
    { $inc: { balance: cfg.reward, lifetimeEarned: cfg.reward, adsWatchedToday: 1, adsWatchedTotal: 1 } }
  );
  const newCount = countToday + 1;

  // Referral Tier 3: friend watches 25 ads (lifetime) -> referrer gets +130
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
};
