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
const beijingDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const formatBeijingTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "待读取";
const isDoubao = (account) => account.service === "doubao" || account.loginType === "doubao";

const errorMessage = {
  LOGIN_REQUIRED: "尚未登录。请在专用窗口完成登录，关闭窗口后再验收。",
  PROFILE_IN_USE: "专用浏览器档案仍在使用。请先关闭登录窗口，再点击只读验收。",
  PROFILE_NOT_FOUND: "尚未建立浏览器档案。请先打开登录窗口。",
  BROWSER_LAUNCH_FAILED: "无法启动 Chrome 或 Edge，请检查浏览器安装。",
  TIKTOK_CREDIT_PAGE_NOT_READY: "Symphony 积分页未加载完成，请检查登录状态或稍后重试。",
  TIKTOK_CREATE_PAGE_NOT_READY: "Symphony 生成页未加载完成，请稍后重试。",
  PAGE_TIMEOUT: "Symphony 页面加载超时，请检查网络后重试。",
  DOUBAO_PAGE_TIMEOUT: "豆包页面加载超时，请检查网络后重试。",
  DOUBAO_PAGE_NOT_READY: "豆包页面未准备好，请稍后重试。",
  DOUBAO_VIDEO_PAGE_NOT_READY: "豆包视频生成页未准备好，请稍后重试。",
  DOUBAO_FREE_MODEL_NOT_FOUND: "未读到免费可用的视频模型，请检查豆包页面。",
  DOUBAO_HISTORY_PAGE_NOT_READY: "豆包创作记录页未准备好，请稍后重试。",
  DOUBAO_HISTORY_INCOMPLETE: "未能完整统计今日视频作品，请稍后重试。",
  PYTHON_NOT_CONFIGURED: "未找到 Python 环境，请按 README 安装验收依赖。",
  ACCOUNT_ALREADY_EXISTS: "账号编号已存在，请换一个编号。",
};
const readableError = (code) => errorMessage[code] || code;

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

function statusBadge(account) {
  const label = account.lastErrorCode === "PROFILE_IN_USE" ? "窗口未关闭"
    : isDoubao(account) && account.status === "ready" ? "视频验收通过" : statusLabel[account.status] || account.status;
  return `<span class="status status-${escapeHtml(account.status)}"><i></i>${escapeHtml(label)}</span>`;
}

function renderMetrics() {
  const summary = state.overview || { accounts: {}, jobs: {} };
  const metrics = [
    ["已验收账号", summary.accounts.ready || 0, `共 ${summary.accounts.total || 0} 个档案`, "mint"],
    ["Symphony 积分", formatNumber(summary.accounts.availableCredits || 0), "仅统计 Symphony 账号", "violet"],
    ["Symphony 草稿", summary.jobs.draft || 0, "尚未提交生成", "amber"],
    ["待人工处理", summary.accounts.needsAttention || 0, "登录、验收或修复", "rose"],
  ];
  $("#metricGrid").innerHTML = metrics.map(([label, value, note, tone]) => `
    <article class="metric-card ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>
  `).join("");
}

function accountCard(account, compact = false) {
  const doubao = isDoubao(account);
  const remaining = Number(account.creditsRemaining || 0);
  const total = Number(account.creditsTotal || 0);
  const todayVerified = account.videoCountDate === beijingDate();
  const balanceKnown = doubao
    ? todayVerified && account.creditsEstimated && Number.isInteger(account.creditsRemaining) && total > 0
    : total > 0;
  const percent = balanceKnown ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 0;
  const models = (account.models || []).map((model) => `<span class="tag">${escapeHtml(model.replace("Dreamina ", ""))}</span>`).join("") || '<span class="muted">验收后显示模型</span>';
  const doubaoCount = todayVerified && Number.isInteger(account.videosCreatedToday)
    ? `${formatNumber(account.videosCreatedToday)} 条` : "待读取";
  const balanceLabel = doubao ? "预计剩余额度" : "可用积分";
  const capability = `<div class="credit-line"><div><span>${balanceLabel}</span><strong>${balanceKnown ? `${formatNumber(remaining)} / ${formatNumber(total)}` : "待读取"}</strong></div><span>${balanceKnown ? `${percent}%` : "—"}</span></div>
      <progress class="progress" value="${balanceKnown ? remaining : 0}" max="${total || 1}" aria-label="${balanceLabel}${balanceKnown ? ` ${percent}%` : "待读取"}">${balanceKnown ? `${percent}%` : "待读取"}</progress>`;
  const accountDetails = doubao
    ? `<p class="account-note">每日 10 额度，5 秒视频用 1 额度，10 秒视频用 2 额度；余额按今日作品时长估算。生成任务尚未接入。</p>
      <div class="account-meta"><span>今日已生成视频 · ${escapeHtml(doubaoCount)}</span><span>档案 · ${escapeHtml(account.workerId)}</span><span>验收 · ${escapeHtml(formatTime(account.lastVerifiedAt))}</span>
      <span>创作记录 · ${account.creditPageReady ? "已读取" : "待读取"}</span><span>视频入口 · ${account.createPageReady ? "已读取" : "待读取"}</span>
      <span>次日重置 · ${escapeHtml(formatBeijingTime(account.creditsResetAt))}</span>
      <span>Seedance 2.0 全模态参考 · 最多 9 张（模型规格）</span>
      <span>当前页面参考图上限 · ${account.referenceImageLimit == null ? "网页未显示" : `${formatNumber(account.referenceImageLimit)} 张`}</span></div>
      <div class="tag-row">${models}</div>`
    : `<div class="account-meta"><span>档案 · ${escapeHtml(account.workerId)}</span><span>验收 · ${escapeHtml(formatTime(account.lastVerifiedAt))}</span><span>刷新 · ${escapeHtml(account.creditsResetAt || "待读取")}</span></div><div class="tag-row">${models}</div>`;
  const lastError = account.lastErrorCode
    ? `<p class="account-error">${escapeHtml(readableError(account.lastErrorCode))}</p>` : "";
  return `<div class="account-card ${compact ? "compact-account" : ""}">
    <div class="account-top"><div><span class="account-code">${escapeHtml(account.id)}</span><h3>${escapeHtml(account.label)}</h3><span class="platform-label">${doubao ? "豆包网页版" : "TikTok Symphony"}</span></div>${statusBadge(account)}</div>
    ${capability}
    ${accountDetails}
    ${lastError}
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
  const primary = state.accounts.find((account) => !isDoubao(account)) || state.accounts[0];
  $("#primaryAccount").innerHTML = primary ? accountCard(primary, true) : '<div class="empty">等待账号接入</div>';
  $("#jobAccount").innerHTML = '<option value="">自动选择（执行层启用后）</option>' + state.accounts.filter((account) => !isDoubao(account)).map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)}</option>`).join("");
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
    toast(`操作失败：${readableError(error.message)}`, true);
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
function updateAccountFormHint() {
  const doubao = $("#accountLoginType").value === "doubao";
  $("#accountIdInput").placeholder = doubao ? "xzkj-pc-01-doubao-01" : "xzkj-pc-01-symphony-02";
  $("#accountLabelInput").placeholder = doubao ? "豆包一号账号" : "Symphony TK 二号账号";
  $("#accountDialogNote").textContent = doubao
    ? "创建后打开独立豆包窗口，由你手动登录。关闭窗口后点击只读验收；工作台不接收密码或 Cookie。"
    : "创建后打开独立 Symphony 窗口，由你手动登录。关闭窗口后点击只读验收；工作台不接收密码或 Cookie。";
}

$("#addAccountButton").addEventListener("click", () => { updateAccountFormHint(); $("#accountDialog").showModal(); });
$("#closeAccountDialogButton").addEventListener("click", () => $("#accountDialog").close());
$("#accountLoginType").addEventListener("change", updateAccountFormHint);

$("#accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    $("#accountDialog").close();
    event.currentTarget.reset();
    updateAccountFormHint();
    toast("账号档案记录已建立");
    await refresh();
  } catch (error) { toast(`创建失败：${readableError(error.message)}`, true); }
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
