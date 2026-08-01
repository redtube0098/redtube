const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    const uid = verifiedUser.id;

    const { code } = req.body || {};
    if (!code || typeof code !== "string" || !/^[A-Z0-9_-]{3,30}$/i.test(code.trim())) {
      return res.status(400).json({ error: "invalid code format" });
    }

    const db = await getDb();
    const promos = db.collection("promocodes");
    const users = db.collection("users");
    const claims = db.collection("promo_claims");

    const upperCode = code.trim().toUpperCase();
    const promo = await promos.findOne({ code: upperCode });
    if (!promo) return res.status(404).json({ error: "Invalid code" });

    // Atomic claim-slot reservation: only increments usedCount if it's still
    // below the limit at the moment of update. This closes the race window
    // where two users claiming the last slot simultaneously could both pass
    // an application-level "usedCount < limit" check and both succeed,
    // over-issuing rewards past the intended limit.
    const reserveResult = await promos.updateOne(
      { _id: promo._id, usedCount: { $lt: promo.limit } },
      { $inc: { usedCount: 1 } }
    );

    if (reserveResult.matchedCount === 0) {
      return res.status(400).json({ error: "This code has reached its claim limit" });
    }

    // Prevent double-claim by the same user. If this fails after we already
    // reserved a slot above, roll the slot back so the limit stays accurate.
    const alreadyClaimed = await claims.findOne({ telegramId: uid, code: promo.code });
    if (alreadyClaimed) {
      await promos.updateOne({ _id: promo._id }, { $inc: { usedCount: -1 } });
      return res.status(400).json({ error: "You already claimed this code" });
    }

    const user = await users.findOne({ telegramId: uid });
    if (!user) {
      await promos.updateOne({ _id: promo._id }, { $inc: { usedCount: -1 } });
      return res.status(404).json({ error: "user not found" });
    }

    await claims.insertOne({
      telegramId: uid,
      username: user.username || null,
      firstName: user.firstName || null,
      code: promo.code,
      reward: promo.reward,
      claimedAt: new Date(),
    });

    await users.updateOne(
      { telegramId: uid },
      { $inc: { balance: promo.reward, lifetimeEarned: promo.reward } }
    );

    console.log(`[PROMO] ${uid} claimed ${promo.code} for +${promo.reward} RDC`);
    return res.status(200).json({ success: true, reward: promo.reward });
  } catch (err) {
    console.error("[ERROR] promo.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
