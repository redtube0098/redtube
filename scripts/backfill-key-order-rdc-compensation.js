// scripts/backfill-key-order-rdc-compensation.js
//
// ONE-TIME MIGRATION — run this manually, ONCE, after removing the Key
// Store (api/user.js's "buy_key" / "check_order" actions, and the
// key_orders branch of matchAndCreditPayment).
//
// What it does: the Key Store used to require users to pay real TON to buy
// "Key Coins" in order to withdraw. Since that requirement is gone
// (withdraw is now gated by Spin Wheel count instead — see
// api/withdraw.js), anyone who ALREADY paid real money for Key Coins is
// compensated with 250 RDC per Key Coin they purchased, credited straight
// to their in-app RDC balance.
//
// Scope, exactly as specified:
//   - ONLY orders with status:"paid" count (i.e. a real completed TON
//     payment actually went through) — orders that were never paid
//     ("pending", abandoned) get nothing, there's nothing to compensate.
//   - Key Coins that were earned FREE via a valid referral are NOT in the
//     key_orders collection at all (those go straight to keyCoinBalance
//     via notifyIfValidReferral in api/_telegram.js) — so this script
//     naturally never touches them. Only real purchases are compensated.
//   - 250 RDC is paid PER Key Coin purchased (order.quantity), not a flat
//     250 per order — e.g. a 5-pack order credits 1250 RDC.
//   - Idempotent / safe to re-run: each key_orders doc gets a
//     rdcCompensationCredited:true flag once processed, and this script
//     only ever looks at doc s where that flag is not yet set — so an
//     order that was already compensated (whether by an earlier run of
//     this exact script, or manually by an admin who then set the flag by
//     hand) is never compensated a second time.
//
// Usage:
//   MONGODB_URI="mongodb+srv://..." node scripts/backfill-key-order-rdc-compensation.js
//
//   Add --dry-run to only print what WOULD happen, without writing
//   anything:
//   MONGODB_URI="..." node scripts/backfill-key-order-rdc-compensation.js --dry-run

const { MongoClient } = require("mongodb");

const RDC_PER_KEY = 250;
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI env var is required. Example:");
    console.error('  MONGODB_URI="mongodb+srv://..." node scripts/backfill-key-order-rdc-compensation.js');
    process.exit(1);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  console.log(`[KEY-RDC-BACKFILL] Connected to MongoDB.${DRY_RUN ? " (DRY RUN — no writes will happen)" : ""}`);

  try {
    const db = client.db("redtube"); // same DB name as api/_db.js
    const keyOrders = db.collection("key_orders");
    const users = db.collection("users");

    // Only PAID orders that have not already been compensated.
    const cursor = keyOrders.find({
      status: "paid",
      rdcCompensationCredited: { $ne: true },
    });

    let processed = 0;
    let totalRdc = 0;
    let skippedNoUser = 0;

    for await (const order of cursor) {
      const quantity = Number(order.quantity) || 0;
      if (quantity <= 0) {
        console.warn(`[KEY-RDC-BACKFILL] Order ${order.orderId} has invalid quantity (${order.quantity}) — skipped.`);
        continue;
      }
      const rdcAmount = quantity * RDC_PER_KEY;

      if (DRY_RUN) {
        console.log(`[KEY-RDC-BACKFILL] (dry-run) Would credit ${rdcAmount} RDC to telegramId ${order.telegramId} for order ${order.orderId} (${quantity} key(s)).`);
        processed++;
        totalRdc += rdcAmount;
        continue;
      }

      // Mark the order FIRST, atomically, so a crash mid-run can never
      // double-credit the same order on a re-run (matches the same
      // "flip a status field, then act" pattern used everywhere else in
      // this codebase for payment idempotency).
      const claim = await keyOrders.updateOne(
        { orderId: order.orderId, rdcCompensationCredited: { $ne: true } },
        { $set: { rdcCompensationCredited: true, rdcCompensationAmount: rdcAmount, rdcCompensatedAt: new Date() } }
      );
      if (claim.modifiedCount === 0) continue; // already claimed (concurrent run) — skip

      const result = await users.updateOne(
        { telegramId: order.telegramId },
        { $inc: { balance: rdcAmount, lifetimeEarned: rdcAmount } }
      );
      if (result.matchedCount === 0) {
        console.warn(`[KEY-RDC-BACKFILL] No user document for telegramId ${order.telegramId} (order ${order.orderId}) — order flagged compensated but no balance to credit.`);
        skippedNoUser++;
        continue;
      }

      processed++;
      totalRdc += rdcAmount;
      console.log(`[KEY-RDC-BACKFILL] Credited ${rdcAmount} RDC to telegramId ${order.telegramId} for order ${order.orderId} (${quantity} key(s)).`);
    }

    console.log(`[KEY-RDC-BACKFILL] Done. ${processed} order(s) processed, ${totalRdc} total RDC ${DRY_RUN ? "would be" : ""} credited. ${skippedNoUser} order(s) had no matching user.`);
  } finally {
    await client.close();
    console.log("[KEY-RDC-BACKFILL] Connection closed.");
  }
}

main().catch((err) => {
  console.error("[KEY-RDC-BACKFILL] Failed:", err);
  process.exit(1);
});
