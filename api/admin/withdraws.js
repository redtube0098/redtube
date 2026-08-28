const { getDb } = require("../_db");
const { checkAdmin, sendPhoto, sendMessage } = require("../_telegram");
const { isSameDevice } = require("../_utils");
const { ObjectId } = require("mongodb");

const requestLog = new Map();
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 1000;

// Same conversion rate as api/withdraw.js's RDC_TO_USD — duplicated here
// only to turn a withdrawn USD amount into the RDC commission credited to
// the referrer below. Keep in sync if that rate ever changes.
const RDC_TO_USD = 0.00004;
const WITHDRAWAL_COMMISSION_PERCENT = 10;

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
}

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

// BUGFIX: escapes legacy-Markdown special characters (_ * ` [) in
// free-form text (like a Telegram @username) before it's dropped into a
// parse_mode:"Markdown" caption/message outside of any code span. Without
// this, a username containing an underscore (extremely common — e.g.
// "john_doe") could pair up with another underscore later in the message
// and get parsed as an unintended *italic* entity, which makes Telegram's
// API reject the WHOLE message with a "can't parse entities" error. That
// rejection was silent (caught and only console.error'd — see sendPhoto/
// sendMessage in ../_telegram.js) so the withdraw still got approved
// normally, but the Pay Channel post for that specific user just never
// appeared — explaining why only some approvals (the ones with
// underscore/asterisk/backtick/bracket usernames) failed to post while
// most went through fine.
function escapeMarkdown(text) {
  return String(text).replace(/([_*`\[])/g, "\\$1");
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
  const userLabel = username ? `@${escapeMarkdown(username)}` : "Unknown";
  const caption =
    `✅ *Withdrawal Completed*\n\n` +
    `👤 User: ${userLabel} (ID: \`${withdrawDoc.telegramId}\`)\n` +
    `💰 Amount: ${withdrawDoc.amount} USDT\n` +
    `🏦 Address: \`${maskAddress(withdrawDoc.address)}\``;

  await sendPhoto(PAY_CHANNEL_ID, PAYMENT_SUCCESS_IMAGE, caption);
}

// Sends the "Congratulations! You've received X USDT" message directly to
// the withdrawing user's own chat with the bot. Uses their telegramId as
// the chat_id — this only works because every user of this mini app has
// already started the bot (that's how they opened it), so a direct-message
// chat with them already exists on Telegram's side. Same fire-and-forget
// contract as postPaymentProof above — a failure (e.g. user blocked the
// bot) is logged but never affects the already-committed approval.
async function notifyUserOfWithdraw(withdrawDoc) {
  const text =
    `🎉 *Congratulations!*\n\n` +
    `You've received ${withdrawDoc.amount} USDT\n\n` +
    `\`${withdrawDoc.address}\`\n\n` +
    `💪 Keep up the great work! Watch more ads, complete tasks, and refer your friends to earn even more RDC every day. 🚀`;

  await sendMessage(withdrawDoc.telegramId, text);
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

      // --- Referral join-rate flag: for each withdrawing user, look at
      // everyone THEY referred and check what fraction never joined the
      // community/group channels (the "cross" ✗ shown in the Show
      // Referrals panel — user.joined !== true). If 70%+ of their referred
      // users are a cross, it's a strong signal of referral farming (bot/
      // proxy accounts made just to inflate the referral count), so we
      // surface a warning line under that user's name in the Withdraws
      // list. Computed here (not stored) so it's always live/current. ---
      const referrerIds = [...new Set(list.map((w) => w.telegramId).filter((id) => id != null))];
      const REFERRAL_CROSS_WARN_THRESHOLD = 70; // percent
      let referralStatsById = new Map();
      if (referrerIds.length > 0) {
        const stats = await users
          .aggregate([
            { $match: { referredBy: { $in: referrerIds } } },
            {
              $group: {
                _id: "$referredBy",
                total: { $sum: 1 },
                notJoined: { $sum: { $cond: [{ $eq: ["$joined", true] }, 0, 1] } },
              },
            },
          ])
          .toArray();
        referralStatsById = new Map(stats.map((s) => [s._id, s]));
      }

      const listWithFlags = list.map((w) => {
        const stat = referralStatsById.get(w.telegramId);
        let referralCrossPercent = null;
        let referralSuspicious = false;
        if (stat && stat.total > 0) {
          referralCrossPercent = Math.round((stat.notJoined / stat.total) * 100);
          referralSuspicious = referralCrossPercent >= REFERRAL_CROSS_WARN_THRESHOLD;
        }
        return { ...w, referralCrossPercent, referralSuspicious };
      });

      return res.status(200).json(listWithFlags);
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

        // Post the "Withdrawal Completed" proof card to the Pay Channel, and
        // message the user directly in their own chat with the bot. Looked
        // up here (not stored on the withdraw doc) so the channel post
        // always reflects the user's current Telegram username.
        const userDoc = await users.findOne({ telegramId: w.telegramId });
        await postPaymentProof(w, userDoc?.username);
        await notifyUserOfWithdraw(w);

        // --- Withdrawal commission: pay the REFERRER 10% of this
        // withdrawal, forever, every time a referred friend withdraws —
        // see the refer page's "Withdrawal commission" box. Paid in RDC,
        // converted from the withdrawn USD `amount` via RDC_TO_USD above.
        // Only fires on actual APPROVAL (never on request, never on a
        // rejected withdrawal) so a fraudulent/mistaken withdrawal can't
        // generate commission for anyone. Same same-device guard as the
        // other referral bonuses (earn.js / user.js / _telegram.js) —
        // skipped if the referrer shares a device/IP with this withdrawer.
        if (userDoc && userDoc.referredBy) {
          const referrerUser = await users.findOne({ telegramId: userDoc.referredBy });
          const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, userDoc.lastIp);
          if (referrerUser && !sameDeviceAsReferrer) {
            const commissionRdc = roundMoney((amount * WITHDRAWAL_COMMISSION_PERCENT) / 100 / RDC_TO_USD);
            if (commissionRdc > 0) {
              await users.updateOne(
                { telegramId: userDoc.referredBy },
                {
                  $inc: {
                    balance: commissionRdc,
                    lifetimeEarned: commissionRdc,
                    withdrawalCommissionEarnings: commissionRdc,
                  },
                }
              );
              console.log(
                `[REFERRAL] Withdrawal commission: uid ${userDoc.referredBy} earned ${commissionRdc} RDC (10% of $${amount}) from referred uid ${w.telegramId}'s withdrawal ${w._id}`
              );
            }
          }
        }
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
