// api/task.js
const { getDb } = require("./_db");
const { ObjectId } = require("mongodb");

module.exports = async (req, res) => {
  const db = await getDb();
  const tasks = db.collection("tasks");
  const submissions = db.collection("task_submissions");

  if (req.method === "GET") {
    // Active tasks only, for the frontend
    const activeTasks = await tasks.find({ active: true }).sort({ createdAt: -1 }).toArray();
    return res.status(200).json(
      activeTasks.map((t) => ({
        id: t._id,
        title: t.title,
        description: t.description || "",
        reward: t.reward,
        textFields: t.textFields || [], // array of labels, max 2
        screenshotFields: t.screenshotCount || 0, // number of screenshot uploads, max 2
      }))
    );
  }

  if (req.method === "POST") {
    // User submits proof for a task
    const { uid, taskId, texts, screenshots } = req.body;
    if (!uid || !taskId) return res.status(400).json({ error: "missing fields" });

    const task = await tasks.findOne({ _id: new ObjectId(taskId), active: true });
    if (!task) return res.status(404).json({ error: "task not found" });

    const already = await submissions.findOne({ telegramId: uid, taskId: task._id, status: { $in: ["pending", "approved"] } });
    if (already) return res.status(400).json({ error: "already submitted" });

    await submissions.insertOne({
      telegramId: uid,
      taskId: task._id,
      taskTitle: task.title,
      reward: task.reward,
      texts: (texts || []).slice(0, 2),      // base64/urls handled client-side upload, stored as text/link here
      screenshots: (screenshots || []).slice(0, 2), // expects URLs (uploaded elsewhere) or base64 strings
      status: "pending",
      createdAt: new Date(),
    });

    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
};
