// public/app.js
const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) tg.ready(), tg.expand();

const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;

const UID = tgUser ? tgUser.id : 5697990319;
const USERNAME = tgUser ? tgUser.username : "demo_user";
const FIRSTNAME = tgUser ? tgUser.first_name : "Demo User";

let userState = null;
let currentTab = "home";
let adNetworks = [];

const RDC_RATE = 0.00004;
const MIN_CONVERT = 500;
const CONVERT_FEE_PCT = 0.25;

const PROMO_ADSGRAM_BLOCK_ID = "38194";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- AD BARRIER (prevents two ad SDKs from running at once) ----------
// Bug this fixes: clicking one network's Watch button while another
// network's ad overlay/iframe was still resolving could cause the wrong
// SDK's ad to render, or two SDKs to fight over the same overlay space.
// activeAdNetwork acts as a single global lock — any ad trigger point
// (promo, earning tab, spin) must acquire it before calling an SDK's
// show()/init() and release it as soon as that call settles (success OR
// failure), so at most one ad is ever in flight across the whole app.
let activeAdNetwork = null;

function acquireAdLock(network) {
  if (activeAdNetwork) return false;
  activeAdNetwork = network;
  return true;
}

function releaseAdLock() {
  activeAdNetwork = null;
}

// ---------- SECURITY: HTML escaping ----------
// Any value that came from a user (Telegram first_name, username, referral
// display name, etc.) MUST be escaped before being inserted via innerHTML —
// otherwise a malicious Telegram display name (which has no character
// restrictions, unlike @username) could inject a <img onerror=...> / script
// payload that runs in every viewer's browser (stored XSS), and could be
// used to steal admin session data if an admin ever views that content.
function esc(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeAlert(msg) {
  try {
    if (tg && tg.showAlert && tg.isVersionAtLeast && tg.isVersionAtLeast("6.2")) {
      tg.showAlert(msg);
    } else {
      alert(msg);
    }
  } catch (e) {
    alert(msg);
  }
}

function showPromoAd() {
  return new Promise((resolve, reject) => {
    if (typeof window.Adsgram === "undefined") {
      reject(new Error("Adsgram SDK not loaded (window.Adsgram is undefined) — check if sad.adsgram.ai script loaded, or if an ad blocker is active."));
      return;
    }
    const AdController = window.Adsgram.init({ blockId: PROMO_ADSGRAM_BLOCK_ID });
    AdController.show()
      .then(resolve)
      .catch(reject);
  });
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (tg && tg.initData) {
    headers["X-Telegram-Init-Data"] = tg.initData;
  }
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

function runLoading() {
  const fill = $("#progressFill");
  let pct = 0;
  const interval = setInterval(() => {
    pct += Math.random() * 18;
    if (pct >= 100) {
      pct = 100;
      fill.style.width = "100%";
      clearInterval(interval);
      setTimeout(initApp, 300);
    } else {
      fill.style.width = pct + "%";
    }
  }, 180);
}

async function initApp() {
  $("#loadingScreen").style.display = "none";

  await api("/api/user", {
    method: "POST",
    body: { username: USERNAME, firstName: FIRSTNAME, refBy: startParam ? Number(startParam) : null },
  });

  const status = await api("/api/user", {
    method: "POST",
    body: { action: "check_join" },
  });

  if (!status.joined) {
    $("#joinGate").style.display = "flex";
  } else {
    enterApp();
  }
}

$("#checkJoinBtn").addEventListener("click", async () => {
  $("#checkJoinBtn").textContent = "Checking...";
  const status = await api("/api/user", { method: "POST", body: { action: "check_join" } });
  if (status.joined) {
    $("#joinGate").style.display = "none";
    enterApp();
  } else {
    $("#joinError").style.display = "block";
    $("#checkJoinBtn").textContent = "✅ I've joined, check now";
  }
});

async function enterApp() {
  $("#mainHeader").style.display = "flex";
  $("#mainContent").style.display = "block";
  $("#bottomNav").style.display = "flex";
  await refreshUser();
  renderTab("home");
}

async function refreshUser() {
  userState = await api("/api/user");
}

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderTab(btn.dataset.tab);
  });
});

$("#historyBtn").addEventListener("click", openHistoryModal);
$("#profileBtn").addEventListener("click", openProfileModal);

function showTabLoading() {
  const content = $("#mainContent");
  content.innerHTML = `
    <div class="tab-loading">
      <div class="tab-loading-ring"></div>
    </div>
  `;
}

async function renderTab(tab) {
  currentTab = tab;
  showTabLoading();

  const content = $("#mainContent");
  if (tab === "home") return renderHome(content);
  if (tab === "earning") return renderEarning(content);
  if (tab === "task") return renderTask(content);
  if (tab === "refer") return renderRefer(content);
  if (tab === "spin") return renderSpin(content);
}

function triggerAutoPopupAd() {
  if (typeof show_11276042 !== "function") return;
  show_11276042("pop").catch((e) => {
    console.log("Auto popup ad skipped/failed:", e);
  });
}

// ---------- LIVE WITHDRAW TICKER (fake activity feed, Home tab only) ----------
let tickerTimer = null;
const TICKER_NAME_POOL = ["kot", "ma", "ra", "sh", "jo", "ni", "ta", "al", "sa", "mi", "ka", "ru", "na", "zo", "ha", "re", "du", "fa", "el", "om"];

function generateFakeWithdrawLine() {
  const namePart = TICKER_NAME_POOL[Math.floor(Math.random() * TICKER_NAME_POOL.length)];
  const mask = Math.random() > 0.5 ? "***" : "**";
  const suffixDigits = Math.floor(10 + Math.random() * 89);
  const amount = (0.065 + Math.random() * (0.1 - 0.065)).toFixed(3);
  return `${namePart}${mask}${suffixDigits} just withdrew $${amount}`;
}

function startLiveTicker() {
  if (tickerTimer) clearInterval(tickerTimer);
  const textEl = $("#liveTickerText");
  if (!textEl) return;
  textEl.textContent = generateFakeWithdrawLine();
  tickerTimer = setInterval(() => {
    const el = $("#liveTickerText");
    if (!el) {
      clearInterval(tickerTimer);
      tickerTimer = null;
      return;
    }
    el.textContent = generateFakeWithdrawLine();
  }, 5000);
}

// ---------- HOME ----------
async function renderHome(content) {
  await refreshUser();
  const usd = (userState.balance * RDC_RATE).toFixed(4);
  const usdtBalance = (userState.usdtBalance || 0).toFixed(3);

  content.innerHTML = `
    <div class="balance-card">
      <div class="meta">ID ${esc(userState.telegramId)}${userState.username ? " · @" + esc(userState.username) : ""}</div>
      <div class="label">Your balance</div>
      <div class="balance-cols">
        <div class="balance-col">
          <div class="coin-label">◆ RDC</div>
          <div class="amount">${esc(userState.balance)}</div>
        </div>
        <div class="balance-col">
          <div class="coin-label">💵 USDT</div>
          <div class="amount usdt">${esc(usdtBalance)}</div>
        </div>
      </div>
      <div class="usd">1 RDC = $${RDC_RATE} · ${esc(userState.balance)} RDC ≈ $${esc(usd)} USD</div>
      <div class="action-row-split">
        <button class="btn-primary home-withdraw-btn" id="withdrawBtn">↑ Withdraw</button>
        <button class="icon-square-btn home-converter-btn" id="converterBtn" title="Convert RDC to USDT">⇄</button>
      </div>
      <div class="withdraw-hint">Tip: To withdraw, first tap the arrow (⇄) next to Withdraw to convert your RDC into USDT, then tap Withdraw.</div>
    </div>

    <div class="live-ticker" id="liveTicker">
      <span class="live-dot"></span>
      <span id="liveTickerText"></span>
    </div>

    <div class="promo-box">
      <div class="promo-card">
        <div class="promo-icon">🎁</div>
        <div class="promo-text">
          <div class="promo-title">Have a promo code?</div>
          <div class="promo-sub">Redeem it for free RDC</div>
        </div>
      </div>
      <div class="promo-row">
        <input class="field-input" id="promoInputHome" placeholder="ENTER CODE" />
        <button class="btn-primary" id="promoBtnHome">Redeem</button>
      </div>
    </div>

    <div class="pill-row">
      <button class="pill-btn-outline" id="milestonesBtn">🎯 Milestones</button>
      <button class="pill-btn-outline" id="leaderboardBtn">🏆 Leaderboard</button>
    </div>

    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>Platform stats</div>
    <div class="stat-grid stat-grid-3">
      <div class="stat-box"><div class="stat-icon">🎬</div><div class="value">${esc(userState.videosToWatch || 0)}</div><div class="label">Videos to watch</div></div>
      <div class="stat-box"><div class="stat-icon">✅</div><div class="value">${esc(userState.tasksAvailable || 0)}</div><div class="label">Tasks available</div></div>
      <div class="stat-box"><div class="stat-icon">👥</div><div class="value">${esc(userState.referralsCount)}</div><div class="label">Your referrals</div></div>
    </div>
  `;

  $("#withdrawBtn").addEventListener("click", () => openWithdrawModal());
  $("#converterBtn").addEventListener("click", () => openConverterModal());
  startLiveTicker();

  $("#promoBtnHome").addEventListener("click", async () => {
    const code = $("#promoInputHome").value.trim();
    if (!code) return;

    if (!acquireAdLock("promo_adsgram")) {
      safeAlert("Another ad is already playing — please wait for it to finish.");
      return;
    }

    const btn = $("#promoBtnHome");
    btn.disabled = true;
    btn.textContent = "Loading ad...";
    showAdLoadingOverlay();

    try {
      await showPromoAd();
    } catch (e) {
      console.error("Promo ad error:", e);
      hideAdLoadingOverlay();
      releaseAdLock();
      btn.disabled = false;
      btn.textContent = "Redeem";
      safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
      return;
    }

    releaseAdLock();
    hideAdLoadingOverlay();
    btn.textContent = "Redeeming...";

    const result = await api("/api/promo", { method: "POST", body: { code } });
    btn.disabled = false;
    btn.textContent = "Redeem";

    if (result.success) {
      safeAlert(`+${result.reward} RDC claimed!`);
      renderHome($("#mainContent"));
    } else {
      safeAlert(result.error || "Error");
    }
  });

  $("#milestonesBtn").addEventListener("click", () => safeAlert("Milestones — coming soon"));
  $("#leaderboardBtn").addEventListener("click", () => safeAlert("Leaderboard — coming soon"));
}

// ---------- CONVERTER (RDC -> USDT) ----------
function openConverterModal() {
  const overlay = $("#converterModal");
  if (!overlay) {
    console.error('Missing #converterModal overlay in index.html');
    return;
  }

  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">Convert RDC → USDT <button class="modal-close" id="closeConverter">✕</button></div>
      <p class="convert-note"><span class="dot"></span>A 25% fee applies here, at conversion — withdrawing afterward is fee-free.</p>

      <div class="balance-display-box">
        <div class="label">RDC BALANCE</div>
        <div class="value">${esc(userState.balance)} <span>RDC</span></div>
      </div>

      <div class="field-label">Amount to convert — minimum ${MIN_CONVERT} RDC</div>
      <input class="field-input" id="convAmount" type="number" placeholder="${MIN_CONVERT}" />

      <div class="convert-breakdown">
        <div class="row"><span>Gross value</span><span id="grossVal">$0.0000</span></div>
        <div class="row fee"><span>Fee (25%)</span><span id="feeVal">-$0.0000</span></div>
        <div class="row total"><span>You'll receive</span><span id="receiveVal">$0.0000</span></div>
      </div>

      <button class="btn-primary" style="width:100%;" id="submitConvert" disabled>Enter an amount</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeConverter").addEventListener("click", () => overlay.classList.remove("show"));

  const amountInput = $("#convAmount");
  const submitBtn = $("#submitConvert");

  amountInput.addEventListener("input", () => {
    const amt = Number(amountInput.value);
    const gross = amt > 0 ? amt * RDC_RATE : 0;
    const fee = gross * CONVERT_FEE_PCT;
    const receive = gross - fee;

    $("#grossVal").textContent = `$${gross.toFixed(4)}`;
    $("#feeVal").textContent = `-$${fee.toFixed(4)}`;
    $("#receiveVal").textContent = `$${receive.toFixed(4)}`;

    if (amt >= MIN_CONVERT && amt <= userState.balance) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Convert";
    } else {
      submitBtn.disabled = true;
      submitBtn.textContent = amt > 0 ? `Minimum ${MIN_CONVERT} RDC` : "Enter an amount";
    }
  });

  submitBtn.addEventListener("click", async () => {
    const amt = Number(amountInput.value);
    if (!amt || amt < MIN_CONVERT) return safeAlert(`Minimum ${MIN_CONVERT} RDC required`);
    if (amt > userState.balance) return safeAlert("Insufficient RDC balance");

    submitBtn.disabled = true;
    submitBtn.textContent = "Converting...";
    const result = await api("/api/withdraw", { method: "POST", body: { action: "convert", amount: amt } });
    if (result.success) {
      safeAlert(`Converted! +${result.receivedUsdt} USDT`);
      overlay.classList.remove("show");
      renderHome($("#mainContent"));
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = "Convert";
      safeAlert(result.error || "Error");
    }
  });
}

// ---------- EARNING (ads/special tasks) ----------
const cooldownTimers = {};

// NOTE ON THE "SPECIAL TASKS" SUB-TAB BELOW: the label stays "🎁 Special
// Tasks" (unchanged), but the body it renders is now the REGULAR task list
// (renderRegularTasks — title/link/text-fields/code/submit) instead of the
// channel-join cards. The channel-join logic now lives under the bottom-nav
// "Task" page instead (see renderTask() further down). Nothing was deleted —
// only which function fills which body was swapped.
async function renderEarning(content, sub = "ads") {
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Watch ads to earn</div>
    <p style="color:var(--text-dim);font-size:13px;margin-bottom:14px;">Each network has its own daily limit — watch them all for maximum earnings.</p>
    <div class="tab-switch">
      <button class="${sub === "ads" ? "active" : ""}" id="adsTab">📺 Ads</button>
      <button class="${sub === "special" ? "active" : ""}" id="specialTab">🎁 Special Tasks</button>
    </div>
    <div id="earningBody"></div>
  `;
  $("#adsTab").addEventListener("click", () => renderEarning(content, "ads"));
  $("#specialTab").addEventListener("click", () => renderEarning(content, "special"));

  const body = $("#earningBody");
  if (sub === "special") {
    return renderRegularTasks(body);
  }

  body.innerHTML = `<div class="tab-loading"><div class="tab-loading-ring"></div></div>`;

  Object.values(cooldownTimers).forEach((t) => clearInterval(t));

  const NETWORKS = [
    { key: "adsgram_daily", name: "Adsgram Daily", icon: "⚡" },
    { key: "adsgram_special", name: "Adsgram Special", icon: "✨" },
    { key: "monetag", name: "Monetag", icon: "🎬" },
    { key: "gigapub", name: "GigaPub", icon: "📺" },
  ];

  const status = await api(`/api/earn`);

  body.innerHTML = NETWORKS.map((n) => {
    const st = status[n.key] || { watchedToday: 0, limit: 0, reward: 0, cooldownSecondsLeft: 0, limitReached: false };
    return `
    <div class="ad-card">
      <div class="ad-icon">${n.icon}</div>
      <div class="ad-info">
        <span class="name">${esc(n.name)}</span><span class="reward">+${esc(st.reward)} RDC</span>
        <div class="ad-progress"><div class="ad-progress-fill" style="width:${(st.watchedToday / st.limit) * 100}%" id="prog-${n.key}"></div></div>
        <div class="count" id="count-${n.key}">${esc(st.watchedToday)}/${esc(st.limit)} today</div>
      </div>
      <button class="watch-btn" data-key="${n.key}">▶ Watch</button>
    </div>
  `;
  }).join("");

  NETWORKS.forEach((n) => {
    const st = status[n.key];
    const btn = body.querySelector(`.watch-btn[data-key="${n.key}"]`);
    if (st.limitReached) {
      showLimitReached(btn, st.resetInSeconds);
    } else if (st.cooldownSecondsLeft > 0) {
      // Existing cooldown from before this render (e.g. page reload) —
      // no popup here, only announce it right after a fresh watch below.
      startCooldown(btn, n.key, st.cooldownSecondsLeft);
    }
  });

  body.querySelectorAll(".watch-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;

      if (!acquireAdLock(key)) {
        safeAlert("Another ad is already playing — please wait for it to finish, then try this one.");
        return;
      }

      btn.disabled = true;
      btn.textContent = "Loading...";
      showAdLoadingOverlay();

      try {
        if (key === "monetag") {
          if (typeof show_11276042 !== "function") {
            throw new Error("Monetag SDK not loaded (show_11276042 is undefined) — check if libtl.com/sdk.js loaded, or if an ad blocker is active.");
          }
          await show_11276042();
        } else if (key === "gigapub") {
          if (typeof window.showGiga !== "function") {
            throw new Error("GigaPub SDK not loaded (window.showGiga is undefined) — check if the GigaPub script tag loaded, or if an ad blocker is active.");
          }
          await window.showGiga("main");
        } else if (key === "adsgram_special") {
          if (typeof window.Adsgram === "undefined") {
            throw new Error("Adsgram SDK not loaded (window.Adsgram is undefined) — check if sad.adsgram.ai script loaded, or if an ad blocker is active.");
          }
          const AdController = window.Adsgram.init({ blockId: "38194" });
          await AdController.show();
        } else if (key === "adsgram_daily") {
          if (typeof window.Adsgram === "undefined") {
            throw new Error("Adsgram SDK not loaded (window.Adsgram is undefined) — check if sad.adsgram.ai script loaded, or if an ad blocker is active.");
          }
          const AdController = window.Adsgram.init({ blockId: "int-38623" });
          await AdController.show();
        }
      } catch (e) {
        console.error("Ad SDK error:", e);
        hideAdLoadingOverlay();
        releaseAdLock();
        btn.disabled = false;
        btn.textContent = "▶ Watch";
        safeAlert("Ad failed to load or was skipped. Try again.");
        return;
      }

      releaseAdLock();

      const result = await api("/api/earn", { method: "POST", body: { network: key } });
      hideAdLoadingOverlay();

      if (result.success) {
        $(`#count-${key}`).textContent = `${result.watchedToday}/${result.limit} today`;
        $(`#prog-${key}`).style.width = `${(result.watchedToday / result.limit) * 100}%`;

        showCongrats(result.reward);

        if (result.limitReached) {
          showLimitReached(btn, result.resetInSeconds);
        } else {
          // announce=true — this is a fresh watch, so tell the user to
          // wait 20s and that they can watch a different ad meanwhile.
          startCooldown(btn, key, result.cooldownSeconds, true);
        }
      } else if (result.error === "cooldown") {
        startCooldown(btn, key, result.secondsLeft);
      } else if (result.error === "limit") {
        $(`#count-${key}`).textContent = `${result.watchedToday}/${result.limit} today`;
        showLimitReached(btn, result.resetInSeconds);
      } else {
        btn.disabled = false;
        btn.textContent = "▶ Watch";
        safeAlert(result.error || "Error");
      }
    });
  });
}

// announce: when true, shows a popup telling the user to wait before
// watching this network again — only fired right after a fresh ad watch,
// not when restoring an existing cooldown on page load.
function startCooldown(btn, key, seconds, announce = false) {
  if (cooldownTimers[key]) clearInterval(cooldownTimers[key]);
  let remaining = Math.ceil(seconds);
  btn.disabled = true;

  if (announce) {
    safeAlert(`This ad is now on a ${remaining}-second cooldown. You can watch a different ad in the meantime!`);
  }

  const tick = () => {
    if (remaining <= 0) {
      clearInterval(cooldownTimers[key]);
      delete cooldownTimers[key];
      btn.disabled = false;
      btn.textContent = "▶ Watch";
      return;
    }
    btn.textContent = `Watch again in ${remaining}s`;
    remaining -= 1;
  };
  tick();
  cooldownTimers[key] = setInterval(tick, 1000);
}

function showLimitReached(btn, resetInSeconds) {
  btn.disabled = true;
  btn.textContent = "Claimed";
}

// ---------- SPECIAL TASKS BODY (channel/group join — Verified or Normal) ----------
// This function's own name/internals are unchanged from before — it's still
// the channel-join card renderer. What changed is WHERE it gets called from:
// it now fills the bottom-nav "Task" page's body (see renderTask below)
// instead of the Earning tab's "Special Tasks" body.
async function renderSpecialTasks(body) {
  body.innerHTML = `<div class="tab-loading"><div class="tab-loading-ring"></div></div>`;

  const tasks = await api("/api/task?type=special");
  if (!Array.isArray(tasks) || !tasks.length) {
    body.innerHTML = `<div class="empty-state">No special tasks available yet.</div>`;
    return;
  }

  body.innerHTML = tasks
    .map(
      (t) => `
    <div class="special-task-card">
      ${t.verificationType === "verified" ? '<span class="verified-badge">✓ Verified</span>' : ""}
      <div class="special-task-row">
        <div class="special-icon">📢</div>
        <div class="special-title">${esc(t.title)}</div>
      </div>
      <div class="special-task-right">
        <div class="special-reward">+${esc(t.reward)}<span>RDC</span></div>
        <button class="special-start-btn" data-id="${esc(t.id)}" ${t.completed ? "disabled" : ""}>${
        t.completed ? "✓ Done" : "▶ Start"
      }</button>
      </div>
    </div>
  `
    )
    .join("");

  body.querySelectorAll(".special-start-btn").forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener("click", () => {
      const task = tasks.find((t) => String(t.id) === btn.dataset.id);
      if (task) openSpecialTaskModal(task);
    });
  });
}

function openSpecialTaskLink(link) {
  if (!link) return;
  try {
    if (tg && tg.openTelegramLink && /^https:\/\/t\.me\//.test(link)) {
      tg.openTelegramLink(link);
    } else if (tg && tg.openLink) {
      tg.openLink(link);
    } else {
      window.open(link, "_blank", "noopener,noreferrer");
    }
  } catch (e) {
    window.open(link, "_blank", "noopener,noreferrer");
  }
}

function openSpecialTaskModal(task) {
  const overlay = $("#specialTaskModal");
  if (!overlay) {
    console.error("Missing #specialTaskModal overlay in index.html");
    return;
  }

  // state machine per open:
  // "initial"  -> first tap: open the join link, then move on
  // "verify"   -> (verified only) waiting for the 2nd tap to actually check
  // "checking" -> request in flight, button disabled/showing "Checking..."
  let state = "initial";
  let showError = false;

  const defaultDesc = "After joining the channel/group, tap Verify below. Our server will check your membership.";

  function render() {
    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="special-modal-title">${esc(task.title)}</div>
        <div class="special-modal-desc">${esc(task.description || defaultDesc)}</div>
        ${showError ? `<div class="special-modal-error">Not a member yet — join first, then verify.</div>` : ""}
        <button class="verify-membership-btn" id="verifyMembershipBtn" ${state === "checking" ? "disabled" : ""}>
          ${state === "checking" ? "Checking..." : "✅ Verify Membership"}
        </button>
        ${state === "checking" ? "" : `<button class="cancel-special-btn" id="cancelSpecialBtn">Cancel</button>`}
      </div>
    `;
    const cancelBtn = $("#cancelSpecialBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", () => overlay.classList.remove("show"));
    $("#verifyMembershipBtn").addEventListener("click", handleVerifyClick);
  }

  async function finishClaim() {
    const result = await api("/api/task", { method: "POST", body: { action: "completeSpecialTask", taskId: task.id } });
    if (result.success) {
      overlay.classList.remove("show");
      showCongrats(result.reward);
      // Special-task cards now live on the bottom-nav "Task" page (Tasks
      // sub-tab), not the Earning tab's "Special Tasks" sub-tab — refresh
      // that page instead so the just-completed card updates.
      renderTask($("#mainContent"), "tasks");
      return;
    }
    if (result.error === "not_member") {
      state = "initial";
      showError = true;
      render();
      return;
    }
    state = "initial";
    showError = false;
    render();
    safeAlert(result.error || "Something went wrong. Please try again.");
  }

  async function handleVerifyClick() {
    showError = false;

    if (task.verificationType === "verified") {
      if (state === "initial") {
        openSpecialTaskLink(task.link);
        state = "verify";
        render();
        return;
      }
      // second tap — actually check membership
      state = "checking";
      render();
      await finishClaim();
      return;
    }

    // Normal task: open the link, then auto-claim after a short wait
    openSpecialTaskLink(task.link);
    state = "checking";
    render();
    setTimeout(() => {
      finishClaim();
    }, 5000);
  }

  state = "initial";
  showError = false;
  render();
  overlay.classList.add("show");
}

// ---------- AD LOADING OVERLAY ----------
function showAdLoadingOverlay() {
  let overlay = $("#adLoadingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "adLoadingOverlay";
    overlay.className = "ad-loading-overlay";
    overlay.innerHTML = `<div class="ad-spinner"></div><div class="ad-loading-text">Loading ad...</div>`;
    document.body.appendChild(overlay);
  }
  overlay.classList.add("show");
}

function hideAdLoadingOverlay() {
  const overlay = $("#adLoadingOverlay");
  if (overlay) overlay.classList.remove("show");
}

// ---------- CONGRATULATIONS POPUP ----------
function showCongrats(reward) {
  let overlay = $("#congratsOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "congratsOverlay";
    overlay.className = "congrats-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", () => overlay.classList.remove("show"));
  }
  overlay.innerHTML = `
    <div class="congrats-box">
      <div class="congrats-icon">📺</div>
      <div class="congrats-title">Congratulations!</div>
      <div class="congrats-sub">You have received</div>
      <div class="congrats-amount">+${esc(reward)} RDC</div>
      <div class="congrats-tap">Tap anywhere to continue</div>
    </div>
  `;
  overlay.classList.add("show");
}

// ---------- REGULAR TASKS BODY (title/link/text-fields/code/submit) ----------
// This is the same card logic that used to live directly inside renderTask()
// (below). It's now its own function so it can be called from the Earning
// tab's "🎁 Special Tasks" sub-tab body instead (see renderEarning above),
// while the bottom-nav "Task" page now shows the channel-join cards instead
// (renderSpecialTasks). Nothing about the cards themselves changed — same
// link/emoji/ellipsis title, same optional "Text / Code" auto-approve box,
// same submit + auto-approve/pending-review behavior.
async function renderRegularTasks(body) {
  body.innerHTML = `<div class="tab-loading"><div class="tab-loading-ring"></div></div>`;

  const tasks = await api("/api/task");
  if (!tasks.length) {
    body.innerHTML = `<div class="empty-state">No tasks available yet.</div>`;
    return;
  }

  body.innerHTML = tasks.map((t) => `
    <div class="task-card" data-id="${esc(t.id)}">
      <div class="title" style="font-size:15.5px;font-weight:600;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
        <span>${esc(t.title)}</span>
        ${
          t.link
            ? `<a href="#" class="task-title-link" data-link="${esc(t.link)}" style="display:inline-flex;align-items:center;gap:4px;color:#3b82f6;text-decoration:none;font-size:14px;font-weight:500;max-width:170px;">
                🔗<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:145px;display:inline-block;vertical-align:bottom;">${esc(t.link)}</span>
              </a>`
            : ""
        }
      </div>
      ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
      <div class="reward-tag">+${esc(t.reward)} RDC</div>
      ${(t.textFields || []).map((label, i) => `<input class="task-input" data-text="${i}" placeholder="${esc(label)}" />`).join("")}
      ${Array.from({ length: t.screenshotFields || 0 }).map((_, i) => `
        <div class="file-input-wrap">
          <label>Screenshot proof ${i + 1}</label>
          <input class="task-input" type="file" accept="image/*" data-shot="${i}" />
        </div>`).join("")}
      ${t.hasCode ? `<input class="task-input" data-code="1" placeholder="Text / Code" style="opacity:0.6;" />` : ""}
      <button class="btn-primary submit-task-btn" style="width:100%;margin-top:8px;">Submit</button>
    </div>
  `).join("");

  body.querySelectorAll(".task-title-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openSpecialTaskLink(a.dataset.link);
    });
  });

  body.querySelectorAll(".submit-task-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".task-card");
      const taskId = card.dataset.id;
      const texts = Array.from(card.querySelectorAll("[data-text]")).map((i) => i.value);
      const codeField = card.querySelector("[data-code]");
      const code = codeField ? codeField.value.trim() : undefined;
      btn.disabled = true;
      btn.textContent = "Submitting...";
      const result = await api("/api/task", { method: "POST", body: { taskId, texts, screenshots: [], code } });
      if (result.success) {
        if (result.autoApproved) {
          btn.textContent = "✓ Approved";
          showCongrats(result.reward);
        } else {
          btn.textContent = "Submitted — pending review";
        }
      } else {
        btn.disabled = false;
        btn.textContent = "Submit";
        safeAlert(result.error || "Error");
      }
    });
  });
}

// ---------- TASK (bottom-nav page) ----------
// The page shell/label ("Task" nav item, "📋 Tasks" / "🔗 Faucet" sub-tabs)
// is unchanged. What it renders under "📋 Tasks" is now the channel-join
// (special task) cards instead of the text-field task cards — that logic
// moved to the Earning tab's "🎁 Special Tasks" sub-tab (see renderEarning
// and renderRegularTasks above). Nothing was deleted, only swapped.
async function renderTask(content, sub = "tasks") {
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Complete tasks, earn RDC</div>
    <div class="tab-switch">
      <button class="${sub === "tasks" ? "active" : ""}" id="tasksTab">📋 Tasks</button>
      <button class="${sub === "faucet" ? "active" : ""}" id="faucetTab">🔗 Faucet</button>
    </div>
    <div id="taskBody"></div>
  `;
  $("#tasksTab").addEventListener("click", () => renderTask(content, "tasks"));
  $("#faucetTab").addEventListener("click", () => renderTask(content, "faucet"));

  const body = $("#taskBody");
  if (sub === "faucet") {
    body.innerHTML = `<div class="empty-state">No faucet available yet.</div>`;
    return;
  }

  return renderSpecialTasks(body);
}

// ---------- REFER ----------
async function renderRefer(content) {
  const ref = await api("/api/referral");
  content.innerHTML = `
    <div class="refer-hero">
      <div class="icon">👥</div>
      <h3>Refer friends, earn RDC</h3>
      <p>Each friend who completes all 3 steps earns you up to 220 RDC total.</p>
      <div class="link-box">${esc(ref.link)}</div>
      <div class="refer-actions">
        <button class="btn-primary" id="shareBtn">Share</button>
        <button class="btn-secondary" id="copyBtn">Copy</button>
      </div>
    </div>
    <div class="stat-grid" style="margin-top:14px;">
      <div class="stat-box"><div class="label">Total referrals</div><div class="value">${esc(ref.totalReferrals)}</div></div>
      <div class="stat-box"><div class="label">Referral earnings</div><div class="value">${esc(ref.referralEarnings)} RDC</div></div>
    </div>
    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>How rewards work</div>
    <div class="reward-step"><div class="step-num">1</div><div class="txt">Friend joins channel + community and verifies</div><div class="plus">+30</div></div>
    <div class="reward-step"><div class="step-num">2</div><div class="txt">Friend completes 10 tasks</div><div class="plus">+60</div></div>
    <div class="reward-step"><div class="step-num">3</div><div class="txt">Friend watches 25 ads</div><div class="plus">+130</div></div>

    <div class="top-refs-header" style="margin-top:18px;">
      <div class="section-label"><span class="dot"></span>Top 20 Referrers</div>
      <button class="pill-btn" id="toggleTop">Show</button>
    </div>
    <div class="ref-list" id="topRefList" style="display:none;"></div>
  `;
  $("#copyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(ref.link);
    $("#copyBtn").textContent = "Copied!";
    setTimeout(() => ($("#copyBtn").textContent = "Copy"), 1500);
  });
  $("#shareBtn").addEventListener("click", () => {
    if (tg) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(ref.link)}`);
    else window.open(`https://t.me/share/url?url=${encodeURIComponent(ref.link)}`, "_blank");
  });
  $("#toggleTop").addEventListener("click", async () => {
    const list = $("#topRefList");
    const btn = $("#toggleTop");
    if (list.style.display === "none") {
      const top = await api("/api/referral?top=1");
      list.innerHTML = top
        .map(
          (r) => `<div class="ref-row"><span class="rank-num">${esc(r.rank)}</span>
          <div class="avatar-circle">${esc((r.name || "?")[0].toUpperCase())}</div>
          <span class="name">${esc(r.name)}</span><span class="refs">${esc(r.refs)} refs</span></div>`
        )
        .join("") || `<div class="empty-state">No referrers yet.</div>`;
      list.style.display = "block";
      btn.textContent = "Hide";
    } else {
      list.style.display = "none";
      btn.textContent = "Show";
    }
  });
}

// ---------- SPIN WHEEL ----------
const SPIN_WHEEL_SEGMENTS = [
  { id: "usdt_001", short: "$0.005" },
  { id: "usdt_0025", short: "$0.01" },
  { id: "rdc10", short: "10 RDC" },
  { id: "rdc20", short: "20 RDC" },
  { id: "rdc30", short: "30 RDC" },
  { id: "rdc40", short: "40 RDC" },
  { id: "rdc50", short: "50 RDC" },
  { id: "free_spin", short: "+1 Spin" },
];

let spinWheelRotation = 0;
let spinInProgress = false;
// Countdown timer for the 1-minute per-spin cooldown (separate from the
// 15-spin/24-hour batch cooldown, which is handled server-side already).
let spinCooldownTimer = null;

async function renderSpin(content) {
  content.innerHTML = `
    <div class="spin-balances">
      <div class="spin-balance-box">
        <div class="coin-label">◆ RDC</div>
        <div class="value" id="spinRdcVal">0</div>
      </div>
      <div class="spin-balance-box">
        <div class="coin-label">💵 USDT</div>
        <div class="value" id="spinUsdtVal">0.000</div>
      </div>
    </div>

    <div class="spin-wheel-wrap">
      <div class="spin-arrow">▲</div>
      <div class="spin-wheel" id="spinWheel">
        ${SPIN_WHEEL_SEGMENTS.map(
          (s, i) => `
          <div class="spin-segment spin-segment-${i}" style="transform: rotate(${i * 45 + 22.5}deg);">
            <span class="spin-segment-label">${s.short}</span>
          </div>`
        ).join("")}
      </div>
      <div class="spin-wheel-center" id="spinWheelCenter">🎰</div>
    </div>

    <button class="btn-primary spin-btn" id="spinNowBtn" style="width:100%;">🎰 SPIN NOW</button>
    <div class="spin-remaining" id="spinRemainingText">Loading...</div>
  `;

  await refreshSpinStatus();
  $("#spinNowBtn").addEventListener("click", handleSpinClick);
  $("#spinWheelCenter").addEventListener("click", handleSpinClick);
}

// Shows the "X spins remaining" / "wait Ns" state without touching the
// batch-level "No spins left" flow below.
function startSpinCooldown(seconds, spinsAvailable) {
  const btn = $("#spinNowBtn");
  const remainingText = $("#spinRemainingText");
  if (!btn || !remainingText) return;
  if (spinCooldownTimer) clearInterval(spinCooldownTimer);

  let remaining = Math.ceil(seconds);
  btn.disabled = true;

  const tick = () => {
    if (remaining <= 0) {
      clearInterval(spinCooldownTimer);
      spinCooldownTimer = null;
      btn.disabled = spinInProgress;
      btn.textContent = "🎰 SPIN NOW";
      remainingText.textContent = `${spinsAvailable} spins remaining`;
      return;
    }
    btn.textContent = `Wait ${remaining}s`;
    remainingText.textContent = `${spinsAvailable} spins remaining`;
    remaining -= 1;
  };
  tick();
  spinCooldownTimer = setInterval(tick, 1000);
}

async function refreshSpinStatus() {
  const status = await api("/api/earn?type=spin");
  const rdcEl = $("#spinRdcVal");
  const usdtEl = $("#spinUsdtVal");
  if (rdcEl) rdcEl.textContent = status.rdcBalance || 0;
  if (usdtEl) usdtEl.textContent = (status.usdtBalance || 0).toFixed(3);

  const btn = $("#spinNowBtn");
  const remainingText = $("#spinRemainingText");
  if (!btn || !remainingText) return status;

  if (spinCooldownTimer) {
    clearInterval(spinCooldownTimer);
    spinCooldownTimer = null;
  }

  if (status.spinsAvailable > 0) {
    if (status.spinCooldownSecondsLeft > 0) {
      startSpinCooldown(status.spinCooldownSecondsLeft, status.spinsAvailable);
    } else {
      btn.disabled = spinInProgress;
      btn.textContent = "🎰 SPIN NOW";
      remainingText.textContent = `${status.spinsAvailable} spins remaining`;
    }
  } else {
    btn.disabled = true;
    btn.textContent = "No spins left";
    const hrs = Math.floor((status.cooldownSecondsLeft || 0) / 3600);
    const mins = Math.floor(((status.cooldownSecondsLeft || 0) % 3600) / 60);
    remainingText.textContent = `Next batch in ${hrs}h ${mins}m`;
  }
  return status;
}

async function handleSpinClick() {
  if (spinInProgress) return;
  const btn = $("#spinNowBtn");

  const status = await refreshSpinStatus();
  if (!status.spinsAvailable || status.spinsAvailable <= 0) {
    safeAlert("No spins left — check back after the cooldown.");
    return;
  }
  if (status.spinCooldownSecondsLeft > 0) {
    safeAlert(`Please wait ${status.spinCooldownSecondsLeft}s before spinning again.`);
    return;
  }
  const network = status.nextNetwork;
  if (!network) {
    safeAlert("Something went wrong — please try again.");
    return;
  }

  if (!acquireAdLock(network)) {
    safeAlert("Another ad is already playing — please wait for it to finish.");
    return;
  }

  spinInProgress = true;
  btn.disabled = true;
  btn.textContent = "Loading ad...";
  showAdLoadingOverlay();

  try {
    if (network === "monetag") {
      if (typeof show_11276042 !== "function") {
        throw new Error("Monetag SDK not loaded (show_11276042 is undefined).");
      }
      await show_11276042();
    } else if (network === "adsgram_daily") {
      if (typeof window.Adsgram === "undefined") {
        throw new Error("Adsgram SDK not loaded (window.Adsgram is undefined).");
      }
      const AdController = window.Adsgram.init({ blockId: "41201" });
      await AdController.show();
    }
  } catch (e) {
    console.error("Spin ad error:", e);
    hideAdLoadingOverlay();
    releaseAdLock();
    spinInProgress = false;
    btn.disabled = false;
    btn.textContent = "🎰 SPIN NOW";
    safeAlert("Ad failed to load or was skipped. Try again.");
    return;
  }

  releaseAdLock();
  hideAdLoadingOverlay();
  btn.textContent = "Spinning...";

  const result = await api("/api/earn", { method: "POST", body: { action: "spin", network } });

  if (!result.success) {
    spinInProgress = false;
    btn.disabled = false;
    btn.textContent = "🎰 SPIN NOW";
    if (result.error === "no_spins_left" || result.error === "invalid_network" || result.error === "spin_cooldown") {
      await refreshSpinStatus();
    } else {
      safeAlert(result.error || "Error — please try again.");
    }
    return;
  }

  spinWheelToSegment(result.segmentIndex, () => {
    spinInProgress = false;
    showSpinReward(result);
    refreshSpinStatus();
  });
}

function spinWheelToSegment(segmentIndex, onDone) {
  const wheel = $("#spinWheel");
  if (!wheel) {
    if (onDone) onDone();
    return;
  }
  const segmentAngle = 360 / SPIN_WHEEL_SEGMENTS.length;
  const extraTurns = 5 * 360;
  const targetWithinTurn = extraTurns - (segmentIndex * segmentAngle + segmentAngle / 2);

  spinWheelRotation = spinWheelRotation - (spinWheelRotation % 360) + targetWithinTurn;
  wheel.style.transition = "transform 4.5s cubic-bezier(0.17, 0.67, 0.12, 0.99)";
  wheel.style.transform = `rotate(${spinWheelRotation}deg)`;

  setTimeout(() => {
    if (onDone) onDone();
  }, 4600);
}

function showSpinReward(result) {
  let overlay = $("#congratsOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "congratsOverlay";
    overlay.className = "congrats-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", () => overlay.classList.remove("show"));
  }
  const rewardLabel =
    result.rewardType === "usdt"
      ? `+$${esc(result.rewardAmount)} USDT`
      : result.rewardType === "rdc"
      ? `+${esc(result.rewardAmount)} RDC`
      : "+1 Free Spin";
  overlay.innerHTML = `
    <div class="congrats-box">
      <div class="congrats-icon">🎰</div>
      <div class="congrats-title">Congratulations!</div>
      <div class="congrats-sub">You have received</div>
      <div class="congrats-amount">${rewardLabel}</div>
      <div class="congrats-tap">Tap anywhere to continue</div>
    </div>
  `;
  overlay.classList.add("show");
}

// ---------- WITHDRAW MODAL ----------
const METHODS = {
  binance: { min: +(2000 * RDC_RATE).toFixed(4), label: "Binance UID", placeholder: "Enter your Binance UID" },
  tonkeeper: { min: +(1600 * RDC_RATE).toFixed(4), label: "Tonkeeper Address", placeholder: "Enter your Tonkeeper wallet address" },
};

function openWithdrawModal(method = "binance") {
  const overlay = $("#withdrawModal");
  const m = METHODS[method];
  const usdtBalance = (userState.usdtBalance || 0).toFixed(4);
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">Withdraw <button class="modal-close" id="closeWithdraw">✕</button></div>
      <p style="color:var(--text-dim);font-size:13px;">USDT Balance: $${esc(usdtBalance)}</p>
      <div class="method-tabs">
        <div class="method-tab ${method === "binance" ? "active" : ""}" data-m="binance">Binance</div>
        <div class="method-tab ${method === "tonkeeper" ? "active" : ""}" data-m="tonkeeper">Tonkeeper</div>
      </div>
      <div class="field-label">${m.label}</div>
      <input class="field-input" id="wAddress" placeholder="${m.placeholder}" />
      <div class="field-label">Amount (USDT) — minimum $${m.min}</div>
      <input class="field-input" id="wAmount" type="number" placeholder="${m.min}" />
      <div class="hint-box">No withdraw fee — you receive the full amount in USDT (the 25% fee is already taken when you convert RDC to USDT). You must have watched at least 5 ads to withdraw. Requests are reviewed manually within 24 hours.</div>
      <button class="btn-primary" style="width:100%;" id="submitWithdraw">Submit Withdraw</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeWithdraw").addEventListener("click", () => overlay.classList.remove("show"));
  overlay.querySelectorAll(".method-tab").forEach((tab) => {
    tab.addEventListener("click", () => openWithdrawModal(tab.dataset.m));
  });
  $("#submitWithdraw").addEventListener("click", async () => {
    const address = $("#wAddress").value.trim();
    const amount = Number($("#wAmount").value);
    if (!address || !amount) return safeAlert("Please fill all fields");
    const result = await api("/api/withdraw", { method: "POST", body: { method, address, amount } });
    if (result.success) {
      safeAlert("Withdraw request submitted!");
      overlay.classList.remove("show");
      renderHome($("#mainContent"));
    } else {
      safeAlert(result.error || "Error");
    }
  });
}

// ---------- HISTORY MODAL ----------
async function openHistoryModal() {
  const overlay = $("#historyModal");
  const history = await api("/api/withdraw");
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">🕐 Withdraw History <button class="modal-close" id="closeHistory">✕</button></div>
      ${history.length === 0 ? `<div class="empty-state">No withdraw requests yet.</div>` :
        history.map((w) => `
          <div class="wh-row">
            <div class="wh-top">
              <span class="wh-coin">$${esc(w.amount)} USDT</span>
              <span class="wh-status ${esc(w.status)}">${esc(w.status)}</span>
            </div>
            <div class="wh-usd">No fee · You'll receive: $${esc(w.payout)} · ${esc(w.method)}</div>
          </div>
        `).join("")
      }
    </div>
  `;
  overlay.classList.add("show");
  $("#closeHistory").addEventListener("click", () => overlay.classList.remove("show"));
}

// ---------- PROFILE MODAL ----------
async function openProfileModal() {
  await refreshUser();
  const overlay = $("#profileModal");
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div style="text-align:center;">
        <div style="font-size:36px;">👤</div>
        <div class="profile-name">${esc(userState.firstName || "User")}</div>
        <div class="profile-uid">@${esc(userState.username || "unknown")} · ID ${esc(userState.telegramId)}</div>
      </div>
      <div class="profile-row"><span>Total balance</span><span>${esc(userState.balance)} RDC</span></div>
      <div class="profile-row"><span>Lifetime earned</span><span>${esc(userState.lifetimeEarned)} RDC</span></div>
      <div class="profile-row"><span>Referrals</span><span>${esc(userState.referralsCount)}</span></div>
      <div class="profile-row"><span>Tasks completed</span><span>${esc(userState.tasksCompleted)}</span></div>
      <button class="btn-secondary" style="width:100%;margin-top:16px;" id="closeProfile">Close</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeProfile").addEventListener("click", () => overlay.classList.remove("show"));
}

// ---------- PROMO MODAL ----------
function openPromoModal() {
  const overlay = $("#promoModal");
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">🎁 Promo Code <button class="modal-close" id="closePromo">✕</button></div>
      <input class="field-input" id="promoInput" placeholder="Enter promo code" />
      <button class="btn-primary" style="width:100%;margin-top:12px;" id="claimPromo">Claim</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closePromo").addEventListener("click", () => overlay.classList.remove("show"));
  $("#claimPromo").addEventListener("click", async () => {
    const code = $("#promoInput").value.trim();
    if (!code) return;

    if (!acquireAdLock("promo_adsgram")) {
      safeAlert("Another ad is already playing — please wait for it to finish.");
      return;
    }

    const btn = $("#claimPromo");
    btn.disabled = true;
    btn.textContent = "Loading ad...";
    showAdLoadingOverlay();

    try {
      await showPromoAd();
    } catch (e) {
      console.error("Promo ad error:", e);
      hideAdLoadingOverlay();
      releaseAdLock();
      btn.disabled = false;
      btn.textContent = "Claim";
      safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
      return;
    }

    releaseAdLock();
    hideAdLoadingOverlay();
    btn.textContent = "Redeeming...";

    const result = await api("/api/promo", { method: "POST", body: { code } });
    btn.disabled = false;
    btn.textContent = "Claim";

    if (result.success) {
      safeAlert(`+${result.reward} RDC claimed!`);
      overlay.classList.remove("show");
      renderHome($("#mainContent"));
    } else {
      safeAlert(result.error || "Error");
    }
  });
}

runLoading();
