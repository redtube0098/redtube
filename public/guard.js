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

  // ---------- TELEGRAM-ONLY GATE ----------
  // Real point to understand first: opening this page in a normal browser
  // (Chrome address bar, a shared link outside Telegram, etc.) was ALREADY
  // useless before this — api/user.js verifies X-Telegram-Init-Data with
  // an HMAC signed by the bot's secret token (verifyInitData in
  // api/_verifyInitData.js), and that token never reaches the client, so
  // no amount of dev-tools tampering can forge a header that passes it.
  // Every real read/write already 401s without it. That check is the actual
  // security boundary and cannot be bypassed from the browser — this gate
  // below does NOT add security on top of it. What it adds is APPEARANCE:
  // right now, opening the raw URL outside Telegram still renders the full
  // loading screen and app shell (with a hardcoded "Demo User" fallback)
  // before every API call silently 401s — which looks half-broken rather
  // than cleanly closed. This replaces that with an immediate, deliberate
  // "open this in Telegram" screen and — critically — never loads app.js
  // at all in that case, so someone poking around outside Telegram sees no
  // app code, no UI state, nothing to inspect.
  //
  // Detection: telegram-web-app.js (loaded from telegram.org in index.html)
  // always defines window.Telegram.WebApp as an object, even when this page
  // is opened directly in a normal browser — so `tg` existing proves
  // nothing. What ONLY a genuine Telegram launch ever populates is
  // `tg.initData` (a non-empty, bot-token-signed string) and
  // `tg.initDataUnsafe.user` with a real numeric id. Outside Telegram both
  // stay empty/absent no matter what a browser's dev tools do to the page,
  // because Telegram itself is what injects them at launch time — they are
  // not something client-side JS can set.
  const isRealTelegramLaunch =
    !!tg &&
    typeof tg.initData === "string" &&
    tg.initData.length > 0 &&
    !!tgUser &&
    Number.isInteger(tgUser.id);

  function renderTelegramOnlyScreen() {
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen) loadingScreen.style.display = "none";

    // Built with inline styles on purpose (not style.css classes) — this
    // screen has to stand alone and render correctly even if something else
    // on the page fails, since it's the ONLY thing allowed to show up when
    // this gate trips.
    const root = document.createElement("div");
    root.id = "telegramOnlyScreen";
    root.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:999999;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;gap:16px;padding:32px;text-align:center;" +
      "background:#0f1115;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
    );
    root.innerHTML = `
      <div style="font-size:48px;">✈️</div>
      <h2 style="margin:0;font-size:20px;">Open in Telegram</h2>
      <p style="margin:0;max-width:320px;color:#a5a8b0;font-size:14px;line-height:1.5;">
        This app only works inside Telegram. Please open it from the RedTube bot, not a browser link.
      </p>
      <a href="https://t.me/redtube12_bot/earn"
         style="margin-top:8px;padding:12px 28px;border-radius:999px;background:#2aabee;color:#fff;
                text-decoration:none;font-weight:600;font-size:15px;">
        Open in Telegram
      </a>
    `;
    document.body.innerHTML = "";
    document.body.appendChild(root);
  }

  // Hard stop: if this isn't a genuine Telegram launch, show the screen and
  // return immediately — guardApi(), init(), and loadApp() (which is what
  // pulls in app.js) never run, so app.js's code never even reaches the
  // browser in this case.
  if (!isRealTelegramLaunch) {
    renderTelegramOnlyScreen();
    return;
  }

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
