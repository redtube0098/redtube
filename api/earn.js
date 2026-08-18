// api/earn.js
const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");
const { isSameDevice } = require("./_utils");
const { notifyIfValidReferral } = require("./_telegram");

// Earning section daily limits. All networks share the same 15-second
// per-watch cooldown. These keys are SLOT ids (fixed positions in the
// earning list) — which underlying ad NETWORK TYPE actually plays in each
// slot is admin-configurable (see ADS_CONFIG below) and independent of
// these limits, so reassigning a slot's network never touches its
// reward/limit/cooldown.
const AD_NETWORKS = {
  adsgram_daily: { reward: 10, limit: 5, cooldown: 15 },
  adsgram_special: { reward: 15, limit: 5, cooldown: 15 },
  monetag: { reward: 10, limit: 10, cooldown: 15 },
  usl_special: { reward: 10, limit: 10, cooldown: 15 },
};

// --- Admin-configurable ad network types --------------------------------
// The pool of actual ad SDKs that can be assigned to an earning slot or to
// a spin ad position. "adsgalaxy" has no live SDK wired in yet — it's a
// placeholder the admin can pick and leave hidden until the real SDK code
// is supplied.
const NETWORK_TYPE_IDS = ["monetag", "adsgram_daily", "adsgram", "adsgram_special", "usl_special", "adsgalaxy"];
const EARNING_SLOT_IDS = Object.keys(AD_NETWORKS);

const DEFAULT_ADS_CONFIG = {
  spin: {
    before: ["monetag", "adsgram"],
    after: ["usl_special", "monetag"],
  },
  earning: {
    adsgram_daily: { network: "adsgram", hidden: false },
    adsgram_special: { network: "adsgram", hidden: false },
    monetag: { network: "monetag", hidden: false },
    usl_special: { network: "usl_special", hidden: false },
  },
};

async function getAdsConfig(db) {
  const settings = db.collection("settings");
  let doc = await settings.findOne({ _id: "ads_config" });
  if (!doc) {
    await settings.updateOne(
      { _id: "ads_config" },
      { $setOnInsert: DEFAULT_ADS_CONFIG },
      { upsert: true }
    );
    doc = await settings.findOne({ _id: "ads_config" });
  }
  // Backfill any slot/field added after a config doc already existed, so
  // older stored docs don't crash on missing keys.
  const spin = {
    before: Array.isArray(doc.spin?.before) ? doc.spin.before : DEFAULT_ADS_CONFIG.spin.before,
    after: Array.isArray(doc.spin?.after) ? doc.spin.after : DEFAULT_ADS_CONFIG.spin.after,
  };
  const earning = {};
  for (const slotId of EARNING_SLOT_IDS) {
    earning[slotId] = doc.earning?.[slotId] || DEFAULT_ADS_CONFIG.earning[slotId];
  }
  return { spin, earning };
}

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

// Ad network pair shown before each spin, cycling within a batch. WHICH
// pair (before/after) is active depends on the user's batch parity — see
// getActiveSpinPair() below. Admin-configured via ADS_CONFIG.spin.

const SPINS_PER_BATCH = 15;
const SPIN_BATCH_COOLDOWN_HOURS = 10;
// Minimum gap between two individual spins within the same 15-spin batch —
// separate from, and in addition to, the 10-hour batch-level cooldown above.
const SPIN_COOLDOWN_SECONDS = 15;

// Picks which configured pair (before/after) applies for a given user right
// now: spinBatchNumber starts at 0 ("before") and increments by 1 every
// time a batch is reset, so it alternates before/after/before/after... each
// time the 10-hour cooldown elapses and a fresh batch starts.
function getActiveSpinPair(user, adsConfig) {
  const batchNumber = user.spinBatchNumber || 0;
  return batchNumber % 2 === 0 ? adsConfig.spin.before : adsConfig.spin.after;
}

// Normal-case weighted pool (used for every spin EXCEPT the milestone-forced
// USDT ones, and EXCEPT the guaranteed-every-70-spins RDC prize below).
// 10 RDC is by far the most common, 20 RDC noticeably less common.
// 30/40/50 RDC are NOT in this pool anymore — they only come from the
// guaranteed 70-spin cycle further down, so they never show up "early" by
// chance and never show up twice in the same 70-spin window either.
const NORMAL_SPIN_WEIGHTS = [
  { id: "rdc10", weight: 70 },  // most common
  { id: "rdc20", weight: 25 },  // less common than 10
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

// Pool used ONLY for the guaranteed 70-spin-cycle prize (see
// decideSpinReward below), for every occurrence AFTER the very first one.
// 30 RDC most likely among the three, 50 RDC least likely.
const RARE_RDC_WEIGHTS = [
  { id: "rdc30", weight: 60 },
  { id: "rdc40", weight: 30 },
  { id: "rdc50", weight: 10 },
];

function pickWeightedRareRdc() {
  const total = RARE_RDC_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const w of RARE_RDC_WEIGHTS) {
    if (r < w.weight) return w.id;
    r -= w.weight;
  }
  return RARE_RDC_WEIGHTS[0].id; // fallback, should never hit
}

// Decides the reward for this spin. lifetimeSpins is the count AFTER this
// spin (i.e. the value already atomically incremented), so "spin #1" means
// lifetimeSpins === 1 here. earlyBonusSpinTarget/earlyBonusGiven live on the
// user document (see below).
function decideSpinReward(lifetimeSpins, user) {
  if (lifetimeSpins === 1) {
    return { segmentId: "usdt_001", setEarlyTarget: true };
  }
  // One-time early bonus of $0.01 — now targeted between spin #50 and #60
  // (was #20-#30). The exact spin within that range is randomized per user
  // the same way as before, just shifted later.
  if (!user.earlyBonusGiven && lifetimeSpins >= (user.earlyBonusSpinTarget || 55)) {
    return { segmentId: "usdt_0025", markEarlyBonusGiven: true };
  }
  if (lifetimeSpins % 600 === 0) {
    return { segmentId: "usdt_0025" };
  }
  if (lifetimeSpins % 300 === 0) {
    return { segmentId: "usdt_001" };
  }
  // Guaranteed rare-RDC prize once every 70 spins (spin #70, #140, #210, ...
  // — one guaranteed hit inside every 70-spin window, not just an average).
  // The very first one (#70) is always 30 RDC; every one after that picks
  // randomly among 30/40/50 RDC (see RARE_RDC_WEIGHTS above).
  if (lifetimeSpins % 70 === 0) {
    if (lifetimeSpins === 70) {
      return { segmentId: "rdc30" };
    }
    return { segmentId: pickWeightedRareRdc() };
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

// ======================= ADSGALAXY REWARD CALLBACK =======================
// AdsGalaxy calls this URL server-to-server right after a user finishes
// watching an ad — it does NOT go through the Telegram webapp, so it can
// never carry Telegram init data. That's why this is routed BEFORE the
// verifyInitData check in module.exports below, and authenticated with a
// shared secret instead.
//
// Set this as the "reward callback" URL in the AdsGalaxy dashboard:
//   https://<your-domain>/api/earn?action=adsgalaxy_callback
// and set an ADSGALAXY_CALLBACK_SECRET env var in Vercel matching whatever
// secret you configure on AdsGalaxy's side (sent back as either the
// x-adsgalaxy-secret header or a ?secret= query param — whichever their
// dashboard supports). If the env var isn't set, the secret check is
// skipped (not recommended for production).
//
// Expected payload (AdsGalaxy -> us):
//   {
//     "event_id": "rwe_...",       // unique per reward event — used for idempotency
//     "request_id": "req_...",     // id of the ad request that completed
//     "mini_app_id": 123,
//     "user_id": "123456789",      // Telegram id of the user who watched
//     "status": "completed",       // only "completed" pays out
//     "completed_at": "2026-08-01T22:58:00Z"
//   }
async function handleAdsGalaxyCallback(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method not allowed" });
    }

    const expectedSecret = process.env.ADSGALAXY_CALLBACK_SECRET;
    if (expectedSecret) {
      const providedSecret = req.headers["x-adsgalaxy-secret"] || req.query.secret;
      if (providedSecret !== expectedSecret) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    const { event_id, request_id, mini_app_id, user_id, status, completed_at } = req.body || {};

    if (!event_id || typeof event_id !== "string" || !user_id || !status) {
      return res.status(400).json({ error: "invalid payload" });
    }

    // Only a "completed" watch is rewarded — anything else (skipped,
    // failed, closed early, etc.) is acknowledged but never paid out.
    if (status !== "completed") {
      return res.status(200).json({ success: true, credited: false, reason: "status not completed" });
    }

    const uid = String(user_id);

    const db = await getDb();
    const users = db.collection("users");
    const adLogs = db.collection("ad_logs");

    // Idempotency guard: ad networks commonly retry the same callback more
    // than once (timeouts, at-least-once delivery, etc.) — never pay out
    // the same event_id twice.
    const alreadyProcessed = await adLogs.findOne({ adsgalaxyEventId: event_id });
    if (alreadyProcessed) {
      return res.status(200).json({ success: true, credited: false, reason: "duplicate event" });
    }

    const user = await users.findOne({ telegramId: uid });
    if (!user) {
      return res.status(404).json({ error: "user not found" });
    }

    // AdsGalaxy has no fixed slot of its own — it plays wherever the admin
    // has assigned network "adsgalaxy" in the Set Ads panel. Find that slot
    // so the reward/limit already configured for it (AD_NETWORKS above)
    // applies, exactly like every other network.
    const adsConfig = await getAdsConfig(db);
    const slotId = EARNING_SLOT_IDS.find(
      (id) => adsConfig.earning[id] && adsConfig.earning[id].network === "adsgalaxy"
    );
    if (!slotId) {
      return res.status(200).json({ success: true, credited: false, reason: "adsgalaxy not assigned to a slot" });
    }

    const cfg = AD_NETWORKS[slotId];
    const startOfDay = getStartOfDay();
    const countToday = await adLogs.countDocuments({
      telegramId: uid,
      network: slotId,
      watchedAt: { $gte: startOfDay },
    });
    if (countToday >= cfg.limit) {
      // Server-verified completion, but today's cap for that slot is
      // already hit — acknowledge without paying out twice.
      return res.status(200).json({ success: true, credited: false, reason: "daily limit reached" });
    }

    await adLogs.insertOne({
      telegramId: uid,
      network: slotId,
      watchedAt: new Date(),
      adsgalaxyEventId: event_id,
      adsgalaxyRequestId: request_id || null,
      adsgalaxyMiniAppId: mini_app_id || null,
      adsgalaxyCompletedAt: completed_at ? new Date(completed_at) : new Date(),
    });

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

    // Same referral tier-3 payout rule as the regular (client-driven)
    // ad-watch flow further down this file.
    const updatedUser = await users.findOne({ telegramId: uid });
    if (
      updatedUser &&
      updatedUser.referredBy &&
      !updatedUser.step3Rewarded &&
      (updatedUser.adsWatchedTotal || 0) >= 25
    ) {
      const referrerUser = await users.findOne({ telegramId: updatedUser.referredBy });
      const sameDeviceAsReferrer = referrerUser && isSameDevice(referrerUser.lastIp, updatedUser.lastIp);
      if (!sameDeviceAsReferrer) {
        await users.updateOne(
          { telegramId: updatedUser.referredBy },
          { $inc: { balance: 130, lifetimeEarned: 130, referralEarnings: 130 } }
        );
      }
      await users.updateOne({ telegramId: uid }, { $set: { step3Rewarded: true } });

      const freshReferredUser = await users.findOne({ telegramId: uid });
      await notifyIfValidReferral(users, freshReferredUser);
    }

    console.log(`[ADSGALAXY] Credited ${cfg.reward} RDC to user ${uid} for event ${event_id} (slot ${slotId})`);
    return res.status(200).json({ success: true, credited: true, reward: cfg.reward, slot: slotId });
  } catch (err) {
    console.error("[ERROR] earn.js adsgalaxy_callback:", err);
    return res.status(500).json({ error: "internal server error" });
  }
}

module.exports = async (req, res) => {
  // AdsGalaxy's server-to-server reward callback — routed first since it
  // carries no Telegram init data and uses its own secret-based auth
  // instead (see handleAdsGalaxyCallback above).
  if (req.query && req.query.action === "adsgalaxy_callback") {
    return handleAdsGalaxyCallback(req, res);
  }

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
    const adsConfig = await getAdsConfig(db);

    // ============================= GET =============================
    if (req.method === "GET") {
      // --- Spin Wheel status ---
      if (req.query && req.query.type === "spin") {
        let user = await users.findOne({ telegramId: uid });
        if (!user) return res.status(404).json({ error: "user not found" });

        // If the batch was exhausted and the cooldown has since fully
        // elapsed, reset it here too — not only in the POST /spin handler.
        // Without this, once spinsAvailable hits 0 the Spin button is
        // disabled client-side (spinsAvailable > 0 check), so the user can
        // never click it again to reach the POST-side reset — they'd be
        // stuck forever even after "0h 0m" is shown.
        if ((user.spinsAvailable ?? SPINS_PER_BATCH) <= 0 && user.spinsExhaustedAt) {
          const elapsedMs = Date.now() - new Date(user.spinsExhaustedAt).getTime();
          if (elapsedMs >= SPIN_BATCH_COOLDOWN_HOURS * 3600 * 1000) {
            const cooldownCutoff = new Date(Date.now() - SPIN_BATCH_COOLDOWN_HOURS * 3600 * 1000);
            const reset = await users.findOneAndUpdate(
              {
                telegramId: uid,
                spinsAvailable: { $lte: 0 },
                spinsExhaustedAt: { $lte: cooldownCutoff },
              },
              { $set: { spinsAvailable: SPINS_PER_BATCH, spinsExhaustedAt: null }, $inc: { spinBatchNumber: 1 } },
              { returnDocument: "after" }
            );
            const resetUser = extractDoc(reset);
            if (resetUser) user = resetUser;
          }
        }

        const spinsAvailable = user.spinsAvailable ?? SPINS_PER_BATCH;
        let cooldownSecondsLeft = 0;
        if (spinsAvailable <= 0 && user.spinsExhaustedAt) {
          const elapsed = (Date.now() - new Date(user.spinsExhaustedAt).getTime()) / 1000;
          cooldownSecondsLeft = Math.max(0, Math.ceil(SPIN_BATCH_COOLDOWN_HOURS * 3600 - elapsed));
        }

        // Per-spin cooldown, independent of the batch cooldown.
        let spinCooldownSecondsLeft = 0;
        const lastSpinLog = await spinLogs.find({ telegramId: uid }).sort({ spunAt: -1 }).limit(1).toArray();
        if (lastSpinLog.length) {
          const elapsedSinceLastSpin = (Date.now() - new Date(lastSpinLog[0].spunAt).getTime()) / 1000;
          spinCooldownSecondsLeft = Math.max(0, Math.ceil(SPIN_COOLDOWN_SECONDS - elapsedSinceLastSpin));
        }

        const activePair = getActiveSpinPair(user, adsConfig);
        const usedInBatch = SPINS_PER_BATCH - spinsAvailable;
        const nextNetwork = activePair[((usedInBatch % activePair.length) + activePair.length) % activePair.length];

        return res.status(200).json({
          spinsAvailable: Math.max(0, spinsAvailable),
          spinsPerBatch: SPINS_PER_BATCH,
          cooldownSecondsLeft,
          spinCooldownSecondsLeft,
          nextNetwork: spinsAvailable > 0 ? nextNetwork : null,
          rdcBalance: user.balance || 0,
          usdtBalance: user.usdtBalance || 0,
        });
      }

      // --- Existing ad-network status ---
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
      // Underscore-prefixed key so it can't collide with any real slot id —
      // tells the client which network type + hide flag each slot uses.
      result._config = adsConfig.earning;
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
            { $set: { spinsAvailable: SPINS_PER_BATCH, spinsExhaustedAt: null }, $inc: { spinBatchNumber: 1 } }
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

        // Per-spin cooldown — enforced server-side so it can't be bypassed
        // by skipping the client-side countdown.
        const lastSpinLog = await spinLogs.find({ telegramId: uid }).sort({ spunAt: -1 }).limit(1).toArray();
        if (lastSpinLog.length) {
          const elapsedSinceLastSpin = (Date.now() - new Date(lastSpinLog[0].spunAt).getTime()) / 1000;
          if (elapsedSinceLastSpin < SPIN_COOLDOWN_SECONDS) {
            return res.status(400).json({
              error: "spin_cooldown",
              secondsLeft: Math.ceil(SPIN_COOLDOWN_SECONDS - elapsedSinceLastSpin),
            });
          }
        }

        const activePair = getActiveSpinPair(preCheck, adsConfig);
        const usedInBatch = SPINS_PER_BATCH - spinsAvailablePre;
        const expectedNetwork = activePair[usedInBatch % activePair.length];
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
          // Randomized between spin #50 and #60 (inclusive).
          setFields.earlyBonusSpinTarget = 50 + Math.floor(Math.random() * 11);
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

        // "Valid referral" (all 3 tiers cleared) notification — only tier 3
        // completing here, so this only actually fires once tiers 1 and 2
        // have ALSO completed for this same referred user (see
        // api/user.js and api/task.js for the other two calls).
        const freshReferredUser = await users.findOne({ telegramId: uid });
        await notifyIfValidReferral(users, freshReferredUser);
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
