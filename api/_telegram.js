// api/_telegram.js
const fetch = require("node-fetch");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!BOT_TOKEN) {
  throw new Error("[CONFIG ERROR] BOT_TOKEN is not set in environment variables.");
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  // Fail loudly at startup rather than silently allowing weak/empty admin auth
  console.error(
    "[SECURITY WARNING] ADMIN_PASSWORD is missing or too short. Set a strong password (16+ random chars) in env vars."
  );
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgCall(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[TG API ERROR] ${method} failed with status ${res.status}`);
  }
  return res.json();
}

// Checks if a user is a member of a channel/group by @username or -100id
async function isMember(chatId, userId) {
  try {
    const data = await tgCall("getChatMember", { chat_id: chatId, user_id: userId });
    if (!data.ok) return false;
    const status = data.result.status;
    return ["member", "administrator", "creator"].includes(status);
  } catch (e) {
    console.error("[ERROR] isMember check failed:", e);
    return false;
  }
}

// Sends a photo with a caption to a chat/channel (e.g. posting a payment-
// proof card to the Pay Channel). chatId can be a @username or a -100...
// numeric channel id. Never throws — a failure here (bad chat id, bot not
// admin in the channel, etc.) should never block the admin action that
// triggered it (e.g. approving a withdraw), so callers can fire-and-forget
// or await it without extra try/catch.
async function sendPhoto(chatId, photoUrl, caption, parseMode = "Markdown") {
  try {
    const data = await tgCall("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: parseMode,
    });
    if (!data.ok) {
      console.error(`[TG API ERROR] sendPhoto to ${chatId} failed:`, data.description || data);
    }
    return data;
  } catch (e) {
    console.error("[ERROR] sendPhoto failed:", e);
    return null;
  }
}

// Simple in-memory brute-force protection for admin login attempts
const failedAttempts = new Map(); // ip -> { count, firstAttempt }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOCKOUT_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
  entry.count++;
  failedAttempts.set(ip, entry);
}

// Timing-safe string comparison — prevents timing-attack password guessing
function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison to keep timing consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAdmin(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isLockedOut(ip)) {
    console.warn(`[SECURITY] Admin login locked out for IP: ${ip}`);
    return false;
  }

  const password = req.headers["x-admin-password"];
  if (!ADMIN_PASSWORD) {
    // Fail closed if password not configured — never allow access on misconfiguration
    return false;
  }

  const isValid = safeCompare(password, ADMIN_PASSWORD);
  if (!isValid) {
    recordFailedAttempt(ip);
    return false;
  }

  // Clear failed attempts on success
  failedAttempts.delete(ip);
  return true;
}

module.exports = { tgCall, isMember, checkAdmin, sendPhoto };
