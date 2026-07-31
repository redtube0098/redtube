const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

// Simple in-memory rate limiter (per-IP) — production e Redis use koro multi-instance hole
const requestLog = new Map();
const RATE_LIMIT = 10; // max requests
const WINDOW_MS = 60 * 1000; // per 1 minute

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

module.exports = async (req, res) => {
  try {
    // 1. Method check first — fail fast
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 2. Rate limit by IP (protects against brute-force / scraping this admin endpoint)
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    // 3. Admin auth check
    if (!checkAdmin(req)) {
      // Log failed attempts — helps detect brute-force on admin token
      console.warn(`[SECURITY] Unauthorized admin access attempt from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 4. Actual logic
    const db = await getDb();
    const users = db.collection("users");
    const groups = await users
      .aggregate([
        { $match: { lastIp: { $ne: null, $exists: true, $ne: "unknown" } } },
        {
          $group: {
            _id: "$lastIp",
            count: { $sum: 1 },
            accounts: {
              $push: {
                telegramId: "$telegramId",
                username: "$username",
                firstName: "$firstName",
                referralsCount: "$referralsCount",
                referredBy: "$referredBy",
              },
            },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    return res.status(200).json(
      groups.map((g) => ({
        ip: g._id,
        accountCount: g.count,
        accounts: g.accounts,
      }))
    );
  } catch (err) {
    // Never leak internal error details to client
    console.error("[ERROR] multi-accounts.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
