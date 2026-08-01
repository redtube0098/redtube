// public/app.js
const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) tg.ready(), tg.expand();

const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;

const UID = tgUser ? tgUser.id : 5697990319; // fallback demo id for browser testing (used for display only now)
const USERNAME = tgUser ? tgUser.username : "demo_user";
const FIRSTNAME = tgUser ? tgUser.first_name : "Demo User";

let userState = null;
let currentTab = "home";
let adNetworks = [];

const RDC_RATE = 0.00004;
const MIN_CONVERT = 500;
const CONVERT_FEE_PCT = 0.25;

// Adsgram block id used for the "watch ad before redeeming a promo code" flow
const PROMO_ADSGRAM_BLOCK_ID = "38194";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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

// Shows one Adsgram rewarded ad. Resolves when the ad was watched through,
// rejects if skipped/errored — same pattern used elsewhere in this file.
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

// ---------- API HELPER ----------
// Every request automatically carries the Telegram-signed initData string,
// so hardened backend endpoints can verify who's really calling — the
// frontend no longer needs to pass uid manually on any call.
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

// ---------- LOADING ----------
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

// ---------- INIT ----------
async function initApp() {
  $("#loadingScreen").style.display = "none";

  // uid removed — hardened /api/user identifies the user from initData
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
  // ?uid=${UID} removed — hardened /api/user reads uid from initData
  userState = await api("/api/user");
}

// ---------- NAV ----------
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

// ---------- HOME ----------
async function renderHome(content) {
  await refreshUser();
  const usd = (userState.balance * RDC_RATE).toFixed(4);
  const usdtBalance = (userState.usdtBalance || 0).toFixed(3);

  content.innerHTML = `
    <div class="balance-card">
      <div class="meta">ID ${userState.telegramId}${userState.username ? " · @" + userState.username : ""}</div>
      <div class="label">Your balance</div>
      <div class="balance-cols">
        <div class="balance-col">
          <div class="coin-label">◆ RDC</div>
          <div class="amount">${userState.balance}</div>
        </div>
        <div class="balance-col">
          <div class="coin-label">💵 USDT</div>
          <div class="amount usdt">${usdtBalance}</div>
        </div>
      </div>
      <div class="usd">1 RDC = $${RDC_RATE} · ${userState.balance} RDC ≈ $${usd} USD</div>
      <div class="action-row-split">
        <button class="btn-primary" id="withdrawBtn">↑ Withdraw</button>
        <button class="icon-square-btn" id="converterBtn" title="Convert RDC to USDT">⇄</button>
      </div>
    </div>

    <div class="ticker">🔥 A user just withdrew from REDTUBE 🎉</div>

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

    <div class="pill-row">
      <button class="pill-btn-outline" id="milestonesBtn">🎯 Milestones</button>
      <button class="pill-btn-outline" id="leaderboardBtn">🏆 Leaderboard</button>
    </div>

    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>Platform stats</div>
    <div class="stat-grid stat-grid-3">
      <div class="stat-box"><div class="stat-icon">🎬</div><div class="value">${userState.videosToWatch || 0}</div><div class="label">Videos to watch</div></div>
      <div class="stat-box"><div class="stat-icon">✅</div><div class="value">${userState.tasksAvailable || 0}</div><div class="label">Tasks available</div></div>
      <div class="stat-box"><div class="stat-icon">👥</div><div class="value">${userState.referralsCount}</div><div class="label">Your referrals</div></div>
    </div>
  `;

  $("#withdrawBtn").addEventListener("click", () => openWithdrawModal());
  $("#converterBtn").addEventListener("click", () => openConverterModal());

  $("#promoBtnHome").addEventListener("click", async () => {
    const code = $("#promoInputHome").value.trim();
    if (!code) return;

    const btn = $("#promoBtnHome");
    btn.disabled = true;
    btn.textContent = "Loading ad...";
    showAdLoadingOverlay();

    try {
      await showPromoAd();
    } catch (e) {
      console.error("Promo ad error:", e);
      hideAdLoadingOverlay();
      btn.disabled = false;
      btn.textContent = "Redeem";
      safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
      return;
    }

    hideAdLoadingOverlay();
    btn.textContent = "Redeeming...";

    // uid removed — hardened /api/promo reads uid from initData
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
        <div class="value">${userState.balance} <span>RDC</span></div>
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
    // uid removed — hardened /api/withdraw reads uid from initData
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

// ---------- EARNING (ads/articles) ----------
const cooldownTimers = {};

async function renderEarning(content, sub = "ads") {
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Watch ads to earn</div>
    <p style="color:var(--text-dim);font-size:13px;margin-bottom:14px;">Each network has its own daily limit — watch them all for maximum earnings.</p>
    <div class="tab-switch">
      <button class="${sub === "ads" ? "active" : ""}" id="adsTab">📺 Ads</button>
      <button class="${sub === "articles" ? "active" : ""}" id="articlesTab">📰 Articles</button>
    </div>
    <div id="earningBody"></div>
  `;
  $("#adsTab").addEventListener("click", () => renderEarning(content, "ads"));
  $("#articlesTab").addEventListener("click", () => renderEarning(content, "articles"));

  const body = $("#earningBody");
  if (sub === "articles") {
    body.innerHTML = `<div class="empty-state">No articles available yet.</div>`;
    return;
  }

  body.innerHTML = `<div class="tab-loading"><div class="tab-loading-ring"></div></div>`;

  Object.values(cooldownTimers).forEach((t) => clearInterval(t));

  const NETWORKS = [
    { key: "adsgram_daily", name: "Adsgram Daily", icon: "⚡" },
    { key: "adsgram_special", name: "Adsgram Special", icon: "✨" },
    { key: "monetag", name: "Monetag", icon: "🎬" },
    { key: "gigapub", name: "GigaPub", icon: "📺" },
  ];

  // uid removed — hardened /api/earn reads uid from initData
  const status = await api(`/api/earn`);

  body.innerHTML = NETWORKS.map((n) => {
    const st = status[n.key] || { watchedToday: 0, limit: 0, reward: 0, cooldownSecondsLeft: 0, limitReached: false };
    return `
    <div class="ad-card">
      <div class="ad-icon">${n.icon}</div>
      <div class="ad-info">
        <span class="name">${n.name}</span><span class="reward">+${st.reward} RDC</span>
        <div class="ad-progress"><div class="ad-progress-fill" style="width:${(st.watchedToday / st.limit) * 100}%" id="prog-${n.key}"></div></div>
        <div class="count" id="count-${n.key}">${st.watchedToday}/${st.limit} today</div>
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
      startCooldown(btn, n.key, st.cooldownSecondsLeft);
    }
  });

  body.querySelectorAll(".watch-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
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
          await window.showGiga();
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
        btn.disabled = false;
        btn.textContent = "▶ Watch";
        safeAlert("Ad failed to load or was skipped. Try again.");
        return;
      }

      const result = await api("/api/earn", { method: "POST", body: { network: key } });
      hideAdLoadingOverlay();

      if (result.success) {
        $(`#count-${key}`).textContent = `${result.watchedToday}/${result.limit} today`;
        $(`#prog-${key}`).style.width = `${(result.watchedToday / result.limit) * 100}%`;

        showCongrats(result.reward);

        if (result.limitReached) {
          showLimitReached(btn, result.resetInSeconds);
        } else {
          startCooldown(btn, key, result.cooldownSeconds);
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

function startCooldown(btn, key, seconds) {
  if (cooldownTimers[key]) clearInterval(cooldownTimers[key]);
  let remaining = Math.ceil(seconds);
  btn.disabled = true;

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
      <div class="congrats-amount">+${reward} RDC</div>
      <div class="congrats-tap">Tap anywhere to continue</div>
    </div>
  `;
  overlay.classList.add("show");
}

// ---------- TASK ----------
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

  body.innerHTML = `<div class="tab-loading"><div class="tab-loading-ring"></div></div>`;

  const tasks = await api("/api/task");
  if (!tasks.length) {
    body.innerHTML = `<div class="empty-state">No tasks available yet.</div>`;
    return;
  }

  body.innerHTML = tasks.map((t) => `
    <div class="task-card" data-id="${t.id}">
      <div class="title">${t.title}</div>
      ${t.description ? `<div class="desc">${t.description}</div>` : ""}
      <div class="reward-tag">+${t.reward} RDC</div>
      ${(t.textFields || []).map((label, i) => `<input class="task-input" data-text="${i}" placeholder="${label}" />`).join("")}
      ${Array.from({ length: t.screenshotFields || 0 }).map((_, i) => `
        <div class="file-input-wrap">
          <label>Screenshot proof ${i + 1}</label>
          <input class="task-input" type="file" accept="image/*" data-shot="${i}" />
        </div>`).join("")}
      <button class="btn-primary submit-task-btn" style="width:100%;margin-top:8px;">Submit</button>
    </div>
  `).join("");

  body.querySelectorAll(".submit-task-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".task-card");
      const taskId = card.dataset.id;
      const texts = Array.from(card.querySelectorAll("[data-text]")).map((i) => i.value);
      btn.disabled = true;
      btn.textContent = "Submitting...";
      const result = await api("/api/task", { method: "POST", body: { taskId, texts, screenshots: [] } });
      if (result.success) {
        btn.textContent = "Submitted — pending review";
      } else {
        btn.disabled = false;
        btn.textContent = "Submit";
        safeAlert(result.error || "Error");
      }
    });
  });
}

// ---------- REFER ----------
async function renderRefer(content) {
  // uid removed — hardened /api/referral reads uid from initData
  const ref = await api("/api/referral");
  content.innerHTML = `
    <div class="refer-hero">
      <div class="icon">👥</div>
      <h3>Refer friends, earn RDC</h3>
      <p>Each friend who completes all 3 steps earns you up to 220 RDC total.</p>
      <div class="link-box">${ref.link}</div>
      <div class="refer-actions">
        <button class="btn-primary" id="shareBtn">Share</button>
        <button class="btn-secondary" id="copyBtn">Copy</button>
      </div>
    </div>
    <div class="stat-grid" style="margin-top:14px;">
      <div class="stat-box"><div class="label">Total referrals</div><div class="value">${ref.totalReferrals}</div></div>
      <div class="stat-box"><div class="label">Referral earnings</div><div class="value">${ref.referralEarnings} RDC</div></div>
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
      // top=1 is a public leaderboard endpoint — no auth needed, kept as-is
      const top = await api("/api/referral?top=1");
      list.innerHTML = top
        .map(
          (r) => `<div class="ref-row"><span class="rank-num">${r.rank}</span>
          <div class="avatar-circle">${r.name[0].toUpperCase()}</div>
          <span class="name">${r.name}</span><span class="refs">${r.refs} refs</span></div>`
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
// 8 segments — order MUST match SPIN_SEGMENTS in api/earn.js exactly, since
// the server sends back a segmentIndex into this same array.
const SPIN_WHEEL_SEGMENTS = [
  { id: "usdt_001", short: "$0.01" },
  { id: "usdt_0025", short: "$0.025" },
  { id: "rdc10", short: "10 RDC" },
  { id: "rdc20", short: "20 RDC" },
  { id: "rdc30", short: "30 RDC" },
  { id: "rdc40", short: "40 RDC" },
  { id: "rdc50", short: "50 RDC" },
  { id: "free_spin", short: "+1 Spin" },
];

let spinWheelRotation = 0; // accumulated, so each spin keeps turning forward
let spinInProgress = false;

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
  // 777 আইকনে ক্লিক করলেও একই স্পিন লজিক চলবে
  $("#spinWheelCenter").addEventListener("click", handleSpinClick);
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

  if (status.spinsAvailable > 0) {
    btn.disabled = spinInProgress;
    btn.textContent = "🎰 SPIN NOW";
    remainingText.textContent = `${status.spinsAvailable} spins remaining`;
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
  const network = status.nextNetwork;
  if (!network) {
    safeAlert("Something went wrong — please try again.");
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
      const AdController = window.Adsgram.init({ blockId: "int-38623" });
      await AdController.show();
    }
  } catch (e) {
    console.error("Spin ad error:", e);
    hideAdLoadingOverlay();
    spinInProgress = false;
    btn.disabled = false;
    btn.textContent = "🎰 SPIN NOW";
    safeAlert("Ad failed to load or was skipped. Try again.");
    return;
  }

  hideAdLoadingOverlay();
  btn.textContent = "Spinning...";

  const result = await api("/api/earn", { method: "POST", body: { action: "spin", network } });

  if (!result.success) {
    spinInProgress = false;
    btn.disabled = false;
    btn.textContent = "🎰 SPIN NOW";
    if (result.error === "no_spins_left" || result.error === "invalid_network") {
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
  const segmentAngle = 360 / SPIN_WHEEL_SEGMENTS.length; // 45deg
  const extraTurns = 5 * 360;
  // Land the CENTER of segmentIndex under the fixed top arrow (0deg).
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
      ? `+$${result.rewardAmount} USDT`
      : result.rewardType === "rdc"
      ? `+${result.rewardAmount} RDC`
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
  bkash: { min: +(5000 * RDC_RATE).toFixed(4), label: "bKash Number", placeholder: "Enter your bKash phone number" },
};

function openWithdrawModal(method = "binance") {
  const overlay = $("#withdrawModal");
  const m = METHODS[method];
  const usdtBalance = (userState.usdtBalance || 0).toFixed(4);
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">Withdraw <button class="modal-close" id="closeWithdraw">✕</button></div>
      <p style="color:var(--text-dim);font-size:13px;">USDT Balance: $${usdtBalance}</p>
      <div class="method-tabs">
        <div class="method-tab ${method === "binance" ? "active" : ""}" data-m="binance">Binance</div>
        <div class="method-tab ${method === "tonkeeper" ? "active" : ""}" data-m="tonkeeper">Tonkeeper</div>
        <div class="method-tab ${method === "bkash" ? "active" : ""}" data-m="bkash">bKash</div>
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
    // uid removed — hardened /api/withdraw reads uid from initData
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
  // ?uid=${UID} removed — hardened /api/withdraw reads uid from initData
  const history = await api("/api/withdraw");
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">🕐 Withdraw History <button class="modal-close" id="closeHistory">✕</button></div>
      ${history.length === 0 ? `<div class="empty-state">No withdraw requests yet.</div>` :
        history.map((w) => `
          <div class="wh-row">
            <div class="wh-top">
              <span class="wh-coin">$${w.amount} USDT</span>
              <span class="wh-status ${w.status}">${w.status}</span>
            </div>
            <div class="wh-usd">No fee · You'll receive: $${w.payout} · ${w.method}</div>
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
        <div class="profile-name">${userState.firstName || "User"}</div>
        <div class="profile-uid">@${userState.username || "unknown"} · ID ${userState.telegramId}</div>
      </div>
      <div class="profile-row"><span>Total balance</span><span>${userState.balance} RDC</span></div>
      <div class="profile-row"><span>Lifetime earned</span><span>${userState.lifetimeEarned} RDC</span></div>
      <div class="profile-row"><span>Referrals</span><span>${userState.referralsCount}</span></div>
      <div class="profile-row"><span>Tasks completed</span><span>${userState.tasksCompleted}</span></div>
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

    const btn = $("#claimPromo");
    btn.disabled = true;
    btn.textContent = "Loading ad...";
    showAdLoadingOverlay();

    try {
      await showPromoAd();
    } catch (e) {
      console.error("Promo ad error:", e);
      hideAdLoadingOverlay();
      btn.disabled = false;
      btn.textContent = "Claim";
      safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
      return;
    }

    hideAdLoadingOverlay();
    btn.textContent = "Redeeming...";

    // uid removed — hardened /api/promo reads uid from initData
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
