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

    const cleanTexts = (texts || []).slice(0, 2).map((t) => String(t || "").slice(0, 500));
    const cleanShots = (screenshots || []).slice(0, 2).filter((s) => typeof s === "string" && s.startsWith("data:image/"));

    const requiredTextFields = (task.textFields || []).length;
    const requiredShots = task.screenshotCount || 0;
    if (requiredTextFields > 0 && cleanTexts.filter(Boolean).length < requiredTextFields) {
      return res.status(400).json({ error: "Please fill in all required fields" });
    }
    if (requiredShots > 0 && cleanShots.length < requiredShots) {
      return res.status(400).json({ error: "Please attach all required screenshots" });
    }
    // Guard against oversized documents (each compressed screenshot should be well under this)
    const totalSize = cleanShots.reduce((sum, s) => sum + s.length, 0);
    if (totalSize > 3_500_000) {
      return res.status(400).json({ error: "Screenshots too large, please retry with smaller images" });
    }

    await submissions.insertOne({
      telegramId: uid,
      taskId: task._id,
      taskTitle: task.title,
      reward: task.reward,
      texts: cleanTexts,
      screenshots: cleanShots, // compressed data:image/jpeg;base64 strings from the client
      status: "pending",
      createdAt: new Date(),
    });

    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
};
