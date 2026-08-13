const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

const RDC_TO_USD = 0.00004;

const METHODS = {
  binance: { min: +(2000 * RDC_TO_USD).toFixed(4), label: "Binance UID" },
  tonkeeper: { min: +(1600 * RDC_TO_USD).toFixed(4), label: "Tonkeeper Address" },
};

const CONVERT_FEE_PERCENT = 25;
const MIN_CONVERT = 500;
const MAX_CONVERT = 10_000_000; // sanity ceiling against typo/overflow-style abuse
const MAX_WITHDRAW = 100_000; // USD sanity ceiling

// Daily (calendar-day) requirements to be eligible to withdraw AT ALL —
// these reset naturally every day since they're computed from today's
// timestamped records (ad_logs / task_submissions), not from a counter
// that would need an explicit reset job.
const MIN_TASKS_REQUIRED_TODAY = 8;
const MIN_ADS_REQUIRED_TODAY = 10;

const GENERIC_WITHDRAW_LOCK_ERROR =
  "Withdraw request could not be processed. Please contact support.";

function isValidAddress(addr) {
  return typeof addr === "string" && addr.trim().length >= 3 && addr.trim().length <= 200;
}

// Normalize an address for lock-matching purposes only (case/whitespace
// insensitive) so a user can't bypass the lock by resubmitting the same
// address with different casing or stray spaces. The ORIGINAL address is
// still what gets stored on the withdraw record itself.
function normalizeAddress(addr) {
  return addr.trim().toLowerCase();
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Referral-based withdraw allowance: the 1st withdrawal ever is always
// free (no referral needed). Every withdrawal AFTER that requires 1 unused
// "valid referral" (validReferralsCount, incremented in
// notifyIfValidReferral once a referred user clears all 3 milestones — see
// api/_telegram.js). priorWithdrawals counts every withdraw this user has
// already submitted that wasn't rejected (pending + approved both count —
// a pending request already "spends" that slot so it can't be reused by
// submitting a second one while the first is still under review).
//
// Returns { firstWithdrawalUsed, validReferralsAvailable, referralEligible }.
function computeReferralEligibility(validReferralsCount, priorWithdrawals) {
  const firstWithdrawalUsed = priorWithdrawals > 0;
  if (!firstWithdrawalUsed) {
    return { firstWithdrawalUsed, validReferralsAvailable: validReferralsCount, referralEligible: true };
  }
  // Withdrawals after the free one that have already consumed a referral:
  const referralWithdrawalsUsed = priorWithdrawals - 1;
  const validReferralsAvailable = Math.max(0, validReferralsCount - referralWithdrawalsUsed);
  return {
    firstWithdrawalUsed,
    validReferralsAvailable,
    referralEligible: validReferralsAvailable > 0,
  };
}

module.exports = async (req, res) => {
  try {
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "unauthorized — invalid or missing Telegram session" });
    }
    const uid = verifiedUser.id;

    const db = await getDb();
    const users = db.collection("users");
    const withdraws = db.collection("withdraws");
    const lockedAddresses = db.collection("locked_withdraw_addresses");
    const adLogs = db.collection("ad_logs");
    const submissions = db.collection("task_submissions");

    if (req.method === "GET") {
      // ---- ELIGIBILITY STATUS (for the Withdraw modal's 3 status lines) ----
      if (req.query && req.query.eligibility === "1") {
        const user = await users.findOne({ telegramId: uid });
        if (!user) return res.status(404).json({ error: "user not found" });

        const today = startOfToday();
        const specialTaskLogs = db.collection("special_task_logs");
        const [regularTasksToday, specialTasksToday, adsToday, priorWithdrawals] = await Promise.all([
          submissions.countDocuments({ telegramId: uid, status: "approved", createdAt: { $gte: today } }),
          specialTaskLogs.countDocuments({ telegramId: uid, completedAt: { $gte: today } }),
          adLogs.countDocuments({ telegramId: uid, watchedAt: { $gte: today } }),
          withdraws.countDocuments({ telegramId: uid, status: { $in: ["pending", "approved"] } }),
        ]);
        // Both task systems count toward the daily requirement — the
        // "Task" nav page (channel-join / special tasks) and the Earning
        // tab's task cards (regular, text-field submissions) are both
        // "completing a task" from the user's point of view.
        const tasksToday = regularTasksToday + specialTasksToday;

        const validReferralsCount = user.validReferralsCount || 0;
        const { firstWithdrawalUsed, validReferralsAvailable, referralEligible } = computeReferralEligibility(
          validReferralsCount,
          priorWithdrawals
        );

        const tasksMet = tasksToday >= MIN_TASKS_REQUIRED_TODAY;
        const adsMet = adsToday >= MIN_ADS_REQUIRED_TODAY;

        return res.status(200).json({
          tasksToday,
          tasksRequired: MIN_TASKS_REQUIRED_TODAY,
          tasksMet,
          adsToday,
          adsRequired: MIN_ADS_REQUIRED_TODAY,
          adsMet,
          firstWithdrawalUsed,
          validReferralsAvailable,
          referralEligible,
          canWithdraw: tasksMet && adsMet && referralEligible,
        });
      }

      const history = await withdraws
        .find({ telegramId: uid })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      return res.status(200).json(
        history.map((w) => ({
          id: w._id,
          method: w.method,
          address: w.address,
          amount: w.amount,
          fee: w.fee,
          payout: w.payout,
          usdValue: w.usdValue,
          status: w.status,
          createdAt: w.createdAt,
        }))
      );
    }

    if (req.method === "POST") {
      // ---- CONVERT (RDC -> USDT) ----
      if (req.body?.action === "convert") {
        const conversions = db.collection("conversions");
        const amount = Number(req.body.amount);

        if (!Number.isFinite(amount) || amount < MIN_CONVERT || amount > MAX_CONVERT) {
          return res.status(400).json({
            error: `Amount must be between ${MIN_CONVERT} and ${MAX_CONVERT} RDC`,
          });
        }

        const grossUsd = +(amount * RDC_TO_USD).toFixed(4);
        const fee = +(grossUsd * (CONVERT_FEE_PERCENT / 100)).toFixed(4);
        const receivedUsdt = +(grossUsd - fee).toFixed(4);

        // Atomic balance-check-and-deduct: the $gte condition is evaluated by
        // MongoDB at update time, so two simultaneous convert requests can't
        // both pass a stale "balance >= amount" check done in application code.
        // Only one can actually decrement past zero.
        const updateResult = await users.updateOne(
          { telegramId: uid, balance: { $gte: amount } },
          { $inc: { balance: -amount, usdtBalance: receivedUsdt } }
        );

        if (updateResult.matchedCount === 0) {
          // Either user doesn't exist, or balance was insufficient at the atomic check
          const exists = await users.findOne({ telegramId: uid });
          if (!exists) return res.status(404).json({ error: "user not found" });
          return res.status(400).json({ error: "insufficient RDC balance" });
        }

        const user = await users.findOne({ telegramId: uid });
        const doc = {
          telegramId: uid,
          username: user?.username || null,
          rdcAmount: amount,
          grossUsd,
          fee,
          receivedUsdt,
          createdAt: new Date(),
        };
        const result = await conversions.insertOne(doc);

        console.log(`[CONVERT] ${uid} converted ${amount} RDC -> ${receivedUsdt} USDT`);
        return res.status(200).json({ success: true, id: result.insertedId, grossUsd, fee, receivedUsdt });
      }

      // ---- WITHDRAW ----
      const { method, address, amount: rawAmount } = req.body || {};
      const amount = Number(rawAmount);

      if (!method || !address || !Number.isFinite(amount)) {
        return res.status(400).json({ error: "missing fields" });
      }
      if (!METHODS[method]) {
        return res.status(400).json({ error: "invalid method" });
      }
      if (!isValidAddress(address)) {
        return res.status(400).json({ error: "invalid address/UID format" });
      }
      const min = METHODS[method].min;
      if (amount < min || amount > MAX_WITHDRAW) {
        return res.status(400).json({ error: `Minimum withdraw for ${method} is $${min}` });
      }

      // ---- WITHDRAW ADDRESS LOCK ----
      // Rule: 1 account can only ever withdraw to 1 address, and 1 address
      // can only ever be used by 1 account — permanently, once set.
      // Error messages are intentionally generic (not "address already
      // locked to another account" etc.) so the exact lock mechanism isn't
      // exposed to anyone probing the endpoint for a bypass.
      const normalizedAddress = normalizeAddress(address);

      // 1) Is this account already permanently locked to a DIFFERENT address?
      const myLock = await lockedAddresses.findOne({ userId: uid });
      if (myLock && myLock.address !== normalizedAddress) {
        console.warn(`[SECURITY] uid ${uid} tried to withdraw to a new address but is locked to a different one`);
        return res.status(403).json({ error: GENERIC_WITHDRAW_LOCK_ERROR });
      }

      // 2) Is this address already permanently locked to a DIFFERENT account?
      const addressLock = await lockedAddresses.findOne({ address: normalizedAddress });
      if (addressLock && String(addressLock.userId) !== String(uid)) {
        console.warn(`[SECURITY] uid ${uid} tried to use address already locked to uid ${addressLock.userId}`);
        return res.status(403).json({ error: GENERIC_WITHDRAW_LOCK_ERROR });
      }

      // 3) Neither side is locked yet -> create the lock now, atomically.
      // Relies on unique indexes on BOTH "address" and "userId" in
      // locked_withdraw_addresses, so even a race between two parallel
      // requests (same user, two tabs / same address, two accounts) can't
      // both succeed — the DB itself rejects the second insert.
      if (!myLock && !addressLock) {
        try {
          await lockedAddresses.insertOne({
            address: normalizedAddress,
            method,
            userId: uid,
            lockedAt: new Date(),
          });
          console.log(`[LOCK] address ${normalizedAddress} permanently locked to uid ${uid}`);
        } catch (e) {
          if (e.code === 11000) {
            // Someone else grabbed this address, or this account got locked
            // to a different address, in the split second between our
            // check above and this insert. Fail safe — reject the request.
            console.warn(`[SECURITY] Race blocked on withdraw-address lock for uid ${uid}, address ${normalizedAddress}`);
            return res.status(409).json({ error: GENERIC_WITHDRAW_LOCK_ERROR });
          }
          throw e;
        }
      }

      const user = await users.findOne({ telegramId: uid });
      if (!user) return res.status(404).json({ error: "user not found" });

      // ---- DAILY TASK / AD REQUIREMENTS (today, calendar day) ----
      const today = startOfToday();
      const specialTaskLogs = db.collection("special_task_logs");
      const [regularTasksToday, specialTasksToday, adsToday, priorWithdrawals] = await Promise.all([
        submissions.countDocuments({ telegramId: uid, status: "approved", createdAt: { $gte: today } }),
        specialTaskLogs.countDocuments({ telegramId: uid, completedAt: { $gte: today } }),
        adLogs.countDocuments({ telegramId: uid, watchedAt: { $gte: today } }),
        withdraws.countDocuments({ telegramId: uid, status: { $in: ["pending", "approved"] } }),
      ]);
      // Both task systems count — see the matching comment in the GET
      // eligibility endpoint above.
      const tasksToday = regularTasksToday + specialTasksToday;

      if (tasksToday < MIN_TASKS_REQUIRED_TODAY) {
        return res.status(400).json({
          error: `Complete at least ${MIN_TASKS_REQUIRED_TODAY} tasks today before withdrawing (you've completed ${tasksToday} today).`,
        });
      }
      if (adsToday < MIN_ADS_REQUIRED_TODAY) {
        return res.status(400).json({
          error: `You need to watch at least ${MIN_ADS_REQUIRED_TODAY} ads today before withdrawing (you've watched ${adsToday} today).`,
        });
      }

      // ---- REFERRAL-BASED WITHDRAW ALLOWANCE ----
      // 1st withdrawal ever is free; every one after that needs 1 unused
      // valid referral.
      const { referralEligible } = computeReferralEligibility(user.validReferralsCount || 0, priorWithdrawals);
      if (!referralEligible) {
        return res.status(400).json({
          error: "You need at least 1 valid referral to make another withdrawal. Invite friends and have them complete all 3 referral steps to unlock more.",
        });
      }

      // Atomic balance-check-and-deduct — same race-condition protection as convert above.
      // Prevents a user firing two withdraw requests in parallel and draining
      // more than their actual usdtBalance before either update commits.
      const updateResult = await users.updateOne(
        { telegramId: uid, usdtBalance: { $gte: amount } },
        { $inc: { usdtBalance: -amount } }
      );

      if (updateResult.matchedCount === 0) {
        return res.status(400).json({ error: "insufficient USDT balance" });
      }

      const fee = 0;
      const payout = amount;
      const usdValue = amount;
      const doc = {
        telegramId: uid,
        username: user.username,
        method,
        address: address.trim(),
        amount,
        fee,
        payout,
        usdValue,
        status: "pending",
        createdAt: new Date(),
      };
      const result = await withdraws.insertOne(doc);

      console.log(`[WITHDRAW] ${uid} requested $${amount} via ${method}`);
      return res.status(200).json({ success: true, id: result.insertedId, fee, payout, usdValue });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] withdraw.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
