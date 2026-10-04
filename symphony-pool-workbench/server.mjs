import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createStore } from "./lib/db.mjs";
import { createVideoApiStore } from "./lib/video-api-store.mjs";
import { createVideoApiScheduler } from "./lib/video-api-scheduler.mjs";
import { createVideoApiClient, VideoApiError, apiKeyFromRequest, apiKeyFingerprint,
  imageContentType, validateGeneration, validateIdempotencyKey, validateTaskId } from "./lib/nocsnow-api.mjs";
import { createQueueScheduler } from "./lib/queue-scheduler.mjs";
import { createPartnerApi } from "./lib/partner-api.mjs";
import { renderPage } from "./lib/pages.mjs";
import { documentationFile } from "./lib/api-docs.mjs";
import { browserRuntime, profileLaunchCommand } from "./lib/browser-runtime.mjs";
import { profileInUse } from "./lib/profile-usage.mjs";
import { AUTO_SELECTION, ALL_VIDEO_MODELS, ALL_VIDEO_DURATIONS, VIDEO_ASPECT_RATIOS,
  hasCompatibleService } from "./lib/job-routing.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = path.resolve(projectRoot, "..");
const publicRoot = path.join(projectRoot, "public");
const DEFAULT_ACCOUNT_ID = "xzkj-pc-01-symphony-01";
const DEFAULT_WORKER_ID = "xzkj-pc-01";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOGIN_TYPES = new Set(["tiktok", "doubao"]);
const MODEL_OPTIONS = new Set([
  "Dreamina Seedance 2.0",
  "Dreamina Seedance 2.0 Mini",
  "Dreamina Seedance 2.0 Fast",
  "Video 1.5 Pro",
]);
const DOUBAO_MODEL_OPTIONS = new Set([
  "Seedance 2.5",
  "Seedance 2.0",
  "Seedance 2.0 Fast",
  "Seedance 2.0 Mini",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}
function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function boundedText(value, name, maxLength, allowEmpty = false) {
  const normalized = String(value ?? "").trim();
  if (!allowEmpty && !normalized) throw new Error(`${name}_REQUIRED`);
  if (normalized.length > maxLength) throw new Error(`${name}_TOO_LONG`);
  return normalized;
}

function safeAccountId(value) {
  const id = boundedText(value, "ACCOUNT_ID", 128);
  if (!ACCOUNT_ID_PATTERN.test(id)) throw new Error("INVALID_ACCOUNT_ID");
  return id;
}

function resolveProfilePath(workspaceRoot, accountId) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const candidate = path.resolve(resolvedRoot, `${accountId}_sandbox_data`);
  if (path.dirname(candidate) !== resolvedRoot || path.basename(candidate) !== `${accountId}_sandbox_data`) {
    throw new Error("INVALID_PROFILE_PATH");
  }
  return candidate;
}

function pathEntryExists(filePath) {
  try { fs.lstatSync(filePath); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function sameOriginAllowed(request, host, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return new Set([`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]).has(origin);
}

function parseVerifierOutput(stdout, loginType) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("EMPTY_VERIFIER_OUTPUT");
  const parsed = JSON.parse(lines.at(-1));
  const permittedModels = loginType === "doubao" ? DOUBAO_MODEL_OPTIONS : MODEL_OPTIONS;
  return {
    ok: Boolean(parsed.ok),
    loggedIn: Boolean(parsed.loggedIn),
    creditPageReady: Boolean(parsed.creditPageReady),
    createPageReady: Boolean(parsed.createPageReady),
    remainingCredits: Number.isInteger(parsed.remainingCredits) ? parsed.remainingCredits : null,
    totalCredits: Number.isInteger(parsed.totalCredits) ? parsed.totalCredits : null,
    creditsEstimated: loginType === "doubao" && parsed.creditsEstimated === true,
    nextRefresh: typeof parsed.nextRefresh === "string" ? parsed.nextRefresh : null,
    videosCreatedToday: Number.isInteger(parsed.videosCreatedToday) && parsed.videosCreatedToday >= 0
      ? parsed.videosCreatedToday : null,
    videoCountDate: typeof parsed.videoCountDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.videoCountDate)
      ? parsed.videoCountDate : null,
    referenceImageLimit: Number.isInteger(parsed.referenceImageLimit) ? parsed.referenceImageLimit : null,
    modelsObserved: Array.isArray(parsed.modelsObserved)
      ? parsed.modelsObserved.filter((item) => permittedModels.has(item))
      : [],
    stage: typeof parsed.stage === "string" ? parsed.stage.slice(0, 80) : null,
    error: typeof parsed.error === "string" ? parsed.error.slice(0, 160) : null,
  };
}

async function readUpload(request, maxBytes, tooLargeError) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(tooLargeError);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

function videoExtension(bytes) {
  if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") return null;
  const brand = bytes.toString("ascii", 8, 12);
  if (brand === "qt  ") return ".mov";
  return new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "MSNV",
    "3gp4", "3gp5", "3gp6", "dash", "cmfc", "cmfs"]).has(brand) ? ".mp4" : null;
}

function validateImage(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("REFERENCE_IMAGE_ABSOLUTE_PATH_REQUIRED");
  let stat;
  try { stat = fs.statSync(filePath); } catch { throw new Error("REFERENCE_IMAGE_NOT_FOUND"); }
  if (!stat.isFile()) throw new Error("REFERENCE_IMAGE_NOT_FILE");
  if (stat.size > 20 * 1024 * 1024) throw new Error("REFERENCE_IMAGE_TOO_LARGE");
  const bytes = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, bytes, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (!imageExtension(bytes)) throw new Error("REFERENCE_IMAGE_INVALID_FORMAT");
}

function validateVideo(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("REFERENCE_VIDEO_ABSOLUTE_PATH_REQUIRED");
  let stat;
  try { stat = fs.statSync(filePath); } catch { throw new Error("REFERENCE_VIDEO_NOT_FOUND"); }
  if (!stat.isFile()) throw new Error("REFERENCE_VIDEO_NOT_FILE");
  if (stat.size > 50 * 1024 * 1024) throw new Error("REFERENCE_VIDEO_TOO_LARGE");
  const bytes = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, bytes, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (!videoExtension(bytes)) throw new Error("REFERENCE_VIDEO_INVALID_FORMAT");
}

function validateRemoteUrl(service, url) {
  if (!url) return null;
  const parsed = new URL(url);
  const expectedHost = service === "doubao" ? "www.doubao.com" : "ads.tiktok.com";
  if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost) throw new Error("INVALID_REMOTE_URL");
  if (service === "symphony") {
    const taskId = parsed.searchParams.get("activeId");
    if (taskId && /^\d+$/.test(taskId)) return `${parsed.origin}${parsed.pathname}?activeId=${taskId}`;
  }
  return parsed.origin + parsed.pathname;
}

export function createWorkbenchServer(options = {}) {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("LOCAL_HOST_REQUIRED");
  const port = Number(options.port || 8787);
  const workspaceRoot = path.resolve(options.workspaceRoot || defaultWorkspaceRoot);
  const profileRoot = path.resolve(options.profileRoot || workspaceRoot);
  const databasePath = path.resolve(options.databasePath || path.join(projectRoot, "data", "workbench.sqlite"));
  const verifierPath = path.resolve(options.verifierPath || path.join(workspaceRoot, "tools", "verify-symphony-profile.py"));
  const doubaoVerifierPath = path.resolve(options.doubaoVerifierPath || path.join(workspaceRoot, "tools", "verify-doubao-profile.py"));
  const workerPath = path.resolve(options.workerPath || path.join(workspaceRoot, "tools", "run-image-to-video.py"));
  const generatedRoot = path.resolve(options.generatedRoot || path.join(projectRoot, "data", "generated"));
  const uploadRoot = path.resolve(options.uploadRoot || path.join(projectRoot, "data", "uploads"));
  const runtime = browserRuntime({ projectRoot, workspaceRoot, platform: options.runtimePlatform,
    pythonExecutable: options.pythonExecutable, launcherPath: options.launcherPath });
  const { launcherPath, pythonExecutable } = runtime;
  const desktopPort = runtime.windows ? null : Number(options.desktopPort || process.env.WORKBENCH_DESKTOP_PORT || 6080);
  const store = createStore(databasePath);
  const videoApiStore = createVideoApiStore(databasePath);
  const videoApi = createVideoApiClient({ baseUrl: options.videoApiBaseUrl });
  const apiGeneratedRoot = path.join(generatedRoot, "video-api");
  const saveVideoApiResult = async (key, taskId) => {
    validateTaskId(taskId);
    const destination = path.join(apiGeneratedRoot, `${taskId}.mp4`);
    if (fs.existsSync(destination)) return destination;
    const upstream = await videoApi.result(key, taskId);
    if (!upstream.body || upstream.status !== 200
      || !upstream.headers.get("content-type")?.startsWith("video/mp4")) {
      throw new VideoApiError(502, "VIDEO_API_INVALID_RESULT");
    }
    const maxBytes = 512 * 1024 * 1024;
    if (Number(upstream.headers.get("content-length")) > maxBytes) {
      throw new VideoApiError(413, "VIDEO_API_RESULT_TOO_LARGE");
    }
    fs.mkdirSync(apiGeneratedRoot, { recursive: true });
    const temporary = path.join(apiGeneratedRoot, `${taskId}.${randomUUID()}.part`);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new VideoApiError(413, "VIDEO_API_RESULT_TOO_LARGE") : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(upstream.body), limit,
        fs.createWriteStream(temporary, { flags: "wx" }));
      if (!bytes) throw new VideoApiError(502, "VIDEO_API_INVALID_RESULT");
      fs.renameSync(temporary, destination);
      return destination;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  };
  const videoApiScheduler = createVideoApiScheduler({ store: videoApiStore, client: videoApi,
    saveResult: saveVideoApiResult,
    intervalMs: options.videoApiSchedulerIntervalMs ?? 10_000,
    maxActiveTasks: options.videoApiMaxActiveTasks ?? 8 });
  const workbenchJobsPage = ({ status, page, pageSize }) => {
    const listing = videoApiStore.listWorkbenchIndex({ status, page, pageSize });
    const jobs = listing.items.map((item) => {
      if (item.source === "account_pool") {
        const job = store.getJob(item.id);
        return job ? { ...job, source: "account_pool" } : null;
      }
      const batch = videoApiStore.getWorkbenchBatch(Number(item.id));
      if (!batch) return null;
      const failed = batch.tasks.some((task) => task.status === "failed");
      const displayStatus = batch.status === "completed" ? failed ? "failed" : "success"
        : batch.status === "running" ? "generating" : batch.status;
      return {
        source: "video_api", id: `video-api:${batch.id}`, providerBatchId: batch.id,
        status: displayStatus, prompt: batch.payload.prompt,
        negativePrompt: batch.payload.negative_prompt,
        model: batch.payload.model, durationSeconds: batch.payload.duration,
        aspectRatio: batch.payload.ratio, resolution: batch.payload.resolution,
        referenceCount: batch.payload.reference_asset_ids.length,
        requestedCount: batch.requestedCount, dispatchedCount: batch.dispatchedCount,
        tasks: batch.tasks.map((task) => ({ id: task.id, status: task.status,
          resultReady: task.resultSaved, resultErrorCode: task.resultErrorCode })),
        errorCode: batch.errorCode, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
      };
    }).filter(Boolean);
    return { jobs, status: listing.status, page: listing.page, pageSize: listing.pageSize,
      total: listing.total, totalPages: listing.totalPages };
  };
  const verificationLocks = new Set();
  const profileLaunchLocks = new Set();
  const profileRetryAfter = new Map();
  const activeProcesses = new Set();
  const schedulerIntervalMs = Number(options.schedulerIntervalMs ?? process.env.WORKBENCH_SCHEDULER_INTERVAL_MS ?? 2_000);
  const maxConcurrentJobs = Number(options.maxConcurrentJobs ?? process.env.WORKBENCH_MAX_CONCURRENT_JOBS ?? 2);
  const maxVerificationAgeMs = Number(options.maxVerificationAgeMs ?? 24 * 60 * 60_000);

  const parseVideoJob = (body) => {
    const unified = body.mode === undefined || body.concurrency !== undefined
      || body.negativePrompt !== undefined || body.positivePrompt !== undefined;
    const mode = boundedText(body.mode || "image_to_video", "MODE", 40);
    const model = boundedText(body.model, "MODEL", 80);
    if (!new Set(["image_to_video", "reference_to_video"]).has(mode)) throw new Error("ONLY_IMAGE_TO_VIDEO_SUPPORTED");
    if (!ALL_VIDEO_MODELS.includes(model)) throw new Error("INVALID_MODEL");
    if (unified && (mode !== "image_to_video" || model === AUTO_SELECTION)) throw new Error("INVALID_MODEL");
    const accountId = !body.accountId || body.accountId === AUTO_SELECTION ? null : safeAccountId(body.accountId);
    const targetAccount = accountId ? store.getAccount(accountId) : null;
    if (accountId && !targetAccount) throw new Error("ACCOUNT_NOT_FOUND");
    const durationSeconds = Number(body.durationSeconds);
    if (!Number.isInteger(durationSeconds) || !ALL_VIDEO_DURATIONS.includes(durationSeconds)) throw new Error("INVALID_DURATION");
    const aspectRatio = boundedText(body.aspectRatio || (unified ? "9:16" : "auto"), "ASPECT_RATIO", 8);
    if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio)) throw new Error("INVALID_ASPECT_RATIO");
    if (unified && !["9:16", "16:9"].includes(aspectRatio)) throw new Error("INVALID_ASPECT_RATIO");
    const prompt = boundedText(body.positivePrompt ?? body.prompt, "PROMPT", 12_000);
    const negativePrompt = boundedText(body.negativePrompt || "", "NEGATIVE_PROMPT", 2_000, true);
    if (prompt.length + negativePrompt.length + (negativePrompt ? 32 : 0) > 12_000) {
      throw new Error("PROMPT_TOO_LONG");
    }
    const concurrency = body.concurrency === undefined ? 1 : Number(body.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("INVALID_CONCURRENCY");
    if (concurrency > 1 && (accountId || mode !== "image_to_video")) {
      throw new Error("CONCURRENCY_REQUIRES_AUTO_ACCOUNT");
    }
    const priority = Number.isInteger(Number(body.priority)) ? Math.max(0, Math.min(100, Number(body.priority))) : 50;
    const referenceAssets = Array.isArray(body.referenceAssets)
      ? body.referenceAssets.map((item) => boundedText(item, "REFERENCE_ASSET", 500)) : [];
    if (referenceAssets.length > 9) {
      throw new Error("REFERENCE_IMAGE_COUNT_INVALID");
    }
    const referenceAssetNames = Array.isArray(body.referenceAssetNames)
      ? body.referenceAssetNames.map((item) => boundedText(item, "REFERENCE_ASSET_NAME", 180))
      : referenceAssets.map((item) => path.basename(item));
    if (referenceAssetNames.length !== referenceAssets.length) throw new Error("REFERENCE_ASSET_NAMES_INVALID");
    const referenceVideo = mode === "reference_to_video"
      ? boundedText(body.referenceVideo, "REFERENCE_VIDEO", 500) : null;
    if (mode === "image_to_video" && body.referenceVideo) throw new Error("REFERENCE_VIDEO_NOT_ALLOWED");
    const referenceVideoName = referenceVideo
      ? boundedText(body.referenceVideoName || path.basename(referenceVideo), "REFERENCE_VIDEO_NAME", 180) : null;
    if (!hasCompatibleService(targetAccount?.service, model, durationSeconds,
      referenceAssets.length, aspectRatio, mode)) {
      throw new Error("JOB_PARAMETERS_INVALID");
    }
    referenceAssets.forEach(validateImage);
    if (referenceVideo) validateVideo(referenceVideo);
    return { accountId, mode, model, durationSeconds, aspectRatio, prompt, negativePrompt,
      concurrency, priority,
      referenceAssets, referenceAssetNames, referenceVideo, referenceVideoName };
  };

  const sameGenerationRequest = (job, input) => job.mode === "image_to_video"
    && job.requestedAccountId === input.accountId && job.requestedModel === input.model
    && job.durationSeconds === input.durationSeconds && job.aspectRatio === input.aspectRatio
    && job.prompt === input.prompt && job.negativePrompt === input.negativePrompt
    && job.concurrency === input.concurrency
    && JSON.stringify(job.referenceAssets) === JSON.stringify(input.referenceAssets)
    && JSON.stringify(job.referenceAssetNames) === JSON.stringify(input.referenceAssetNames);

  const executeJob = async ({ job, account }, collectExisting = false) => {
    const expectedResultPath = path.join(generatedRoot, `${job.id}.mp4`);
    let worker;
    let workerError = null;
    try {
      worker = spawn(pythonExecutable, [workerPath], { cwd: workspaceRoot, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: ["pipe", "pipe", "pipe"] });
      activeProcesses.add(worker);
      worker.stdin.end(JSON.stringify({ ...job, service: account.service,
        profilePath: account.profilePath, outputPath: expectedResultPath,
        collectExistingUrl: collectExisting ? job.remoteUrl : null }));
      worker.stderr.on("data", () => {});
      const lines = readline.createInterface({ input: worker.stdout });
      lines.on("line", (line) => {
        if (line.length > 8_192) return;
        try {
          const item = JSON.parse(line);
          if (item.stage === "error") {
            workerError = /^[A-Z][A-Z0-9_]{2,80}$/.test(item.code) ? item.code : "BROWSER_AUTOMATION_FAILED";
            return;
          }
          if (!new Set(["submitting", "submitted", "generating", "collecting", "success"]).has(item.stage)) return;
          const remoteUrl = validateRemoteUrl(account.service, item.remoteUrl);
          const resultPath = item.stage === "success" && item.resultPath === expectedResultPath
            && fs.existsSync(expectedResultPath) ? expectedResultPath : null;
          if (item.stage === "success" && !resultPath) throw new Error("RESULT_FILE_MISSING");
          store.updateJob(job.id, { status: item.stage, remoteUrl, resultPath });
        } catch {
          workerError = "WORKER_PROTOCOL_ERROR";
          worker.kill();
        }
      });
      const timeout = setTimeout(() => { workerError = "WORKER_TIMEOUT"; worker.kill(); },
        (account.service === "symphony" ? 22 : 12) * 60_000);
      try {
        await new Promise((resolve, reject) => {
          worker.once("error", reject);
          worker.once("close", resolve);
        });
      } finally { clearTimeout(timeout); }
      const current = store.getJob(job.id);
      if (current?.status !== "success") {
        const possiblySubmitted = new Set(["submitting", "submitted", "generating", "collecting", "reconciling"]).has(current?.status);
        const quotaExhausted = workerError === "DOUBAO_FREE_QUOTA_EXHAUSTED";
        const errorCode = workerError || "WORKER_EXITED";
        if (errorCode === "LOGIN_EXPIRED_DURING_SUBMISSION") {
          store.markAccountLoginRequired(account.id, errorCode);
        }
        if (job.queuedAt != null && (quotaExhausted || !possiblySubmitted)) {
          if (errorCode === "PROFILE_IN_USE") profileRetryAfter.set(account.id, Date.now() + 5_000);
          store.handleDispatchFailure(job.id, account.id, errorCode,
            { quotaExhausted, beforeSubmission: !possiblySubmitted });
        } else {
          store.updateJob(job.id, { status: quotaExhausted || !possiblySubmitted ? "failed" : "reconciling",
            errorCode });
          if (quotaExhausted) store.markAccountQuotaExhausted(account.id);
        }
      }
    } catch {
      const current = store.getJob(job.id);
      if (current && !new Set(["queued", "success", "failed", "cancelled"]).has(current.status)) {
        store.updateJob(job.id, { status: current.status === "leased" ? "failed" : "reconciling",
          errorCode: workerError || "WORKER_LAUNCH_FAILED" });
      }
    } finally {
      if (worker) activeProcesses.delete(worker);
      queueMicrotask(() => queueScheduler.wake());
      queueMicrotask(() => partnerApi.wake());
    }
  };

  if (store.listAccounts().length === 0 && !store.hasAccountHistory()) {
    const defaultProfile = resolveProfilePath(profileRoot, DEFAULT_ACCOUNT_ID);
    store.ensureAccount({
      id: DEFAULT_ACCOUNT_ID,
      label: "Symphony TK 一号账号",
      loginType: "tiktok",
      service: "symphony",
      workerId: DEFAULT_WORKER_ID,
      profilePath: defaultProfile,
      status: fs.existsSync(defaultProfile) ? "auth_required" : "provisioning",
    });
  }

  const runVerification = async (account) => {
    const selectedVerifier = account.loginType === "doubao" ? doubaoVerifierPath : verifierPath;
    if (!fs.existsSync(selectedVerifier)) throw new Error("VERIFIER_NOT_FOUND");
    if (!fs.existsSync(pythonExecutable)) throw new Error("PYTHON_NOT_CONFIGURED");
    if (!fs.existsSync(account.profilePath)) throw new Error("PROFILE_NOT_FOUND");
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(pythonExecutable, [selectedVerifier, "--headed", "--profile", account.profilePath], {
        cwd: workspaceRoot,
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      }));
    } catch (error) {
      stdout = typeof error.stdout === "string" ? error.stdout : "";
      if (!stdout.trim()) throw new Error(error.killed ? "VERIFIER_TIMEOUT" : "VERIFIER_FAILED");
    }
    return parseVerifierOutput(stdout, account.loginType);
  };

  const reverifyAfterQueuedJob = async ({ job, account }) => {
    if (options.autoReverifyAfterQueuedJob === false) return;
    const current = store.getJob(job.id);
    const latestAccount = store.getAccount(account.id);
    if (!current || !latestAccount || new Set(["queued", "reconciling"]).has(current.status)
      || latestAccount.status === "cooling" || verificationLocks.has(account.id)) return;
    verificationLocks.add(account.id);
    store.setAccountChecking(account.id);
    try {
      const result = await runVerification(latestAccount);
      store.saveVerification(account.id, result, latestAccount);
    } catch (error) {
      store.saveVerificationFailure(account.id, String(error.message || "VERIFIER_FAILED").slice(0, 120));
    } finally {
      verificationLocks.delete(account.id);
    }
  };

  const queueScheduler = createQueueScheduler({
    claim: () => {
      const unavailableAccountIds = store.listAccounts().filter((account) => {
        if (account.status !== "ready") return false;
        if (profileLaunchLocks.has(account.id) || verificationLocks.has(account.id)
          || (profileRetryAfter.get(account.id) || 0) > Date.now()) return true;
        profileRetryAfter.delete(account.id);
        // Local ownership checks avoid launching a second Chrome on a login profile.
        try { return (options.profileInUse || profileInUse)(account.profilePath); }
        catch { return true; }
      }).map((account) => account.id);
      return store.claimNextQueuedJob({ maxVerificationAgeMs, unavailableAccountIds });
    },
    execute: executeJob,
    afterExecute: reverifyAfterQueuedJob,
    canRun: () => store.hasQueuedJobs() && fs.existsSync(pythonExecutable) && fs.existsSync(workerPath),
    intervalMs: schedulerIntervalMs,
    maxConcurrent: maxConcurrentJobs,
    onError: (error, assignment) => {
      console.error("QUEUE_DISPATCH_ERROR", String(error.message || error).slice(0, 160));
      if (!assignment) return;
      const current = store.getJob(assignment.job.id);
      if (current && !new Set(["success", "failed", "cancelled", "reconciling"]).has(current.status)) {
        store.updateJob(current.id, { status: current.status === "leased" ? "failed" : "reconciling",
          errorCode: "QUEUE_DISPATCH_ERROR" });
      }
    },
  });

  const partnerApi = createPartnerApi({ databasePath, generatedRoot, uploadRoot, port,
    wakeQueue: queueScheduler.wake, options: options.partnerApi,
    ...(options.partnerNow ? { now: options.partnerNow } : {}) });

  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    try {
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(String(request.headers.host || "").toLowerCase())) {
        return json(response, 403, { error: "HOST_NOT_ALLOWED" });
      }
      const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);
      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch {
        throw new Error("INVALID_URL");
      }
      // The LAN proxy marks public requests; check again after URL normalization.
      if (request.headers["x-symphony-api-only"] === "1"
        && pathname !== "/v1" && !pathname.startsWith("/v1/")) {
        return json(response, 404, { error: "NOT_FOUND" });
      }
      if (pathname === "/v1" || pathname.startsWith("/v1/")) {
        return await partnerApi.handle(request, response, requestUrl, pathname);
      }
      if (pathname.startsWith("/api/") && request.method !== "GET" && !sameOriginAllowed(request, host, port)) {
        return json(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      }

      if (request.method === "GET" && pathname === "/api/health") {
        return json(response, 200, { ok: true, service: "symphony-pool-workbench", localOnly: true });
      }

      if (request.method === "GET" && pathname === "/api/overview") {
        return json(response, 200, {
          overview: store.overview(),
          accounts: store.listAccounts(),
          busyAccountIds: store.listBusyAccountIds(),
          jobs: store.listJobs(50),
          events: store.listEvents(60),
          automationEnabled: true,
          desktopPort,
        });
      }

      if (request.method === "GET" && pathname === "/api/accounts") {
        return json(response, 200, { accounts: store.listAccounts() });
      }

      if (request.method === "POST" && pathname === "/api/accounts") {
        const body = await readJson(request);
        const id = safeAccountId(body.accountId);
        const label = boundedText(body.label, "LABEL", 80);
        const loginType = body.loginType || "tiktok";
        if (!LOGIN_TYPES.has(loginType)) throw new Error("INVALID_LOGIN_TYPE");
        const workerId = boundedText(body.workerId || DEFAULT_WORKER_ID, "WORKER_ID", 128);
        if (store.listAccounts().some((account) => account.id.toLowerCase() === id.toLowerCase())) {
          throw new Error("ACCOUNT_ALREADY_EXISTS");
        }
        const profilePath = resolveProfilePath(profileRoot, id);
        if (pathEntryExists(profilePath)) throw new Error("ACCOUNT_PROFILE_ALREADY_EXISTS");
        const account = store.ensureAccount({
          id,
          label,
          loginType,
          service: loginType === "doubao" ? "doubao" : "symphony",
          workerId,
          profilePath,
          status: "provisioning",
        });
        return json(response, 201, { account });
      }

      const deleteAccountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (request.method === "DELETE" && deleteAccountMatch) {
        const id = safeAccountId(deleteAccountMatch[1]);
        const account = store.getAccount(id);
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (verificationLocks.has(id)) throw new Error("VERIFICATION_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        if (store.hasPendingJobForAccount(id)) throw new Error("ACCOUNT_HAS_PENDING_JOBS");
        const expectedProfile = resolveProfilePath(profileRoot, id);
        if (path.resolve(account.profilePath).toLowerCase() !== expectedProfile.toLowerCase()) {
          throw new Error("ACCOUNT_PROFILE_PATH_INVALID");
        }
        let stagedProfile = null;
        if (pathEntryExists(expectedProfile)) {
          const profileStat = fs.lstatSync(expectedProfile);
          if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
            throw new Error("ACCOUNT_PROFILE_NOT_DIRECTORY");
          }
          const actualRoot = fs.realpathSync.native(profileRoot);
          const actualProfile = fs.realpathSync.native(expectedProfile);
          if (path.dirname(actualProfile).toLowerCase() !== actualRoot.toLowerCase()
            || path.basename(actualProfile).toLowerCase() !== path.basename(expectedProfile).toLowerCase()) {
            throw new Error("ACCOUNT_PROFILE_PATH_INVALID");
          }
          if (profileInUse(expectedProfile)) {
            throw new Error("ACCOUNT_PROFILE_IN_USE");
          }
          stagedProfile = path.join(profileRoot, `.${id}.deleting-${randomUUID()}`);
          if (path.dirname(stagedProfile) !== profileRoot) throw new Error("ACCOUNT_PROFILE_PATH_INVALID");
          try { fs.renameSync(expectedProfile, stagedProfile); }
          catch (error) {
            if (["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw new Error("ACCOUNT_PROFILE_IN_USE");
            throw new Error("ACCOUNT_PROFILE_MOVE_FAILED");
          }
        }
        try { store.deleteAccount(id); }
        catch (error) {
          if (stagedProfile) {
            try { fs.renameSync(stagedProfile, expectedProfile); }
            catch { throw new Error("ACCOUNT_PROFILE_ROLLBACK_FAILED"); }
          }
          throw error;
        }
        let profileCleanupPending = false;
        if (stagedProfile) {
          try { fs.rmSync(stagedProfile, { recursive: true }); }
          catch { profileCleanupPending = true; }
        }
        return json(response, 200, { ok: true, accountId: id, profileCleanupPending });
      }

      const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (request.method === "PATCH" && accountMatch) {
        const id = safeAccountId(accountMatch[1]);
        const body = await readJson(request);
        const nextId = safeAccountId(body.accountId ?? id);
        const label = boundedText(body.label, "LABEL", 80);
        const account = store.getAccount(id);
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (nextId === id) {
          return json(response, 200, { account: store.updateAccountLabel(id, label) });
        }
        if (verificationLocks.has(id)) throw new Error("VERIFICATION_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        if (store.hasRunningJobForAccount(id)) throw new Error("ACCOUNT_ALREADY_RUNNING");
        if (nextId.toLowerCase() === id.toLowerCase()) throw new Error("ACCOUNT_ID_CASE_CONFLICT");
        if (store.listAccounts().some((item) => item.id.toLowerCase() === nextId.toLowerCase())) {
          throw new Error("ACCOUNT_ALREADY_EXISTS");
        }
        const oldProfilePath = resolveProfilePath(profileRoot, id);
        const nextProfilePath = resolveProfilePath(profileRoot, nextId);
        if (path.resolve(account.profilePath).toLowerCase() !== oldProfilePath.toLowerCase()) {
          throw new Error("ACCOUNT_PROFILE_PATH_INVALID");
        }
        if (fs.existsSync(nextProfilePath)) throw new Error("ACCOUNT_PROFILE_ALREADY_EXISTS");
        let movedProfile = false;
        if (fs.existsSync(oldProfilePath)) {
          if (!fs.lstatSync(oldProfilePath).isDirectory()) throw new Error("ACCOUNT_PROFILE_NOT_DIRECTORY");
          if (profileInUse(oldProfilePath)) throw new Error("ACCOUNT_PROFILE_IN_USE");
          try {
            fs.renameSync(oldProfilePath, nextProfilePath);
            movedProfile = true;
          } catch (error) {
            if (["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
              throw new Error("ACCOUNT_PROFILE_IN_USE");
            }
            if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
              throw new Error("ACCOUNT_PROFILE_ALREADY_EXISTS");
            }
            throw new Error("ACCOUNT_PROFILE_MOVE_FAILED");
          }
        }
        let updated;
        try {
          updated = store.updateAccountIdentity(id, nextId, label, nextProfilePath);
        } catch (error) {
          if (movedProfile) {
            try { fs.renameSync(nextProfilePath, oldProfilePath); }
            catch { throw new Error("ACCOUNT_PROFILE_ROLLBACK_FAILED"); }
          }
          throw error;
        }
        return json(response, 200, { account: updated });
      }

      const openMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/open$/);
      if (request.method === "POST" && openMatch) {
        const id = safeAccountId(openMatch[1]);
        const account = store.getAccount(id);
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if (store.hasRunningJobForAccount(id)) throw new Error("ACCOUNT_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id) || verificationLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        if (!fs.existsSync(launcherPath)) return json(response, 500, { error: "LAUNCHER_NOT_FOUND" });
        if (!runtime.windows && !fs.existsSync(pythonExecutable)) {
          return json(response, 503, { error: "PYTHON_NOT_CONFIGURED" });
        }
        const launch = profileLaunchCommand(runtime, account);
        let launchResult;
        profileLaunchLocks.add(id);
        try {
          launchResult = await execFileAsync(launch.executable, launch.args, {
            cwd: workspaceRoot,
            windowsHide: true,
            timeout: 45_000,
            maxBuffer: 16 * 1024,
          });
        } catch (error) {
          let code = error.killed ? "PROFILE_LAUNCH_TIMEOUT" : "PROFILE_LAUNCH_FAILED";
          try {
            const detail = JSON.parse(error.stdout || "{}");
            if (["DISPLAY_NOT_CONFIGURED", "PROFILE_IN_USE", "INVALID_BROWSER_CHANNEL", "PROFILE_DESKTOP_FAILED"].includes(detail.error)) code = detail.error;
          } catch { }
          return json(response, 500, { error: code });
        } finally {
          profileLaunchLocks.delete(id);
        }
        let alreadyOpen = false;
        let desktop;
        if (!runtime.windows) {
          try {
            const detail = JSON.parse(launchResult.stdout);
            if (detail.ok !== true || detail.desktop?.protocol !== "xpra" || detail.desktop?.accountId !== id
              || !/^[a-f0-9]{64}$/.test(detail.desktop?.token || "")) throw new Error("INVALID_DESKTOP");
            alreadyOpen = detail.alreadyOpen === true;
            desktop = { protocol: "xpra", port: desktopPort, token: detail.desktop.token, accountId: id };
          } catch { return json(response, 500, { error: "PROFILE_DESKTOP_FAILED" }); }
        }
        store.recordProfileOpened(id);
        return json(response, 202, { ok: true, accountId: id, alreadyOpen, ...(desktop ? { desktop } : {}) });
      }

      const closeLoginMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/close-login$/);
      if (request.method === "POST" && closeLoginMatch) {
        const id = safeAccountId(closeLoginMatch[1]);
        const account = store.getAccount(id);
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if (runtime.windows) return json(response, 409, { error: "PROFILE_CLOSE_UNSUPPORTED" });
        if (store.hasRunningJobForAccount(id)) throw new Error("ACCOUNT_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id) || verificationLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        const launch = profileLaunchCommand(runtime, account);
        profileLaunchLocks.add(id);
        try {
          const { stdout } = await execFileAsync(launch.executable, [...launch.args, "--close"], {
            cwd: workspaceRoot, windowsHide: true, timeout: 25_000, maxBuffer: 16 * 1024,
          });
          if (JSON.parse(stdout).ok !== true) throw new Error("PROFILE_CLOSE_FAILED");
          if ((options.profileInUse || profileInUse)(account.profilePath)) throw new Error("PROFILE_CLOSE_FAILED");
          return json(response, 200, { ok: true, accountId: id });
        } catch {
          return json(response, 500, { error: "PROFILE_CLOSE_FAILED" });
        } finally {
          profileLaunchLocks.delete(id);
        }
      }

      const verifyMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/verify$/);
      if (request.method === "POST" && verifyMatch) {
        const id = safeAccountId(verifyMatch[1]);
        const account = store.getAccount(id);
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if (store.hasRunningJobForAccount(id)) throw new Error("ACCOUNT_ALREADY_RUNNING");
        if (verificationLocks.has(id)) return json(response, 409, { error: "VERIFICATION_ALREADY_RUNNING" });
        if (profileLaunchLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        verificationLocks.add(id);
        store.setAccountChecking(id);
        try {
          const result = await runVerification(account);
          const updated = store.saveVerification(id, result, account);
          return json(response, result.ok ? 200 : 409, {
            ...(result.ok ? {} : { error: result.error || "VERIFICATION_FAILED" }),
            result,
            account: updated,
          });
        } catch (error) {
          const code = String(error.message || "VERIFIER_FAILED").slice(0, 120);
          store.saveVerificationFailure(id, code);
          return json(response, 500, { error: code });
        } finally {
          verificationLocks.delete(id);
          queueMicrotask(queueScheduler.wake);
        }
      }

      if (request.method === "GET" && pathname === "/api/workbench/jobs") {
        const status = requestUrl.searchParams.get("status") || "all";
        const page = Number(requestUrl.searchParams.get("page") || 1);
        const pageSize = Number(requestUrl.searchParams.get("pageSize") || 6);
        if (!["all", "success", "failed", "active"].includes(status)) throw new Error("INVALID_JOB_FILTER");
        if (!Number.isSafeInteger(page) || page < 1
          || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
          throw new Error("INVALID_JOB_PAGE");
        }
        return json(response, 200, workbenchJobsPage({ status, page, pageSize }));
      }

      const workbenchResultMatch = pathname.match(/^\/api\/workbench\/video-results\/([^/]+)$/);
      if (request.method === "GET" && workbenchResultMatch) {
        const taskId = validateTaskId(workbenchResultMatch[1]);
        const task = videoApiStore.getLocalResult(taskId);
        const expected = path.join(apiGeneratedRoot, `${taskId}.mp4`);
        if (task?.status !== "succeeded" || task.path !== expected || !fs.existsSync(expected)) {
          return json(response, 404, { error: "RESULT_NOT_FOUND" });
        }
        response.writeHead(200, { "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${taskId}.mp4"`,
          "Content-Length": fs.statSync(expected).size, "Cache-Control": "no-store" });
        return fs.createReadStream(expected).pipe(response);
      }

      if (request.method === "GET" && pathname === "/api/jobs") {
        if (requestUrl.searchParams.has("status") || requestUrl.searchParams.has("page")
          || requestUrl.searchParams.has("pageSize")) {
          const status = requestUrl.searchParams.get("status") || "all";
          const page = Number(requestUrl.searchParams.get("page") || 1);
          const pageSize = Number(requestUrl.searchParams.get("pageSize") || 6);
          if (!["all", "success", "failed", "active"].includes(status)) throw new Error("INVALID_JOB_FILTER");
          if (!Number.isSafeInteger(page) || page < 1
            || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
            throw new Error("INVALID_JOB_PAGE");
          }
          return json(response, 200, store.listJobsPage({ status, page, pageSize }));
        }
        return json(response, 200, { jobs: store.listJobs(100) });
      }

      if (request.method === "GET" && pathname === "/api/events") {
        const page = Number(requestUrl.searchParams.get("page") || 1);
        const pageSize = Number(requestUrl.searchParams.get("pageSize") || 10);
        if (!Number.isSafeInteger(page) || page < 1
          || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
          throw new Error("INVALID_EVENT_PAGE");
        }
        return json(response, 200, store.listEventsPage({ page, pageSize }));
      }

      if (request.method === "GET" && pathname === "/api/video-provider/models") {
        const key = apiKeyFromRequest(request);
        const models = await videoApi.models(key);
        videoApiScheduler.attach(key);
        return json(response, 200, models);
      }

      if (request.method === "POST" && pathname === "/api/video-provider/uploads") {
        const key = apiKeyFromRequest(request);
        const bytes = await readUpload(request, 6 * 1024 * 1024, "VIDEO_API_IMAGE_TOO_LARGE");
        const mime = imageContentType(bytes);
        if (!mime || request.headers["content-type"]?.split(";")[0]?.trim() !== mime) {
          throw new VideoApiError(415, "VIDEO_API_IMAGE_FORMAT_INVALID");
        }
        const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mime];
        const requestedName = String(request.headers["x-filename"] || "");
        const filename = /^[\x20-\x7e]{1,200}$/.test(requestedName)
          ? requestedName : `reference.${extension}`;
        return json(response, 201, await videoApi.upload(key, bytes, mime, filename));
      }

      if (request.method === "POST" && pathname === "/api/video-provider/generations") {
        const key = apiKeyFromRequest(request);
        const fingerprint = apiKeyFingerprint(key);
        const idempotencyKey = validateIdempotencyKey(request.headers["idempotency-key"]);
        const payload = validateGeneration(await readJson(request));
        const batch = videoApiStore.enqueue(fingerprint, idempotencyKey, payload);
        videoApiScheduler.attach(key);
        return json(response, 202, { batch });
      }

      if (request.method === "GET" && pathname === "/api/video-provider/history") {
        const key = apiKeyFromRequest(request);
        const fingerprint = apiKeyFingerprint(key);
        const page = Number(requestUrl.searchParams.get("page") || 1);
        if (!Number.isSafeInteger(page) || page < 1) throw new VideoApiError(400, "INVALID_VIDEO_API_PAGE");
        videoApiScheduler.attach(key);
        return json(response, 200, videoApiStore.listBatches(fingerprint, { page }));
      }

      const providerRetryMatch = pathname.match(/^\/api\/video-provider\/batches\/(\d+)\/retry$/);
      if (request.method === "POST" && providerRetryMatch) {
        const key = apiKeyFromRequest(request);
        const batch = videoApiStore.retryBlocked(apiKeyFingerprint(key), Number(providerRetryMatch[1]));
        videoApiScheduler.attach(key);
        return json(response, 202, { batch });
      }

      const providerResultMatch = pathname.match(/^\/api\/video-provider\/generations\/([^/]+)\/result$/);
      if (request.method === "GET" && providerResultMatch) {
        const key = apiKeyFromRequest(request);
        const taskId = validateTaskId(providerResultMatch[1]);
        const range = request.headers.range;
        if (range && !/^bytes=\d+-\d*$/.test(range)) throw new VideoApiError(416, "INVALID_VIDEO_RANGE");
        const upstream = await videoApi.result(key, taskId, range);
        if (!upstream.body || ![200, 206].includes(upstream.status)
          || !upstream.headers.get("content-type")?.startsWith("video/mp4")) {
          throw new VideoApiError(502, "VIDEO_API_INVALID_RESULT");
        }
        const headers = { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="${taskId}.mp4"`,
          "Cache-Control": "no-store" };
        for (const header of ["content-length", "content-range", "accept-ranges"]) {
          const value = upstream.headers.get(header);
          if (value) headers[header] = value;
        }
        response.writeHead(upstream.status, headers);
        return Readable.fromWeb(upstream.body).pipe(response);
      }

      const providerTaskMatch = pathname.match(/^\/api\/video-provider\/generations\/([^/]+)$/);
      if (request.method === "GET" && providerTaskMatch) {
        const key = apiKeyFromRequest(request);
        const taskId = validateTaskId(providerTaskMatch[1]);
        const upstream = await videoApi.task(key, taskId);
        videoApiStore.updateTask(apiKeyFingerprint(key), taskId, upstream);
        videoApiScheduler.attach(key);
        return json(response, 200, upstream);
      }

      if (request.method === "POST" && pathname === "/api/assets") {
        const bytes = await readUpload(request, 20 * 1024 * 1024, "REFERENCE_IMAGE_TOO_LARGE");
        const extension = imageExtension(bytes);
        if (!extension) throw new Error("REFERENCE_IMAGE_INVALID_FORMAT");
        fs.mkdirSync(uploadRoot, { recursive: true });
        const uploadedPath = path.join(uploadRoot, `${randomUUID()}${extension}`);
        fs.writeFileSync(uploadedPath, bytes, { flag: "wx" });
        return json(response, 201, { path: uploadedPath });
      }

      if (request.method === "POST" && pathname === "/api/assets/video") {
        const bytes = await readUpload(request, 50 * 1024 * 1024, "REFERENCE_VIDEO_TOO_LARGE");
        const extension = videoExtension(bytes);
        if (!extension) throw new Error("REFERENCE_VIDEO_INVALID_FORMAT");
        fs.mkdirSync(uploadRoot, { recursive: true });
        const uploadedPath = path.join(uploadRoot, `${randomUUID()}${extension}`);
        fs.writeFileSync(uploadedPath, bytes, { flag: "wx" });
        return json(response, 201, { path: uploadedPath });
      }

      if (request.method === "POST" && pathname === "/api/video-generations") {
        const body = await readJson(request);
        if (body.mode && body.mode !== "image_to_video") throw new Error("ONLY_IMAGE_TO_VIDEO_SUPPORTED");
        const input = parseVideoJob({ ...body, mode: "image_to_video",
          concurrency: body.concurrency ?? 1, negativePrompt: body.negativePrompt ?? "" });
        if (!fs.existsSync(pythonExecutable) || !fs.existsSync(workerPath)) throw new Error("WORKER_NOT_CONFIGURED");
        const idempotencyKey = boundedText(body.idempotencyKey || `generation-${randomUUID()}`,
          "IDEMPOTENCY_KEY", 160);
        let draft = store.getJobByIdempotencyKey(idempotencyKey);
        if (!draft) {
          try { draft = store.createDraftJob({ ...input, idempotencyKey }); }
          catch (error) {
            draft = store.getJobByIdempotencyKey(idempotencyKey);
            if (!draft) throw error;
          }
        }
        if (!sameGenerationRequest(draft, input)) throw new Error("IDEMPOTENCY_CONFLICT");
        if (draft.status !== "draft") {
          return json(response, 200, { batchId: draft.batchId || draft.id,
            jobs: store.listBatchJobs(draft.batchId || draft.id) });
        }
        const started = store.startJobBatch(draft.id);
        for (const assignment of started) void executeJob(assignment);
        return json(response, 202, { batchId: started[0].job.batchId || draft.id,
          jobs: started.map((assignment) => assignment.job) });
      }

      const generationMatch = pathname.match(/^\/api\/video-generations\/([^/]+)$/);
      if (request.method === "GET" && generationMatch) {
        const batchId = boundedText(generationMatch[1], "BATCH_ID", 160);
        const jobs = store.listBatchJobs(batchId);
        return jobs.length ? json(response, 200, { batchId, jobs })
          : json(response, 404, { error: "JOB_NOT_FOUND" });
      }

      if (request.method === "POST" && pathname === "/api/jobs") {
        const body = await readJson(request);
        const enqueue = body.enqueue === true;
        const parsedJob = parseVideoJob(body);
        if (enqueue && parsedJob.concurrency > 1) throw new Error("CONCURRENCY_REQUIRES_IMMEDIATE_START");
        const job = store.createDraftJob({
          idempotencyKey: boundedText(body.idempotencyKey || `draft-${randomUUID()}`, "IDEMPOTENCY_KEY", 160),
          ...parsedJob,
          enqueue,
        });
        json(response, enqueue ? 202 : 201, { job, automationEnabled: true });
        if (enqueue) queueMicrotask(queueScheduler.wake);
        return;
      }

      const getJobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (request.method === "GET" && getJobMatch) {
        const job = store.getJob(boundedText(getJobMatch[1], "JOB_ID", 160));
        return job ? json(response, 200, { job }) : json(response, 404, { error: "JOB_NOT_FOUND" });
      }

      const editMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (request.method === "PATCH" && editMatch) {
        const id = boundedText(editMatch[1], "JOB_ID", 160);
        if (!store.getJob(id)) return json(response, 404, { error: "JOB_NOT_FOUND" });
        const job = store.updateDraftJob(id, parseVideoJob(await readJson(request)));
        return json(response, 200, { job });
      }

      const startMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const id = boundedText(startMatch[1], "JOB_ID", 160);
        const job = store.getJob(id);
        if (!job) return json(response, 404, { error: "JOB_NOT_FOUND" });
        if (!fs.existsSync(pythonExecutable) || !fs.existsSync(workerPath)) throw new Error("WORKER_NOT_CONFIGURED");
        job.referenceAssets.forEach(validateImage);
        if (job.mode === "reference_to_video") validateVideo(job.referenceVideo);
        const started = store.startJobBatch(id);
        for (const assignment of started) void executeJob(assignment);
        return json(response, 202, { job: started[0].job,
          jobs: started.map((assignment) => assignment.job), batchId: started[0].job.batchId || id });
      }

      const queueMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/queue$/);
      if (request.method === "POST" && queueMatch) {
        const id = boundedText(queueMatch[1], "JOB_ID", 160);
        const job = store.getJob(id);
        if (!job) return json(response, 404, { error: "JOB_NOT_FOUND" });
        if (job.concurrency > 1) throw new Error("CONCURRENCY_REQUIRES_IMMEDIATE_START");
        job.referenceAssets.forEach(validateImage);
        if (job.mode === "reference_to_video") validateVideo(job.referenceVideo);
        const queued = store.enqueueJob(id);
        json(response, 202, { job: queued });
        queueMicrotask(queueScheduler.wake);
        return;
      }

      const recollectMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/recollect$/);
      if (request.method === "POST" && recollectMatch) {
        const id = boundedText(recollectMatch[1], "JOB_ID", 160);
        const job = store.getJob(id);
        if (!job) return json(response, 404, { error: "JOB_NOT_FOUND" });
        const account = store.getAccount(job.accountId);
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (!fs.existsSync(pythonExecutable) || !fs.existsSync(workerPath)) throw new Error("WORKER_NOT_CONFIGURED");
        const remoteUrl = validateRemoteUrl(account.service, job.remoteUrl);
        if (!remoteUrl || (account.service === "doubao" && !/^\/chat\/\d+$/.test(new URL(remoteUrl).pathname))
          || (account.service === "symphony" && !/^\d+$/.test(new URL(remoteUrl).searchParams.get("activeId") || ""))) {
          throw new Error("INVALID_REMOTE_URL");
        }
        const started = store.recollectJob(id);
        void executeJob(started, true);
        return json(response, 202, { job: started.job });
      }

      const resultMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/result$/);
      if (request.method === "GET" && resultMatch) {
        const job = store.getJob(boundedText(resultMatch[1], "JOB_ID", 160));
        if (!job || job.status !== "success") return json(response, 404, { error: "RESULT_NOT_FOUND" });
        const expected = path.join(generatedRoot, `${job.id}.mp4`);
        if (job.resultPath !== expected || !fs.existsSync(expected)) return json(response, 404, { error: "RESULT_NOT_FOUND" });
        response.writeHead(200, { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="${job.id}.mp4"`,
          "Content-Length": fs.statSync(expected).size, "Cache-Control": "no-store" });
        return fs.createReadStream(expected).pipe(response);
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        store.cancelJob(boundedText(cancelMatch[1], "JOB_ID", 160));
        return json(response, 200, { ok: true });
      }

      if (request.method === "GET" && !pathname.startsWith("/api/")) {
        const loginPage = pathname.match(/^\/accounts\/([^/]+)\/login$/);
        if (loginPage) {
          const id = safeAccountId(loginPage[1]);
          if (!store.getAccount(id)) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
          response.writeHead(200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" });
          return fs.createReadStream(path.join(publicRoot, "account-login.html")).pipe(response);
        }
        const document = documentationFile(pathname);
        if (document) {
          response.writeHead(200, { "Content-Type": document.type, "Cache-Control": "no-store",
            "Content-Disposition": `attachment; filename="${document.filename}"` });
          return response.end(document.content);
        }
        if (["/overview", "/video-api"].includes(pathname.replace(/\/+$/, ""))
          || (pathname === "/jobs" && requestUrl.searchParams.get("tab") === "api")) {
          response.writeHead(302, { Location: "/jobs", "Cache-Control": "no-store" });
          return response.end();
        }
        const html = renderPage(pathname, partnerApi.baseUrl);
        if (html !== null) {
          response.writeHead(200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" });
          return response.end(html);
        }
        const relative = pathname.replace(/^\/+/, "");
        const filePath = path.resolve(publicRoot, relative);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
          response.writeHead(403);
          return response.end("Forbidden");
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          response.writeHead(404);
          return response.end("Not found");
        }
        response.writeHead(200, {
          "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        return fs.createReadStream(filePath).pipe(response);
      }

      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof VideoApiError) {
        return json(response, error.status, { error: error.code, requestId: error.requestId });
      }
      const code = String(error.message || "INTERNAL_ERROR").slice(0, 160);
      const status = code.includes("NOT_FOUND") ? 404
        : code.includes("NOT_CANCELLABLE") || code.includes("ALREADY_RUNNING") || code.includes("NOT_STARTABLE")
          || code.includes("NOT_EDITABLE") || code.includes("NOT_QUEUEABLE")
          || code.includes("NOT_RECOLLECTABLE")
          || code === "ACCOUNT_NOT_READY" || code === "ACCOUNT_ALREADY_EXISTS"
          || code === "ACCOUNT_ID_CASE_CONFLICT" || code === "ACCOUNT_PROFILE_IN_USE"
          || code === "ACCOUNT_PROFILE_STATE_UNKNOWN"
          || code === "ACCOUNT_PROFILE_ALREADY_EXISTS" || code === "ACCOUNT_PROFILE_NOT_DIRECTORY"
          || code === "ACCOUNT_HAS_PENDING_JOBS" || code === "VERIFICATION_ALREADY_RUNNING" ? 409
          : code === "PAYLOAD_TOO_LARGE" || code === "VIDEO_API_IMAGE_TOO_LARGE" || code === "REFERENCE_IMAGE_TOO_LARGE"
            || code === "REFERENCE_VIDEO_TOO_LARGE" ? 413
            : code === "INTERNAL_ERROR" || code === "ACCOUNT_PROFILE_MOVE_FAILED"
              || code === "ACCOUNT_PROFILE_ROLLBACK_FAILED" ? 500 : 400;
      return json(response, status, { error: code });
    }
  });

  return {
    server,
    store,
    queueScheduler,
    partnerApi,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          queueScheduler.start();
          videoApiScheduler.start();
          partnerApi.start();
          resolve({ host, port, url: `http://${host}:${port}` });
        });
      });
    },
    close() {
      const waitingForQueue = queueScheduler.stop();
      const waitingForVideoApi = videoApiScheduler.stop();
      const waitingForPartner = partnerApi.stop();
      for (const child of activeProcesses) child.kill();
      return new Promise((resolve) => server.close(() => {
        const wait = () => activeProcesses.size ? setTimeout(wait, 100)
          : Promise.all([waitingForQueue, waitingForVideoApi, waitingForPartner]).then(() => {
            partnerApi.close(); videoApiStore.close(); store.close(); resolve();
          });
        wait();
      }));
    },
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const envFile = path.join(projectRoot, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const app = createWorkbenchServer({
    host: process.env.WORKBENCH_HOST || "127.0.0.1",
    port: Number(process.env.WORKBENCH_PORT || 8787),
    databasePath: process.env.WORKBENCH_DATABASE_PATH,
    profileRoot: process.env.WORKBENCH_PROFILE_ROOT,
  });
  const address = await app.listen();
  console.log(JSON.stringify({ status: "listening", ...address, localOnly: address.host === "127.0.0.1" }));

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
