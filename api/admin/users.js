const { getDb } = require("../_db");
const { checkAdmin, tgCall, EARN_MORE_KEYBOARD } = require("../_telegram");
const { ObjectId } = require("mongodb");

function isValidObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

// Same 2 withdraw method ids as api/withdraw.js's METHODS keys — duplicated
// here only to validate the "override_wallet_lock" action below (no shared
// module slot, same reason as the ads-config lists further down). Keep in
// sync with api/withdraw.js if a method is ever added/removed.
const WITHDRAW_METHOD_IDS = ["binance", "tonkeeper"];

// Same normalization api/withdraw.js uses for lock-matching (case/whitespace
// insensitive) — duplicated so an admin override lands on the exact same
// normalized value the lock-check on withdraw compares against.
function normalizeAddress(addr) {
  return addr.trim().toLowerCase();
}

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

// --- Ads Config (Set Ads panel) helpers — same "settings" collection/
// pattern as the weekly-contest helpers above, duplicated from api/earn.js
// on purpose for the same reason (no free serverless-function slot to add
// a shared module in). Keep these two lists in sync with api/earn.js if
// either ever changes. ---
const NETWORK_TYPE_IDS = ["monetag", "adsgram_daily", "adsgram", "adsgram_special", "usl_special", "adsgalaxy"];
const EARNING_SLOT_IDS = ["adsgram_daily", "adsgram_special", "monetag", "usl_special"];
// Same fallback as api/earn.js's PROMO_AD_NETWORK_DEFAULT — keep in sync.
const PROMO_AD_NETWORK_DEFAULT = "adsgram_special";
// Original hardcoded per-slot rewards from api/earn.js's AD_NETWORKS —
// duplicated here only as the seed/fallback value for a slot's reward, for
// the same "no shared module slot" reason as the lists above. Keep in sync
// with api/earn.js's AD_NETWORKS if either ever changes.
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
    await settings.updateOne(
      { _id: "ads_config" },
      { $setOnInsert: DEFAULT_ADS_CONFIG },
      { upsert: true }
    );
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

      // --- "Set Ads" panel: current admin-configured ad network setup
      // for the Spin wheel (before/after 10-hour pairs) and the Earning
      // section (which network + hidden flag per slot) ---
      if (req.query.action === "ads_config") {
        const config = await getAdsConfigAdmin(db);
        return res.status(200).json({ config, networkTypes: NETWORK_TYPE_IDS, earningSlots: EARNING_SLOT_IDS });
      }

      // --- WAL (Withdraw Address Lock) tab: most recent rejected reuse
      // attempts — someone whose account is locked to a different address
      // (or trying an address already locked to a different account) tried
      // to withdraw anyway. Logged in api/withdraw.js at the moment of
      // rejection (wal_logs collection). Capped to the latest 100, newest
      // first; usernames joined in from the users collection for display. ---
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
            // Set once an admin uses the "Change wallet to this" override
            // below for this exact attempt — lets the panel show it as
            // already handled instead of a still-actionable row.
            resolvedAt: a.resolvedAt || null,
            resolvedTo: a.resolvedTo || null,
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

      // --- "Refer Check" panel: given a UID or @username, find who
      // referred THAT user (the reverse of "Show Referrals", which finds
      // who a user referred). Fully separate from the main search (`q=`)
      // handler below on purpose — doesn't touch or change its behavior.
      if (req.query.action === "refer_check") {
        const q = req.query.q;
        if (!q || typeof q !== "string") {
          return res.status(400).json({ error: "query required" });
        }
        const trimmedQ = q.trim().slice(0, 100);
        if (!trimmedQ) {
          return res.status(400).json({ error: "query required" });
        }
        const asNumber = Number(trimmedQ);
        const filter = !isNaN(asNumber)
          ? { telegramId: asNumber }
          : { username: trimmedQ.replace("@", "") };
        const user = await users.findOne(filter);
        if (!user) return res.status(404).json({ error: "not found" });

        let referrer = null;
        if (user.referredBy) {
          const refUser = await users.findOne({ telegramId: user.referredBy });
          referrer = refUser
            ? {
                telegramId: refUser.telegramId,
                username: refUser.username || null,
                firstName: refUser.firstName || null,
              }
            : { telegramId: user.referredBy, username: null, firstName: null }; // referrer id set but account no longer found
        }

        return res.status(200).json({
          telegramId: user.telegramId,
          username: user.username || null,
          firstName: user.firstName || null,
          referrer,
        });
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

      // --- Duplicate-account count: how many OTHER accounts share this
      // user's lastIp — same signal renderMultiAcc()/multi-accounts.js
      // already uses, just scoped to a single user here for the search
      // card instead of listing every suspicious group. ---
      let duplicateAccountCount = 0;
      if (user.lastIp && user.lastIp !== "unknown") {
        const sameIpCount = await users.countDocuments({ lastIp: user.lastIp });
        duplicateAccountCount = Math.max(0, sameIpCount - 1);
      }

      // --- Total RDC deducted from balance via conversions (RDC -> USDT),
      // FEE INCLUDED. This is the gross rdcAmount stored on each conversion
      // doc — the actual amount subtracted from the user's RDC balance at
      // convert time, before the 25% CONVERT_FEE_PERCENT was taken out.
      // (The later withdraw step, USDT -> bKash/Binance/etc., has its own
      // fee fixed at 0 in api/withdraw.js, so nothing is lost there — the
      // conversion step is the only place RDC balance actually leaves.) ---
      const conversions = db.collection("conversions");
      const userConversions = await conversions
        .find({ telegramId: user.telegramId })
        .project({ rdcAmount: 1, _id: 0 })
        .toArray();
      const totalWithdrawnRDC = userConversions.reduce((sum, c) => sum + (Number(c.rdcAmount) || 0), 0);

      // --- How many withdrawals this user has taken so far (approved/
      // completed ones) + the total USDT paid out across them, for the
      // admin search card. ---
      const withdraws = db.collection("withdraws");
      const approvedWithdraws = await withdraws
        .find({ telegramId: user.telegramId, status: "approved" })
        .project({ amount: 1, _id: 0 })
        .toArray();
      const withdrawalsCount = approvedWithdraws.length;
      const totalWithdrawnUSDT = approvedWithdraws.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);

      // Never leak internal/sensitive fields (e.g. IP history, raw tokens) to admin UI unless needed
      return res.status(200).json({
        ...user,
        duplicateAccountCount,
        totalWithdrawnRDC,
        withdrawalsCount,
        totalWithdrawnUSDT,
      });
    }

    if (req.method === "POST") {
      // --- Update the "Set Ads" config: spin's before/after network pairs
      // and each earning slot's network + hidden flag. Validated against
      // the fixed id lists so a typo/garbage value can never end up
      // referencing a network type or slot that doesn't exist. ---
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
        if (!earning || typeof earning !== "object") {
          return res.status(400).json({ error: "invalid earning config" });
        }
        const cleanEarning = {};
        for (const slotId of EARNING_SLOT_IDS) {
          const slotCfg = earning[slotId];
          if (!slotCfg || !NETWORK_TYPE_IDS.includes(slotCfg.network)) {
            return res.status(400).json({ error: `invalid network for slot ${slotId}` });
          }
          // Reward is the RDC amount credited per watch for this slot.
          // Coerced to a number and rejected if it isn't a finite,
          // non-negative value — same guard isValidReward()/getAdsConfig()
          // apply on the read side, so an admin can never persist a reward
          // that later gets silently replaced by the fallback.
          const rewardNum = Number(slotCfg.reward);
          if (!isValidReward(rewardNum)) {
            return res.status(400).json({ error: `invalid reward for slot ${slotId}` });
          }
          cleanEarning[slotId] = { network: slotCfg.network, hidden: !!slotCfg.hidden, reward: rewardNum };
        }
        // Which ad network type plays for the promo "Redeem" button — same
        // pool as every other slot (NETWORK_TYPE_IDS), so the admin can pick
        // ANY connected ad network here, not just Adsgram. Falls back to the
        // default if missing/invalid so it can never be saved as garbage.
        let cleanPromoAdNetwork = PROMO_AD_NETWORK_DEFAULT;
        if (promoAdNetwork !== undefined) {
          if (!NETWORK_TYPE_IDS.includes(promoAdNetwork)) {
            return res.status(400).json({ error: "invalid promo ad network" });
          }
          cleanPromoAdNetwork = promoAdNetwork;
        }
        const settings = db.collection("settings");
        await settings.updateOne(
          { _id: "ads_config" },
          {
            $set: {
              spin: { before: spin.before, after: spin.after },
              earning: cleanEarning,
              promoAdNetwork: cleanPromoAdNetwork,
            },
          },
          { upsert: true }
        );
        console.log(`[ADMIN] Ads config updated by IP ${ip}`);
        return res.status(200).json({ success: true });
      }

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

      // --- Send a claimable "Gift" to a user: unlike the direct balance
      // adjust below (which credits silently, no UI on the user's side),
      // this creates a PENDING gift record. The RDC is only actually
      // credited once the user opens the bot and taps "Claim Gift" on the
      // popup card (see api/user.js GET/pendingGift + POST/claim_gift) —
      // this endpoint never touches balance directly. ---
      if (req.body?.action === "send_gift") {
        const { uid: giftUid, amount: giftAmount, reason: giftReason } = req.body || {};
        const giftUidNum = Number(giftUid);
        const giftAmountNum = Number(giftAmount);
        if (!Number.isFinite(giftUidNum)) {
          return res.status(400).json({ error: "invalid uid" });
        }
        if (!Number.isFinite(giftAmountNum) || giftAmountNum <= 0) {
          return res.status(400).json({ error: "invalid amount" });
        }
        // Same typo-protection ceiling as the direct balance adjust below.
        if (giftAmountNum > 1_000_000) {
          return res.status(400).json({ error: "amount exceeds safe limit" });
        }
        const targetUser = await users.findOne({ telegramId: giftUidNum });
        if (!targetUser) {
          return res.status(404).json({ error: "user not found" });
        }
        const reason =
          typeof giftReason === "string" && giftReason.trim()
            ? giftReason.trim().slice(0, 200)
            : "Just a gift 🎁";

        const gifts = db.collection("gifts");
        const giftDoc = {
          telegramId: giftUidNum,
          amount: giftAmountNum,
          reason,
          status: "pending",
          createdAt: new Date(),
        };
        const insertResult = await gifts.insertOne(giftDoc);

        console.log(
          `[ADMIN] Gift of ${giftAmountNum} RDC queued for telegramId ${giftUidNum} by IP ${ip}`
        );

        // Best-effort nudge so the user notices — never blocks the response
        // if Telegram delivery fails for any reason (blocked bot, etc.).
        tgCall("sendMessage", {
          chat_id: giftUidNum,
          text: `🎁 You've received a gift! Open the app to claim your *${giftAmountNum} RDC*.`,
          parse_mode: "Markdown",
          reply_markup: EARN_MORE_KEYBOARD,
        }).catch((e) => console.error("[WARN] Gift notify failed:", e.message));

        return res.status(200).json({ success: true, id: insertResult.insertedId });
      }

      // --- WAL tab override: "Change wallet to this" — for a user whose
      // account is locked to address A but who then tried address B (their
      // OWN mistake, e.g. a typo on the very first withdraw). Re-points
      // their permanent lock to B, discarding A entirely. From then on:
      //   - withdrawing to B (the new locked address) just works, same as
      //     any normal locked account — no special-casing needed there,
      //     the existing match check in api/withdraw.js already treats it
      //     as "their" address.
      //   - withdrawing to any OTHER address still gets rejected + logged
      //     to WAL as usual, so this is a one-time fix, not an unlock.
      // Refuses to run if B is already someone ELSE's locked address —
      // this is for fixing a user's own mistake, never for reassigning a
      // different account's address to them. ---
      if (req.body?.action === "override_wallet_lock") {
        const { telegramId, newAddress, newMethod, walLogId } = req.body || {};
        const uidNum = Number(telegramId);
        if (!Number.isFinite(uidNum)) {
          return res.status(400).json({ error: "invalid telegramId" });
        }
        if (typeof newAddress !== "string" || newAddress.trim().length < 3 || newAddress.trim().length > 200) {
          return res.status(400).json({ error: "invalid address" });
        }
        if (!WITHDRAW_METHOD_IDS.includes(newMethod)) {
          return res.status(400).json({ error: "invalid method" });
        }

        const normalizedNewAddress = normalizeAddress(newAddress);
        const lockedAddresses = db.collection("locked_withdraw_addresses");

        const conflictingLock = await lockedAddresses.findOne({ address: normalizedNewAddress });
        if (conflictingLock && String(conflictingLock.userId) !== String(uidNum)) {
          return res.status(409).json({
            error: `That address is already permanently locked to a different account (UID ${conflictingLock.userId}).`,
          });
        }

        try {
          await lockedAddresses.updateOne(
            { userId: uidNum },
            {
              $set: {
                address: normalizedNewAddress,
                method: newMethod,
                lockedAt: new Date(),
                overriddenByAdminIp: ip,
              },
            },
            { upsert: true }
          );
        } catch (e) {
          if (e.code === 11000) {
            // Someone else grabbed this exact address in the split second
            // between our check above and this write — fail safe.
            return res.status(409).json({ error: "That address was just locked to another account. Try again." });
          }
          throw e;
        }

        // Best-effort: mark the WAL log row that prompted this as resolved
        // so the panel stops showing it as still-needing-action. Never
        // blocks the response — the lock change above already succeeded
        // and is what actually matters.
        if (walLogId && isValidObjectId(walLogId)) {
          const walLogs = db.collection("wal_logs");
          walLogs
            .updateOne(
              { _id: new ObjectId(walLogId) },
              { $set: { resolvedAt: new Date(), resolvedTo: normalizedNewAddress } }
            )
            .catch((e) => console.error("[WAL] Failed to mark attempt resolved:", e.message));
        }

        console.log(
          `[ADMIN] Withdraw address lock overridden for telegramId ${uidNum}: now locked to "${normalizedNewAddress}" (${newMethod}), by IP ${ip}`
        );
        return res.status(200).json({ success: true });
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
