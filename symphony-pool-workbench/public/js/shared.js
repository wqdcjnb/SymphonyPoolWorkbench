export const state = {
  accounts: [], busyAccountIds: [], jobs: [], events: [], overview: null, automationEnabled: false,
  jobPage: { jobs: [], status: "all", page: 1, pageSize: 6, total: 0, totalPages: 1 },
  eventPage: { events: [], page: 1, pageSize: 10, total: 0, totalPages: 1 },
};
export const statusLabel = {
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

export const modeLabel = {
  reference_to_video: "参考素材转视频",
  image_to_video: "视频生成",
  text_to_video: "文生视频",
};
export const jobStatusLabel = {
  draft: "草稿", queued: "排队中", leased: "启动中", submitting: "提交中", submitted: "已提交",
  generating: "生成中", collecting: "保存视频中", reconciling: "需核对平台",
  success: "已完成", failed: "失败", blocked: "需处理", cancelled: "已取消",
};
export const supportedModels = {
  doubao: ["Seedance 2.0 Fast", "Seedance 2.0 Mini"],
  symphony: ["Video 1.5 Pro"],
};
export const supportedDurations = { doubao: [5, 10], symphony: [5, 10, 12] };
export const supportedImageLimits = { doubao: 9, symphony: 4 };
export const $ = (selector) => document.querySelector(selector);
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
export const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
export const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "尚未验收";
export const beijingDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const formatBeijingTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "待读取";
export const isDoubao = (account) => account.service === "doubao" || account.loginType === "doubao";

const errorMessage = {
  LOGIN_REQUIRED: "尚未登录。请在专用窗口完成登录，关闭窗口后再验收。",
  LOGIN_EXPIRED_DURING_SUBMISSION: "平台在提交时要求重新登录，任务已暂停待核对；请重新登录并检查平台记录，避免重复生成。",
  DOUBAO_SUBMISSION_UNCONFIRMED: "豆包未返回有效任务地址，需核对平台记录后再处理，避免重复生成。",
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
  DOUBAO_RESPONSE_TIMEOUT: "豆包未及时返回生成指令，请打开平台任务核对。",
  DOUBAO_GENERATION_TIMEOUT: "豆包生成超时，请打开平台任务核对，完成后可重新收集结果。",
  DOUBAO_FREE_QUOTA_EXHAUSTED: "豆包提示今日免费生成次数已用完，请明天再使用该账号。",
  PYTHON_NOT_CONFIGURED: "未找到 Python 环境，请按 README 安装验收依赖。",
  DISPLAY_NOT_CONFIGURED: "服务器虚拟桌面未启动，请检查 symphony-display 服务。",
  INVALID_BROWSER_CHANNEL: "浏览器配置无效，请检查 WORKBENCH_BROWSER_CHANNEL。",
  PROFILE_LAUNCH_FAILED: "浏览器窗口启动失败，请检查浏览器安装及虚拟桌面。",
  PROFILE_DESKTOP_FAILED: "此账号的 Xpra 登录窗口启动失败，请检查 Xpra 服务后重试。",
  PROFILE_CLOSE_FAILED: "登录窗口未能正常结束，请稍后重试；账号档案已保留。",
  PROFILE_CLOSE_UNSUPPORTED: "请直接关闭本机 Chrome 登录窗口。",
  PROFILE_LAUNCH_TIMEOUT: "浏览器窗口启动超时，请检查服务器负载和虚拟桌面。",
  ACCOUNT_ALREADY_EXISTS: "账号编号已存在，请换一个编号。",
  ACCOUNT_NOT_FOUND: "账号不存在，请刷新页面。",
  ACCOUNT_ID_CASE_CONFLICT: "仅修改编号字母大小写暂不支持，请换一个编号。",
  ACCOUNT_PROFILE_IN_USE: "该账号的浏览器正在运行或启动，请关闭账号浏览器窗口后再操作；只关闭远程桌面标签页不会关闭账号浏览器。",
  ACCOUNT_BROWSER_BUSY: "可用账号的浏览器正被登录或验收占用，释放后将自动开始；只关闭远程桌面标签页不会关闭里面的浏览器。",
  ACCOUNT_PROFILE_STATE_UNKNOWN: "无法确认浏览器档案的占用状态，请检查运行权限或档案是否被其他主机使用。",
  ACCOUNT_PROFILE_ALREADY_EXISTS: "新编号对应的浏览器档案目录已存在，请换一个编号。",
  ACCOUNT_PROFILE_NOT_DIRECTORY: "当前浏览器档案路径不是目录，请检查后重试。",
  ACCOUNT_PROFILE_PATH_INVALID: "当前浏览器档案路径与账号编号不一致，无法自动迁移。",
  ACCOUNT_PROFILE_MOVE_FAILED: "迁移浏览器档案失败，请检查本地文件权限。",
  ACCOUNT_PROFILE_ROLLBACK_FAILED: "账号修改未完成，浏览器档案回退失败，请检查本地目录。",
  ACCOUNT_HAS_PENDING_JOBS: "此账号还有待处理或需核对的任务，请先完成或取消任务。",
  VERIFICATION_ALREADY_RUNNING: "该账号正在验收，请完成后再修改编号。",
  INVALID_ACCOUNT_ID: "账号编号格式无效，请使用字母、数字、点、下划线或连字符。",
  LABEL_REQUIRED: "请输入显示名称。",
  LABEL_TOO_LONG: "显示名称最多 80 个字符。",
  ACCOUNT_NOT_READY: "账号尚未通过验收，请先在账号池验收。",
  ACCOUNT_ALREADY_RUNNING: "此账号已有任务正在执行或等待核对。",
  MODEL_NOT_VERIFIED_FOR_ACCOUNT: "该账号尚未验收此模型，请重新验收账号。",
  REFERENCE_IMAGE_NOT_FOUND: "本地图片路径不存在。",
  REFERENCE_IMAGE_INVALID_FORMAT: "图片格式不支持，请使用 PNG、JPG 或 WebP。",
  REFERENCE_IMAGE_ABSOLUTE_PATH_REQUIRED: "请输入本机图片的绝对路径。",
  REFERENCE_IMAGE_TOO_LARGE: "图片不能超过 20 MB。",
  PAYLOAD_TOO_LARGE: "请求内容过大。",
  REFERENCE_IMAGE_COUNT_INVALID: "参考图片最多 9 张。",
  REFERENCE_VIDEO_REQUIRED: "请选择 1 条参考视频。",
  REFERENCE_VIDEO_NOT_FOUND: "参考视频文件不存在，请重新选择。",
  REFERENCE_VIDEO_NOT_FILE: "参考视频路径不是文件，请重新选择。",
  REFERENCE_VIDEO_ABSOLUTE_PATH_REQUIRED: "参考视频路径无效，请重新选择。",
  REFERENCE_VIDEO_INVALID_FORMAT: "参考视频仅支持 MP4 或 MOV，建议使用 MP4。",
  REFERENCE_VIDEO_TOO_LARGE: "参考视频不能超过 50 MB。",
  REFERENCE_VIDEO_NOT_ALLOWED: "此任务不接收参考视频。",
  REFERENCE_VIDEO_MODEL_UNAVAILABLE: "参考素材转视频只支持豆包 Seedance 2.0 Fast。",
  INVALID_ASPECT_RATIO: "视频比例不受支持。",
  INVALID_MODEL: "请选择三个可用模型之一。",
  INVALID_CONCURRENCY: "并发数须为 1–8 的整数。",
  CONCURRENCY_REQUIRES_AUTO_ACCOUNT: "并发大于 1 时须自动分配账号。",
  CONCURRENCY_REQUIRES_IMMEDIATE_START: "多账号并发任务请直接开始生成。",
  INSUFFICIENT_ELIGIBLE_ACCOUNTS: "符合条件的可用账号不足，整批未启动。",
  IDEMPOTENCY_CONFLICT: "相同请求编号的参数不一致，请使用新编号。",
  invalid_api_key: "请求方的 API Key 无效或已过期。",
  insufficient_points: "请求方的 API 额度不足。",
  VIDEO_API_RESULT_SAVE_FAILED: "视频结果保存失败，后台将重试。",
  VIDEO_API_RESULT_UNAVAILABLE: "视频结果暂不可下载，后台将重试。",
  PROMPT_TOO_LONG: "正向和负面提示词合计过长，请缩短后重试。",
  ASPECT_RATIO_SELECTION_FAILED: "豆包未能设置所选视频比例，请检查平台页面。",
  MULTI_IMAGE_UPLOAD_UNAVAILABLE: "TikTok 多图上传控件暂不可用，请检查平台页面。",
  REFERENCE_ASSET_NAMES_INVALID: "参考图片信息不完整，请重新选择图片。",
  JOB_NOT_EDITABLE: "此任务已开始或已取消，不能再编辑草稿。",
  JOB_NOT_QUEUEABLE: "此任务已排队、开始或结束，不能再次排队。",
  WORKER_NOT_CONFIGURED: "视频生成执行环境尚未安装完整。",
  SERVICE_NOT_CONNECTED: "该账号所属平台暂不支持此任务模式。",
  CONFIRMED_NOT_SUBMITTED: "平台未收到本次提交，请重新建立任务。",
  JOB_NOT_RECOLLECTABLE: "此任务没有可重新收集的平台结果链接。",
  JOB_PARAMETERS_INVALID: "所选账号、模型、时长、素材数量和视频比例不能组合使用。",
  NO_ELIGIBLE_ACCOUNT: "当前没有符合模型、时长、素材数量、比例和额度要求的可用账号。",
};
export const readableError = (code) => errorMessage[code] || code;

export async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

export function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = isError ? "show error" : "show";
  window.setTimeout(() => { node.className = ""; }, 3200);
}
