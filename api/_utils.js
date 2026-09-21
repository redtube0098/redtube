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

module.exports = { getClientIp, isPlausibleIp, isSameDevice, checkIpLock, getAdDayBoundary, getSecondsUntilNextAdReset, applyCors };

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
