// api/earn.js
const { getDb } = require("./_db");

// Ad networks and their per-watch reward + daily limit (matches screenshot)
const AD_NETWORKS = {
  adsgram_daily: { reward: 10, limit: 10 },
  adsgram_special: { reward: 20, limit: 5 },
  monetag: { reward: 15, limit: 20 },
  gigapub: { reward: 15, limit: 20 },
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const db = await getDb();
  const users = db.collection("users");
  const adLogs = db.collection("ad_logs");

  const { uid, network } = req.body;
  if (!uid || !network || !AD_NETWORKS[network]) {
    return res.status(400).json({ error: "invalid request" });
  }

  const user = await users.findOne({ telegramId: uid });
  if (!user) return res.status(404).json({ error: "user not found" });

  // Count today's watches for this network
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const countToday = await adLogs.countDocuments({
    telegramId: uid,
    network,
    watchedAt: { $gte: startOfDay },
  });

  const cfg = AD_NETWORKS[network];
  if (countToday >= cfg.limit) {
    return res.status(400).json({ error: "daily limit reached" });
  }

  await adLogs.insertOne({ telegramId: uid, network, watchedAt: new Date() });
  await users.updateOne(
    { telegramId: uid },
    { $inc: { balance: cfg.reward, lifetimeEarned: cfg.reward, adsWatchedToday: 1 } }
  );

  const newCount = countToday + 1;
  return res.status(200).json({ success: true, reward: cfg.reward, watchedToday: newCount, limit: cfg.limit });
};
