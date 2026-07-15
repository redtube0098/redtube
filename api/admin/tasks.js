const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");
const { ObjectId } = require("mongodb");
module.exports = async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = await getDb();
  const tasks = db.collection("tasks");
  const submissions = db.collection("task_submissions");
  if (req.method === "GET") {
    if (req.query.submissions === "1") {
      const filter = req.query.status ? { status: req.query.status } : {};
      const list = await submissions.find(filter).sort({ createdAt: -1 }).toArray();
      return res.status(200).json(list);
    }
    const list = await tasks.find({}).sort({ createdAt: -1 }).toArray();
    return res.status(200).json(list);
  }
  if (req.method === "POST") {
    if (req.body.submissionId) {
      const { submissionId, action } = req.body;
      const sub = await submissions.findOne({ _id: new ObjectId(submissionId) });
      if (!sub) return res.status(404).json({ error: "not found" });
      if (sub.status !== "pending") return res.status(400).json({ error: "already processed" });
      if (action === "approve") {
        const users = db.collection("users");
        await users.updateOne(
          { telegramId: sub.telegramId },
          { $inc: { balance: sub.reward, lifetimeEarned: sub.reward, tasksCompleted: 1, tasksDoneToday: 1 } }
        );
        await submissions.updateOne({ _id: sub._id }, { $set: { status: "approved" } });
        // Referral Tier 2: friend completes 10 tasks (lifetime) -> referrer gets +60
        const updatedUser = await users.findOne({ telegramId: sub.telegramId });
        if (
          updatedUser &&
          updatedUser.referredBy &&
          !updatedUser.step2Rewarded &&
          (updatedUser.tasksCompleted || 0) >= 10
        ) {
          await users.updateOne(
            { telegramId: updatedUser.referredBy },
            { $inc: { balance: 60, lifetimeEarned: 60, referralEarnings: 60 } }
          );
          await users.updateOne({ telegramId: sub.telegramId }, { $set: { step2Rewarded: true } });
        }
      } else {
        await submissions.updateOne({ _id: sub._id }, { $set: { status: "rejected" } });
      }
      return res.status(200).json({ success: true });
    }
    const { title, description, reward, textFields, screenshotCount } = req.body;
    if (!title || reward === undefined) return res.status(400).json({ error: "missing fields" });
    await tasks.insertOne({
      title,
      description: description || "",
      reward: Number(reward),
      textFields: (textFields || []).slice(0, 2),
      screenshotCount: Math.min(Number(screenshotCount) || 0, 2),
      active: true,
      createdAt: new Date(),
    });
    return res.status(200).json({ success: true });
  }
  if (req.method === "DELETE") {
    const { id } = req.body;
    await tasks.deleteOne({ _id: new ObjectId(id) });
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
};
