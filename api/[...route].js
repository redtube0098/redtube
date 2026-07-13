// api/[...route].js
module.exports = async (req, res) => {
  const parts = req.query.route || [];
  const path = parts.join("/");

  const routes = {
    "bot": "../lib/bot",
    "user": "../lib/user",
    "earn": "../lib/earn",
    "promo": "../lib/promo",
    "referral": "../lib/referral",
    "task": "../lib/task",
    "withdraw": "../lib/withdraw",
    "admin/users": "../lib/admin/users",
    "admin/withdraws": "../lib/admin/withdraws",
    "admin/tasks": "../lib/admin/tasks",
    "admin/promo": "../lib/admin/promo",
    "admin/multi-accounts": "../lib/admin/multi-accounts",
  };

  const modulePath = routes[path];
  if (!modulePath) {
    return res.status(404).json({ error: "Route not found" });
  }

  const handler = require(modulePath);
  return handler(req, res);
};
