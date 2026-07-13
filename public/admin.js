// public/admin.js
let ADMIN_PW = localStorage.getItem("redtube_admin_pw") || "";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PW },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

async function login() {
  ADMIN_PW = document.getElementById("pwInput").value;
  const test = await api("/api/admin/withdraws");
  if (test.error === "Unauthorized") {
    alert("Wrong password");
    return;
  }
  localStorage.setItem("redtube_admin_pw", ADMIN_PW);
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
  if (tab === "withdraws") return renderWithdraws(el);
  if (tab === "users") return renderUsers(el);
  if (tab === "multiacc") return renderMultiAcc(el);
  if (tab === "tasks") return renderTasks(el);
  if (tab === "submissions") return renderSubmissions(el);
  if (tab === "promo") return renderPromo(el);
}

// ---------- WITHDRAWS ----------
async function renderWithdraws(el) {
  const list = await api("/api/admin/withdraws");
  el.innerHTML = `
    <table>
      <tr><th>User</th><th>Method</th><th>Address</th><th>Amount</th><th>Payout</th><th>USD</th><th>Status</th><th>Action</th></tr>
      ${list.map((w) => `
        <tr>
          <td>@${w.username || "?"} (${w.telegramId})</td>
          <td>${w.method}</td>
          <td>${w.address}</td>
          <td>${w.amount} WTC</td>
          <td>${w.payout} WTC</td>
          <td>$${w.usdValue}</td>
          <td><span class="status ${w.status}">${w.status}</span></td>
          <td>
            ${w.status === "pending" ? `
              <button onclick="processWithdraw('${w._id}','approve')">Approve</button>
              <button class="danger" onclick="processWithdraw('${w._id}','reject')">Reject</button>
            ` : "-"}
          </td>
        </tr>
      `).join("")}
    </table>
  `;
}

async function processWithdraw(id, action) {
  await api("/api/admin/withdraws", { method: "POST", body: { id, action } });
  renderWithdraws(document.getElementById("tabContent"));
}

// ---------- USERS ----------
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
      <p><b>${user.firstName || "User"}</b> (@${user.username || "none"}) — UID: ${user.telegramId}</p>
      <p>Balance: ${user.balance} WTC | Lifetime: ${user.lifetimeEarned} WTC | Referrals: ${user.referralsCount || 0}</p>
      <div class="row" style="margin-top:12px;">
        <input id="adjustAmount" type="number" placeholder="Amount (+ or -)" style="margin-bottom:0;" />
        <button onclick="adjustBalance(${user.telegramId})">Apply</button>
      </div>
    </div>
  `;
}

async function adjustBalance(uid) {
  const amount = Number(document.getElementById("adjustAmount").value);
  if (!amount) return;
  await api("/api/admin/users", { method: "POST", body: { uid, amount } });
  alert("Balance updated");
  searchUser();
}

// ---------- MULTI-ACCOUNT FLAGS ----------
async function renderMultiAcc(el) {
  const groups = await api("/api/admin/multi-accounts");
  if (!groups.length) {
    el.innerHTML = `<div class="card">No suspicious multi-accounts detected yet. This checks users who opened the app from the same IP/device.</div>`;
    return;
  }
  el.innerHTML = groups.map((g) => `
    <div class="card">
      <p><b>⚠️ ${g.accountCount} accounts</b> shared the same IP: <code>${g.ip}</code></p>
      <table style="margin-top:10px;">
        <tr><th>UID</th><th>Username</th><th>Referrals</th><th>Referred By</th></tr>
        ${g.accounts.map((a) => `
          <tr>
            <td>${a.telegramId}</td>
            <td>@${a.username || "none"}</td>
            <td>${a.referralsCount || 0}</td>
            <td>${a.referredBy || "-"}</td>
          </tr>
        `).join("")}
      </table>
    </div>
  `).join("");
}

// ---------- TASKS ----------
async function renderTasks(el) {
  const tasks = await api("/api/admin/tasks");
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Add New Task</h3>
      <input id="taskTitle" placeholder="Task title" />
      <textarea id="taskDesc" placeholder="Description (optional)" rows="2"></textarea>
      <input id="taskReward" type="number" placeholder="Reward (WTC)" />
      <input id="taskField1" placeholder="Text field 1 label (optional)" />
      <input id="taskField2" placeholder="Text field 2 label (optional)" />
      <input id="taskShots" type="number" min="0" max="2" placeholder="Number of screenshot uploads (0-2)" />
      <button onclick="createTask()">Create Task</button>
    </div>
    <table>
      <tr><th>Title</th><th>Reward</th><th>Fields</th><th>Status</th><th>Action</th></tr>
      ${tasks.map((t) => `
        <tr>
          <td>${t.title}</td>
          <td>${t.reward} WTC</td>
          <td>${(t.textFields || []).length} text, ${t.screenshotCount || 0} shots</td>
          <td>${t.active ? "Active" : "Inactive"}</td>
          <td><button class="danger" onclick="deleteTask('${t._id}')">Delete</button></td>
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

  await api("/api/admin/tasks", { method: "POST", body: { title, description, reward, textFields, screenshotCount } });
  renderTasks(document.getElementById("tabContent"));
}

async function deleteTask(id) {
  if (!confirm("Delete this task?")) return;
  await api("/api/admin/tasks", { method: "DELETE", body: { id } });
  renderTasks(document.getElementById("tabContent"));
}

// ---------- SUBMISSIONS ----------
async function renderSubmissions(el) {
  const subs = await api("/api/admin/tasks?submissions=1&status=pending");
  el.innerHTML = `
    <table>
      <tr><th>User</th><th>Task</th><th>Reward</th><th>Texts</th><th>Screenshots</th><th>Action</th></tr>
      ${subs.map((s) => `
        <tr>
          <td>${s.telegramId}</td>
          <td>${s.taskTitle}</td>
          <td>${s.reward} WTC</td>
          <td>${(s.texts || []).join(" | ")}</td>
          <td>${(s.screenshots || []).length} file(s)</td>
          <td>
            <button onclick="processSubmission('${s._id}','approve')">Approve</button>
            <button class="danger" onclick="processSubmission('${s._id}','reject')">Reject</button>
          </td>
        </tr>
      `).join("") || `<tr><td colspan="6">No pending submissions</td></tr>`}
    </table>
  `;
}

async function processSubmission(id, action) {
  await api("/api/admin/tasks", { method: "POST", body: { submissionId: id, action } });
  renderSubmissions(document.getElementById("tabContent"));
}

// ---------- PROMO ----------
async function renderPromo(el) {
  const promos = await api("/api/admin/promo");
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Create Promo Code</h3>
      <input id="promoCode" placeholder="Code (e.g. REDTUBE50)" />
      <input id="promoReward" type="number" placeholder="Reward (WTC)" />
      <input id="promoLimit" type="number" placeholder="Claim limit (max users)" />
      <button onclick="createPromo()">Create</button>
    </div>
    <table>
      <tr><th>Code</th><th>Reward</th><th>Used / Limit</th><th>Action</th></tr>
      ${promos.map((p) => `
        <tr>
          <td>${p.code}</td><td>${p.reward} WTC</td><td>${p.usedCount}/${p.limit}</td>
          <td><button onclick="viewClaimants('${p.code}')">View claimants</button></td>
        </tr>
      `).join("")}
    </table>
    <div id="claimantsBox"></div>
  `;
}

async function viewClaimants(code) {
  const box = document.getElementById("claimantsBox");
  const list = await api(`/api/admin/promo?code=${encodeURIComponent(code)}`);
  box.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:10px;">Claimed "${code}" by</h3>
      <table>
        <tr><th>UID</th><th>Username</th><th>Claimed At</th></tr>
        ${list.map((c) => `
          <tr>
            <td>${c.telegramId}</td>
            <td>@${c.username || "none"}</td>
            <td>${new Date(c.claimedAt).toLocaleString()}</td>
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
