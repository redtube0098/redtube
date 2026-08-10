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
    const lockedAddresses = db.collection("locked_withdraw_addresses");

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

    // Cross-reference: for every account inside a suspicious IP group, attach
    // its permanently locked withdraw address (if any). This doesn't do any
    // blocking itself — the actual enforcement happens in withdraw.js via the
    // unique-indexed locked_withdraw_addresses collection — this is purely
    // for admin visibility, so a reviewer can see at a glance e.g. "these 3
    // accounts share an IP AND 2 of them are locked to suspiciously similar
    // addresses" or "these accounts share an IP but have distinct locked
    // addresses, probably a shared network (office/family), not abuse".
    const allTelegramIds = groups.flatMap((g) => g.accounts.map((a) => a.telegramId));

    const locks = allTelegramIds.length
      ? await lockedAddresses
          .find({ userId: { $in: allTelegramIds } })
          .project({ userId: 1, address: 1, method: 1, lockedAt: 1, _id: 0 })
          .toArray()
      : [];

    const lockByUserId = new Map(locks.map((l) => [String(l.userId), l]));

    const enrichedGroups = groups.map((g) => ({
      ip: g._id,
      accountCount: g.count,
      accounts: g.accounts.map((a) => {
        const lock = lockByUserId.get(String(a.telegramId));
        return {
          ...a,
          lockedWithdrawAddress: lock ? lock.address : null,
          lockedWithdrawMethod: lock ? lock.method : null,
          lockedAt: lock ? lock.lockedAt : null,
        };
      }),
    }));

    return res.status(200).json(enrichedGroups);
  } catch (err) {
    // Never leak internal error details to client
    console.error("[ERROR] multi-accounts.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
