const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");
const { ObjectId } = require("mongodb");

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

function isValidObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
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
      console.warn(`[SECURITY] Unauthorized admin/withdraws access from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const withdraws = db.collection("withdraws");
    const users = db.collection("users");

    if (req.method === "GET") {
      const allowedStatuses = ["pending", "approved", "rejected"];
      const filter =
        req.query.status && allowedStatuses.includes(req.query.status)
          ? { status: req.query.status }
          : {};
      const list = await withdraws
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      return res.status(200).json(list);
    }

    if (req.method === "POST") {
      const { id, action } = req.body || {};

      if (!isValidObjectId(id)) {
        return res.status(400).json({ error: "invalid id" });
      }
      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "invalid action" });
      }

      // Atomic claim: only proceed if status is still "pending" at update time.
      // Prevents race condition — two simultaneous admin clicks (or a retried
      // request) double-processing the same withdrawal.
      const claimed = await withdraws.findOneAndUpdate(
        { _id: new ObjectId(id), status: "pending" },
        { $set: { status: "processing" } },
        { returnDocument: "after" }
      );

      const w = claimed?.value || claimed; // driver-version-safe access
      if (!w) {
        // Either not found, or already processed by another request
        const existing = await withdraws.findOne({ _id: new ObjectId(id) });
        if (!existing) return res.status(404).json({ error: "not found" });
        return res.status(400).json({ error: "already processed" });
      }

      // Sanity-check the withdrawal amount before any refund logic
      const amount = Number(w.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        console.error(`[DATA ERROR] Invalid amount on withdraw ${w._id}`);
        // Roll back the "processing" lock so it can be reviewed manually
        await withdraws.updateOne({ _id: w._id }, { $set: { status: "pending" } });
        return res.status(400).json({ error: "invalid withdraw amount" });
      }

      if (action === "approve") {
        await withdraws.updateOne(
          { _id: w._id },
          { $set: { status: "approved", processedAt: new Date() } }
        );
      } else {
        // reject -> refund balance to user
        await users.updateOne(
          { telegramId: w.telegramId },
          { $inc: { balance: amount } }
        );
        await withdraws.updateOne(
          { _id: w._id },
          { $set: { status: "rejected", processedAt: new Date() } }
        );
      }

      console.log(`[ADMIN] Withdraw ${id} ${action}d by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] withdraws.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
