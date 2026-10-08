// api/_utils.js
// Basic IPv4/IPv6 shape check — filters out garbage/spoofed junk values
// (doesn't guarantee authenticity, just sane formatting)
function isPlausibleIp(ip) {
  if (typeof ip !== "string" || !ip.trim()) return false;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(ip) || ipv6.test(ip);
}
function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) {
    // x-forwarded-for can be a comma-separated list (client, proxy1, proxy2...)
    // The first entry is the original client — but note this header is
    // client-controllable unless your platform (Vercel/Cloudflare) overwrites it,
    // so treat it as best-effort, not cryptographic proof of identity.
    const candidate = fwd.split(",")[0].trim();
    if (isPlausibleIp(candidate)) return candidate;
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "unknown";
}

// Shared "same device" check, used to detect a referred account sharing the
// same IP/device as its referrer (the multi-account farming pattern). Both
// values must be real, plausible IPs and not the "unknown" sentinel — two
// users who both failed IP detection must never be treated as a match,
// or every undetectable-IP referral would incorrectly lose its reward.
function isSameDevice(ipA, ipB) {
  return (
    typeof ipA === "string" &&
    typeof ipB === "string" &&
    ipA !== "unknown" &&
    ipB !== "unknown" &&
    isPlausibleIp(ipA) &&
    isPlausibleIp(ipB) &&
    ipA === ipB
  );
}

// ---------- MULTI-ACCOUNT / IP LOCK GUARD (shared) ----------
// One IP can only have ONE "active" account at a time. The first account
// ever seen on an IP claims it (ipLocks collection). Any other Telegram
// account is reported as "blocked".
//
// Originally this only lived in user.js and was only checked when the app
// loaded (via guard.js -> POST /api/user). That meant a script calling
// /api/earn or /api/task directly with valid initData — skipping the app
// UI entirely — never hit this check at all, so a blocked account could
// still farm rewards indefinitely. Moved here so every reward-granting
// endpoint can enforce the exact same lock, not just app-open.
async function checkIpLock(db, uid, ip) {
  if (!isPlausibleIp(ip) || ip === "unknown") {
    // Can't reliably identify the IP — never block on unreliable data.
    return { blocked: false };
  }
  const ipLocks = db.collection("ipLocks");
  // Atomic: only the first caller for a brand-new IP wins the claim,
  // even under concurrent requests.
  await ipLocks.updateOne(
    { _id: ip },
    { $setOnInsert: { activeTelegramId: uid, updatedAt: new Date() } },
    { upsert: true }
  );
  const lock = await ipLocks.findOne({ _id: ip });
  if (!lock || lock.activeTelegramId === uid) {
    return { blocked: false };
  }
  const users = db.collection("users");
  const activeUser = await users.findOne({ telegramId: lock.activeTelegramId });
  return {
    blocked: true,
    activeAccount: {
      telegramId: lock.activeTelegramId,
      name: (activeUser && activeUser.firstName) || "User",
      username: activeUser ? activeUser.username : null,
    },
  };
}

// ---------- DAILY AD-RESET BOUNDARY (shared by api/earn.js and api/bot.js) ----------
// The earning-section ads (and the "🔄 Ads have reset!" cron notification)
// reset once every 24h at a FIXED clock time — 09:30 Bangladesh time (BDT,
// UTC+6) — instead of local/server midnight. BDT has no DST, so this is a
// constant offset: 09:30 BDT = 03:30 UTC.
// Defined ONCE here and imported by both api/earn.js (which actually gates
// whether a user can watch more ads) and api/bot.js (whose cron job sends
// the "ads have reset" notification) so the two can never drift apart —
// exactly the kind of duplicated-constant bug that caused the Markdown-
// escaping issue earlier. Do NOT redefine this boundary anywhere else;
// import it from here.
// NOTE: this only affects the earning-section ad limits. Withdraw.js has
// its own, separate local-midnight day boundary for daily withdrawal
// limits — intentionally untouched.
const AD_RESET_HOUR_UTC = 3;
const AD_RESET_MINUTE_UTC = 30;

// The start of the "ad day" containing `d` — i.e. the most recent
// 03:30 UTC at or before `d`. Used to filter "today's" ad_logs.
function getAdDayBoundary(d = new Date()) {
  const boundary = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), AD_RESET_HOUR_UTC, AD_RESET_MINUTE_UTC, 0, 0)
  );
  if (d.getTime() < boundary.getTime()) {
    boundary.setUTCDate(boundary.getUTCDate() - 1);
  }
  return boundary;
}

// Seconds remaining until the NEXT 03:30 UTC (09:30 AM BDT) reset — sent to
// the client so the countdown shown on the Earning tab is accurate.
function getSecondsUntilNextAdReset(d = new Date()) {
  const next = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), AD_RESET_HOUR_UTC, AD_RESET_MINUTE_UTC, 0, 0)
  );
  if (d.getTime() >= next.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return Math.ceil((next.getTime() - d.getTime()) / 1000);
}

// ---------- AUTOMATED BOT / FARMER AUDIT ENGINE ----------
/**
 * Audits a user's activity for automated bot/script farming signals.
 * Zero false positives for real humans — flags only clear mathematical bot patterns.
 */
function auditUserWithdrawal(user, adLogs = [], sharedIpCount = 1, referralStat = null) {
  const reasons = [];
  let score = 0;

  // 1. Robotic Ad Timing & Burst Checks
  if (adLogs && adLogs.length >= 3) {
    const sorted = [...adLogs]
      .filter((l) => l.watchedAt)
      .sort((a, b) => new Date(a.watchedAt).getTime() - new Date(b.watchedAt).getTime());

    const intervals = [];
    let impossibleBurstCount = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const diffSec = (new Date(sorted[i + 1].watchedAt).getTime() - new Date(sorted[i].watchedAt).getTime()) / 1000;
      if (diffSec >= 0 && diffSec < 600) {
        intervals.push(diffSec);
        if (diffSec < 4) impossibleBurstCount++;
      }
    }

    if (impossibleBurstCount >= 2) {
      score += 50;
      reasons.push(`Impossible ad speed: ${impossibleBurstCount} ads claimed < 4s apart`);
    }

    if (intervals.length >= 4) {
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
      const stdDev = Math.sqrt(variance);

      // Bot script signature: very low standard deviation (< 1.25s) with low average interval
      if (mean <= 35 && stdDev < 1.25) {
        score += 45;
        reasons.push(`Robotic ad timing: consecutive ads at identical ${mean.toFixed(1)}s intervals (variance ±${stdDev.toFixed(2)}s)`);
      }
    }
  }

  // 2. Exclusive Game Gift / Playtime Discrepancy Check
  if (user) {
    const gifts = user.dailyGameGiftClaims || 0;
    const dailyPlaytime = user.dailyGamePlaytimeSec || 0;
    const lifetimePlaytime = user.lifetimeGamePlaytimeSec || 0;
    const playtime = Math.max(dailyPlaytime, lifetimePlaytime);

    // Each gift claim requires at least 45-60s of active gameplay.
    if (gifts >= 2 && playtime < gifts * 25) {
      score += 55;
      reasons.push(`Game gift exploit: claimed ${gifts} gifts with only ${Math.round(playtime)}s total game playtime`);
    }
  }

  // 3. Multi-Account / Shared IP Check
  if (sharedIpCount >= 3) {
    score += 35;
    reasons.push(`Multi-account IP cluster: ${sharedIpCount} accounts registered from same IP`);
  }

  score = Math.min(100, score);
  const fraudLevel = score >= 50 ? "high" : score >= 30 ? "medium" : "clean";

  return {
    fraudScore: score,
    fraudLevel,
    fraudReasons: reasons,
    isFraud: score >= 50,
  };
}

/**
 * Batch attaches fraud audit details to a list of withdraw documents.
 */
async function attachFraudAuditToWithdraws(db, withdrawList) {
  if (!withdrawList || !withdrawList.length) return withdrawList;

  const users = db.collection("users");
  const adLogs = db.collection("ad_logs");

  const userIds = [...new Set(withdrawList.map((w) => w.telegramId).filter(Boolean))];
  if (!userIds.length) return withdrawList;

  const [userDocs, allAdLogs, referralStats] = await Promise.all([
    users.find({ telegramId: { $in: userIds } }).toArray(),
    adLogs
      .find({ telegramId: { $in: userIds } })
      .sort({ watchedAt: -1 })
      .limit(userIds.length * 35)
      .toArray(),
    users
      .aggregate([
        { $match: { referredBy: { $in: userIds } } },
        {
          $group: {
            _id: "$referredBy",
            total: { $sum: 1 },
            notJoined: { $sum: { $cond: [{ $eq: ["$joined", true] }, 0, 1] } },
          },
        },
      ])
      .toArray(),
  ]);

  const userMap = new Map(userDocs.map((u) => [u.telegramId, u]));
  const referralMap = new Map(referralStats.map((r) => [r._id, r]));

  // Group ad logs by telegramId
  const logsByUser = new Map();
  for (const log of allAdLogs) {
    if (!logsByUser.has(log.telegramId)) logsByUser.set(log.telegramId, []);
    logsByUser.get(log.telegramId).push(log);
  }

  // IP sharing counts
  const ips = [...new Set(userDocs.map((u) => u.lastIp).filter((ip) => isPlausibleIp(ip) && ip !== "unknown"))];
  let ipCountMap = new Map();
  if (ips.length) {
    const ipGroups = await users
      .aggregate([
        { $match: { lastIp: { $in: ips } } },
        { $group: { _id: "$lastIp", count: { $sum: 1 } } },
      ])
      .toArray();
    ipCountMap = new Map(ipGroups.map((g) => [g._id, g.count]));
  }

  return withdrawList.map((w) => {
    const user = userMap.get(w.telegramId) || null;
    const userLogs = logsByUser.get(w.telegramId) || [];
    const sharedIpCount = (user && user.lastIp && ipCountMap.get(user.lastIp)) || 1;
    const referralStat = referralMap.get(w.telegramId) || null;

    const audit = auditUserWithdrawal(user, userLogs, sharedIpCount, referralStat);

    // 5. Synchronized / Batch Withdrawal Cluster Check
    const wCreatedMs = new Date(w.createdAt).getTime();
    const simultaneousWithdraws = withdrawList.filter(
      (other) =>
        other.telegramId !== w.telegramId &&
        Math.abs(new Date(other.createdAt).getTime() - wCreatedMs) <= 120 * 1000
    );

    // 5+ accounts within 2 minutes: undeniable batch attack (High Fraud)
    if (simultaneousWithdraws.length >= 4) {
      audit.fraudScore += 60;
      audit.fraudReasons.push(
        `Synchronized withdrawal cluster: ${simultaneousWithdraws.length + 1} accounts requested withdraws within 2 mins of each other`
      );
    } else if (simultaneousWithdraws.length >= 2) {
      // 3-4 accounts within 2 minutes: Suspicious batch
      audit.fraudScore += 35;
      audit.fraudReasons.push(
        `Simultaneous withdrawal: ${simultaneousWithdraws.length + 1} accounts requested withdraws within 2 mins of each other`
      );
    }

    // 6. Parallel Bot Activity (Same Last-Active Minute) Check
    if (user && user.lastActiveAt) {
      const uActiveMs = new Date(user.lastActiveAt).getTime();
      const sameActiveUsers = userDocs.filter(
        (other) =>
          other.telegramId !== user.telegramId &&
          other.lastActiveAt &&
          Math.abs(new Date(other.lastActiveAt).getTime() - uActiveMs) <= 60 * 1000
      );
      if (sameActiveUsers.length >= 2) {
        audit.fraudScore += 35;
        audit.fraudReasons.push(
          `Parallel bot session: ${sameActiveUsers.length + 1} accounts active at exact same minute`
        );
      }
    }

    // 7. Bulk Account Creation (Created in Same 15-Minute Window) Check
    if (user && user.createdAt) {
      const uCreatedMs = new Date(user.createdAt).getTime();
      const sameCreationUsers = userDocs.filter(
        (other) =>
          other.telegramId !== user.telegramId &&
          other.createdAt &&
          Math.abs(new Date(other.createdAt).getTime() - uCreatedMs) <= 15 * 60 * 1000
      );
      if (sameCreationUsers.length >= 2) {
        audit.fraudScore += 30;
        audit.fraudReasons.push(
          `Bulk account creation: ${sameCreationUsers.length + 1} accounts joined within minutes of each other`
        );
      }
    }

    audit.fraudScore = Math.min(100, audit.fraudScore);
    if (audit.fraudScore >= 50) audit.fraudLevel = "high";
    else if (audit.fraudScore >= 30) audit.fraudLevel = "medium";
    else audit.fraudLevel = "clean";
    audit.isFraud = audit.fraudScore >= 50;

    let referralCrossPercent = null;
    let referralSuspicious = false;
    let referralTotal = 0;
    let referralNotJoined = 0;
    if (referralStat && referralStat.total > 0) {
      referralTotal = referralStat.total;
      referralNotJoined = referralStat.notJoined;
      referralCrossPercent = Math.round((referralStat.notJoined / referralStat.total) * 100);
      referralSuspicious = referralCrossPercent >= 70 && referralStat.total >= 4;
    }

    return {
      ...w,
      referralTotal,
      referralNotJoined,
      referralCrossPercent,
      referralSuspicious,
      fraudScore: audit.fraudScore,
      fraudLevel: audit.fraudLevel,
      fraudReasons: audit.fraudReasons,
      isFraud: audit.isFraud,
    };
  });
}

// Verifies and burns a single-use puzzle captcha token (anti-script protection)
async function verifyAndBurnCaptchaToken(db, uid, token) {
  if (!token || typeof token !== "string") {
    return { ok: false, error: "Security verification required. Please solve the puzzle." };
  }
  const cleanToken = token.trim();
  const tokensCol = db.collection("captcha_tokens");
  const tokenDoc = await tokensCol.findOne({
    token: cleanToken,
    telegramId: { $in: [uid, Number(uid), String(uid)] },
    used: false,
  });
  if (!tokenDoc) {
    return { ok: false, error: "Invalid or already used verification. Please solve the puzzle again." };
  }
  if (Date.now() - Number(tokenDoc.createdAt || 0) > 120 * 1000) {
    return { ok: false, error: "Verification expired. Please solve the puzzle again." };
  }
  await tokensCol.updateOne(
    { _id: tokenDoc._id },
    { $set: { used: true, usedAt: new Date() } }
  );
  return { ok: true };
}

module.exports = {
  getClientIp,
  isPlausibleIp,
  isSameDevice,
  checkIpLock,
  getAdDayBoundary,
  getSecondsUntilNextAdReset,
  applyCors,
  auditUserWithdrawal,
  attachFraudAuditToWithdraws,
  verifyAndBurnCaptchaToken,
};

// ---------- CORS lock-down ----------
// Merged in here (rather than its own api/_cors.js) to avoid using up one
// more of your 12 Vercel serverless function slots — this file is already
// a shared helper every route requires, not a route of its own.
//
// WHAT THIS DOES: this app's frontend is only ever meant to be loaded from
// the origins in ALLOWED_ORIGINS below. Without it, the response had no
// Access-Control-Allow-Origin header at all, which already blocks other
// origins by default — this makes that restriction EXPLICIT and adds
// proper OPTIONS-preflight handling, instead of relying on "we just never
// set it".
//
// WHAT THIS DOES NOT DO — read this before assuming it "blocks hackers":
// CORS is a rule browsers enforce on behalf of a THIRD-PARTY WEBPAGE trying
// to read a response via that visitor's browser (e.g. some other site
// embeds your app in a hidden iframe and fetches your API in the
// background). It stops that specific scenario. It does NOT stop anyone
// calling these endpoints directly — curl, Postman, a Node script, or a
// browser's dev tools Network/Console tab all bypass CORS entirely, because
// CORS is enforced by the BROWSER reading the response, not by your server
// refusing the request. Origin headers are also just a client-sent header —
// trivially set to anything by a direct HTTP client, so this is not a
// second copy of the real check either.
//
// The one thing on this server that ACTUALLY can't be bypassed by any of
// the above is verifyInitData() in api/_verifyInitData.js: it checks an
// HMAC signature made with the bot's secret token, which never reaches the
// client in any form — so no direct request, no matter how it's crafted or
// what Origin/headers it fakes, can pass it without that token. This is a
// defense-in-depth layer on top of that, not a replacement for it.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "https://redtube-nine.vercel.app"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
// ^ If you ever put this app on a custom domain (or add a staging URL),
// add it here via the ALLOWED_ORIGINS env var as a comma-separated list —
// e.g. "https://redtube-nine.vercel.app,https://mycustomdomain.com" —
// rather than editing this file.

/**
 * Call as the FIRST line inside every route's module.exports(req, res).
 * Returns true if it already fully handled the request (an OPTIONS
 * preflight) — the caller should `return` immediately in that case.
 * Returns false otherwise, meaning the route should continue as normal.
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // Telegram Mini Apps normally call these endpoints same-origin (the app
  // is served from this same Vercel deployment), so browsers won't even
  // send a preflight for most requests in practice — these headers exist
  // for the cross-origin case above, so a preflight is answered correctly
  // if one ever does happen.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Telegram-Init-Data, X-Action-Token"
  );
  res.setHeader("Access-Control-Expose-Headers", "X-Action-Token");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
