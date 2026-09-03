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

// Fallback only — overwritten from the admin's "Set Ads" config as soon as
// enterApp() fetches it, so admin changes take effect without a redeploy.
// This is a NETWORK TYPE id (e.g. "monetag", "adsgram_special", ...), the
// same pool used by every other ad slot — see showAdByNetworkType() further
// down, which is what actually plays it.
let PROMO_AD_NETWORK = "adsgram_special";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Panda Daily (Taddy) SDK bootstrap ----
// Per Taddy's docs, taddy.ready() must be called once on app load (it fires
// the initial "start" analytics event) — separate from actually showing an
// ad, which happens per-watch in showTaddyAd() further down. Polled +
// fire-and-forget: if the script hasn't finished registering window.Taddy
// yet, or the SDK is unreachable (ad blocker, network hiccup), this just
// gives up quietly — it must never block or break the rest of the app from
// loading, same contract as every other ad SDK here.
const TADDY_PUB_ID = "0baa1b4ce7594e56d3fd87ddb314c86d";
(function initTaddy() {
  const start = Date.now();
  const tryInit = () => {
    if (window.Taddy) {
      try {
        window.Taddy.init(TADDY_PUB_ID);
        window.Taddy.ready();
      } catch (e) {
        console.error("[Taddy] init failed:", e);
      }
      return;
    }
    if (Date.now() - start < 5000) setTimeout(tryInit, 100);
  };
  tryInit();
})();

// Display-only USDT formatter: TRUNCATES (never rounds) to 2 decimals, so
// e.g. a real balance of 0.0014 or 0.0019 both show as "0.00" — the 3rd
// decimal (and beyond) still exists in the real balance and is used as-is
// for every actual calculation/withdraw check, it's just never shown.
// toFixed() would round (0.016 -> "0.02"), which is why this exists
// instead of just calling .toFixed(2) everywhere.
function formatUsdt(value) {
  const n = Number(value) || 0;
  const truncated = Math.floor(n * 100) / 100;
  return truncated.toFixed(2);
}

// Display-only RDC formatter: below 10,000 shows the plain number truncated
// to 2 decimals (trailing ".00" dropped); at 10,000+ switches to compact
// "Xk" notation (12345 -> "12.34k", 10000 -> "10k") so large balances stay
// readable on the balance card. Same truncate-never-round philosophy as
// formatUsdt above — the full-precision value is untouched everywhere else
// (conversion math, withdraw checks), this only ever affects what's shown.
function formatRdcCompact(value) {
  const n = Number(value) || 0;
  const trimTwo = (x) => {
    const truncated = Math.floor(x * 100) / 100;
    return truncated % 1 === 0 ? truncated.toFixed(0) : truncated.toFixed(2);
  };
  if (n >= 10000) {
    return `${trimTwo(n / 1000)}k`;
  }
  return trimTwo(n);
}

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

// ---------- ADEXIUM AUTO-POPUP GUARD ----------
// Adexium's autoMode() has no official pause/stop/callback API (confirmed —
// their docs only expose autoMode()), so we can't ask it to hold off while
// another ad is running. Instead we watch the DOM for whatever element it
// injects when it pops an ad up, and:
//   - if another ad is already locked when Adexium's overlay appears, we
//     remove it immediately, before the user ever sees it — Adexium's own
//     internal timer will simply try again later on its own.
//   - if Adexium's overlay appears while nothing else is active, we treat
//     it as holding the lock too, so a manually-tapped ad button at that
//     exact moment gets blocked instead of colliding with it — and we
//     release the lock again once its overlay is removed from the DOM.
function isAdexiumNode(node) {
  if (!(node instanceof HTMLElement)) return false;
  const idClass = `${node.id || ""} ${node.className || ""}`.toLowerCase();
  if (idClass.includes("adexium")) return true;
  const iframe = node.tagName === "IFRAME" ? node : node.querySelector && node.querySelector("iframe");
  if (iframe && /adexium|tgads/i.test(iframe.src || "")) return true;
  return false;
}

const adexiumObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!isAdexiumNode(node)) continue;

      if (activeAdNetwork && activeAdNetwork !== "adexium_auto") {
        // Another ad is already showing — remove Adexium's overlay before
        // it becomes visible. It'll retry on its own schedule later.
        node.remove();
        console.log("[AdexiumGuard] Blocked Adexium auto-popup — another ad was already active.");
      } else {
        acquireAdLock("adexium_auto");
      }
    }
    for (const node of m.removedNodes) {
      if (isAdexiumNode(node) && activeAdNetwork === "adexium_auto") {
        releaseAdLock();
      }
    }
  }
});
adexiumObserver.observe(document.body, { childList: true, subtree: true });

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
// Strips "fancy"/strikethrough-style Unicode combining marks that some
// admins accidentally paste in from "stylish text" generator sites —
// these render as garbled/overlapping characters ("Vlwebsite&getcode"
// instead of "Visit website & get code") because dozens of invisible
// combining strikethrough marks stack on top of a handful of base
// letters. This only removes Unicode category "Mark, Nonspacing"
// (combining diacriticals) — normal Bengali/English/emoji text is
// completely unaffected.
function stripFancyUnicode(str) {
  if (typeof str !== "string") return str;
  try {
    return str.normalize("NFKD").replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, "");
  } catch (e) {
    return str;
  }
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

// Plays whichever ad network the admin picked for the promo "Redeem"
// button (see PROMO_AD_NETWORK above / showAdByNetworkType() further down,
// which is the same dispatcher the Earning tab and Spin wheel use — so any
// network the admin has wired in there works here too, not just Adsgram).
function showPromoAd() {
  return showAdByNetworkType(PROMO_AD_NETWORK);
}

// --- Signed action tokens (see api/_actionSign.js) -----------------------
// Some GET status/list endpoints (/api/earn, /api/task, /api/withdraw) may
// hand back a short-lived "X-Action-Token" response header. api() below
// caches the latest one per endpoint and echoes it back automatically on
// that same endpoint's next POST. Purely additive: if the server never
// sends this header (e.g. ACTION_SIGNING_SECRET isn't configured yet),
// actionTokens just stays empty and nothing about any request changes.
const actionTokens = { "/api/earn": null, "/api/task": null, "/api/withdraw": null };

function actionTokenKeyFor(path) {
  const clean = path.split("?")[0];
  return Object.prototype.hasOwnProperty.call(actionTokens, clean) ? clean : null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (tg && tg.initData) {
    headers["X-Telegram-Init-Data"] = tg.initData;
  }
  const method = opts.method || "GET";
  const tokenKey = actionTokenKeyFor(path);
  if (tokenKey && method === "POST" && actionTokens[tokenKey]) {
    headers["X-Action-Token"] = actionTokens[tokenKey];
  }
  const res = await fetch(path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (tokenKey) {
    const freshToken = res.headers.get("x-action-token");
    if (freshToken) actionTokens[tokenKey] = freshToken;
  }
  return res.json();
}

// Loading screen: previously the progress bar was purely cosmetic — it ran
// on its own fake timer, and only once it hit 100% did initApp() start the
// REAL network calls (create/refresh user, check channel join), while
// hiding the loading screen immediately. That meant users saw the bar
// finish, then a blank screen with zero feedback while the actual data was
// still loading over the network — the real source of the "app takes a
// while to open" complaint.
//
// Now the real data fetch kicks off immediately, in parallel with the bar
// animation, and the loading screen only comes down once BOTH the bar
// animation and the real data are ready — whichever finishes last. On a
// fast connection the bar's own timing still gives a smooth, non-instant
// feel; on a slow connection the bar keeps animating (looping back down
// briefly and re-filling) instead of sitting frozen at 100% with nothing
// happening.
function runLoading() {
  const fill = $("#progressFill");
  const percentText = $("#progressPercent");
  let pct = 10;
  if (percentText) percentText.textContent = "10%";

  const dataPromise = (async () => {
    await api("/api/user", {
      method: "POST",
      body: { username: USERNAME, firstName: FIRSTNAME, refBy: startParam ? Number(startParam) : null },
    });
    return api("/api/user", {
      method: "POST",
      body: { action: "check_join" },
    });
  })();

  let animationDone = false;
  let dataDone = false;
  let dataResult = null;

  function maybeFinish() {
    if (animationDone && dataDone) {
      finishLoading(dataResult);
    }
  }

  dataPromise
    .then((status) => {
      dataResult = status;
    })
    .catch((e) => {
      console.error("Initial load failed:", e);
      dataResult = { joined: false };
    })
    .finally(() => {
      dataDone = true;
      maybeFinish();
    });

  const interval = setInterval(() => {
    pct += Math.random() * 16;
    if (pct >= 100) {
      pct = 100;
      fill.style.width = "100%";
      if (percentText) percentText.textContent = "100%";
      clearInterval(interval);
      animationDone = true;
      maybeFinish();
    } else if (pct >= 96 && !dataDone) {
      // Bar animation would otherwise finish before the network calls do —
      // ease it back a little and keep it gently moving instead of
      // freezing at "99%" with no visible progress while data is still
      // in flight.
      pct = 92 + Math.random() * 4;
      fill.style.width = pct + "%";
      if (percentText) percentText.textContent = Math.floor(pct) + "%";
    } else {
      fill.style.width = pct + "%";
      if (percentText) percentText.textContent = Math.floor(pct) + "%";
    }
  }, 180);
}

function finishLoading(status) {
  $("#loadingScreen").style.display = "none";
  if (!status || !status.joined) {
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
  refreshPromoAdConfig(); // fire-and-forget — home renders immediately with the fallback id if this is still in flight

  // BUGFIX (nav flash on cold start): the nav buttons become clickable the
  // instant #bottomNav is shown above, but this function's own
  // await refreshUser() can still take a moment (slow connection, cold
  // serverless function, etc.). If the user tapped a different tab
  // (Earning, Task, ...) during that wait, currentTab already changed
  // synchronously in the click handler (renderTab() sets it as its very
  // first line). Previously we'd call renderTab("home") unconditionally
  // right here regardless, yanking them back to Home for a moment before
  // their real tab's (slower) render finished and "corrected" it back —
  // that flash is the bug. Now we only render Home if Home is still what
  // should actually be showing.
  if (currentTab === "home") {
    renderTab("home");
  }

  checkPendingGift();
}

async function refreshUser() {
  userState = await api("/api/user");
}

// Pulls the admin-configurable ad NETWORK TYPE for the promo "Redeem"
// button's ad. Best-effort: on any failure (or if the admin hasn't set one
// yet) the hardcoded fallback above stays in place, so promo redemption
// never breaks because of this fetch.
async function refreshPromoAdConfig() {
  try {
    const status = await api("/api/earn");
    if (status && typeof status._promoAdNetwork === "string" && NETWORK_TYPE_DISPLAY[status._promoAdNetwork]) {
      PROMO_AD_NETWORK = status._promoAdNetwork;
    }
  } catch (e) {
    console.error("Failed to load promo ad config, using fallback network:", e);
  }
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

// ---------- MODAL BACKDROP CLICK-TO-CLOSE ----------
// Every modal (withdraw, converter, history, profile, promo/leaderboard/
// weekly-contest, specialTask) uses the same ".modal-overlay" shell in
// index.html. Those overlay <div>s are static — only their innerHTML gets
// replaced each time a modal opens — so we can attach this listener once,
// here, instead of re-attaching it inside every open*Modal() function.
// Checking `e.target === overlay` ensures a click INSIDE the modal-sheet
// card (or on any of its buttons/inputs) does NOT bubble up and close the
// modal — only a click on the dimmed backdrop area itself does, matching
// tapping the ✕ button.
$$(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("show");
    }
  });
});

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
  // This auto-popup previously bypassed the ad lock entirely, so it could
  // fire Monetag's popup WHILE another network (e.g. USL Special) was already
  // showing an ad — the two SDKs then fight over the same overlay space,
  // which can make the second one (often the one the user actually tapped
  // "Watch" for) fail to render at all. Now it acquires the same lock as
  // every other ad trigger point, so it simply skips itself if anything
  // else is already in flight instead of stacking on top of it.
  if (!acquireAdLock("monetag_auto_popup")) return;
  show_11276042("pop")
    .catch((e) => {
      console.log("Auto popup ad skipped/failed:", e);
    })
    .finally(() => {
      releaseAdLock();
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
  const usdtBalance = formatUsdt(userState.usdtBalance);
  const spinStatus = await api("/api/earn?type=spin");
  const spinsRemaining = spinStatus.spinsAvailable || 0;

content.innerHTML = `
    <div class="balance-card-v2">
      <div class="bc-top-row">
        <div class="bc-top-label">Total Balance <span class="bc-eye">👁</span></div>
        <div class="bc-meta">
          <div>ID ${esc(userState.telegramId)}</div>
          ${userState.username ? `<div class="bc-username">@${esc(userState.username)} <span class="bc-copy">⧉</span></div>` : ""}
        </div>
      </div>
      <div class="bc-total-row">
        <span class="bc-total-amount">${esc(formatRdcCompact(userState.balance))}</span>
        <span class="bc-total-icon">◆</span>
        <span class="bc-total-unit">RDC</span>
      </div>
      <div class="bc-total-usd">≈ $${esc(usd)} USD</div>

      <div class="bc-cols">
        <div class="bc-col">
          <div class="bc-col-label"><span class="bc-col-icon bc-col-icon-rdc">◆</span> RDC Balance</div>
          <div class="bc-col-amount">${esc(formatRdcCompact(userState.balance))}</div>
          <div class="bc-col-usd">≈ $${esc(usd)}</div>
        </div>
        <div class="bc-col">
          <div class="bc-col-label"><span class="bc-col-icon bc-col-icon-usdt">T</span> USDT Balance</div>
          <div class="bc-col-amount bc-col-amount-usdt">${esc(usdtBalance)}</div>
          <div class="bc-col-usd">≈ $${esc(usdtBalance)}</div>
        </div>
      </div>

      <div class="bc-key-box">
        <div class="bc-key-left">
          <span class="bc-col-icon bc-col-icon-key">🔑</span>
          <div class="bc-key-text">
            <div class="bc-key-label">Key Coin</div>
            <div class="bc-key-sub">Unlocks withdraw</div>
          </div>
        </div>
        <div class="bc-key-amount">${esc(userState.keyCoinBalance || 0)}</div>
      </div>

      <div class="bc-rate-row">
        <span>1 RDC = $${RDC_RATE}</span>
        <span class="bc-rate-sep">|</span>
        <span>${esc(formatRdcCompact(userState.balance))} RDC = $${esc(usd)} USD</span>
      </div>
    </div>

    <div class="bc-action-row">
      <button class="bc-action-btn" id="withdrawBtn">
        <span class="bc-action-icon">↑</span>
        <span>Withdraw</span>
      </button>
      <button class="bc-action-btn" id="converterBtn">
        <span class="bc-action-icon">⇄</span>
        <span>Convert</span>
      </button>
      <button class="bc-action-btn" id="historyBtnHome">
        <span class="bc-action-icon">🕐</span>
        <span>History</span>
      </button>
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

    <div class="promo-box key-store-box" id="keyStoreBox">
      <div class="promo-card">
        <div class="promo-icon">🔑</div>
        <div class="promo-text">
          <div class="promo-title">Key Store</div>
          <div class="promo-sub">Buy Key Coins from the store to unlock more withdrawals</div>
        </div>
        <button class="btn-primary key-store-open-btn" id="openKeyStoreBtn">Open Store</button>
      </div>
    </div>

    <div class="quick-grid">
      <button class="quick-card" id="weeklyContestCard">
        <div class="quick-icon quick-icon-purple">🎯</div>
        <div class="quick-title">Weekly Contest</div>
        <div class="quick-sub">Win exciting rewards</div>
      </button>
      <button class="quick-card" id="leaderboardCard">
        <div class="quick-icon quick-icon-gold">🏆</div>
        <div class="quick-title">Leaderboard</div>
        <div class="quick-sub">Top earners ranking</div>
      </button>
      <button class="quick-card" id="officialChannelCard">
        <div class="quick-icon quick-icon-blue">📣</div>
        <div class="quick-title">Official Channel</div>
        <div class="quick-sub">Join our channel</div>
      </button>
      <button class="quick-card" id="payChannelCard">
        <div class="quick-icon quick-icon-green">💲</div>
        <div class="quick-title">Pay Channel</div>
        <div class="quick-sub">Payment proof</div>
      </button>
    </div>

    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>Platform stats</div>
    <div class="stat-grid stat-grid-3">
      <div class="stat-box"><div class="stat-icon">🎰</div><div class="value">${esc(spinsRemaining)}</div><div class="label">Spin Remaining</div></div>
      <div class="stat-box"><div class="stat-icon">✅</div><div class="value">${esc(userState.tasksAvailable || 0)}</div><div class="label">Tasks available</div></div>
      <div class="stat-box"><div class="stat-icon">👥</div><div class="value">${esc(userState.referralsCount)}</div><div class="label">Your referrals</div></div>
    </div>

    <div class="circle-row">
      <button class="circle-btn" id="quickSpinBtn">
        <div class="circle-icon">🎰</div>
        <div class="circle-label">Spin & Win</div>
      </button>
      <button class="circle-btn" id="quickTaskBtn">
        <div class="circle-icon">📋</div>
        <div class="circle-label">Complete Task</div>
      </button>
      <button class="circle-btn" id="quickReferBtn">
        <div class="circle-icon">👥</div>
        <div class="circle-label">Refer & Earn</div>
      </button>
      <button class="circle-btn" id="quickDailyBtn">
        <span class="soon-badge">SOON</span>
        <div class="circle-icon">🎁</div>
        <div class="circle-label">Daily Bonus</div>
      </button>
      <button class="circle-btn" id="quickWatchBtn">
        <div class="circle-icon">🎬</div>
        <div class="circle-label">Earning</div>
      </button>
    </div>
  `;

  $("#withdrawBtn").addEventListener("click", () => openWithdrawModal());
  $("#converterBtn").addEventListener("click", () => openConverterModal());
  $("#historyBtnHome").addEventListener("click", openHistoryModal);
  startLiveTicker();

  // Switches both the visible tab AND the bottom-nav active highlight,
  // same as tapping the nav item directly — used by the quick-action
  // circle buttons below so they behave exactly like nav taps.
  function goToTab(tab) {
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    const navBtn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (navBtn) navBtn.classList.add("active");
    renderTab(tab);
  }

  $("#keyStoreBox").addEventListener("click", () => openKeyStoreModal());
  $("#weeklyContestCard").addEventListener("click", () => openWeeklyContestModal());
  $("#leaderboardCard").addEventListener("click", () => openLeaderboardModal());
  $("#officialChannelCard").addEventListener("click", () => openSpecialTaskLink("https://t.me/redtubeofficial00"));
  $("#payChannelCard").addEventListener("click", () => openSpecialTaskLink("https://t.me/redtubepayment"));

  $("#quickSpinBtn").addEventListener("click", () => goToTab("spin"));
  $("#quickTaskBtn").addEventListener("click", () => goToTab("task"));
  $("#quickReferBtn").addEventListener("click", () => goToTab("refer"));
  $("#quickWatchBtn").addEventListener("click", () => goToTab("earning"));
  $("#quickDailyBtn").addEventListener("click", () => safeAlert("Daily Bonus — coming soon"));

  $("#promoBtnHome").addEventListener("click", async () => {
    const code = $("#promoInputHome").value.trim();
    if (!code) return;

    if (!acquireAdLock("promo_ad")) {
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
      if (e && e.adSkippedEarly) {
        safeAlert(`Please watch at least ${MIN_AD_WATCH_MS / 1000} seconds of the ad to redeem your code.`);
      } else {
        safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
      }
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
        <div class="value">${esc(formatRdcCompact(userState.balance))} <span>RDC</span></div>
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
// Ad network TYPES (the actual SDKs) that can be assigned to any earning
// slot or spin position via the admin "Set Ads" panel.
const NETWORK_TYPE_DISPLAY = {
  monetag: { name: "Monetag", icon: "🎬" },
  adsgram_daily: { name: "Adsgram Daily", icon: "⚡" },
  adsgram: { name: "Adsgram", icon: "⚡" },
  adsgram_special: { name: "Adsgram Special", icon: "⚡" },
  usl_special: { name: "USL SPECIAL", icon: "📺" },
  adsgalaxy: { name: "AdsGalaxy", icon: "🌌" },
  panda_daily: { name: "Panda Daily", icon: "🐼" },
};

// Each of the 3 Adsgram network types has its own block id — keep this in
// sync with the admin panel's "Set Ads" options if a block id ever changes.
const ADSGRAM_BLOCK_IDS = {
  adsgram_daily: "38194",
  adsgram: "41201",
  adsgram_special: "int-38623",
};

// ══════════════════════════════════════════════════════════════
// AD NETWORK SDK WRAPPERS — every network below (Monetag, all 3 Adsgram
// slots, USL Ads/TowerAds, AdsGalaxy) follows the same two safety patterns,
// so no single network can get the loading overlay/button stuck forever:
//   1. SDK-READY POLL — a network's <script> tag can still be finishing its
//      own async init the instant a user taps "Watch" (especially right
//      after the app just opened), so we briefly poll for its entry point
//      to exist instead of failing on the very first tick.
//   2. SAFETY-NET TIMEOUT — if the SDK's own promise/callback never fires
//      (no fill, dead iframe, network hiccup, etc.) we reject after a fixed
//      timeout instead of hanging indefinitely.
// A MINIMUM WATCH TIME (see showAdByNetworkType at the bottom of this
// block) is enforced centrally on top of ALL FOUR networks, so every ad
// trigger point in the app — Earning tab, Spin wheel, Promo code redeem
// (both the home-screen field and the modal) — gets it automatically,
// with nothing per-call-site to remember.
// ══════════════════════════════════════════════════════════════

const MIN_AD_WATCH_MS = 7000;        // must stay "in" the ad at least this long, or no reward
const AD_SDK_POLL_TIMEOUT_MS = 5000; // how long we wait for a script tag to finish registering
const AD_SHOW_TIMEOUT_MS = 60000;    // how long we wait for an opened ad to actually resolve

function pollForAdSdk(checkFn, timeoutMs, errorMessage) {
  if (checkFn()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (checkFn()) { resolve(); return; }
      if (Date.now() - startedAt > timeoutMs) { reject(new Error(errorMessage)); return; }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function withAdShowTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    Promise.resolve(promise).then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(result);
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(err instanceof Error ? err : new Error(String(err || "ad_error")));
    });
  });
}

// ---- Monetag ----
const showMonetagAd = () => pollForAdSdk(
  () => typeof show_11276042 === "function",
  AD_SDK_POLL_TIMEOUT_MS,
  "Monetag SDK not loaded (show_11276042 is undefined) — check if libtl.com/sdk.js loaded, or if an ad blocker is active."
).then(() => withAdShowTimeout(show_11276042(), AD_SHOW_TIMEOUT_MS, "Monetag ad timed out — no response from the ad SDK."));

// ---- Adsgram (all 3 slot types share this) ----
const showAdsgramAd = (type) => pollForAdSdk(
  () => typeof window.Adsgram !== "undefined",
  AD_SDK_POLL_TIMEOUT_MS,
  "Adsgram SDK not loaded (window.Adsgram is undefined) — check if sad.adsgram.ai script loaded, or if an ad blocker is active."
).then(() => {
  const AdController = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_IDS[type] });
  return withAdShowTimeout(AdController.show(), AD_SHOW_TIMEOUT_MS, "Adsgram ad timed out — no response from the ad SDK.");
});

// ---- USL Ads (TowerAds) ----
// TowerAds reports success via an onRewardEarned(reward) callback rather
// than resolving loadAndShow()'s own promise, so this wraps that callback
// pattern into the same Promise-based shape every other network uses here
// (resolve = ad finished, reject = no reward / error). A single TowerAds
// instance is created once and reused; onRewardEarned/onError are
// reassigned per call since only one ad plays at a time (see acquireAdLock
// above, which already guarantees that).
let towerAdsInstance = null;
function getTowerAdsInstance() {
  if (towerAdsInstance) return towerAdsInstance;
  if (typeof TowerAds === "undefined") return null;
  towerAdsInstance = new TowerAds({
    apiKey: "4137b6e6489edc50bc13aac52e62b605",
    placementId: "plc_03a1a55d4d78f98f",
    onRewardEarned() {},
    onError() {},
  });
  return towerAdsInstance;
}
const showUslSpecialAd = () => pollForAdSdk(
  () => getTowerAdsInstance() !== null,
  AD_SDK_POLL_TIMEOUT_MS,
  "USL Ads SDK not loaded (TowerAds is undefined) — check if the USL Ads script tag loaded, or if an ad blocker is active."
).then(() => new Promise((resolve, reject) => {
  const instance = getTowerAdsInstance();
  let settled = false;
  const t = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error("USL Ads timed out — no response from the ad SDK."));
  }, AD_SHOW_TIMEOUT_MS);
  instance.onRewardEarned = (reward) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    resolve(reward);
  };
  instance.onError = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    reject(error instanceof Error ? error : new Error(String(error || "usl_ad_error")));
  };
  instance.loadAndShow().catch((error) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    reject(error instanceof Error ? error : new Error(String(error || "usl_ad_error")));
  });
}));

// ---- AdsGalaxy (Mini App ID: 26) ----
// window.showAdsGalaxy() resolves once the ad has actually played, with the
// same shape every other network here uses — so it plugs straight into the
// shared SDK-ready poll + safety timeout. Per AdsGalaxy's own integration
// docs, the resolved result carries a request_id that must be forwarded to
// our backend (never credit a wallet purely client-side) — see where
// showAdByNetworkType's return value is used in the watch-btn handler
// below, which sends it along with the normal POST /api/earn call.
const showAdsGalaxyAd = () => pollForAdSdk(
  () => typeof window.showAdsGalaxy === "function",
  AD_SDK_POLL_TIMEOUT_MS,
  "AdsGalaxy SDK not loaded (window.showAdsGalaxy is undefined) — check if the AdsGalaxy script tag loaded, or if an ad blocker is active."
).then(() => withAdShowTimeout(
  window.showAdsGalaxy(),
  AD_SHOW_TIMEOUT_MS,
  "AdsGalaxy ad timed out — no response from the ad SDK."
));

// ---- Panda Daily (Taddy) ----
// Taddy's interstitial() call is callback-based (onClosed / onViewThrough)
// rather than promise-based like Monetag/Adsgram/AdsGalaxy — same shape as
// the USL Ads wrapper above. onViewThrough only fires once the ad was
// actually watched through, so — same rule as every other network here —
// that's the ONLY callback allowed to resolve/credit a reward. onClosed
// firing without a matching onViewThrough (ad skipped/closed early) rejects
// instead, so no reward is credited for an incomplete view.
const showPandaDailyAd = () => pollForAdSdk(
  () => !!(window.Taddy && typeof window.Taddy.ads === "function"),
  AD_SDK_POLL_TIMEOUT_MS,
  "Panda Daily SDK not loaded (window.Taddy is undefined) — check if sdk.taddy.pro loaded, or if an ad blocker is active."
).then(() => new Promise((resolve, reject) => {
  let settled = false;
  const t = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error("Panda Daily ad timed out — no response from the ad SDK."));
  }, AD_SHOW_TIMEOUT_MS);
  try {
    window.Taddy.ads().interstitial({
      onViewThrough: (id) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(id);
      },
      onClosed: () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(new Error("Panda Daily ad was closed before it finished — no reward."));
      },
    });
  } catch (e) {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    reject(e instanceof Error ? e : new Error(String(e || "panda_daily_ad_error")));
  }
}));

// ══════════════════════════════════════════════════════════════
// CENTRAL DISPATCHER — every ad trigger point in the app (Earning tab,
// Spin wheel, Promo code redeem — home field & modal) calls this one
// function. Measuring start-to-finish time HERE, once, means the minimum
// watch time is enforced identically everywhere, for every network, with
// nothing to duplicate at each call site. Skipping/closing an ad before
// MIN_AD_WATCH_MS throws with err.adSkippedEarly = true so callers can
// show a distinct "watch the full ad" message instead of the generic
// "failed to load" one, and can be sure to skip crediting any reward.
// ══════════════════════════════════════════════════════════════
async function showAdByNetworkType(type) {
  const startedAt = Date.now();
  let result;

  if (type === "monetag") {
    result = await showMonetagAd();
  } else if (type === "adsgram_daily" || type === "adsgram" || type === "adsgram_special") {
    result = await showAdsgramAd(type);
  } else if (type === "usl_special") {
    result = await showUslSpecialAd();
  } else if (type === "adsgalaxy") {
    result = await showAdsGalaxyAd();
  } else if (type === "panda_daily") {
    result = await showPandaDailyAd();
  } else {
    throw new Error("Unknown ad network type: " + type);
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < MIN_AD_WATCH_MS) {
    const err = new Error(
      "Ad was skipped before " + (MIN_AD_WATCH_MS / 1000) + "s (" + elapsedMs + "ms) — no reward."
    );
    err.adSkippedEarly = true;
    throw err;
  }

  return result;
}

async function renderEarning(content, sub = "ads") {
  // Header/tab-switch render IMMEDIATELY (no fetch awaited first) so
  // switching between "Ads" and "Special Tasks" stays instant, same as
  // before "Today: +X RDC" was added. The today-total starts at "..." and
  // is filled in a moment later by the background fetch below — nothing
  // above this waits on it.
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Watch ads to earn</div>
    <div class="earning-header-row">
      <p class="earning-desc">Each network has its own daily limit — watch them all for maximum earnings.</p>
      <div class="earning-today">Today: <span class="earning-today-amount" data-raw="0">...</span></div>
    </div>
    <div class="tab-switch">
      <button class="${sub === "ads" ? "active" : ""}" id="adsTab">📺 Ads</button>
      <button class="${sub === "special" ? "active" : ""}" id="specialTab">🎁 Special Tasks</button>
    </div>
    <div id="earningBody"></div>
  `;
  $("#adsTab").addEventListener("click", () => renderEarning(content, "ads"));
  $("#specialTab").addEventListener("click", () => renderEarning(content, "special"));

  const body = $("#earningBody");

  // Single shared /api/earn call, fired in the background (not awaited
  // here) — used to fill in the header's "Today: +X RDC" for BOTH
  // sub-tabs, and also reused by the "ads" branch below for the actual
  // slot list so it's never fetched twice. Failures here are non-fatal —
  // the header just keeps showing "..." if this fails.
  const earnStatusPromise = api(`/api/earn`).catch(() => null);
  earnStatusPromise.then((status) => {
    const todayEarned = status && typeof status._todayEarned === "number" ? status._todayEarned : 0;
    const todayEl = content.querySelector(".earning-today-amount");
    if (todayEl) {
      todayEl.dataset.raw = todayEarned;
      todayEl.textContent = `+${todayEarned} RDC`;
    }
  });

  if (sub === "special") {
    return renderRegularTasks(body);
  }

  body.innerHTML = `<div class="tab-loading"><div class="tab-loading-ring"></div></div>`;

  Object.values(cooldownTimers).forEach((t) => clearInterval(t));

  // Fixed slot positions — reward/limit/cooldown are tied to the slot id
  // (see AD_NETWORKS in api/earn.js) and stay put no matter which network
  // type an admin assigns to the slot. The displayed name/icon and which
  // SDK actually plays are resolved below from status._config, which the
  // admin panel's "Set Ads" section controls.
  const SLOT_IDS = ["adsgram_daily", "adsgram_special", "monetag", "usl_special"];

  const status = await earnStatusPromise;
  if (!status) {
    body.innerHTML = `<div class="empty-state">Failed to load ads. Pull to refresh.</div>`;
    return;
  }
  const earningConfig = status._config || {};

  const slots = SLOT_IDS
    .map((slotId) => {
      const cfg = earningConfig[slotId] || { network: slotId === "monetag" ? "monetag" : slotId, hidden: false };
      const display = NETWORK_TYPE_DISPLAY[cfg.network] || { name: slotId, icon: "📺" };
      return { slotId, network: cfg.network, hidden: cfg.hidden, name: display.name, icon: display.icon };
    })
    .filter((s) => !s.hidden);

  body.innerHTML = slots.map((n) => {
    const st = status[n.slotId] || { watchedToday: 0, limit: 0, reward: 0, cooldownSecondsLeft: 0, limitReached: false };
    return `
    <div class="ad-card">
      <div class="ad-icon">${n.icon}</div>
      <div class="ad-info">
        <span class="name">${esc(n.name)}</span><span class="reward">+${esc(st.reward)} RDC</span>
        <div class="ad-progress"><div class="ad-progress-fill" style="width:${(st.watchedToday / st.limit) * 100}%" id="prog-${n.slotId}"></div></div>
        <div class="count" id="count-${n.slotId}">${esc(st.watchedToday)}/${esc(st.limit)} today</div>
      </div>
      <button class="watch-btn" data-key="${n.slotId}" data-network="${n.network}">▶ Watch</button>
    </div>
  `;
  }).join("");

  slots.forEach((n) => {
    const st = status[n.slotId];
    const btn = body.querySelector(`.watch-btn[data-key="${n.slotId}"]`);
    if (st.limitReached) {
      showLimitReached(btn, st.resetInSeconds);
    } else if (st.cooldownSecondsLeft > 0) {
      // Existing cooldown from before this render (e.g. page reload) —
      // no popup here, only announce it right after a fresh watch below.
      startCooldown(btn, n.slotId, st.cooldownSecondsLeft);
    }
  });

  body.querySelectorAll(".watch-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const netType = btn.dataset.network;

      if (!acquireAdLock(key)) {
        safeAlert("Another ad is already playing — please wait for it to finish, then try this one.");
        return;
      }

      btn.disabled = true;
      btn.textContent = "Loading...";
      showAdLoadingOverlay();

      let adResult;
      try {
        adResult = await showAdByNetworkType(netType);
      } catch (e) {
        console.error("Ad SDK error:", e);
        hideAdLoadingOverlay();
        releaseAdLock();
        btn.disabled = false;
        btn.textContent = "▶ Watch";
        if (e && e.adSkippedEarly) {
          safeAlert(`Please watch at least ${MIN_AD_WATCH_MS / 1000} seconds of the ad to earn your reward.`);
        } else {
          safeAlert("Ad failed to load or was skipped. Try again.");
        }
        return;
      }

      releaseAdLock();

      // AdsGalaxy is credited the same way as every other network: the
      // client posts to /api/earn right after the ad resolves, using the
      // slot id (key) exactly like Monetag/Adsgram/USL do — no separate
      // dashboard callback URL/secret is involved. The one AdsGalaxy-only
      // addition is request_id: per their integration docs it must be
      // forwarded to the backend rather than crediting on the client's
      // say-so, so it's tacked onto the same POST body when this slot's
      // network is "adsgalaxy" (harmless no-op for every other network,
      // which just ignores the extra field server-side).
      const postBody = { network: key };
      if (netType === "adsgalaxy" && adResult && adResult.request_id) {
        postBody.request_id = adResult.request_id;
      }
      const result = await api("/api/earn", { method: "POST", body: postBody });
      hideAdLoadingOverlay();

      if (result.success) {
        $(`#count-${key}`).textContent = `${result.watchedToday}/${result.limit} today`;
        $(`#prog-${key}`).style.width = `${(result.watchedToday / result.limit) * 100}%`;

        // Live-update the "Today: +X RDC" header total by the exact reward
        // just credited, instead of re-fetching /api/earn — same number
        // the server just $inc'd onto this log's stored reward.
        const todayEl = document.querySelector(".earning-today-amount");
        if (todayEl) {
          const updated = (parseFloat(todayEl.dataset.raw) || 0) + (result.reward || 0);
          todayEl.dataset.raw = updated;
          todayEl.textContent = `+${updated} RDC`;
        }

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

// announce: previously showed a popup telling the user to wait before
// watching this network again right after a fresh ad watch — that popup
// has been removed, so `announce` is now a no-op flag kept only so call
// sites don't need to change.
function startCooldown(btn, key, seconds, announce = false) {
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
      <div class="special-task-body">
        <div class="special-icon">📢</div>
        <div class="special-task-main">
          <span class="special-badge ${t.verificationType === "verified" ? "verified" : "link"}">${
        t.verificationType === "verified" ? "✓ Verified" : "🔗 Link"
      }</span>
          <div class="special-title">${esc(t.title)}</div>
          <button class="special-start-btn" data-id="${esc(t.id)}" ${t.completed ? "disabled" : ""}>${
        t.completed ? "✓ Done" : "▶ Start"
      }</button>
        </div>
        <div class="special-reward-box">
          <div class="amount">+${esc(t.reward)}</div>
          <div class="unit">RDC</div>
        </div>
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

    // Normal task: open the link, then auto-claim after a short wait.
    // Also fire a background view-log call so the server can verify this
    // wait actually happened (see api/task.js viewSpecialTask) — this is
    // non-blocking and never delays or changes what the user sees.
    openSpecialTaskLink(task.link);
    api("/api/task", { method: "POST", body: { action: "viewSpecialTask", taskId: task.id } }).catch(() => {});
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

// ---------- ADMIN GIFT CLAIM POPUP ----------
// Shown once per app load (see checkPendingGift(), called from enterApp())
// whenever userState.pendingGift is present — an admin queued a gift via
// the "🎁 Gift" panel (api/admin/users.js action:"send_gift") that hasn't
// been claimed yet. Two-step flow, matching the reference design exactly:
// step 1 is the "Congratulations! ... Claim Gift" card, step 2 (after
// tapping Claim) is the "+N RDC / Gift claimed successfully!" result —
// tapping "Awesome!" closes the popup and drops the user back on whatever
// screen is under it (Home, same as before the popup appeared).
let giftModalShown = false;

async function checkPendingGift() {
  if (giftModalShown) return; // already showing/handled this session
  if (!userState || !userState.pendingGift) return;
  giftModalShown = true;
  showGiftClaimCard(userState.pendingGift);
}

function getGiftOverlay() {
  let overlay = $("#giftOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "giftOverlay";
    overlay.className = "gift-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

function showGiftClaimCard(gift) {
  const overlay = getGiftOverlay();
  overlay.innerHTML = `
    <div class="gift-box">
      <div class="gift-ray-burst"></div>
      <div class="gift-icon">🎁</div>
      <div class="gift-title">🎉 Congratulations!</div>
      <div class="gift-sub">You have received a gift from admin</div>
      <div class="gift-reason-box">
        <div class="gift-reason-label">REASON</div>
        <div class="gift-reason-text">${esc(gift.reason)}</div>
      </div>
      <button class="gift-claim-btn" id="giftClaimBtn">🎁 Claim Gift</button>
    </div>
  `;
  overlay.classList.add("show");

  $("#giftClaimBtn").addEventListener("click", async () => {
    const btn = $("#giftClaimBtn");
    btn.disabled = true;
    btn.textContent = "Claiming...";
    try {
      const result = await api("/api/user", { method: "POST", body: { action: "claim_gift" } });
      if (result.error) {
        safeAlert(result.error);
        btn.disabled = false;
        btn.textContent = "🎁 Claim Gift";
        return;
      }
      await refreshUser();
      showGiftClaimedCard(result.amount);
    } catch (e) {
      console.error("Gift claim failed:", e);
      safeAlert("Something went wrong claiming your gift. Please try again.");
      btn.disabled = false;
      btn.textContent = "🎁 Claim Gift";
    }
  });
}

function showGiftClaimedCard(amount) {
  const overlay = getGiftOverlay();
  overlay.innerHTML = `
    <div class="gift-box">
      <div class="gift-icon">🎉</div>
      <div class="gift-claimed-amount">+${esc(amount)} RDC</div>
      <div class="gift-sub">Gift claimed successfully!</div>
      <button class="gift-awesome-btn" id="giftAwesomeBtn">Awesome!</button>
    </div>
  `;

  $("#giftAwesomeBtn").addEventListener("click", () => {
    overlay.classList.remove("show");
    // Land back on Home, same as tapping the Home nav item.
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    const homeBtn = document.querySelector('.nav-item[data-tab="home"]');
    if (homeBtn) homeBtn.classList.add("active");
    renderTab("home");
  });
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
     <div class="title" style="font-size:15.5px;font-weight:600;line-height:1.45;margin-bottom:8px;letter-spacing:normal;">
        <div>${esc(stripFancyUnicode(t.title))}</div>
        ${
          t.link
            ? `<a href="#" class="task-title-link" data-link="${esc(t.link)}" style="display:block;color:#3b82f6;text-decoration:none;font-size:13px;font-weight:500;line-height:1.5;margin-top:6px;word-break:break-all;">
                🔗 ${esc(t.link)}
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
// The page shell/label ("Task" nav item, "📋 Tasks" / "📢 Post Task"
// sub-tabs) is unchanged apart from the second sub-tab's label/content —
// what it renders under "📋 Tasks" is still the channel-join (special
// task) cards, see renderSpecialTasks below. Nothing was deleted, only
// the old empty "Faucet" placeholder was replaced with a real "Post Task"
// support-contact card.
async function renderTask(content, sub = "tasks") {
  content.innerHTML = `
    <div class="section-label"><span class="dot"></span>Complete tasks, earn RDC</div>
    <div class="tab-switch">
      <button class="${sub === "tasks" ? "active" : ""}" id="tasksTab">📋 Tasks</button>
      <button class="${sub === "faucet" ? "active" : ""}" id="faucetTab">📢 Post Task</button>
    </div>
    <div id="taskBody"></div>
  `;
  $("#tasksTab").addEventListener("click", () => renderTask(content, "tasks"));
  $("#faucetTab").addEventListener("click", () => renderTask(content, "faucet"));

  const body = $("#taskBody");
  if (sub === "faucet") {
    body.innerHTML = `
      <div class="card post-task-card">
        <div class="post-task-icon">📢</div>
        <div class="post-task-title">Want to promote your channel or bot?</div>
        <div class="post-task-desc">
          Contact support to get your channel or bot listed as a task here.
          Tap the button below to message us directly.
        </div>
        <button class="btn-primary post-task-support-btn" id="postTaskSupportBtn">💬 Contact Support</button>
      </div>
    `;
    $("#postTaskSupportBtn").addEventListener("click", () =>
      openSpecialTaskLink("https://t.me/mahibro0098")
    );
    return;
  }

  return renderSpecialTasks(body);
}

// ---------- REFER ----------
async function renderRefer(content) {
  const ref = await api("/api/referral");
  const commissionUsd = ((ref.withdrawalCommissionEarnings || 0) * RDC_RATE).toFixed(4);
  content.innerHTML = `
    <div class="refer-hero">
      <div class="icon">👥</div>
      <h3>Refer friends, earn RDC</h3>
      <p>Each friend who completes all 3 steps earns you up to 220 RDC total.</p>
      <div class="refer-commission-badge">💰 +10% of everything they withdraw, forever</div>
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
    <div class="commission-box">
      <div class="commission-left">
        <div class="commission-title">💰 Withdrawal commission</div>
        <div class="commission-desc">10% of every withdrawal your referrals make — for as long as they keep withdrawing.</div>
      </div>
      <div class="commission-right">
        <div class="commission-value">${esc(ref.withdrawalCommissionEarnings || 0)}</div>
        <div class="commission-usd">≈ $${esc(commissionUsd)} USD</div>
      </div>
    </div>
    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>How rewards work</div>
    <div class="reward-step"><div class="step-num">1</div><div class="txt">Friend joins channel + community and verifies</div><div class="plus">+30</div></div>
    <div class="reward-step"><div class="step-num">2</div><div class="txt">Friend completes 10 tasks</div><div class="plus">+90</div></div>
    <div class="reward-step"><div class="step-num">3</div><div class="txt">Friend watches 25 ads</div><div class="plus">+180</div></div>
    <div class="reward-step"><div class="step-num">💰</div><div class="txt">Every time they withdraw, after that</div><div class="plus">+10%</div></div>
    <div class="refer-valid-box">
      <div class="refer-valid-title">✅ When does a referral become "valid"?</div>
      <p>A referral counts toward your withdrawals once your friend has completed <strong>both</strong> — 10 tasks <strong>and</strong> 25 ads (doesn't matter which order). Joining the channel alone, or just one of the two, isn't enough yet.</p>
    </div>
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
  if (usdtEl) usdtEl.textContent = formatUsdt(status.usdtBalance);

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
    await showAdByNetworkType(network);
  } catch (e) {
    console.error("Spin ad error:", e);
    hideAdLoadingOverlay();
    releaseAdLock();
    spinInProgress = false;
    btn.disabled = false;
    btn.textContent = "🎰 SPIN NOW";
    if (e && e.adSkippedEarly) {
      safeAlert(`Please watch at least ${MIN_AD_WATCH_MS / 1000} seconds of the ad to earn your spin.`);
    } else {
      safeAlert("Ad failed to load or was skipped. Try again.");
    }
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
  // Fixed minimum per admin request — matches api/withdraw.js's tonkeeper.min
  tonkeeper: { min: 0.03, label: "Tonkeeper Address", placeholder: "Enter your Tonkeeper wallet address" },
};

// Renders just the 3 status lines' innerHTML (called once eligibility data
// arrives, and again after any Submit attempt so a rejected withdraw's
// updated counts show immediately without closing the modal).
function renderWithdrawStatusLines(elig) {
  const tasksDone = elig.tasksMet;
  const adsDone = elig.adsMet;
  const referralLine = elig.firstWithdrawalUsed
    ? `<div class="wd-status-line ${elig.referralEligible ? "met" : ""}">
         <span>${elig.referralEligible ? "✅" : "⏳"}</span> 🔑 Key Coin available (${esc(elig.validReferralsAvailable)} available)
       </div>`
    : `<div class="wd-status-line met"><span>✅</span> First withdrawal — free, no Key Coin needed</div>`;

  return `
    <div class="wd-status-line ${tasksDone ? "met" : ""}">
      <span>${tasksDone ? "✅" : "⏳"}</span> Complete ${esc(elig.tasksRequired)} tasks today (${esc(elig.tasksToday)}/${esc(elig.tasksRequired)})
    </div>
    <div class="wd-status-line ${adsDone ? "met" : ""}">
      <span>${adsDone ? "✅" : "⏳"}</span> Watch ${esc(elig.adsRequired)} ads today (${esc(elig.adsToday)}/${esc(elig.adsRequired)})
    </div>
    ${referralLine}
  `;
}

function openWithdrawModal(method = "binance") {
  const overlay = $("#withdrawModal");
  const m = METHODS[method];
  const usdtBalance = formatUsdt(userState.usdtBalance);
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">Withdraw USDT <button class="modal-close" id="closeWithdraw">✕</button></div>
      <p style="color:var(--text-dim);font-size:13px;">USDT Balance: $${esc(usdtBalance)}</p>
      <div class="field-label">Select gateway</div>
      <div class="method-tabs">
        <div class="method-tab ${method === "binance" ? "active" : ""}" data-m="binance">Binance</div>
        <div class="method-tab ${method === "tonkeeper" ? "active" : ""}" data-m="tonkeeper">Tonkeeper</div>
      </div>
      <div class="field-label">${m.label}</div>
      <input class="field-input" id="wAddress" placeholder="${m.placeholder}" />
      <div class="field-label">Amount (USDT) — minimum $${m.min}</div>
      <div class="amount-max-row">
        <input class="field-input" id="wAmount" type="number" placeholder="${m.min}" />
        <button class="max-btn" id="wMaxBtn">MAX</button>
      </div>
      <div class="withdraw-status-box" id="withdrawStatusBox">
        <div class="tab-loading"><div class="tab-loading-ring"></div></div>
      </div>
      <div class="hint-box">No withdraw fee — you receive the full amount in USDT (the 25% fee is already taken when you convert RDC to USDT). You must complete at least 5 tasks (lifetime) and watch at least 10 ads today to withdraw. Requests are reviewed manually within 24 hours.</div>
      <button class="btn-primary" style="width:100%;" id="submitWithdraw">Submit Withdraw</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeWithdraw").addEventListener("click", () => overlay.classList.remove("show"));
  overlay.querySelectorAll(".method-tab").forEach((tab) => {
    tab.addEventListener("click", () => openWithdrawModal(tab.dataset.m));
  });

  $("#wMaxBtn").addEventListener("click", () => {
    $("#wAmount").value = formatUsdt(userState.usdtBalance);
  });

  // Fetch live eligibility (today's tasks/ads + referral allowance) and
  // fill in the 3 status lines. Submit stays clickable either way — the
  // server re-checks everything anyway, so a stale/slow fetch here never
  // blocks a request that would otherwise succeed.
  const statusBox = $("#withdrawStatusBox");
  api("/api/withdraw?eligibility=1").then((elig) => {
    if (elig && !elig.error) {
      statusBox.innerHTML = renderWithdrawStatusLines(elig);
    } else {
      statusBox.innerHTML = `<div class="wd-status-line">Could not load eligibility status.</div>`;
    }
  });

  $("#submitWithdraw").addEventListener("click", async () => {
    const address = $("#wAddress").value.trim();
    const amount = Number($("#wAmount").value);
    if (!address || !amount) return safeAlert("Please fill all fields");
    const submitBtn = $("#submitWithdraw");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
    const result = await api("/api/withdraw", { method: "POST", body: { method, address, amount } });
    if (result.success) {
      safeAlert("Withdraw request submitted!");
      overlay.classList.remove("show");
      renderHome($("#mainContent"));
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Withdraw";
      safeAlert(result.error || "Error");
      // Refresh the status lines too — the rejection was likely one of the
      // 3 conditions shown above, so the user should see updated counts.
      api("/api/withdraw?eligibility=1").then((elig) => {
        if (elig && !elig.error) statusBox.innerHTML = renderWithdrawStatusLines(elig);
      });
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
      <div class="profile-row"><span>Total balance</span><span>${esc(formatRdcCompact(userState.balance))} RDC</span></div>
      <div class="profile-row"><span>Lifetime earned</span><span>${esc(userState.lifetimeEarned)} RDC</span></div>
      <div class="profile-row"><span>Referrals</span><span>${esc(userState.referralsCount)}</span></div>
      <div class="profile-row"><span>Tasks completed</span><span>${esc(userState.tasksCompleted)}</span></div>
      <button class="btn-secondary" style="width:100%;margin-top:16px;" id="closeProfile">Close</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeProfile").addEventListener("click", () => overlay.classList.remove("show"));
}

// ---------- LEADERBOARD MODAL (podium-style Top 20 Referrers) ----------
async function openLeaderboardModal() {
  const overlay = $("#promoModal");
  if (!overlay) {
    console.error("Missing #promoModal overlay in index.html");
    return;
  }

  overlay.innerHTML = `
    <div class="modal-sheet lb-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <span>🏆 Top 20 Referrers</span>
        <button class="modal-close" id="closeLeaderboard">✕</button>
      </div>
      <p class="lb-subtitle">Ranked by lifetime referrals.</p>
      <div id="lbBody" class="tab-loading"><div class="tab-loading-ring"></div></div>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeLeaderboard").addEventListener("click", () => overlay.classList.remove("show"));

 const top = await api("/api/referral?top=1");
  const body = $("#lbBody");
  // The initial shell carries class="tab-loading" (display:flex, centered) for
  // the spinner. That class MUST be removed once real content goes in —
  // otherwise .lb-podium and .lb-list become flex children of a row-direction
  // flex container and sit side-by-side instead of stacked (podium on top,
  // list below).
  body.classList.remove("tab-loading");

  if (!Array.isArray(top) || !top.length) {
    body.innerHTML = `<div class="empty-state">No referrers yet.</div>`;
    return;
  }

  const initial = (r) => esc((r.name || "?")[0].toUpperCase());
  const [first, second, third] = [top[0], top[1], top[2]];
  const rest = top.slice(3);

  body.innerHTML = `
    <div class="lb-podium">
      ${
        second
          ? `<div class="lb-podium-item lb-rank-2">
              <div class="lb-avatar-ring silver"><div class="lb-avatar">${initial(second)}</div></div>
              <div class="lb-medal">🥈</div>
              <div class="lb-p-name">${esc(second.name)}</div>
              <div class="lb-p-refs">${esc(second.refs)} refs</div>
            </div>`
          : `<div class="lb-podium-item lb-rank-2"></div>`
      }
      ${
        first
          ? `<div class="lb-podium-item lb-rank-1">
              <div class="lb-avatar-ring gold"><div class="lb-avatar">${initial(first)}</div></div>
              <div class="lb-medal">🥇</div>
              <div class="lb-p-name">${esc(first.name)}</div>
              <div class="lb-p-refs">${esc(first.refs)} refs</div>
            </div>`
          : `<div class="lb-podium-item lb-rank-1"></div>`
      }
      ${
        third
          ? `<div class="lb-podium-item lb-rank-3">
              <div class="lb-avatar-ring bronze"><div class="lb-avatar">${initial(third)}</div></div>
              <div class="lb-medal">🥉</div>
              <div class="lb-p-name">${esc(third.name)}</div>
              <div class="lb-p-refs">${esc(third.refs)} refs</div>
            </div>`
          : `<div class="lb-podium-item lb-rank-3"></div>`
      }
    </div>
    <div class="lb-list">
      ${rest
        .map(
          (r) => `<div class="lb-row"><span class="lb-rank">${esc(r.rank)}</span>
          <div class="avatar-circle">${initial(r)}</div>
          <span class="lb-row-name">${esc(r.name)}</span><span class="lb-row-refs">${esc(r.refs)} refs</span></div>`
        )
        .join("")}
    </div>
  `;
}

// ---------- WEEKLY CONTEST MODAL ----------
async function openWeeklyContestModal() {
  const overlay = $("#promoModal");
  if (!overlay) {
    console.error("Missing #promoModal overlay in index.html");
    return;
  }

  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <span>🎯 Weekly Referral Contest</span>
        <button class="modal-close" id="closeWeeklyContest">✕</button>
      </div>
      <div id="wcBody" class="tab-loading"><div class="tab-loading-ring"></div></div>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeWeeklyContest").addEventListener("click", () => overlay.classList.remove("show"));

  const [ref, top] = await Promise.all([api("/api/referral"), api("/api/referral?weekly=1")]);
  const body = $("#wcBody");
  // same fix as the leaderboard modal — remove the flex-centering
  // "tab-loading" class once real content goes in, or the sections
  // below stack side-by-side instead of top-to-bottom.
  body.classList.remove("tab-loading");

  const weeklyReferrals = ref.weeklyReferrals || 0;
  const weeklyThreshold = ref.weeklyThreshold || 10;
  const weeklyQualified = !!ref.weeklyQualified;
  const pct = Math.min(100, Math.round((weeklyReferrals / weeklyThreshold) * 100));
  const remaining = Math.max(0, weeklyThreshold - weeklyReferrals);
  const topList = Array.isArray(top) ? top : [];

  const initial = (name) => esc((String(name || "?").replace("@", "")[0] || "?").toUpperCase());

  body.innerHTML = `
    <p class="wc-desc">Refer ${esc(weeklyThreshold)}+ new people THIS WEEK to qualify. Top 10 qualifying referrers win a reward. Resets when the admin ends the week.</p>
    <div class="wc-progress-box">
      <div class="wc-progress-top">
        <span>Your referrals this week</span>
        <span class="wc-progress-count">${esc(weeklyReferrals)}<span class="wc-progress-total">/${esc(weeklyThreshold)}</span></span>
      </div>
      <div class="wc-progress-track"><div class="wc-progress-fill" style="width:${pct}%"></div></div>
      ${
        weeklyQualified
          ? `<div class="wc-qualify-banner">✅ You currently qualify for this week's reward!</div>`
          : `<div class="wc-qualify-banner not-qualified">Refer ${esc(remaining)} more to qualify</div>`
      }
    </div>
    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>THIS WEEK'S TOP REFERRERS</div>
    ${
      topList.length === 0
        ? `<div class="empty-state">No referrals yet this week.</div>`
        : `<div class="wc-list">
            ${topList
              .map(
                (r, i) => `
              <div class="wc-row">
                ${i < 5 ? `<span class="wc-trophy">🏆</span>` : `<span class="wc-rank-num">${i + 1}</span>`}
                <div class="avatar-circle">${initial(r.username)}</div>
                <span class="wc-row-name">${esc(r.username)}</span>
                <span class="wc-row-refs">${esc(r.refs)} refs</span>
              </div>`
              )
              .join("")}
          </div>`
    }
  `;
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

    if (!acquireAdLock("promo_ad")) {
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
      if (e && e.adSkippedEarly) {
        safeAlert(`Please watch at least ${MIN_AD_WATCH_MS / 1000} seconds of the ad to redeem your code.`);
      } else {
        safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
      }
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
// ---------- 🔑 KEY STORE ----------
// Prices/quantities MUST match KEY_PACKAGES / KEY_PRICE_TON in api/user.js —
// this list is display-only, the server always re-computes the real price
// (and adds a small unique nanoton offset per order — see addUniqueOffset
// in api/user.js — so what's shown here is only an approximate preview).
const KEY_PACKAGE_LIST = [
  { id: "pack_1", quantity: 1 },
  { id: "pack_2", quantity: 2 },
  { id: "pack_5", quantity: 5 },
  { id: "pack_10", quantity: 10 },
];
const KEY_PRICE_TON = 0.015;

// ---------- TonConnect (optional "Connect Wallet") ----------
// Purely a UX upgrade over the ton:// deep link: once connected, "Purchase"
// sends the transfer directly through the user's already-connected wallet
// instead of trying to open a separate wallet app. It does NOT change how
// payment is confirmed — that's still the same TonAPI webhook
// (handleTonWebhook in api/user.js) watching TON_DEPOSIT_ADDRESS on-chain,
// regardless of which method the buyer used to send the TON. If the SDK
// script fails to load (blocked network, offline) or the user never
// connects a wallet, the deep-link flow below still works exactly as
// before — connecting a wallet is optional, never required to buy.
let tonConnectUI = null;
if (window.TON_CONNECT_UI) {
  try {
    tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl: "https://redtube-nine.vercel.app/tonconnect-manifest.json",
      buttonRootId: null, // we render our own connect button below instead of the SDK's default one
    });
  } catch (e) {
    console.error("TonConnect init failed:", e);
  }
}

function openKeyStoreModal() {
  const overlay = $("#keyStoreModal");
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">🔑 Key Store <button class="modal-close" id="closeKeyStore">✕</button></div>
      <div class="key-store-wallet-row">
        <span id="walletStatusText">Wallet not connected</span>
        <button class="key-store-connect-btn" id="connectWalletBtn">Connect Wallet</button>
      </div>
      <div class="key-store-howto">
        <div class="key-store-howto-title">How to get free Key's</div>
        <div class="key-store-howto-sub">1 valid referral = 1 free 🔑 Key Coin.</div>
      </div>
      <div class="key-store-grid">
        ${KEY_PACKAGE_LIST.map((p) => `
          <div class="key-pack-card" data-pack="${p.id}">
            <div class="key-pack-icon">🔑</div>
            <div class="key-pack-qty">${p.quantity} Key${p.quantity > 1 ? "s" : ""}</div>
            <button class="key-pack-buy-btn" data-pack="${p.id}">Buy</button>
          </div>
        `).join("")}
      </div>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeKeyStore").addEventListener("click", () => overlay.classList.remove("show"));
  overlay.querySelectorAll(".key-pack-buy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pkg = KEY_PACKAGE_LIST.find((p) => p.id === btn.dataset.pack);
      if (pkg) openKeyBuyModal(pkg);
    });
  });

  const walletBtn = $("#connectWalletBtn");
  const walletText = $("#walletStatusText");
  function refreshWalletUi() {
    const wallet = tonConnectUI && tonConnectUI.wallet;
    if (wallet) {
      const addr = wallet.account.address;
      walletText.textContent = `Connected: ${addr.slice(0, 4)}...${addr.slice(-4)}`;
      walletBtn.textContent = "Disconnect";
    } else {
      walletText.textContent = "Wallet not connected";
      walletBtn.textContent = "Connect Wallet";
    }
  }
  if (tonConnectUI) {
    refreshWalletUi();
    tonConnectUI.onStatusChange(() => refreshWalletUi());
    walletBtn.addEventListener("click", () => {
      if (tonConnectUI.wallet) {
        tonConnectUI.disconnect();
      } else {
        tonConnectUI.openModal();
      }
    });
  } else {
    walletText.textContent = "Wallet connect unavailable — you can still pay via wallet app";
    walletBtn.style.display = "none";
  }
}

function openKeyBuyModal(pkg) {
  const overlay = $("#keyBuyModal");
  const totalTon = Math.round(pkg.quantity * KEY_PRICE_TON * 1e6) / 1e6;
  overlay.innerHTML = `
    <div class="modal-sheet key-buy-sheet">
      <button class="modal-close key-buy-close" id="closeKeyBuy">✕</button>
      <div class="key-buy-icon">🔑</div>
      <div class="key-buy-title">Key Coin</div>
      <div class="key-buy-rows">
        <div class="key-buy-row"><span>Quantity</span><span>${pkg.quantity} Key${pkg.quantity > 1 ? "s" : ""}</span></div>
        <div class="key-buy-row"><span>Value</span><span>~${esc(totalTon)} TON</span></div>
      </div>
      <button class="btn-primary key-buy-purchase-btn" id="purchaseKeyBtn">Purchase</button>
    </div>
  `;
  overlay.classList.add("show");
  $("#closeKeyBuy").addEventListener("click", () => overlay.classList.remove("show"));
  $("#purchaseKeyBtn").addEventListener("click", async () => {
    const btn = $("#purchaseKeyBtn");
    btn.disabled = true;
    btn.textContent = "Processing...";
    // These get set once wallet-connect is pending, so the outer finally{}
    // below knows NOT to reset the button yet (it's still waiting on the
    // user picking a wallet in the TonConnect modal).
    let waitingOnConnect = false;

    // Sends the already-created order's exact amount to the already-
    // connected wallet. Called either immediately (wallet was already
    // connected) or automatically the instant a wallet connects (see the
    // one-tap flow below) — the user never has to press "Purchase" twice.
    async function sendToConnectedWallet(order) {
      btn.textContent = "Confirm in your wallet...";
      try {
        await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{ address: order.address, amount: String(order.amountNano) }],
        });
        showWaitingForPayment(overlay, order);
      } catch (e) {
        // User rejected in their wallet, or wallet-side error — let them
        // retry, don't treat as a crash. The order stays "pending" server-
        // side and can simply be re-attempted (a fresh Buy tap makes a new
        // order; this one just never gets paid).
        console.error("sendTransaction failed/rejected:", e);
        safeAlert("Payment wasn't sent from your wallet — you can try again.");
      } finally {
        btn.disabled = false;
        btn.textContent = "Purchase";
      }
    }

    try {
      const order = await api("/api/user", { method: "POST", body: { action: "buy_key", packageId: pkg.id } });
      if (!(order && order.success)) {
        safeAlert((order && order.error) || "Could not start payment. Please try again.");
        return;
      }

      if (!tonConnectUI) {
        // TonConnect SDK never loaded (blocked network, offline, etc.) —
        // only the deep-link route is possible.
        openDeepLinkFallback(order);
        showWaitingForPayment(overlay, order);
        return;
      }

      if (tonConnectUI.wallet) {
        // Already connected from a previous session — straight to sending.
        waitingOnConnect = true; // sendToConnectedWallet's own finally{} resets the button
        await sendToConnectedWallet(order);
        return;
      }

      // ---------- ONE-TAP CONNECT-THEN-PAY ----------
      // Not connected yet: open TonConnect's own wallet picker (the QR +
      // "Tonkeeper / Wallet in Telegram / Gram Wallet" screen). The instant
      // ANY wallet connects, we automatically fire sendTransaction with
      // this exact order's address+amount — no second tap needed. If the
      // user closes the picker without connecting, the button just resets
      // so they can try again.
      waitingOnConnect = true;
      btn.textContent = "Choose your wallet...";
      let settled = false;
      const unsubStatus = tonConnectUI.onStatusChange(async (wallet) => {
        if (wallet && !settled) {
          settled = true;
          unsubStatus();
          if (unsubModal) unsubModal();
          await sendToConnectedWallet(order);
        }
      });
      const unsubModal = tonConnectUI.onModalStateChange((state) => {
        if (state.status === "closed" && !settled && !tonConnectUI.wallet) {
          settled = true;
          unsubStatus();
          unsubModal();
          btn.disabled = false;
          btn.textContent = "Purchase";
        }
      });
      tonConnectUI.openModal();
    } catch (e) {
      console.error("buy_key error:", e);
      safeAlert("Could not start payment. Please try again.");
      btn.disabled = false;
      btn.textContent = "Purchase";
    } finally {
      // Only reset here if we're NOT mid-connect/mid-send — those paths
      // reset the button themselves once they actually finish, which may
      // be many seconds later (waiting on the user to pick a wallet/
      // confirm), so resetting unconditionally here would re-enable
      // "Purchase" while a connect/send is still genuinely in flight.
      if (!waitingOnConnect) {
        btn.disabled = false;
        btn.textContent = "Purchase";
      }
    }
  });

  function openDeepLinkFallback(order) {
    const openUrl = order.tonkeeperLink || order.tonDeepLink;
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) {
      window.Telegram.WebApp.openLink(openUrl);
    } else {
      window.open(openUrl, "_blank");
    }
  }
}

// Swaps the buy modal into a "waiting for payment" view showing the exact
// address/amount as a manual fallback (copy-to-clipboard), regardless of
// which path (TonConnect or deep link) was used to attempt the send. Key
// Coins land automatically via the TonAPI webhook once the on-chain
// transfer is actually seen. While this screen is open we also lightly
// poll /api/user (action: check_order) purely to know WHEN to flip this
// same screen to "Successfully" — the webhook is still the only thing
// that ever actually credits the balance; polling here never touches it.
function showWaitingForPayment(overlay, result) {
  overlay.querySelector(".key-buy-sheet").innerHTML = `
    <button class="modal-close key-buy-close" id="closeKeyBuy2">✕</button>
    <div class="key-buy-icon">🔑</div>
    <div class="key-buy-title">Waiting for payment</div>
    <div class="key-buy-rows">
      <div class="key-buy-row"><span>Send exactly</span><span>${esc(result.priceTon)} TON</span></div>
      <div class="key-buy-row"><span>To address</span><span class="key-buy-copyval" id="copyAddr">${esc(result.address)}</span></div>
    </div>
    <div class="key-buy-note">${esc(result.quantity)} 🔑 Key Coin(s) will be added automatically once the payment is confirmed on-chain (usually within a minute) — no need to keep this open. If you have already paid, please wait 10-15 minutes — your Key Coin(s) will be added successfully.</div>
  `;

  // Stop any previous order's poll loop still running from an earlier
  // "Buy" attempt on this same overlay before starting a new one.
  if (overlay._keyPollTimer) {
    clearInterval(overlay._keyPollTimer);
    overlay._keyPollTimer = null;
  }

  $("#closeKeyBuy2").addEventListener("click", () => {
    overlay.classList.remove("show");
    if (overlay._keyPollTimer) {
      clearInterval(overlay._keyPollTimer);
      overlay._keyPollTimer = null;
    }
  });
  const el = $("#copyAddr");
  if (el) el.addEventListener("click", () => {
    navigator.clipboard && navigator.clipboard.writeText(el.textContent).catch(() => {});
    const original = el.textContent;
    el.textContent = "Copied!";
    setTimeout(() => { el.textContent = original; }, 1200);
  });

  // ---------- POLL FOR PAYMENT CONFIRMATION ----------
  // Nobody who never pays ever sees anything but "Waiting for payment" —
  // this loop simply never finds status "paid" for them, so the screen
  // just sits here for as long as the modal stays open, exactly as
  // before. Every 3s is gentle enough to leave running for a long time.
  let stopped = false;
  overlay._keyPollTimer = setInterval(async () => {
    if (stopped || !overlay.classList.contains("show")) return;
    try {
      const check = await api("/api/user", {
        method: "POST",
        body: { action: "check_order", orderId: result.orderId },
      });
      if (check && check.success && check.status === "paid") {
        stopped = true;
        clearInterval(overlay._keyPollTimer);
        overlay._keyPollTimer = null;
        showKeyPurchaseSuccess(overlay, check.quantity || result.quantity);
      }
    } catch (e) {
      // Transient network hiccup — just try again on the next tick.
      console.error("check_order poll failed:", e);
    }
  }, 3000);
}

// Flips the buy modal to a "Successfully" screen once check_order reports
// "paid", then reloads the whole app shortly after so every balance
// display (header, wallet, etc.) is guaranteed to reflect the new
// keyCoinBalance — not just this modal.
function showKeyPurchaseSuccess(overlay, quantity) {
  overlay.querySelector(".key-buy-sheet").innerHTML = `
    <div class="key-success-wrap">
      <div class="key-success-coin">
        <div class="key-success-coin-face key-success-coin-front">🔑</div>
        <div class="key-success-coin-face key-success-coin-back">🔑</div>
      </div>
      <div class="key-success-check">
        <svg viewBox="0 0 52 52"><circle class="key-success-check-circle" cx="26" cy="26" r="24"/><path class="key-success-check-mark" d="M14 27l7 7 17-17"/></svg>
      </div>
      <div class="key-success-title">Successfully!</div>
      <div class="key-success-sub">${esc(quantity)} 🔑 Key Coin${quantity > 1 ? "s" : ""} added to your wallet.</div>
      <div class="key-success-reload">Refreshing your balance…</div>
    </div>
  `;
  setTimeout(() => {
    window.location.reload();
  }, 2200);
}
// ---------- LOADING SCREEN SPARKS ----------
(function () {
  const sparksEl = document.getElementById("sparks");
  if (!sparksEl) return;
  function createSpark() {
    const spark = document.createElement("div");
    spark.className = "spark";
    spark.style.left = (20 + Math.random() * 60) + "%";
    const duration = 2.2 + Math.random() * 2.8;
    spark.style.animationDuration = duration + "s";
    spark.style.setProperty("--move", (-80 + Math.random() * 160) + "px");
    const size = 2 + Math.random() * 3;
    spark.style.width = size + "px";
    spark.style.height = (6 + Math.random() * 12) + "px";
    sparksEl.appendChild(spark);
    setTimeout(() => spark.remove(), duration * 1000);
  }
  const sparkInterval = setInterval(createSpark, 100);
  for (let i = 0; i < 18; i++) setTimeout(createSpark, i * 80);
  // Stop generating once the loading screen is gone (after login/join-check)
  const stopCheck = setInterval(() => {
    const screen = document.getElementById("loadingScreen");
    if (!screen || screen.style.display === "none") {
      clearInterval(sparkInterval);
      clearInterval(stopCheck);
    }
  }, 1000);
})();
runLoading();
