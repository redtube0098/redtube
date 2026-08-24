// api/_telegram.js
const fetch = require("node-fetch");
const { isSameDevice } = require("./_utils");
const { verifyInitData } = require("./_verifyInitData");

const BOT_TOKEN = process.env.BOT_TOKEN;
// Admin access is now locked to this single Telegram account instead of a
// shared password. Override via env var if you ever need to change it
// without a redeploy of this constant; falls back to the owner's id below.
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID) || 5697990319;

if (!BOT_TOKEN) {
  throw new Error("[CONFIG ERROR] BOT_TOKEN is not set in environment variables.");
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
// already exist on the user doc (set in api/user.js, maybeRewardStep2Task
// below, and api/earn.js respectively) and are only ever set when the user
// has a referrer, so their combined truthiness is exactly "all 3 milestones
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

// MongoDB driver v6+ made findOneAndUpdate() return the document directly
// instead of the old { value: doc } wrapper. This works with either.
function extractDoc(result) {
  if (result && typeof result === "object" && "value" in result) {
    return result.value;
  }
  return result;
}

// Referral Tier 2 (friend completes 10 tasks -> referrer gets +60) — SHARED
// logic used by every place a task can be completed: regular task
// auto-approve, special (channel-join) task completion, AND admin manual
// approval of a regular task submission. Previously each call site had its
// own copy of this check using ONLY "tasksCompleted" (which is incremented
// exclusively by regular-task approval), so a user who completed 10 special
// tasks — or a mix of regular+special adding up to 10 — never triggered the
// referrer's bonus. This version counts BOTH task systems together, and any
// call site invoking this after ANY task completion will pick up combined
// progress made through either system.
//
// `db` is the raw Mongo db handle (needed to reach task_submissions and
// special_task_logs directly), `users` is the already-open users collection,
// `telegramId` is the id of the user who just completed a task (the
// REFERRED user, not the referrer).
async function maybeRewardStep2Task(db, users, telegramId) {
  try {
    const user = await users.findOne({ telegramId });
    if (!user || !user.referredBy || user.step2Rewarded) return;

    const submissions = db.collection("task_submissions");
    const specialTaskLogs = db.collection("special_task_logs");
    const [regularCount, specialCount] = await Promise.all([
      submissions.countDocuments({ telegramId, status: "approved" }),
      specialTaskLogs.countDocuments({ telegramId }),
    ]);
    const combined = regularCount + specialCount;
    if (combined < 10) return;

    // Atomic claim — filter re-checks "not already rewarded" at write time,
    // so two task-completion requests landing at nearly the same moment
    // (e.g. a regular submit and a special complete racing each other)
    // can't both pay the referrer twice.
    const claim = await users.findOneAndUpdate(
      { telegramId, step2Rewarded: { $ne: true } },
      { $set: { step2Rewarded: true } },
      { returnDocument: "after" }
    );
    const claimedUser = extractDoc(claim);
    if (!claimedUser) return; // lost the race, someone else already claimed it

    // MULTI-ACCOUNT GUARD: same rule as before — skip the referrer's coin
    // payout (not the referral count itself) if this account shares a
    // device/IP with its referrer.
    const referrerUser = await users.findOne({ telegramId: claimedUser.referredBy });
    const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, claimedUser.lastIp);

    if (!sameDeviceAsReferrer) {
      await users.updateOne(
        { telegramId: claimedUser.referredBy },
        { $inc: { balance: 60, lifetimeEarned: 60, referralEarnings: 60 } }
      );
    }

    await notifyIfValidReferral(users, claimedUser);
  } catch (e) {
    console.error("[ERROR] maybeRewardStep2Task failed:", e);
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

// Admin auth is now Telegram-only: the admin panel runs as a Telegram Mini
// App and every request must carry the signed initData string Telegram
// itself hands to the page (window.Telegram.WebApp.initData). That string
// is HMAC-signed by Telegram using BOT_TOKEN, so it cannot be forged from
// a browser/devtools without knowing the bot token — unlike a password,
// it's never typed, stored, or visible anywhere that could leak. On top of
// verifying the signature, we also require the signed user id to match
// ADMIN_TELEGRAM_ID, so even a legitimate Telegram session from any other
// account is rejected.
function checkAdmin(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isLockedOut(ip)) {
    console.warn(`[SECURITY] Admin login locked out for IP: ${ip}`);
    return false;
  }

  const initData = req.headers["x-telegram-init-data"];
  const user = verifyInitData(initData);

  if (!user || user.id !== ADMIN_TELEGRAM_ID) {
    recordFailedAttempt(ip);
    console.warn(`[SECURITY] Rejected admin access attempt from IP: ${ip}${user ? ` (telegram id ${user.id})` : ""}`);
    return false;
  }

  // Clear failed attempts on success
  failedAttempts.delete(ip);
  return true;
}

module.exports = {
  tgCall,
  isMember,
  checkAdmin,
  sendPhoto,
  sendMessage,
  notifyIfValidReferral,
  maybeRewardStep2Task,
  ADMIN_TELEGRAM_ID,
};
