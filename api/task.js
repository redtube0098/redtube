// api/task.js
const { getDb } = require("./_db");
const { ObjectId } = require("mongodb");
const { verifyInitData } = require("./_verifyInitData");
const { isMember, maybeRewardStep2Task } = require("./_telegram");
const { getClientIp, checkIpLock } = require("./_utils");
const { signAction, verifyActionToken } = require("./_actionSign");

// Same generic wording as earn.js/withdraw.js — deliberately vague so the
// exact detection mechanism isn't handed to anyone probing the endpoint.
const TASK_BLOCKED_ERROR =
  "This account can't complete tasks right now. Please contact support.";

// Minimum time a "normal" (unverified) special task's link must have been
// opened before completeSpecialTask is allowed to pay out. Matches the
// 5-second wait the frontend already shows the user — this just makes that
// wait a real server-side requirement instead of a client-only setTimeout
// that a direct API call could skip entirely.
const NORMAL_TASK_MIN_VIEW_MS = 5000;
// A view older than this is considered stale — stops someone viewing a task
// once and then claiming it again arbitrarily far in the future off a
// single logged view (they'd need to "view" again, which is free/harmless,
// but keeps the log meaningfully tied to one claim attempt).
const NORMAL_TASK_VIEW_MAX_AGE_MS = 30 * 60 * 1000;

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
    const specialTaskViews = db.collection("special_task_views");

    // ---- MULTI-ACCOUNT / IP-LOCK ENFORCEMENT (same as earn.js) ----
    // Blocks a request from a genuinely blocked account before it can log a
    // view, submit a task, or claim a special task — not just when the app
    // first loads. Fails open on unresolvable/unplausible IPs, same as
    // everywhere else this check is used. GET (read-only) requests are
    // unaffected.
    if (req.method === "POST") {
      const taskIp = getClientIp(req);
      const taskIpLock = await checkIpLock(db, uid, taskIp);
      if (taskIpLock.blocked) {
        console.warn(`[SECURITY] uid ${uid} blocked from tasks — IP ${taskIp} locked to another account`);
        return res.status(403).json({ error: TASK_BLOCKED_ERROR, blocked: true });
      }
    }

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
        // Signed action token (see api/_actionSign.js) for the claim POST
        // below to verify — sent as a header so this array response's
        // shape is untouched. No-op while ACTION_SIGNING_SECRET is unset.
        const specialTaskActionToken = signAction(uid, "task");
        if (specialTaskActionToken) res.setHeader("X-Action-Token", specialTaskActionToken);
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
      // Same signed action token as the special-tasks branch above — same
      // scope ("task"), so either GET list can hand the token the POST
      // submission below will verify.
      const regularTaskActionToken = signAction(uid, "task");
      if (regularTaskActionToken) res.setHeader("X-Action-Token", regularTaskActionToken);
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
      // --- Special Task VIEW log (normal-type tasks only) ---
      // Frontend calls this the moment it opens the task link, right before
      // starting its own 5s countdown (see public/app.js). This is what lets
      // completeSpecialTask below actually verify time passed server-side,
      // instead of trusting a client setTimeout that a direct API call could
      // just skip. Harmless/idempotent — just records "this account opened
      // this task link right now."
      if (req.body && req.body.action === "viewSpecialTask") {
        const { taskId } = req.body;
        if (!isValidObjectId(taskId)) {
          return res.status(400).json({ error: "invalid taskId" });
        }
        await specialTaskViews.updateOne(
          { telegramId: uid, taskId: new ObjectId(taskId) },
          { $set: { viewedAt: new Date() } },
          { upsert: true }
        );
        return res.status(200).json({ success: true });
      }

      // --- Special Task claim (Verified: real membership check; Normal:
      // requires a viewSpecialTask log at least NORMAL_TASK_MIN_VIEW_MS old) ---
      if (req.body && req.body.action === "completeSpecialTask") {
        const { taskId } = req.body;
        if (!isValidObjectId(taskId)) {
          return res.status(400).json({ error: "invalid taskId" });
        }
        const task = await specialTasks.findOne({ _id: new ObjectId(taskId), active: true });
        if (!task) return res.status(404).json({ error: "task not found" });

        // Signed-action check (see api/_actionSign.js) — no-op/always-passes
        // until ACTION_SIGNING_SECRET is configured.
        if (!verifyActionToken(req.headers["x-action-token"], uid, "task")) {
          return res.status(403).json({ error: "Please refresh and try again." });
        }

        if (task.verificationType === "verified") {
          if (!task.chatId) {
            console.error("[task.js] special task missing chatId:", task._id);
            return res.status(500).json({ error: "misconfigured task" });
          }
          const member = await isMember(task.chatId, uid);
          if (!member) {
            return res.status(400).json({ error: "not_member" });
          }
        } else {
          // "normal" type — server-side enforce the same 5s wait the UI
          // already shows, using the viewSpecialTask log as proof the link
          // was actually opened, not just that the client waited locally.
          const view = await specialTaskViews.findOne({ telegramId: uid, taskId: task._id });
          if (!view || !view.viewedAt) {
            return res.status(400).json({ error: "Please open the task link first, then try again." });
          }
          const elapsedMs = Date.now() - new Date(view.viewedAt).getTime();
          if (elapsedMs < NORMAL_TASK_MIN_VIEW_MS) {
            return res.status(400).json({ error: "Please wait a moment before claiming this task." });
          }
          if (elapsedMs > NORMAL_TASK_VIEW_MAX_AGE_MS) {
            return res.status(400).json({ error: "Please open the task link again, then try claiming." });
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

        // Timestamped completion log — specialTasksDone itself is just a
        // {taskId: true} map with no per-completion date, so without this
        // log a special-task completion could never be counted toward
        // "tasks completed today" (see api/withdraw.js eligibility check).
        await db.collection("special_task_logs").insertOne({
          telegramId: uid,
          taskId: task._id,
          completedAt: new Date(),
        });

        // Referral Tier 2: friend completes 10 tasks TOTAL, counting
        // regular + special tasks together -> referrer gets +60.
        // Shared helper — see api/_telegram.js for the combined-count logic.
        await maybeRewardStep2Task(db, users, uid);

        return res.status(200).json({ success: true, reward: task.reward, balance: updatedUser.balance });
      }

      // --- Regular task submission ---
      const { taskId, texts, screenshots, code: submittedCode } = req.body || {};
      if (!isValidObjectId(taskId)) {
        return res.status(400).json({ error: "invalid taskId" });
      }

      // Signed-action check (see api/_actionSign.js) — no-op/always-passes
      // until ACTION_SIGNING_SECRET is configured.
      if (!verifyActionToken(req.headers["x-action-token"], uid, "task")) {
        return res.status(403).json({ error: "Please refresh and try again." });
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

      // If this task has an auto-approve code set, the submitted code MUST
      // match exactly (after trimming) — there is no "fall through to
      // pending review" path for a code-gated task anymore. Previously a
      // wrong/blank code on a code-gated task silently created a pending
      // submission with no feedback, so the user had no idea their code
      // was wrong until an admin (never) reviewed it manually. Now a wrong
      // code is rejected immediately with a clear error, and nothing is
      // written to the submissions collection for that attempt — the user
      // can just retype the code and submit again right away.
      const hasCode = !!task.code;
      const codeMatches =
        hasCode &&
        typeof submittedCode === "string" &&
        submittedCode.trim().length > 0 &&
        submittedCode.trim() === task.code;

      if (hasCode && !codeMatches) {
        return res.status(400).json({ error: "Wrong code — please check and try again." });
      }

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
        // approvedAt mirrors the manual-approve path in api/admin/tasks.js —
        // this is what the ttl_task_submissions_approved_7d TTL index (see
        // api/_db.js) keys off of, so an auto-approved submission also
        // auto-deletes 7 days after approval. Left undefined for the
        // pending (codeMatches === false) case, same as before.
        ...(codeMatches ? { approvedAt: new Date() } : {}),
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

      // Referral Tier 2: friend completes 10 tasks TOTAL, counting
      // regular + special tasks together -> referrer gets +60.
      // Shared helper — see api/_telegram.js for the combined-count logic.
      await maybeRewardStep2Task(db, users, uid);

      return res.status(200).json({ success: true, autoApproved: true, reward: task.reward });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] task.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
