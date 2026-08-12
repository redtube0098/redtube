// api/task.js
const { getDb } = require("./_db");
const { ObjectId } = require("mongodb");
const { verifyInitData } = require("./_verifyInitData");
const { isMember, notifyIfValidReferral } = require("./_telegram");
const { isSameDevice } = require("./_utils");

function isValidObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

// MongoDB driver v6+ made findOneAndUpdate() return the document directly
// instead of the old { value: doc } wrapper. This works with either.
function extractDoc(result) {
  if (result && typeof result === "object" && "value" in result) {
    return result.value;
  }
  return result;
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
    const users = db.collection("users");
    const specialTasks = db.collection("special_tasks");

    if (req.method === "GET") {
      // --- Special Tasks (channel/group join — Verified or Normal type) ---
      if (req.query && req.query.type === "special") {
        const activeSpecial = await specialTasks
          .find({ active: true })
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();
        const user = await users.findOne({ telegramId: uid });
        const done = (user && user.specialTasksDone) || {};
        return res.status(200).json(
          activeSpecial.map((t) => ({
            id: t._id,
            title: t.title,
            description: t.description || "",
            reward: t.reward,
            link: t.link,
            verificationType: t.verificationType, // "verified" | "normal"
            completed: !!done[t._id.toString()],
          }))
        );
      }

      // --- Regular tasks ---
      // link is optional and shown next to the title on the user side.
      // hasCode is a boolean only — the actual code is never sent to the
      // client, so it can't be read out of the network tab and guessed.
      const activeTasks = await tasks.find({ active: true }).sort({ createdAt: -1 }).limit(200).toArray();
      return res.status(200).json(
        activeTasks.map((t) => ({
          id: t._id,
          title: t.title,
          description: t.description || "",
          reward: t.reward,
          textFields: t.textFields || [],
          screenshotFields: t.screenshotCount || 0,
          link: t.link || null,
          hasCode: !!t.code,
        }))
      );
    }
    if (req.method === "POST") {
      // --- Special Task claim (Verified: real membership check; Normal:
      // no check, client just waits 5s then calls this) ---
      if (req.body && req.body.action === "completeSpecialTask") {
        const { taskId } = req.body;
        if (!isValidObjectId(taskId)) {
          return res.status(400).json({ error: "invalid taskId" });
        }
        const task = await specialTasks.findOne({ _id: new ObjectId(taskId), active: true });
        if (!task) return res.status(404).json({ error: "task not found" });

        if (task.verificationType === "verified") {
          if (!task.chatId) {
            console.error("[task.js] special task missing chatId:", task._id);
            return res.status(500).json({ error: "misconfigured task" });
          }
          const member = await isMember(task.chatId, uid);
          if (!member) {
            return res.status(400).json({ error: "not_member" });
          }
        }

        // Atomic claim — the filter re-checks "not already done" at the
        // moment of the write, so two rapid clicks (or two tabs) can never
        // both grant the reward for the same task.
        const claimed = await users.findOneAndUpdate(
          { telegramId: uid, [`specialTasksDone.${taskId}`]: { $ne: true } },
          {
            $set: { [`specialTasksDone.${taskId}`]: true },
            $inc: { balance: task.reward, lifetimeEarned: task.reward },
          },
          { returnDocument: "after" }
        );
        const updatedUser = extractDoc(claimed);
        if (!updatedUser) {
          return res.status(400).json({ error: "already_completed" });
        }
        return res.status(200).json({ success: true, reward: task.reward, balance: updatedUser.balance });
      }

      // --- Regular task submission ---
      const { taskId, texts, screenshots, code: submittedCode } = req.body || {};
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

      // If this task has an auto-approve code set, and what the user typed
      // matches it exactly (after trimming), skip the manual review queue
      // entirely — reward is credited right here instead of waiting for an
      // admin to approve it from the Task Submissions tab.
      const codeMatches =
        !!task.code &&
        typeof submittedCode === "string" &&
        submittedCode.trim().length > 0 &&
        submittedCode.trim() === task.code;

      await submissions.insertOne({
        telegramId: uid,
        taskId: task._id,
        taskTitle: task.title,
        reward: task.reward,
        texts: safeTexts,
        screenshots: safeScreenshots,
        status: codeMatches ? "approved" : "pending",
        autoApproved: codeMatches,
        createdAt: new Date(),
      });

      if (!codeMatches) {
        return res.status(200).json({ success: true, autoApproved: false });
      }

      // --- Auto-approve payout (mirrors the manual-approve path in
      // api/admin/tasks.js exactly, so auto vs. manual approval always pay
      // out identically) ---
      await users.updateOne(
        { telegramId: uid },
        {
          $inc: {
            balance: task.reward,
            lifetimeEarned: task.reward,
            tasksCompleted: 1,
            tasksDoneToday: 1,
          },
        }
      );

      // Referral Tier 2: friend completes 10 tasks (lifetime) -> referrer gets +60
      const updatedUser = await users.findOne({ telegramId: uid });
      if (
        updatedUser &&
        updatedUser.referredBy &&
        !updatedUser.step2Rewarded &&
        (updatedUser.tasksCompleted || 0) >= 10
      ) {
        // MULTI-ACCOUNT GUARD: same rule as the admin manual-approve path —
        // skip the referrer payout if this account shares a device/IP with
        // its referrer (referral count itself was already recorded at step 1).
        const referrerUser = await users.findOne({ telegramId: updatedUser.referredBy });
        const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, updatedUser.lastIp);

        if (!sameDeviceAsReferrer) {
          await users.updateOne(
            { telegramId: updatedUser.referredBy },
            { $inc: { balance: 60, lifetimeEarned: 60, referralEarnings: 60 } }
          );
        }
        await users.updateOne({ telegramId: uid }, { $set: { step2Rewarded: true } });

        // "Valid referral" (all 3 tiers cleared) notification — only tier 2
        // completing here, so this only actually fires once tiers 1 and 3
        // have ALSO completed for this same referred user (see
        // api/user.js and api/earn.js for the other two calls).
        const freshReferredUser = await users.findOne({ telegramId: uid });
        await notifyIfValidReferral(users, freshReferredUser);
      }

      return res.status(200).json({ success: true, autoApproved: true, reward: task.reward });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] task.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
