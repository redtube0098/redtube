// scripts/backfill-last-active-at.js
//
// ONE-TIME MIGRATION — run this manually, ONCE, RIGHT BEFORE (or right
// after, but as soon as possible) deploying the new 60-day dormant-account
// TTL index on users.lastActiveAt (see api/_db.js).
//
// WHY THIS EXISTS: the TTL index only ever deletes a `users` document once
// it HAS a lastActiveAt field that's more than 60 days old. Every existing
// user in the database (everyone who signed up before this feature shipped)
// has NO lastActiveAt field at all yet — MongoDB's TTL sweep leaves a
// document completely alone if the indexed field is missing, so without
// this script nothing would happen to them until they next open the app.
//
// This script sets lastActiveAt = right now (NOT their old createdAt/last
// known activity) for every existing user who doesn't have it yet. That's a
// deliberate safety choice: backfilling with their true last-activity date
// could immediately delete anyone who happens to already be past 60 days
// inactive the moment this ships, with zero warning. Setting it to "now"
// instead gives every existing account — active or already-dormant — a
// full fresh 60-day countdown starting from the day this feature goes
// live, so nobody is deleted as a surprise side effect of this migration
// itself. Going forward, the TTL only fires 60 days after this point (or
// 60 days after their last real app-open, for anyone who comes back).
//
// Usage:
//   MONGODB_URI="mongodb+srv://..." node scripts/backfill-last-active-at.js
//
// Safe to re-run: it only ever touches users where lastActiveAt doesn't
// exist yet ({ lastActiveAt: { $exists: false } }), so running it twice
// does nothing the second time — it will never reset anyone's clock who
// already has the field (from a real app-open or a prior run).

const { MongoClient } = require("mongodb");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI env var is required. Example:");
    console.error('  MONGODB_URI="mongodb+srv://..." node scripts/backfill-last-active-at.js');
    process.exit(1);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  console.log("[BACKFILL] Connected to MongoDB.");

  try {
    const db = client.db("redtube"); // same DB name as api/_db.js
    const users = db.collection("users");

    const result = await users.updateMany(
      { lastActiveAt: { $exists: false } },
      { $set: { lastActiveAt: new Date() } }
    );

    console.log(
      `[BACKFILL] Done. Matched ${result.matchedCount} user(s) with no lastActiveAt, ` +
        `set it to "now" on ${result.modifiedCount} of them.`
    );
    console.log(
      "[BACKFILL] Every one of those accounts now has a fresh 60-day window " +
        "starting today before the dormant-account TTL can delete them."
    );
  } finally {
    await client.close();
    console.log("[BACKFILL] Connection closed.");
  }
}

main().catch((err) => {
  console.error("[BACKFILL] Failed:", err);
  process.exit(1);
});
