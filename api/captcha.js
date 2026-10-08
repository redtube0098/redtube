// api/captcha.js
const crypto = require("crypto");
const { getDb } = require("./_db");
const { verifyInitData } = require("./_verifyInitData");
const { applyCors } = require("./_utils");

const CHALLENGE_EXPIRY_MS = 120 * 1000; // 2 minutes
const TOKEN_EXPIRY_MS = 90 * 1000;      // 90 seconds

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const initDataRaw = req.headers["x-telegram-init-data"];
    const verifiedUser = verifyInitData(initDataRaw);
    if (!verifiedUser) {
      return res.status(401).json({ error: "Unauthorized — invalid Telegram session" });
    }

    const uid = Number(verifiedUser.id);
    let parsedBody = req.body;
    if (typeof parsedBody === "string") {
      try { parsedBody = JSON.parse(parsedBody); } catch (e) { parsedBody = {}; }
    }
    const { action } = parsedBody || {};

    const db = await getDb();
    const challengesCol = db.collection("captcha_challenges");
    const tokensCol = db.collection("captcha_tokens");

    // Action 1: Create a fresh puzzle challenge
    if (action === "create") {
      const challengeId = crypto.randomBytes(16).toString("hex");
      // Puzzle canvas is 320px wide. Valid slot range between 80px and 230px.
      const targetX = Math.floor(Math.random() * (230 - 80 + 1)) + 80;
      const targetY = Math.floor(Math.random() * (85 - 25 + 1)) + 25;
      const now = Date.now();

      await challengesCol.insertOne({
        challengeId,
        telegramId: uid,
        targetX,
        targetY,
        createdAt: now,
        used: false,
      });

      return res.status(200).json({
        ok: true,
        challengeId,
        targetX,
        targetY,
      });
    }

    // Action 2: Verify the user's solved slider position
    if (action === "verify") {
      const { challengeId, solvedX, timeElapsed } = parsedBody || {};

      if (!challengeId || typeof solvedX !== "number") {
        return res.status(400).json({ error: "Missing verification parameters" });
      }

      const challenge = await challengesCol.findOne({
        challengeId,
        telegramId: uid,
        used: false,
      });

      if (!challenge) {
        return res.status(400).json({ error: "Invalid or already used challenge. Please try again." });
      }

      // Mark challenge as used immediately to prevent replay
      await challengesCol.updateOne(
        { _id: challenge._id },
        { $set: { used: true, verifiedAt: Date.now() } }
      );

      const now = Date.now();
      if (now - challenge.createdAt > CHALLENGE_EXPIRY_MS) {
        return res.status(400).json({ error: "Challenge expired. Please try again." });
      }

      // 1. Anti-Bot Check: Human slider movement takes at least 200ms
      const elapsed = Number(timeElapsed) || 0;
      if (elapsed < 200) {
        return res.status(400).json({ error: "Solving too fast. Please slide naturally." });
      }

      // 2. Tolerance Check: puzzle piece placed nearby (relaxed to ±20 pixels for easy UX)
      const diff = Math.abs(solvedX - challenge.targetX);
      if (diff > 20) {
        return res.status(400).json({
          error: "Puzzle piece did not fit into place. Try again.",
          diff,
        });
      }

      // All checks passed! Issue a single-use cryptographically random token
      const captchaToken = crypto.randomBytes(24).toString("hex");
      await tokensCol.insertOne({
        token: captchaToken,
        telegramId: uid,
        createdAt: now,
        used: false,
      });

      return res.status(200).json({
        ok: true,
        captchaToken,
        message: "Verification successful!",
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("[ERROR] captcha.js:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
