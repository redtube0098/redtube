// api/_actionSign.js
//
// Lightweight anti-tampering layer for reward-granting POST endpoints
// (ad/task claims, withdraw requests). It does NOT replace Telegram
// initData verification (see _verifyInitData.js) — that already proves
// WHO is calling. This proves the claim/withdraw POST actually followed a
// real status/list GET moments earlier, instead of being fired directly
// at the API by a script that skipped the normal app flow.
//
// Flow:
//   1. A GET status/list endpoint calls signAction(uid, scope) and sends
//      the result back as an "X-Action-Token" response header.
//   2. The client caches that token and echoes it back as the same
//      header on the next matching claim/withdraw POST.
//   3. The POST handler calls verifyActionToken(token, uid, scope) before
//      granting any reward.
//
// FAIL-OPEN BY DESIGN: if ACTION_SIGNING_SECRET is not set (e.g. not yet
// configured in the deployment's env vars), signAction() returns null (no
// header is ever sent) and verifyActionToken() returns true (nothing is
// blocked). This mirrors the existing WEBHOOK_SECRET behavior in bot.js —
// deploying this file changes nothing until the secret is actually set,
// so no existing flow can be broken by this addition alone.
const crypto = require("crypto");

const ACTION_SIGNING_SECRET = process.env.ACTION_SIGNING_SECRET;
const ACTION_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes — plenty for a real user's claim flow

if (!ACTION_SIGNING_SECRET) {
  console.warn(
    "[SECURITY WARNING] ACTION_SIGNING_SECRET is not set. Action-token issuance/verification is disabled (fail-open) until it's configured."
  );
}

// Builds a signed token binding this token to one user + one scope + one
// issue time. base64url so it's header/URL-safe with no extra encoding.
function signAction(uid, scope) {
  if (!ACTION_SIGNING_SECRET) return null;
  if (!uid || !scope) return null;
  const payload = `${uid}.${scope}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", ACTION_SIGNING_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

// Verifies a token was (a) issued by us, (b) for this exact uid+scope, and
// (c) not expired. Returns true/false — never throws on malformed input.
function verifyActionToken(token, uid, scope) {
  if (!ACTION_SIGNING_SECRET) return true; // feature disabled — never blocks a real request
  if (!token || typeof token !== "string") return false;

  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return false;
  }

  const parts = decoded.split(".");
  if (parts.length !== 4) return false;
  const [tUid, tScope, tTs, sig] = parts;

  if (tUid !== String(uid) || tScope !== scope) return false;

  const ts = Number(tTs);
  if (!Number.isFinite(ts) || Date.now() - ts > ACTION_TOKEN_TTL_MS || Date.now() - ts < 0) {
    return false;
  }

  const expectedPayload = `${tUid}.${tScope}.${tTs}`;
  const expectedSig = crypto.createHmac("sha256", ACTION_SIGNING_SECRET).update(expectedPayload).digest("hex");

  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signAction, verifyActionToken };
