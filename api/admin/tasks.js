const { getDb } = require("../_db");
const { checkAdmin, maybeRewardStep2Task } = require("../_telegram");
const { ObjectId } = require("mongodb");

const requestLog = new Map();
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    requestLog.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count++;
  requestLog.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

function isValidObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

module.exports = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    if (!checkAdmin(req)) {
      console.warn(`[SECURITY] Unauthorized admin/tasks access from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const tasks = db.collection("tasks");
    const submissions = db.collection("task_submissions");
    const users = db.collection("users");
    const specialTasks = db.collection("special_tasks");

    if (req.method === "GET") {
      if (req.query.special === "1") {
        const list = await specialTasks.find({}).sort({ createdAt: -1 }).limit(500).toArray();
        return res.status(200).json(list);
      }
      if (req.query.submissions === "1") {
        const allowedStatuses = ["pending", "approved", "rejected"];
        const filter =
          req.query.status && allowedStatuses.includes(req.query.status)
            ? { status: req.query.status }
            : {};
        const list = await submissions
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray();
        return res.status(200).json(list);
      }
      const list = await tasks.find({}).sort({ createdAt: -1 }).limit(500).toArray();
      return res.status(200).json(list);
    }

    if (req.method === "POST") {
      // --- ONE-TIME BACKFILL: catches every existing referred user who
      // already had combined (regular + special) task completions >= 10
      // BEFORE the referral tier-2 counting bug was fixed, and pays their
      // referrer the missed +60 (plus fires the "valid referral"
      // notification if tiers 1+3 are also already done). Folded into this
      // existing endpoint (instead of a new file) to avoid using up another
      // serverless function slot. Safe to call more than once —
      // maybeRewardStep2Task() atomically checks/claims step2Rewarded
      // before paying out, so re-running this is a harmless no-op for
      // anyone already rewarded. Trigger with:
      //   POST /api/admin/tasks   body: { action: "backfill_referrals" }
      if (req.body?.action === "backfill_referrals") {
        const candidates = await users
          .find({ referredBy: { $ne: null, $exists: true }, step2Rewarded: { $ne: true } })
          .project({ telegramId: 1 })
          .toArray();

        let checked = 0;
        for (const c of candidates) {
          await maybeRewardStep2Task(db, users, c.telegramId);
          checked++;
        }

        console.log(`[ADMIN] Backfill referral tier-2 completed — checked ${checked} candidates by IP ${ip}`);
        return res.status(200).json({ success: true, checked });
      }

      // --- Approve/Reject submission ---
      if (req.body?.submissionId) {
        const { submissionId, action } = req.body;

        if (!isValidObjectId(submissionId)) {
          return res.status(400).json({ error: "invalid submissionId" });
        }
        if (!["approve", "reject"].includes(action)) {
          return res.status(400).json({ error: "invalid action" });
        }

        const sub = await submissions.findOne({ _id: new ObjectId(submissionId) });
        if (!sub) return res.status(404).json({ error: "not found" });
        if (sub.status !== "pending") {
          return res.status(400).json({ error: "already processed" });
        }

        if (action === "approve") {
          // Guard against corrupted/negative reward data
          const reward = Number(sub.reward);
          if (!Number.isFinite(reward) || reward < 0) {
            console.error(`[DATA ERROR] Invalid reward on submission ${sub._id}`);
            return res.status(400).json({ error: "invalid reward on submission" });
          }

          await users.updateOne(
            { telegramId: sub.telegramId },
            {
              $inc: {
                balance: reward,
                lifetimeEarned: reward,
                tasksCompleted: 1,
                tasksDoneToday: 1,
              },
            }
          );
          await submissions.updateOne(
            { _id: sub._id },
            { $set: { status: "approved" } }
          );

          // Referral Tier 2: friend completes 10 tasks TOTAL, counting
          // regular + special tasks together -> referrer gets +60.
          // Shared helper — see api/_telegram.js for the combined-count
          // logic and the multi-account device guard (unchanged behavior).
          await maybeRewardStep2Task(db, users, sub.telegramId);
        } else {
          await submissions.updateOne(
            { _id: sub._id },
            { $set: { status: "rejected" } }
          );
        }

        console.log(`[ADMIN] Submission ${submissionId} ${action}d by IP ${ip}`);
        return res.status(200).json({ success: true });
      }

      // --- Create new SPECIAL task (channel/group join) ---
      if (req.body?.taskType === "special") {
        const { title, description, reward, link, chatId, verificationType } = req.body;

        if (!title || typeof title !== "string" || !title.trim()) {
          return res.status(400).json({ error: "missing or invalid title" });
        }
        const rewardNum = Number(reward);
        if (!Number.isFinite(rewardNum) || rewardNum < 0) {
          return res.status(400).json({ error: "invalid reward value" });
        }
        if (!link || typeof link !== "string" || !link.trim()) {
          return res.status(400).json({ error: "link is required" });
        }
        if (!["verified", "normal"].includes(verificationType)) {
          return res.status(400).json({ error: "verificationType must be 'verified' or 'normal'" });
        }
        if (verificationType === "verified" && (!chatId || typeof chatId !== "string" || !chatId.trim())) {
          return res.status(400).json({ error: "chatId is required for verified tasks (e.g. @channelusername or -100...)" });
        }

        await specialTasks.insertOne({
          title: title.trim().slice(0, 200),
          description: typeof description === "string" ? description.slice(0, 2000) : "",
          reward: rewardNum,
          link: link.trim().slice(0, 500),
          chatId: verificationType === "verified" ? chatId.trim().slice(0, 200) : null,
          verificationType,
          active: true,
          createdAt: new Date(),
        });

        console.log(`[ADMIN] Special task created: "${title}" (${verificationType}) by IP ${ip}`);
        return res.status(200).json({ success: true });
      }

      // --- Create new task ---
      // NOTE: link + code were added here — previously this destructure and
      // the insertOne() below silently dropped both fields even though the
      // admin panel form sent them, so tasks always saved with no link and
      // no auto-approve code no matter what the admin typed.
      const { title, description, reward, textFields, screenshotCount, link, code } = req.body || {};

      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "missing or invalid title" });
      }
      if (reward === undefined) {
        return res.status(400).json({ error: "missing fields" });
      }

      const rewardNum = Number(reward);
      if (!Number.isFinite(rewardNum) || rewardNum < 0) {
        return res.status(400).json({ error: "invalid reward value" });
      }

      // Sanitize textFields — cap length and count, avoid huge payload injection
      const safeTextFields = Array.isArray(textFields)
        ? textFields
            .slice(0, 2)
            .map((f) => (typeof f === "string" ? f.slice(0, 200) : ""))
        : [];

      await tasks.insertOne({
        title: title.trim().slice(0, 200),
        description: typeof description === "string" ? description.slice(0, 2000) : "",
        reward: rewardNum,
        textFields: safeTextFields,
        screenshotCount: Math.min(Math.max(Number(screenshotCount) || 0, 0), 2),
        link: typeof link === "string" ? link.trim().slice(0, 500) : "",
        code: typeof code === "string" ? code.trim().slice(0, 200) : "",
        active: true,
        createdAt: new Date(),
      });

      console.log(`[ADMIN] Task created: "${title}" by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { id, taskType } = req.body || {};
      if (!isValidObjectId(id)) {
        return res.status(400).json({ error: "invalid id" });
      }
      const collection = taskType === "special" ? specialTasks : tasks;
      const result = await collection.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "task not found" });
      }
      console.log(`[ADMIN] ${taskType === "special" ? "Special task" : "Task"} ${id} deleted by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] tasks.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
