// public/guard.js
// Loaded BEFORE app.js (see index.html). Checks whether this IP is already
// linked to a different Telegram account. If blocked, shows the lock
// screen and never loads app.js. If clear, loads app.js exactly as before.
// app.js itself is never modified or touched by this file.
(function () {
  const tg = window.Telegram ? window.Telegram.WebApp : null;
  if (tg) { tg.ready(); tg.expand(); }

  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
  const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;
  const USERNAME = tgUser ? tgUser.username : "demo_user";
  const FIRSTNAME = tgUser ? tgUser.first_name : "Demo User";

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function guardApi(body) {
    const headers = { "Content-Type": "application/json" };
    if (tg && tg.initData) headers["X-Telegram-Init-Data"] = tg.initData;
    return fetch("/api/user", { method: "POST", headers, body: JSON.stringify(body) })
      .then((r) => r.json())
      .catch(() => ({ blocked: false })); // network hiccup — fail open, don't trap the user
  }

  function loadApp() {
    const s = document.createElement("script");
    s.src = "app.js";
    document.body.appendChild(s);
  }

  function renderLockScreen(activeAccount) {
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen) loadingScreen.style.display = "none";

    let root = document.getElementById("ipLockScreen");
    if (!root) {
      root = document.createElement("div");
      root.id = "ipLockScreen";
      root.className = "ip-lock-screen";
      document.getElementById("app").appendChild(root);
    }
    const name = activeAccount ? esc(activeAccount.name) : "User";
    const username = activeAccount && activeAccount.username ? "@" + esc(activeAccount.username) : "";
    const uid = activeAccount ? esc(activeAccount.telegramId) : "";

    root.innerHTML = `
      <div class="ip-lock-icon">📶</div>
      <h2 class="ip-lock-title">IP Already In Use</h2>
      <p class="ip-lock-desc">This connection is already linked to another account.<br>Switch your VPN or network, or claim it for this account below.</p>
      <div class="ip-lock-card">
        <div class="ip-lock-avatar">👤</div>
        <div class="ip-lock-info">
          <div class="ip-lock-name">${name}</div>
          <div class="ip-lock-uid">${username}${username ? " · " : ""}ID ${uid}</div>
        </div>
      </div>
      <div class="ip-lock-error" id="ipLockError" style="display:none;">Please go back to your account.</div>
      <button class="ip-lock-btn-retry" id="ipLockRetryBtn">🔄 I've switched — try again</button>
      <button class="ip-lock-btn-switch" id="ipLockSwitchBtn">Switch account (resets my balance)</button>
      <p class="ip-lock-note">Switching claims this connection for your account but resets your RDC and USDT balance to zero.</p>
      <div class="ip-lock-confirm-overlay" id="ipLockConfirmOverlay">
        <div class="ip-lock-confirm-box">
          <p>This will reset your entire balance to zero. Continue?</p>
          <div class="ip-lock-confirm-actions">
            <button id="ipLockCancelBtn">Cancel</button>
            <button id="ipLockOkBtn">OK</button>
          </div>
        </div>
      </div>
    `;
    root.style.display = "flex";

    document.getElementById("ipLockRetryBtn").addEventListener("click", handleRetry);
    document.getElementById("ipLockSwitchBtn").addEventListener("click", () => {
      document.getElementById("ipLockConfirmOverlay").classList.add("show");
    });
    document.getElementById("ipLockCancelBtn").addEventListener("click", () => {
      document.getElementById("ipLockConfirmOverlay").classList.remove("show");
    });
    document.getElementById("ipLockOkBtn").addEventListener("click", handleClaim);
  }

  async function handleRetry() {
    const btn = document.getElementById("ipLockRetryBtn");
    const errBox = document.getElementById("ipLockError");
    btn.disabled = true;
    btn.textContent = "Checking...";
    errBox.style.display = "none";

    const result = await guardApi({ username: USERNAME, firstName: FIRSTNAME, refBy: startParam ? Number(startParam) : null });

    btn.disabled = false;
    btn.textContent = "🔄 I've switched — try again";

    if (!result.blocked) {
      const root = document.getElementById("ipLockScreen");
      if (root) root.style.display = "none";
      loadApp();
    } else {
      errBox.style.display = "block";
    }
  }

  async function handleClaim() {
    document.getElementById("ipLockConfirmOverlay").classList.remove("show");
    const btn = document.getElementById("ipLockSwitchBtn");
    btn.disabled = true;
    btn.textContent = "Switching...";

    const result = await guardApi({ action: "claim_ip", username: USERNAME, firstName: FIRSTNAME });

    if (result.success) {
      const root = document.getElementById("ipLockScreen");
      if (root) root.style.display = "none";
      loadApp();
    } else {
      btn.disabled = false;
      btn.textContent = "Switch account (resets my balance)";
    }
  }

  async function init() {
    const result = await guardApi({ username: USERNAME, firstName: FIRSTNAME, refBy: startParam ? Number(startParam) : null });
    if (result && result.blocked) {
      renderLockScreen(result.activeAccount);
    } else {
      loadApp();
    }
  }

  init();
})();
