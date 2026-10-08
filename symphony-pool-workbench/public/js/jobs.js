import { state, statusLabel, modeLabel, jobStatusLabel, supportedModels, supportedDurationsForModel, supportedImageLimits, $, escapeHtml, formatNumber, formatTime, readableError, api, toast } from "./shared.js";
import { jobProgress } from './job-progress.js';
import { DAILY_CREDITS, VIDEO_RATIOS, videoModel } from './video-policy.js';

let selectedJobPage = 1;
let jobPageRequestId = 0;
let lastJobRender = '';

const selectedReferenceFiles = [];
const savedReferenceAssets = [];
const uploadedReferencePaths = new WeakMap();
let editingJobId = null;

const isDolaModel = (model) => model === "Dreamina Seedance 2.0 Fast" || model === "Dreamina Seedance 2.5";

function syncDurationOptions() {
  const account = state.accounts.find((item) => item.id === $("#jobAccount").value);
  const choices = account ? supportedModels[account.service] : Object.values(supportedModels).flat();
  if (!choices?.includes($("#jobModel").value)) $("#jobModel").value = choices?.[0] || '';
  const model = $("#jobModel").value;
  const services = account ? [account.service] : Object.keys(supportedModels);
  const durations = [...new Set(services.flatMap((service) => supportedDurationsForModel(service, model)))];
  for (const option of $("#jobModel").options) option.hidden = option.disabled = Boolean(account && !supportedModels[account.service]?.includes(option.value));
  $("#jobDuration").innerHTML = durations.map(duration => `<option value="${duration}">${duration} 秒</option>`).join('');
  const ratios = videoModel(model)?.ratios || VIDEO_RATIOS;
  for (const option of $("#jobAspectRatio").options) option.hidden = option.disabled = !ratios.includes(option.value);
  if (!ratios.includes($("#jobAspectRatio").value)) $("#jobAspectRatio").value = ratios[0];
}

function renderDeliveryNotice() {
  const spec = videoModel($("#jobModel").value);
  if (spec) $("#jobCreditNotice").textContent = `每个账号每日 ${DAILY_CREDITS} 积分，${spec.duration} 秒视频每条消耗 ${spec.credits} 积分。`;
  $("#jobReferencePicker").hidden = spec?.maxImages === 0;
}

export function renderJobAccount() {
  const currentAccount = $("#jobAccount").value;
  $("#jobAccount").innerHTML = '<option value="auto">自动选择可用账号</option>' + state.accounts.map((account) =>
    `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)} · ${escapeHtml(statusLabel[account.status] || account.status)}</option>`).join("");
  $("#jobAccount").value = currentAccount === "auto" || state.accounts.some((account) => account.id === currentAccount)
    ? currentAccount : "auto";
  if (!currentAccount) {
    const first = state.accounts.find(account => account.status === 'ready');
    if (first && !state.accounts.some(account => supportedModels[account.service]?.includes($("#jobModel").value))) {
      $("#jobModel").value = supportedModels[first.service]?.[0] || $("#jobModel").value;
    }
  }
  syncDurationOptions();
  renderDeliveryNotice();
}

function jobValidationError(data, imageCount) {
  if (!Number.isInteger(data.concurrency) || data.concurrency < 1 || data.concurrency > 100) {
    return "并发数须为 1–100 的整数。";
  }
  if (data.concurrency > 1 && data.accountId !== "auto") {
    return "并发生成需要多个账号，请将目标账号改为自动分配。";
  }
  if (imageCount > 9) return "最多选择 9 张图片。";
  const account = state.accounts.find((item) => item.id === data.accountId);
  const serviceCompatible = (service) => supportedDurationsForModel(service, data.model).includes(data.durationSeconds)
    && imageCount <= supportedImageLimits[service]
    && videoModel(data.model)?.ratios.includes(data.aspectRatio)
    && (data.aspectRatio === "9:16" || service === "doubao" || service === "dola")
    && supportedModels[service]?.includes(data.model);
  const validCombination = account ? serviceCompatible(account.service)
    : Object.keys(supportedModels).some(serviceCompatible);
  if (!validCombination) return "豆包支持 2.0 Fast / Mini、15 秒；Dola 支持 2.5、30 秒。请选择有效的视频参数。";
  return null;
}

function renderSelectedFiles() {
  const input = $("#jobReferenceFile");
  const transfer = new DataTransfer();
  selectedReferenceFiles.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  const savedCount = savedReferenceAssets.length;
  const newCount = selectedReferenceFiles.length;
  $("#jobFileSummary").textContent = !savedCount && !newCount ? "未选择图片，将按纯文字生成"
    : savedCount && newCount ? `已选 ${savedCount + newCount} 张图片（草稿 ${savedCount} 张，新选 ${newCount} 张）`
      : savedCount ? `草稿中已有 ${savedCount} 张图片` : `已选 ${newCount} 张图片`;
  $("#jobReferencePicker").classList.toggle("is-disabled", input.disabled);
  const stored = savedReferenceAssets.map((asset, index) => `
    <div class="reference-file"><span title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)} · 已保存</span>
      <button class="text-button danger" type="button" data-remove-reference="saved:${index}" ${$("#jobForm").dataset.submitting === "true" ? "disabled" : ""}>删除</button></div>`);
  const picked = selectedReferenceFiles.map((file, index) => `
    <div class="reference-file"><span title="${escapeHtml(file.name)}">${escapeHtml(file.name)} · ${formatNumber(Math.ceil(file.size / 1024))} KB</span>
      <button class="text-button danger" type="button" data-remove-reference="new:${index}" ${$("#jobForm").dataset.submitting === "true" ? "disabled" : ""}>删除</button></div>`);
  $("#jobSelectedFiles").innerHTML = [...stored, ...picked].join("");
}

function resetDraftEditor() {
  editingJobId = null;
  savedReferenceAssets.length = 0;
  selectedReferenceFiles.length = 0;
  $("#jobForm").reset();
  syncDurationOptions();
  renderDeliveryNotice();
  $("#jobDraftEditNotice").hidden = true;
  $("#jobStopEditingButton").hidden = true;
  $("#jobStartButton").textContent = "开始生成";
  renderSelectedFiles();
}

function editDraft(jobId) {
  const job = state.jobPage.jobs.find((item) => item.id === jobId
    && item.status === "draft" && item.mode === "image_to_video");
  if (!job) { toast("草稿已不存在或已开始", true); return; }
  editingJobId = job.id;
  selectedReferenceFiles.length = 0;
  savedReferenceAssets.length = 0;
  job.referenceAssets.forEach((assetPath, index) => savedReferenceAssets.push({
    path: assetPath, name: job.referenceAssetNames?.[index] || assetPath.split(/[\\/]/).pop(),
  }));
  $("#jobAccount").value = job.accountId || "auto";
  $("#jobModel").value = job.model;
  syncDurationOptions();
  renderDeliveryNotice();
  $("#jobAspectRatio").value = VIDEO_RATIOS.includes(job.aspectRatio) ? job.aspectRatio : "9:16";
  $("#jobConcurrency").value = String(job.concurrency || 1);
  $("#jobForm").elements.positivePrompt.value = job.prompt;
  $("#jobForm").elements.negativePrompt.value = job.negativePrompt || "";
  $("#jobDraftEditNotice").textContent = `正在编辑待开始任务 ${job.id.slice(0, 12)}；提交后将尝试开始生成。`;
  $("#jobDraftEditNotice").hidden = false;
  $("#jobStopEditingButton").hidden = false;
  $("#jobStartButton").textContent = "更新并开始生成";
  renderSelectedFiles();
  $("#jobForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

const providerTaskLabel = {
  queued: "排队中", submitting: "提交中", processing: "生成中", running: "生成中",
  succeeded: "已完成", failed: "失败",
};

function renderVideoApiJob(job) {
  const remaining = Math.max(0, job.requestedCount - job.dispatchedCount);
  return `<div class="job-item">
    <div class="job-head"><strong>外部任务 #${escapeHtml(job.providerBatchId)}</strong><span class="status status-${escapeHtml(job.status)}">${escapeHtml(jobStatusLabel[job.status] || job.status)}</span></div>
    <p>${escapeHtml(job.prompt.slice(0, 110))}${job.prompt.length > 110 ? "…" : ""}</p>
    ${job.negativePrompt ? `<p class="job-negative-prompt">避免：${escapeHtml(job.negativePrompt.slice(0, 90))}${job.negativePrompt.length > 90 ? "…" : ""}</p>` : ""}
    <div class="job-meta"><span>${escapeHtml(job.model)}</span><span>${escapeHtml(job.durationSeconds)} 秒</span><span>${escapeHtml(job.aspectRatio)}</span><span>${escapeHtml(job.resolution)}</span><span>${job.referenceCount ? `${escapeHtml(job.referenceCount)} 张参考图` : "纯文字"}</span><span>申请 ${escapeHtml(job.requestedCount)} 条</span><span>${escapeHtml(formatTime(job.updatedAt))}</span></div>
    <p class="field-note">已提交 ${escapeHtml(job.dispatchedCount)} / ${escapeHtml(job.requestedCount)} 条${remaining ? `，剩余 ${remaining} 条等待轮次` : ""}。</p>
    ${job.errorCode ? `<p class="account-error">${escapeHtml(readableError(job.errorCode))}</p>` : ""}
    ${job.status === "blocked" ? '<p class="field-note">请让请求方检查自己的 Key 或额度，并通过原 API 重试。</p>' : ""}
    ${job.tasks.length ? `<div class="api-video-tasks">${job.tasks.map((task) => `
      <div class="api-video-task"><span>${escapeHtml(task.id.slice(0, 8))} · ${escapeHtml(providerTaskLabel[task.status] || task.status)}</span>
        ${task.resultReady ? `<a class="button primary small" href="/api/workbench/video-results/${encodeURIComponent(task.id)}">下载 MP4</a>` : task.status === "succeeded" ? `<span class="muted">${task.resultErrorCode ? `保存重试中：${escapeHtml(readableError(task.resultErrorCode))}` : "正在保存视频"}</span>` : ""}
      </div>`).join("")}</div>` : ""}
  </div>`;
}

function renderJobs() {
  const { jobs, page, pageSize, total, totalPages, status } = state.jobPage;
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  $("#jobRange").textContent = `第 ${first}–${last} 条，共 ${total} 条`;
  $("#jobPageInfo").textContent = `第 ${page} / ${totalPages} 页`;
  $("#jobPrevPage").disabled = page <= 1;
  $("#jobNextPage").disabled = page >= totalPages;
  const renderKey = JSON.stringify([jobs, state.accounts.map(account => [account.id, account.label]), status]);
  if (renderKey === lastJobRender) return;
  lastJobRender = renderKey;
  $("#jobList").innerHTML = jobs.length ? jobs.map((job) => { const progress = job.progress || jobProgress(job); return job.source === "video_api"
    ? renderVideoApiJob(job) : `
    <div class="job-item">
      <div class="job-head"><strong>${escapeHtml(state.accounts.find((account) => account.id === job.accountId)?.label || job.accountId || "自动选择账号")}</strong><span class="status status-${escapeHtml(job.status)}">${escapeHtml(progress.label)}</span></div>
      <p>${escapeHtml(job.prompt.slice(0, 110))}${job.prompt.length > 110 ? "…" : ""}</p>
      ${job.negativePrompt ? `<p class="job-negative-prompt">避免：${escapeHtml(job.negativePrompt.slice(0, 90))}${job.negativePrompt.length > 90 ? "…" : ""}</p>` : ""}
      <div class="job-meta"><span>${escapeHtml(modeLabel[job.mode] || job.mode)}</span><span>${escapeHtml(job.model === "auto" ? "自动选择模型" : job.model)}</span><span>${job.durationSeconds}s</span><span>${escapeHtml(job.aspectRatio === "auto" ? "比例自动" : job.aspectRatio || "比例自动")}</span><span>${job.mode === "image_to_video" && !job.referenceAssets.length ? "纯文字" : `${job.referenceAssets.length} 张参考图`}</span>${job.referenceVideo ? "<span>1 条参考视频</span>" : ""}<span>${escapeHtml(formatTime(job.updatedAt))}</span></div>
      ${job.batchSize > 1 ? `<p class="field-note">批次 ${escapeHtml(job.batchIndex)}/${escapeHtml(job.batchSize)}</p>` : job.status === "draft" && job.concurrency > 1 ? `<p class="field-note">并发 ${escapeHtml(job.concurrency)} 条</p>` : ""}
      <p class="field-note">${escapeHtml(progress.description)}${job.nextReconcileAt ? ` 下次核对：${escapeHtml(formatTime(job.nextReconcileAt))}。` : ''}</p>
      ${job.errorCode ? `<p class="${job.status === "queued" ? "muted" : "account-error"}">${escapeHtml(readableError(job.errorCode))}</p>` : ""}
      ${job.collectOnly && !['success','failed','cancelled'].includes(job.status) ? `<p class="field-note">仅处理原任务结果 · 已自动核对 ${job.reconcileAttempts || 0} 次</p>` : ''}
      ${job.status === "success" ? `<video class="job-video-preview" controls playsinline preload="none" aria-label="生成视频预览" src="/api/jobs/${encodeURIComponent(job.id)}/result?preview=1"></video>` : ""}
      <div class="job-actions">
        ${job.status === "draft" && job.mode === "image_to_video" ? `<button class="button ghost small" data-action="edit-job" data-job="${escapeHtml(job.id)}">编辑任务</button><button class="button primary small" data-action="start-job" data-job="${escapeHtml(job.id)}">开始生成</button><button class="text-button danger" data-action="cancel-job" data-job="${escapeHtml(job.id)}">取消任务</button>` : ""}
        ${job.status === "queued" ? `<button class="text-button danger" data-action="cancel-job" data-job="${escapeHtml(job.id)}">取消排队</button>` : ""}
        ${job.remoteUrl ? `<a class="text-button" href="${escapeHtml(job.remoteUrl)}" target="_blank" rel="noopener noreferrer" title="在当前浏览器打开，需要登录与此任务相同的平台账号；不共享云端浏览器登录态">平台原会话（需同一账号）</a>${job.accountId && state.desktopPort && !["leased", "submitting", "submitted", "generating", "collecting"].includes(job.status) ? `<a class="text-button" href="/accounts/${encodeURIComponent(job.accountId)}/login" target="_blank" rel="noopener noreferrer">打开对应账号窗口</a>` : ""}` : ""}
        ${job.status === "reconciling" && progress.action !== 'none' && isDolaModel(job.model) ? `<button class="button primary small" data-action="resume-verified-job" data-job="${escapeHtml(job.id)}">${progress.action === 'verify' ? '验证完成，继续任务' : progress.action === 'recollect' ? '重新收集原结果' : '核对并继续'}</button>${progress.action === 'verify' ? `<a class="text-button" href="/accounts/${encodeURIComponent(job.accountId)}/login" target="_blank" rel="noopener noreferrer">打开账号处理验证</a>` : ''}${!job.remoteUrl && job.model.startsWith('Dreamina') ? `<button class="text-button" data-action="attach-remote" data-job="${escapeHtml(job.id)}">手动绑定平台任务</button>` : ""}` : ""}
        ${job.status === "reconciling" && !job.nextReconcileAt && job.remoteUrl && !isDolaModel(job.model) ? `<button class="text-button" data-action="recollect-job" data-job="${escapeHtml(job.id)}">重新收集结果</button>` : ""}
        ${job.status === "success" ? `<a class="button primary small" href="/api/jobs/${encodeURIComponent(job.id)}/result">下载 MP4</a>` : ""}
        ${job.status === "success" && isDolaModel(job.model) ? `<a class="text-button" href="/api/jobs/${encodeURIComponent(job.id)}/result?original=1">下载平台原片</a>` : ""}
      </div>
    </div>
  `; }).join("") : `<div class="empty">${status === "success" ? "暂无生成成功的任务。" : status === "failed" ? "暂无生成失败的任务。" : status === "active" ? "暂无未完成的任务。" : "暂无任务。"}</div>`;
}

export async function refreshJobsPage() {
  const requestId = ++jobPageRequestId;
  const status = $("#jobStatusFilter").value;
  const page = await api(`/api/workbench/jobs?status=${encodeURIComponent(status)}&page=${selectedJobPage}&pageSize=6`);
  if (requestId !== jobPageRequestId) return;
  state.jobPage = page;
  selectedJobPage = page.page;
  renderJobs();
}

export function bindJobControls(refresh) {
  // A running server may still hold the previous page template in memory.
  $("#jobStatusFilter").querySelector('option[value="draft"]')?.remove();
  $("#jobModel").addEventListener("change", () => {
    syncDurationOptions();
    renderDeliveryNotice();
  });
  $("#jobAccount").addEventListener("change", () => {
    const account = state.accounts.find(item => item.id === $("#jobAccount").value);
    const models = supportedModels[account?.service];
    if (models && !models.includes($("#jobModel").value)) $("#jobModel").value = models[0];
    syncDurationOptions();
    renderDeliveryNotice();
  });
  document.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
  if (action.dataset.action === "edit-job") editDraft(action.dataset.job);
  if (action.dataset.action === "cancel-job") {
    try {
      await api(`/api/jobs/${encodeURIComponent(action.dataset.job)}/cancel`, { method: "POST", body: "{}" });
      if (editingJobId === action.dataset.job) resetDraftEditor();
      toast("任务已取消");
      await refresh();
    } catch (error) { toast(`取消失败：${error.message}`, true); }
  }
  if (action.dataset.action === "start-job") {
    action.disabled = true;
    try {
      const started = await api(`/api/jobs/${encodeURIComponent(action.dataset.job)}/start`,
        { method: "POST", body: "{}" });
      if (editingJobId === action.dataset.job) resetDraftEditor();
      toast(`已加入 ${started.jobs.length} 条生成任务，系统按可用容量执行，请在任务列表查看进度`);
      $("#jobStatusFilter").value = "all";
      selectedJobPage = 1;
      await refresh();
    } catch (error) { toast(`开始失败：${readableError(error.message)}`, true); }
    finally { action.disabled = false; }
  }
  if (action.dataset.action === "resume-verified-job") {
    action.disabled = true;
    const label = action.textContent;
    action.textContent = "正在核对并恢复…";
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(action.dataset.job)}/resume-after-verification`, {method:"POST",body:"{}"});
      toast(result.platformState === "failed" ? "平台已明确返回生成失败，请查看任务记录"
        : result.alreadyResumed ? "此任务已恢复，请查看当前进度"
          : result.resubmitted ? "验证已通过，原请求已补提交排队，保留原任务编号和扣点记录"
            : result.platformState === "pending" ? "验证已通过，平台已有原消息，尚未确认开始生成"
              : "已接回原任务，将继续生成跟踪和视频下载", result.platformState === "failed");
      await refresh();
    } catch (error) { toast(`尚未恢复：${readableError(error.message)}`, true); }
    finally { action.disabled = false; action.textContent = label; }
  }
  if (action.dataset.action === "attach-remote") {
    const remoteUrl = window.prompt("请在该账号的 Dola 窗口中核对提示词，复制本条视频任务地址（https://www.dola.com/chat/数字）。绑定后只收集现有结果，不会重新生成。");
    if (!remoteUrl?.trim()) return;
    action.disabled = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(action.dataset.job)}/attach-remote`, { method: "POST", body: JSON.stringify({ remoteUrl: remoteUrl.trim() }) });
      toast("已绑定平台任务，请点击“验证完成，继续任务”。");
      await refresh();
    } catch (error) { toast(`绑定失败：${readableError(error.message)}`, true); }
    finally { action.disabled = false; }
  }
  if (action.dataset.action === "recollect-job") {
    action.disabled = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(action.dataset.job)}/recollect`, { method: "POST", body: "{}" });
      toast("正在从平台重新收集视频，不会再次提交生成");
      await refresh();
    } catch (error) { toast(`收集失败：${readableError(error.message)}`, true); }
    finally { action.disabled = false; }
  }

  });
$("#jobStatusFilter").addEventListener("change", () => {
  selectedJobPage = 1;
  refreshJobsPage().catch((error) => toast(`筛选失败：${error.message}`, true));
});
$("#jobPrevPage").addEventListener("click", () => {
  if (selectedJobPage <= 1) return;
  selectedJobPage -= 1;
  refreshJobsPage().catch((error) => toast(`翻页失败：${error.message}`, true));
});
$("#jobNextPage").addEventListener("click", () => {
  if (selectedJobPage >= state.jobPage.totalPages) return;
  selectedJobPage += 1;
  refreshJobsPage().catch((error) => toast(`翻页失败：${error.message}`, true));
});

$("#jobStopEditingButton").addEventListener("click", () => resetDraftEditor());
$("#jobReferenceFile").addEventListener("change", (event) => {
  const picked = [...event.target.files].filter((file) => !selectedReferenceFiles.some((existing) =>
    existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified));
  if (picked.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.name)
    || (file.type && !["image/png", "image/jpeg", "image/webp"].includes(file.type)))) {
    toast(readableError("REFERENCE_IMAGE_INVALID_FORMAT"), true);
  } else if (picked.some((file) => file.size > 20 * 1024 * 1024)) {
    toast(readableError("REFERENCE_IMAGE_TOO_LARGE"), true);
  } else if (savedReferenceAssets.length + selectedReferenceFiles.length + picked.length > 9) {
    toast("最多选择 9 张图片", true);
  } else {
    selectedReferenceFiles.push(...picked);
  }
  renderSelectedFiles();
});
$("#jobSelectedFiles").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-reference]");
  if (!button || $("#jobForm").dataset.submitting === "true") return;
  const [kind, rawIndex] = button.dataset.removeReference.split(":");
  if (kind === "saved") savedReferenceAssets.splice(Number(rawIndex), 1);
  else selectedReferenceFiles.splice(Number(rawIndex), 1);
  renderSelectedFiles();
});
$("#jobForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const data = Object.fromEntries(form);
  data.mode = "image_to_video";
  data.durationSeconds = Number(data.durationSeconds);
  data.concurrency = Number(data.concurrency);
  data.priority = 50;
  data.referenceAssets = savedReferenceAssets.map((asset) => asset.path);
  data.referenceAssetNames = savedReferenceAssets.map((asset) => asset.name);
  const validationError = jobValidationError(data, data.referenceAssets.length + selectedReferenceFiles.length);
  if (validationError) { toast(validationError, true); return; }
  formElement.dataset.submitting = "true";
  formElement.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = true; });
  $("#jobReferenceFile").disabled = true;
  renderSelectedFiles();
  let savedJobId = null;
  try {
    for (const file of selectedReferenceFiles) {
      if (file.size > 20 * 1024 * 1024) throw new Error("REFERENCE_IMAGE_TOO_LARGE");
      let uploadedPath = uploadedReferencePaths.get(file);
      if (!uploadedPath) {
        const uploaded = await api("/api/assets", {
          method: "POST", body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        uploadedPath = uploaded.path;
        uploadedReferencePaths.set(file, uploadedPath);
      }
      data.referenceAssets.push(uploadedPath);
      data.referenceAssetNames.push(file.name);
    }
    const savingEdit = Boolean(editingJobId);
    const saved = await api(savingEdit ? `/api/jobs/${encodeURIComponent(editingJobId)}` : "/api/jobs",
      { method: savingEdit ? "PATCH" : "POST", body: JSON.stringify(data) });
    savedJobId = saved.job.id;
    const started = await api(`/api/jobs/${encodeURIComponent(saved.job.id)}/start`,
      { method: "POST", body: "{}" });
    resetDraftEditor();
    $("#jobAccount").value = data.accountId;
    $("#jobModel").value = data.model;
    $("#jobDuration").value = String(data.durationSeconds);
    $("#jobAspectRatio").value = data.aspectRatio;
    $("#jobConcurrency").value = String(data.concurrency);
    toast(`已使用 ${started.jobs.length} 个账号开始生成，请在任务列表查看进度`);
    $("#jobStatusFilter").value = "all";
    selectedJobPage = 1;
    await refresh();
  } catch (error) {
    if (savedJobId) resetDraftEditor();
    toast(savedJobId ? `任务已记录，但启动失败：${readableError(error.message)}；可在任务列表重试`
      : `任务处理失败：${readableError(error.message)}`, true);
    await refresh().catch(() => {});
  }
  finally {
    delete formElement.dataset.submitting;
    formElement.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = false; });
    $("#jobReferenceFile").disabled = false;
    renderSelectedFiles();
  }
});

}
