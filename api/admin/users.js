const { getDb } = require("../_db");
const { checkAdmin } = require("../_telegram");

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

// --- Weekly Referral Contest helpers (duplicated from api/referral.js on
// purpose — keeping this file self-contained rather than adding a new
// shared api/_contest.js, since a fresh serverless-function slot is off
// the table right now). Same "settings.weekly_contest.startedAt" doc is
// read/written by both files, so they always agree on the current window. ---
async function getContestStart(db) {
  const settings = db.collection("settings");
  let doc = await settings.findOne({ _id: "weekly_contest" });
  if (!doc) {
    await settings.updateOne(
      { _id: "weekly_contest" },
      { $setOnInsert: { startedAt: new Date(0) } },
      { upsert: true }
    );
    doc = await settings.findOne({ _id: "weekly_contest" });
  }
  return doc.startedAt;
}

async function getWeeklyTopNAdmin(db, contestStart, limit) {
  return db
    .collection("users")
    .aggregate([
      { $match: { referredBy: { $ne: null, $exists: true }, createdAt: { $gte: contestStart } } },
      { $group: { _id: "$referredBy", weeklyRefs: { $sum: 1 } } },
      { $sort: { weeklyRefs: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "telegramId",
          as: "referrer",
        },
      },
      { $unwind: { path: "$referrer", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          telegramId: "$_id",
          username: "$referrer.username",
          firstName: "$referrer.firstName",
          weeklyRefs: 1,
        },
      },
    ])
    .toArray();
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
      console.warn(`[SECURITY] Unauthorized admin/users access from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const users = db.collection("users");

    if (req.method === "GET") {
      // --- "All Refer Users" panel: every user who has ever referred
      // anyone, with their UID + username + total referral count ---
      if (req.query.action === "all_referrers") {
        const all = await users
          .find({ referralsCount: { $gt: 0 } })
          .sort({ referralsCount: -1 })
          .limit(1000)
          .toArray();
        return res.status(200).json(
          all.map((u) => ({
            telegramId: u.telegramId,
            username: u.username || null,
            firstName: u.firstName || null,
            referralsCount: u.referralsCount || 0,
          }))
        );
      }

      // --- "Refer Contest" panel: current weekly-contest top 10, with
      // UID + username so the admin can pay out winners ---
      if (req.query.action === "weekly_top10") {
        const contestStart = await getContestStart(db);
        const top10 = await getWeeklyTopNAdmin(db, contestStart, 10);
        return res.status(200).json({
          contestStartedAt: contestStart,
          top: top10.map((r, i) => ({
            rank: i + 1,
            telegramId: r.telegramId,
            username: r.username || null,
            firstName: r.firstName || null,
            weeklyRefs: r.weeklyRefs,
          })),
        });
      }

      // --- List everyone referred by a given uid (for the "Show Referrals"
      // panel in the admin Users tab) ---
      if (req.query.referredBy !== undefined) {
        const refByNum = Number(req.query.referredBy);
        if (!Number.isFinite(refByNum)) {
          return res.status(400).json({ error: "invalid referredBy" });
        }
        const referred = await users
          .find({ referredBy: refByNum })
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray();

        // "Tasks Done" must reflect BOTH task systems combined — regular
        // task approvals (task_submissions, status:"approved") AND special/
        // channel-join task completions (special_task_logs) — matching
        // exactly what maybeRewardStep2Task() in api/_telegram.js counts
        // toward the referral tier-2 threshold. Previously this column
        // only read u.tasksCompleted, which is incremented ONLY by the
        // regular-task path — so anyone who completed special tasks (or
        // ONLY special tasks) showed "0" here even though their actual
        // combined progress toward the referral reward was correct
        // server-side. This was a display bug only; the reward logic
        // itself was already counting both correctly.
        const submissions = db.collection("task_submissions");
        const specialTaskLogs = db.collection("special_task_logs");

        const withCombinedTasks = await Promise.all(
          referred.map(async (u) => {
            const [regularCount, specialCount] = await Promise.all([
              submissions.countDocuments({ telegramId: u.telegramId, status: "approved" }),
              specialTaskLogs.countDocuments({ telegramId: u.telegramId }),
            ]);
            return {
              telegramId: u.telegramId,
              username: u.username,
              firstName: u.firstName,
              joined: u.joined || false,
              tasksCompleted: regularCount + specialCount,
              adsWatchedTotal: u.adsWatchedTotal || 0,
              createdAt: u.createdAt,
            };
          })
        );

        return res.status(200).json(withCombinedTasks);
      }

      const q = req.query.q;
      // Must be a string — blocks NoSQL injection via object-shaped query params
      // (e.g. ?q[$ne]=null would arrive as an object, not a string)
      if (!q || typeof q !== "string") {
        return res.status(400).json({ error: "query required" });
      }
      const trimmedQ = q.trim().slice(0, 100); // cap length, defense in depth
      if (!trimmedQ) {
        return res.status(400).json({ error: "query required" });
      }
      const asNumber = Number(trimmedQ);
      const filter = !isNaN(asNumber)
        ? { telegramId: asNumber }
        : { username: trimmedQ.replace("@", "") };
      const user = await users.findOne(filter);
      if (!user) return res.status(404).json({ error: "not found" });
      // Never leak internal/sensitive fields (e.g. IP history, raw tokens) to admin UI unless needed
      return res.status(200).json(user);
    }

    if (req.method === "POST") {
      // --- Reset the weekly contest: starts a brand-new window from now.
      // Nothing about past referrals is deleted — this only moves the
      // "startedAt" cutoff forward, so old referrals stop counting toward
      // the (new) weekly totals automatically. ---
      if (req.body?.action === "reset_weekly_contest") {
        const settings = db.collection("settings");
        const now = new Date();
        await settings.updateOne(
          { _id: "weekly_contest" },
          { $set: { startedAt: now } },
          { upsert: true }
        );
        console.log(`[ADMIN] Weekly referral contest reset by IP ${ip} at ${now.toISOString()}`);
        return res.status(200).json({ success: true, startedAt: now });
      }

      const { uid, amount } = req.body || {};
      if (uid === undefined || uid === null || amount === undefined) {
        return res.status(400).json({ error: "missing fields" });
      }
      const uidNum = Number(uid);
      const amountNum = Number(amount);
      if (!Number.isFinite(uidNum)) {
        return res.status(400).json({ error: "invalid uid" });
      }
      if (!Number.isFinite(amountNum)) {
        return res.status(400).json({ error: "invalid amount" });
      }
      // Guard against absurd values (typo protection, e.g. accidental extra zero)
      if (Math.abs(amountNum) > 1_000_000) {
        return res.status(400).json({ error: "amount exceeds safe limit" });
      }
      const result = await users.updateOne(
        { telegramId: uidNum },
        { $inc: { balance: amountNum } }
      );
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "user not found" });
      }
      console.log(
        `[ADMIN] Balance adjusted for telegramId ${uidNum}: ${amountNum > 0 ? "+" : ""}${amountNum} by IP ${ip}`
      );
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] users.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
