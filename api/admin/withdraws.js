// api/admin/withdraws.js
//
// MERGED ADMIN API — this ONE file (the old withdraws.js — repurposed
// rather than adding a brand-new file to the repo) now handles what used
// to be 5 separate serverless functions:
//   api/admin/withdraws.js       (this file, unchanged path)
//   api/admin/users.js           (deleted — merged in below)
//   api/admin/multi-accounts.js  (deleted — merged in below)
//   api/admin/tasks.js           (deleted — merged in below)
//   api/admin/promo.js           (deleted — merged in below)
//
// WHY: Vercel's Hobby plan caps a project at 12 Serverless Functions —
// this app was sitting at exactly 12. Every file directly under /api
// (that doesn't start with "_") becomes its own function, so 5 admin
// files = 5 of those 12 slots. Merging 4 of them INTO this existing file
// (instead of creating a new one) drops the total from 12 down to 8,
// freeing 4 slots, with zero new files added to the repo.
//
// HOW ROUTING WORKS NOW: instead of separate URLs like "/api/admin/users"
// and "/api/admin/tasks", every admin call now hits THIS route
// ("/api/admin/withdraws") with a `resource` query param telling it which
// of the 5 sections to run — e.g. "/api/admin/withdraws?resource=users".
// The frontend (public/admin.js) was updated in exactly ONE place (its
// shared api() helper) to rewrite the old-style paths into this new shape
// automatically — none of its ~27 individual call sites had to change.
//
// Everything below this point is each of the 5 old files' logic, moved
// in as-is (same validation, same collections, same responses) under a
// handleXxx(...) function — nothing about WHAT each resource does was
// changed, only how a request gets routed to it.

const { getDb } = require("../_db");
const {
  checkAdmin,
  tgCall,
  maybeRewardStep2Task,
  notifyIfValidReferral,
  EARN_MORE_KEYBOARD,
  enqueueBroadcast,
  drainBroadcastQueue,
  isValidObjectId,
  approveWithdrawById,
  rejectWithdrawById,
} = require("../_telegram");
const { ObjectId } = require("mongodb");

// One shared per-IP rate limiter for the whole merged file (previously
// each of the 5 files had its own separate bucket at 10-20/min). This is
// only a secondary guard — checkAdmin() below is still what actually
// gates access — so one shared 20/min-per-IP bucket across all admin
// actions combined is plenty.
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

// =======================================================================
// RESOURCE: withdraws   (was api/admin/withdraws.js)
// =======================================================================
async function handleWithdraws(req, res, db, ip) {
  const withdraws = db.collection("withdraws");
  const users = db.collection("users");

  if (req.method === "GET") {
    const allowedStatuses = ["pending", "approved", "rejected"];
    const filter =
      req.query.status && allowedStatuses.includes(req.query.status)
        ? { status: req.query.status }
        : {};
    const list = await withdraws.find(filter).sort({ createdAt: -1 }).limit(500).toArray();

    // Referral join-rate flag — see original file's comment: 70%+ of a
    // withdrawing user's referred accounts never joining is a referral-
    // farming signal, shown as a warning line under their name.
    const referrerIds = [...new Set(list.map((w) => w.telegramId).filter((id) => id != null))];
    const REFERRAL_CROSS_WARN_THRESHOLD = 70;
    let referralStatsById = new Map();
    if (referrerIds.length > 0) {
      const stats = await users
        .aggregate([
          { $match: { referredBy: { $in: referrerIds } } },
          {
            $group: {
              _id: "$referredBy",
              total: { $sum: 1 },
              notJoined: { $sum: { $cond: [{ $eq: ["$joined", true] }, 0, 1] } },
            },
          },
        ])
        .toArray();
      referralStatsById = new Map(stats.map((s) => [s._id, s]));
    }

    const listWithFlags = list.map((w) => {
      const stat = referralStatsById.get(w.telegramId);
      let referralCrossPercent = null;
      let referralSuspicious = false;
      if (stat && stat.total > 0) {
        referralCrossPercent = Math.round((stat.notJoined / stat.total) * 100);
        referralSuspicious = referralCrossPercent >= REFERRAL_CROSS_WARN_THRESHOLD;
      }
      return { ...w, referralCrossPercent, referralSuspicious };
    });

    return res.status(200).json(listWithFlags);
  }

  if (req.method === "POST") {
    const { id, action } = req.body || {};
    if (!isValidObjectId(id)) return res.status(400).json({ error: "invalid id" });
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "invalid action" });

    // Same shared function the bot's "💸 Withdraw" button calls — see
    // api/_telegram.js (moved there from a separate file, to avoid an extra file in the repo). Web panel and bot always behave identically.
    const result =
      action === "approve"
        ? await approveWithdrawById(db, id, { ip, source: "web-admin" })
        : await rejectWithdrawById(db, id, { ip, source: "web-admin" });

    if (!result.ok) return res.status(result.statusCode).json({ error: result.error });
    return res.status(200).json({ success: true });
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    if (!isValidObjectId(id)) return res.status(400).json({ error: "invalid id" });

    const existing = await withdraws.findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ error: "not found" });
    if (existing.status !== "rejected") {
      return res.status(400).json({ error: "only rejected withdraws can be deleted" });
    }

    await withdraws.deleteOne({ _id: new ObjectId(id) });
    console.log(`[ADMIN] Withdraw ${id} deleted by IP ${ip}`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// =======================================================================
// RESOURCE: users   (was api/admin/users.js)
// =======================================================================

// Same 2 withdraw method ids as api/withdraw.js's METHODS keys.
const WITHDRAW_METHOD_IDS = ["binance", "tonkeeper"];

function normalizeAddress(addr) {
  return addr.trim().toLowerCase();
}

const NETWORK_TYPE_IDS = ["monetag", "adsgram_daily", "adsgram", "adsgram_special", "usl_special", "adsgalaxy", "panda_daily"];
const EARNING_SLOT_IDS = ["adsgram_daily", "adsgram_special", "monetag", "usl_special"];
const PROMO_AD_NETWORK_DEFAULT = "adsgram_special";
const SLOT_REWARD_DEFAULTS = {
  adsgram_daily: 10,
  adsgram_special: 15,
  monetag: 10,
  usl_special: 10,
};
const DEFAULT_ADS_CONFIG = {
  spin: {
    before: ["monetag", "adsgram"],
    after: ["usl_special", "monetag"],
  },
  earning: {
    adsgram_daily: { network: "adsgram", hidden: false, reward: SLOT_REWARD_DEFAULTS.adsgram_daily },
    adsgram_special: { network: "adsgram", hidden: false, reward: SLOT_REWARD_DEFAULTS.adsgram_special },
    monetag: { network: "monetag", hidden: false, reward: SLOT_REWARD_DEFAULTS.monetag },
    usl_special: { network: "usl_special", hidden: false, reward: SLOT_REWARD_DEFAULTS.usl_special },
  },
  promoAdNetwork: PROMO_AD_NETWORK_DEFAULT,
};

function isValidReward(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

async function getAdsConfigAdmin(db) {
  const settings = db.collection("settings");
  let doc = await settings.findOne({ _id: "ads_config" });
  if (!doc) {
    await settings.updateOne({ _id: "ads_config" }, { $setOnInsert: DEFAULT_ADS_CONFIG }, { upsert: true });
    doc = await settings.findOne({ _id: "ads_config" });
  }
  const spin = {
    before: Array.isArray(doc.spin?.before) ? doc.spin.before : DEFAULT_ADS_CONFIG.spin.before,
    after: Array.isArray(doc.spin?.after) ? doc.spin.after : DEFAULT_ADS_CONFIG.spin.after,
  };
  const earning = {};
  for (const slotId of EARNING_SLOT_IDS) {
    const stored = doc.earning?.[slotId] || DEFAULT_ADS_CONFIG.earning[slotId];
    earning[slotId] = {
      network: stored.network,
      hidden: !!stored.hidden,
      reward: isValidReward(stored.reward) ? stored.reward : SLOT_REWARD_DEFAULTS[slotId],
    };
  }
  const promoAdNetwork =
    typeof doc.promoAdNetwork === "string" && NETWORK_TYPE_IDS.includes(doc.promoAdNetwork)
      ? doc.promoAdNetwork
      : PROMO_AD_NETWORK_DEFAULT;
  return { spin, earning, promoAdNetwork };
}

async function getContestStart(db) {
  const settings = db.collection("settings");
  let doc = await settings.findOne({ _id: "weekly_contest" });
  if (!doc) {
    await settings.updateOne({ _id: "weekly_contest" }, { $setOnInsert: { startedAt: new Date(0) } }, { upsert: true });
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
      { $lookup: { from: "users", localField: "_id", foreignField: "telegramId", as: "referrer" } },
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

async function handleUsers(req, res, db, ip) {
  const users = db.collection("users");

  if (req.method === "GET") {
    if (req.query.action === "all_referrers") {
      const all = await users.find({ referralsCount: { $gt: 0 } }).sort({ referralsCount: -1 }).limit(1000).toArray();
      return res.status(200).json(
        all.map((u) => ({
          telegramId: u.telegramId,
          username: u.username || null,
          firstName: u.firstName || null,
          referralsCount: u.referralsCount || 0,
        }))
      );
    }

    if (req.query.action === "ads_config") {
      const config = await getAdsConfigAdmin(db);
      return res.status(200).json({ config, networkTypes: NETWORK_TYPE_IDS, earningSlots: EARNING_SLOT_IDS });
    }

    if (req.query.action === "wal") {
      const walLogs = db.collection("wal_logs");
      const attempts = await walLogs.find({}).sort({ createdAt: -1 }).limit(100).toArray();
      const uids = [...new Set(attempts.map((a) => a.telegramId))];
      const attemptUsers = uids.length
        ? await users.find({ telegramId: { $in: uids } }).project({ telegramId: 1, username: 1, _id: 0 }).toArray()
        : [];
      const usernameByUid = new Map(attemptUsers.map((u) => [u.telegramId, u.username]));
      return res.status(200).json(
        attempts.map((a) => ({
          _id: a._id.toString(),
          telegramId: a.telegramId,
          username: usernameByUid.get(a.telegramId) || null,
          attemptedAddress: a.attemptedAddress,
          attemptedMethod: a.attemptedMethod,
          reason: a.reason,
          lockedAddress: a.lockedAddress || null,
          lockedMethod: a.lockedMethod || null,
          lockedToUserId: a.lockedToUserId || null,
          createdAt: a.createdAt,
          resolvedAt: a.resolvedAt || null,
          resolvedTo: a.resolvedTo || null,
        }))
      );
    }

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

    if (req.query.referredBy !== undefined) {
      const refByNum = Number(req.query.referredBy);
      if (!Number.isFinite(refByNum)) return res.status(400).json({ error: "invalid referredBy" });
      const referred = await users.find({ referredBy: refByNum }).sort({ createdAt: -1 }).limit(500).toArray();

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

    if (req.query.action === "refer_check") {
      const q = req.query.q;
      if (!q || typeof q !== "string") return res.status(400).json({ error: "query required" });
      const trimmedQ = q.trim().slice(0, 100);
      if (!trimmedQ) return res.status(400).json({ error: "query required" });
      const asNumber = Number(trimmedQ);
      const filter = !isNaN(asNumber) ? { telegramId: asNumber } : { username: trimmedQ.replace("@", "") };
      const user = await users.findOne(filter);
      if (!user) return res.status(404).json({ error: "not found" });

      let referrer = null;
      if (user.referredBy) {
        const refUser = await users.findOne({ telegramId: user.referredBy });
        referrer = refUser
          ? { telegramId: refUser.telegramId, username: refUser.username || null, firstName: refUser.firstName || null }
          : { telegramId: user.referredBy, username: null, firstName: null };
      }
      return res.status(200).json({
        telegramId: user.telegramId,
        username: user.username || null,
        firstName: user.firstName || null,
        referrer,
      });
    }

    const q = req.query.q;
    if (!q || typeof q !== "string") return res.status(400).json({ error: "query required" });
    const trimmedQ = q.trim().slice(0, 100);
    if (!trimmedQ) return res.status(400).json({ error: "query required" });
    const asNumber = Number(trimmedQ);
    const filter = !isNaN(asNumber) ? { telegramId: asNumber } : { username: trimmedQ.replace("@", "") };
    const user = await users.findOne(filter);
    if (!user) return res.status(404).json({ error: "not found" });

    let duplicateAccountCount = 0;
    if (user.lastIp && user.lastIp !== "unknown") {
      const sameIpCount = await users.countDocuments({ lastIp: user.lastIp });
      duplicateAccountCount = Math.max(0, sameIpCount - 1);
    }

    const conversions = db.collection("conversions");
    const userConversions = await conversions.find({ telegramId: user.telegramId }).project({ rdcAmount: 1, _id: 0 }).toArray();
    const totalWithdrawnRDC = userConversions.reduce((sum, c) => sum + (Number(c.rdcAmount) || 0), 0);

    // Reads the durable per-user counters (see approveWithdrawById in
    // api/_telegram.js) instead of live-summing approved withdraw
    // documents — those get pruned to the last 10 per user, so a live sum
    // would understate heavy withdrawers once pruning has removed anything.
    // NOTE: these counters only accumulate from the moment this shipped —
    // they won't reflect a user's approved withdraws from before that.
    const withdrawalsCount = user.lifetimeWithdrawalsCount || 0;
    const totalWithdrawnUSDT = user.lifetimeWithdrawnUSDT || 0;

    return res.status(200).json({ ...user, duplicateAccountCount, totalWithdrawnRDC, withdrawalsCount, totalWithdrawnUSDT });
  }

  if (req.method === "POST") {
    if (req.body?.action === "update_ads_config") {
      const { spin, earning, promoAdNetwork } = req.body || {};
      if (
        !spin ||
        !Array.isArray(spin.before) || spin.before.length !== 2 ||
        !Array.isArray(spin.after) || spin.after.length !== 2 ||
        ![...spin.before, ...spin.after].every((n) => NETWORK_TYPE_IDS.includes(n))
      ) {
        return res.status(400).json({ error: "invalid spin config" });
      }
      if (!earning || typeof earning !== "object") return res.status(400).json({ error: "invalid earning config" });
      const cleanEarning = {};
      for (const slotId of EARNING_SLOT_IDS) {
        const slotCfg = earning[slotId];
        if (!slotCfg || !NETWORK_TYPE_IDS.includes(slotCfg.network)) {
          return res.status(400).json({ error: `invalid network for slot ${slotId}` });
        }
        const rewardNum = Number(slotCfg.reward);
        if (!isValidReward(rewardNum)) return res.status(400).json({ error: `invalid reward for slot ${slotId}` });
        cleanEarning[slotId] = { network: slotCfg.network, hidden: !!slotCfg.hidden, reward: rewardNum };
      }
      let cleanPromoAdNetwork = PROMO_AD_NETWORK_DEFAULT;
      if (promoAdNetwork !== undefined) {
        if (!NETWORK_TYPE_IDS.includes(promoAdNetwork)) return res.status(400).json({ error: "invalid promo ad network" });
        cleanPromoAdNetwork = promoAdNetwork;
      }
      const settings = db.collection("settings");
      await settings.updateOne(
        { _id: "ads_config" },
        { $set: { spin: { before: spin.before, after: spin.after }, earning: cleanEarning, promoAdNetwork: cleanPromoAdNetwork } },
        { upsert: true }
      );
      console.log(`[ADMIN] Ads config updated by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    if (req.body?.action === "reset_weekly_contest") {
      const settings = db.collection("settings");
      const now = new Date();
      await settings.updateOne({ _id: "weekly_contest" }, { $set: { startedAt: now } }, { upsert: true });
      console.log(`[ADMIN] Weekly referral contest reset by IP ${ip} at ${now.toISOString()}`);
      return res.status(200).json({ success: true, startedAt: now });
    }

    if (req.body?.action === "send_gift") {
      const { uid: giftUid, amount: giftAmount, reason: giftReason } = req.body || {};
      const giftUidNum = Number(giftUid);
      const giftAmountNum = Number(giftAmount);
      if (!Number.isFinite(giftUidNum)) return res.status(400).json({ error: "invalid uid" });
      if (!Number.isFinite(giftAmountNum) || giftAmountNum <= 0) return res.status(400).json({ error: "invalid amount" });
      if (giftAmountNum > 1_000_000) return res.status(400).json({ error: "amount exceeds safe limit" });
      const targetUser = await users.findOne({ telegramId: giftUidNum });
      if (!targetUser) return res.status(404).json({ error: "user not found" });
      const reason = typeof giftReason === "string" && giftReason.trim() ? giftReason.trim().slice(0, 200) : "Just a gift 🎁";

      const gifts = db.collection("gifts");
      const giftDoc = { telegramId: giftUidNum, amount: giftAmountNum, reason, status: "pending", createdAt: new Date() };
      const insertResult = await gifts.insertOne(giftDoc);

      console.log(`[ADMIN] Gift of ${giftAmountNum} RDC queued for telegramId ${giftUidNum} by IP ${ip}`);

      tgCall("sendMessage", {
        chat_id: giftUidNum,
        text: `🎁 You've received a gift! Open the app to claim your *${giftAmountNum} RDC*.`,
        parse_mode: "Markdown",
        reply_markup: EARN_MORE_KEYBOARD,
      }).catch((e) => console.error("[WARN] Gift notify failed:", e.message));

      return res.status(200).json({ success: true, id: insertResult.insertedId });
    }

    if (req.body?.action === "override_wallet_lock") {
      const { telegramId, newAddress, newMethod, walLogId } = req.body || {};
      const uidNum = Number(telegramId);
      if (!Number.isFinite(uidNum)) return res.status(400).json({ error: "invalid telegramId" });
      if (typeof newAddress !== "string" || newAddress.trim().length < 3 || newAddress.trim().length > 200) {
        return res.status(400).json({ error: "invalid address" });
      }
      if (!WITHDRAW_METHOD_IDS.includes(newMethod)) return res.status(400).json({ error: "invalid method" });

      const normalizedNewAddress = normalizeAddress(newAddress);
      const lockedAddresses = db.collection("locked_withdraw_addresses");
      const conflictingLock = await lockedAddresses.findOne({ address: normalizedNewAddress });
      if (conflictingLock && String(conflictingLock.userId) !== String(uidNum)) {
        return res.status(409).json({ error: `That address is already permanently locked to a different account (UID ${conflictingLock.userId}).` });
      }

      try {
        await lockedAddresses.updateOne(
          { userId: uidNum },
          { $set: { address: normalizedNewAddress, method: newMethod, lockedAt: new Date(), overriddenByAdminIp: ip } },
          { upsert: true }
        );
      } catch (e) {
        if (e.code === 11000) {
          return res.status(409).json({ error: "That address was just locked to another account. Try again." });
        }
        throw e;
      }

      if (walLogId && isValidObjectId(walLogId)) {
        const walLogs = db.collection("wal_logs");
        walLogs
          .updateOne({ _id: new ObjectId(walLogId) }, { $set: { resolvedAt: new Date(), resolvedTo: normalizedNewAddress } })
          .catch((e) => console.error("[WAL] Failed to mark attempt resolved:", e.message));
      }

      console.log(`[ADMIN] Withdraw address lock overridden for telegramId ${uidNum}: now locked to "${normalizedNewAddress}" (${newMethod}), by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    const { uid, amount } = req.body || {};
    if (uid === undefined || uid === null || amount === undefined) return res.status(400).json({ error: "missing fields" });
    const uidNum = Number(uid);
    const amountNum = Number(amount);
    if (!Number.isFinite(uidNum)) return res.status(400).json({ error: "invalid uid" });
    if (!Number.isFinite(amountNum)) return res.status(400).json({ error: "invalid amount" });
    if (Math.abs(amountNum) > 1_000_000) return res.status(400).json({ error: "amount exceeds safe limit" });
    const result = await users.updateOne({ telegramId: uidNum }, { $inc: { balance: amountNum } });
    if (result.matchedCount === 0) return res.status(404).json({ error: "user not found" });
    console.log(`[ADMIN] Balance adjusted for telegramId ${uidNum}: ${amountNum > 0 ? "+" : ""}${amountNum} by IP ${ip}`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// =======================================================================
// RESOURCE: multi-accounts   (was api/admin/multi-accounts.js)
// =======================================================================
async function handleMultiAccounts(req, res, db, ip) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const users = db.collection("users");
  const lockedAddresses = db.collection("locked_withdraw_addresses");

  const groups = await users
    .aggregate([
      { $match: { lastIp: { $ne: null, $exists: true, $ne: "unknown" } } },
      {
        $group: {
          _id: "$lastIp",
          count: { $sum: 1 },
          accounts: {
            $push: { telegramId: "$telegramId", username: "$username", firstName: "$firstName", referralsCount: "$referralsCount", referredBy: "$referredBy" },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  const allTelegramIds = groups.flatMap((g) => g.accounts.map((a) => a.telegramId));
  const locks = allTelegramIds.length
    ? await lockedAddresses.find({ userId: { $in: allTelegramIds } }).project({ userId: 1, address: 1, method: 1, lockedAt: 1, _id: 0 }).toArray()
    : [];
  const lockByUserId = new Map(locks.map((l) => [String(l.userId), l]));

  const enrichedGroups = groups.map((g) => ({
    ip: g._id,
    accountCount: g.count,
    accounts: g.accounts.map((a) => {
      const lock = lockByUserId.get(String(a.telegramId));
      return { ...a, lockedWithdrawAddress: lock ? lock.address : null, lockedWithdrawMethod: lock ? lock.method : null, lockedAt: lock ? lock.lockedAt : null };
    }),
  }));

  return res.status(200).json(enrichedGroups);
}

// =======================================================================
// RESOURCE: tasks   (was api/admin/tasks.js)
// =======================================================================
async function handleTasks(req, res, db, ip) {
  const tasks = db.collection("tasks");
  const submissions = db.collection("task_submissions");
  const users = db.collection("users");
  const specialTasks = db.collection("special_tasks");

  if (req.method === "GET") {
    if (req.query.special === "1") {
      const list = await specialTasks.find({}).sort({ createdAt: -1 }).limit(500).toArray();
      return res.status(200).json(list);
    }
    if (req.query.submissions === "1") {
      const allowedStatuses = ["pending", "approved", "rejected"];
      const filter = req.query.status && allowedStatuses.includes(req.query.status) ? { status: req.query.status } : {};
      const list = await submissions.find(filter).sort({ createdAt: -1 }).limit(500).toArray();
      return res.status(200).json(list);
    }
    const list = await tasks.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    return res.status(200).json(list);
  }

  if (req.method === "POST") {
    if (req.body?.action === "backfill_referrals") {
      const step2Candidates = await users.find({ referredBy: { $ne: null, $exists: true }, step2Rewarded: { $ne: true } }).project({ telegramId: 1 }).toArray();
      let step2Checked = 0;
      for (const c of step2Candidates) {
        await maybeRewardStep2Task(db, users, c.telegramId);
        step2Checked++;
      }

      const validCandidates = await users
        .find({ referredBy: { $ne: null, $exists: true }, step1Rewarded: true, step2Rewarded: true, step3Rewarded: true, validReferralNotified: { $ne: true } })
        .project({ telegramId: 1 })
        .toArray();
      let validNotified = 0;
      for (const c of validCandidates) {
        const freshDoc = await users.findOne({ telegramId: c.telegramId });
        const before = freshDoc.validReferralNotified;
        await notifyIfValidReferral(users, freshDoc);
        if (!before) {
          const after = await users.findOne({ telegramId: c.telegramId }, { projection: { validReferralNotified: 1 } });
          if (after && after.validReferralNotified) validNotified++;
        }
      }

      console.log(`[ADMIN] Backfill referrals completed — step2 checked: ${step2Checked}, valid-referral notified: ${validNotified} — by IP ${ip}`);
      return res.status(200).json({ success: true, step2Checked, validNotified });
    }

    if (req.body?.submissionId) {
      const { submissionId, action } = req.body;
      if (!isValidObjectId(submissionId)) return res.status(400).json({ error: "invalid submissionId" });
      if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "invalid action" });

      const sub = await submissions.findOne({ _id: new ObjectId(submissionId) });
      if (!sub) return res.status(404).json({ error: "not found" });

      // Approved submissions are final — money has already been paid out,
      // and reversing that would need a balance decrement that isn't
      // implemented, so approved stays locked either way.
      if (sub.status === "approved") return res.status(400).json({ error: "already processed" });

      // Rejected submissions can only move to "approve" — this is the
      // undo path for an admin who rejected something by mistake (e.g.
      // already paid the user some other way and rejected in error).
      // Re-rejecting an already-rejected submission is a no-op error, not
      // a new action.
      if (sub.status === "rejected" && action === "reject") {
        return res.status(400).json({ error: "already processed" });
      }

      if (action === "approve") {
        const reward = Number(sub.reward);
        if (!Number.isFinite(reward) || reward < 0) {
          console.error(`[DATA ERROR] Invalid reward on submission ${sub._id}`);
          return res.status(400).json({ error: "invalid reward on submission" });
        }
        await users.updateOne({ telegramId: sub.telegramId }, { $inc: { balance: reward, lifetimeEarned: reward, tasksCompleted: 1, tasksDoneToday: 1 } });
        await submissions.updateOne(
          { _id: sub._id },
          // approvedAt mirrors the fix in api/admin/tasks.js's copy of this
          // same logic — keys the ttl_task_submissions_approved_7d TTL
          // index (api/_db.js), safe because withdraw eligibility reads the
          // durable user.tasksCompleted counter (incremented above), not
          // this collection directly. $unset processedAt since this
          // submission may be flipping from rejected -> approved, and
          // approved rows must never be picked up by the rejected-only
          // TTL index (task_submissions_rejected_ttl).
          { $set: { status: "approved", approvedAt: new Date() }, $unset: { processedAt: "" } }
        );
        await maybeRewardStep2Task(db, users, sub.telegramId);
      } else {
        await submissions.updateOne({ _id: sub._id }, { $set: { status: "rejected", processedAt: new Date() } });
      }

      console.log(`[ADMIN] Submission ${submissionId} ${action}d by IP ${ip} (was ${sub.status})`);
      return res.status(200).json({ success: true });
    }

    if (req.body?.taskType === "special") {
      const { title, description, reward, link, chatId, verificationType } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "missing or invalid title" });
      const rewardNum = Number(reward);
      if (!Number.isFinite(rewardNum) || rewardNum < 0) return res.status(400).json({ error: "invalid reward value" });
      if (!link || typeof link !== "string" || !link.trim()) return res.status(400).json({ error: "link is required" });
      if (!["verified", "normal"].includes(verificationType)) return res.status(400).json({ error: "verificationType must be 'verified' or 'normal'" });
      if (verificationType === "verified" && (!chatId || typeof chatId !== "string" || !chatId.trim())) {
        return res.status(400).json({ error: "chatId is required for verified tasks (e.g. @channelusername or -100...)" });
      }

      await specialTasks.insertOne({
        title: title.trim().slice(0, 200),
        description: typeof description === "string" ? description.slice(0, 2000) : "",
        reward: rewardNum,
        link: link.trim().slice(0, 500),
        chatId: verificationType === "verified" ? chatId.trim().slice(0, 200) : null,
        verificationType,
        active: true,
        createdAt: new Date(),
      });
      console.log(`[ADMIN] Special task created: "${title}" (${verificationType}) by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    const { title, description, reward, textFields, screenshotCount, link, code } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "missing or invalid title" });
    if (reward === undefined) return res.status(400).json({ error: "missing fields" });
    const rewardNum = Number(reward);
    if (!Number.isFinite(rewardNum) || rewardNum < 0) return res.status(400).json({ error: "invalid reward value" });
    const safeTextFields = Array.isArray(textFields) ? textFields.slice(0, 2).map((f) => (typeof f === "string" ? f.slice(0, 200) : "")) : [];

    await tasks.insertOne({
      title: title.trim().slice(0, 200),
      description: typeof description === "string" ? description.slice(0, 2000) : "",
      reward: rewardNum,
      textFields: safeTextFields,
      screenshotCount: Math.min(Math.max(Number(screenshotCount) || 0, 0), 2),
      link: typeof link === "string" ? link.trim().slice(0, 500) : "",
      code: typeof code === "string" ? code.trim().slice(0, 200) : "",
      active: true,
      createdAt: new Date(),
    });
    console.log(`[ADMIN] Task created: "${title}" by IP ${ip}`);
    return res.status(200).json({ success: true });
  }

  if (req.method === "DELETE") {
    // Permanently remove a rejected submission row (separate from deleting
    // a task/special-task definition below) — mirrors the "delete rejected
    // withdraw record" pattern in handleWithdraws above.
    if (req.body?.submissionId) {
      const { submissionId } = req.body;
      if (!isValidObjectId(submissionId)) return res.status(400).json({ error: "invalid submissionId" });

      const sub = await submissions.findOne({ _id: new ObjectId(submissionId) });
      if (!sub) return res.status(404).json({ error: "not found" });
      if (sub.status !== "rejected") {
        return res.status(400).json({ error: "only rejected submissions can be deleted" });
      }

      await submissions.deleteOne({ _id: new ObjectId(submissionId) });
      console.log(`[ADMIN] Submission ${submissionId} deleted by IP ${ip}`);
      return res.status(200).json({ success: true });
    }

    const { id, taskType } = req.body || {};
    if (!isValidObjectId(id)) return res.status(400).json({ error: "invalid id" });
    const collection = taskType === "special" ? specialTasks : tasks;
    const result = await collection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "task not found" });
    console.log(`[ADMIN] ${taskType === "special" ? "Special task" : "Task"} ${id} deleted by IP ${ip}`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// =======================================================================
// RESOURCE: promo   (was api/admin/promo.js)
// =======================================================================
function buildPromoBroadcastText(code, reward) {
  return (
    `🎉 *Congratulations!* 🎉\n\n` +
    `You have received ${reward} RDC ✅🎁\n\n` +
    `🔴 Redeem Code: "\`${code}\`"\n` +
    `📌 Tap the code to copy it instantly.\n\n` +
    `Don't miss it! 🚀`
  );
}

async function broadcastPromoCode(db, code, reward) {
  const text = buildPromoBroadcastText(code, reward);
  await enqueueBroadcast(db, { text, keyboard: EARN_MORE_KEYBOARD });
  const sentSoFar = await drainBroadcastQueue(db, 20000);
  const totalUsers = await db.collection("users").countDocuments({});
  return { sentSoFar, totalUsers };
}

function isValidCode(code) {
  return typeof code === "string" && /^[A-Z0-9_-]{3,30}$/i.test(code.trim());
}

async function handlePromo(req, res, db, ip) {
  const promos = db.collection("promocodes");
  const claims = db.collection("promo_claims");

  if (req.method === "GET") {
    if (req.query.code) {
      if (!isValidCode(req.query.code)) return res.status(400).json({ error: "invalid code format" });
      const list = await claims.find({ code: req.query.code.trim().toUpperCase() }).sort({ claimedAt: -1 }).limit(500).toArray();
      return res.status(200).json(list);
    }
    const list = await promos.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    return res.status(200).json(list);
  }

  if (req.method === "POST") {
    const { code, reward, limit } = req.body || {};
    if (!code || reward === undefined || !limit) return res.status(400).json({ error: "missing fields" });
    if (!isValidCode(code)) return res.status(400).json({ error: "invalid code format" });

    const rewardNum = Number(reward);
    const limitNum = Number(limit);
    if (!Number.isFinite(rewardNum) || rewardNum < 0 || !Number.isFinite(limitNum) || limitNum <= 0 || !Number.isInteger(limitNum)) {
      return res.status(400).json({ error: "invalid reward or limit value" });
    }

    const upperCode = code.trim().toUpperCase();
    const exists = await promos.findOne({ code: upperCode });
    if (exists) return res.status(400).json({ error: "code already exists" });

    await promos.insertOne({ code: upperCode, reward: rewardNum, limit: limitNum, usedCount: 0, createdAt: new Date() });
    console.log(`[ADMIN] Promo code created: ${upperCode} by IP ${ip}`);

    let sentSoFar = 0;
    let totalUsers = 0;
    try {
      ({ sentSoFar, totalUsers } = await broadcastPromoCode(db, upperCode, rewardNum));
    } catch (broadcastErr) {
      console.error("[ERROR] promo broadcast failed:", broadcastErr);
    }

    const remaining = Math.max(totalUsers - sentSoFar, 0);
    return res.status(200).json({ success: true, notified: sentSoFar, sentSoFar, totalUsers, remainingQueued: remaining });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// =======================================================================
// DISPATCHER
// =======================================================================
const HANDLERS = {
  withdraws: handleWithdraws,
  users: handleUsers,
  "multi-accounts": handleMultiAccounts,
  tasks: handleTasks,
  promo: handlePromo,
};

module.exports = async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";

    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    if (!checkAdmin(req)) {
      console.warn(`[SECURITY] Unauthorized admin access from IP: ${ip} (resource: ${req.query.resource})`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const handler = HANDLERS[req.query.resource];
    if (!handler) {
      return res.status(400).json({ error: "invalid or missing resource" });
    }

    const db = await getDb();
    return await handler(req, res, db, ip);
  } catch (err) {
    console.error("[ERROR] admin.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// promo's broadcast-drain step can run long on a big user base — keep the
// same raised timeout the old api/admin/promo.js had, now applied to the
// whole merged function (a POST to ?resource=promo is the only path that
// actually needs it; every other resource returns in well under a second).
module.exports.config = { maxDuration: 60 };
