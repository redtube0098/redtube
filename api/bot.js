const { getDb } = require("./_db");
const { tgCall } = require("./_telegram");
const fetch = require("node-fetch");
const WEBAPP_URL = process.env.WEBAPP_URL;
const TGADS_WID = process.env.TGADS_WID; // widget ID from tgads.live dashboard
const BANNER_IMAGE_URL = "https://i.postimg.cc/xTnSxLWs/04be4b98-8bdc-4c8a-b52e-c5d30338fe3c.png"; // banner image 
const CHANNEL_LINK = "https://t.me/redtubecommunity";
const COMMUNITY_LINK = "https://t.me/redtubeofficial0";

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

    await tgCall("sendPhoto", {
      chat_id: chatId,
      photo: ad.image,
      caption: ad.text || "",
      reply_markup: {
        inline_keyboard: [[{ text: ad.buttonText || "Open", url: ad.clickUrl }]],
      },
    });
  } catch (e) {
    console.error("TGAds request failed:", e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const update = req.body;
  try {
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text;
      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const refBy = parts[1] ? Number(parts[1]) : null;
        const db = await getDb();
        const users = db.collection("users");
        const existing = await users.findOne({ telegramId: chatId });
        if (!existing) {
          await users.insertOne({
            telegramId: chatId,
            username: update.message.from.username || null,
            firstName: update.message.from.first_name || null,
            balance: 0,
            lifetimeEarned: 0,
            adsWatchedToday: 0,
            tasksDoneToday: 0,
            tasksCompleted: 0,
            referralsCount: 0,
            referredBy: refBy && refBy !== chatId ? refBy : null,
            joined: false,
            createdAt: new Date(),
          });
        }
        const caption =
          "Welcome to REDTUBE!\n\n" +
          "Earn free crypto (WTC → TON/USDT) by watching videos — no investment required! 💰\n\n" +
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

        // Send one TGAds ad right after the welcome message (fire-and-forget, doesn't block the reply)
        sendTgAdsAd(chatId, update.message.from);
      }
    }
  } catch (e) {
    console.error(e);
  }
  return res.status(200).send("ok");
};
