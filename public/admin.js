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
}

// ---------- WITHDRAWS ----------
async function renderWithdraws(el) {
  const list = await api("/api/admin/withdraws");
  if (list.error) {
    el.innerHTML = `<div class="card">Failed to load withdraws.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <tr><th>User</th><th>Method</th><th>Address</th><th>Amount</th><th>Payout</th><th>USD</th><th>Status</th><th>Action</th></tr>
      ${list.map((w) => `
        <tr>
          <td>@${esc(w.username || "?")} (${esc(w.telegramId)})</td>
          <td>${esc(w.method)}</td>
          <td>${esc(w.address)}</td>
          <td>${esc(w.amount)} RDC</td>
          <td>${esc(w.payout)} RDC</td>
          <td>$${esc(w.usdValue)}</td>
          <td><span class="status ${esc(w.status)}">${esc(w.status)}</span></td>
          <td>
            ${w.status === "pending" ? `
              <button onclick="processWithdraw('${esc(w._id)}','approve')">Approve</button>
              <button class="danger" onclick="processWithdraw('${esc(w._id)}','reject')">Reject</button>
            ` : "-"}
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

async function searchUser() {
  const q = document.getElementById("userSearch").value.trim();
  if (!q) return;
  const user = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
  const box = document.getElementById("userResult");
  if (user.error) {
    box.innerHTML = `<div class="card">User not found</div>`;
    return;
  }
  box.innerHTML = `
    <div class="card">
      <p><b>${esc(user.firstName || "User")}</b> (@${esc(user.username || "none")}) — UID: ${esc(user.telegramId)}</p>
      <p>Balance: ${esc(user.balance)} RDC | Lifetime: ${esc(user.lifetimeEarned)} RDC | Referrals: ${esc(user.referralsCount || 0)}</p>
      <div class="row" style="margin-top:12px;">
        <input id="adjustAmount" type="number" placeholder="Amount (+ or -)" style="margin-bottom:0;" />
        <button onclick="adjustBalance(${Number(user.telegramId)})">Apply</button>
      </div>
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

// ---------- TASKS ----------
async function renderTasks(el) {
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
      <input id="taskField1" placeholder="Text field 1 label (optional)" />
      <input id="taskField2" placeholder="Text field 2 label (optional)" />
      <input id="taskShots" type="number" min="0" max="2" placeholder="Number of screenshot uploads (0-2)" />
      <button onclick="createTask()">Create Task</button>
    </div>
    <table>
      <tr><th>Title</th><th>Reward</th><th>Fields</th><th>Status</th><th>Action</th></tr>
      ${tasks.map((t) => `
        <tr>
          <td>${esc(t.title)}</td>
          <td>${esc(t.reward)} RDC</td>
          <td>${esc((t.textFields || []).length)} text, ${esc(t.screenshotCount || 0)} shots</td>
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
  const f1 = document.getElementById("taskField1").value.trim();
  const f2 = document.getElementById("taskField2").value.trim();
  const screenshotCount = Number(document.getElementById("taskShots").value) || 0;
  const textFields = [f1, f2].filter(Boolean);

  if (!title || !reward) return alert("Title and reward are required");

  const result = await api("/api/admin/tasks", { method: "POST", body: { title, description, reward, textFields, screenshotCount } });
  if (result.error) {
    alert(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"));
}

async function deleteTask(id) {
  if (!confirm("Delete this task?")) return;
  const result = await api("/api/admin/tasks", { method: "DELETE", body: { id } });
  if (result.error) {
    alert(result.error);
    return;
  }
  renderTasks(document.getElementById("tabContent"));
}

// ---------- SUBMISSIONS ----------
async function renderSubmissions(el) {
  const subs = await api("/api/admin/tasks?submissions=1&status=pending");
  if (subs.error) {
    el.innerHTML = `<div class="card">Failed to load submissions.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <tr><th>User</th><th>Task</th><th>Reward</th><th>Texts</th><th>Screenshots</th><th>Action</th></tr>
      ${subs.map((s) => `
        <tr>
          <td>${esc(s.telegramId)}</td>
          <td>${esc(s.taskTitle)}</td>
          <td>${esc(s.reward)} RDC</td>
          <td>${esc((s.texts || []).join(" | "))}</td>
          <td>${esc((s.screenshots || []).length)} file(s)</td>
          <td>
            <button onclick="processSubmission('${esc(s._id)}','approve')">Approve</button>
            <button class="danger" onclick="processSubmission('${esc(s._id)}','reject')">Reject</button>
          </td>
        </tr>
      `).join("") || `<tr><td colspan="6">No pending submissions</td></tr>`}
    </table>
  `;
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
