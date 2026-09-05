// scripts/backfill-lifetime-withdrawn.js
//
// ONE-TIME MIGRATION — run this manually, ONCE, BEFORE deploying the new
// approveWithdrawById() (api/_telegram.js) that (a) prunes old approved
// withdraws down to the last 10 per user, and (b) increments
// user.lifetimeWithdrawnUSDT / user.lifetimeWithdrawalsCount on every NEW
// approval from that point forward.
//
// Why this exists: those two counters start counting from zero the moment
// the new code ships. Any user who already had approved withdraws BEFORE
// that point would show an understated "lifetime total withdrawn" in the
// admin panel forever, unless this script sums their EXISTING approved
// withdraw history into the counters first.
//
// This must run before any pruning has happened — once old approved
// withdraws are deleted, their amounts can no longer be recovered from the
// withdraws collection at all. If you've already deployed the new approve
// logic and pruning may have already run for some users, this script will
// still work correctly for anyone who hasn't hit the 10-approved-withdraws
// mark yet, but will UNDERSTATE the true lifetime total for anyone who has
// (their oldest approved withdraws are already gone). Run this FIRST.
//
// Usage:
//   MONGODB_URI="mongodb+srv://..." node scripts/backfill-lifetime-withdrawn.js
//
// Safe to re-run: it OVERWRITES (not increments) each user's two counters
// with a fresh sum computed from their current approved withdraws, so
// running it twice in a row (with nothing approved in between) gives the
// same result both times — it will never double-count.

const { MongoClient } = require("mongodb");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI env var is required. Example:");
    console.error('  MONGODB_URI="mongodb+srv://..." node scripts/backfill-lifetime-withdrawn.js');
    process.exit(1);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  console.log("[BACKFILL] Connected to MongoDB.");

  try {
    const db = client.db("redtube"); // same DB name as api/_db.js
    const withdraws = db.collection("withdraws");
    const users = db.collection("users");

    // Aggregate: for every telegramId that has at least one approved
    // withdraw, compute the sum of amounts and the count.
    const totals = await withdraws
      .aggregate([
        { $match: { status: "approved" } },
        {
          $group: {
            _id: "$telegramId",
            totalUSDT: { $sum: { $ifNull: ["$amount", 0] } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    console.log(`[BACKFILL] Found ${totals.length} user(s) with at least one approved withdraw.`);

    let updated = 0;
    for (const row of totals) {
      const telegramId = row._id;
      const result = await users.updateOne(
        { telegramId },
        {
          $set: {
            lifetimeWithdrawnUSDT: Math.round((row.totalUSDT + Number.EPSILON) * 1e6) / 1e6,
            lifetimeWithdrawalsCount: row.count,
          },
        }
      );
      if (result.matchedCount === 0) {
        // Approved withdraw exists but the user document itself is gone
        // (deleted account, test data, etc.) — nothing to backfill onto,
        // skip it rather than creating a stray user document.
        console.warn(`[BACKFILL] No user document for telegramId ${telegramId} — skipped (${row.count} approved withdraws, $${row.totalUSDT}).`);
        continue;
      }
      updated++;
    }

    console.log(`[BACKFILL] Done. Updated ${updated} user document(s).`);
  } finally {
    await client.close();
    console.log("[BACKFILL] Connection closed.");
  }
}

main().catch((err) => {
  console.error("[BACKFILL] Failed:", err);
  process.exit(1);
});
