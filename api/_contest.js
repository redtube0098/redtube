// api/_contest.js
const { sendMessage, enqueueBroadcast, EARN_MORE_KEYBOARD } = require("./_telegram");

const CONTEST_OVER_KEYBOARD = {
  inline_keyboard: [[{ text: "Open Redtube Now!", url: "https://t.me/redtube12_bot/earn?startapp=contest" }]],
};

const WEEKLY_CONTEST_PRIZES = {
  1: 1.00,
  2: 0.50,
  3: 0.40,
  4: 0.30,
  5: 0.20,
  6: 0.05,
  7: 0.05,
  8: 0.05,
  9: 0.05,
  10: 0.05,
};

const CONTEST_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function getContestState(db) {
  const settings = db.collection("settings");
  let state = await settings.findOne({ _id: "refer_contest_state" });
  if (!state) {
    const now = new Date();
    const endsAt = new Date(now.getTime() + CONTEST_DURATION_MS);
    const newState = {
      _id: "refer_contest_state",
      weekNumber: 1,
      startedAt: now,
      endsAt: endsAt,
      status: "active",
      createdAt: now,
    };
    await settings.updateOne(
      { _id: "refer_contest_state" },
      { $setOnInsert: newState },
      { upsert: true }
    );
    state = await settings.findOne({ _id: "refer_contest_state" });
  }
  return state;
}

// Aggregates referred users created between [contestStart, contestEnd)
// Groups by referrer (_id: "$referredBy")
// Sorts by:
// 1) weeklyRefs: -1 (higher referrals rank higher)
// 2) lastRefAt: -1 (tie breaker: whoever reached that count later / more recently ranks higher)
async function getContestRankings(db, contestStart, contestEnd, limit = 20) {
  const matchFilter = {
    referredBy: { $ne: null, $exists: true },
    createdAt: { $gte: contestStart },
  };
  if (contestEnd) {
    matchFilter.createdAt.$lt = contestEnd;
  }

  const results = await db
    .collection("users")
    .aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: "$referredBy",
          weeklyRefs: { $sum: 1 },
          lastRefAt: { $max: "$createdAt" },
        },
      },
      {
        $sort: {
          weeklyRefs: -1,
          lastRefAt: -1,
        },
      },
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
          photoUrl: "$referrer.photoUrl",
          weeklyRefs: 1,
          lastRefAt: 1,
        },
      },
    ])
    .toArray();

  return results;
}

async function checkAndFinalizeContest(db) {
  const settings = db.collection("settings");
  let state = await getContestState(db);
  const now = new Date();

  // If current week hasn't ended yet, nothing to finalize
  if (now < new Date(state.endsAt)) {
    return state;
  }

  // Atomically claim the finalization lock
  const claim = await settings.findOneAndUpdate(
    { _id: "refer_contest_state", endsAt: { $lte: now }, status: "active" },
    { $set: { status: "finalizing", finalizingAt: now } },
    { returnDocument: "after" }
  );

  const lockedState = claim?.value || claim;
  if (!lockedState) {
    // Already claimed or finalized by another request, fetch fresh state
    return await settings.findOne({ _id: "refer_contest_state" });
  }

  try {
    const startedAt = new Date(lockedState.startedAt);
    const endedAt = new Date(lockedState.endsAt);
    const weekNumber = lockedState.weekNumber || 1;

    // Fetch top 20 rankings for the finished week
    const top20 = await getContestRankings(db, startedAt, endedAt, 20);

    const gifts = db.collection("gifts");
    const formattedRankings = [];

    for (let i = 0; i < top20.length; i++) {
      const u = top20[i];
      const rank = i + 1;
      const prize = rank <= 10 && u.weeklyRefs > 0 ? (WEEKLY_CONTEST_PRIZES[rank] || 0) : 0;

      formattedRankings.push({
        rank,
        telegramId: u.telegramId,
        username: u.username || null,
        firstName: u.firstName || null,
        photoUrl: u.photoUrl || null,
        displayName: u.firstName || (u.username ? `@${u.username}` : `UID: ${u.telegramId}`),
        refs: u.weeklyRefs,
        prizeUsdt: prize,
      });

      // Distribute prize via claimable gift if rank 1-10 with valid referrals
      if (prize > 0) {
        await gifts.insertOne({
          telegramId: u.telegramId,
          amount: prize,
          currency: "USDT",
          reason: `Weekly Refer Contest (Week #${weekNumber}) Rank #${rank} Prize ($${prize.toFixed(2)}) 🏆`,
          status: "pending",
          createdAt: new Date(),
        });
      }
    }

    // Archive this completed week into refer_contest_history
    const history = db.collection("refer_contest_history");
    await history.insertOne({
      weekNumber,
      startedAt,
      endedAt,
      rankings: formattedRankings,
      createdAt: new Date(),
    });

    // Enqueue contest-over broadcast to ALL users with "Open Redtube Now!" button
    const broadcastText = "🤝 *Referral contest is over! USDT added to the winners' balance!*";
    try {
      await enqueueBroadcast(db, { text: broadcastText, keyboard: CONTEST_OVER_KEYBOARD });
      console.log(`[CONTEST] Enqueued contest-over broadcast for Week #${weekNumber}.`);
    } catch (e) {
      console.error("[CONTEST] Failed to enqueue contest-over broadcast:", e.message);
    }

    // Advance to next week (starts from previous endsAt)
    const nextStartedAt = endedAt;
    const nextEndsAt = new Date(nextStartedAt.getTime() + CONTEST_DURATION_MS);
    const updated = await settings.findOneAndUpdate(
      { _id: "refer_contest_state" },
      {
        $set: {
          weekNumber: weekNumber + 1,
          startedAt: nextStartedAt,
          endsAt: nextEndsAt,
          status: "active",
          lastFinalizedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    console.log(`[CONTEST] Week #${weekNumber} finalized successfully with ${formattedRankings.length} ranked users.`);
    return updated?.value || updated;
  } catch (err) {
    console.error("[ERROR] Contest finalization failed:", err);
    // Release lock so it can recover on next tick
    await settings.updateOne(
      { _id: "refer_contest_state", status: "finalizing" },
      { $set: { status: "active" } }
    );
    throw err;
  }
}

async function getContestData(db, userUid = null) {
  const state = await checkAndFinalizeContest(db);
  const top20 = await getContestRankings(db, state.startedAt, state.endsAt, 20);

  const formattedTop20 = top20.map((u, i) => {
    const rank = i + 1;
    return {
      rank,
      telegramId: u.telegramId,
      username: u.username || null,
      firstName: u.firstName || null,
      photoUrl: u.photoUrl || null,
      displayName: u.firstName || (u.username ? `@${u.username}` : `UID: ${u.telegramId}`),
      refs: u.weeklyRefs,
      prizeUsdt: rank <= 10 && u.weeklyRefs > 0 ? (WEEKLY_CONTEST_PRIZES[rank] || 0) : 0,
      isMe: userUid ? String(u.telegramId) === String(userUid) : false,
    };
  });

  // Fetch the latest previous week from history
  const history = db.collection("refer_contest_history");
  const prevDoc = await history.findOne({}, { sort: { weekNumber: -1 } });

  let myContestStats = null;
  if (userUid) {
    const users = db.collection("users");
    const myRefs = await users.countDocuments({
      referredBy: Number(userUid),
      createdAt: { $gte: state.startedAt, $lt: state.endsAt },
    });
    const myInTop = formattedTop20.find((r) => String(r.telegramId) === String(userUid));
    myContestStats = {
      refs: myRefs,
      rank: myInTop ? myInTop.rank : null,
      prizeUsdt: myInTop ? myInTop.prizeUsdt : 0,
    };
  }

  return {
    thisWeek: {
      weekNumber: state.weekNumber || 1,
      startedAt: state.startedAt,
      endsAt: state.endsAt,
      prizes: WEEKLY_CONTEST_PRIZES,
      rankings: formattedTop20,
      myStats: myContestStats,
    },
    previousWeek: prevDoc
      ? {
          weekNumber: prevDoc.weekNumber,
          startedAt: prevDoc.startedAt,
          endedAt: prevDoc.endedAt,
          rankings: prevDoc.rankings || [],
        }
      : null,
  };
}

module.exports = {
  WEEKLY_CONTEST_PRIZES,
  CONTEST_DURATION_MS,
  getContestState,
  getContestRankings,
  checkAndFinalizeContest,
  getContestData,
};
