const { getDb } = require("../_db");
const { checkAdmin, EARN_MORE_KEYBOARD, enqueueBroadcast, drainBroadcastQueue } = require("../_telegram");

// --- Promo broadcast (fires once, right after a new code is created) ----
// Sends the "you received a promo code" card to every bot user's DM, same
// as the reference screenshot: title, reward, the code itself quoted AND
// wrapped in Markdown backticks (Telegram renders backtick-wrapped text as
// monospace, which is what makes it tap-to-copy on mobile), and a closing
// line. No "Expires in" line — this app's promo codes don't expire.
//
// USED TO loop through every user and send inline, right here, in this
// same request. That could never finish for a 30k-user base: 30000 users
// / 25-per-batch * 1s pause between batches ≈ 1,200s (20 minutes), but
// this function's own maxDuration is capped at 60 (see the bottom of this
// file) — Vercel kills the invocation at 60s regardless, so only the
// first ~1,200-1,500 users near the front of the list ever actually got
// messaged and everyone after that got nothing. That silent partial
// failure was the real cause of promo broadcasts "not reaching all 30k
// users".
//
// FIX: this now just enqueues the broadcast (instant — see
// _telegram.js's enqueueBroadcast) and does one small immediate drain so
// admin sees SOME users get it right away, without waiting on a cron
// tick. The remainder resumes automatically via drainBroadcastQueue()
// called from the reset-notify cron handler in api/bot.js every time
// it's pinged — see the big setup comment there for wiring up a free
// external pinger so that happens every few minutes instead of only once
// a day.
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
  const sentSoFar = await drainBroadcastQueue(db, 20000); // small immediate head start
  const totalUsers = await db.collection("users").countDocuments({});
  return { sentSoFar, totalUsers };
}

// Rate limiter (per-IP) — production e Redis recommend kori multi-instance deploy hole
const requestLog = new Map();
const RATE_LIMIT = 15;
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

// Promo code format validation — sudhu alphanumeric, reasonable length
function isValidCode(code) {
  return typeof code === "string" && /^[A-Z0-9_-]{3,30}$/i.test(code.trim());
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
      console.warn(`[SECURITY] Unauthorized admin/promo access attempt from IP: ${ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const db = await getDb();
    const promos = db.collection("promocodes");
    const claims = db.collection("promo_claims");

    if (req.method === "GET") {
      if (req.query.code) {
        // Input validation before query — prevent malformed/oversized input
        if (!isValidCode(req.query.code)) {
          return res.status(400).json({ error: "invalid code format" });
        }
        const list = await claims
          .find({ code: req.query.code.trim().toUpperCase() })
          .sort({ claimedAt: -1 })
          .limit(500) // prevent unbounded result dump
          .toArray();
        return res.status(200).json(list);
      }
      const list = await promos
        .find({})
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      return res.status(200).json(list);
    }

    if (req.method === "POST") {
      const { code, reward, limit } = req.body || {};

      // Strict input validation
      if (!code || reward === undefined || !limit) {
        return res.status(400).json({ error: "missing fields" });
      }
      if (!isValidCode(code)) {
        return res.status(400).json({ error: "invalid code format" });
      }

      const rewardNum = Number(reward);
      const limitNum = Number(limit);

      if (
        !Number.isFinite(rewardNum) ||
        rewardNum < 0 ||
        !Number.isFinite(limitNum) ||
        limitNum <= 0 ||
        !Number.isInteger(limitNum)
      ) {
        return res.status(400).json({ error: "invalid reward or limit value" });
      }

      const upperCode = code.trim().toUpperCase();
      const exists = await promos.findOne({ code: upperCode });
      if (exists) return res.status(400).json({ error: "code already exists" });

      await promos.insertOne({
        code: upperCode,
        reward: rewardNum,
        limit: limitNum,
        usedCount: 0,
        createdAt: new Date(),
      });

      console.log(`[ADMIN] Promo code created: ${upperCode} by IP ${ip}`);

      // Queues the broadcast + does one small immediate drain (see the
      // comment above broadcastPromoCode) — wrapped so a broadcast hiccup
      // never turns a successfully-created promo code into an error
      // response.
      let sentSoFar = 0;
      let totalUsers = 0;
      try {
        ({ sentSoFar, totalUsers } = await broadcastPromoCode(db, upperCode, rewardNum));
      } catch (broadcastErr) {
        console.error("[ERROR] promo broadcast failed:", broadcastErr);
      }

      const remaining = Math.max(totalUsers - sentSoFar, 0);
      return res.status(200).json({
        success: true,
        notified: sentSoFar, // kept for backward compatibility with any existing admin.js UI reading "notified"
        sentSoFar,
        totalUsers,
        remainingQueued: remaining,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[ERROR] promo.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Broadcasting to a large user base can take longer than Vercel's default
// function timeout (10s on Hobby). Raise this function's own cap so the
// POST handler above has room to finish the batch-send loop instead of
// getting killed mid-broadcast. If your plan's max is lower than 60,
// Vercel will just cap it there instead of failing the deploy.
module.exports.config = { maxDuration: 60 };
