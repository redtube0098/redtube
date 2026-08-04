// api/earn.js
const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");
const { isSameDevice } = require("./_utils");

// Earning section: all three networks now share the same 20s cooldown.
// (monetag was 60s before — changed to 20 to match gigapub/adsgram.)
const AD_NETWORKS = {
  adsgram_daily: { reward: 10, limit: 15, cooldown: 20 },
  adsgram_special: { reward: 15, limit: 5, cooldown: 20 },
  monetag: { reward: 10, limit: 20, cooldown: 20 },
  gigapub: { reward: 15, limit: 20, cooldown: 20 },
};

// --- Spin Wheel config -----------------------------------------------
// 8 fixed segments, order agreed with the frontend wheel graphic. Index is
// what's sent back to the client so it knows which segment to land on —
// the reward is always decided here on the server first, never inferred
// from anything the client sends.
const SPIN_SEGMENTS = [
  { id: "usdt_001", type: "usdt", amount: 0.005 },
  { id: "usdt_0025", type: "usdt", amount: 0.01 },
  { id: "rdc10", type: "rdc", amount: 10 },
  { id: "rdc20", type: "rdc", amount: 20 },
  { id: "rdc30", type: "rdc", amount: 30 },
  { id: "rdc40", type: "rdc", amount: 40 },
  { id: "rdc50", type: "rdc", amount: 50 },
  { id: "free_spin", type: "free_spin", amount: 1 },
];
const SPIN_INDEX = Object.fromEntries(SPIN_SEGMENTS.map((s, i) => [s.id, i]));

// Ad network shown before each spin, cycling in this order.
const SPIN_AD_SEQUENCE = ["monetag", "adsgram_daily"];

const SPINS_PER_BATCH = 15;
const SPIN_BATCH_COOLDOWN_HOURS = 24;

// Normal-case weighted pool (used for every spin EXCEPT the milestone-forced
// USDT ones below). Weights are out of 100 — 10/20/30 RDC common, 40/50 RDC
// rare, small Free Spin chance. Tune these numbers here only.
const NORMAL_SPIN_WEIGHTS = [
  { id: "rdc10", weight: 35 },
  { id: "rdc20", weight: 28 },
  { id: "rdc30", weight: 20 },
  { id: "rdc40", weight: 9 },
  { id: "rdc50", weight: 3 },
  { id: "free_spin", weight: 5 },
];

function pickWeightedSegment() {
  const total = NORMAL_SPIN_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const w of NORMAL_SPIN_WEIGHTS) {
    if (r < w.weight) return w.id;
    r -= w.weight;
  }
  return NORMAL_SPIN_WEIGHTS[0].id; // fallback, should never hit
}

// Decides the reward for this spin. lifetimeSpins is the count AFTER this
// spin (i.e. the value already atomically incremented), so "spin #1" means
// lifetimeSpins === 1 here. earlyBonusSpinTarget/earlyBonusGiven live on the
// user document (see below).
function decideSpinReward(lifetimeSpins, user) {
  if (lifetimeSpins === 1) {
    return { segmentId: "usdt_001", setEarlyTarget: true };
  }
  if (!user.earlyBonusGiven && lifetimeSpins >= (user.earlyBonusSpinTarget || 25)) {
    return { segmentId: "usdt_0025", markEarlyBonusGiven: true };
  }
  if (lifetimeSpins % 600 === 0) {
    return { segmentId: "usdt_0025" };
  }
  if (lifetimeSpins % 300 === 0) {
    return { segmentId: "usdt_001" };
  }
  return { segmentId: pickWeightedSegment() };
}

const inFlightRequests = new Set();

// MongoDB driver v6+ made findOneAndUpdate() return the document directly
// instead of the old { value: doc } wrapper. This works with either.
function extractDoc(result) {
  if (result && typeof result === "object" && "value" in result) {
    return result.value;
  }
  return result;
}

function getStartOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getSecondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return Math.ceil((midnight - now) / 1000);
}

module.exports = async (req, res) => {
  try {
    // --- Verify the request genuinely came from Telegram, for a real user ---
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);

    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }

    // uid now comes ONLY from verified data — never trust client-supplied uid
    const uid = verifiedUser.id;

    const db = await getDb();
    const users = db.collection("users");
    const adLogs = db.collection("ad_logs");
    const spinLogs = db.collection("spin_logs");

    // ============================= GET =============================
    if (req.method === "GET") {
      // --- Spin Wheel status ---
      if (req.query && req.query.type === "spin") {
        const user = await users.findOne({ telegramId: uid });
        if (!user) return res.status(404).json({ error: "user not found" });

        const spinsAvailable = user.spinsAvailable ?? SPINS_PER_BATCH;
        let cooldownSecondsLeft = 0;
        if (spinsAvailable <= 0 && user.spinsExhaustedAt) {
          const elapsed = (Date.now() - new Date(user.spinsExhaustedAt).getTime()) / 1000;
          cooldownSecondsLeft = Math.max(0, Math.ceil(SPIN_BATCH_COOLDOWN_HOURS * 3600 - elapsed));
        }
        const usedInBatch = SPINS_PER_BATCH - spinsAvailable;
        const nextNetwork = SPIN_AD_SEQUENCE[((usedInBatch % SPIN_AD_SEQUENCE.length) + SPIN_AD_SEQUENCE.length) % SPIN_AD_SEQUENCE.length];

        return res.status(200).json({
          spinsAvailable: Math.max(0, spinsAvailable),
          spinsPerBatch: SPINS_PER_BATCH,
          cooldownSecondsLeft,
          nextNetwork: spinsAvailable > 0 ? nextNetwork : null,
          rdcBalance: user.balance || 0,
          usdtBalance: user.usdtBalance || 0,
        });
      }

      // --- Existing ad-network status (unchanged) ---
      const startOfDay = getStartOfDay();
      const result = {};
      for (const [key, cfg] of Object.entries(AD_NETWORKS)) {
        const countToday = await adLogs.countDocuments({
          telegramId: uid,
          network: key,
          watchedAt: { $gte: startOfDay },
        });
        const lastLog = await adLogs
          .find({ telegramId: uid, network: key })
          .sort({ watchedAt: -1 })
          .limit(1)
          .toArray();
        let secondsLeft = 0;
        if (lastLog.length) {
          const elapsed = (Date.now() - new Date(lastLog[0].watchedAt).getTime()) / 1000;
          secondsLeft = Math.max(0, Math.ceil(cfg.cooldown - elapsed));
        }
        result[key] = {
          watchedToday: countToday,
          limit: cfg.limit,
          reward: cfg.reward,
          cooldownSecondsLeft: secondsLeft,
          limitReached: countToday >= cfg.limit,
          resetInSeconds: countToday >= cfg.limit ? getSecondsUntilMidnight() : null,
        };
      }
      return res.status(200).json(result);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { action, network } = req.body || {};

    // ============================= SPIN =============================
    if (action === "spin") {
      const lockKey = `${uid}:spin`;
      if (inFlightRequests.has(lockKey)) {
        return res.status(429).json({ error: "request already in progress" });
      }
      inFlightRequests.add(lockKey);

      try {
        const userBefore = await users.findOne({ telegramId: uid });
        if (!userBefore) return res.status(404).json({ error: "user not found" });

        if (userBefore.spinsAvailable === undefined) {
          await users.updateOne(
            { telegramId: uid, spinsAvailable: { $exists: false } },
            { $set: { spinsAvailable: SPINS_PER_BATCH, lifetimeSpins: userBefore.lifetimeSpins || 0 } }
          );
        }

        if ((userBefore.spinsAvailable ?? SPINS_PER_BATCH) <= 0) {
          const cooldownCutoff = new Date(Date.now() - SPIN_BATCH_COOLDOWN_HOURS * 3600 * 1000);
          await users.findOneAndUpdate(
            {
              telegramId: uid,
              spinsAvailable: { $lte: 0 },
              spinsExhaustedAt: { $lte: cooldownCutoff },
            },
            { $set: { spinsAvailable: SPINS_PER_BATCH, spinsExhaustedAt: null } }
          );
        }

        const preCheck = await users.findOne({ telegramId: uid });
        const spinsAvailablePre = preCheck.spinsAvailable ?? SPINS_PER_BATCH;
        if (spinsAvailablePre <= 0) {
          const elapsed = preCheck.spinsExhaustedAt
            ? (Date.now() - new Date(preCheck.spinsExhaustedAt).getTime()) / 1000
            : 0;
          return res.status(400).json({
            error: "no_spins_left",
            cooldownSecondsLeft: Math.max(0, Math.ceil(SPIN_BATCH_COOLDOWN_HOURS * 3600 - elapsed)),
          });
        }
        const usedInBatch = SPINS_PER_BATCH - spinsAvailablePre;
        const expectedNetwork = SPIN_AD_SEQUENCE[usedInBatch % SPIN_AD_SEQUENCE.length];
        if (!network || network !== expectedNetwork) {
          return res.status(400).json({ error: "invalid_network", expectedNetwork });
        }

        const consumed = await users.findOneAndUpdate(
          { telegramId: uid, spinsAvailable: { $gt: 0 } },
          { $inc: { spinsAvailable: -1, lifetimeSpins: 1 } },
          { returnDocument: "after" }
        );
        const updatedUser = extractDoc(consumed);
        if (!updatedUser) {
          return res.status(400).json({ error: "no_spins_left" });
        }
        const lifetimeSpins = updatedUser.lifetimeSpins || 1;

        if (updatedUser.spinsAvailable <= 0) {
          await users.updateOne(
            { telegramId: uid },
            { $set: { spinsExhaustedAt: new Date() } }
          );
        }

        const decision = decideSpinReward(lifetimeSpins, updatedUser);
        const segment = SPIN_SEGMENTS[SPIN_INDEX[decision.segmentId]];

        const balanceUpdate = { $inc: {} };
        if (segment.type === "usdt") {
          balanceUpdate.$inc.usdtBalance = segment.amount;
        } else if (segment.type === "rdc") {
          balanceUpdate.$inc.balance = segment.amount;
          balanceUpdate.$inc.lifetimeEarned = segment.amount;
        } else if (segment.type === "free_spin") {
          balanceUpdate.$inc.spinsAvailable = 1;
        }
        const setFields = {};
        if (decision.setEarlyTarget) {
          setFields.earlyBonusSpinTarget = 20 + Math.floor(Math.random() * 11);
        }
        if (decision.markEarlyBonusGiven) {
          setFields.earlyBonusGiven = true;
        }
        if (Object.keys(setFields).length) {
          balanceUpdate.$set = setFields;
        }

        const finalUserResult = await users.findOneAndUpdate(
          { telegramId: uid },
          balanceUpdate,
          { returnDocument: "after" }
        );
        const finalUser = extractDoc(finalUserResult);

        await spinLogs.insertOne({
          telegramId: uid,
          network,
          segmentId: segment.id,
          lifetimeSpins,
          spunAt: new Date(),
        });

        return res.status(200).json({
          success: true,
          segmentId: segment.id,
          segmentIndex: SPIN_INDEX[segment.id],
          rewardType: segment.type,
          rewardAmount: segment.amount,
          spinsAvailable: finalUser ? finalUser.spinsAvailable : updatedUser.spinsAvailable,
          rdcBalance: finalUser ? finalUser.balance : undefined,
          usdtBalance: finalUser ? finalUser.usdtBalance : undefined,
        });
      } finally {
        inFlightRequests.delete(lockKey);
      }
    }

    // ========================= EXISTING AD-WATCH (unchanged) =========================
    if (!network || typeof network !== "string" || !AD_NETWORKS[network]) {
      return res.status(400).json({ error: "invalid request" });
    }

    const lockKey = `${uid}:${network}`;
    if (inFlightRequests.has(lockKey)) {
      return res.status(429).json({ error: "request already in progress" });
    }
    inFlightRequests.add(lockKey);

    try {
      const user = await users.findOne({ telegramId: uid });
      if (!user) return res.status(404).json({ error: "user not found" });

      const cfg = AD_NETWORKS[network];
      const startOfDay = getStartOfDay();

      const lastLog = await adLogs
        .find({ telegramId: uid, network })
        .sort({ watchedAt: -1 })
        .limit(1)
        .toArray();
      if (lastLog.length) {
        const elapsed = (Date.now() - new Date(lastLog[0].watchedAt).getTime()) / 1000;
        if (elapsed < cfg.cooldown) {
          return res.status(400).json({
            error: "cooldown",
            secondsLeft: Math.ceil(cfg.cooldown - elapsed),
          });
        }
      }

      const countToday = await adLogs.countDocuments({
        telegramId: uid,
        network,
        watchedAt: { $gte: startOfDay },
      });
      if (countToday >= cfg.limit) {
        return res.status(400).json({
          error: "limit",
          watchedToday: countToday,
          limit: cfg.limit,
          resetInSeconds: getSecondsUntilMidnight(),
        });
      }

      await adLogs.insertOne({ telegramId: uid, network, watchedAt: new Date() });

      await users.updateOne(
        { telegramId: uid },
        {
          $inc: {
            balance: cfg.reward,
            lifetimeEarned: cfg.reward,
            adsWatchedToday: 1,
            adsWatchedTotal: 1,
          },
        }
      );

      const newCount = countToday + 1;

      const updatedUser = await users.findOne({ telegramId: uid });
      if (
        updatedUser &&
        updatedUser.referredBy &&
        !updatedUser.step3Rewarded &&
        (updatedUser.adsWatchedTotal || 0) >= 25
      ) {
        // MULTI-ACCOUNT GUARD: same rule as the other two referral tiers —
        // if this account shares a device/IP with its referrer, skip the
        // RDC payout (the referral count was already recorded at step 1).
        const referrerUser = await users.findOne({ telegramId: updatedUser.referredBy });
        const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, updatedUser.lastIp);

        if (!sameDeviceAsReferrer) {
          await users.updateOne(
            { telegramId: updatedUser.referredBy },
            { $inc: { balance: 130, lifetimeEarned: 130, referralEarnings: 130 } }
          );
        }
        await users.updateOne({ telegramId: uid }, { $set: { step3Rewarded: true } });
      }

      return res.status(200).json({
        success: true,
        reward: cfg.reward,
        watchedToday: newCount,
        limit: cfg.limit,
        cooldownSeconds: cfg.cooldown,
        limitReached: newCount >= cfg.limit,
        resetInSeconds: newCount >= cfg.limit ? getSecondsUntilMidnight() : null,
      });
    } finally {
      inFlightRequests.delete(lockKey);
    }
  } catch (err) {
    console.error("[ERROR] earn.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
