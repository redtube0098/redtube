const { getDb } = require("./_db");
const { tgCall } = require("./_telegram");
const fetch = require("node-fetch");

const WEBAPP_URL = process.env.WEBAPP_URL;
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
      }
    }
  } catch (e) {
    console.error("[ERROR] bot.js:", e);
  }

  // Always return 200 to Telegram, even on internal error — otherwise Telegram
  // will keep retrying the same update repeatedly
  return res.status(200).send("ok");
};
