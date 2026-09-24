// public/app.js
const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) tg.ready(), tg.expand();

const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
const rawStartParam =
  (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) ||
  new URLSearchParams(window.location.search).get("tgWebAppStartParam") ||
  new URLSearchParams(window.location.hash.substring(1)).get("tgWebAppStartParam") ||
  null;
const startParam = typeof rawStartParam === "string" ? rawStartParam.trim() : null;
let promoCodeFromDeepLink = null;
if (typeof startParam === "string" && /^promo[_-]/i.test(startParam)) {
  promoCodeFromDeepLink = startParam.replace(/^promo[_-]/i, "").trim().toUpperCase();
}

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

// The exact string these 3 POST handlers send back when the cached
// action token is missing/expired/mismatched (see api/_actionSign.js's
// verifyActionToken + earn.js/task.js/withdraw.js). Matched verbatim below
// so we only auto-retry on THIS specific failure, never on real errors
// like "cooldown" or "limit".
const ACTION_TOKEN_ERROR = "Please refresh and try again.";

function actionTokenKeyFor(path) {
  const clean = path.split("?")[0];
  return Object.prototype.hasOwnProperty.call(actionTokens, clean) ? clean : null;
}

// BUGFIX (stale action token on long-lived tabs): the token cached above is
// only ever refreshed by a GET call — the claim POSTs themselves never
// rotate it. A user who opens the Earning tab (fetching the token once)
// and then takes a while working through the ad list — slow-loading SDKs,
// waiting out cooldowns, reading Special Tasks, etc. — can easily still be
// on that same token several minutes later. Once it ages past the server's
// TTL, the NEXT claim (often the last slot in the list, e.g. USL Special)
// gets rejected with ACTION_TOKEN_ERROR even though the ad played in full
// and nothing the user did was wrong. Rather than just raising the TTL
// (still a ticking clock, only a bigger one), api() now self-heals: on
// exactly that error, for exactly these 3 token-scoped endpoints, it
// silently fetches a fresh token via a GET on the same path and retries
// the original POST once before ever surfacing anything to the user. A
// genuine failure (still errors after a real fresh token) still surfaces
// normally.
async function api(path, opts = {}, _isRetry = false) {
  const headers = { "Content-Type": "application/json" };
  if (tg && tg.initData) {
    headers["X-Telegram-Init-Data"] = tg.initData;
  }
  const method = opts.method || "GET";
  const tokenKey = actionTokenKeyFor(path);
  let bodyToSend = opts.body;

  if (tokenKey && method === "POST" && actionTokens[tokenKey]) {
    headers["X-Action-Token"] = actionTokens[tokenKey];
    if (bodyToSend && typeof bodyToSend === "object" && !Array.isArray(bodyToSend)) {
      bodyToSend = { ...bodyToSend, actionToken: actionTokens[tokenKey] };
    }
  }

  const res = await fetch(path, {
    method,
    headers,
    body: bodyToSend ? JSON.stringify(bodyToSend) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (tokenKey) {
    const freshToken =
      res.headers.get("x-action-token") ||
      (data && data._actionToken) ||
      (data && data.actionToken);
    if (freshToken) actionTokens[tokenKey] = freshToken;
  }

  if (
    !_isRetry &&
    tokenKey &&
    method === "POST" &&
    data &&
    data.error === ACTION_TOKEN_ERROR
  ) {
    try {
      // For withdraw, eligibility=1 is the route that returns eligibility & signs the fresh action token
      const refreshPath = tokenKey === "/api/withdraw" ? "/api/withdraw?eligibility=1" : tokenKey;
      await api(refreshPath, { method: "GET" }, true); // refreshes actionTokens[tokenKey] as a side effect
    } catch (e) {
      // Refresh failed too (e.g. offline) — fall through and return original error
    }
    if (actionTokens[tokenKey]) {
      return api(path, opts, true);
    }
  }

  return data;
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
      body: { username: USERNAME, firstName: FIRSTNAME, refBy: (startParam && /^\d+$/.test(startParam)) ? Number(startParam) : null },
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
  await refreshUser();
  refreshPromoAdConfig(); // fire-and-forget — home renders immediately with the fallback id if this is still in flight

  $("#mainHeader").style.display = "flex";
  $("#mainContent").style.display = "block";

  // Deep-link routing: the "OPEN TASK" button on the "New task added"
  // broadcast (see api/user.js's task-post payment flow) opens this Mini
  // App with ?startapp=task, which Telegram exposes here as
  // start_param === "task" — a non-numeric sentinel, so it can never be
  // confused with a real referral id (Number("task") is NaN, which the
  // refBy lookup above already just treats as "no valid referrer").
  // Route straight to the Task tab in that case, same as tapping the
  // bottom-nav Task button.
  if (startParam === "task" && currentTab === "home") {
    await renderTab("task");
    $("#bottomNav").style.display = "flex";
    return;
  }

  // Deep-link routing: startapp=contest opens directly to Refer -> Contest tab
  if ((startParam === "contest" || startParam === "refer_contest") && currentTab === "home") {
    referCurrentSubtab = "contest";
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    const referBtn = document.querySelector('.nav-item[data-tab="refer"]');
    if (referBtn) referBtn.classList.add("active");
    await renderTab("refer");
    $("#bottomNav").style.display = "flex";
    checkPendingGift();
    return;
  }

  if (currentTab === "home") {
    await renderTab("home");
  }

  // Reveal bottom nav only once the app and initial tab are fully fulfilled
  $("#bottomNav").style.display = "flex";

  checkPendingGift();

  if (promoCodeFromDeepLink) {
    setTimeout(() => {
      openPromoModal(promoCodeFromDeepLink);
    }, 300);
  }
}

async function refreshUser() {
  userState = await api("/api/user");
}

// Pulls the admin-configurable ad NETWORK TYPE for the promo "Redeem"
// button's ad. Best-effort: on any failure (or if the admin hasn't set one
// yet) the hardcoded fallback above stays in place, so promo redemption
let GIGAPUB_PROJECT_ID = "";

// never breaks because of this fetch.
async function refreshPromoAdConfig() {
  try {
    const status = await api("/api/earn");
    if (status && typeof status._promoAdNetwork === "string" && NETWORK_TYPE_DISPLAY[status._promoAdNetwork]) {
      PROMO_AD_NETWORK = status._promoAdNetwork;
    }
    if (status && typeof status._gigaPubProjectId === "string") {
      GIGAPUB_PROJECT_ID = status._gigaPubProjectId.trim();
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
// TADS network ad slot — Text-Graphic Block (TGB) widget #12098, shown as a
// plain static ad at the very bottom of the Home tab (not reward-based, no
// watch-to-earn flow — it just displays whenever an ad is available, same
// as any normal banner ad). Re-run every time renderHome() re-renders
// (each Home tab visit) since the container <div> itself is recreated by
// content.innerHTML each time — window.tads.init() targets that div fresh
// every call, same pattern as a normal ad refresh. Uses the same
// pollForAdSdk() wait-for-script-tag helper every other network here uses,
// in case widget.js hasn't finished registering window.tads yet.
function initTadsHomeAd() {
  pollForAdSdk(
    () => typeof window.tads !== "undefined" && typeof window.tads.init === "function",
    AD_SDK_POLL_TIMEOUT_MS,
    "TADS SDK not loaded (window.tads is undefined) — check if w.tads.me/widget.js loaded, or if an ad blocker is active."
  )
    .then(() => {
      const adController = window.tads.init({
        widgetId: 12098,
        type: "static",
        debug: false,
        onAdsNotFound: () => console.log("[TADS] No ads found to show"),
      });
      return adController.loadAd().then(() => adController.showAd());
    })
    .catch((err) => console.log("[TADS] home ad skipped:", err.message || err));
}

async function renderHome(content) {
  await refreshUser();
  const usd = (userState.balance * RDC_RATE).toFixed(4);
  const usdtBalance = formatUsdt(userState.usdtBalance);
  const spinStatus = await api("/api/earn?type=spin");
  const spinsRemaining = spinStatus.spinsAvailable || 0;

content.innerHTML = `
    <div class="balance-card-v2">
      <div class="bc-top-row">
        <div class="bc-top-label">
          <span class="bc-card-chip"></span>
          <span>Total Balance</span>
          <span class="bc-eye" title="Hide/Show">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </span>
        </div>
        <div class="bc-meta">
          <div class="bc-id-badge">ID ${esc(userState.telegramId)}</div>
          ${userState.username ? `<div class="bc-username">@${esc(userState.username)} <span class="bc-copy"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></div>` : ""}
        </div>
      </div>
      <div class="bc-total-row">
        <span class="bc-total-amount">${esc(formatRdcCompact(userState.balance))}</span>
        <span class="bc-total-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <path d="M12 2L2 9l10 13 10-13-10-7z" fill="url(#rdcGemGrad)" stroke="#ff3358" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M2 9h20M12 2v20M7 9l5 13M17 9l-5 13M7 9l5-7 5 7" stroke="rgba(255,255,255,0.45)" stroke-width="0.8"/>
            <defs>
              <linearGradient id="rdcGemGrad" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
                <stop stop-color="#ff4d6e"/>
                <stop offset="1" stop-color="#8a001e"/>
              </linearGradient>
            </defs>
          </svg>
        </span>
        <span class="bc-total-unit">RDC</span>
      </div>
      <div class="bc-total-usd">≈ $${esc(usd)} USD</div>

      <div class="bc-cols">
        <div class="bc-col">
          <div class="bc-col-label">
            <span class="bc-col-icon bc-col-icon-rdc">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                <path d="M8 1.5L1.5 6l6.5 8.5 6.5-8.5L8 1.5z" fill="#ff3358" stroke="#ffffff" stroke-width="0.8"/>
              </svg>
            </span>
            RDC Balance
          </div>
          <div class="bc-col-amount">${esc(formatRdcCompact(userState.balance))}</div>
          <div class="bc-col-usd">≈ $${esc(usd)}</div>
        </div>
        <div class="bc-col">
          <div class="bc-col-label">
            <span class="bc-col-icon bc-col-icon-usdt">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                <circle cx="8" cy="8" r="7" fill="#16a34a"/>
                <path d="M4.5 5.5h7M8 5.5v5.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </span>
            USDT Balance
          </div>
          <div class="bc-col-amount bc-col-amount-usdt">${esc(usdtBalance)}</div>
          <div class="bc-col-usd">≈ $${esc(usdtBalance)}</div>
        </div>
      </div>

      <div class="bc-rate-row">
        <span>1 RDC = $${RDC_RATE}</span>
        <span class="bc-rate-sep">|</span>
        <span>${esc(formatRdcCompact(userState.balance))} RDC = $${esc(usd)} USD</span>
      </div>
    </div>

    <div class="bc-action-row">
      <button class="bc-action-btn bc-btn-withdraw" id="withdrawBtn">
        <span class="bc-action-icon">
          <svg class="action-svg-icon withdraw-svg" viewBox="0 0 26 26" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="26" height="26" rx="8" fill="rgba(255,255,255,0.14)"/>
            <path d="M13 18V7M13 7L7.5 12.5M13 7L18.5 12.5" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M8 20.5H18" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
        <span>Withdraw</span>
      </button>
      <button class="bc-action-btn bc-btn-convert" id="converterBtn">
        <span class="bc-action-icon">
          <svg class="action-svg-icon convert-svg" viewBox="0 0 26 26" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="26" height="26" rx="8" fill="rgba(255,255,255,0.14)"/>
            <path d="M6.5 10.5h11m0 0l-3-3M17.5 10.5l-3 3" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M19.5 16.5h-11m0 0l3 3M8.5 16.5l3-3" stroke="rgba(255,255,255,0.85)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span>Convert</span>
      </button>
      <button class="bc-action-btn bc-btn-history" id="historyBtnHome">
        <span class="bc-action-icon">
          <svg class="action-svg-icon history-svg" viewBox="0 0 26 26" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="26" height="26" rx="8" fill="rgba(255,255,255,0.14)"/>
            <circle cx="13" cy="13" r="7.5" stroke="#ffffff" stroke-width="2.2"/>
            <path d="M13 9V13l2.5 2.5" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span>History</span>
      </button>
    </div>

    <div class="live-ticker" id="liveTicker">
      <span class="live-dot"></span>
      <span id="liveTickerText"></span>
    </div>

    <div class="promo-box-v2" id="promoCardHome">
      <div class="promo-box-v2-left">
        <div class="promo-box-v2-icon">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="14" width="20" height="13" rx="2" fill="#f59e0b" stroke="#000000" stroke-width="1.8"/>
            <rect x="4" y="10" width="24" height="4.5" rx="1.5" fill="#f59e0b" stroke="#000000" stroke-width="1.8"/>
            <rect x="13.5" y="10" width="5" height="17" fill="#ef4444" stroke="#000000" stroke-width="1.2"/>
            <path d="M15 10C13 5 8 5.5 8 8C8 10 12.5 10 15 10Z" fill="#ef4444" stroke="#000000" stroke-width="1.2"/>
            <path d="M17 10C19 5 24 5.5 24 8C24 10 19.5 10 17 10Z" fill="#ef4444" stroke="#000000" stroke-width="1.2"/>
            <circle cx="16" cy="10" r="1.4" fill="#f87171" stroke="#000000" stroke-width="1"/>
          </svg>
        </div>
        <div class="promo-box-v2-text">
          <div class="promo-box-v2-title">Have a promo code?</div>
          <div class="promo-box-v2-sub">Redeem it for free Diamonds &amp; USDT</div>
        </div>
      </div>
      <button class="promo-box-v2-btn" id="promoRedeemBtnHome" type="button">
        Redeem <span class="promo-box-v2-chevron">&rsaquo;</span>
      </button>
    </div>

    <div class="quick-grid">
      <button class="quick-card" id="weeklyContestCard">
        <div class="quick-icon quick-icon-purple">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="6"/>
            <circle cx="12" cy="12" r="2" fill="currentColor"/>
          </svg>
        </div>
        <div class="quick-title">Weekly Contest</div>
        <div class="quick-sub">Win exciting rewards</div>
      </button>
      <button class="quick-card" id="leaderboardCard">
        <div class="quick-icon quick-icon-gold">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2M18 9h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2M6 3h12v7a6 6 0 0 1-12 0V3zM12 16v5M8 21h8"/>
          </svg>
        </div>
        <div class="quick-title">Leaderboard</div>
        <div class="quick-sub">Top earners ranking</div>
      </button>
      <button class="quick-card" id="officialChannelCard">
        <div class="quick-icon quick-icon-blue">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m22 2-7 20-4-9-9-4 20-7zM22 2 11 13"/>
          </svg>
        </div>
        <div class="quick-title">Official Channel</div>
        <div class="quick-sub">Join community channel</div>
      </button>
      <button class="quick-card" id="payChannelCard">
        <div class="quick-icon quick-icon-green">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <div class="quick-title">Pay Channel</div>
        <div class="quick-sub">Live payment proofs</div>
      </button>
    </div>

    <div class="section-label" style="margin-top:18px;"><span class="dot"></span>Platform stats</div>
    <div class="stat-grid stat-grid-3">
      <div class="stat-box stat-box-spin">
        <div class="stat-box-header">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="#ff3358" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M10 2v16M2 10h16"/></svg>
          <span>Spins</span>
        </div>
        <div class="value">${esc(spinsRemaining)}</div>
      </div>
      <div class="stat-box stat-box-tasks">
        <div class="stat-box-header">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M5 3h10M4 7h12M4 11h12M4 15h8"/></svg>
          <span>Tasks</span>
        </div>
        <div class="value">${esc(userState.tasksAvailable || 0)}</div>
      </div>
      <div class="stat-box stat-box-refer">
        <div class="stat-box-header">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="#34d399" stroke-width="2"><circle cx="7" cy="7" r="3"/><circle cx="14" cy="7" r="2.5"/><path d="M2 16c0-2.5 2-4.5 5-4.5s5 2 5 4.5M12 15c.5-1.5 2-2.5 4-2.5s3.5 1 3.5 2.5"/></svg>
          <span>Referrals</span>
        </div>
        <div class="value">${esc(userState.referralsCount)}</div>
      </div>
    </div>

    <div class="circle-row">
      <button class="circle-btn" id="quickSpinBtn">
        <div class="circle-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ff3358" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93 4.93 19.07"/>
          </svg>
        </div>
        <div class="circle-label">Spin & Win</div>
      </button>
      <button class="circle-btn" id="quickTaskBtn">
        <div class="circle-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5h6m-6 9 2 2 4-4"/>
          </svg>
        </div>
        <div class="circle-label">Tasks</div>
      </button>
      <button class="circle-btn" id="quickReferBtn">
        <div class="circle-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="circle-label">Refer</div>
      </button>
      <button class="circle-btn" id="quickDailyBtn">
        <span class="soon-badge">SOON</span>
        <div class="circle-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </div>
        <div class="circle-label">Daily</div>
      </button>
      <button class="circle-btn" id="quickWatchBtn">
        <div class="circle-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ec4899" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="4"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/>
          </svg>
        </div>
        <div class="circle-label">Earning</div>
      </button>
    </div>

    <div class="tads-home-ad" id="tads-container-12098"></div>
  `;

  $("#withdrawBtn").addEventListener("click", () => openWithdrawModal());
  $("#converterBtn").addEventListener("click", () => openConverterModal());
  $("#historyBtnHome").addEventListener("click", openHistoryModal);
  startLiveTicker();

  const eyeBtn = content.querySelector(".bc-eye");
  if (eyeBtn) {
    let isHidden = false;
    const totalEl = content.querySelector(".bc-total-amount");
    const usdEl = content.querySelector(".bc-total-usd");
    const origTotal = totalEl ? totalEl.textContent : "";
    const origUsd = usdEl ? usdEl.textContent : "";
    eyeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      isHidden = !isHidden;
      if (isHidden) {
        if (totalEl) totalEl.textContent = "••••••";
        if (usdEl) usdEl.textContent = "≈ $•••• USD";
        eyeBtn.style.opacity = "0.4";
      } else {
        if (totalEl) totalEl.textContent = origTotal;
        if (usdEl) usdEl.textContent = origUsd;
        eyeBtn.style.opacity = "1";
      }
    });
  }

  const copyBtn = content.querySelector(".bc-copy");
  if (copyBtn && userState.username) {
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(`@${userState.username}`);
      copyBtn.style.color = "#34d399";
      setTimeout(() => { copyBtn.style.color = ""; }, 1200);
    });
  }

  // Switches both the visible tab AND the bottom-nav active highlight,
  // same as tapping the nav item directly — used by the quick-action
  // circle buttons below so they behave exactly like nav taps.
  function goToTab(tab) {
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    const navBtn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (navBtn) navBtn.classList.add("active");
    renderTab(tab);
  }

  $("#weeklyContestCard").addEventListener("click", () => openWeeklyContestModal());
  $("#leaderboardCard").addEventListener("click", () => openLeaderboardModal());
  $("#officialChannelCard").addEventListener("click", () => openSpecialTaskLink("https://t.me/redtubeofficial00"));
  $("#payChannelCard").addEventListener("click", () => openSpecialTaskLink("https://t.me/redtubepayment"));

  $("#quickSpinBtn").addEventListener("click", () => goToTab("spin"));
  $("#quickTaskBtn").addEventListener("click", () => goToTab("task"));
  $("#quickReferBtn").addEventListener("click", () => goToTab("refer"));
  $("#quickWatchBtn").addEventListener("click", () => goToTab("earning"));
  $("#quickDailyBtn").addEventListener("click", () => safeAlert("Daily Bonus — coming soon"));

  initTadsHomeAd();

  const promoCard = $("#promoCardHome");
  if (promoCard) {
    promoCard.addEventListener("click", () => openPromoModal());
  }
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
      <div class="modal-header">
        <span class="modal-hdr-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#a855f7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
          </svg>
        </span>
        Convert RDC → USDT
        <button class="modal-close" id="closeConverter">✕</button>
      </div>
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
  // Internal id stays "panda_daily" (already used everywhere in admin
  // configs/DB/API allow-lists) — only the display name/icon changed when
  // this slot's underlying SDK was swapped from Taddy to Monetag's
  // Rewarded Popup format. See showPandaDailyAd() further down.
  panda_daily: { name: "Monetag Daily", icon: "🎁" },
  bengalads: { name: "BengalADS", icon: "🇧🇩" },
  gigapub: { name: "GigaPub", icon: "⚡" },
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

// ---- Monetag Daily (formerly Panda Daily / Taddy) ----
// This slot now plays Monetag's Rewarded Popup format on the SAME
// show_11276042 SDK/zone the plain "monetag" network above already uses —
// the only difference is the 'pop' argument, which per Monetag's docs opens
// the Rewarded Popup flow: the user is taken straight to the offer page (no
// banner) and, once they return, the promise resolves and the reward can be
// credited. Same SDK-ready poll + safety-net timeout contract as every
// other network here, and it goes through the same acquireAdLock/
// showAdByNetworkType path, so the AD BARRIER still guarantees it can never
// run at the same time as another network's ad (e.g. Adexium's auto-popup
// or the plain "monetag" slot).
const showPandaDailyAd = () => pollForAdSdk(
  () => typeof show_11276042 === "function",
  AD_SDK_POLL_TIMEOUT_MS,
  "Monetag Daily SDK not loaded (show_11276042 is undefined) — check if libtl.com/sdk.js loaded, or if an ad blocker is active."
).then(() => withAdShowTimeout(
  show_11276042('pop'),
  AD_SHOW_TIMEOUT_MS,
  "Monetag Daily ad timed out — no response from the ad SDK."
));

// ---- BengalADS ----
// BengalAds.init() needs Telegram's initData, which is already available
// by the time app.js runs (guard.js already called tg.ready()/tg.expand()
// before injecting app.js's <script> tag — see guard.js). init() itself is
// only run once, lazily, right before the FIRST BengalADS ad is ever
// requested (not at page load) — the same "don't block startup on a slow
// ad SDK" approach used everywhere else on this page. If the SDK script
// tag is slow or blocked, pollForAdSdk below simply keeps waiting/times
// out exactly like every other network's wrapper.
let bengalAdsInitialized = false;
function ensureBengalAdsInit() {
  if (bengalAdsInitialized) return;
  if (typeof window.BengalAds === "undefined" || typeof window.BengalAds.init !== "function") return;
  window.BengalAds.init({
    appId: "tma_d3e7933ca7146cf30891125e79b68611e7346e5c",
    formatId: "int_bff8ffcdd472983b6610e097eacb2220491ded45",
    telegramInitData: tg && tg.initData ? tg.initData : "",
  });
  bengalAdsInitialized = true;
}
const showBengalAdsAd = () => pollForAdSdk(
  () => typeof window.BengalAds !== "undefined" && typeof window.BengalAds.showInterstitial === "function",
  AD_SDK_POLL_TIMEOUT_MS,
  "BengalADS SDK not loaded (window.BengalAds is undefined) — check if ads.bengalads.com/sdk/telegram-interstitial.js loaded, or if an ad blocker is active."
).then(() => {
  ensureBengalAdsInit();
  return withAdShowTimeout(
    window.BengalAds.showInterstitial(),
    AD_SHOW_TIMEOUT_MS,
    "BengalADS ad timed out — no response from the ad SDK."
  );
});

// ---- GigaPub (Project ID: 7256) ----
// GigaPub SDK uses window.showGiga() to show interstitial/rewarded ads.
// Per admin instruction, whenever Monetag is chosen, Monetag plays first,
// and immediately after it finishes, GigaPub is shown. If GigaPub fails to
// load or fails to show (e.g. no inventory / timeout / network error),
// the failure is caught and ignored so the user still receives their reward
// for watching Monetag.
const showGigaPubAd = () => pollForAdSdk(
  () => typeof window.showGiga === "function",
  AD_SDK_POLL_TIMEOUT_MS,
  "GigaPub SDK not loaded (window.showGiga is undefined) — check if ad.gigapub.tech/script?id=7256 loaded, or if an ad blocker is active."
).then(() => withAdShowTimeout(
  window.showGiga(),
  AD_SHOW_TIMEOUT_MS,
  "GigaPub ad timed out — no response from the ad SDK."
));

// Safe wrapper: triggers GigaPub right after Monetag. If GigaPub fails, times
// out, has no fill, or fails to load, it is safely caught so the user is never
// blocked from receiving their reward for completing Monetag.
const showGigaPubSafe = async () => {
  try {
    if (typeof window.showGiga !== "function") {
      await pollForAdSdk(() => typeof window.showGiga === "function", 3000, "GigaPub not loaded");
    }
    if (typeof window.showGiga === "function") {
      await withAdShowTimeout(window.showGiga(), AD_SHOW_TIMEOUT_MS, "GigaPub ad timed out — no response.");
    }
  } catch (gigaErr) {
    console.warn("[GigaPub] Ad skipped/failed after Monetag — proceeding with reward anyway:", gigaErr);
  }
};

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
    await showGigaPubSafe();
  } else if (type === "panda_daily") {
    result = await showPandaDailyAd();
    await showGigaPubSafe();
  } else if (type === "gigapub") {
    result = await showGigaPubAd();
  } else if (type === "adsgram_daily" || type === "adsgram" || type === "adsgram_special") {
    result = await showAdsgramAd(type);
  } else if (type === "usl_special") {
    result = await showUslSpecialAd();
  } else if (type === "adsgalaxy") {
    result = await showAdsGalaxyAd();
  } else if (type === "bengalads") {
    result = await showBengalAdsAd();
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

function renderWatchBtnContent(label = "Watch") {
  return `
    <span class="watch-btn-icon">
      <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor">
        <polygon points="5 3 17 10 5 17"/>
      </svg>
    </span>
    <span class="watch-btn-txt">${label}</span>
  `;
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
    if (status && typeof status._gigaPubProjectId === "string" && status._gigaPubProjectId) {
      GIGAPUB_PROJECT_ID = status._gigaPubProjectId.trim();
    }
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
  if (!status || status.error || !status.adsgram_daily) {
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
    const st = status[n.slotId] || { watchedToday: 0, limit: 10, reward: 10, cooldownSecondsLeft: 0, limitReached: false };
    return `
    <div class="ad-card">
      <div class="ad-icon">${n.icon}</div>
      <div class="ad-info">
        <span class="name">${esc(n.name)}</span><span class="reward">+${esc(st.reward)} RDC</span>
        <div class="ad-progress"><div class="ad-progress-fill" style="width:${(st.watchedToday / st.limit) * 100}%" id="prog-${n.slotId}"></div></div>
        <div class="count" id="count-${n.slotId}">${esc(st.watchedToday)}/${esc(st.limit)} today</div>
      </div>
      <button class="watch-btn" data-key="${n.slotId}" data-network="${n.network}">
        ${renderWatchBtnContent("Watch")}
      </button>
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
      btn.innerHTML = `<span class="watch-btn-txt">Loading...</span>`;
      showAdLoadingOverlay();

      let adResult;
      try {
        adResult = await showAdByNetworkType(netType);
      } catch (e) {
        console.error("Ad SDK error:", e);
        hideAdLoadingOverlay();
        releaseAdLock();
        btn.disabled = false;
        btn.innerHTML = renderWatchBtnContent("Watch");
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
        btn.innerHTML = renderWatchBtnContent("Watch");
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
      btn.innerHTML = renderWatchBtnContent("Watch");
      return;
    }
    btn.innerHTML = `<span class="watch-btn-txt">Wait ${remaining}s</span>`;
    remaining -= 1;
  };
  tick();
  cooldownTimers[key] = setInterval(tick, 1000);
}

function showLimitReached(btn, resetInSeconds) {
  btn.disabled = true;
  btn.innerHTML = `<span class="watch-btn-txt">Claimed</span>`;
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
        <div class="special-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <circle cx="12" cy="12" r="10" fill="url(#taskCoinGrad)" stroke="#f59e0b" stroke-width="1.5"/>
            <circle cx="12" cy="12" r="7.5" stroke="rgba(255,255,255,0.55)" stroke-width="0.9" stroke-dasharray="2 1.5"/>
            <path d="M12 6.5v11M9.5 9h4a1.8 1.8 0 0 1 0 3.6H10.5a1.8 1.8 0 0 0 0 3.6h4" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <defs>
              <linearGradient id="taskCoinGrad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                <stop stop-color="#fbbf24"/>
                <stop offset="0.5" stop-color="#f59e0b"/>
                <stop offset="1" stop-color="#b45309"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div class="special-task-main">
          <span class="special-badge ${t.verificationType === "verified" ? "verified" : "link"}">${
        t.verificationType === "verified" ? "✓ Verified" : "🔗 Link"
      }</span>
          <div class="special-title">${esc(t.title)}</div>
          <button class="special-start-btn" data-id="${esc(t.id)}" ${t.completed ? "disabled" : ""}>${
        t.completed ? "✓ Done" : "Start Task"
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
  const isUsdt = gift.currency === "USDT" || gift.currency === "usdt";
  const amountDisplay = isUsdt ? `$${Number(gift.amount).toFixed(2)} USDT` : `${esc(gift.amount)} RDC`;
  const overlay = getGiftOverlay();
  overlay.innerHTML = `
    <div class="gift-box">
      <div class="gift-ray-burst"></div>
      <div class="gift-icon">🎁</div>
      <div class="gift-title">🎉 Congratulations!</div>
      <div class="gift-sub">You have received a gift</div>
      <div class="gift-reason-box">
        <div class="gift-reason-label">REASON</div>
        <div class="gift-reason-text">${esc(gift.reason)}</div>
      </div>
      <button class="gift-claim-btn" id="giftClaimBtn">🎁 Claim Gift (${amountDisplay})</button>
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
        btn.textContent = `🎁 Claim Gift (${amountDisplay})`;
        return;
      }
      await refreshUser();
      showGiftClaimedCard(result.amount, result.currency);
    } catch (e) {
      console.error("Gift claim failed:", e);
      safeAlert("Something went wrong claiming your gift. Please try again.");
      btn.disabled = false;
      btn.textContent = `🎁 Claim Gift (${amountDisplay})`;
    }
  });
}

function showGiftClaimedCard(amount, currency) {
  const isUsdt = currency === "USDT" || currency === "usdt";
  const amountStr = isUsdt ? `+$${Number(amount).toFixed(2)} USDT` : `+${esc(amount)} RDC`;
  const overlay = getGiftOverlay();
  overlay.innerHTML = `
    <div class="gift-box">
      <div class="gift-icon">🎉</div>
      <div class="gift-claimed-amount">${amountStr}</div>
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
    return renderPostTaskHome(body);
  }

  return renderSpecialTasks(body);
}

// ---------- POST TASK (self-serve, pay-to-post) ----------
// Entry screen for the "📢 Post Task" sub-tab: a short pitch + two buttons
// ("Post a New Task" -> the wizard below, "My Posted Tasks" -> History).
// Support-contact is kept as a small secondary link for anything the
// self-serve flow doesn't cover.
function renderPostTaskHome(body) {
  body.innerHTML = `
    <div class="card post-task-card">
      <div class="post-task-icon">📢</div>
      <div class="post-task-title">Promote your channel, group, bot or website</div>
      <div class="post-task-desc">
        Pay with TON to post your own task here — it'll be shown to every user until your paid-for
        number of completions is reached, then it closes automatically.
      </div>
      <button class="btn-primary" id="startPostTaskBtn">➕ Post a New Task</button>
      <button class="btn-secondary" id="viewPostTaskHistoryBtn" style="margin-top:10px;">🕓 My Posted Tasks</button>
    </div>
    <div class="card" style="margin-top:12px;">
      <div class="post-task-desc">Need help instead? <a href="#" id="postTaskSupportLink" style="color:var(--blue);">Contact support</a></div>
    </div>
  `;
  $("#startPostTaskBtn").addEventListener("click", () => renderPostTaskWizard(body));
  $("#viewPostTaskHistoryBtn").addEventListener("click", () => renderPostTaskHistory(body));
  $("#postTaskSupportLink").addEventListener("click", (e) => {
    e.preventDefault();
    openSpecialTaskLink("https://t.me/mahibro0098");
  });
}

// Shared draft object for the wizard below — reset every time the wizard
// (re)starts from renderPostTaskHome.
function freshPostTaskDraft() {
  return {
    taskType: null, // "channel_join" | "link"
    chatId: "",
    chatIdVerified: false,
    title: "",
    tierId: null,
    link: "",
    tiers: null, // fetched lazily, cached for the life of this wizard instance
    rewardPerCompletion: null,
  };
}

// One function renders every step of the wizard, driven entirely by
// `draft`'s current fields — simpler to keep correct than a separate
// render function per step, since later steps need earlier steps' values
// visible in the review anyway.
async function renderPostTaskWizard(body, draft = freshPostTaskDraft()) {
  if (!draft.tiers) {
    const tierData = await api("/api/user", { method: "POST", body: { action: "task_post_tiers" } });
    if (tierData && tierData.success) {
      draft.tiers = tierData.tiers;
      draft.rewardPerCompletion = tierData.rewardPerCompletion;
    } else {
      draft.tiers = [];
    }
  }

  body.innerHTML = `
    <div class="card">
      <button class="btn-secondary post-task-back-btn" id="postTaskBackBtn">← Back</button>

      <div class="post-task-step-label">1. Task type</div>
      <div class="post-task-type-row">
        <button class="post-task-type-btn ${draft.taskType === "channel_join" ? "active" : ""}" data-type="channel_join">
          📢<br>Channel / Group Join
        </button>
        <button class="post-task-type-btn ${draft.taskType === "link" ? "active" : ""}" data-type="link">
          🔗<br>Link (Bot / Website)
        </button>
      </div>

      ${draft.taskType === "channel_join" ? `
        <div class="post-task-step-label">2. Channel/group username</div>
        <div class="post-task-desc" style="margin-top:-6px;">
          The bot MUST be an admin of this channel/group before you can post a task for it.
        </div>
        <input type="text" id="postTaskChatId" class="post-task-input" placeholder="@yourchannel" value="${esc(draft.chatId)}">
        <button class="btn-secondary" id="verifyAdminBtn" style="margin-top:8px;">🔎 Verify bot is admin</button>
        <div id="verifyAdminResult" style="margin-top:8px;">
          ${draft.chatIdVerified ? `<span style="color:#4ade80;">✅ Verified — bot is an admin here.</span>` : ""}
        </div>
      ` : ""}

      ${draft.taskType === "link" ? `
        <div class="post-task-step-label">2. Link (bot or website)</div>
        <input type="text" id="postTaskLink" class="post-task-input" placeholder="https://... or t.me/yourbot" value="${esc(draft.link)}">
        <div id="postTaskLinkWarning" style="margin-top:6px;color:#f87171;"></div>
      ` : ""}

      ${draft.taskType ? `
        <div class="post-task-step-label">3. Task title</div>
        <input type="text" id="postTaskTitle" class="post-task-input" placeholder="e.g. Join our announcement channel" maxlength="100" value="${esc(draft.title)}">

        <div class="post-task-step-label">4. How many users should complete this?</div>
        <div class="post-task-tier-grid">
          ${draft.tiers.map((t) => `
            <button class="post-task-tier-btn ${draft.tierId === t.id ? "active" : ""}" data-tier="${esc(t.id)}">
              <div class="post-task-tier-count">${esc(t.maxCompletions)}</div>
              <div class="post-task-tier-label">completions</div>
              <div class="post-task-tier-price">${esc(t.priceTon)} TON</div>
            </button>
          `).join("")}
        </div>
        ${draft.rewardPerCompletion ? `<div class="post-task-desc">Each user who completes it earns ${esc(draft.rewardPerCompletion)} RDC.</div>` : ""}

        <button class="btn-primary" id="reviewPostTaskBtn" style="margin-top:14px;">Continue to Payment →</button>
      ` : ""}
    </div>
  `;

  $("#postTaskBackBtn").addEventListener("click", () => renderPostTaskHome(body));

  body.querySelectorAll(".post-task-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      draft.taskType = btn.dataset.type;
      renderPostTaskWizard(body, draft);
    });
  });

  const chatIdInput = $("#postTaskChatId");
  if (chatIdInput) {
    chatIdInput.addEventListener("input", () => {
      draft.chatId = chatIdInput.value;
      draft.chatIdVerified = false; // any edit invalidates a previous verification
    });
    $("#verifyAdminBtn").addEventListener("click", async () => {
      const vBtn = $("#verifyAdminBtn");
      const resultEl = $("#verifyAdminResult");
      const chatId = chatIdInput.value.trim();
      if (!chatId) {
        resultEl.innerHTML = `<span style="color:#f87171;">Please enter a channel/group username first.</span>`;
        return;
      }
      vBtn.disabled = true;
      vBtn.textContent = "Checking...";
      try {
        const result = await api("/api/user", { method: "POST", body: { action: "check_channel_admin", chatId } });
        if (result && result.success && result.isAdmin) {
          draft.chatIdVerified = true;
          resultEl.innerHTML = `<span style="color:#4ade80;">✅ Verified — bot is an admin here.</span>`;
        } else {
          draft.chatIdVerified = false;
          resultEl.innerHTML = `<span style="color:#f87171;">❌ The bot is not an admin of this channel/group yet. Add it as admin, then try again.</span>`;
        }
      } catch (e) {
        resultEl.innerHTML = `<span style="color:#f87171;">Could not check right now — please try again.</span>`;
      } finally {
        vBtn.disabled = false;
        vBtn.textContent = "🔎 Verify bot is admin";
      }
    });
  }

  const linkInput = $("#postTaskLink");
  if (linkInput) {
    linkInput.addEventListener("input", () => {
      draft.link = linkInput.value;
      $("#postTaskLinkWarning").textContent = "";
    });
  }

  const titleInput = $("#postTaskTitle");
  if (titleInput) {
    titleInput.addEventListener("input", () => { draft.title = titleInput.value; });
  }

  body.querySelectorAll(".post-task-tier-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      draft.tierId = btn.dataset.tier;
      renderPostTaskWizard(body, draft);
    });
  });

  const reviewBtn = $("#reviewPostTaskBtn");
  if (reviewBtn) {
    reviewBtn.addEventListener("click", () => {
      // Re-read the live input values (draft fields already track them via
      // the input listeners above, this is just a final safety sync).
      if (titleInput) draft.title = titleInput.value.trim();
      if (linkInput) draft.link = linkInput.value.trim();

      if (!draft.title) {
        safeAlert("Please enter a task title.");
        return;
      }
      if (!draft.tierId) {
        safeAlert("Please choose how many completions you want.");
        return;
      }
      if (draft.taskType === "channel_join") {
        if (!draft.chatId.trim()) {
          safeAlert("Please enter a channel/group username.");
          return;
        }
        if (!draft.chatIdVerified) {
          safeAlert("Please verify the bot is an admin of that channel/group first.");
          return;
        }
      } else {
        const plausible = /^https?:\/\/.+/i.test(draft.link) || /^(https?:\/\/)?t\.me\/\w+/i.test(draft.link);
        if (!plausible) {
          $("#postTaskLinkWarning").textContent = "Please enter a valid link (starting with https:// or t.me/) before continuing.";
          return;
        }
      }
      renderPostTaskReview(body, draft);
    });
  }
}

function renderPostTaskReview(body, draft) {
  const tier = draft.tiers.find((t) => t.id === draft.tierId);
  body.innerHTML = `
    <div class="card">
      <button class="btn-secondary post-task-back-btn" id="postTaskReviewBackBtn">← Edit</button>
      <div class="post-task-step-label">Review your task</div>
      <div class="key-buy-rows">
        <div class="key-buy-row"><span>Type</span><span>${draft.taskType === "channel_join" ? "Channel/Group Join" : "Link (Bot/Website)"}</span></div>
        <div class="key-buy-row"><span>Title</span><span>${esc(draft.title)}</span></div>
        ${draft.taskType === "channel_join" ? `<div class="key-buy-row"><span>Channel</span><span>${esc(draft.chatId)}</span></div>` : `<div class="key-buy-row"><span>Link</span><span style="word-break:break-all;">${esc(draft.link)}</span></div>`}
        <div class="key-buy-row"><span>Completions</span><span>${esc(tier.maxCompletions)}</span></div>
        <div class="key-buy-row"><span>Price</span><span>${esc(tier.priceTon)} TON</span></div>
      </div>
      <button class="btn-primary" id="payPostTaskBtn" style="margin-top:14px;">Pay ${esc(tier.priceTon)} TON</button>
    </div>
  `;
  $("#postTaskReviewBackBtn").addEventListener("click", () => renderPostTaskWizard(body, draft));
  $("#payPostTaskBtn").addEventListener("click", () => submitPostTaskPayment(body, draft));
}

async function submitPostTaskPayment(body, draft) {
  const btn = $("#payPostTaskBtn");
  btn.disabled = true;
  btn.textContent = "Processing...";
  try {
    const order = await api("/api/user", {
      method: "POST",
      body: {
        action: "create_task_post_order",
        taskType: draft.taskType,
        title: draft.title,
        link: draft.taskType === "link" ? draft.link : undefined,
        chatId: draft.taskType === "channel_join" ? draft.chatId : undefined,
        tierId: draft.tierId,
      },
    });
    if (!(order && order.success)) {
      safeAlert((order && order.error) || "Could not start payment. Please try again.");
      btn.disabled = false;
      btn.textContent = "Pay";
      return;
    }

    if (tonConnectUI && tonConnectUI.wallet) {
      btn.textContent = "Confirm in your wallet...";
      try {
        await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{ address: order.address, amount: String(order.amountNano) }],
        });
      } catch (e) {
        console.error("Post Task sendTransaction failed/rejected:", e);
        safeAlert("Payment wasn't sent from your wallet — you can try again from the link below.");
      }
    } else {
      const openUrl = order.tonkeeperLink || order.tonDeepLink;
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) {
        window.Telegram.WebApp.openLink(openUrl);
      } else {
        window.open(openUrl, "_blank");
      }
    }
    showPostTaskWaitingForPayment(body, order, draft);
  } catch (e) {
    console.error("create_task_post_order error:", e);
    safeAlert("Could not start payment. Please try again.");
    btn.disabled = false;
    btn.textContent = "Pay";
  }
}

// "waiting -> poll -> success" pattern for Task Post payments — the ONLY
// thing that ever actually creates the task is creditTaskPostOrder()
// server-side once payment is confirmed; this screen just polls to know
// when to say so.
function showPostTaskWaitingForPayment(body, order, draft) {
  body.innerHTML = `
    <div class="card">
      <div class="post-task-icon">⏳</div>
      <div class="post-task-title">Waiting for payment</div>
      <div class="key-buy-rows">
        <div class="key-buy-row"><span>Send exactly</span><span>${esc(order.priceTon)} TON</span></div>
        <div class="key-buy-row"><span>To address</span><span class="key-buy-copyval" id="postTaskCopyAddr">${esc(order.address)}</span></div>
      </div>
      <div class="post-task-desc">
        Your task "${esc(draft.title)}" will go live automatically once the payment is confirmed
        on-chain (usually within a few minutes) — no need to keep this open. If you've already
        paid, please allow a little time for confirmation.
      </div>
    </div>
  `;
  const el = $("#postTaskCopyAddr");
  if (el) {
    el.addEventListener("click", () => {
      navigator.clipboard && navigator.clipboard.writeText(el.textContent).catch(() => {});
      const original = el.textContent;
      el.textContent = "Copied!";
      setTimeout(() => { el.textContent = original; }, 1200);
    });
  }

  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const check = await api("/api/user", {
        method: "POST",
        body: { action: "check_task_post_order", orderId: order.orderId },
      });
      if (check && check.success && check.status === "paid") {
        stopped = true;
        clearInterval(timer);
        body.innerHTML = `
          <div class="card">
            <div class="post-task-icon">✅</div>
            <div class="post-task-title">Your task is live!</div>
            <div class="post-task-desc">"${esc(draft.title)}" is now visible to every user. Check "My Posted Tasks" to track its progress.</div>
            <button class="btn-primary" id="postTaskDoneBtn" style="margin-top:10px;">🕓 View My Posted Tasks</button>
          </div>
        `;
        $("#postTaskDoneBtn").addEventListener("click", () => renderPostTaskHistory(body));
      }
    } catch (e) {
      console.error("check_task_post_order poll failed:", e);
    }
  }, 3000);
}

// ---------- POST TASK: History ----------
// Shows the poster's own tasks — active (still collecting) and any that
// finished within the last 24h (see ttl_special_tasks_completed_24h in
// api/_db.js, which is what actually removes a finished one from here
// after that window — this view just displays whatever's currently
// still in the collection).
async function renderPostTaskHistory(body) {
  body.innerHTML = `<div class="card">Loading...</div>`;
  const result = await api("/api/user", { method: "POST", body: { action: "my_posted_tasks" } });
  const tasks = (result && result.success && result.tasks) || [];

  body.innerHTML = `
    <div class="card">
      <button class="btn-secondary post-task-back-btn" id="postTaskHistoryBackBtn">← Back</button>
      <div class="post-task-step-label">My Posted Tasks</div>
      ${tasks.length === 0 ? `<div class="post-task-desc">You haven't posted any tasks yet.</div>` : ""}
    </div>
    ${tasks.map((t) => {
      const pct = t.maxCompletions ? Math.min(100, Math.round((t.completedCount / t.maxCompletions) * 100)) : 0;
      const status = !t.active ? "Completed ✅" : "Active";
      return `
        <div class="card" style="margin-top:10px;">
          <div class="post-task-history-title">${esc(t.title)}</div>
          <div class="post-task-desc">${t.type === "channel_join" ? "Channel/Group Join" : "Link"} — ${status}</div>
          <div class="post-task-progress-bar"><div class="post-task-progress-fill" style="width:${pct}%;"></div></div>
          <div class="post-task-desc">${esc(t.completedCount || 0)} / ${esc(t.maxCompletions || "∞")} completed</div>
        </div>
      `;
    }).join("")}
  `;
  $("#postTaskHistoryBackBtn").addEventListener("click", () => renderPostTaskHome(body));
}

// ---------- REFER & REFER CONTEST ----------
let referCurrentSubtab = "invite"; // "invite" | "contest"
let contestCurrentPeriod = "this_week"; // "this_week" | "previous_week"
let contestCountdownInterval = null;

async function renderRefer(content) {
  if (contestCountdownInterval) {
    clearInterval(contestCountdownInterval);
    contestCountdownInterval = null;
  }

  content.innerHTML = `
    <div class="refer-subtab-bar">
      <button class="refer-subtab-btn ${referCurrentSubtab === "invite" ? "active" : ""}" id="referSubtabInviteBtn">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Refer
      </button>
      <button class="refer-subtab-btn ${referCurrentSubtab === "contest" ? "active" : ""}" id="referSubtabContestBtn">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>
        </svg>
        Refer Contest 🏆
      </button>
    </div>
    <div id="referSubtabView"></div>
  `;

  const viewContainer = $("#referSubtabView");

  $("#referSubtabInviteBtn").addEventListener("click", () => {
    if (referCurrentSubtab === "invite") return;
    referCurrentSubtab = "invite";
    if (contestCountdownInterval) {
      clearInterval(contestCountdownInterval);
      contestCountdownInterval = null;
    }
    $("#referSubtabInviteBtn").classList.add("active");
    $("#referSubtabContestBtn").classList.remove("active");
    renderReferInviteView(viewContainer);
  });

  $("#referSubtabContestBtn").addEventListener("click", () => {
    if (referCurrentSubtab === "contest") return;
    referCurrentSubtab = "contest";
    $("#referSubtabInviteBtn").classList.remove("active");
    $("#referSubtabContestBtn").classList.add("active");
    renderReferContestView(viewContainer);
  });

  if (referCurrentSubtab === "contest") {
    renderReferContestView(viewContainer);
  } else {
    renderReferInviteView(viewContainer);
  }
}

async function renderReferInviteView(container) {
  container.innerHTML = `
    <div class="tab-loading">
      <div class="tab-loading-ring"></div>
    </div>
  `;
  try {
    const ref = await api("/api/referral");
    const commissionUsd = ((ref.withdrawalCommissionEarnings || 0) * RDC_RATE).toFixed(4);
    container.innerHTML = `
      <div class="refer-hero">
        <div class="refer-hero-badge">
          <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="#a855f7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <h3>Refer Friends, Earn RDC</h3>
        <p>Each friend who completes all 3 steps earns you up to 220 RDC total.</p>
        <div class="refer-commission-badge">
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="#f59e0b" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M10 6v8M7 8h6M7 12h4"/></svg>
          <span>+10% of everything they withdraw, forever</span>
        </div>
        <div class="link-box">${esc(ref.link)}</div>
        <div class="refer-actions">
          <button class="btn-primary" id="shareBtn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L2 9l9 3 3 9 8-19L12 2z"/></svg>
            Share
          </button>
          <button class="btn-secondary" id="copyBtn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
        </div>
      </div>
      <div class="stat-grid" style="margin-top:14px;">
        <div class="stat-box">
          <div class="label">Total Referrals</div>
          <div class="value">${esc(ref.totalReferrals)}</div>
        </div>
        <div class="stat-box">
          <div class="label">Referral Earnings</div>
          <div class="value">${esc(ref.referralEarnings)} RDC</div>
        </div>
      </div>
      <div class="commission-box">
        <div class="commission-left">
          <div class="commission-title">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#10b981" stroke-width="2"><path d="M12 2v16M2 10h16M17 5l-5-3-5 3"/></svg>
            Withdrawal Commission
          </div>
          <div class="commission-desc">10% of every withdrawal your referrals make — for as long as they keep withdrawing.</div>
        </div>
        <div class="commission-right">
          <div class="commission-value">${esc(ref.withdrawalCommissionEarnings || 0)}</div>
          <div class="commission-usd">≈ $${esc(commissionUsd)} USD</div>
        </div>
      </div>
      <div class="section-label" style="margin-top:18px;"><span class="dot"></span>How Rewards Work</div>
      <div class="reward-step">
        <div class="step-num">1</div>
        <div class="txt">Friend joins channel + community and verifies</div>
        <div class="plus">+30</div>
      </div>
      <div class="reward-step">
        <div class="step-num">2</div>
        <div class="txt">Friend completes 10 tasks</div>
        <div class="plus">+90</div>
      </div>
      <div class="reward-step">
        <div class="step-num">3</div>
        <div class="txt">Friend watches 25 ads</div>
        <div class="plus">+180</div>
      </div>
      <div class="reward-step reward-step-vip">
        <div class="step-num">★</div>
        <div class="txt">Every time they withdraw, after that</div>
        <div class="plus">+10%</div>
      </div>
      <div class="refer-valid-box">
        <div class="refer-valid-title">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#10b981" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="m6 10 3 3 5-5"/></svg>
          When does a referral become "valid"?
        </div>
        <p>A referral counts toward your withdrawals once your friend has completed <strong>both</strong> — 10 tasks <strong>and</strong> 25 ads (doesn't matter which order). Joining the channel alone, or just one of the two, isn't enough yet.</p>
      </div>
    `;
    $("#copyBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(ref.link);
      $("#copyBtn").innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        $("#copyBtn").innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 1500);
    });
    $("#shareBtn").addEventListener("click", () => {
      if (tg) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(ref.link)}`);
      else window.open(`https://t.me/share/url?url=${encodeURIComponent(ref.link)}`, "_blank");
    });
  } catch (err) {
    console.error("renderReferInviteView error:", err);
    container.innerHTML = `<div class="contest-empty-box">Failed to load referral data. Please try again.</div>`;
  }
}

async function renderReferContestView(container) {
  container.innerHTML = `
    <div class="tab-loading">
      <div class="tab-loading-ring"></div>
    </div>
  `;
  try {
    const data = await api("/api/referral?contest=1");
    if (!data || data.error) {
      container.innerHTML = `<div class="contest-empty-box">Failed to load contest. Please try again.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="contest-period-switch">
        <button class="contest-period-btn ${contestCurrentPeriod === "this_week" ? "active" : ""}" id="contestPeriodThisWeekBtn">Current week</button>
        <button class="contest-period-btn ${contestCurrentPeriod === "previous_week" ? "active" : ""}" id="contestPeriodPrevWeekBtn">Previous week</button>
      </div>

      <div id="contestPeriodBody"></div>
    `;

    const body = $("#contestPeriodBody");

    $("#contestPeriodThisWeekBtn").addEventListener("click", () => {
      if (contestCurrentPeriod === "this_week") return;
      contestCurrentPeriod = "this_week";
      $("#contestPeriodThisWeekBtn").classList.add("active");
      $("#contestPeriodPrevWeekBtn").classList.remove("active");
      renderContestPeriodContent(body, data);
    });

    $("#contestPeriodPrevWeekBtn").addEventListener("click", () => {
      if (contestCurrentPeriod === "previous_week") return;
      contestCurrentPeriod = "previous_week";
      if (contestCountdownInterval) {
        clearInterval(contestCountdownInterval);
        contestCountdownInterval = null;
      }
      $("#contestPeriodThisWeekBtn").classList.remove("active");
      $("#contestPeriodPrevWeekBtn").classList.add("active");
      renderContestPeriodContent(body, data);
    });

    renderContestPeriodContent(body, data);
  } catch (err) {
    console.error("renderReferContestView error:", err);
    container.innerHTML = `<div class="contest-empty-box">Failed to load contest. Please try again.</div>`;
  }
}

function renderContestPeriodContent(body, data) {
  if (contestCountdownInterval) {
    clearInterval(contestCountdownInterval);
    contestCountdownInterval = null;
  }

  if (contestCurrentPeriod === "this_week") {
    const thisWeek = data.thisWeek;
    const rankings = thisWeek.rankings || [];

    body.innerHTML = `
      <div class="contest-meta-row">
        <div class="contest-ends-label">Contest ends in:</div>
        <div class="contest-live-badge">
          <span class="live-pulse-dot"></span>
          <span class="live-pulse-text">LIVE</span>
        </div>
      </div>

      <div class="contest-countdown-box">
        <div class="contest-countdown-digits" id="contestCountdownVal">00d : 00h : 00m : 00s</div>
      </div>

      <div class="contest-participants-label">List of participants:</div>

      <div class="contest-participants-list">
        ${
          rankings.length === 0
            ? `
              <div class="contest-empty-box">
                <div class="contest-empty-icon">👥</div>
                <div class="contest-empty-title">No participants yet</div>
                <div class="contest-empty-sub">Share your referral link to be the first on the leaderboard!</div>
              </div>
            `
            : rankings
                .map((r) => {
                  const isMe = r.isMe;
                  const photoUrl = r.photoUrl || (isMe && tgUser && tgUser.photo_url ? tgUser.photo_url : null);
                  const displayName = r.firstName || (r.username ? r.username : `User ${r.telegramId}`);
                  const usernameSub = r.username ? `@${r.username}` : `UID: ${r.telegramId}`;
                  const initial = (displayName || "U").trim().charAt(0).toUpperCase();

                  const prizeHtml =
                    r.prizeUsdt > 0
                      ? `<div class="participant-reward-amt">$${r.prizeUsdt.toFixed(2)}</div>`
                      : `<div class="participant-reward-dash">-</div>`;

                  return `
                    <div class="participant-card ${isMe ? "is-me" : ""}">
                      <div class="participant-card-top">
                        <div class="participant-user-info">
                          <div class="participant-avatar-wrap">
                            ${
                              photoUrl
                                ? `<img src="${esc(photoUrl)}" class="participant-avatar-img" alt="" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />`
                                : ""
                            }
                            <div class="participant-avatar-fallback" style="${photoUrl ? "display:none;" : ""}">
                              ${esc(initial)}
                            </div>
                          </div>
                          <div class="participant-name-wrap">
                            <div class="participant-display-name">
                              ${esc(displayName)}
                              ${isMe ? `<span class="participant-you-tag">YOU</span>` : ""}
                            </div>
                            <div class="participant-username">${esc(usernameSub)}</div>
                          </div>
                        </div>
                        <div class="participant-reward-wrap">
                          ${prizeHtml}
                        </div>
                      </div>
                      <div class="participant-card-bottom">
                        <div class="participant-friends-count">${r.refs} new ${r.refs === 1 ? "friend" : "friends"}</div>
                        <div class="participant-rank-num">#${r.rank}</div>
                      </div>
                    </div>
                  `;
                })
                .join("")
        }
      </div>
    `;

    // Live countdown timer updater
    const endsTime = new Date(thisWeek.endsAt).getTime();
    function updateCountdown() {
      const el = $("#contestCountdownVal");
      if (!el) return;
      const diff = endsTime - Date.now();
      if (diff <= 0) {
        el.textContent = "00d : 00h : 00m : 00s";
        return;
      }
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
      const minutes = Math.floor((diff / (1000 * 60)) % 60);
      const seconds = Math.floor((diff / 1000) % 60);
      const dStr = String(days).padStart(2, "0");
      const hStr = String(hours).padStart(2, "0");
      const mStr = String(minutes).padStart(2, "0");
      const sStr = String(seconds).padStart(2, "0");
      el.textContent = `${dStr}d : ${hStr}h : ${mStr}m : ${sStr}s`;
    }
    updateCountdown();
    contestCountdownInterval = setInterval(updateCountdown, 1000);
  } else {
    // Previous Week View
    const prev = data.previousWeek;
    if (!prev || !prev.rankings || prev.rankings.length === 0) {
      body.innerHTML = `
        <div class="contest-empty-box" style="margin-top:20px;">
          <div class="contest-empty-icon">⏳</div>
          <div class="contest-empty-title">No previous contest data yet</div>
          <div class="contest-empty-sub">This week's contest is active. Once it ends, the final winners and rewards will be shown right here!</div>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="contest-meta-row">
        <div class="contest-ends-label">Week #${esc(prev.weekNumber)} Winners</div>
        <div class="contest-ended-badge">FINISHED</div>
      </div>

      <div class="contest-participants-label">List of participants:</div>

      <div class="contest-participants-list">
        ${prev.rankings
          .map((r) => {
            const photoUrl = r.photoUrl || null;
            const displayName = r.firstName || (r.username ? r.username : `User ${r.telegramId}`);
            const usernameSub = r.username ? `@${r.username}` : `UID: ${r.telegramId}`;
            const initial = (displayName || "U").trim().charAt(0).toUpperCase();

            const prizeHtml =
              r.prizeUsdt > 0
                ? `<div class="participant-reward-amt won">$${r.prizeUsdt.toFixed(2)}</div>`
                : `<div class="participant-reward-dash">-</div>`;

            return `
              <div class="participant-card">
                <div class="participant-card-top">
                  <div class="participant-user-info">
                    <div class="participant-avatar-wrap">
                      ${
                        photoUrl
                          ? `<img src="${esc(photoUrl)}" class="participant-avatar-img" alt="" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />`
                          : ""
                      }
                      <div class="participant-avatar-fallback" style="${photoUrl ? "display:none;" : ""}">
                        ${esc(initial)}
                      </div>
                    </div>
                    <div class="participant-name-wrap">
                      <div class="participant-display-name">${esc(displayName)}</div>
                      <div class="participant-username">${esc(usernameSub)}</div>
                    </div>
                  </div>
                  <div class="participant-reward-wrap">
                    ${prizeHtml}
                  </div>
                </div>
                <div class="participant-card-bottom">
                  <div class="participant-friends-count">${r.refs} new ${r.refs === 1 ? "friend" : "friends"}</div>
                  <div class="participant-rank-num">#${r.rank}</div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }
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
        <div class="coin-label">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M8 1.5L1.5 6l6.5 8.5 6.5-8.5L8 1.5z" fill="#ff3358" stroke="#fff" stroke-width="0.8"/></svg>
          RDC Balance
        </div>
        <div class="value" id="spinRdcVal">0</div>
      </div>
      <div class="spin-balance-box">
        <div class="coin-label">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><circle cx="8" cy="8" r="7" fill="#10b981"/><path d="M4.5 5.5h7M8 5.5v5.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/></svg>
          USDT Balance
        </div>
        <div class="value" id="spinUsdtVal">0.000</div>
      </div>
    </div>

    <div class="spin-wheel-wrap">
      <div class="spin-arrow">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="url(#spinArrowGrad)">
          <path d="M12 22L3 6h18L12 22z"/>
          <defs>
            <linearGradient id="spinArrowGrad" x1="12" y1="6" x2="12" y2="22" gradientUnits="userSpaceOnUse">
              <stop stop-color="#ff3358"/>
              <stop offset="1" stop-color="#b91c1c"/>
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div class="spin-wheel" id="spinWheel">
        ${SPIN_WHEEL_SEGMENTS.map(
          (s, i) => `
          <div class="spin-segment spin-segment-${i}" style="transform: rotate(${i * 45 + 22.5}deg);">
            <span class="spin-segment-label">${s.short}</span>
          </div>`
        ).join("")}
      </div>
      <div class="spin-wheel-center" id="spinWheelCenter">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </div>
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
  if (status && typeof status.gigaPubProjectId === "string" && status.gigaPubProjectId) {
    GIGAPUB_PROJECT_ID = status.gigaPubProjectId.trim();
  }
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

// ---- SPIN AD FALLBACK (Monetag) ----
// If the ad network assigned to THIS spin (from the admin's before/after
// sequence in ADS_CONFIG.spin) fails to actually LOAD/SHOW — SDK script
// never registered, no fill, the show() call timed out, etc — the user
// would otherwise be stuck unable to spin until they retry. Per request,
// we instead transparently substitute a Monetag ad in that exact case,
// SPIN ONLY (Earning tab / Promo redeem still call showAdByNetworkType()
// directly and are completely untouched).
//
// Important: this does NOT change what gets sent to the server. The
// caller (handleSpinClick) still POSTs the ORIGINAL `network` (the one
// the server told us to expect via nextNetwork/expectedNetwork) — the
// backend only checks that value against its own before/after sequence
// for anti-cheat/stats, it has no idea (and doesn't need to know) which
// SDK actually rendered. So server-side validation, reward crediting,
// spin_logs, and every other ad slot are all completely unaffected.
//
// This also never risks two ads at once: the caller already holds the
// single global ad lock (acquireAdLock) for the whole duration of this
// function, and the fallback call only ever starts AFTER the primary
// network's promise has already rejected — never in parallel.
//
// A deliberate early skip (err.adSkippedEarly) is a user-behavior case,
// not an "ad failed to load" case, so it's deliberately NOT retried here
// — it bubbles straight up to the existing "watch longer" message.
async function playSpinAdWithFallback(network) {
  try {
    await showAdByNetworkType(network);
  } catch (err) {
    if (err && err.adSkippedEarly) throw err;
    if (network === "monetag") throw err; // already Monetag — nothing left to fall back to
    console.warn(`[SpinAdFallback] "${network}" failed to load for this spin — falling back to Monetag.`, err);
    await showAdByNetworkType("monetag"); // let this one's error (if any) propagate as-is
  }
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
    await playSpinAdWithFallback(network);
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
// Minimum withdraw is now tiered by withdrawal count (1st $0.03, 2nd $0.06,
// 3rd $0.12, 4th $0.16, 5th+ fixed $0.20 — same for both methods) and comes
// from the server (elig.minRequired) since it depends on the user's own
// withdraw history — see api/withdraw.js.
const METHODS = {
  binance: { label: "Binance UID", placeholder: "Enter your Binance UID (numbers only)" },
  tonkeeper: { label: "Tonkeeper Address", placeholder: "Enter your Tonkeeper wallet address" },
};

// Renders the status lines' innerHTML (called once eligibility data
// arrives, and again after any Submit attempt so a rejected withdraw's
// updated counts show immediately without closing the modal).
function renderWithdrawStatusLines(elig) {
  const tasksDone = elig.tasksMet;
  const adsDone = elig.adsMet;
  const spinsDone = elig.spinsMet;
  const waitLine = elig.newUserWaitApplicable
    ? `<div class="wd-status-line ${elig.newUserWaitMet ? "met" : ""}">
         <span>${elig.newUserWaitMet ? "✅" : "⏳"}</span> ${elig.newUserWaitMet ? "48-hour new account wait complete" : `New account — wait ${esc(elig.newUserWaitHoursLeft)} more hour(s) before your first withdrawal`}
       </div>`
    : "";

  return `
    <div class="wd-status-line ${tasksDone ? "met" : ""}">
      <span>${tasksDone ? "✅" : "⏳"}</span> Complete ${esc(elig.tasksRequired)} tasks today (${esc(elig.tasksToday)}/${esc(elig.tasksRequired)})
    </div>
    <div class="wd-status-line ${adsDone ? "met" : ""}">
      <span>${adsDone ? "✅" : "⏳"}</span> Watch ${esc(elig.adsRequired)} ads today (${esc(elig.adsToday)}/${esc(elig.adsRequired)})
    </div>
    <div class="wd-status-line ${spinsDone ? "met" : ""}">
      <span>${spinsDone ? "✅" : "⏳"}</span> Complete ${esc(elig.spinsRequired)} spins (${esc(elig.spinsCompleted)}/${esc(elig.spinsRequired)})
    </div>
    ${waitLine}
  `;
}

function openWithdrawModal(method = "binance") {
  const overlay = $("#withdrawModal");
  const m = METHODS[method];
  const usdtBalance = formatUsdt(userState.usdtBalance);
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <span class="modal-hdr-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ff3358" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v14M5 9l7 7 7-7M2 20h20"/>
          </svg>
        </span>
        Withdraw USDT
        <button class="modal-close" id="closeWithdraw">✕</button>
      </div>
      <p style="color:var(--text-dim);font-size:13px;display:flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;"></span>
        USDT Balance: <strong style="color:var(--text);">$${esc(usdtBalance)}</strong>
      </p>
      <div class="field-label">Select Gateway</div>
      <div class="method-tabs">
        <div class="method-tab ${method === "binance" ? "active" : ""}" data-m="binance">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#f59e0b"><path d="m12 2 3.8 3.8-1.8 1.8L12 5.6 9.9 7.6 8.2 5.8 12 2zm-6.2 6.2 1.8-1.8 3.8 3.8L9.6 12 7.6 10l-1.8-1.8zm12.4 0 1.8 1.8L14.4 12l-1.8-1.8 3.8-3.8 1.8 1.8zM12 9.2l2.8 2.8-2.8 2.8-2.8-2.8 2.8-2.8zM5.8 12.2l1.8 1.8-1.8 1.8L2 12l3.8-3.8 1.8 1.8-1.8 2.2zm12.4 0-1.8-2.2 1.8-1.8L22 12l-3.8 3.8-1.8-1.8 1.8-1.8zm-6.2 6.2 1.8-1.8 2.1 2.1-3.9 3.9-3.8-3.8 2.1-2.1 1.7 1.7z"/></svg>
          Binance
        </div>
        <div class="method-tab ${method === "tonkeeper" ? "active" : ""}" data-m="tonkeeper">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#0098ea" stroke-width="2"><path d="M12 2L3 7v10l9 5 9-5V7l-9-5z"/><path d="m12 6 5 6-5 6-5-6 5-6z"/></svg>
          Tonkeeper
        </div>
      </div>
      <div class="field-label">${m.label}</div>
      <input class="field-input" id="wAddress" placeholder="${m.placeholder}" />
      <div class="field-label" id="wAmountLabel">Amount (USDT) — minimum loading…</div>
      <div class="amount-max-row">
        <input class="field-input" id="wAmount" type="number" placeholder="0.00" />
        <button class="max-btn" id="wMaxBtn">MAX</button>
      </div>
      <div class="withdraw-status-box" id="withdrawStatusBox">
        <div class="tab-loading"><div class="tab-loading-ring"></div></div>
      </div>
      <div class="hint-box">No withdraw fee — you receive the full amount in USDT (the 25% fee is already taken when you convert RDC to USDT). You must complete at least 5 tasks (lifetime), watch at least 10 ads today, and complete at least 10 spins to withdraw. Once you set your withdraw address it is locked permanently — it cannot be changed later. Requests are reviewed manually within 24 hours.</div>
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

  // Fetch live eligibility (today's tasks/ads/spins + tiered minimum) and
  // fill in the status lines + the real minimum for this user's NEXT
  // withdrawal. Submit stays clickable either way — the server re-checks
  // everything anyway, so a stale/slow fetch here never blocks a request
  // that would otherwise succeed.
  const statusBox = $("#withdrawStatusBox");
  const amountLabel = $("#wAmountLabel");
  const amountInput = $("#wAmount");
  api("/api/withdraw?eligibility=1").then((elig) => {
    if (elig && !elig.error) {
      statusBox.innerHTML = renderWithdrawStatusLines(elig);
      if (typeof elig.minRequired === "number") {
        amountLabel.textContent = `Amount (USDT) — minimum $${elig.minRequired} (withdrawal #${elig.withdrawNumber})`;
        amountInput.placeholder = String(elig.minRequired);
      }
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
    if (!actionTokens["/api/withdraw"]) {
      try {
        await api("/api/withdraw?eligibility=1");
      } catch (e) {}
    }
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
      <div class="modal-header">
        <span class="modal-hdr-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#60a5fa" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
        Withdraw History
        <button class="modal-close" id="closeHistory">✕</button>
      </div>
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
  const initial = esc((userState.firstName || "U")[0].toUpperCase());
  overlay.innerHTML = `
    <div class="modal-sheet profile-sheet">
      <div class="modal-handle"></div>
      <div class="profile-header-center">
        <div class="profile-avatar-ring">
          <div class="profile-avatar">${initial}</div>
        </div>
        <div class="profile-name">${esc(userState.firstName || "User")}</div>
        <div class="profile-uid">@${esc(userState.username || "unknown")} · ID ${esc(userState.telegramId)}</div>
      </div>
      <div class="profile-card-grid">
        <div class="profile-row"><span>Total balance</span><span>${esc(formatRdcCompact(userState.balance))} RDC</span></div>
        <div class="profile-row"><span>Lifetime earned</span><span>${esc(userState.lifetimeEarned)} RDC</span></div>
        <div class="profile-row"><span>Referrals</span><span>${esc(userState.referralsCount)}</span></div>
        <div class="profile-row"><span>Tasks completed</span><span>${esc(userState.tasksCompleted)}</span></div>
      </div>
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
        <span class="modal-hdr-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.45 1-1 1H7v4h10v-4h-2c-.55 0-1-.45-1-1v-2.34c3.09-.76 5-3.5 5-6.66V4H6v4c0 3.16 1.91 5.9 5 6.66z"/></svg>
        </span>
        Top 20 Referrers
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
        <span class="modal-hdr-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ff3358" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
        </span>
        Weekly Referral Contest
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

// ---------- PROMO MODAL (IMAGE 2) ----------
function openPromoModal(initialCode = "") {
  const overlay = $("#promoModal");
  if (!overlay) return;

  const prefilled = typeof initialCode === "string" ? initialCode.trim().toUpperCase() : "";

  overlay.innerHTML = `
    <div class="promo-modal-dialog">
      <button class="promo-modal-close" id="closePromo" type="button" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>

      <div class="promo-modal-badge">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1c1300" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 12 20 22 4 22 4 12"/>
          <rect x="2" y="7" width="20" height="5" rx="1.5"/>
          <line x1="12" y1="22" x2="12" y2="7"/>
          <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
          <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
        </svg>
      </div>

      <div class="promo-modal-title">REDEEM PROMO CODE</div>
      <div class="promo-modal-desc">Enter secret code from official Telegram channel to get free Diamonds &amp; USDT!</div>

      <input class="promo-modal-input" id="promoInput" value="${esc(prefilled)}" placeholder="ENTER PROMO CODE..." autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" />

      <button class="promo-modal-btn" id="claimPromo" type="button">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z"/>
        </svg>
        <span>CLAIM REWARD NOW</span>
      </button>
    </div>
  `;

  overlay.classList.add("show", "promo-center-mode");

  const closeModal = () => {
    overlay.classList.remove("show", "promo-center-mode");
  };

  const closeBtn = $("#closePromo");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const inputEl = $("#promoInput");
  if (inputEl) {
    setTimeout(() => {
      inputEl.focus();
      if (prefilled) {
        try {
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        } catch (_) {}
      }
    }, 150);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#claimPromo")?.click();
      }
    });
  }

  const claimBtn = $("#claimPromo");
  if (claimBtn) {
    claimBtn.addEventListener("click", async () => {
      const code = inputEl ? inputEl.value.trim() : "";
      if (!code) {
        safeAlert("Please enter a promo code.");
        return;
      }

      if (!acquireAdLock("promo_ad")) {
        safeAlert("Another ad is already playing — please wait for it to finish.");
        return;
      }

      claimBtn.disabled = true;
      const originalHtml = claimBtn.innerHTML;
      claimBtn.innerHTML = `<span>Loading ad...</span>`;
      showAdLoadingOverlay();

      try {
        await showPromoAd();
      } catch (e) {
        console.error("Promo ad error:", e);
        hideAdLoadingOverlay();
        releaseAdLock();
        claimBtn.disabled = false;
        claimBtn.innerHTML = originalHtml;
        if (e && e.adSkippedEarly) {
          safeAlert(`Please watch at least ${MIN_AD_WATCH_MS / 1000} seconds of the ad to redeem your code.`);
        } else {
          safeAlert("Ad was not watched fully. Please watch the full ad to redeem your code.");
        }
        return;
      }

      releaseAdLock();
      hideAdLoadingOverlay();
      claimBtn.innerHTML = `<span>Redeeming...</span>`;

      try {
        const result = await api("/api/promo", { method: "POST", body: { code } });
        claimBtn.disabled = false;
        claimBtn.innerHTML = originalHtml;

        if (result && result.success) {
          safeAlert(`+${result.reward} RDC claimed!`);
          closeModal();
          await refreshUser();
          renderHome($("#mainContent"));
        } else {
          safeAlert(result?.error || "Error redeeming promo code");
        }
      } catch (err) {
        claimBtn.disabled = false;
        claimBtn.innerHTML = originalHtml;
        safeAlert("Network error. Please try again.");
      }
    });
  }
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
