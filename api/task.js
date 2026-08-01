// api/task.js
const { getDb } = require("./_db");
const { ObjectId } = require("mongodb");
const { verifyInitData } = require("./_verifyInitData");

function isValidObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

module.exports = async (req, res) => {
  try {
    // --- Verify request genuinely came from Telegram, for a real user ---
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    const uid = verifiedUser.id; // never trust client-supplied uid anymore

    const db = await getDb();
    const tasks = db.collection("tasks");
    const submissions = db.collection("task_submissions");

    if (req.method === "GET") {
      const activeTasks = await tasks.find({ active: true }).sort({ createdAt: -1 }).limit(200).toArray();
      return res.status(200).json(
        activeTasks.map((t) => ({
          id: t._id,
          title: t.title,
          description: t.description || "",
          reward: t.reward,
          textFields: t.textFields || [],
          screenshotFields: t.screenshotCount || 0,
        }))
      );
    }

    if (req.method === "POST") {
      const { taskId, texts, screenshots } = req.body || {};

      if (!isValidObjectId(taskId)) {
        return res.status(400).json({ error: "invalid taskId" });
      }

      // Validate texts/screenshots shape before touching DB
      const safeTexts = Array.isArray(texts)
        ? texts.slice(0, 2).map((t) => (typeof t === "string" ? t.slice(0, 500) : ""))
        : [];
      const safeScreenshots = Array.isArray(screenshots)
        ? screenshots.slice(0, 2).map((s) => (typeof s === "string" ? s.slice(0, 2000) : ""))
        : [];

      const task = await tasks.findOne({ _id: new ObjectId(taskId), active: true });
      if (!task) return res.status(404).json({ error: "task not found" });

      // Require the fields the task actually asks for — stops empty/junk submissions
      // from farming pending approvals
      if (task.textFields?.length && safeTexts.filter(Boolean).length < task.textFields.length) {
        return res.status(400).json({ error: "missing required text fields" });
      }
      if (task.screenshotCount && safeScreenshots.filter(Boolean).length < task.screenshotCount) {
        return res.status(400).json({ error: "missing required screenshots" });
      }

      // Atomic duplicate-submission guard: insert a placeholder-safe check + insert
      // close together to shrink the race window between two rapid duplicate submits
      const already = await submissions.findOne({
        telegramId: uid,
        taskId: task._id,
        status: { $in: ["pending", "approved"] },
      });
      if (already) return res.status(400).json({ error: "already submitted" });

      await submissions.insertOne({
        telegramId: uid,
        taskId: task._id,
        taskTitle: task.title,
        reward: task.reward,
        texts: safeTexts,
        screenshots: safeScreenshots,
        status: "pending",
        createdAt: new Date(),
      });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] task.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
