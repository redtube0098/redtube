const { getDb } = require("./_db");
const { isMember, tgCall } = require("./_telegram");
const { getClientIp } = require("./_utils");
const CHANNEL_1 = "@redtubecommunity";
const CHANNEL_2 = "@redtubeofficial00";
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
module.exports = async (req, res) => {
  const db = await getDb();
  const users = db.collection("users");
  if (req.method === "GET") {
    const uid = Number(req.query.uid);
    if (!uid) return res.status(400).json({ error: "uid required" });
    let user = await users.findOne({ telegramId: uid });
    if (!user) return res.status(404).json({ error: "not found" });
    return res.status(200).json({
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      balance: user.balance,
      lifetimeEarned: user.lifetimeEarned,
      adsWatchedToday: user.adsWatchedToday,
      tasksDoneToday: user.tasksDoneToday,
      referralsCount: user.referralsCount || 0,
      joined: user.joined || false,
      tasksCompleted: user.tasksCompleted || 0,
    });
  }
  if (req.method === "POST") {
    const { uid, username, firstName, action, refBy } = req.body;
    if (!uid) return res.status(400).json({ error: "uid required" });
    const ip = getClientIp(req);
    let user = await users.findOne({ telegramId: uid });
    if (!user) {
      const newUser = {
        telegramId: uid,
        username: username || null,
        firstName: firstName || null,
        balance: 0,
        lifetimeEarned: 0,
        adsWatchedToday: 0,
        tasksDoneToday: 0,
        tasksCompleted: 0,
        referralsCount: 0,
        referredBy: refBy || null,
        joined: false,
        lastIp: ip,
        createdAt: new Date(),
      };
      await users.insertOne(newUser);
      user = newUser;
      if (ADMIN_ID) {
        const refText = refBy ? `\nReferred by: ${refBy}` : "";
        tgCall("sendMessage", {
          chat_id: ADMIN_ID,
          text: `🆕 New user joined REDTUBE!\nUID: ${uid}\nUsername: @${username || "none"}\nName: ${firstName || "unknown"}${refText}`,
        }).catch((e) => console.error("Admin notify failed:", e));
      }
    } else {
      await users.updateOne({ telegramId: uid }, { $set: { lastIp: ip } });
    }
    if (action === "check_join") {
      const m1 = await isMember(CHANNEL_1, uid);
      const m2 = await isMember(CHANNEL_2, uid);
      const bothJoined = m1 && m2;
      if (bothJoined && !user.joined) {
        await users.updateOne({ telegramId: uid }, { $set: { joined: true } });
        if (user.referredBy && !user.step1Rewarded) {
          await users.updateOne(
            { telegramId: user.referredBy },
            { $inc: { balance: 30, lifetimeEarned: 30, referralsCount: 1 } }
          );
          await users.updateOne({ telegramId: uid }, { $set: { step1Rewarded: true } });
        }
      }
      return res.status(200).json({ joined: bothJoined });
    }
    return res.status(200).json({ joined: user.joined });
  }
  return res.status(405).end();
};
