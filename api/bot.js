const { getDb } = require("./_db");
const { tgCall, sendMessage, ADMIN_TELEGRAM_ID } = require("./_telegram");
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
// user-broadcast behavior as api/admin/promo.js's POST handler — that
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

// Same broadcast text/logic used by api/admin/promo.js — duplicated here
// (rather than imported) so this file's edit never touches that route.
const PROMO_BROADCAST_BATCH_SIZE = 25;
const PROMO_BROADCAST_BATCH_DELAY_MS = 1000;

function buildPromoBroadcastText(code, reward) {
  return (
    `🎉 *Congratulations!* 🎉\n\n` +
    `You have received ${reward} RDC ✅🎁\n\n` +
    `🔴 Redeem Code: "\`${code}\`"\n` +
    `📌 Tap the code to copy it instantly.\n\n` +
    `Don't miss it! 🚀`
  );
}

async function broadcastPromoCodeToUsers(db, code, reward) {
  const users = db.collection("users");
  const allUsers = await users.find({}, { projection: { telegramId: 1 } }).toArray();
  const text = buildPromoBroadcastText(code, reward);

  for (let i = 0; i < allUsers.length; i += PROMO_BROADCAST_BATCH_SIZE) {
    const batch = allUsers.slice(i, i + PROMO_BROADCAST_BATCH_SIZE);
    await Promise.all(batch.map((u) => sendMessage(u.telegramId, text)));
    if (i + PROMO_BROADCAST_BATCH_SIZE < allUsers.length) {
      await new Promise((resolve) => setTimeout(resolve, PROMO_BROADCAST_BATCH_DELAY_MS));
    }
  }
  return allUsers.length;
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

      let notified = 0;
      try {
        notified = await broadcastPromoCodeToUsers(db, code, reward);
      } catch (broadcastErr) {
        console.error("[ERROR] promo flow broadcast failed:", broadcastErr);
      }

      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          `✅ *Promo code created!*\n\n` +
          `🎟 Code: \`${code}\`\n` +
          `💰 Reward: ${reward} RDC\n` +
          `👥 Claim limit: ${limitNum}\n` +
          `📢 Notified: ${notified} users`,
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

module.exports = async (req, res) => {
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

          // Keep referrer's count in sync at signup time
          if (validRefBy) {
            await users.updateOne(
              { telegramId: validRefBy },
              { $inc: { referralsCount: 1 } }
            );
          }
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
      // Handles taps on inline buttons — currently only "🎟 Promo Code".
      const cq = update.callback_query;
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      const fromId = cq.from && cq.from.id;

      if (cq.data === "admin_promo_start" && chatId && fromId === ADMIN_TELEGRAM_ID) {
        await startPromoFlow(chatId);
      }

      // Always ack the callback so Telegram clears the button's loading spinner,
      // even for taps that didn't match anything above.
      if (cq.id) {
        await tgCall("answerCallbackQuery", { callback_query_id: cq.id });
      }
    }
  } catch (e) {
    console.error("[ERROR] bot.js:", e);
  }

  // Always return 200 to Telegram, even on internal error — otherwise Telegram
  // will keep retrying the same update repeatedly
  return res.status(200).send("ok");
};
