const { getDb } = require("../_db");
const { checkAdmin, sendPhoto } = require("../_telegram");
const { ObjectId } = require("mongodb");

const requestLog = new Map();
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 1000;

// Where the "Withdrawal Completed" payment-proof card gets posted after an
// admin approves a withdraw. Set PAY_CHANNEL_ID in your env vars to your
// Pay Channel's @username (e.g. "@redtubepayment") or its -100... chat id.
// The bot account must already be an admin of that channel, or Telegram
// will reject the send — this never blocks the approval itself either way.
const PAY_CHANNEL_ID = process.env.PAY_CHANNEL_ID;
const PAYMENT_SUCCESS_IMAGE = "https://i.postimg.cc/TwjkS2jB/b49076c3-566e-44db-bca6-47e44e7b6693.jpg";

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

// Masks a withdraw address for public display: first 4 chars + •••• +
// last 4 chars (e.g. "UQCf••••lwo0"). Short addresses are returned as-is
// rather than masked into something unreadable.
function maskAddress(address) {
  const a = String(address || "");
  if (a.length <= 8) return a;
  return `${a.slice(0, 4)}••••${a.slice(-4)}`;
}

// Posts the "Withdrawal Completed" proof card to the Pay Channel. Fire-
// and-forget from the caller's perspective: any failure here (missing
// PAY_CHANNEL_ID, bot not admin in the channel, Telegram API error) is
// logged but never affects the already-committed approval.
async function postPaymentProof(withdrawDoc, username) {
  if (!PAY_CHANNEL_ID) {
    console.warn("[WITHDRAW] PAY_CHANNEL_ID not set — skipping payment-proof post.");
    return;
  }
  const userLabel = username ? `@${username}` : "Unknown";
  const caption =
    `✅ *Withdrawal Completed*\n\n` +
    `👤 User: ${userLabel} (ID: \`${withdrawDoc.telegramId}\`)\n` +
    `💰 Amount: ${withdrawDoc.amount} USDT\n` +
    `🏦 Address: \`${maskAddress(withdrawDoc.address)}\``;

  await sendPhoto(PAY_CHANNEL_ID, PAYMENT_SUCCESS_IMAGE, caption);
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
    const lockedAddresses = db.collection("locked_withdraw_addresses");

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
        // SECURITY: re-validate the address lock at approval time too, not
        // just at request-creation time. This guards against edge cases like
        // the lock record being manually removed from the DB between the
        // user's request and the admin's approval, or two pending requests
        // for the same address slipping through before either was approved.
        if (w.address) {
          const normalizedAddress = String(w.address).trim().toLowerCase();
          const lockRecord = await lockedAddresses.findOne({ address: normalizedAddress });

          if (lockRecord && String(lockRecord.userId) !== String(w.telegramId)) {
            console.warn(
              `[SECURITY] Blocked approval of withdraw ${w._id}: address ${normalizedAddress} is locked to a different account (${lockRecord.userId}), request was from ${w.telegramId}`
            );
            // Roll back to pending so it doesn't get stuck in "processing"
            await withdraws.updateOne(
              { _id: w._id },
              { $set: { status: "pending" } }
            );
            return res.status(409).json({
              error: "This withdraw address is locked to a different account and cannot be approved",
            });
          }
        }

        await withdraws.updateOne(
          { _id: w._id },
          { $set: { status: "approved", processedAt: new Date() } }
        );

        // Post the "Withdrawal Completed" proof card to the Pay Channel.
        // Looked up here (not stored on the withdraw doc) so it always
        // reflects the user's current Telegram username.
        const userDoc = await users.findOne({ telegramId: w.telegramId });
        await postPaymentProof(w, userDoc?.username);
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

    if (req.method === "DELETE") {
      const { id } = req.body || {};

      if (!isValidObjectId(id)) {
        return res.status(400).json({ error: "invalid id" });
      }

      const existing = await withdraws.findOne({ _id: new ObjectId(id) });
      if (!existing) {
        return res.status(404).json({ error: "not found" });
      }
      // Only rejected withdraws can be deleted — pending needs to be
      // approved/rejected first, and approved records must stay as a
      // permanent payout history. This keeps deletion strictly limited to
      // rows the admin has already resolved and no longer needs.
      if (existing.status !== "rejected") {
        return res.status(400).json({ error: "only rejected withdraws can be deleted" });
      }

      await withdraws.deleteOne({ _id: new ObjectId(id) });

      console.log(`[ADMIN] Withdraw ${id} deleted by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] admin/withdraws.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
