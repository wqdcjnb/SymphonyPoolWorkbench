const state = { accounts: [], jobs: [], events: [], overview: null, automationEnabled: false };

const statusLabel = {
  provisioning: "待建立档案",
  auth_required: "待登录",
  checking: "验收中",
  ready: "可用",
  busy: "执行中",
  cooling: "冷却中",
  degraded: "已降级",
  disabled: "已暂停",
  error: "异常",
};

const modeLabel = {
  reference_to_video: "参考素材转视频",
  image_to_video: "图生视频",
  text_to_video: "文生视频",
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "尚未验收";

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = isError ? "show error" : "show";
  window.setTimeout(() => { node.className = ""; }, 3200);
}

function statusBadge(status) {
  return `<span class="status status-${escapeHtml(status)}"><i></i>${escapeHtml(statusLabel[status] || status)}</span>`;
}

function renderMetrics() {
  const summary = state.overview || { accounts: {}, jobs: {} };
  const metrics = [
    ["可用账号", summary.accounts.ready || 0, `共 ${summary.accounts.total || 0} 个档案`, "mint"],
    ["可用积分", formatNumber(summary.accounts.availableCredits || 0), "按最近验收汇总", "violet"],
    ["任务草稿", summary.jobs.draft || 0, "尚未提交生成", "amber"],
    ["待人工处理", summary.accounts.authRequired || 0, "登录或验证", "rose"],
  ];
  $("#metricGrid").innerHTML = metrics.map(([label, value, note, tone]) => `
    <article class="metric-card ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>
  `).join("");
}

function accountCard(account, compact = false) {
  const remaining = Number(account.creditsRemaining || 0);
  const total = Number(account.creditsTotal || 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 0;
  const models = (account.models || []).map((model) => `<span class="tag">${escapeHtml(model.replace("Dreamina ", ""))}</span>`).join("") || '<span class="muted">验收后显示模型</span>';
  return `<div class="account-card ${compact ? "compact-account" : ""}">
    <div class="account-top"><div><span class="account-code">${escapeHtml(account.id)}</span><h3>${escapeHtml(account.label)}</h3></div>${statusBadge(account.status)}</div>
    <div class="credit-line"><div><span>可用积分</span><strong>${total ? `${formatNumber(remaining)} / ${formatNumber(total)}` : "待读取"}</strong></div><span>${percent}%</span></div>
    <progress class="progress" value="${remaining}" max="${total || 1}" aria-label="积分剩余 ${percent}%">${percent}%</progress>
    <div class="account-meta"><span>档案 · ${escapeHtml(account.workerId)}</span><span>验收 · ${escapeHtml(formatTime(account.lastVerifiedAt))}</span><span>刷新 · ${escapeHtml(account.creditsResetAt || "待读取")}</span></div>
    <div class="tag-row">${models}</div>
    <div class="account-actions">
      <button class="button ghost small" data-action="open" data-account="${escapeHtml(account.id)}">打开登录窗口</button>
      <button class="button primary small" data-action="verify" data-account="${escapeHtml(account.id)}" ${account.status === "checking" ? "disabled" : ""}>只读验收</button>
    </div>
  </div>`;
}

function renderAccounts() {
  $("#accountGrid").innerHTML = state.accounts.length
    ? state.accounts.map((account) => accountCard(account)).join("")
    : '<div class="empty">还没有账号档案。</div>';
  $("#primaryAccount").innerHTML = state.accounts[0] ? accountCard(state.accounts[0], true) : '<div class="empty">等待账号接入</div>';
  $("#jobAccount").innerHTML = '<option value="">自动选择（执行层启用后）</option>' + state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)}</option>`).join("");
  $("#updatedAt").textContent = `刷新于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
}

function renderJobs() {
  $("#jobList").innerHTML = state.jobs.length ? state.jobs.map((job) => `
    <div class="job-item">
      <div class="job-head"><strong>${escapeHtml(modeLabel[job.mode] || job.mode)}</strong><span class="status status-${escapeHtml(job.status)}">${escapeHtml(job.status)}</span></div>
      <p>${escapeHtml(job.prompt.slice(0, 110))}${job.prompt.length > 110 ? "…" : ""}</p>
      <div class="job-meta"><span>${escapeHtml(job.model)}</span><span>${job.durationSeconds}s</span><span>${job.referenceAssets.length} 个参考素材</span></div>
      ${new Set(["draft", "queued"]).has(job.status) ? `<button class="text-button danger" data-action="cancel-job" data-job="${escapeHtml(job.id)}">取消草稿</button>` : ""}
    </div>
  `).join("") : '<div class="empty">尚未保存任务草稿。</div>';
}

function eventRows(limit) {
  return state.events.slice(0, limit).map((event) => `
    <div class="event-item"><span class="event-dot"></span><div><div class="event-title"><strong>${escapeHtml(event.message)}</strong><time>${escapeHtml(formatTime(event.createdAt))}</time></div><p>${escapeHtml(event.accountLabel || event.accountId || event.jobId || "系统")}</p></div></div>
  `).join("") || '<div class="empty">暂无审计事件。</div>';
}

function renderEvents() {
  $("#eventPreview").innerHTML = eventRows(5);
  $("#eventList").innerHTML = eventRows(60);
}

async function refresh() {
  const payload = await api("/api/overview");
  Object.assign(state, payload);
  renderMetrics();
  renderAccounts();
  renderJobs();
  renderEvents();
}

async function accountAction(action, accountId, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = action === "verify" ? "验收中…" : "正在打开…";
  try {
    await api(`/api/accounts/${encodeURIComponent(accountId)}/${action}`, { method: "POST", body: "{}" });
    toast(action === "verify" ? "只读验收通过" : "专用登录窗口已打开");
    await refresh();
  } catch (error) {
    toast(`操作失败：${error.message}`, true);
    await refresh().catch(() => {});
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-target]");
  if (nav) {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === nav));
    document.querySelectorAll(".panel-section").forEach((section) => section.classList.toggle("active-section", section.id === nav.dataset.target));
  }
  const jump = event.target.closest("[data-jump]");
  if (jump) document.querySelector(`[data-target="${jump.dataset.jump}"]`)?.click();
  const action = event.target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "open" || action.dataset.action === "verify") {
    await accountAction(action.dataset.action, action.dataset.account, action);
  }
  if (action.dataset.action === "cancel-job") {
    try {
      await api(`/api/jobs/${encodeURIComponent(action.dataset.job)}/cancel`, { method: "POST", body: "{}" });
      toast("任务草稿已取消");
      await refresh();
    } catch (error) { toast(`取消失败：${error.message}`, true); }
  }
});

$("#refreshButton").addEventListener("click", () => refresh().then(() => toast("数据已刷新")).catch((error) => toast(error.message, true)));
$("#addAccountButton").addEventListener("click", () => $("#accountDialog").showModal());

$("#accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    $("#accountDialog").close();
    event.currentTarget.reset();
    toast("账号档案记录已建立");
    await refresh();
  } catch (error) { toast(`创建失败：${error.message}`, true); }
});

$("#jobForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = Object.fromEntries(form);
  data.durationSeconds = Number(data.durationSeconds);
  data.priority = Number(data.priority);
  data.referenceAssets = String(data.referenceAssets || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  try {
    await api("/api/jobs", { method: "POST", body: JSON.stringify(data) });
    event.currentTarget.reset();
    toast("任务草稿已保存，未提交生成");
    await refresh();
  } catch (error) { toast(`保存失败：${error.message}`, true); }
});

refresh().catch((error) => toast(`工作台加载失败：${error.message}`, true));
