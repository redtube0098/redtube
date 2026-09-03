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
// server-side action triggered it. Optional replyMarkup (e.g.
// EARN_MORE_KEYBOARD below) attaches an inline keyboard under the message —
// omitted entirely (not sent as a key) when null/undefined, so every
// existing sendMessage(chatId, text) call keeps working unchanged.
async function sendMessage(chatId, text, parseMode = "Markdown", replyMarkup = null) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const data = await tgCall("sendMessage", payload);
    if (!data.ok) {
      console.error(`[TG API ERROR] sendMessage to ${chatId} failed:`, data.description || data);
    }
    return data;
  } catch (e) {
    console.error("[ERROR] sendMessage failed:", e);
    return null;
  }
}

// Shared "EARN RDC MORE" inline button — a url button (not a bot command),
// so tapping it opens this exact Telegram Mini App directly, same as any
// other t.me deep link. Reused on every outbound message that's meant to
// pull the user back into the app: the promo-code broadcast, and the new
// withdrawal-commission / ads-reset / spin-reload notifications below.
// Update this one constant if the bot username or app short name changes.
const EARN_MORE_KEYBOARD = {
  inline_keyboard: [[{ text: "EARN RDC MORE 🚀", url: "https://t.me/redtube12_bot/earn" }]],
};

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

    // Every valid referral now also mints 1 Key Coin (🔑) for the referrer —
    // Key Coins are what actually gate withdrawals after the first free one
    // (see computeReferralEligibility in api/withdraw.js). validReferralsCount
    // is kept alongside it purely as a lifetime stat for admin/profile display.
    await users.updateOne(
      { telegramId: referredUserDoc.referredBy },
      { $inc: { validReferralsCount: 1, keyCoinBalance: 1 } }
    );

    await sendMessage(
      referredUserDoc.referredBy,
      `🎉 *Congratulations!*\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked 1 valid referral (🔑 Key Coin) — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`,
      "Markdown",
      EARN_MORE_KEYBOARD
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
        { $inc: { balance: 90, lifetimeEarned: 90, referralEarnings: 90 } }
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

// ---------------------------------------------------------------------
// NEW: persistent, resumable broadcast queue.
//
// WHY THIS EXISTS: every mass-send in this app (ads-reset nudge, spin-
// reload nudge, promo-code broadcast from the web admin panel, promo-code
// broadcast from the in-chat /admin flow) used to loop through ALL target
// users inside a single serverless invocation. That works fine at a few
// hundred users. At 30,000 users, sending 25 at a time with a 1s pause
// between batches takes 30000/25 * 1s ≈ 1,200s (20 minutes) — but this
// project's functions are capped at maxDuration: 60 (Vercel Hobby's max).
// Vercel kills the function at 60s no matter what, so only the first
// ~1,200-1,500 users near the front of the list ever actually got
// messaged; everyone after that silently never received anything. This
// was the real cause of "promo/notification not reaching all 30k users" —
// not a bug in the message-sending code itself, just a function that
// cannot possibly run long enough to finish.
//
// FIX: broadcasts are no longer sent inline. Creating one just inserts a
// small job document into the "broadcast_jobs" collection (instant).
// Actual sending happens in drainBroadcastQueue(), called from the
// reset-notify cron handler (api/bot.js) every time it's pinged. Each
// call only works for up to `timeBudgetMs` (kept well under the 60s
// function cap) and then stops, saving exactly how far it got
// (cursorTelegramId / cursorIndex) back onto the job document. The next
// ping — whether that's Vercel's own daily cron or (much better, see the
// setup note in api/bot.js) a free external pinger hitting the same URL
// every 1-5 minutes — picks up exactly where the last one left off. No
// matter how large the user base is, or how slow/interrupted the pings
// are, the queue always eventually finishes; it just may take longer if
// pings are infrequent. Nothing is lost between invocations because the
// cursor lives in MongoDB, not in memory.
const BROADCAST_JOB_BATCH_SIZE = 25; // Telegram-safe fan-out size per burst
const BROADCAST_JOB_BATCH_DELAY_MS = 1000; // pause between bursts, same rate-limit reasoning as before
const BROADCAST_USER_PAGE_SIZE = 1000; // how many "all_users" candidates we pull from Mongo per page

// Queues a broadcast to either every current user ("all_users" — the
// target list is resolved lazily, page by page, at drain time, ordered by
// telegramId) or a fixed, already-known list of telegramIds
// ("explicit_ids" — e.g. "these specific users' spins just reloaded").
// Returns the new job's _id. Safe to call as often as needed; multiple
// jobs queue up and drain in FIFO (oldest createdAt first) order.
async function enqueueBroadcast(db, { text, parseMode = "Markdown", keyboard = null, targetIds = null }) {
  const jobs = db.collection("broadcast_jobs");
  const doc = {
    mode: Array.isArray(targetIds) ? "explicit_ids" : "all_users",
    text,
    parseMode,
    keyboard,
    status: "pending",
    cursorTelegramId: null, // used by "all_users" mode
    cursorIndex: 0, // used by "explicit_ids" mode
    sentCount: 0,
    createdAt: new Date(),
    finishedAt: null,
  };
  if (doc.mode === "explicit_ids") {
    doc.targetIds = targetIds;
    doc.total = targetIds.length;
  }
  const result = await jobs.insertOne(doc);
  return result.insertedId;
}

// Notifies the admin (ADMIN_TELEGRAM_ID) once a broadcast_jobs entry
// finishes sending to everyone in its target set. Fire-and-forget-safe —
// sendMessage() itself never throws, so a failed/blocked admin DM can never
// stall or crash the drain loop that's calling this. `finalSentCount` is
// the job's true cumulative total (across every tick it took to finish),
// not just however many went out on the tick that happened to complete it.
async function notifyBroadcastJobDone(job, finalSentCount) {
  const modeLabel = job.mode === "explicit_ids" ? "Targeted broadcast" : "All-users broadcast";
  const firstLine = (job.text || "").split("\n")[0].slice(0, 60);
  const preview = firstLine + ((job.text || "").length > firstLine.length ? "…" : "");
  await sendMessage(
    ADMIN_TELEGRAM_ID,
    `✅ *Broadcast complete!*\n\n` +
      `${modeLabel} finished sending.\n` +
      `📨 Total sent: ${finalSentCount}\n` +
      `📝 Message: "${preview}"`,
    "Markdown"
  );
}

async function sendBatchAndPause(batchIds, job, startedAt, timeBudgetMs) {
  await Promise.all(batchIds.map((tid) => sendMessage(tid, job.text, job.parseMode || "Markdown", job.keyboard)));
  if (Date.now() - startedAt < timeBudgetMs) {
    await new Promise((resolve) => setTimeout(resolve, BROADCAST_JOB_BATCH_DELAY_MS));
  }
}

// Does up to `timeBudgetMs` worth of broadcast sending, then returns how
// many messages it sent this call. Meant to be called on every single
// reset-notify cron tick (see api/bot.js) — cheap/instant when the queue
// is empty (one indexed findOne that matches nothing), bounded work when
// it isn't. Never throws: a bad chat id or blocked bot for one user is
// already swallowed inside sendMessage() itself, so one broken user can
// never stall or crash the whole drain.
async function drainBroadcastQueue(db, timeBudgetMs = 45000) {
  const startedAt = Date.now();
  const jobs = db.collection("broadcast_jobs");
  const users = db.collection("users");
  let sentTotal = 0;

  while (Date.now() - startedAt < timeBudgetMs) {
    const job = await jobs.findOne({ status: "pending" }, { sort: { createdAt: 1 } });
    if (!job) break; // queue empty, nothing to do

    if (job.mode === "explicit_ids") {
      const ids = job.targetIds || [];
      let cursor = job.cursorIndex || 0;
      if (cursor >= ids.length) {
        await jobs.updateOne({ _id: job._id }, { $set: { status: "done", finishedAt: new Date() } });
        await notifyBroadcastJobDone(job, ids.length);
        continue;
      }
      while (cursor < ids.length && Date.now() - startedAt < timeBudgetMs) {
        const batch = ids.slice(cursor, cursor + BROADCAST_JOB_BATCH_SIZE);
        await sendBatchAndPause(batch, job, startedAt, timeBudgetMs);
        cursor += batch.length;
        sentTotal += batch.length;
      }
      const done = cursor >= ids.length;
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: { cursorIndex: cursor, status: done ? "done" : "pending", finishedAt: done ? new Date() : null },
          $inc: { sentCount: 0 }, // sentCount kept for parity; total progress = cursorIndex
        }
      );
      if (done) await notifyBroadcastJobDone(job, cursor);
      // continues the outer while loop — either more of this same job next
      // pass, or (if it just finished) whatever's next in the queue.
      continue;
    }

    // mode === "all_users": page through the users collection live, ordered
    // by telegramId, resuming after cursorTelegramId. Using live queries
    // (rather than snapshotting all 30k ids into the job doc up front)
    // keeps job documents small and means the query can use the
    // uniq_users_telegramId index added in _db.js.
    const filter = job.cursorTelegramId == null ? {} : { telegramId: { $gt: job.cursorTelegramId } };
    const page = await users
      .find(filter, { projection: { telegramId: 1 } })
      .sort({ telegramId: 1 })
      .limit(BROADCAST_USER_PAGE_SIZE)
      .toArray();

    if (page.length === 0) {
      await jobs.updateOne({ _id: job._id }, { $set: { status: "done", finishedAt: new Date() } });
      await notifyBroadcastJobDone(job, job.sentCount || 0);
      continue;
    }

    let lastId = job.cursorTelegramId;
    let i = 0;
    for (; i < page.length && Date.now() - startedAt < timeBudgetMs; i += BROADCAST_JOB_BATCH_SIZE) {
      const batch = page.slice(i, i + BROADCAST_JOB_BATCH_SIZE);
      await sendBatchAndPause(
        batch.map((u) => u.telegramId),
        job,
        startedAt,
        timeBudgetMs
      );
      lastId = batch[batch.length - 1].telegramId;
      sentTotal += batch.length;
    }

    await jobs.updateOne(
      { _id: job._id },
      { $set: { cursorTelegramId: lastId }, $inc: { sentCount: i } }
    );
    // Loop back around: if time's still left, the next while-loop pass
    // either pulls the next page of this same job or, once a page comes
    // back empty, marks it done and moves to the next queued job.
  }

  return sentTotal;
}

module.exports = {
  tgCall,
  isMember,
  checkAdmin,
  sendPhoto,
  sendMessage,
  notifyIfValidReferral,
  maybeRewardStep2Task,
  enqueueBroadcast,
  drainBroadcastQueue,
  ADMIN_TELEGRAM_ID,
  EARN_MORE_KEYBOARD,
};
