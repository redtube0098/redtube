const { getDb } = require("./_db");
const {
  tgCall,
  sendMessage,
  ADMIN_TELEGRAM_ID,
  EARN_MORE_KEYBOARD,
  enqueueBroadcast,
  drainBroadcastQueue,
  listPendingWithdraws,
  approveWithdrawById,
  rejectWithdrawById,
  escapeMarkdown,
} = require("./_telegram");
const fetch = require("node-fetch");

const WEBAPP_URL = process.env.WEBAPP_URL;
// Admin panel lives at /admin.html on the same deployment as the mini app.
// Derived from WEBAPP_URL's origin so it always points at the right host.
const ADMIN_WEBAPP_URL = WEBAPP_URL ? new URL("/admin.html", WEBAPP_URL).toString() : null;
const TGADS_WID = process.env.TGADS_WID; // widget ID from tgads.live dashboard
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // set this via bot.telegram.setWebhook(..., { secret_token })
const BANNER_IMAGE_URL = "https://i.postimg.cc/xTnSxLWs/04be4b98-8bdc-4c8a-b52e-c5d30338fe3c.png";
const CHANNEL_LINK = "https://t.me/redtubecommunity";
const COMMUNITY_LINK = "https://t.me/redtubeofficial00";

// --- Cron reset-notify job, merged into THIS file (not its own /api/cron
// route) ---------------------------------------------------------------
// This app was previously sitting at exactly 12 routes under /api (Vercel
// Hobby's hard cap on Serverless Functions per deployment). The 5 old
// admin/*.js routes (multi-accounts, promo, tasks, users, withdraws) have
// since been merged into the existing api/admin/withdraws.js (repurposed, no new file) — so the project is now at
// 8 routes (admin, bot, earn, promo, referral, task, user, withdraw), with
// 4 slots free. Reset-notify is STILL handled here rather than as its own
// api/cron/reset-notify.js — not because a slot isn't available anymore,
// but because a Telegram webhook is always POST, so branching on a GET to
// this same URL costs nothing and keeps the cron logic next to the rest of
// the bot's request handling.
//
// Point an external pinger AND Vercel Cron at:
//   GET /api/bot?cron=reset-notify   (see vercel.json)
//
// *** IMPORTANT — READ THIS IF BROADCASTS AREN'T REACHING EVERYONE ***
// Vercel's Hobby plan silently caps Cron Jobs to running AT MOST ONCE PER
// DAY, no matter what schedule you put in vercel.json ("*/30 * * * *" etc
// is simply ignored/collapsed down to daily on Hobby — this is a Vercel
// platform limit, nothing to do with this code or vercel.json's syntax).
// So on Hobby, vercel.json's cron alone will only ever fire once a day.
// That's fine for the daily ads-reset check, but it means the broadcast
// queue below (see _telegram.js's drainBroadcastQueue) would only get
// drained once a day too — too slow for 30k users waiting on a promo
// notification.
//
// FIX: set up a free external scheduler to hit this exact URL every 1-5
// minutes (this is just a plain HTTP GET, so it works from ANY plan,
// Hobby included — the once-a-day limit only applies to Vercel's own
// built-in Cron trigger, not to who/what calls the URL):
//   1. Go to https://cron-job.org (free) or use a GitHub Actions
//      scheduled workflow — either works.
//   2. Create a job hitting:
//        https://YOUR_DOMAIN/api/bot?cron=reset-notify&secret=YOUR_CRON_SECRET
//      (YOUR_CRON_SECRET = the same value as the CRON_SECRET env var set
//      in Vercel — this is the "manual ?secret=" path in the auth check
//      below, so no Vercel-specific header/config is needed for it).
//   3. Set the interval to every 1-5 minutes.
// Keep vercel.json's cron entry too — it's a harmless once-daily
// safety-net in case the external pinger is ever down, no changes needed
// there. With the external pinger running every few minutes, a 30k-user
// broadcast queued via enqueueBroadcast() (see _telegram.js) finishes in
// well under an hour instead of never finishing at all.
//
// Auth: accepts EITHER the Authorization header Vercel Cron automatically
// attaches when a CRON_SECRET env var is set, OR a manual ?secret= query
// param for an external pinger — both compared against the same
// CRON_SECRET env var. Safe to call as often as you like: every job this
// handler does (ads-reset dedupe, spin-reload dedupe, and the broadcast
// queue drain) is idempotent/resumable, so an extra/overlapping
// invocation just finds nothing new to do, or picks up the queue exactly
// where the last call left off, and returns quickly either way.
const SPINS_PER_BATCH_CRON = 15; // keep in sync with api/earn.js's SPINS_PER_BATCH
const SPIN_BATCH_COOLDOWN_HOURS_CRON = 10; // keep in sync with api/earn.js's SPIN_BATCH_COOLDOWN_HOURS
// How much of each cron tick's time budget goes to draining the broadcast
// queue.
//
// IMPORTANT: this used to be 45000 (45s). That's under this function's own
// maxDuration (60, set at the bottom of this file), so Vercel never killed
// it — but external pingers have their OWN, usually much shorter, timeout
// on the HTTP connection itself, separate from Vercel's limit. cron-job.org
// (a commonly-used free pinger for exactly this setup) hard-closes the
// connection after 30s and marks the run "Failed (timeout)" — visible in
// its dashboard as repeated timeout failures even though a manual browser
// hit of the same URL succeeds (the browser just waits longer than 30s).
// Every scheduled tick was hitting that 30s wall and getting cut off before
// this handler could even finish the drain step, let alone respond — so
// the queue only ever advanced during manual visits, never automatically.
//
// FIX: keep total handler time comfortably under 30s, with headroom for
// DB connection setup, the ads-reset/spin-reload checks above, and network
// latency to the pinger itself — 18s leaves a solid ~12s margin. If you
// upgrade to cron-job.org's paid "sustaining membership" (5-minute timeout)
// or switch to a pinger with a longer/no timeout, this can be raised again
// — just keep it under whatever your pinger's own timeout is, not just
// under Vercel's maxDuration.
const CRON_DRAIN_TIME_BUDGET_MS = 18000;

function cronStartOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// "YYYY-MM-DD" for the current local day — same clock getStartOfDay() uses
// everywhere else in this app (api/earn.js, api/withdraw.js) — used as a
// once-per-day dedupe key for the ads-reset broadcast below.
function cronTodayKey() {
  return cronStartOfDay().toISOString().slice(0, 10);
}

async function handleResetNotifyCron(req, res) {
  try {
    const CRON_SECRET = process.env.CRON_SECRET;
    if (!CRON_SECRET) {
      console.error("[CONFIG ERROR] CRON_SECRET is not set — refusing to run reset-notify.");
      return res.status(500).json({ error: "server not configured" });
    }
    const authHeader = req.headers.authorization;
    const validVercelAuth = authHeader === `Bearer ${CRON_SECRET}`;
    const validManualSecret = req.query && req.query.secret === CRON_SECRET;
    if (!validVercelAuth && !validManualSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const db = await getDb();
    const users = db.collection("users");
    const settings = db.collection("settings");

    // ---- 1) DAILY ADS-RESET BROADCAST ----
    // The "Today: +X RDC" total on the Earning tab already resets itself
    // automatically at local midnight (computed live from today's ad logs —
    // see api/earn.js's getStartOfDay()/_todayEarned — no extra code needed
    // for that). This is ONLY the "come back, ads have reset" nudge
    // message, sent to every user once per calendar day. A single settings
    // doc tracks the last date this fired, claimed atomically so it's safe
    // even if this endpoint gets triggered many times in the same day.
    // NOTE: this used to fetch every user and send to all of them right
    // here, inline. That could never finish for 30k users inside one
    // invocation (see the big comment above and in _telegram.js) — it now
    // just enqueues an "all_users" broadcast job (instant) and the actual
    // sending happens in the drainBroadcastQueue() call at the bottom of
    // this function, spread across this and however many subsequent ticks
    // it takes.
    let adsResetQueued = false;
    const today = cronTodayKey();
    // NOTE: this upsert's filter uses $ne on a non-_id field. Once today's
    // doc already exists (lastNotifiedDate === today), the filter no longer
    // matches it — but upsert:true still tries to INSERT a new doc using the
    // filter's _id ("ads_reset_notify"), which already exists, causing a
    // MongoServerError E11000 duplicate key error on every subsequent tick
    // for the rest of the day. That crashed this whole cron invocation
    // before it ever reached drainBroadcastQueue() below, which is also why
    // queued broadcasts stopped progressing. A duplicate-key error here just
    // means "already notified today" — treat it as a no-op, not a failure.
    let claim;
    try {
      claim = await settings.updateOne(
        { _id: "ads_reset_notify", lastNotifiedDate: { $ne: today } },
        { $set: { lastNotifiedDate: today, lastNotifiedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      if (e && e.code === 11000) {
        claim = { modifiedCount: 0, upsertedCount: 0 };
      } else {
        throw e;
      }
    }
    if (claim.modifiedCount > 0 || claim.upsertedCount > 0) {
      const text =
        `🔄 *Ads have reset!*\n\n` +
        `Your daily ad watch limits are back to zero — watch them all again for maximum earnings today! 🚀`;
      await enqueueBroadcast(db, { text, keyboard: EARN_MORE_KEYBOARD });
      adsResetQueued = true;
    }

    // ---- 2) PER-USER SPIN-BATCH RELOAD NOTIFICATION ----
    // Mirrors the exact same lazy-reset condition api/earn.js already uses
    // when a user happens to open the Spin tab after their 10h cooldown has
    // passed (spinsAvailable <= 0 AND spinsExhaustedAt more than
    // SPIN_BATCH_COOLDOWN_HOURS_CRON ago) — this just performs that same
    // reset proactively (instead of waiting for the user to open the app)
    // and then messages them. The atomic per-document match/update means
    // this can never double-reset or double-notify someone: once reset,
    // spinsAvailable becomes 15 (> 0) and the query below simply stops
    // matching that user until they exhaust their next batch.
    let spinResetQueued = 0;
    const cooldownCutoff = new Date(Date.now() - SPIN_BATCH_COOLDOWN_HOURS_CRON * 3600 * 1000);
    const dueUsers = await users
      .find(
        { spinsAvailable: { $lte: 0 }, spinsExhaustedAt: { $ne: null, $lte: cooldownCutoff } },
        { projection: { telegramId: 1 } }
      )
      .toArray();

    const justReset = [];
    for (const u of dueUsers) {
      const result = await users.updateOne(
        { telegramId: u.telegramId, spinsAvailable: { $lte: 0 }, spinsExhaustedAt: { $ne: null, $lte: cooldownCutoff } },
        { $set: { spinsAvailable: SPINS_PER_BATCH_CRON, spinsExhaustedAt: null }, $inc: { spinBatchNumber: 1 } }
      );
      if (result.modifiedCount > 0) justReset.push(u.telegramId);
    }
    if (justReset.length) {
      // Explicit_ids mode — this is a specific subset of users (whoever's
      // cooldown just lapsed this tick), not "everyone", so it queues with
      // a fixed target list rather than the "all_users" mode used above.
      const text =
        `🎡 *Your spins have reloaded!*\n\n` +
        `You've got ${SPINS_PER_BATCH_CRON} fresh spins waiting — come spin now! 🎉`;
      await enqueueBroadcast(db, { text, keyboard: EARN_MORE_KEYBOARD, targetIds: justReset });
      spinResetQueued = justReset.length;
    }

    // ---- 3) DRAIN THE BROADCAST QUEUE ----
    // Whatever's pending in broadcast_jobs (the two enqueues just above,
    // PLUS any promo-code broadcast queued via api/admin/withdraws.js (?resource=promo) or the
    // in-chat /admin promo flow below) gets worked on here, bounded to
    // CRON_DRAIN_TIME_BUDGET_MS so this invocation always returns well
    // before Vercel's 60s cap AND before the external pinger's own (usually
    // much shorter) connection timeout — see the constant's definition
    // above for why that second limit is the one that actually matters in
    // practice. Whatever doesn't get finished this tick resumes
    // automatically on the next one — see the big comment above
    // handleResetNotifyCron for why frequent external pings matter here.
    const drainedThisTick = await drainBroadcastQueue(db, CRON_DRAIN_TIME_BUDGET_MS);

    console.log(
      `[CRON] reset-notify: adsResetQueued=${adsResetQueued}, spinResetQueued=${spinResetQueued}, broadcastMessagesSentThisTick=${drainedThisTick}`
    );
    return res.status(200).json({ success: true, adsResetQueued, spinResetQueued, broadcastMessagesSentThisTick: drainedThisTick });
  } catch (err) {
    console.error("[ERROR] bot.js reset-notify cron:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

if (!WEBAPP_URL) {
  console.error("[CONFIG ERROR] WEBAPP_URL is not set.");
}
if (!WEBHOOK_SECRET) {
  console.warn(
    "[SECURITY WARNING] WEBHOOK_SECRET is not set. Anyone who discovers this URL can send fake Telegram updates. Set WEBHOOK_SECRET and configure it via setWebhook's secret_token."
  );
}

// Per-user rate limiter — loose enough not to block real users double-tapping /start,
// tight enough to stop scripted spam
const userLastStart = new Map();
const START_COOLDOWN_MS = 2000;

function isSpammingStart(userId) {
  const now = Date.now();
  const last = userLastStart.get(userId) || 0;
  if (now - last < START_COOLDOWN_MS) return true;
  userLastStart.set(userId, now);
  return false;
}

// Fetches one ad from TGAds and sends it as a photo message to the user.
// Fails silently (just logs) so a broken ad network never blocks the normal /start flow.
async function sendTgAdsAd(chatId, user) {
  if (!TGADS_WID) return; // not configured yet
  try {
    const bidRes = await fetch("https://bid.tgads.live/bot-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wid: TGADS_WID,
        language: "en",
        isPremium: !!user.is_premium,
        firstName: user.first_name || "there",
        telegramId: String(chatId),
      }),
      timeout: 5000,
    });
    if (!bidRes.ok) return; // no ad available right now, skip quietly
    const ad = await bidRes.json();
    if (!ad || !ad.image) return;

    // Basic shape check on the third-party response before sending to Telegram
    const buttonUrl = typeof ad.clickUrl === "string" ? ad.clickUrl : null;
    if (!buttonUrl || !/^https?:\/\//i.test(buttonUrl)) return;

    await tgCall("sendPhoto", {
      chat_id: chatId,
      photo: ad.image,
      caption: typeof ad.text === "string" ? ad.text.slice(0, 1024) : "",
      reply_markup: {
        inline_keyboard: [[{ text: (ad.buttonText || "Open").slice(0, 60), url: buttonUrl }]],
      },
    });
  } catch (e) {
    console.error("[TGADS] request failed:", e.message);
  }
}

// ---------------------------------------------------------------------
// NEW: in-chat "Promo Code" quick-create flow for the admin.
//
// /admin now sends TWO buttons instead of one:
//   1) "🎟 Promo Code"     -> starts a step-by-step chat flow right here
//                             (code -> reward -> claim limit) and creates
//                             the promo code directly, no need to open the
//                             web panel.
//   2) "Open Admin Panel"  -> unchanged, opens the exact same full admin
//                             WebApp (admin.html) as before.
//
// This block is purely additive. It writes to the same "promocodes"
// collection, with the exact same document shape and the exact same
// user-broadcast behavior as api/admin/withdraws.js (?resource=promo)'s POST handler — that
// file is left completely untouched, and so is the web admin panel's
// own "Promo" tab. Both ways of creating a promo code keep working.
// ---------------------------------------------------------------------

// chatId -> { step: "code" | "reward" | "limit", code?, reward? }
// In-memory only (same tradeoff as userLastStart above) — fine on a warm
// serverless instance; a cold start mid-flow just drops the flow silently
// and the admin can tap the "Promo Code" button again.
const adminPromoState = new Map();

function isValidPromoCode(code) {
  return typeof code === "string" && /^[A-Z0-9_-]{3,30}$/i.test(code.trim());
}

// Same broadcast text used by api/admin/withdraws.js (?resource=promo) — duplicated here
// (rather than imported) so this file's edit never touches that route.
function buildPromoBroadcastText(code, reward) {
  return (
    `🎉 *Congratulations!* 🎉\n\n` +
    `You have received ${reward} RDC ✅🎁\n\n` +
    `🔴 Redeem Code: "\`${code}\`"\n` +
    `📌 Tap the code to copy it instantly.\n\n` +
    `Don't miss it! 🚀`
  );
}

// Used to just loop over every user and send inline — see the big comment
// above handleResetNotifyCron / in _telegram.js for why that could never
// finish for a 30k-user base within one invocation. Now it only enqueues
// the broadcast (instant) and does one small immediate drain so the
// first page of users gets their message right away without waiting for
// the next cron tick; the rest resumes automatically from there via
// drainBroadcastQueue() inside handleResetNotifyCron.
async function broadcastPromoCodeToUsers(db, code, reward) {
  const text = buildPromoBroadcastText(code, reward);
  await enqueueBroadcast(db, { text, keyboard: EARN_MORE_KEYBOARD });
  const sentSoFar = await drainBroadcastQueue(db, 20000); // small immediate head start
  const totalUsers = await db.collection("users").countDocuments({});
  return { sentSoFar, totalUsers };
}

async function startPromoFlow(chatId) {
  adminPromoState.set(chatId, { step: "code" });
  await tgCall("sendMessage", {
    chat_id: chatId,
    text:
      "🎟 *Create Promo Code*\n\n" +
      "Promo code টা type করে পাঠাও (e.g. REDTUBE50):\n\n" +
      "Cancel করতে চাইলে /cancel লিখো।",
    parse_mode: "Markdown",
  });
}

// Handles one text message that arrives while the admin is mid-flow.
// Returns true if it consumed the message (whether or not it was valid),
// false if the admin has no flow in progress (caller does nothing further).
async function handlePromoFlowMessage(chatId, rawText) {
  const state = adminPromoState.get(chatId);
  if (!state) return false;

  const text = rawText.trim();

  if (text === "/cancel") {
    adminPromoState.delete(chatId);
    await tgCall("sendMessage", { chat_id: chatId, text: "❌ Promo code creation cancelled." });
    return true;
  }

  if (state.step === "code") {
    if (!isValidPromoCode(text)) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Invalid code। শুধু letters/numbers/_/- চলবে, 3-30 characters। আবার try করো (or /cancel):",
      });
      return true;
    }

    const upperCode = text.toUpperCase();
    try {
      const db = await getDb();
      const exists = await db.collection("promocodes").findOne({ code: upperCode });
      if (exists) {
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: `⚠️ "${upperCode}" already আছে। অন্য একটা code দিয়ে আবার try করো (or /cancel):`,
        });
        return true;
      }
    } catch (e) {
      console.error("[ERROR] promo flow code-lookup failed:", e);
      await tgCall("sendMessage", { chat_id: chatId, text: "⚠️ Database error, আবার try করো।" });
      return true;
    }

    state.code = upperCode;
    state.step = "reward";
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: `💰 Code: \`${upperCode}\`\n\nএখন reward কত RDC দিবে সেটা লিখো (number, e.g. 50):`,
      parse_mode: "Markdown",
    });
    return true;
  }

  if (state.step === "reward") {
    const rewardNum = Number(text);
    if (!Number.isFinite(rewardNum) || rewardNum < 0) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Valid একটা number দাও (0 বা তার বেশি)। আবার try করো (or /cancel):",
      });
      return true;
    }

    state.reward = rewardNum;
    state.step = "limit";
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "👥 কত জন claim করতে পারবে সেটা লিখো (max users, e.g. 100):",
    });
    return true;
  }

  if (state.step === "limit") {
    const limitNum = Number(text);
    if (!Number.isFinite(limitNum) || limitNum <= 0 || !Number.isInteger(limitNum)) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Valid একটা whole number দাও (1 বা তার বেশি)। আবার try করো (or /cancel):",
      });
      return true;
    }

    // Clear state before the async DB/broadcast work below so a stray
    // extra message from the admin mid-save can't re-enter this branch.
    const { code, reward } = state;
    adminPromoState.delete(chatId);

    try {
      const db = await getDb();
      const promos = db.collection("promocodes");

      // Re-check right before insert — guards against a race with a code
      // of the same name created via the web admin panel in the meantime.
      const doubleCheck = await promos.findOne({ code });
      if (doubleCheck) {
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: `⚠️ "${code}" already created (possibly from the admin panel) meanwhile — nothing done.`,
        });
        return true;
      }

      await promos.insertOne({
        code,
        reward,
        limit: limitNum,
        usedCount: 0,
        createdAt: new Date(),
      });

      console.log(`[ADMIN] Promo code created via bot chat: ${code}`);

      let sentSoFar = 0;
      let totalUsers = 0;
      try {
        ({ sentSoFar, totalUsers } = await broadcastPromoCodeToUsers(db, code, reward));
      } catch (broadcastErr) {
        console.error("[ERROR] promo flow broadcast failed:", broadcastErr);
      }

      const remaining = Math.max(totalUsers - sentSoFar, 0);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          `✅ *Promo code created!*\n\n` +
          `🎟 Code: \`${code}\`\n` +
          `💰 Reward: ${reward} RDC\n` +
          `👥 Claim limit: ${limitNum}\n` +
          `📢 Sent instantly to ${sentSoFar}/${totalUsers} users` +
          (remaining > 0
            ? `\n⏳ Remaining ${remaining} users will get it automatically over the next little while (queued broadcast).`
            : ``),
        parse_mode: "Markdown",
      });
    } catch (e) {
      console.error("[ERROR] promo flow creation failed:", e);
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Promo code create করতে গিয়ে error হয়েছে। আবার try করো।",
      });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------
// NEW: in-chat "💸 Withdraw" list for the admin.
//
// /admin now sends THREE buttons instead of two:
//   1) "🎟 Promo Code"      -> unchanged (chat flow above)
//   2) "💸 Withdraw"        -> shows the current PENDING withdraws right
//                              here in the chat, each with its own
//                              ✅ Approve / ❌ Reject buttons.
//   3) "Open Admin Panel"   -> unchanged, opens admin.html as before.
//
// Approving/rejecting from here calls the EXACT SAME shared function
// (now living in api/_telegram.js) that the web admin panel's
// api/admin/withdraws.js POST handler calls — so an approve/reject done
// from the bot is the same action as doing it from the web panel: same
// atomic "pending -> processing" claim, same address-lock re-check, same
// payment-proof post, same referral commission, same balance refund on
// reject. It writes to the exact same "withdraws" collection, so the web
// admin panel will show the updated status the moment it's refreshed —
// there's nothing separate to keep "in sync", it's the same data.
// ---------------------------------------------------------------------

const WITHDRAW_PAGE_SIZE = 10;

// Formats a Date as "YYYY-MM-DD HH:MM UTC" — no extra library needed.
function formatWithdrawTime(date) {
  if (!date) return "unknown time";
  const d = new Date(date);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Builds the message text + inline keyboard for one page of pending
// withdraws. Each entry gets its own numbered line (name, UID, amount,
// method, FULL address, time) and its own Approve/Reject button row —
// tagged with that withdraw's _id so a tap only ever acts on that one row.
async function buildWithdrawListView(db, skip) {
  const { list, totalPending } = await listPendingWithdraws(db, { limit: WITHDRAW_PAGE_SIZE, skip });

  if (list.length === 0) {
    const text =
      skip === 0
        ? "💸 *Pending Withdraws*\n\nNo pending withdraws right now. ✅"
        : "💸 *Pending Withdraws*\n\nNo more pending withdraws on this page.";
    return {
      text,
      keyboard: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `admin_withdraw_list:0` }]] },
    };
  }

  const lines = [`💸 *Pending Withdraws* (${totalPending} total pending)\n`];
  const buttonRows = [];

  list.forEach((w, i) => {
    const num = skip + i + 1;
    // ROOT CAUSE FIX: username and address are real, untrusted, free-form
    // text (Telegram usernames commonly contain "_"; TON/crypto addresses
    // commonly contain "_"/"-" from base64url encoding). Dropped in
    // unescaped, a single "_" or "*" or "`" breaks Telegram's legacy
    // "Markdown" entity parser for the WHOLE message — editMessageText/
    // sendMessage then returns { ok: false } from the Telegram API.
    // tgCall() only logs that, it never throws — so nothing here noticed,
    // the list silently never rendered, and the admin saw literally no
    // response when tapping "💸 Withdraw". escapeMarkdown() (now exported
    // from _telegram.js) fixes that; the .ok check added below in
    // sendWithdrawList/refreshWithdrawList makes any future failure like
    // this show up as a visible "⚠️ Failed to load withdraws" toast
    // instead of failing silently again.
    const nameLabel = w.username ? `@${escapeMarkdown(w.username)}` : escapeMarkdown(w.firstName || "Unknown");
    lines.push(
      `*${num}.* ${nameLabel} (UID: \`${w.telegramId}\`)\n` +
        `   💰 $${w.amount} via ${escapeMarkdown(w.method)}\n` +
        `   🏦 \`${escapeMarkdown(w.address)}\`\n` +
        `   🕒 ${formatWithdrawTime(w.createdAt)}`
    );
    buttonRows.push([
      { text: `✅ Approve #${num}`, callback_data: `wd_approve:${w._id}` },
      { text: `❌ Reject #${num}`, callback_data: `wd_reject:${w._id}` },
    ]);
  });

  const navRow = [{ text: "🔄 Refresh", callback_data: `admin_withdraw_list:${skip}` }];
  if (skip + list.length < totalPending) {
    navRow.push({ text: "Next ▶️", callback_data: `admin_withdraw_list:${skip + WITHDRAW_PAGE_SIZE}` });
  }
  if (skip > 0) {
    navRow.unshift({ text: "◀️ Prev", callback_data: `admin_withdraw_list:${Math.max(0, skip - WITHDRAW_PAGE_SIZE)}` });
  }
  buttonRows.push(navRow);

  return { text: lines.join("\n\n"), keyboard: { inline_keyboard: buttonRows } };
}

// Sends a brand-new withdraw-list message (first tap on "💸 Withdraw").
// Returns the raw Telegram API response so the callback_query handler can
// tell a real failure apart from success — tgCall() never throws on a
// Telegram-side error (bad Markdown, etc.), it only logs, so without this
// the caller had no way to know the send didn't actually go through.
async function sendWithdrawList(db, chatId, skip = 0) {
  const { text, keyboard } = await buildWithdrawListView(db, skip);
  return tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", reply_markup: keyboard });
}

// Re-renders an EXISTING withdraw-list message in place — used both for
// the "🔄 Refresh"/"Next"/"Prev" buttons and right after an approve/reject
// action, so the acted-on withdraw simply disappears from the refreshed
// pending list instead of needing any manual bookkeeping of which rows
// are "done".
async function refreshWithdrawList(db, chatId, messageId, skip = 0) {
  const { text, keyboard } = await buildWithdrawListView(db, skip);
  // Same reasoning as sendWithdrawList above — return the raw response so
  // a Telegram-side rejection (which never throws) is still visible to
  // the caller instead of silently doing nothing.
  return tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

module.exports = async (req, res) => {
  // Cron entry point — GET only (Telegram webhooks are always POST, so
  // this can never collide with a real incoming update). See the comment
  // block above handleResetNotifyCron for why this lives here instead of
  // its own /api/cron file.
  if (req.method === "GET" && req.query && req.query.cron === "reset-notify") {
    return handleResetNotifyCron(req, res);
  }

  if (req.method !== "POST") return res.status(200).send("ok");

  // --- Webhook authenticity check ---
  // Telegram sends this header back exactly as configured in setWebhook's secret_token.
  // Without this check, anyone who finds your webhook URL can POST fake bot updates.
  if (WEBHOOK_SECRET) {
    const tokenFromTelegram = req.headers["x-telegram-bot-api-secret-token"];
    if (tokenFromTelegram !== WEBHOOK_SECRET) {
      console.warn("[SECURITY] Webhook request with invalid/missing secret token rejected.");
      return res.status(403).send("forbidden");
    }
  }

  const update = req.body;

  try {
    // Defensive shape checks — malformed/unexpected payloads shouldn't crash the function
    if (
      update &&
      update.message &&
      typeof update.message.text === "string" &&
      update.message.chat &&
      update.message.from
    ) {
      const chatId = update.message.chat.id;
      const text = update.message.text.slice(0, 4096); // Telegram's own max message length
      const fromUser = update.message.from;

      if (text.startsWith("/start")) {
        if (isSpammingStart(chatId)) {
          return res.status(200).send("ok"); // silently ignore rapid repeat /start
        }

        const parts = text.split(" ");
        let refBy = parts[1] ? Number(parts[1]) : null;
        // Validate referral payload — must be a plausible positive Telegram user id
        if (!Number.isFinite(refBy) || !Number.isInteger(refBy) || refBy <= 0) {
          refBy = null;
        }

        const db = await getDb();
        const users = db.collection("users");
        const existing = await users.findOne({ telegramId: chatId });

        if (!existing) {
          // If a referrer id was given, confirm that user actually exists
          // before storing it, so referral rewards can't be farmed with fake ids
          let validRefBy = null;
          if (refBy && refBy !== chatId) {
            const refUser = await users.findOne({ telegramId: refBy });
            if (refUser) validRefBy = refBy;
          }

          await users.insertOne({
            telegramId: chatId,
            username: typeof fromUser.username === "string" ? fromUser.username.slice(0, 64) : null,
            firstName: typeof fromUser.first_name === "string" ? fromUser.first_name.slice(0, 128) : null,
            balance: 0,
            lifetimeEarned: 0,
            adsWatchedToday: 0,
            tasksDoneToday: 0,
            tasksCompleted: 0,
            referralsCount: 0,
            referredBy: validRefBy,
            joined: false,
            createdAt: new Date(),
          });

          // NOTE: referralsCount is intentionally NOT incremented here at
          // signup time. It's incremented exactly once, in api/user.js,
          // only when this referred user actually completes step1
          // (joins BOTH the community and channel) — guarded there by an
          // atomic `step1Rewarded: { $ne: true }` check, so it can never
          // double-fire even across retries. Incrementing it here too
          // (at raw /start time, before any join) used to double-count
          // every referral that went on to complete step1 — that's what
          // caused referralsCount to read higher than the actual number
          // of referred users shown in the admin panel's Show Referrals
          // list.
        }

        const caption =
          "Welcome to REDTUBE!\n\n" +
          "Earn free crypto (RDC → TON/USDT) by watching videos — no investment required! 💰\n\n" +
          "⚠️ Joining our official channel and community is required before you can start.";
        const keyboard = {
          inline_keyboard: [
            [
              { text: "📢 Official Channel", url: CHANNEL_LINK },
              { text: "💬 Community", url: COMMUNITY_LINK },
            ],
            [{ text: "✅ Check & Open App", web_app: { url: WEBAPP_URL } }],
          ],
        };

        if (BANNER_IMAGE_URL) {
          await tgCall("sendPhoto", {
            chat_id: chatId,
            photo: BANNER_IMAGE_URL,
            caption,
            reply_markup: keyboard,
          });
        } else {
          await tgCall("sendMessage", {
            chat_id: chatId,
            text: caption,
            reply_markup: keyboard,
          });
        }

        // Fire-and-forget, doesn't block the reply — errors are caught inside the function itself
        sendTgAdsAd(chatId, fromUser);
      } else if (text === "/admin") {
        // Admin panel access — restricted to a single Telegram account.
        // Anyone else who sends /admin gets silently ignored (no reply at
        // all), so the command's existence isn't even confirmed to them.
        // Two buttons now: "Promo Code" runs the quick-create chat flow
        // defined above, "Open Admin Panel" opens admin.html as a Telegram
        // WebApp exactly as before — that's what api/_telegram.js's
        // checkAdmin() verifies server-side on every admin API call, so
        // the panel simply won't function for anyone else even if they
        // discover/open the admin.html URL directly.
        if (chatId === ADMIN_TELEGRAM_ID && ADMIN_WEBAPP_URL) {
          adminPromoState.delete(chatId); // fresh /admin cancels any half-finished promo flow
          await tgCall("sendMessage", {
            chat_id: chatId,
            text: "🔐 REDTUBE Admin Panel",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🎟 Promo Code", callback_data: "admin_promo_start" }],
                [{ text: "💸 Withdraw", callback_data: "admin_withdraw_list:0" }],
                [{ text: "Open Admin Panel", web_app: { url: ADMIN_WEBAPP_URL } }],
              ],
            },
          });
        }
      } else if (chatId === ADMIN_TELEGRAM_ID) {
        // Only reached for plain text from the admin that isn't /start or
        // /admin — e.g. the code/reward/limit answers typed during the
        // promo-code flow. No-ops (returns false, does nothing) if the
        // admin isn't currently in that flow. Never reached for any other
        // user, so nobody else's messages are affected.
        await handlePromoFlowMessage(chatId, text);
      }
    } else if (update && update.callback_query) {
      // Handles taps on inline buttons: "🎟 Promo Code", "💸 Withdraw"
      // (list/refresh/paginate), and each row's ✅ Approve / ❌ Reject.
      const cq = update.callback_query;
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      const messageId = cq.message && cq.message.message_id;
      const fromId = cq.from && cq.from.id;
      const isAdmin = chatId && fromId === ADMIN_TELEGRAM_ID;
      let ackText = null; // optional short toast shown via answerCallbackQuery

      if (cq.data === "admin_promo_start" && isAdmin) {
        await startPromoFlow(chatId);
      } else if (typeof cq.data === "string" && cq.data.startsWith("admin_withdraw_list") && isAdmin) {
        // "admin_withdraw_list:0" from the /admin button, or
        // "admin_withdraw_list:<skip>" from Refresh/Next/Prev — both just
        // (re)render the list, so the very first tap can go through the
        // same code path as every later refresh/paginate tap.
        const skip = Number(cq.data.split(":")[1]) || 0;
        try {
          const db = await getDb();
          const tgResult = messageId
            ? await refreshWithdrawList(db, chatId, messageId, skip)
            : await sendWithdrawList(db, chatId, skip);
          // tgCall() never throws on a Telegram-side rejection (e.g. bad
          // Markdown from an unescaped "_" in a username/address) — it only
          // logs to the server console and returns { ok: false }. Without
          // this check that failure was invisible: no exception, so the
          // catch block below never ran, and answerCallbackQuery went out
          // with no text — the admin just saw the tap do nothing at all.
          if (!tgResult || tgResult.ok === false) {
            console.error("[TG API ERROR] withdraw list render rejected by Telegram:", tgResult && tgResult.description);
            ackText = "⚠️ Failed to load withdraws, try again.";
          }
        } catch (e) {
          console.error("[ERROR] withdraw list render failed:", e);
          ackText = "⚠️ Failed to load withdraws, try again.";
        }
      } else if (typeof cq.data === "string" && (cq.data.startsWith("wd_approve:") || cq.data.startsWith("wd_reject:")) && isAdmin) {
        const isApprove = cq.data.startsWith("wd_approve:");
        const withdrawId = cq.data.split(":")[1];
        try {
          const db = await getDb();
          const result = isApprove
            ? await approveWithdrawById(db, withdrawId, { ip: `bot:${fromId}`, source: "bot" })
            : await rejectWithdrawById(db, withdrawId, { ip: `bot:${fromId}`, source: "bot" });

          if (!result.ok) {
            // Most common case: someone (web panel or a second bot tap)
            // already approved/rejected this exact withdraw a moment
            // earlier — that's not an error, just stale buttons.
            ackText = result.error === "already processed" ? "Already processed." : `⚠️ ${result.error}`;
          } else {
            ackText = isApprove ? "✅ Approved!" : "❌ Rejected — balance refunded.";
          }

          // Re-render the list either way, so the acted-on row (or the
          // now-stale row, if it was already handled elsewhere) simply
          // disappears from the refreshed pending list. The approve/reject
          // itself already succeeded at this point (ackText above reflects
          // that) — this re-render failing is a lesser, separate problem,
          // so it only downgrades ackText if it wasn't already a success
          // message, never overwrites a real approve/reject error.
          if (messageId) {
            const tgResult = await refreshWithdrawList(db, chatId, messageId, 0);
            if ((!tgResult || tgResult.ok === false) && result.ok) {
              console.error("[TG API ERROR] withdraw list re-render rejected by Telegram:", tgResult && tgResult.description);
              ackText += " (list refresh failed, reopen 💸 Withdraw to see it)";
            }
          }
        } catch (e) {
          console.error("[ERROR] withdraw approve/reject via bot failed:", e);
          ackText = "⚠️ Something went wrong, please try again.";
        }
      }

      // Always ack the callback so Telegram clears the button's loading
      // spinner, even for taps that didn't match anything above — with a
      // short toast (show_alert stays false, so it's the quick top-of-
      // screen kind) whenever one of the branches above set ackText.
      if (cq.id) {
        await tgCall("answerCallbackQuery", {
          callback_query_id: cq.id,
          ...(ackText ? { text: ackText } : {}),
        });
      }
    }
  } catch (e) {
    console.error("[ERROR] bot.js:", e);
  }

  // Always return 200 to Telegram, even on internal error — otherwise Telegram
  // will keep retrying the same update repeatedly
  return res.status(200).send("ok");
};

// The in-chat /admin "Promo Code" flow's broadcast (broadcastPromoCodeToUsers
// above) can take longer than Vercel's default function timeout (10s on
// Hobby) for a large user base — same reasoning as api/admin/withdraws.js (?resource=promo) and
// api/cron/reset-notify.js. Raised here too so a big broadcast triggered
// from the bot chat doesn't get killed mid-send.
module.exports.config = { maxDuration: 60 };
