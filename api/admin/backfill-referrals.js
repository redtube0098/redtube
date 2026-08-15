const { getDb } = require("../_db");
const { checkAdmin, maybeRewardStep2Task } = require("../_telegram");

// ONE-TIME BACKFILL: catches every existing referred user who already had
// combined (regular + special) task completions >= 10 BEFORE the referral
// tier-2 bug was fixed, and pays their referrer the missed +60 (plus fires
// the "valid referral" notification if tiers 1+3 are also already done).
// Safe to run more than once — maybeRewardStep2Task() itself checks
// step2Rewarded and atomically claims before paying out, so re-running
// this after the first successful pass is a harmless no-op for anyone
// already rewarded.
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (!checkAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const users = db.collection("users");

    // Only users who: have a referrer, and haven't already been rewarded
    // for tier 2 — everyone else is skipped without any DB work.
    const candidates = await users
      .find({ referredBy: { $ne: null, $exists: true }, step2Rewarded: { $ne: true } })
      .project({ telegramId: 1 })
      .toArray();

    let checked = 0;
    for (const c of candidates) {
      await maybeRewardStep2Task(db, users, c.telegramId);
      checked++;
    }

    console.log(`[ADMIN] Backfill referral tier-2 completed — checked ${checked} candidates`);
    return res.status(200).json({ success: true, checked });
  } catch (err) {
    console.error("[ERROR] backfill-referrals.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
