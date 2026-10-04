import { state, statusLabel, $, escapeHtml, formatNumber, formatTime, beijingDate, formatBeijingTime, isDoubao, readableError, api, toast } from "./shared.js";
import { suggestAccount } from "./account-suggestion.js";

function statusBadge(account) {
  const label = account.lastErrorCode === "PROFILE_IN_USE" ? "窗口未关闭"
    : statusLabel[account.status] || account.status;
  return `<span class="status status-${escapeHtml(account.status)}"><i></i>${escapeHtml(label)}</span>`;
}
function hasDesktop() {
  const port = Number(state.desktopPort);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
function accountCard(account) {
  const doubao = isDoubao(account);
  const runningJob = state.jobs.some((job) => job.accountId === account.id
    && new Set(["leased", "submitting", "submitted", "generating", "collecting"]).has(job.status));
  const remaining = Number(account.creditsRemaining || 0);
  const total = Number(account.creditsTotal || 0);
  const todayVerified = account.videoCountDate === beijingDate();
  const quotaExhausted = doubao && account.lastErrorCode === "DOUBAO_FREE_QUOTA_EXHAUSTED";
  const balanceKnown = doubao
    ? quotaExhausted || (todayVerified && account.creditsEstimated && Number.isInteger(account.creditsRemaining) && total > 0)
    : total > 0;
  const percent = balanceKnown ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 0;
  const models = (account.models || []).map((model) => `<span class="tag">${escapeHtml(model.replace("Dreamina ", ""))}</span>`).join("") || '<span class="muted">验收后显示模型</span>';
  const doubaoCount = todayVerified && Number.isInteger(account.videosCreatedToday)
    ? `${formatNumber(account.videosCreatedToday)} 条` : "待读取";
  const balanceLabel = quotaExhausted ? "平台确认剩余额度" : doubao ? "预计剩余额度" : "可用积分";
  const balanceValue = quotaExhausted ? "0" : balanceKnown ? `${formatNumber(remaining)} / ${formatNumber(total)}` : "待读取";
  const capability = `<div class="credit-line"><div><span>${balanceLabel}</span><strong>${balanceValue}</strong></div><span>${balanceKnown ? `${percent}%` : "—"}</span></div>
      <progress class="progress" value="${balanceKnown ? remaining : 0}" max="${total || 1}" aria-label="${balanceLabel}${balanceKnown ? ` ${percent}%` : "待读取"}">${balanceKnown ? `${percent}%` : "待读取"}</progress>`;
  const refresh = doubao ? formatBeijingTime(account.creditsResetAt) : account.creditsResetAt || "待读取";
  const accountDetails = `<div class="account-meta"><span>档案 · ${escapeHtml(account.workerId)}</span><span>验收 · ${escapeHtml(formatTime(account.lastVerifiedAt))}</span><span>刷新 · ${escapeHtml(refresh)}</span></div>
    <div class="tag-row">${models}</div>`;
  const doubaoDetails = doubao ? `<details class="account-extra">
    <summary>今日已生成视频 · ${escapeHtml(doubaoCount)}<span>豆包详情</span></summary>
    <div class="account-extra-grid">
      <div>额度 · 平台无法精确读取，模型和时长等都会影响消耗</div>
      <div>显示值 · 根据今日作品粗估，仅用于账号排序</div>
      <div>次数用尽 · 立即记为 0，次日重新验收</div>
      <div>创作记录 · ${account.creditPageReady ? "已读取" : "待读取"}</div>
      <div>视频入口 · ${account.createPageReady ? "已读取" : "待读取"}</div>
      <div>Seedance 2.0 全模态参考 · 最多 9 张（模型规格）</div>
      <div>当前页面参考图上限 · ${account.referenceImageLimit == null ? "网页未显示" : `${formatNumber(account.referenceImageLimit)} 张`}</div>
      <div>生成任务 · 手动开始</div>
    </div>
  </details>` : "";
  const lastError = account.lastErrorCode
    ? `<p class="account-error">${escapeHtml(readableError(account.lastErrorCode))}</p>` : "";
  const desktop = hasDesktop();
  const openControl = desktop
    ? `<a class="button ghost small" href="/accounts/${encodeURIComponent(account.id)}/login" target="_blank" rel="noopener noreferrer" data-action="open" data-account="${escapeHtml(account.id)}" ${runningJob ? 'aria-disabled="true" tabindex="-1"' : ""}>打开登录窗口</a>`
    : `<button class="button ghost small" data-action="open" data-account="${escapeHtml(account.id)}" ${runningJob ? "disabled" : ""}>打开登录窗口</button>`;
  return `<div class="account-card">
    <div class="account-top"><div class="account-top-row"><span class="account-code">${escapeHtml(account.id)}</span>
      <div class="account-top-actions"><button class="icon-button account-edit-button" type="button" data-action="edit-account" data-account="${escapeHtml(account.id)}" aria-label="编辑 ${escapeHtml(account.label)} 的编号和名称" title="编辑账号编号和名称"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg></button><button class="icon-button account-delete-button" type="button" data-action="delete-account" data-account="${escapeHtml(account.id)}" aria-label="删除 ${escapeHtml(account.label)}" title="删除账号"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>
      <div class="account-heading"><h3>${escapeHtml(account.label)}</h3><span class="platform-label">${doubao ? "豆包网页版" : "TikTok Symphony"}</span>${statusBadge(account)}</div></div>
    ${capability}
    ${accountDetails}
    ${doubaoDetails}
    ${lastError}
    <div class="account-actions">
      ${openControl}
      <button class="button primary small" data-action="verify" data-account="${escapeHtml(account.id)}" ${account.status === "checking" || runningJob ? "disabled" : ""}>只读验收</button>
    </div>
  </div>`;
}

export function renderAccounts() {
  const loginNote = $("#accountLoginNote");
  if (loginNote) {
    loginNote.textContent = hasDesktop()
      ? "使用 Xpra 打开账号的独立 Chrome 窗口；登录后点击“登录完成，结束窗口”，再进行只读验收。"
      : "每个账号使用独立浏览器档案；登录完成后关闭窗口，再进行只读验收。";
  }
  $("#accountGrid").innerHTML = state.accounts.length
    ? state.accounts.map((account) => accountCard(account)).join("")
    : '<div class="empty">还没有账号档案。</div>';
}

async function accountAction(action, accountId, button, refresh) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = action === "verify" ? "验收中…" : "正在打开…";
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/${action}`, { method: "POST", body: "{}" });
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

let lastSuggestion = { id: "", label: "" };

function updateAccountFormHint(force = false) {
  const doubao = $("#accountLoginType").value === "doubao";
  const idInput = $("#accountIdInput");
  const labelInput = $("#accountLabelInput");
  const suggestion = suggestAccount(state.accounts, $("#accountLoginType").value,
    $("#accountWorkerIdInput").value);
  if (force || !idInput.value || idInput.value === lastSuggestion.id) idInput.value = suggestion.id;
  if (force || !labelInput.value || labelInput.value === lastSuggestion.label) labelInput.value = suggestion.label;
  lastSuggestion = suggestion;
  $("#accountDialogNote").textContent = doubao
    ? "创建后打开独立豆包窗口，由你手动登录。关闭窗口后点击只读验收；工作台不接收密码或 Cookie。"
    : "创建后打开独立 Symphony 窗口，由你手动登录。关闭窗口后点击只读验收；工作台不接收密码或 Cookie。";
}

export function bindAccountControls(refresh) {
  document.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (action && (action.dataset.action === "open" || action.dataset.action === "verify")) {
      if (action.getAttribute("aria-disabled") === "true" || action.dataset.busy === "true") {
        event.preventDefault();
        return;
      }
      // The account-specific tab launches once and waits for its own desktop connection.
      if (action.tagName === "A" && action.dataset.action === "open") return;
      action.dataset.busy = "true";
      await accountAction(action.dataset.action, action.dataset.account, action, refresh);
      delete action.dataset.busy;
    }
    if (action?.dataset.action === "edit-account") {
      const account = state.accounts.find((item) => item.id === action.dataset.account);
      if (!account) return;
      const dialog = $("#editAccountDialog");
      dialog.dataset.accountId = account.id;
      $("#editAccountIdInput").value = account.id;
      $("#editAccountLabelInput").value = account.label;
      dialog.showModal();
      $("#editAccountIdInput").focus();
    }
    if (action?.dataset.action === "delete-account") {
      const account = state.accounts.find((item) => item.id === action.dataset.account);
      if (!account || !window.confirm(`确定删除「${account.label}」？账号记录和浏览器登录档案将永久删除，历史任务与已生成视频会保留。请先关闭该账号的登录窗口。`)) return;
      action.disabled = true;
      let deleted;
      try {
        deleted = await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      } catch (error) {
        action.disabled = false;
        toast(`删除失败：${readableError(error.message)}`, true);
        return;
      }
      state.accounts = state.accounts.filter((item) => item.id !== account.id);
      renderAccounts();
      toast(deleted.profileCleanupPending ? "账号已删除，登录档案清理未完成，请检查服务器目录" : "账号已删除");
      refresh().catch((error) => toast(`账号已删除，列表同步失败：${readableError(error.message)}`, true));
    }
  });
  $("#addAccountButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      state.accounts = (await api("/api/accounts")).accounts;
      $("#accountForm").reset();
      updateAccountFormHint(true);
      $("#accountDialog").showModal();
    } catch (error) {
      toast(`读取账号失败：${readableError(error.message)}`, true);
    } finally {
      button.disabled = false;
    }
  });
  $("#closeAccountDialogButton").addEventListener("click", () => $("#accountDialog").close());
  $("#accountLoginType").addEventListener("change", () => updateAccountFormHint(true));
  $("#accountWorkerIdInput").addEventListener("input", () => updateAccountFormHint());
  $("#closeEditAccountDialogButton").addEventListener("click", () => $("#editAccountDialog").close());

  $("#editAccountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const dialog = $("#editAccountDialog");
    const idInput = $("#editAccountIdInput");
    const labelInput = $("#editAccountLabelInput");
    idInput.value = idInput.value.trim();
    labelInput.value = labelInput.value.trim();
    if (!idInput.reportValidity() || !labelInput.reportValidity()) return;
    const button = event.submitter || $("#editAccountForm button[type='submit']");
    button.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(dialog.dataset.accountId)}`, {
        method: "PATCH", body: JSON.stringify({ accountId: idInput.value, label: labelInput.value }),
      });
      dialog.close();
      toast("账号信息已更新");
      await refresh();
    } catch (error) {
      toast(`修改失败：${readableError(error.message)}`, true);
    } finally {
      button.disabled = false;
    }
  });

  $("#accountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const accountForm = event.currentTarget;
    const submitButton = event.submitter || accountForm.querySelector("button[type='submit']");
    const form = new FormData(accountForm);
    submitButton.disabled = true;
    let account;
    try {
      ({ account } = await api("/api/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }));
    } catch (error) {
      toast(`创建失败：${readableError(error.message)}`, true);
      submitButton.disabled = false;
      return;
    }
    accountForm.reset();
    $("#accountDialog").close();
    submitButton.disabled = false;
    state.accounts = [...state.accounts.filter((item) => item.id !== account.id), account];
    renderAccounts();
    toast("账号档案记录已建立");
    refresh().catch((error) => toast(`账号已创建，列表同步失败：${readableError(error.message)}`, true));
  });
}
