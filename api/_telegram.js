// api/_telegram.js
const fetch = require("node-fetch");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!BOT_TOKEN) {
  throw new Error("[CONFIG ERROR] BOT_TOKEN is not set in environment variables.");
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  // Fail loudly at startup rather than silently allowing weak/empty admin auth
  console.error(
    "[SECURITY WARNING] ADMIN_PASSWORD is missing or too short. Set a strong password (16+ random chars) in env vars."
  );
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgCall(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[TG API ERROR] ${method} failed with status ${res.status}`);
  }
  return res.json();
}

// Checks if a user is a member of a channel/group by @username or -100id
async function isMember(chatId, userId) {
  try {
    const data = await tgCall("getChatMember", { chat_id: chatId, user_id: userId });
    if (!data.ok) return false;
    const status = data.result.status;
    return ["member", "administrator", "creator"].includes(status);
  } catch (e) {
    console.error("[ERROR] isMember check failed:", e);
    return false;
  }
}

// Sends a photo with a caption to a chat/channel (e.g. posting a payment-
// proof card to the Pay Channel). chatId can be a @username or a -100...
// numeric channel id. Never throws — a failure here (bad chat id, bot not
// admin in the channel, etc.) should never block the admin action that
// triggered it (e.g. approving a withdraw), so callers can fire-and-forget
// or await it without extra try/catch.
async function sendPhoto(chatId, photoUrl, caption, parseMode = "Markdown") {
  try {
    const data = await tgCall("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: parseMode,
    });
    if (!data.ok) {
      console.error(`[TG API ERROR] sendPhoto to ${chatId} failed:`, data.description || data);
    }
    return data;
  } catch (e) {
    console.error("[ERROR] sendPhoto failed:", e);
    return null;
  }
}

// Sends a plain text message to a chat. chatId can be a user's telegramId
// (direct message — only works if that user has already started the bot,
// which every user of this mini app has, since starting the bot is how
// they open it in the first place), a @username, or a -100... channel id.
// Never throws — same fire-and-forget contract as sendPhoto above, so a
// failed notification (e.g. user blocked the bot) never blocks whatever
// server-side action triggered it.
async function sendMessage(chatId, text, parseMode = "Markdown") {
  try {
    const data = await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
    if (!data.ok) {
      console.error(`[TG API ERROR] sendMessage to ${chatId} failed:`, data.description || data);
    }
    return data;
  } catch (e) {
    console.error("[ERROR] sendMessage failed:", e);
    return null;
  }
}

// A referral counts as "valid" only once the referred user has cleared ALL
// THREE reward tiers: step1Rewarded (channel join + verify), step2Rewarded
// (10 tasks completed), step3Rewarded (25 ads watched) — these three flags
// already exist on the user doc (set in api/user.js, api/task.js, and
// api/earn.js respectively) and are only ever set when the user has a
// referrer, so their combined truthiness is exactly "all 3 milestones
// cleared by a referred user".
//
// Callers should re-fetch the referred user's fresh doc right after setting
// whichever stepXRewarded flag they just set, and pass that doc in here —
// this function itself does no DB reads for that doc, only for the write
// that claims the notification and the referrer's own doc update.
//
// `users` is the MongoDB "users" collection — passed in rather than
// required directly, since each of the three callers already has it open
// on their own db connection.
async function notifyIfValidReferral(users, referredUserDoc) {
  try {
    if (!referredUserDoc || !referredUserDoc.referredBy) return;
    if (referredUserDoc.validReferralNotified) return;
    if (
      !referredUserDoc.step1Rewarded ||
      !referredUserDoc.step2Rewarded ||
      !referredUserDoc.step3Rewarded
    ) {
      return;
    }

    // Atomic claim: only the caller that actually flips this to true gets
    // to send the notification and increment the referrer's count. Since
    // step1/2/3 can each complete via a different endpoint (user.js,
    // task.js, earn.js), it's possible for two of them to finish in quick
    // succession — this filter guarantees the notify+increment below fires
    // exactly once per referred user, no matter which endpoint's request
    // happens to be the one that completes the set.
    const claim = await users.updateOne(
      { telegramId: referredUserDoc.telegramId, validReferralNotified: { $ne: true } },
      { $set: { validReferralNotified: true } }
    );
    if (claim.modifiedCount === 0) return;

    await users.updateOne(
      { telegramId: referredUserDoc.referredBy },
      { $inc: { validReferralsCount: 1 } }
    );

    await sendMessage(
      referredUserDoc.referredBy,
      `🎉 *Congratulations!*\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked 1 valid referral — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`
    );
  } catch (e) {
    console.error("[ERROR] notifyIfValidReferral failed:", e);
  }
}

// Simple in-memory brute-force protection for admin login attempts
const failedAttempts = new Map(); // ip -> { count, firstAttempt }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOCKOUT_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
  entry.count++;
  failedAttempts.set(ip, entry);
}

// Timing-safe string comparison — prevents timing-attack password guessing
function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison to keep timing consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAdmin(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isLockedOut(ip)) {
    console.warn(`[SECURITY] Admin login locked out for IP: ${ip}`);
    return false;
  }

  const password = req.headers["x-admin-password"];
  if (!ADMIN_PASSWORD) {
    // Fail closed if password not configured — never allow access on misconfiguration
    return false;
  }

  const isValid = safeCompare(password, ADMIN_PASSWORD);
  if (!isValid) {
    recordFailedAttempt(ip);
    return false;
  }

  // Clear failed attempts on success
  failedAttempts.delete(ip);
  return true;
}

module.exports = { tgCall, isMember, checkAdmin, sendPhoto, sendMessage, notifyIfValidReferral };
