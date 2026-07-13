const { getDb } = require("./_db");
const { tgCall } = require("./_telegram");
const WEBAPP_URL = process.env.WEBAPP_URL;
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
        await tgCall("sendMessage", {
          chat_id: chatId,
          text: "Welcome to REDTUBE! Tap below to start earning.",
          reply_markup: {
            inline_keyboard: [[{ text: "🚀 Open REDTUBE", web_app: { url: WEBAPP_URL } }]],
          },
        });
      }
    }
  } catch (e) {
    console.error(e);
  }
  return res.status(200).send("ok");
};