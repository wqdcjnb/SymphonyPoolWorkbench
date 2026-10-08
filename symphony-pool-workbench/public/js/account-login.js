import { api, readableError } from "./shared.js";

const accountId = decodeURIComponent(window.location.pathname.split("/")[2] || "");
const loginItem = new URLSearchParams(window.location.search).get('loginItem');
const viewerStorage='symphony-browser-viewer';
let viewerId;
try{viewerId=window.localStorage.getItem(viewerStorage);}catch{}
if(!/^[a-f0-9]{64}$/.test(viewerId||'')){
  viewerId=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
  try{window.localStorage.setItem(viewerStorage,viewerId);}catch{}
}
const picker=document.querySelector('#loginAccountPicker');
async function refreshBrowsers(){
  try{
    const result=await api('/api/browser-sessions');
    picker.replaceChildren();
    for(const account of result.accounts||[]){
      const option=document.createElement('option');option.value=account.id;
      option.textContent=`${account.label} · ${account.busy?'执行中':account.running?'浏览器运行中':account.resident?'正在恢复':'待登录'}`;
      option.disabled=result.managed&&!account.local;picker.append(option);
    }
    picker.value=accountId;
    const current=result.accounts?.find(a=>a.id===accountId);
    document.querySelector('#residentState').textContent=current?.running
      ? `浏览器正在运行${current.resident?' · 已启用持续保留':''}。平台登录是否有效以账号验收状态为准。`
      : current?.resident?`已启用持续保留${current.error?' · '+readableError(current.error):' · 正在恢复浏览器'}`:'完成登录验收后，浏览器会自动持续保留。';
  }catch{document.querySelector('#residentState').textContent='暂时无法读取浏览器状态';}
}
async function detachViewer(){await api('/api/browser-viewer/detach',{method:'POST',body:JSON.stringify({viewerId})});}
picker.addEventListener('change',async()=>{
  if(!picker.value||picker.value===accountId||busy)return;
  const selected=picker.value;picker.disabled=true;
  try{await detachViewer();window.location.assign(`/accounts/${encodeURIComponent(selected)}/login`);}
  catch(error){status.textContent=`切换失败：${readableError(error.message)}`;picker.value=accountId;picker.disabled=false;}
});
let loginPhone = '';
document.querySelector('#manageLoginIdentity').href=`/pool?account=${encodeURIComponent(accountId)}`;
api(`/api/pool/identity/${encodeURIComponent(accountId)}`).then(identity=>{
  loginPhone=identity.identifier||'';
  document.querySelector('#loginIdentity').textContent=identity.loginMethod==='phone_sms'
    ? `手机号 + 短信验证码登录 · ${loginPhone||'尚未保存手机号'}`
    : `Cookie 登录 · ${identity.cookieFingerprint||'尚未保存 Cookie'}`;
  document.querySelector('#copyLoginPhone').hidden=!loginPhone;
}).catch(()=>{document.querySelector('#loginIdentity').textContent='暂时无法读取登录资料，请返回账号池检查。';});
document.querySelector('#copyLoginPhone').onclick=async()=>{
  try{await navigator.clipboard.writeText(loginPhone);document.querySelector('#loginStatus').textContent='登录手机号已复制';}
  catch{document.querySelector('#loginStatus').textContent='请选中上方手机号手动复制。';}
};
const status = document.querySelector("#loginStatus");
const retry = document.querySelector("#loginRetry");
const actions = document.querySelector("#loginActions");
const native = document.querySelector("#loginNative");
const download = document.querySelector("#loginDownload");
const finish = document.querySelector("#loginFinish");
const recovery = document.querySelector("#loginRecovery");
const recoveryStatus = document.querySelector("#recoveryStatus");
const resume = document.querySelector("#loginResume");
let recoveryJobId = null;
let recoveryError = null;
let resumed = false;
let progressTimer;
let fileUrl;
let busy = false;

async function refreshRecovery() {
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/pending-verification`);
    const jobs = result.jobs || [];
    if (!jobs.length) return;
    recovery.hidden = false;
    recoveryJobId = jobs.length === 1 ? jobs[0].id : null;
    resume.hidden = !recoveryJobId;
    finish.hidden = true;
    const progress = jobs[0]?.progress;
    if (progress) {
      resume.textContent = progress.action === 'verify' ? '验证完成，继续任务'
        : progress.action === 'recollect' ? '重新收集原结果' : '核对并继续';
      resume.hidden = !recoveryJobId || progress.action === 'none';
    }
    recoveryStatus.textContent = recoveryJobId && progress ? `${progress.label}：${progress.description}` : recoveryJobId
      ? ['DOUBAO_HUMAN_VERIFICATION_REQUIRED','DOLA_HUMAN_VERIFICATION_REQUIRED'].includes(jobs[0].errorCode)
        ? "任务正在等待验证。请完成此账号的验证码，保留 Chrome 窗口，再点击“验证完成，继续任务”。"
        : `任务需要核对：${readableError(jobs[0].errorCode || 'DOUBAO_SUBMISSION_UNCONFIRMED')} 保留窗口后可点击继续任务。`
      : "此账号有多条待核对任务，请前往任务页面逐条处理。";
    if (recoveryJobId && !progressTimer) progressTimer = window.setTimeout(trackRecoveredJob,5000);
  } catch {
    recovery.hidden = false;
    resume.hidden = true;
    recoveryStatus.textContent = "暂时无法读取视频任务状态，请到任务页面查看。";
  }
}

async function trackRecoveredJob(allowDuringResume = false) {
  if (progressTimer) window.clearTimeout(progressTimer);
  if (busy && !allowDuringResume) { progressTimer = window.setTimeout(trackRecoveredJob, 1000); return; }
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(recoveryJobId)}`);
    if (busy && !allowDuringResume) { progressTimer = window.setTimeout(trackRecoveredJob, 1000); return; }
    const labels = {queued:job.collectOnly ? "已接回原任务，排队等待继续收集" : "原请求已排队，等待向平台提交",
      leased:job.collectOnly ? "正在连接原平台任务" : "正在准备原请求",submitting:"正在向平台提交原请求",
      submitted:"平台已接受原任务",generating:"生成中：正在跟踪原平台任务",
      collecting:"保存视频中：平台已完成，正在下载和处理视频",success:"视频已保存。API 请求的修补与交付状态请以 API 结果为准",
      reconciling:"任务仍需处理",failed:"任务失败",cancelled:"任务已取消"};
    recoveryStatus.textContent = job.progress ? `${job.progress.label}：${job.progress.description}`
      : (labels[job.status] || job.status) + (job.errorCode ? `：${readableError(job.errorCode)}` : "。");
    if (job.status === "reconciling") {
      if (recoveryError) recoveryStatus.textContent += `\n本次继续操作未完成：${recoveryError}`;
      resumed = false; resume.hidden = job.progress?.action === 'none'; retry.hidden = false;
      resume.textContent = job.progress?.action === 'recollect' ? '重新收集原结果'
        : job.progress?.action === 'verify' ? '验证完成，继续任务' : '核对并继续';
    } else { resume.hidden = true; recoveryError = null; }
    if (!["success","failed","cancelled"].includes(job.status)) {
      progressTimer = window.setTimeout(trackRecoveredJob, 5000);
    }
  } catch {
    recoveryStatus.textContent = "暂时无法读取进度，请点击“查看任务进度”刷新确认。";
    progressTimer = window.setTimeout(trackRecoveredJob, 5000);
  }
}
document.querySelector("#loginAccount").textContent = `账号：${accountId}`;
document.title = `${accountId} · 账号浏览器`;

async function openLogin() {
  if (busy) return null;
  busy = true;
  retry.hidden = true;
  actions.hidden = true;
  native.removeAttribute("href");
  download.removeAttribute("href");
  status.textContent = "正在准备此账号的 Chrome 窗口…";
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/open`, { method: "POST", body: JSON.stringify({viewerId}) });
    if (!result.desktop) {
      status.textContent = "此账号的浏览器窗口已打开，可关闭本标签页。";
      return;
    }
    const { protocol, port, token, accountId: desktopAccount } = result.desktop;
    if (protocol !== "xpra" || desktopAccount !== accountId || !Number.isInteger(port) || port < 1 || port > 65535
      || !/^[a-f0-9]{64}$/.test(token)) throw new Error("PROFILE_DESKTOP_FAILED");
    // HTTPS deployments carry desktop traffic through the authenticated site's
    // TLS gateway. HTTP/SSH tunnel deployments retain their separate local port.
    const secure = window.location.protocol === "https:";
    const transport = secure ? "wss" : "ws";
    const connectionPort = secure ? Number(window.location.port || 443) : port;
    const connectionPath = secure ? `xpra/${token}` : token;
    const host = window.location.hostname;
    // window-close is rejected by Xpra's URL parser; the native launcher and
    // downloaded connection file set it through supported configuration paths.
    const clientOptions = new URLSearchParams({ splash: "no", opengl: "no", clipboard: "yes",
      "clipboard-direction": "both", notifications: "no", title: "@title@ - @session-name@" });
    native.href = `xpra+${transport}://${host}:${connectionPort}/${connectionPath}?${clientOptions}`;
    const config = ["# Symphony account login", `mode=${transport}`, `host=${host}`, `port=${connectionPort}`,
      `path=${connectionPath}`, "autoconnect=true", "clipboard=yes", "clipboard-direction=both",
      "splash=no", "opengl=no", "window-close=disconnect", "video-decoders=openh264", "audio=no",
      "speaker=disabled", "microphone=disabled", "webcam=no", "printing=no", "file-transfer=no",
      "open-files=no", "open-url=no", "notifications=no", "title=@title@ — @session-name@", ""].join("\n");
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(new Blob([config], { type: "application/x-xpra" }));
    download.href = fileUrl;
    download.download = `${accountId}.xpra`;
    actions.hidden = false;
    finish.disabled = false;
    if (!resumed) await refreshRecovery();
    status.textContent = "当前账号已准备好。点击“查看当前账号”连接 Xpra，其他浏览器继续在后台运行。";
    void refreshBrowsers();
    return native.href;
  } catch (error) {
    status.textContent = `打开失败：${readableError(error.message)}`;
    retry.hidden = false;
    return null;
  } finally {
    busy = false;
  }
}
native.addEventListener("click", async (event) => {
  event.preventDefault();
  // Closing Chrome also ends its Xpra session. Resolve a live connection on
  // every click; the link prepared when this page loaded may have expired.
  const connection = await openLogin();
  if (!connection) return;
  // A slow server start can outlast Chrome's user activation. Keep a ready,
  // explicit next click instead of silently attempting a blocked app launch.
  if (navigator.userActivation?.isActive === false) {
    status.textContent = "窗口已重新准备好。请再点一次“查看当前账号”进入。";
    return;
  }
  status.textContent = "正在请求打开 Xpra；如浏览器询问是否打开应用，请选择打开。";
  window.location.assign(connection);
});
finish.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  finish.disabled = true;
  status.textContent = "正在检查登录结果并保留后台浏览器…";
  try {
    if(loginItem){
      const result=await api('/api/pool/login/finish',{method:'POST',body:JSON.stringify({id:loginItem,accountId})});
      if(!result.ok)throw new Error('登录验收未通过，请返回账号池检查登录进度。');
    }else{
      const result=await api(`/api/accounts/${encodeURIComponent(accountId)}/verify`,{method:'POST',body:'{}'});
      if(!result.result?.loggedIn&&!result.result?.ok)throw new Error('LOGIN_REQUIRED');
    }
    await detachViewer();
    status.textContent = "登录验收完成，浏览器持续在后台运行。可以选择其他账号查看。";
    await refreshBrowsers();
  } catch (error) {
    status.textContent = `尚未完成：${readableError(error.message)}`;
  } finally {
    busy = false;
    finish.disabled = false;
  }
});
resume.addEventListener("click", async () => {
  if (busy || !recoveryJobId) return;
  busy = true; resume.disabled = true; finish.disabled = true;
  recoveryError = null;
  recoveryStatus.textContent = "正在核对原会话，确认平台进度并恢复后续处理，请稍候…";
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(recoveryJobId)}/resume-after-verification`, {method:"POST",body:"{}"});
    resumed = true;
    resume.hidden = true; actions.hidden = true; retry.hidden = true;
    status.textContent = result.resubmitted ? "验证已通过，原请求已补提交排队。任务编号和工作台扣点记录保持不变。"
      : result.platformState === 'pending' ? "验证已通过，平台已有原消息，正在等待明确的生成结果。"
        : "验证处理已完成，工作台已接回此任务。";
    await trackRecoveredJob(true);
  } catch (error) {
    recoveryError = readableError(error.message);
    recoveryStatus.textContent = `尚未恢复：${recoveryError}`;
    retry.hidden = false;
  } finally {
    busy = false; resume.disabled = false; finish.disabled = false;
  }
});
retry.addEventListener("click", openLogin);
document.querySelector('#loginDetach').addEventListener('click',async()=>{
  if(busy)return;busy=true;
  try{await detachViewer();status.textContent='已收起查看窗口，后台浏览器继续运行。';}
  catch(error){status.textContent=`收起失败：${readableError(error.message)}`;}
  finally{busy=false;}
});
void refreshBrowsers();
openLogin();
