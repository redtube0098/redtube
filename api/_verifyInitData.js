// api/_verifyInitData.js
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("[CONFIG ERROR] BOT_TOKEN is not set — initData verification will fail.");
}

function verifyInitData(initData) {
  if (!initData || typeof initData !== "string") return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");

    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    // Timing-safe comparison
    const hashBuf = Buffer.from(hash, "hex");
    const computedBuf = Buffer.from(computedHash, "hex");
    if (hashBuf.length !== computedBuf.length) return null;
    if (!crypto.timingSafeEqual(hashBuf, computedBuf)) return null;

    // Reject stale/replayed initData
    const authDate = Number(params.get("auth_date"));
    const MAX_AGE_SECONDS = 24 * 60 * 60;
    if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

    const userJson = params.get("user");
    if (!userJson) return null;

    const user = JSON.parse(userJson);
    if (!user || !Number.isFinite(user.id)) return null;

    return user;
  } catch (e) {
    console.error("[SECURITY] initData verification error:", e.message);
    return null;
  }
}

module.exports = { verifyInitData };
