// public/admin.js
let ADMIN_PW = localStorage.getItem("redtube_admin_pw") || "";

// ---------- SECURITY: HTML escaping ----------
// Any value that came from a user (username, firstName, task text, address, etc.)
// must be escaped before being inserted via innerHTML — otherwise a malicious
// username/task submission could inject a <script>/onerror payload that runs
// in the admin's browser and steals ADMIN_PW from localStorage.
function esc(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PW },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      // Password became invalid (changed/expired) — force re-login instead of
      // silently failing or showing confusing empty data
      localStorage.removeItem("redtube_admin_pw");
      alert("Session expired or invalid password. Please log in again.");
      location.reload();
      return { error: "Unauthorized" };
    }
    if (res.status === 429) {
      alert("Too many requests — please wait a moment and try again.");
      return { error: "rate limited" };
    }
    return await res.json();
  } catch (e) {
    console.error("API request failed:", e);
    alert("Network error — please try again.");
    return { error: "network error" };
  }
}

async function login() {
  const pwField = document.getElementById("pwInput");
  ADMIN_PW = pwField.value;
  const test = await api("/api/admin/withdraws");
  if (test.error === "Unauthorized" || test.error === "rate limited") {
    if (test.error === "Unauthorized") alert("Wrong password");
    return;
  }
  localStorage.setItem("redtube_admin_pw", ADMIN_PW);
  pwField.value = ""; // clear from the DOM immediately after use
  document.getElementById("loginBox").style.display = "none";
  document.getElementById("panel").style.display = "block";
  renderTab("withdraws");
}

if (ADMIN_PW) {
  document.getElementById("loginBox").style.display = "none";
  document.getElementById("panel").style.display = "block";
  renderTab("withdraws");
}

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
      <tr><th>#</th><th>User</th><th>Method</th><th>Address</th><th>Amount</th><th>Payout</th><th>USD</th><th>Status</th><th>Action</th></tr>
      ${sorted.map((w, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>@${esc(w.username || "?")} (${esc(w.telegramId)})</td>
          <td>${esc(w.method)}</td>
          <td>${esc(w.address)}</td>
          <td>${esc(w.amount)} RDC</td>
          <td>${esc(w.payout)} RDC</td>
          <td>$${esc(w.usdValue)}</td>
          <td><span class="status ${esc(w.status)}">${esc(w.status)}</span></td>
          <td>
            ${
              w.status === "pending"
                ? `
              <button onclick="processWithdraw('${esc(w._id)}','approve')">Approve</button>
              <button class="danger" onclick="processWithdraw('${esc(w._id)}','reject')">Reject</button>
            `
                : w.status === "rejected"
                ? `<button class="danger" onclick="deleteWithdraw('${esc(w._id)}')">Delete</button>`
                : "-"
            }
          </td>
        </tr>
      `).join("")}
    </table>
  `;
}

async function processWithdraw(id, action) {
  if (!confirm(`Are you sure you want to ${action} this withdraw? This cannot be undone.`)) return;
  const result = await api("/api/admin/withdraws", { method: "POST", body: { id, action } });
  if (result.error) {
    alert(result.error);
    return;
  }
  renderWithdraws(document.getElementById("tabContent"));
}

async function deleteWithdraw(id) {
  if (!confirm("Permanently delete this rejected withdraw record? This cannot be undone.")) return;
  const result = await api("/api/admin/withdraws", { method: "DELETE", body: { id } });
  if (result.error) {
    alert(result.error);
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
      <p><b>${esc(user.firstName || "User")}</b> (@${esc(user.username || "none")}) — UID: ${esc(user.telegramId)} <span style="color:#22c55e;">~ Valid Referrals: ${esc(user.validReferralsCount || 0)}</span></p>
      <p>Balance: ${esc(user.balance)} RDC | Lifetime: ${esc(user.lifetimeEarned)} RDC | Referrals: ${esc(user.referralsCount || 0)}
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
      } | Total Withdrawn: ${esc(user.totalWithdrawnRDC || 0)} RDC</p>
      <div class="row" style="margin-top:12px;">
        <input id="adjustAmount" type="number" placeholder="Amount (+ or -)" style="margin-bottom:0;" />
        <button onclick="adjustBalance(${Number(user.telegramId)})">Apply</button>
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
  if (!confirm(`Apply ${amount > 0 ? "+" : ""}${amount} RDC to this user's balance?`)) return;
  const result = await api("/api/admin/users", { method: "POST", body: { uid, amount } });
  if (result.error) {
    alert(result.error);
    return;
  }
  alert("Balance updated");
  searchUser();
}

// ---------- ALL USERS ----------
async function renderAllUsers(el) {
  const list = await api("/api/admin/all-users");
  if (list.error) {
    el.innerHTML = `<div class="card">Failed to load users.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">Showing latest ${esc(list.length)} users (most recent first)</div>
    <table>
      <tr><th>UID</th><th>Username</th><th>Balance</th><th>Lifetime</th><th>Referrals</th><th>Joined?</th><th>Since</th></tr>
      ${list.map((u) => `
        <tr>
          <td>${esc(u.telegramId)}</td>
          <td>@${esc(u.username || "none")}</td>
          <td>${esc(u.balance)} RDC</td>
          <td>${esc(u.lifetimeEarned)} RDC</td>
          <td>${esc(u.referralsCount || 0)}</td>
          <td>${u.joined ? "✅" : "❌"}</td>
          <td>${esc(new Date(u.createdAt).toLocaleDateString())}</td>
        </tr>
      `).join("") || `<tr><td colspan="7">No users yet</td></tr>`}
    </table>
  `;
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

  if (!title || !reward) return alert("Title and reward are required");

  const result = await api("/api/admin/tasks", { method: "POST", body: { title, description, reward, link, textFields, code } });
  if (result.error) {
    alert(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "special");
}

async function deleteTask(id) {
  if (!confirm("Delete this task?")) return;
  const result = await api("/api/admin/tasks", { method: "DELETE", body: { id } });
  if (result.error) {
    alert(result.error);
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

  if (!title || !reward || !link) return alert("Title, reward and link are required");
  if (verificationType === "verified" && !chatId) return alert("Chat ID is required for Verified tasks (e.g. @channelusername or -100...)");

  const result = await api("/api/admin/tasks", {
    method: "POST",
    body: { taskType: "special", title, description, reward, link, verificationType, chatId },
  });
  if (result.error) {
    alert(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "task");
}

async function deleteSpecialTask(id) {
  if (!confirm("Delete this special task?")) return;
  const result = await api("/api/admin/tasks", { method: "DELETE", body: { id, taskType: "special" } });
  if (result.error) {
    alert(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"), "task");
}

// ---------- SUBMISSIONS (regular task submissions — pending ones AND
// auto-approved ones (matched via the task's code) are shown here. Special
// tasks auto-claim directly against the user's balance and never create a
// submission row, so they never appear here at all.
// Auto-approved rows show a permanent "Approved" status with no buttons —
// they're already settled, this is just visibility into who got them. ----------
let lastSubmissionsData = [];

async function renderSubmissions(el) {
  const subs = await api("/api/admin/tasks?submissions=1&status=pending");
  if (subs.error) {
    el.innerHTML = `<div class="card">Failed to load submissions.</div>`;
    return;
  }
  // Bulk Approve/Reject All should only ever touch submissions still awaiting
  // manual review — auto-approved rows are already settled and must never be
  // re-processed.
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
              : `<span class="status pending">pending</span>`
          }</td>
          <td>
            ${
              s.status === "approved"
                ? "-"
                : `
              <button onclick="processSubmission('${esc(s._id)}','approve')">Approve</button>
              <button class="danger" onclick="processSubmission('${esc(s._id)}','reject')">Reject</button>
            `
            }
          </td>
        </tr>
      `).join("") || `<tr><td colspan="7">No pending submissions</td></tr>`}
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
  if (!lastSubmissionsData.length) return alert("No pending submissions.");
  if (!confirm(`${action === "approve" ? "Approve" : "Reject"} ALL ${lastSubmissionsData.length} pending submissions? This cannot be undone.`)) return;

  for (const s of lastSubmissionsData) {
    const result = await api("/api/admin/tasks", { method: "POST", body: { submissionId: s._id, action } });
    if (result.error) {
      alert(`Stopped early — failed on submission ${s._id}: ${result.error}`);
      break;
    }
    // small delay between requests to stay well under the admin API's rate limit
    await new Promise((r) => setTimeout(r, 350));
  }
  renderSubmissions(document.getElementById("tabContent"));
}

async function processSubmission(id, action) {
  if (!confirm(`Are you sure you want to ${action} this submission?`)) return;
  const result = await api("/api/admin/tasks", { method: "POST", body: { submissionId: id, action } });
  if (result.error) {
    alert(result.error);
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
  if (!code || !reward || !limit) return alert("All fields required");
  const result = await api("/api/admin/promo", { method: "POST", body: { code, reward, limit } });
  if (result.error) return alert(result.error);
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
  if (!confirm("Reset the weekly referral contest? This starts a brand-new window from now — past referrals aren't deleted, but they'll no longer count toward this week's totals.")) return;
  const result = await api("/api/admin/users", { method: "POST", body: { action: "reset_weekly_contest" } });
  if (result.error) {
    alert(result.error);
    return;
  }
  alert("Weekly contest reset!");
  renderReferContest(document.getElementById("referArea"));
}
