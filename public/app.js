// public/app.js
const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) tg.ready(), tg.expand();

const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;

const UID = tgUser ? tgUser.id : 5697990319; // fallback demo id for browser testing
const USERNAME = tgUser ? tgUser.username : "demo_user";
const FIRSTNAME = tgUser ? tgUser.first_name : "Demo User";

let userState = null;
let currentTab = "home";
let adNetworks = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
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

  // create/fetch user
  await api("/api/user", {
    method: "POST",
    body: { uid: UID, username: USERNAME, firstName: FIRSTNAME, refBy: startParam ? Number(startParam) : null },
  });

  const status = await api("/api/user", {
    method: "POST",
    body: { uid: UID, action: "check_join" },
  });

  if (!status.joined) {
    $("#joinGate").style.display = "flex";
  } else {
    enterApp();
  }
}

$("#checkJoinBtn").addEventListener("click", async () => {
  $("#checkJoinBtn").textContent = "Checking...";
  const status = await api("/api/user", { method: "POST", body: { uid: UID, action: "check_join" } });
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
  userState = await api(`/api/user?uid=${UID}`);
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

async function renderTab(tab) {
  currentTab = tab;
  const content = $("#mainContent");
  if (tab === "home") return renderHome(content);
  if (tab === "video") return renderVideo(content);
  if (tab === "earning") return renderEarning(content);
  if (tab === "task") return renderTask(content);
  if (tab === "refer") return renderRefer(content);
}

// ---------- HOME ----------
async function renderHome(content) {
  await refreshUser();
  const usd = (userState.balance * 0.00005).toFixed(4);
  content.innerHTML = `
    <div class="balance-card">
      <div class="meta">ID ${userState.telegramId}${userState.username ? " · @" + userState.username : ""}</div>
      <div class="label">Your balance</div>
      <div class="amount">${userState.balance} <span>WTC</span></div>
      <div class="usd">≈ $${usd} USD</div>
    </div>
    <div class="action-row">
      <button class="btn-primary" id="withdrawBtn">↑ Withdraw</button>
      <button class="btn-secondary" id="promoBtn">🎁 Promo code</button>
    </div>
    <div class="ticker">🔥 A user just withdrew from REDTUBE 🎉</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="label">Ads watched today</div><div class="value">${userState.adsWatchedToday}</div></div>
      <div class="stat-box"><div class="label">Tasks done today</div><div class="value">${userState.tasksDoneToday}</div></div>
      <div class="stat-box"><div class="label">Lifetime earned</div><div class="value">${userState.lifetimeEarned} WTC</div></div>
      <div class="stat-box"><div class="label">Referrals</div><div class="value">${userState.referralsCount}</div></div>
    </div>
    <div class="top-refs-header">
      <div class="section-label"><span class="dot"></span>Top 20 Referrers</div>
      <button class="pill-btn" id="toggleTop">Show</button>
    </div>
    <div class="ref-list" id="topRefList" style="display:none;"></div>
  `;
  $("#withdrawBtn").addEventListener("click", openWithdrawModal);
  $("#promoBtn").addEventListener("click", openPromoModal);
  $("#toggleTop").addEventListener("click", async () => {
    const list = $("#topRefList");
    const btn = $("#toggleTop");
    if (list.style.display === "none") {
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

// ---------- VIDEO ----------
function renderVideo(content) {
  const videos = [
    ["Space walker", "🚀"], ["Earth hall", "🌍"], ["1$ Vs 100K$", "💵"], ["Hunting and eating", "🏕️"],
    ["Survival of world", "🌿"], ["River monster", "🐊"], ["Man Vs wild", "🦁"], ["Agent Kim", "🎬"],
  ];
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Watch videos, earn WTC</div>
    <div class="video-grid">
      ${videos.map(([t, e]) => `
        <div class="video-card">
          <div class="video-thumb">${e}<div class="play">▶</div></div>
          <div class="video-title">${t}</div>
        </div>`).join("")}
    </div>
  `;
}

// ---------- EARNING (ads/articles) ----------
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

  const NETWORKS = [
    { key: "adsgram_daily", name: "Adsgram Daily", reward: 10, limit: 10, icon: "⚡" },
    { key: "adsgram_special", name: "Adsgram Special", reward: 20, limit: 5, icon: "✨" },
    { key: "monetag", name: "Monetag", reward: 15, limit: 20, icon: "🎬" },
    { key: "gigapub", name: "GigaPub", reward: 15, limit: 20, icon: "📺" },
  ];

  body.innerHTML = NETWORKS.map((n) => `
    <div class="ad-card">
      <div class="ad-icon">${n.icon}</div>
      <div class="ad-info">
        <span class="name">${n.name}</span><span class="reward">+${n.reward} WTC</span>
        <div class="ad-progress"><div class="ad-progress-fill" style="width:0%" id="prog-${n.key}"></div></div>
        <div class="count" id="count-${n.key}">0/${n.limit} today</div>
      </div>
      <button class="watch-btn" data-key="${n.key}">▶ Watch</button>
    </div>
  `).join("");

  body.querySelectorAll(".watch-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      btn.disabled = true;
      btn.textContent = "Loading...";
      // NOTE: plug your real ad network SDK's "show ad" call here before rewarding
      const result = await api("/api/earn", { method: "POST", body: { uid: UID, network: key } });
      if (result.success) {
        $(`#count-${key}`).textContent = `${result.watchedToday}/${result.limit} today`;
        $(`#prog-${key}`).style.width = `${(result.watchedToday / result.limit) * 100}%`;
        if (result.watchedToday >= result.limit) {
          btn.textContent = "Limit reached";
        } else {
          btn.disabled = false;
          btn.textContent = "▶ Watch";
        }
      } else {
        btn.disabled = false;
        btn.textContent = "▶ Watch";
        alert(result.error || "Error");
      }
    });
  });
}

// ---------- TASK ----------
async function renderTask(content, sub = "tasks") {
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Complete tasks, earn WTC</div>
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

  const tasks = await api("/api/task");
  if (!tasks.length) {
    body.innerHTML = `<div class="empty-state">No tasks available yet.</div>`;
    return;
  }

  body.innerHTML = tasks.map((t) => `
    <div class="task-card" data-id="${t.id}">
      <div class="title">${t.title}</div>
      ${t.description ? `<div class="desc">${t.description}</div>` : ""}
      <div class="reward-tag">+${t.reward} WTC</div>
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
      // NOTE: screenshots need an upload endpoint to convert to a URL; wire that up before going live
      btn.disabled = true;
      btn.textContent = "Submitting...";
      const result = await api("/api/task", { method: "POST", body: { uid: UID, taskId, texts, screenshots: [] } });
      if (result.success) {
        btn.textContent = "Submitted — pending review";
      } else {
        btn.disabled = false;
        btn.textContent = "Submit";
        alert(result.error || "Error");
      }
    });
  });
}

// ---------- REFER ----------
async function renderRefer(content) {
  const ref = await api(`/api/referral?uid=${UID}`);
  content.innerHTML = `
    <div class="refer-hero">
      <div class="icon">👥</div>
      <h3>Refer friends, earn WTC</h3>
      <p>Each friend who completes all 3 steps earns you up to 220 WTC total.</p>
      <div class="link-box">${ref.link}</div>
      <div class="refer-actions">
        <button class="btn-primary" id="shareBtn">Share</button>
        <button class="btn-secondary" id="copyBtn">Copy</button>
      </div>
    </div>
    <div class="stat-grid" style="margin-top:14px;">
      <div class="stat-box"><div class="label">Total referrals</div><div class="value">${ref.totalReferrals}</div></div>
      <div class="stat-box"><div class="label">Referral earnings</div><div class="value">${ref.referralEarnings} WTC</div></div>
    </div>
    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>How rewards work</div>
    <div class="reward-step"><div class="step-num">1</div><div class="txt">Friend joins channel + community and verifies</div><div class="plus">+30</div></div>
    <div class="reward-step"><div class="step-num">2</div><div class="txt">Friend completes 10 tasks</div><div class="plus">+60</div></div>
    <div class="reward-step"><div class="step-num">3</div><div class="txt">Friend watches 25 ads</div><div class="plus">+130</div></div>
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
}

// ---------- WITHDRAW MODAL ----------
const METHODS = {
  binance: { min: 2000, label: "Binance UID", placeholder: "Enter your Binance UID" },
  tonkeeper: { min: 1600, label: "Tonkeeper Address", placeholder: "Enter your Tonkeeper wallet address" },
  bkash: { min: 5000, label: "bKash Number", placeholder: "Enter your bKash phone number" },
};

function openWithdrawModal(method = "binance") {
  const overlay = $("#withdrawModal");
  const m = METHODS[method];
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">Withdraw <button class="modal-close" id="closeWithdraw">✕</button></div>
      <p style="color:var(--text-dim);font-size:13px;">Balance: ${userState.balance} WTC</p>
      <div class="method-tabs">
        <div class="method-tab ${method === "binance" ? "active" : ""}" data-m="binance">Binance</div>
        <div class="method-tab ${method === "tonkeeper" ? "active" : ""}" data-m="tonkeeper">Tonkeeper</div>
        <div class="method-tab ${method === "bkash" ? "active" : ""}" data-m="bkash">bKash</div>
      </div>
      <div class="field-label">${m.label}</div>
      <input class="field-input" id="wAddress" placeholder="${m.placeholder}" />
      <div class="field-label">Amount (WTC) — minimum ${m.min}</div>
      <input class="field-input" id="wAmount" type="number" placeholder="${m.min}" />
      <div class="hint-box">A 20% withdraw fee applies (you'll receive 80% of the requested amount). You must have completed at least 5 tasks to withdraw. Requests are reviewed manually within 24 hours.</div>
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
    if (!address || !amount) return alert("Please fill all fields");
    const result = await api("/api/withdraw", { method: "POST", body: { uid: UID, method, address, amount } });
    if (result.success) {
      alert("Withdraw request submitted!");
      overlay.classList.remove("show");
      renderHome($("#mainContent"));
    } else {
      alert(result.error || "Error");
    }
  });
}

// ---------- HISTORY MODAL ----------
async function openHistoryModal() {
  const overlay = $("#historyModal");
  const history = await api(`/api/withdraw?uid=${UID}`);
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">🕐 Withdraw History <button class="modal-close" id="closeHistory">✕</button></div>
      ${history.length === 0 ? `<div class="empty-state">No withdraw requests yet.</div>` :
        history.map((w) => `
          <div class="wh-row">
            <div class="wh-top">
              <span class="wh-coin">${w.amount} WTC</span>
              <span class="wh-status ${w.status}">${w.status}</span>
            </div>
            <div class="wh-usd">≈ $${w.usdValue} · ${w.method}</div>
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
      <div class="profile-row"><span>Total balance</span><span>${userState.balance} WTC</span></div>
      <div class="profile-row"><span>Lifetime earned</span><span>${userState.lifetimeEarned} WTC</span></div>
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
    const result = await api("/api/promo", { method: "POST", body: { uid: UID, code } });
    if (result.success) {
      alert(`+${result.reward} WTC claimed!`);
      overlay.classList.remove("show");
      renderHome($("#mainContent"));
    } else {
      alert(result.error || "Error");
    }
  });
}

runLoading();
