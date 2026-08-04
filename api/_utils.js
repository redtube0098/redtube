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

module.exports = { getClientIp, isPlausibleIp, isSameDevice };
