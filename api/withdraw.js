const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");
const { signAction, verifyActionToken } = require("./_actionSign");
const { applyCors } = require("./_utils");

const RDC_TO_USD = 0.00004;

const METHODS = {
  binance: { label: "Binance UID" },
  tonkeeper: { label: "Tonkeeper Address" },
};

// ---------- TIERED MINIMUM WITHDRAW (per admin request) ----------
// The minimum withdraw amount now depends on how many withdrawals this
// user has EVER submitted (a persistent counter, user.withdrawCount — NOT
// a live count of the `withdraws` collection, because approveWithdrawById
// caps/prunes old history down to the last 10 at approval time, so a live
// count would eventually under-count and let old users slide back to a
// lower tier). Applies to BOTH methods identically — there is no longer a
// per-method minimum.
// 1st withdrawal: $0.03, 2nd: $0.06, 3rd: $0.12, 4th: $0.16, 5th: $0.20,
// every withdrawal after the 5th stays fixed at $0.20.
const WITHDRAW_MIN_TIERS = [0.03, 0.06, 0.12, 0.16, 0.20];
function getMinWithdrawForNextRequest(withdrawCountSoFar) {
  const idx = Math.max(0, Number(withdrawCountSoFar) || 0);
  if (idx < WITHDRAW_MIN_TIERS.length) return WITHDRAW_MIN_TIERS[idx];
  return WITHDRAW_MIN_TIERS[WITHDRAW_MIN_TIERS.length - 1];
}

// ---------- SPIN-BASED WITHDRAW ALLOWANCE (replaces the old Key Coin gate) ----------
// A user must have spun the Spin Wheel at least MIN_LIFETIME_SPINS_REQUIRED
// times, ever (user.lifetimeSpins — see api/earn.js), before their FIRST
// withdrawal is allowed. This is a one-time lifetime threshold, not
// consumed per-withdrawal — once crossed, it stays satisfied forever.
const MIN_LIFETIME_SPINS_REQUIRED = 10;

// ---------- 48-HOUR WAIT FOR NEW USERS (first withdrawal only) ----------
// Applies ONLY to accounts created on/after this cutoff (i.e. users who
// join from now on) — anyone whose account already existed before this
// went live is grandfathered in and never subject to this wait, even on
// their first-ever withdrawal. user.createdAt already exists on every user
// document (set at account creation — see api/user.js), so no new field
// or migration is needed to know when someone joined.
const NEW_USER_WAIT_FEATURE_CUTOFF = new Date("2026-09-24T00:00:00.000Z");
const NEW_USER_WAIT_HOURS = 48;

function isSubjectToNewUserWait(user) {
  return !!(user.createdAt && new Date(user.createdAt) >= NEW_USER_WAIT_FEATURE_CUTOFF);
}
function newUserWaitStatus(user) {
  if (!isSubjectToNewUserWait(user)) {
    return { applicable: false, met: true, hoursLeft: 0 };
  }
  const elapsedMs = Date.now() - new Date(user.createdAt).getTime();
  const requiredMs = NEW_USER_WAIT_HOURS * 60 * 60 * 1000;
  if (elapsedMs >= requiredMs) return { applicable: true, met: true, hoursLeft: 0 };
  const hoursLeft = Math.ceil((requiredMs - elapsedMs) / (60 * 60 * 1000));
  return { applicable: true, met: false, hoursLeft };
}

// ---------- WITHDRAW ADDRESS FORMAT VALIDATION ----------
// Binance UID must be numeric only (Binance's own UID format — this is
// NOT an email/phone/username, just digits).
function isValidBinanceUid(addr) {
  return /^[0-9]{5,20}$/.test(addr.trim());
}
// TonKeeper / TON wallet address — accepts either on-chain form TonKeeper
// itself produces: the raw "<workchain>:<64 hex chars>" form, or the
// user-friendly base64url form (48 characters, e.g. starting EQ/UQ/kQ/0Q).
// Anything else (a random string, a Binance-style UID, an email, etc.) is
// rejected — this stops someone submitting an obviously-wrong address for
// the wrong wallet.
function isValidTonAddress(addr) {
  const trimmed = addr.trim();
  if (/^-?[0-9]+:[0-9a-fA-F]{64}$/.test(trimmed)) return true; // raw form
  if (/^[A-Za-z0-9_-]{48}$/.test(trimmed)) return true; // user-friendly form
  return false;
}
function isValidAddressForMethod(method, addr) {
  if (typeof addr !== "string") return false;
  if (method === "binance") return isValidBinanceUid(addr);
  if (method === "tonkeeper") return isValidTonAddress(addr);
  return false;
}

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

const CONVERT_FEE_PERCENT = 10; // was 25 — updated per product decision
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

// Spin-based withdraw allowance (replaces the old Key Coin gate): a user
// simply needs MIN_LIFETIME_SPINS_REQUIRED lifetime spins, ever, to be
// eligible — not consumed per withdrawal, so once true it stays true.
function computeSpinEligibility(lifetimeSpins) {
  const spins = Math.max(0, Number(lifetimeSpins) || 0);
  return {
    spinsCompleted: spins,
    spinsRequired: MIN_LIFETIME_SPINS_REQUIRED,
    spinsMet: spins >= MIN_LIFETIME_SPINS_REQUIRED,
  };
}

// Lifetime (all-time, no date filter) count of completed tasks across both
// task systems — regular approved submissions + special (channel-join) task
// completions. This is what MIN_LIFETIME_TASKS_REQUIRED is checked against.
//
// CHANGED: the regular-task half used to be a live
// `submissions.countDocuments({ status: "approved" })` — i.e. it re-derived
// the lifetime count from the raw task_submissions documents every single
// time. That becomes unsafe the moment approved submissions get a TTL (see
// api/_db.js — approved task_submissions now auto-delete 7 days after
// approval, per product decision): a user who finished their 5 tasks more
// than 7 days ago would suddenly fail this check on their NEXT withdrawal,
// even though they genuinely completed the requirement before. Reading
// user.tasksCompleted instead is safe because it's a durable counter
// incremented +1 exactly once per regular-task approval (see
// api/admin/tasks.js and the auto-approve path in api/task.js) and never
// decremented — it keeps the true lifetime total even after the underlying
// submission documents are cleaned up. (It only ever counts regular tasks,
// never special/channel-join ones — that's why specialTasksLifetime is
// still added separately below, unchanged.)
async function getLifetimeTasksCompleted(db, uid, regularTasksLifetime) {
  const specialTaskLogs = db.collection("special_task_logs");
  const specialTasksLifetime = await specialTaskLogs.countDocuments({ telegramId: uid });
  return regularTasksLifetime + specialTasksLifetime;
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
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
          getLifetimeTasksCompleted(db, uid, user.tasksCompleted || 0),
          adLogs.countDocuments({ telegramId: uid, watchedAt: { $gte: today } }),
        ]);
        // NOTE: "tasksToday" is kept as the field name for compatibility with
        // any existing frontend code reading this response, but it is now a
        // LIFETIME/CUMULATIVE count (never resets), not a daily count.

        const { spinsCompleted, spinsRequired, spinsMet } = computeSpinEligibility(user.lifetimeSpins || 0);
        const waitStatus = newUserWaitStatus(user);
        const withdrawCountSoFar = user.withdrawCount || 0;
        const minRequired = getMinWithdrawForNextRequest(withdrawCountSoFar);

        const tasksMet = tasksToday >= MIN_LIFETIME_TASKS_REQUIRED;
        const adsMet = adsToday >= MIN_ADS_REQUIRED_TODAY;

        // Signed action token (see api/_actionSign.js) for the withdraw
        // POST below to verify — sent as a header AND in JSON body for robust delivery.
        const withdrawActionToken = signAction(uid, "withdraw");
        if (withdrawActionToken) {
          res.setHeader("X-Action-Token", withdrawActionToken);
          res.setHeader("Access-Control-Expose-Headers", "X-Action-Token");
        }

        return res.status(200).json({
          tasksToday,
          tasksRequired: MIN_LIFETIME_TASKS_REQUIRED,
          tasksMet,
          adsToday,
          adsRequired: MIN_ADS_REQUIRED_TODAY,
          adsMet,
          spinsCompleted,
          spinsRequired,
          spinsMet,
          newUserWaitApplicable: waitStatus.applicable,
          newUserWaitMet: waitStatus.met,
          newUserWaitHoursLeft: waitStatus.hoursLeft,
          minRequired,
          withdrawNumber: withdrawCountSoFar + 1,
          canWithdraw: tasksMet && adsMet && spinsMet && waitStatus.met,
          _actionToken: withdrawActionToken,
        });
      }

      const withdrawActionToken = signAction(uid, "withdraw");
      if (withdrawActionToken) {
        res.setHeader("X-Action-Token", withdrawActionToken);
        res.setHeader("Access-Control-Expose-Headers", "X-Action-Token");
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

      // Signed-action check (see api/_actionSign.js) — verified from header or body
      const actionToken = req.headers["x-action-token"] || req.body?.actionToken;
      if (!verifyActionToken(actionToken, uid, "withdraw")) {
        return res.status(403).json({ error: "Please refresh and try again." });
      }

      if (!method || !address || !Number.isFinite(amount)) {
        return res.status(400).json({ error: "missing fields" });
      }
      if (!METHODS[method]) {
        return res.status(400).json({ error: "invalid method" });
      }
      // Binance UID must be numeric only; Tonkeeper must look like a real
      // TON address. Anything else is rejected before it ever reaches the
      // address-lock step below.
      if (!isValidAddressForMethod(method, address)) {
        return res.status(400).json({
          error:
            method === "binance"
              ? "Invalid Binance UID — it must contain numbers only."
              : "Invalid Tonkeeper address format.",
        });
      }

      const userForChecks = await users.findOne({ telegramId: uid });
      if (!userForChecks) return res.status(404).json({ error: "user not found" });

      // ---- TASK (LIFETIME) / AD (DAILY) / SPIN / NEW-USER-WAIT REQUIREMENTS ----
      // Checked BEFORE the address lock below so a request that would fail
      // one of these never ends up permanently locking the account/address.
      const todayForChecks = startOfToday();
      const [lifetimeTasksCompletedPre, adsTodayPre] = await Promise.all([
        getLifetimeTasksCompleted(db, uid, userForChecks.tasksCompleted || 0),
        adLogs.countDocuments({ telegramId: uid, watchedAt: { $gte: todayForChecks } }),
      ]);
      if (lifetimeTasksCompletedPre < MIN_LIFETIME_TASKS_REQUIRED) {
        return res.status(400).json({
          error: `Complete at least ${MIN_LIFETIME_TASKS_REQUIRED} tasks in total before withdrawing (you've completed ${lifetimeTasksCompletedPre} so far).`,
        });
      }
      if (adsTodayPre < MIN_ADS_REQUIRED_TODAY) {
        return res.status(400).json({
          error: `You need to watch at least ${MIN_ADS_REQUIRED_TODAY} ads today before withdrawing (you've watched ${adsTodayPre} today).`,
        });
      }
      const { spinsMet, spinsCompleted, spinsRequired } = computeSpinEligibility(userForChecks.lifetimeSpins || 0);
      if (!spinsMet) {
        return res.status(400).json({
          error: `Complete at least ${spinsRequired} spins on the Spin Wheel before withdrawing (you've done ${spinsCompleted} so far).`,
        });
      }
      const waitStatusPre = newUserWaitStatus(userForChecks);
      if (!waitStatusPre.met) {
        return res.status(400).json({
          error: `New accounts must wait 48 hours after joining before their first withdrawal. Please try again in about ${waitStatusPre.hoursLeft} hour(s).`,
        });
      }

      const withdrawCountSoFar = userForChecks.withdrawCount || 0;
      const min = getMinWithdrawForNextRequest(withdrawCountSoFar);
      if (amount < min || amount > MAX_WITHDRAW) {
        return res.status(400).json({ error: `Minimum withdraw for your ${withdrawCountSoFar + 1}${withdrawCountSoFar === 0 ? "st" : withdrawCountSoFar === 1 ? "nd" : withdrawCountSoFar === 2 ? "rd" : "th"} withdrawal is $${min}` });
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
          // Prefer the exact-case address the user originally typed
          // (originalAddress) over the lowercased `address` field, which
          // exists only for case-insensitive lock matching — see the
          // insertOne below. Falls back to `address` for any lock created
          // before originalAddress existed, so old records still display.
          lockedAddress: myLock.originalAddress || myLock.address,
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
            // Exact-case address as the user actually typed it, kept purely
            // for display in the admin panel (user detail card, WAL tab,
            // multi-account tab). `address` above stays lowercased/trimmed
            // and is what all matching + the unique index still use — this
            // field is additive only and never read for lock-matching logic.
            originalAddress: address.trim(),
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

      const user = userForChecks;

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

      // Bump the persistent withdrawCount exactly once, right after this
      // withdrawal actually succeeds — this is what the NEXT withdrawal's
      // tiered minimum (getMinWithdrawForNextRequest) is based on. Kept as
      // a persistent counter (not derived from counting withdraw request
      // documents) because approveWithdrawById prunes old history down to
      // the last 10 at approval time — a live count would eventually
      // under-count and incorrectly drop a user back to a lower tier.
      await users.updateOne({ telegramId: uid }, { $inc: { withdrawCount: 1 } });

      console.log(`[WITHDRAW] ${uid} requested $${amount} via ${method} (withdrawal #${withdrawCountSoFar + 1})`);

      // NOTE: the "keep last 10" history cap now lives in
      // approveWithdrawById() in api/_telegram.js, triggered at APPROVAL
      // time (not here at request-creation time) — see that function for
      // why.
      return res.status(200).json({ success: true, id: result.insertedId, fee, payout, usdValue });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] withdraw.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
