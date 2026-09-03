const { getDb } = require("../_db");
const { checkAdmin, maybeRewardStep2Task, notifyIfValidReferral } = require("../_telegram");
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
      // --- COMPREHENSIVE ONE-TIME BACKFILL for "valid referral" counting.
      // Fixes TWO overlapping gaps that could each leave validReferralsCount
      // stuck at 0 for a referrer even though their referred users actually
      // qualify:
      //
      //  (a) step2Rewarded (10 combined tasks) never got set for a referred
      //      user, e.g. because it was only checked via the regular-task
      //      auto-approve/manual-approve paths and that user's progress
      //      came from special tasks, or from before maybeRewardStep2Task
      //      was wired up correctly everywhere it needed to be.
      //
      //  (b) step1Rewarded / step2Rewarded / step3Rewarded are ALL already
      //      true for a referred user, but notifyIfValidReferral() never
      //      actually ran for them (e.g. it was only ever triggered from a
      //      code path that had a bug at the time, or the user simply never
      //      triggered a call site again after the last flag flipped true).
      //
      // Pass 1 handles (a): re-check step2 for anyone missing it, using the
      // exact same combined regular+special count as the live reward path.
      // Pass 2 handles (b): directly re-run notifyIfValidReferral for every
      // referred user who has all 3 flags true but hasn't been notified/
      // counted yet — this is the safety net that catches everyone, even if
      // pass 1 wasn't needed for them.
      //
      // Both passes are fully idempotent (notifyIfValidReferral atomically
      // claims validReferralNotified before paying out), so this endpoint
      // is always safe to re-run — already-rewarded users are untouched.
      //
      //   POST /api/admin/tasks   body: { action: "backfill_referrals" }
      if (req.body?.action === "backfill_referrals") {
        // Pass 1: catch up missing step2Rewarded
        const step2Candidates = await users
          .find({ referredBy: { $ne: null, $exists: true }, step2Rewarded: { $ne: true } })
          .project({ telegramId: 1 })
          .toArray();

        let step2Checked = 0;
        for (const c of step2Candidates) {
          await maybeRewardStep2Task(db, users, c.telegramId);
          step2Checked++;
        }

        // Pass 2: catch anyone with all 3 flags already true but never
        // actually notified/counted — re-fetch fresh docs since pass 1 may
        // have just flipped some of these to true.
        const validCandidates = await users
          .find({
            referredBy: { $ne: null, $exists: true },
            step1Rewarded: true,
            step2Rewarded: true,
            step3Rewarded: true,
            validReferralNotified: { $ne: true },
          })
          .project({ telegramId: 1 })
          .toArray();

        let validNotified = 0;
        for (const c of validCandidates) {
          const freshDoc = await users.findOne({ telegramId: c.telegramId });
          const before = freshDoc.validReferralNotified;
          await notifyIfValidReferral(users, freshDoc);
          if (!before) {
            const after = await users.findOne({ telegramId: c.telegramId }, { projection: { validReferralNotified: 1 } });
            if (after && after.validReferralNotified) validNotified++;
          }
        }

        console.log(
          `[ADMIN] Backfill referrals completed — step2 checked: ${step2Checked}, valid-referral notified: ${validNotified} — by IP ${ip}`
        );
        return res.status(200).json({ success: true, step2Checked, validNotified });
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
          // processedAt is what the TTL index in api/_db.js
          // (task_submissions_rejected_ttl) keys off of — this is what
          // makes a rejected submission auto-delete 30 days from now.
          // Never set on "approved", so approved submissions (needed
          // forever for the lifetime task count) are never touched by it.
          await submissions.updateOne(
            { _id: sub._id },
            { $set: { status: "rejected", processedAt: new Date() } }
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
