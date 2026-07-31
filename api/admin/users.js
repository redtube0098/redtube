const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

const requestLog = new Map();
const RATE_LIMIT = 20;
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
      console.warn(`[SECURITY] Unauthorized admin/users access from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const users = db.collection("users");

    if (req.method === "GET") {
      const q = req.query.q;

      // Must be a string — blocks NoSQL injection via object-shaped query params
      // (e.g. ?q[$ne]=null would arrive as an object, not a string)
      if (!q || typeof q !== "string") {
        return res.status(400).json({ error: "query required" });
      }

      const trimmedQ = q.trim().slice(0, 100); // cap length, defense in depth
      if (!trimmedQ) {
        return res.status(400).json({ error: "query required" });
      }

      const asNumber = Number(trimmedQ);
      const filter = !isNaN(asNumber)
        ? { telegramId: asNumber }
        : { username: trimmedQ.replace("@", "") };

      const user = await users.findOne(filter);
      if (!user) return res.status(404).json({ error: "not found" });

      // Never leak internal/sensitive fields (e.g. IP history, raw tokens) to admin UI unless needed
      return res.status(200).json(user);
    }

    if (req.method === "POST") {
      const { uid, amount } = req.body || {};

      if (uid === undefined || uid === null || amount === undefined) {
        return res.status(400).json({ error: "missing fields" });
      }

      const uidNum = Number(uid);
      const amountNum = Number(amount);

      if (!Number.isFinite(uidNum)) {
        return res.status(400).json({ error: "invalid uid" });
      }
      if (!Number.isFinite(amountNum)) {
        return res.status(400).json({ error: "invalid amount" });
      }
      // Guard against absurd values (typo protection, e.g. accidental extra zero)
      if (Math.abs(amountNum) > 1_000_000) {
        return res.status(400).json({ error: "amount exceeds safe limit" });
      }

      const result = await users.updateOne(
        { telegramId: uidNum },
        { $inc: { balance: amountNum } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "user not found" });
      }

      console.log(
        `[ADMIN] Balance adjusted for telegramId ${uidNum}: ${amountNum > 0 ? "+" : ""}${amountNum} by IP ${ip}`
      );
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] users.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
