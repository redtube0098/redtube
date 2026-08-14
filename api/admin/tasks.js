const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");
const { isSameDevice } = require("../_utils");
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

          // Referral Tier 2: friend completes 10 tasks (lifetime) -> referrer gets +60
          const updatedUser = await users.findOne({ telegramId: sub.telegramId });
          if (
            updatedUser &&
            updatedUser.referredBy &&
            !updatedUser.step2Rewarded &&
            (updatedUser.tasksCompleted || 0) >= 10
          ) {
            // MULTI-ACCOUNT GUARD: if the referred account shares the same
            // device/IP as the referrer, skip paying out this milestone
            // bonus — it's the same person farming their own referral link
            // with a second account on the same device. The referral was
            // already counted once at step 1 (join); this only affects the
            // RDC payout, not the count. Referrals from a different device
            // are paid out exactly as before.
            const referrerUser = await users.findOne({ telegramId: updatedUser.referredBy });
            const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, updatedUser.lastIp);

            if (!sameDeviceAsReferrer) {
              await users.updateOne(
                { telegramId: updatedUser.referredBy },
                { $inc: { balance: 60, lifetimeEarned: 60, referralEarnings: 60 } }
              );
            }
            await users.updateOne(
              { telegramId: sub.telegramId },
              { $set: { step2Rewarded: true } }
            );
          }
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
