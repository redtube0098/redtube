const { getDb } = require("./_db");
const { tgCall } = require("./_telegram");
const WEBAPP_URL = process.env.WEBAPP_URL;
const BANNER_IMAGE_URL = process.env.BANNER_IMAGE_URL; // set this in Vercel env vars
const CHANNEL_LINK = "https://t.me/redtubecommunity";
const COMMUNITY_LINK = "https://t.me/redtubeofficial0";

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
      }
    }
  } catch (e) {
    console.error(e);
  }
  return res.status(200).send("ok");
};
