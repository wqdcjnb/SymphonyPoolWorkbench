import { qualityLabel } from './account-quality.js';
import { state, statusLabel, $, escapeHtml, formatNumber, formatTime, formatBeijingTime, isDoubao, readableError, api, toast } from "./shared.js";
import { suggestAccount } from "./account-suggestion.js";

function statusBadge(account) {
  const label = account.needsAttention ? "待人工处理" : account.lastErrorCode === "PROFILE_IN_USE" ? "窗口未关闭"
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
  const quotaExhausted = (doubao && account.lastErrorCode === "DOUBAO_FREE_QUOTA_EXHAUSTED")
    || (account.service === "dola" && account.lastErrorCode === "DOLA_QUOTA_EXHAUSTED");
  const balanceKnown = Number.isInteger(account.creditsRemaining) && total > 0;
  const percent = balanceKnown ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 0;
  const models = (account.models || []).map((model) => `<span class="tag">${escapeHtml(model.replace("Dreamina ", ""))}</span>`).join("") || '<span class="muted">验收后显示模型</span>';
  const balanceLabel = "可用积分";
  const balanceValue = quotaExhausted ? "0" : balanceKnown ? `${formatNumber(remaining)} / ${formatNumber(total)}` : "待读取";
  const capability = `<div class="credit-line"><div><span>${balanceLabel}</span><strong>${balanceValue}</strong></div><span>${balanceKnown ? `${percent}%` : "—"}</span></div>
      <progress class="progress" value="${balanceKnown ? remaining : 0}" max="${total || 1}" aria-label="${balanceLabel}${balanceKnown ? ` ${percent}%` : "待读取"}">${balanceKnown ? `${percent}%` : "待读取"}</progress>`;
  const refresh = formatBeijingTime(account.creditsResetAt);
  const accountDetails = `<div class="account-meta"><span>节点 · ${escapeHtml(account.workerId)}</span><span>验收 · ${escapeHtml(formatTime(account.lastVerifiedAt))}</span><span>刷新 · ${escapeHtml(refresh)}</span></div>
    <div class="tag-row">${models}</div>`;
  const lastError = account.lastErrorCode
    ? `<p class="account-error">${escapeHtml(readableError(account.lastErrorCode))}</p>` : "";
  const desktop = hasDesktop();
  const openControl = desktop
    ? `<a class="button ghost small" href="/accounts/${encodeURIComponent(account.id)}/login" target="symphony-account-browser" data-action="open" data-account="${escapeHtml(account.id)}" ${runningJob ? 'aria-disabled="true" tabindex="-1"' : ""}>查看账号浏览器</a>`
    : `<button class="button ghost small" data-action="open" data-account="${escapeHtml(account.id)}" ${runningJob ? "disabled" : ""}>打开登录窗口</button>`;
  return `<div class="account-card">
    <div class="account-top"><div class="account-top-row"><span class="account-code">${escapeHtml(account.id)}</span>
      <div class="account-top-actions"><button class="icon-button account-edit-button" type="button" data-action="edit-account" data-account="${escapeHtml(account.id)}" aria-label="编辑 ${escapeHtml(account.label)} 的编号和名称" title="编辑账号编号和名称"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg></button></div></div>
      <div class="account-heading"><h3>${escapeHtml(account.label)}</h3><span class="platform-label">${account.service === "dola" ? "Dola" : "豆包"}</span>${statusBadge(account)}</div></div>
    ${capability}
    ${accountDetails}
    <p class="field-note">每日 10 积分 · ${doubao ? '15 秒 / 2 积分' : '30 秒 / 4 积分'} · 按工作台任务扣减 · 北京时间 00:00 重置${account.creditsReserved ? ` · 已预留 ${formatNumber(account.creditsReserved)} 积分` : ''}</p>
    <p class="field-note">${escapeHtml(qualityLabel(account))} · 稳定性 ${account.reliabilityScore ?? 80} 分 · 完成 ${account.videoSuccessCount || 0} · 掉线 ${account.authFailureCount || 0} · 验证 ${account.challengeCount || 0} · 中断 ${account.executionFailureCount || 0}</p>
    ${account.needsAttention ? '<p class="account-error">已暂停派发，请人工处理并重新验收。</p>' : ''}
    ${lastError}
    <div class="account-actions">
      ${openControl}
      <a class="text-button" href="/pool?account=${encodeURIComponent(account.id)}">登录资料与恢复</a>
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
  const suggestion = suggestAccount(state.accounts, $("#accountLoginType").value);
  if (force || !idInput.value || idInput.value === lastSuggestion.id) idInput.value = suggestion.id;
  if (force || !labelInput.value || labelInput.value === lastSuggestion.label) labelInput.value = suggestion.label;
  lastSuggestion = suggestion;
  const platform = doubao ? "豆包" : "Dola";
  $("#accountDialogNote").textContent = `创建后到账号池管理中保存${doubao ? '登录手机号' : '对应 Cookie'}并配置出口组。也可直接在账号池管理中创建并保存登录资料。`;
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
    toast(`账号已创建，已分配到节点 ${account.workerId}`);
    refresh().catch((error) => toast(`账号已创建，列表同步失败：${readableError(error.message)}`, true));
  });
}
