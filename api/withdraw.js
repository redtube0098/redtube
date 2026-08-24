const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");

const RDC_TO_USD = 0.00004;

const METHODS = {
  binance: { min: +(2000 * RDC_TO_USD).toFixed(4), label: "Binance UID" },
  // Fixed minimum (not RDC-formula-derived) per admin request — Binance
  // above is untouched and still uses the RDC_TO_USD formula.
  tonkeeper: { min: 0.03, label: "Tonkeeper Address" },
};

// Floating point safety: usdtBalance is accumulated over many $inc calls
// (spin rewards like 0.005 / 0.01, convert credits, etc.). Binary floats
// can't represent most decimal fractions exactly, so after enough additions
// the value stored in Mongo can end up a hair below the "clean" number the
// frontend displays (e.g. 0.18999999999999997 instead of 0.19). A strict
// `$gte: amount` atomic check then intermittently rejects a withdrawal the
// user visibly has the balance for — and it starts "working" again only
// once further earnings push the real balance safely past the drift. BAL_EPS
// absorbs that drift in the comparison without weakening the atomicity of
// the check (the deducted amount is still exactly `amount`).
const BAL_EPS = 1e-6;

function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
}

const CONVERT_FEE_PERCENT = 25;
const MIN_CONVERT = 500;
const MAX_CONVERT = 10_000_000; // sanity ceiling against typo/overflow-style abuse
const MAX_WITHDRAW = 100_000; // USD sanity ceiling

// Task requirement is LIFETIME/CUMULATIVE (never resets day-to-day) — once
// a user has completed MIN_LIFETIME_TASKS_REQUIRED tasks total (ever, across
// both task systems), this requirement stays satisfied forever, even if
// those tasks were completed on different days or all in the past before
// this requirement existed. Ads stays a DAILY requirement (resets every
// calendar day) — computed from today's timestamped ad_logs.
const MIN_LIFETIME_TASKS_REQUIRED = 5;
const MIN_ADS_REQUIRED_TODAY = 10;

const GENERIC_WITHDRAW_LOCK_ERROR =
  "Withdraw request could not be processed. Please contact support.";

// Logs a rejected withdraw-address-lock attempt for the admin panel's WAL
// tab. Fire-and-forget-safe (caller doesn't await failure) — a logging
// hiccup must never turn into the user seeing a different/worse error than
// the generic lock message they were already about to get.
function logWalAttempt(walLogs, entry) {
  walLogs
    .insertOne({ ...entry, createdAt: new Date() })
    .catch((e) => console.error("[WAL] Failed to log lock attempt:", e.message));
}

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
// api/_telegram.js).
//
// Referral slot consumption is tracked with PERSISTENT counters on the user
// doc (freeWithdrawalUsed, referralsConsumed) instead of being derived from
// counting withdraw request documents. This means leftover test/pending/
// rejected withdraw requests never accidentally "eat" a referral slot — a
// slot is only ever consumed at the moment a withdrawal actually goes
// through successfully (see the POST handler below, right after
// withdraws.insertOne), exactly once per successful withdrawal.
//
// Returns { firstWithdrawalUsed, validReferralsAvailable, referralEligible }.
function computeReferralEligibility(validReferralsCount, freeWithdrawalUsed, referralsConsumed) {
  if (!freeWithdrawalUsed) {
    return { firstWithdrawalUsed: false, validReferralsAvailable: validReferralsCount, referralEligible: true };
  }
  const validReferralsAvailable = Math.max(0, validReferralsCount - (referralsConsumed || 0));
  return {
    firstWithdrawalUsed: true,
    validReferralsAvailable,
    referralEligible: validReferralsAvailable > 0,
  };
}

// Lifetime (all-time, no date filter) count of completed tasks across both
// task systems — regular approved submissions + special (channel-join) task
// completions. This is what MIN_LIFETIME_TASKS_REQUIRED is checked against.
async function getLifetimeTasksCompleted(db, uid) {
  const submissions = db.collection("task_submissions");
  const specialTaskLogs = db.collection("special_task_logs");
  const [regularTasksLifetime, specialTasksLifetime] = await Promise.all([
    submissions.countDocuments({ telegramId: uid, status: "approved" }),
    specialTaskLogs.countDocuments({ telegramId: uid }),
  ]);
  return regularTasksLifetime + specialTasksLifetime;
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
    // WAL = Withdraw Address Lock. Every rejected reuse attempt (case 1 or
    // case 2 below) gets logged here so the admin panel's WAL tab can show
    // them live — the generic error the USER sees never explains why, but
    // the admin can see exactly what happened.
    const walLogs = db.collection("wal_logs");

    if (req.method === "GET") {
      // ---- ELIGIBILITY STATUS (for the Withdraw modal's 3 status lines) ----
      if (req.query && req.query.eligibility === "1") {
        const user = await users.findOne({ telegramId: uid });
        if (!user) return res.status(404).json({ error: "user not found" });

        const today = startOfToday();
        const [tasksToday, adsToday] = await Promise.all([
          getLifetimeTasksCompleted(db, uid),
          adLogs.countDocuments({ telegramId: uid, watchedAt: { $gte: today } }),
        ]);
        // NOTE: "tasksToday" is kept as the field name for compatibility with
        // any existing frontend code reading this response, but it is now a
        // LIFETIME/CUMULATIVE count (never resets), not a daily count.

        const validReferralsCount = user.validReferralsCount || 0;
        const { firstWithdrawalUsed, validReferralsAvailable, referralEligible } = computeReferralEligibility(
          validReferralsCount,
          user.freeWithdrawalUsed || false,
          user.referralsConsumed || 0
        );

        const tasksMet = tasksToday >= MIN_LIFETIME_TASKS_REQUIRED;
        const adsMet = adsToday >= MIN_ADS_REQUIRED_TODAY;

        return res.status(200).json({
          tasksToday,
          tasksRequired: MIN_LIFETIME_TASKS_REQUIRED,
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
          { telegramId: uid, balance: { $gte: amount - BAL_EPS } },
          { $inc: { balance: -amount, usdtBalance: receivedUsdt } }
        );

        if (updateResult.matchedCount === 0) {
          // Either user doesn't exist, or balance was insufficient at the atomic check
          const exists = await users.findOne({ telegramId: uid });
          if (!exists) return res.status(404).json({ error: "user not found" });
          return res.status(400).json({ error: "insufficient RDC balance" });
        }

        // Self-heal: fold the tiny binary-float remainder back into a clean
        // 6-decimal number so drift doesn't keep compounding on every future
        // convert/withdraw. Purely cosmetic/precision cleanup — never
        // changes who is eligible for what, since BAL_EPS already covers it.
        const healed = await users.findOne({ telegramId: uid });
        if (healed) {
          const cleanBalance = roundMoney(healed.balance);
          const cleanUsdt = roundMoney(healed.usdtBalance);
          if (cleanBalance !== healed.balance || cleanUsdt !== healed.usdtBalance) {
            await users.updateOne(
              { telegramId: uid },
              { $set: { balance: cleanBalance, usdtBalance: cleanUsdt } }
            );
          }
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
        logWalAttempt(walLogs, {
          telegramId: uid,
          attemptedAddress: address.trim(),
          attemptedMethod: method,
          reason: "account_locked_to_different_address",
          lockedAddress: myLock.address,
          lockedMethod: myLock.method,
        });
        return res.status(403).json({ error: GENERIC_WITHDRAW_LOCK_ERROR });
      }

      // 2) Is this address already permanently locked to a DIFFERENT account?
      const addressLock = await lockedAddresses.findOne({ address: normalizedAddress });
      if (addressLock && String(addressLock.userId) !== String(uid)) {
        console.warn(`[SECURITY] uid ${uid} tried to use address already locked to uid ${addressLock.userId}`);
        logWalAttempt(walLogs, {
          telegramId: uid,
          attemptedAddress: address.trim(),
          attemptedMethod: method,
          reason: "address_locked_to_different_account",
          lockedToUserId: addressLock.userId,
        });
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

      // ---- TASK (LIFETIME) / AD (DAILY) REQUIREMENTS ----
      const today = startOfToday();
      const [lifetimeTasksCompleted, adsToday] = await Promise.all([
        getLifetimeTasksCompleted(db, uid),
        adLogs.countDocuments({ telegramId: uid, watchedAt: { $gte: today } }),
      ]);

      if (lifetimeTasksCompleted < MIN_LIFETIME_TASKS_REQUIRED) {
        return res.status(400).json({
          error: `Complete at least ${MIN_LIFETIME_TASKS_REQUIRED} tasks in total before withdrawing (you've completed ${lifetimeTasksCompleted} so far).`,
        });
      }
      if (adsToday < MIN_ADS_REQUIRED_TODAY) {
        return res.status(400).json({
          error: `You need to watch at least ${MIN_ADS_REQUIRED_TODAY} ads today before withdrawing (you've watched ${adsToday} today).`,
        });
      }

      // ---- REFERRAL-BASED WITHDRAW ALLOWANCE ----
      // 1st withdrawal ever is free; every one after that needs 1 unused
      // valid referral, tracked via the persistent counters on the user doc
      // (see computeReferralEligibility above) — NOT derived from counting
      // withdraw request documents, so leftover/rejected/test requests
      // never falsely consume a referral slot.
      const freeWithdrawalUsed = user.freeWithdrawalUsed || false;
      const referralsConsumed = user.referralsConsumed || 0;
      const { referralEligible } = computeReferralEligibility(
        user.validReferralsCount || 0,
        freeWithdrawalUsed,
        referralsConsumed
      );
      if (!referralEligible) {
        return res.status(400).json({
          error: "You need at least 1 valid referral to make another withdrawal. Invite friends and have them complete all 3 referral steps to unlock more.",
        });
      }

      // Atomic balance-check-and-deduct — same race-condition protection as convert above.
      // Prevents a user firing two withdraw requests in parallel and draining
      // more than their actual usdtBalance before either update commits.
      const updateResult = await users.updateOne(
        { telegramId: uid, usdtBalance: { $gte: amount - BAL_EPS } },
        { $inc: { usdtBalance: -amount } }
      );

      if (updateResult.matchedCount === 0) {
        return res.status(400).json({ error: "insufficient USDT balance" });
      }

      // Self-heal: clamp any leftover sub-cent float dust (e.g. -3e-9 after
      // an epsilon-tolerated deduction, or long-run binary drift) back to a
      // clean 6-decimal value so it never snowballs into a real discrepancy.
      const healedAfterWithdraw = await users.findOne({ telegramId: uid });
      if (healedAfterWithdraw) {
        let cleanUsdt = roundMoney(healedAfterWithdraw.usdtBalance);
        if (cleanUsdt < 0 && cleanUsdt > -BAL_EPS * 10) cleanUsdt = 0;
        if (cleanUsdt !== healedAfterWithdraw.usdtBalance) {
          await users.updateOne({ telegramId: uid }, { $set: { usdtBalance: cleanUsdt } });
        }
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

      // Mark the free withdrawal as used, OR consume one referral slot —
      // exactly once, right after this withdrawal actually succeeds. This
      // is the ONLY place these counters ever change, so a slot is spent
      // precisely once per successful withdrawal, regardless of how many
      // total withdraw request documents (pending/rejected/test) exist.
      if (!freeWithdrawalUsed) {
        await users.updateOne({ telegramId: uid }, { $set: { freeWithdrawalUsed: true } });
      } else {
        await users.updateOne({ telegramId: uid }, { $inc: { referralsConsumed: 1 } });
      }

      console.log(`[WITHDRAW] ${uid} requested $${amount} via ${method}`);
      return res.status(200).json({ success: true, id: result.insertedId, fee, payout, usdValue });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] withdraw.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
