// public/admin.js
//
// ---------- AUTH ----------
// Access is no longer a password. When Telegram opens this page as a
// WebApp (via the "Open Admin Panel" button the bot sends to the admin's
// account only), Telegram itself hands the page a signed `initData` string
// through window.Telegram.WebApp.initData. That string is HMAC-signed
// server-side using the bot token, so it can't be forged from a browser or
// devtools — every admin API call sends it, and api/_telegram.js's
// checkAdmin() re-verifies the signature AND checks the signed Telegram
// user id matches the one admin account. Opening this URL any other way
// (plain browser, curl, devtools) simply has no valid initData to send, so
// every API call comes back 401 and the panel never renders.
const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
}
const TG_INIT_DATA = tg ? tg.initData : "";

// ---------- SECURITY: HTML escaping ----------
// Any value that came from a user (username, firstName, task text, address, etc.)
// must be escaped before being inserted via innerHTML — otherwise a malicious
// username/task submission could inject a <script>/onerror payload that runs
// in the admin's browser.
function esc(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// All 5 admin/*.js serverless functions (withdraws, users, multi-accounts,
// tasks, promo) were merged into ONE existing file — api/admin/withdraws.js
// (repurposed, not a new file) — dispatched by a `resource` query param,
// done to stay under Vercel Hobby's 12-function cap. This helper
// transparently rewrites the OLD-style paths this file calls everywhere
// ("/api/admin/<resource>...") into the new shape
// ("/api/admin/withdraws?resource=<resource>&...") — so none of the
// api() call sites below had to change, only this one spot.
function rewriteAdminPath(path) {
  const match = path.match(/^\/api\/admin\/([a-zA-Z0-9_-]+)(\?.*)?$/);
  if (!match) return path; // not an "/api/admin/<resource>" call — leave untouched
  const resource = match[1];
  const existingQs = match[2] ? match[2].slice(1) : ""; // drop leading "?"
  const qs = new URLSearchParams(existingQs);
  qs.set("resource", resource);
  return `/api/admin/withdraws?${qs.toString()}`;
}

async function api(path, opts = {}) {
  try {
    const res = await fetch(rewriteAdminPath(path), {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", "x-telegram-init-data": TG_INIT_DATA },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      showGate(
        "Access denied",
        "This Telegram account isn't authorized for the admin panel, or this page wasn't opened through the bot's Admin Panel button."
      );
      return { error: "Unauthorized" };
    }
    if (res.status === 429) {
      await alertAsync("Too many requests — please wait a moment and try again.");
      return { error: "rate limited" };
    }
    return await res.json();
  } catch (e) {
    console.error("API request failed:", e);
    await alertAsync("Network error — please try again.");
    return { error: "network error" };
  }
}

// ---------- FIX: Telegram-native confirm/alert ----------
// Plain browser confirm()/alert()/prompt() are unreliable inside Telegram's
// in-app WebView (many Telegram clients simply swallow them — the dialog
// never shows, confirm() resolves falsy instantly). That's exactly why every
// button in here that goes through confirm() first (Approve/Reject withdraw,
// delete task, etc.) appeared to do nothing when tapped: `if (!confirm(...))
// return;` was returning immediately with no visible error.
// Telegram's WebApp SDK provides real native replacements — showConfirm()
// and showAlert() (or showPopup() as a fallback on older clients) — that
// actually render inside Telegram. These wrap them in a Promise so every
// call site below can just `await confirmAsync(...)` / `await
// alertAsync(...)` exactly like it used to use confirm()/alert().
// Falls back to the real browser confirm()/alert() when tg isn't present
// (e.g. testing this page outside Telegram), so nothing breaks in dev.
function confirmAsync(message) {
  return new Promise((resolve) => {
    if (tg && typeof tg.showConfirm === "function") {
      tg.showConfirm(message, (ok) => resolve(!!ok));
    } else if (tg && typeof tg.showPopup === "function") {
      tg.showPopup(
        { message, buttons: [{ id: "cancel", type: "cancel" }, { id: "ok", type: "ok" }] },
        (buttonId) => resolve(buttonId === "ok")
      );
    } else {
      resolve(confirm(message));
    }
  });
}

function alertAsync(message) {
  return new Promise((resolve) => {
    if (tg && typeof tg.showAlert === "function") {
      tg.showAlert(message, () => resolve());
    } else if (tg && typeof tg.showPopup === "function") {
      tg.showPopup({ message, buttons: [{ type: "ok" }] }, () => resolve());
    } else {
      alert(message);
      resolve();
    }
  });
}

function showGate(title, text) {
  document.getElementById("panel").style.display = "none";
  const gate = document.getElementById("gateBox");
  document.getElementById("gateTitle").textContent = title;
  document.getElementById("gateText").textContent = text;
  gate.style.display = "block";
}

function boot() {
  if (!tg || !TG_INIT_DATA) {
    showGate(
      "Open this from Telegram",
      "This panel only works when opened from the REDTUBE bot's Admin Panel button in Telegram — it won't function in a regular browser tab."
    );
    return;
  }
  // Optimistically show the panel and load the default tab — if the
  // server rejects the request (401), api() itself hides the panel and
  // shows the access-denied gate, so nothing sensitive stays on screen.
  document.getElementById("gateBox").style.display = "none";
  document.getElementById("panel").style.display = "block";
  renderTab("withdraws");
}

boot();

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderTab(btn.dataset.tab);
  });
});

async function renderTab(tab) {
  const el = document.getElementById("tabContent");
  el.innerHTML = `<div class="card">Loading...</div>`;
  if (tab === "withdraws") return renderWithdraws(el);
  if (tab === "users") return renderUsers(el);
  if (tab === "allusers") return renderAllUsers(el);
  if (tab === "multiacc") return renderMultiAcc(el);
  if (tab === "tasks") return renderTasks(el);
  if (tab === "submissions") return renderSubmissions(el);
  if (tab === "promo") return renderPromo(el);
  if (tab === "refer") return renderRefer(el);
  if (tab === "ads") return renderAds(el);
}

// ---------- WITHDRAWS ----------
async function renderWithdraws(el) {
  const list = await api("/api/admin/withdraws");
  if (list.error) {
    el.innerHTML = `<div class="card">Failed to load withdraws.</div>`;
    return;
  }
  // Pending first, everything else (approved/rejected) after — Array.sort is
  // stable in all modern browsers, so the relative (date) order returned by
  // the API is preserved within each group.
  const sorted = [...list].sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    return aPending - bPending;
  });
  el.innerHTML = `
    <table>
      <tr><th>#</th><th>User</th><th>Method</th><th>Address</th><th>USD</th><th>Status</th><th>Action</th></tr>
      ${sorted.map((w, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>@${esc(w.username || "?")} (${esc(w.telegramId)})${
            w.referralSuspicious
              ? `<br><span style="color:#f59e0b;font-size:11px;">⚠️ ${esc(w.referralCrossPercent)}% of their referrals never joined the community/group (possible referral farming)</span>`
              : ""
          }</td>
          <td>${esc(w.method)}</td>
          <td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span class="wd-address-text" style="word-break:break-all;">${esc(w.address)}</span><button class="gray copy-btn" data-address="${esc(w.address)}" onclick="copyWithdrawAddress(this)" style="padding:3px 8px;font-size:11px;flex-shrink:0;">📋 Copy</button></div></td>
          <td>$${esc(w.usdValue)} (${Math.round(Number(w.amount) / RDC_TO_USD).toLocaleString()} RDC)</td>
          <td><span class="status ${esc(w.status)}">${esc(w.status)}</span></td>
          <td style="width:1%;white-space:nowrap;">
            ${
              w.status === "pending"
                ? `
              <div style="display:flex;gap:6px;flex-wrap:nowrap;">
                <button onclick="processWithdraw('${esc(w._id)}','approve')">Approve</button>
                <button class="danger" onclick="processWithdraw('${esc(w._id)}','reject')">Reject</button>
              </div>
            `
                : w.status === "rejected"
                ? `
              <div style="display:flex;gap:6px;flex-wrap:nowrap;">
                <button onclick="processWithdraw('${esc(w._id)}','approve')">Approve</button>
                <button class="danger" onclick="deleteWithdraw('${esc(w._id)}')">Delete</button>
              </div>
            `
                : "-"
            }
          </td>
        </tr>
      `).join("")}
    </table>
  `;
}

// Same 1 RDC = $0.00004 rate used server-side (api/withdraw.js's RDC_TO_USD)
// — display-only here, just to show the withdraw's USDT amount as its RDC
// equivalent next to the USD value. Doesn't affect any actual balance math.
const RDC_TO_USD = 0.00004;

// Copies a withdraw address to the clipboard and flips the button to a
// "Copied" state for a moment so the admin gets clear feedback, then
// reverts back to the copy icon/label.
function copyWithdrawAddress(btn) {
  const address = btn.getAttribute("data-address") || "";
  const original = btn.textContent;
  navigator.clipboard.writeText(address).then(() => {
    btn.textContent = "✅ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  }).catch(async (e) => {
    console.error("Copy failed:", e);
    await alertAsync("Couldn't copy automatically — please copy the address manually.");
  });
}

async function processWithdraw(id, action) {
  if (!await confirmAsync(`Are you sure you want to ${action} this withdraw? This cannot be undone.`)) return;
  const result = await api("/api/admin/withdraws", { method: "POST", body: { id, action } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderWithdraws(document.getElementById("tabContent"));
}

async function deleteWithdraw(id) {
  if (!await confirmAsync("Permanently delete this rejected withdraw record? This cannot be undone.")) return;
  const result = await api("/api/admin/withdraws", { method: "DELETE", body: { id } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderWithdraws(document.getElementById("tabContent"));
}

// ---------- USERS (search one) ----------
async function renderUsers(el) {
  el.innerHTML = `
    <div class="card">
      <div class="row">
        <input id="userSearch" placeholder="Search by UID or @username" style="margin-bottom:0;" />
        <button onclick="searchUser()">Search</button>
      </div>
    </div>
    <div id="userResult"></div>

    <div class="card" style="margin-top:16px;">
      <h3 style="margin-bottom:10px;">🔎 Refer Check</h3>
      <p style="color:var(--text-dim,#888);font-size:13px;margin-bottom:10px;">Enter a UID or @username to see who referred that person.</p>
      <div class="row">
        <input id="referCheckInput" placeholder="UID or @username" style="margin-bottom:0;" />
        <button onclick="checkReferrer()">Check</button>
      </div>
    </div>
    <div id="referCheckResult"></div>
  `;
}

async function checkReferrer() {
  const q = document.getElementById("referCheckInput").value.trim();
  if (!q) return;
  const resultBox = document.getElementById("referCheckResult");
  resultBox.innerHTML = `<div class="card">Checking...</div>`;

  const result = await api(`/api/admin/users?action=refer_check&q=${encodeURIComponent(q)}`);
  if (result.error) {
    resultBox.innerHTML = `<div class="card">User not found</div>`;
    return;
  }

  const userLine = `<b>${esc(result.firstName || "User")}</b> (@${esc(result.username || "none")}) — UID: ${esc(result.telegramId)}`;

  const referrerLine = result.referrer
    ? `Referred by: <b>${esc(result.referrer.firstName || "User")}</b> (@${esc(result.referrer.username || "none")}) — UID: ${esc(result.referrer.telegramId)}`
    : `<span style="color:var(--text-dim,#888);">No referrer — this user joined without a referral link.</span>`;

  resultBox.innerHTML = `
    <div class="card">
      <p>${userLine}</p>
      <p style="margin-top:8px;">${referrerLine}</p>
    </div>
  `;
}

// Tracks whether the referrals panel is currently open, and for which uid —
// so re-searching a different user doesn't accidentally reuse stale state.
let referralsPanelOpenFor = null;

async function searchUser() {
  const q = document.getElementById("userSearch").value.trim();
  if (!q) return;
  const user = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
  const box = document.getElementById("userResult");
  referralsPanelOpenFor = null; // reset — fresh search, panel starts closed
  if (user.error) {
    box.innerHTML = `<div class="card">User not found</div>`;
    return;
  }
 box.innerHTML = `
    <div class="card">
      <p><b>${esc(user.firstName || "User")}</b> (@${esc(user.username || "none")}) — UID: ${esc(user.telegramId)} <span style="color:#22c55e;">~ Valid Referrals: ${esc(user.validReferralsCount || 0)}</span> <span style="color:#d4a24e;">~ 🔑 Key Coins: ${esc(user.keyCoinBalance || 0)}</span></p>
      <p>Balance: ${esc(user.balance)} RDC ($${esc(Number(user.usdtBalance || 0).toFixed(4))} USDT) | Lifetime: ${esc(user.lifetimeEarned)} RDC | Referrals: ${esc(user.referralsCount || 0)}
        ${
          (user.referralsCount || 0) > 0
            ? ` — <a href="#" onclick="toggleReferralsList(${Number(user.telegramId)}); return false;" id="showReferralsLink">Show Referrals</a>`
            : ""
        }
      </p>
      <p>${
        (user.duplicateAccountCount || 0) > 0
          ? `<span style="color:#f59e0b;">⚠️ ${esc(user.duplicateAccountCount)} duplicate account(s)</span> (same IP)`
          : `<span style="color:#22c55e;">No duplicate accounts detected</span>`
      } | Total RDC Converted (fee soho): ${esc(user.totalWithdrawnRDC || 0)} RDC</p>
      <p>Withdrawals taken so far: ${esc(user.withdrawalsCount || 0)} (Total paid out: $${esc(Number(user.totalWithdrawnUSDT || 0).toFixed(4))} USDT)</p>
      <div class="row" style="margin-top:12px;">
        <input id="adjustAmount" type="number" placeholder="Amount (+ or -)" style="margin-bottom:0;" />
        <button onclick="adjustBalance(${Number(user.telegramId)})">Apply</button>
      </div>
      <div class="row" style="margin-top:8px;">
        <input id="giftAmount" type="number" min="1" placeholder="Gift amount (RDC)" style="margin-bottom:0;" />
        <button style="background:#dc2626;" onclick="sendGift(${Number(user.telegramId)})">🎁 Gift</button>
      </div>
    </div>
    <div id="referralsListBox"></div>
  `;
}

async function toggleReferralsList(uid) {
  const listBox = document.getElementById("referralsListBox");
  const link = document.getElementById("showReferralsLink");
  if (!listBox) return;

  // Already open for this same uid — collapse it
  if (referralsPanelOpenFor === uid) {
    listBox.innerHTML = "";
    referralsPanelOpenFor = null;
    if (link) link.textContent = "Show Referrals";
    return;
  }

  if (link) link.textContent = "Loading...";
  const referred = await api(`/api/admin/users?referredBy=${uid}`);
  if (referred.error) {
    listBox.innerHTML = `<div class="card">Failed to load referrals.</div>`;
    if (link) link.textContent = "Show Referrals";
    return;
  }

  referralsPanelOpenFor = uid;
  if (link) link.textContent = "Hide Referrals";

  listBox.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Referred by this user (${esc(referred.length)})</h3>
      <table>
        <tr><th>UID</th><th>Username</th><th>Joined?</th><th>Tasks Done</th><th>Ads Watched</th><th>Since</th></tr>
        ${referred.map((r) => `
          <tr>
            <td>${esc(r.telegramId)}</td>
            <td>@${esc(r.username || "none")}</td>
            <td>${r.joined ? "✅" : "❌"}</td>
            <td>${esc(r.tasksCompleted)}</td>
            <td>${esc(r.adsWatchedTotal)}</td>
            <td>${r.createdAt ? esc(new Date(r.createdAt).toLocaleDateString()) : "-"}</td>
          </tr>
        `).join("") || `<tr><td colspan="6">No referrals found</td></tr>`}
      </table>
    </div>
  `;
}

async function adjustBalance(uid) {
  const amount = Number(document.getElementById("adjustAmount").value);
  if (!amount) return;
  if (!await confirmAsync(`Apply ${amount > 0 ? "+" : ""}${amount} RDC to this user's balance?`)) return;
  const result = await api("/api/admin/users", { method: "POST", body: { uid, amount } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  await alertAsync("Balance updated");
  searchUser();
}

async function sendGift(uid) {
  const input = document.getElementById("giftAmount");
  const amount = Number(input.value);
  if (!amount || amount <= 0) {
    await alertAsync("Enter a valid gift amount (RDC)");
    return;
  }
  if (!await confirmAsync(`Send a claimable gift of ${amount} RDC to this user?`)) return;
  const result = await api("/api/admin/users", {
    method: "POST",
    body: { action: "send_gift", uid, amount },
  });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  input.value = "";
  await alertAsync("🎁 Gift queued — the user will see it the next time they open the bot.");
}

// ---------- WAL (Withdraw Address Lock attempts) ----------
// Shows live, most-recent-first: every time someone's withdraw got rejected
// because their account is locked to a different address, or because the
// address they tried is already locked to a different account. See
// api/withdraw.js (where these get logged) and api/admin/users.js's
// ?action=wal handler (where they're read back).
const WAL_REASON_LABELS = {
  account_locked_to_different_address: "Account already locked to a different address",
  address_locked_to_different_account: "Address already locked to a different account",
};

async function renderAllUsers(el) {
  const list = await api("/api/admin/users?action=wal");
  if (list.error) {
    el.innerHTML = `<div class="card">Failed to load WAL attempts.</div>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<div class="card">No withdraw-address-lock attempts yet. This list fills up whenever someone tries to withdraw to an address that conflicts with the permanent 1-account-1-address lock.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">Showing the latest ${esc(list.length)} lock attempts (most recent first)</div>
    <table>
      <tr><th>UID</th><th>Username</th><th>Tried</th><th>Reason</th><th>Conflicts with</th><th>When</th><th>Action</th></tr>
      ${list.map((a) => `
        <tr>
          <td>${esc(a.telegramId)}</td>
          <td>@${esc(a.username || "none")}</td>
          <td>${esc(a.attemptedMethod)}<br><span style="word-break:break-all;color:#8b94a7;font-size:11px;">${esc(a.attemptedAddress)}</span></td>
          <td>${esc(WAL_REASON_LABELS[a.reason] || a.reason)}</td>
          <td>${
            a.reason === "account_locked_to_different_address"
              ? `${esc(a.lockedMethod)}<br><span style="word-break:break-all;color:#8b94a7;font-size:11px;">${esc(a.lockedAddress)}</span>`
              : a.lockedToUserId
              ? `UID ${esc(a.lockedToUserId)}`
              : "-"
          }</td>
          <td>${a.createdAt ? esc(new Date(a.createdAt).toLocaleString()) : "-"}</td>
          <td>${
            a.resolvedAt
              ? `<span style="color:#4ade80;font-size:11px;">✅ Changed<br>${esc(new Date(a.resolvedAt).toLocaleString())}</span>`
              : a.reason === "account_locked_to_different_address"
              ? `<button
                   class="wal-override-btn"
                   data-telegram-id="${esc(a.telegramId)}"
                   data-address="${esc(a.attemptedAddress)}"
                   data-method="${esc(a.attemptedMethod)}"
                   data-wal-id="${esc(a._id)}"
                   onclick="overrideWalletLock(this)"
                   style="font-size:11px;padding:6px 10px;"
                 >Change wallet to this</button>`
              : "-"
          }</td>
        </tr>
      `).join("")}
    </table>
  `;
}

// Only offered for "account_locked_to_different_address" rows — this is
// specifically for a user's OWN mistaken first address (see the comment on
// the backend action in api/admin/users.js). Reads the target address/
// method off the button's own data-* attributes (rather than interpolating
// them into the onclick string) so an address containing a quote or
// backslash can never break the button.
async function overrideWalletLock(btn) {
  const telegramId = btn.dataset.telegramId;
  const newAddress = btn.dataset.address;
  const newMethod = btn.dataset.method;
  const walLogId = btn.dataset.walId;
  if (
    !await confirmAsync(
      `Re-lock UID ${telegramId}'s withdrawals to this address instead?\n\n${newMethod}: ${newAddress}\n\nTheir current locked address will be discarded — this only fixes their OWN mistaken wallet and can't be used to take over someone else's.`
    )
  ) {
    return;
  }
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Changing...";
  const result = await api("/api/admin/users", {
    method: "POST",
    body: { action: "override_wallet_lock", telegramId, newAddress, newMethod, walLogId },
  });
  if (result.error) {
    await alertAsync(result.error);
    btn.disabled = false;
    btn.textContent = originalLabel;
    return;
  }
  await alertAsync("Done — they're now locked to this address and can withdraw to it normally.");
  renderAllUsers(document.getElementById("tabContent"));
}

// ---------- MULTI-ACCOUNT FLAGS ----------
async function renderMultiAcc(el) {
  const groups = await api("/api/admin/multi-accounts");
  if (groups.error) {
    el.innerHTML = `<div class="card">Failed to load multi-account data.</div>`;
    return;
  }
  if (!groups.length) {
    el.innerHTML = `<div class="card">No suspicious multi-accounts detected yet. This checks users who opened the app from the same IP/device.</div>`;
    return;
  }
  el.innerHTML = groups.map((g) => `
    <div class="card">
      <p><b>⚠️ ${esc(g.accountCount)} accounts</b> shared the same IP: <code>${esc(g.ip)}</code></p>
      <table style="margin-top:10px;">
        <tr><th>UID</th><th>Username</th><th>Referrals</th><th>Referred By</th></tr>
        ${g.accounts.map((a) => `
          <tr>
            <td>${esc(a.telegramId)}</td>
            <td>@${esc(a.username || "none")}</td>
            <td>${esc(a.referralsCount || 0)}</td>
            <td>${esc(a.referredBy || "-")}</td>
          </tr>
        `).join("")}
      </table>
    </div>
  `).join("");
}

// ---------- TASKS (Task / Special Task toggle) ----------
// The two button labels below ("Task" / "Special Task") are unchanged.
// What flipped is which form each one opens: the "Task" tab (default)
// now opens the special/channel-join task form, and the "Special Task"
// tab now opens the regular task form — mirroring the same swap made on
// the user-facing side in app.js. No tasks or submissions were touched.
let taskSubTab = "task";

async function renderTasks(el, sub) {
  if (sub) taskSubTab = sub;
  el.innerHTML = `
    <div class="row" style="margin-bottom:16px;">
      <button class="${taskSubTab === "task" ? "" : "gray"}" onclick="renderTasks(document.getElementById('tabContent'), 'task')">Task</button>
      <button class="${taskSubTab === "special" ? "" : "gray"}" onclick="renderTasks(document.getElementById('tabContent'), 'special')">Special Task</button>
    </div>
    <div id="taskFormArea"></div>
  `;
  const area = document.getElementById("taskFormArea");
  if (taskSubTab === "special") return renderRegularTaskForm(area);
  return renderSpecialTaskForm(area);
}

// ---------- Regular Tasks ----------
// Form now has a "Link (optional)" field (shown above the text field labels,
// rendered on the user side next to the task title with a 🔗 icon), and a
// "Code (optional)" field replacing the old screenshot-count field — if set,
// a submission that matches this code exactly gets auto-approved instead of
// sitting in the pending queue.
async function renderRegularTaskForm(el) {
  const tasks = await api("/api/admin/tasks");
  if (tasks.error) {
    el.innerHTML = `<div class="card">Failed to load tasks.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Add New Task</h3>
      <input id="taskTitle" placeholder="Task title" />
      <textarea id="taskDesc" placeholder="Description (optional)" rows="2"></textarea>
      <input id="taskReward" type="number" placeholder="Reward (RDC)" />
      <input id="taskLink" placeholder="Link (optional) — shown next to the title with a 🔗 icon" />
      <input id="taskField1" placeholder="Text field 1 label (optional)" />
      <input id="taskField2" placeholder="Text field 2 label (optional)" />
      <input id="taskCode" placeholder="Auto-approve code (optional) — exact match auto-approves the submission" />
      <button onclick="createTask()">Create Task</button>
    </div>
    <table>
      <tr><th>Title</th><th>Reward</th><th>Fields</th><th>Link</th><th>Code</th><th>Status</th><th>Action</th></tr>
      ${tasks.map((t) => `
        <tr>
          <td>${esc(t.title)}</td>
          <td>${esc(t.reward)} RDC</td>
          <td>${esc((t.textFields || []).length)} text</td>
          <td>${t.link ? `<span title="${esc(t.link)}">🔗 yes</span>` : "-"}</td>
          <td>${t.code ? `<code>${esc(t.code)}</code>` : "-"}</td>
          <td>${t.active ? "Active" : "Inactive"}</td>
          <td><button class="danger" onclick="deleteTask('${esc(t._id)}')">Delete</button></td>
        </tr>
      `).join("")}
    </table>
  `;
}

async function createTask() {
  const title = document.getElementById("taskTitle").value.trim();
  const description = document.getElementById("taskDesc").value.trim();
  const reward = Number(document.getElementById("taskReward").value);
  const link = document.getElementById("taskLink").value.trim();
  const f1 = document.getElementById("taskField1").value.trim();
  const f2 = document.getElementById("taskField2").value.trim();
  const code = document.getElementById("taskCode").value.trim();
  const textFields = [f1, f2].filter(Boolean);

  if (!title || !reward) return await alertAsync("Title and reward are required");

  const result = await api("/api/admin/tasks", { method: "POST", body: { title, description, reward, link, textFields, code } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "special");
}

async function deleteTask(id) {
  if (!await confirmAsync("Delete this task?")) return;
  const result = await api("/api/admin/tasks", { method: "DELETE", body: { id } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "special");
}

// ---------- Special Tasks (channel/group join — Verified or Normal) ----------
async function renderSpecialTaskForm(el) {
  const tasks = await api("/api/admin/tasks?special=1");
  if (tasks.error) {
    el.innerHTML = `<div class="card">Failed to load special tasks.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Add New Special Task</h3>
      <input id="specTitle" placeholder="Task title" />
      <textarea id="specDesc" placeholder="Description (optional)" rows="2"></textarea>
      <input id="specReward" type="number" placeholder="Reward (RDC)" />
      <input id="specLink" placeholder="Channel/Group link (e.g. https://t.me/yourchannel)" />
      <select id="specVerifyType" onchange="toggleSpecialChatId()" style="width:100%;padding:10px;border-radius:8px;border:1px solid #1f2937;background:#0a0e17;color:#e5e9f0;margin-bottom:10px;font-size:14px;">
        <option value="normal">Normal (no membership check)</option>
        <option value="verified">Verified (checks membership)</option>
      </select>
      <input id="specChatId" placeholder="Chat ID (e.g. @channelusername or -100...) — required for Verified" style="display:none;" />
      <button onclick="createSpecialTask()">Create Special Task</button>
    </div>
    <table>
      <tr><th>Title</th><th>Reward</th><th>Type</th><th>Link</th><th>Status</th><th>Action</th></tr>
      ${tasks.map((t) => `
        <tr>
          <td>${esc(t.title)}</td>
          <td>${esc(t.reward)} RDC</td>
          <td>${t.verificationType === "verified" ? "✓ Verified" : "Normal"}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.link)}</td>
          <td>${t.active ? "Active" : "Inactive"}</td>
          <td><button class="danger" onclick="deleteSpecialTask('${esc(t._id)}')">Delete</button></td>
        </tr>
      `).join("")}
    </table>
  `;
  // restore select state if a value was chosen before this re-render
  toggleSpecialChatId();
}

function toggleSpecialChatId() {
  const typeEl = document.getElementById("specVerifyType");
  const chatEl = document.getElementById("specChatId");
  if (!typeEl || !chatEl) return;
  chatEl.style.display = typeEl.value === "verified" ? "block" : "none";
}

async function createSpecialTask() {
  const title = document.getElementById("specTitle").value.trim();
  const description = document.getElementById("specDesc").value.trim();
  const reward = Number(document.getElementById("specReward").value);
  const link = document.getElementById("specLink").value.trim();
  const verificationType = document.getElementById("specVerifyType").value;
  const chatId = document.getElementById("specChatId").value.trim();

  if (!title || !reward || !link) return await alertAsync("Title, reward and link are required");
  if (verificationType === "verified" && !chatId) return await alertAsync("Chat ID is required for Verified tasks (e.g. @channelusername or -100...)");

  const result = await api("/api/admin/tasks", {
    method: "POST",
    body: { taskType: "special", title, description, reward, link, verificationType, chatId },
  });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "task");
}

async function deleteSpecialTask(id) {
  if (!await confirmAsync("Delete this special task?")) return;
  const result = await api("/api/admin/tasks", { method: "DELETE", body: { id, taskType: "special" } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "task");
}

// ---------- SUBMISSIONS (regular task submissions — pending ones, rejected
// ones, AND auto-approved ones (matched via the task's code) are shown here.
// Special tasks auto-claim directly against the user's balance and never
// create a submission row, so they never appear here at all.
// Auto-approved rows show a permanent "Approved" status with no buttons —
// they're already settled, this is just visibility into who got them.
// Rejected rows get an "Approve" button (undo an accidental reject) and a
// "Delete" button (permanently wipe the row) instead of Approve/Reject. ----------
let lastSubmissionsData = [];

async function renderSubmissions(el) {
  // No status filter — pulls pending + approved + rejected together so
  // rejected rows are visible (and re-approvable/deletable) here too.
  const subs = await api("/api/admin/tasks?submissions=1");
  if (subs.error) {
    el.innerHTML = `<div class="card">Failed to load submissions.</div>`;
    return;
  }
  // Bulk Approve/Reject All should only ever touch submissions still awaiting
  // manual review — auto-approved and rejected rows are already settled and
  // must never be swept up by the bulk buttons.
  lastSubmissionsData = subs.filter((s) => s.status === "pending");
  el.innerHTML = `
    <div class="card">
      <input id="subSearch" placeholder="Search by UID, task title, or submitted text" oninput="highlightSubmissionMatches()" />
      <div class="row">
        <button onclick="bulkProcessSubmissions('approve')">Approve All</button>
        <button class="danger" onclick="bulkProcessSubmissions('reject')">Reject All</button>
      </div>
    </div>
    <table id="submissionsTable">
      <tr><th>User</th><th>Task</th><th>Reward</th><th>Texts</th><th>Screenshots</th><th>Status</th><th>Action</th></tr>
      ${subs.map((s) => `
        <tr data-search="${esc((String(s.telegramId) + " " + (s.taskTitle || "") + " " + (s.texts || []).join(" ")).toLowerCase())}">
          <td>${esc(s.telegramId)}</td>
          <td>${esc(s.taskTitle)}</td>
          <td>${esc(s.reward)} RDC</td>
          <td>${esc((s.texts || []).join(" | "))}</td>
          <td>${esc((s.screenshots || []).length)} file(s)</td>
          <td>${
            s.status === "approved"
              ? `<span class="status approved">Approved${s.autoApproved ? " (auto)" : ""}</span>`
              : s.status === "rejected"
              ? `<span class="status rejected">Rejected</span>`
              : `<span class="status pending">pending</span>`
          }</td>
          <td>
            ${
              s.status === "approved"
                ? "-"
                : s.status === "rejected"
                ? `
              <button onclick="processSubmission('${esc(s._id)}','approve')">Approve</button>
              <button class="danger" onclick="deleteSubmission('${esc(s._id)}')">Delete</button>
            `
                : `
              <button onclick="processSubmission('${esc(s._id)}','approve')">Approve</button>
              <button class="danger" onclick="processSubmission('${esc(s._id)}','reject')">Reject</button>
            `
            }
          </td>
        </tr>
      `).join("") || `<tr><td colspan="7">No submissions</td></tr>`}
    </table>
  `;
}

// Highlights matching rows instead of filtering — every submission stays
// visible, the search just points out where the match is.
function highlightSubmissionMatches() {
  const input = document.getElementById("subSearch");
  const q = input ? input.value.trim().toLowerCase() : "";
  const rows = document.querySelectorAll("#submissionsTable tr[data-search]");
  let firstMatch = null;
  rows.forEach((row) => {
    const matches = q.length > 0 && row.dataset.search.includes(q);
    row.style.background = matches ? "rgba(59,130,246,0.18)" : "";
    if (matches && !firstMatch) firstMatch = row;
  });
  if (firstMatch) firstMatch.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function bulkProcessSubmissions(action) {
  if (!lastSubmissionsData.length) return await alertAsync("No pending submissions.");
  if (!await confirmAsync(`${action === "approve" ? "Approve" : "Reject"} ALL ${lastSubmissionsData.length} pending submissions? This cannot be undone.`)) return;

  for (const s of lastSubmissionsData) {
    const result = await api("/api/admin/tasks", { method: "POST", body: { submissionId: s._id, action } });
    if (result.error) {
      await alertAsync(`Stopped early — failed on submission ${s._id}: ${result.error}`);
      break;
    }
    // small delay between requests to stay well under the admin API's rate limit
    await new Promise((r) => setTimeout(r, 350));
  }
  renderSubmissions(document.getElementById("tabContent"));
}

async function processSubmission(id, action) {
  if (!await confirmAsync(`Are you sure you want to ${action} this submission?`)) return;
  const result = await api("/api/admin/tasks", { method: "POST", body: { submissionId: id, action } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderSubmissions(document.getElementById("tabContent"));
}

// Permanently removes a rejected submission row. Only rejected rows can be
// deleted this way (enforced server-side too) — approve it first if it
// should actually be paid out instead.
async function deleteSubmission(id) {
  if (!await confirmAsync("Permanently delete this rejected submission? This cannot be undone.")) return;
  const result = await api("/api/admin/tasks", { method: "DELETE", body: { submissionId: id } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  renderSubmissions(document.getElementById("tabContent"));
}

// ---------- PROMO ----------
async function renderPromo(el) {
  const promos = await api("/api/admin/promo");
  if (promos.error) {
    el.innerHTML = `<div class="card">Failed to load promo codes.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Create Promo Code</h3>
      <input id="promoCode" placeholder="Code (e.g. REDTUBE50)" />
      <input id="promoReward" type="number" placeholder="Reward (RDC)" />
      <input id="promoLimit" type="number" placeholder="Claim limit (max users)" />
      <button onclick="createPromo()">Create</button>
    </div>
    <table>
      <tr><th>Code</th><th>Reward</th><th>Used / Limit</th><th>Action</th></tr>
      ${promos.map((p) => `
        <tr>
          <td>${esc(p.code)}</td><td>${esc(p.reward)} RDC</td><td>${esc(p.usedCount)}/${esc(p.limit)}</td>
          <td><button onclick="viewClaimants('${esc(p.code)}')">View claimants</button></td>
        </tr>
      `).join("")}
    </table>
    <div id="claimantsBox"></div>
  `;
}

async function viewClaimants(code) {
  const box = document.getElementById("claimantsBox");
  const list = await api(`/api/admin/promo?code=${encodeURIComponent(code)}`);
  if (list.error) {
    box.innerHTML = `<div class="card">Failed to load claimants.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Claimed "${esc(code)}" by</h3>
      <table>
        <tr><th>UID</th><th>Username</th><th>Claimed At</th></tr>
        ${list.map((c) => `
          <tr>
            <td>${esc(c.telegramId)}</td>
            <td>@${esc(c.username || "none")}</td>
            <td>${esc(new Date(c.claimedAt).toLocaleString())}</td>
          </tr>
        `).join("") || `<tr><td colspan="3">No claims yet</td></tr>`}
      </table>
    </div>
  `;
}

async function createPromo() {
  const code = document.getElementById("promoCode").value.trim();
  const reward = Number(document.getElementById("promoReward").value);
  const limit = Number(document.getElementById("promoLimit").value);
  if (!code || !reward || !limit) return await alertAsync("All fields required");
  const result = await api("/api/admin/promo", { method: "POST", body: { code, reward, limit } });
  if (result.error) return await alertAsync(result.error);
  renderPromo(document.getElementById("tabContent"));
}

// ---------- REFER (All Refer Users / Refer Contest) ----------
let referSubTab = "all";

async function renderRefer(el, sub) {
  if (sub) referSubTab = sub;
  el.innerHTML = `
    <div class="row" style="margin-bottom:16px;">
      <button class="${referSubTab === "all" ? "" : "gray"}" onclick="renderRefer(document.getElementById('tabContent'), 'all')">All Refer Users</button>
      <button class="${referSubTab === "contest" ? "" : "gray"}" onclick="renderRefer(document.getElementById('tabContent'), 'contest')">Refer Contest</button>
    </div>
    <div id="referArea"></div>
  `;
  const area = document.getElementById("referArea");
  if (referSubTab === "contest") return renderReferContest(area);
  return renderAllReferrers(area);
}

// "All Refer Users" — every user with ≥1 lifetime referral: uid + username + total count
async function renderAllReferrers(el) {
  const list = await api("/api/admin/users?action=all_referrers");
  if (list.error) {
    el.innerHTML = `<div class="card">Failed to load referrers.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">Showing all users with at least 1 referral (${esc(list.length)})</div>
    <table>
      <tr><th>UID</th><th>Username</th><th>Total Referrals</th></tr>
      ${list.map((u) => `
        <tr>
          <td>${esc(u.telegramId)}</td>
          <td>@${esc(u.username || "none")}</td>
          <td>${esc(u.referralsCount)}</td>
        </tr>
      `).join("") || `<tr><td colspan="3">No referrers yet</td></tr>`}
    </table>
  `;
}

// "Refer Contest" — this week's top 10: uid + username + weekly count, plus a reset button
async function renderReferContest(el) {
  const data = await api("/api/admin/users?action=weekly_top10");
  if (data.error) {
    el.innerHTML = `<div class="card">Failed to load weekly contest.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <p>Contest started: ${data.contestStartedAt ? esc(new Date(data.contestStartedAt).toLocaleString()) : "-"}</p>
      <button class="danger" style="margin-top:10px;" onclick="resetWeeklyContest()">Reset Weekly Contest</button>
    </div>
    <table>
      <tr><th>Rank</th><th>UID</th><th>Username</th><th>Weekly Refs</th></tr>
      ${(data.top || []).map((r) => `
        <tr>
          <td>${esc(r.rank)}</td>
          <td>${esc(r.telegramId)}</td>
          <td>@${esc(r.username || "none")}</td>
          <td>${esc(r.weeklyRefs)}</td>
        </tr>
      `).join("") || `<tr><td colspan="4">No referrals this week yet</td></tr>`}
    </table>
  `;
}

async function resetWeeklyContest() {
  if (!await confirmAsync("Reset the weekly referral contest? This starts a brand-new window from now — past referrals aren't deleted, but they'll no longer count toward this week's totals.")) return;
  const result = await api("/api/admin/users", { method: "POST", body: { action: "reset_weekly_contest" } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  await alertAsync("Weekly contest reset!");
  renderReferContest(document.getElementById("referArea"));
}

// ---------- SET ADS ----------
const NETWORK_TYPE_LABELS = {
  monetag: "Monetag",
  adsgram_daily: "Adsgram Daily",
  adsgram: "Adsgram",
  adsgram_special: "Adsgram Special",
  usl_special: "USL SPECIAL",
  adsgalaxy: "AdsGalaxy",
  panda_daily: "Panda Daily 🐼",
};
const EARNING_SLOT_LABELS = {
  adsgram_daily: "Earning Slot 1",
  adsgram_special: "Earning Slot 2",
  monetag: "Earning Slot 3",
  usl_special: "Earning Slot 4",
};

function networkOptions(selected) {
  return Object.entries(NETWORK_TYPE_LABELS)
    .map(([id, label]) => `<option value="${id}" ${id === selected ? "selected" : ""}>${esc(label)}</option>`)
    .join("");
}

async function renderAds(el) {
  const data = await api("/api/admin/users?action=ads_config");
  if (data.error) {
    el.innerHTML = `<div class="card">Failed to load ads config.</div>`;
    return;
  }
  const cfg = data.config;
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">🎰 Spin Ads</h3>
      <p style="color:#8b94a7;font-size:12px;margin-bottom:12px;">Spin batches reset every 10 hours. Each spin in a batch alternates between the 2 networks below — which pair is active alternates every time the 10-hour batch resets.</p>

      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:12px;color:#8b94a7;margin-bottom:4px;">10 Hour Before Ads</label>
        <div class="row">
          <select id="spinBefore1">${networkOptions(cfg.spin.before[0])}</select>
          <select id="spinBefore2">${networkOptions(cfg.spin.before[1])}</select>
        </div>
      </div>

      <div>
        <label style="display:block;font-size:12px;color:#8b94a7;margin-bottom:4px;">10 Hour After Ads</label>
        <div class="row">
          <select id="spinAfter1">${networkOptions(cfg.spin.after[0])}</select>
          <select id="spinAfter2">${networkOptions(cfg.spin.after[1])}</select>
        </div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:10px;">📺 Earning Section Ads</h3>
      <p style="color:#8b94a7;font-size:12px;margin-bottom:12px;">Pick which ad network shows in each slot, and hide any slot you don't want visible right now (hidden slots don't reserve empty space — the rest move up to fill the gap).</p>
      ${Object.keys(EARNING_SLOT_LABELS).map((slotId) => `
        <div class="row" style="margin-bottom:10px;">
          <span style="width:110px;font-size:13px;color:#8b94a7;">${esc(EARNING_SLOT_LABELS[slotId])}</span>
          <select id="earn-network-${slotId}">${networkOptions(cfg.earning[slotId].network)}</select>
          <input type="number" id="earn-reward-${slotId}" value="${esc(cfg.earning[slotId].reward)}" min="0" step="any" title="Reward (RDC) per watch" style="width:70px;" />
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;">
            <input type="checkbox" id="earn-hidden-${slotId}" ${cfg.earning[slotId].hidden ? "checked" : ""} />
            Hidden
          </label>
        </div>
      `).join("")}
    </div>

    <div class="card">
      <h3 style="margin-bottom:10px;">🎁 Promo Redeem Ad</h3>
      <p style="color:#8b94a7;font-size:12px;margin-bottom:12px;">Ad network shown when a user taps "Redeem" on a promo code. Pick any connected network — change it any time, no redeploy needed.</p>
      <div>
        <label style="display:block;font-size:12px;color:#8b94a7;margin-bottom:4px;">Ad Network</label>
        <select id="promoAdNetwork">${networkOptions(cfg.promoAdNetwork)}</select>
      </div>
    </div>

    <button onclick="saveAdsConfig()">Save Ads Config</button>
  `;
}

async function saveAdsConfig() {
  const spin = {
    before: [document.getElementById("spinBefore1").value, document.getElementById("spinBefore2").value],
    after: [document.getElementById("spinAfter1").value, document.getElementById("spinAfter2").value],
  };
  const earning = {};
  Object.keys(EARNING_SLOT_LABELS).forEach((slotId) => {
    earning[slotId] = {
      network: document.getElementById(`earn-network-${slotId}`).value,
      hidden: document.getElementById(`earn-hidden-${slotId}`).checked,
      reward: Number(document.getElementById(`earn-reward-${slotId}`).value),
    };
  });
  for (const slotId of Object.keys(earning)) {
    if (!Number.isFinite(earning[slotId].reward) || earning[slotId].reward < 0) {
      await alertAsync(`Enter a valid (non-negative) reward for ${EARNING_SLOT_LABELS[slotId]}.`);
      return;
    }
  }
  const promoAdNetwork = document.getElementById("promoAdNetwork").value;
  const result = await api("/api/admin/users", { method: "POST", body: { action: "update_ads_config", spin, earning, promoAdNetwork } });
  if (result.error) {
    await alertAsync(result.error);
    return;
  }
  await alertAsync("Ads config saved!");
}
