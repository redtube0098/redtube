const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

// Rate limiter (per-IP) — production e Redis recommend kori multi-instance deploy hole
const requestLog = new Map();
const RATE_LIMIT = 15;
const WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    requestLog.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count++;
  requestLog.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

// Promo code format validation — sudhu alphanumeric, reasonable length
function isValidCode(code) {
  return typeof code === "string" && /^[A-Z0-9_-]{3,30}$/i.test(code.trim());
}

module.exports = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    if (!checkAdmin(req)) {
      console.warn(`[SECURITY] Unauthorized admin/promo access attempt from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const promos = db.collection("promocodes");
    const claims = db.collection("promo_claims");

    if (req.method === "GET") {
      if (req.query.code) {
        // Input validation before query — prevent malformed/oversized input
        if (!isValidCode(req.query.code)) {
          return res.status(400).json({ error: "invalid code format" });
        }
        const list = await claims
          .find({ code: req.query.code.trim().toUpperCase() })
          .sort({ claimedAt: -1 })
          .limit(500) // prevent unbounded result dump
          .toArray();
        return res.status(200).json(list);
      }
      const list = await promos
        .find({})
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      return res.status(200).json(list);
    }

    if (req.method === "POST") {
      const { code, reward, limit } = req.body || {};

      // Strict input validation
      if (!code || reward === undefined || !limit) {
        return res.status(400).json({ error: "missing fields" });
      }
      if (!isValidCode(code)) {
        return res.status(400).json({ error: "invalid code format" });
      }

      const rewardNum = Number(reward);
      const limitNum = Number(limit);

      if (
        !Number.isFinite(rewardNum) ||
        rewardNum < 0 ||
        !Number.isFinite(limitNum) ||
        limitNum <= 0 ||
        !Number.isInteger(limitNum)
      ) {
        return res.status(400).json({ error: "invalid reward or limit value" });
      }

      const upperCode = code.trim().toUpperCase();
      const exists = await promos.findOne({ code: upperCode });
      if (exists) return res.status(400).json({ error: "code already exists" });

      await promos.insertOne({
        code: upperCode,
        reward: rewardNum,
        limit: limitNum,
        usedCount: 0,
        createdAt: new Date(),
      });

      console.log(`[ADMIN] Promo code created: ${upperCode} by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] promo.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
