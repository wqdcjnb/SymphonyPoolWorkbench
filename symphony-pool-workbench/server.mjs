import fs from "node:fs";
import { collectionUrl } from './lib/long-task.mjs';
import { VIDEO_RATIOS } from './public/js/video-policy.js';
import { mentionsThirtySeconds, THIRTY_SECOND_MODEL, resolvePromptRatio } from './lib/prompt-policy.mjs';
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrowserSessions } from "./lib/browser-sessions.mjs";
import { createBrowserResidency } from "./lib/browser-residency.mjs";
import { createDolaRecovery } from "./lib/dola-recovery.mjs";
import { createLoginQueue } from "./lib/login-queue.mjs";
import { EGRESS_ERRORS, MULTILOGIN_ERRORS, INFRA_ERRORS } from "./lib/infra-errors.mjs";
import { poolHttp, privatePython } from "./lib/pool-http.mjs";
import { createAccountPool } from "./lib/account-pool.mjs";
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
import { AUTO_SELECTION, ALL_VIDEO_MODELS, ALL_VIDEO_DURATIONS,
  hasCompatibleService } from "./lib/job-routing.mjs";
import { sendVideo } from "./lib/media-response.mjs";
import { assertTrackedDolaVideo } from './lib/media-delivery.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = path.resolve(projectRoot, "..");
const publicRoot = path.join(projectRoot, "public");
const DEFAULT_ACCOUNT_ID = "xzkj-pc-01-doubao-01";
const DEFAULT_WORKER_ID = "xzkj-pc-01";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOGIN_TYPES = new Set(["doubao", "dola"]);
const JOB_FILTERS = new Set(['all','active','draft','queued','leased','submitting','submitted','generating','collecting','reconciling','success','failed','blocked','cancelled']);
const MODEL_OPTIONS = new Set([
  "Dreamina Seedance 2.5",
]);
const DOUBAO_MODEL_OPTIONS = new Set([
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

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
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
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("INVALID_REMOTE_URL"); }
  const expectedHost = service === "doubao" ? "www.doubao.com" : service === "dola" ? "www.dola.com" : "ads.tiktok.com";
  if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost) throw new Error("INVALID_REMOTE_URL");
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) throw new Error("INVALID_REMOTE_URL");
  if (service === "dola" && !/^\/chat\/\d+$/.test(parsed.pathname)) throw new Error("INVALID_REMOTE_URL");
  if (service === "symphony") {
    const taskId = parsed.searchParams.get("activeId");
    if (taskId && /^\d+$/.test(taskId)) return `${parsed.origin}${parsed.pathname}?activeId=${taskId}`;
  }
  return parsed.origin + parsed.pathname;
}

export async function createWorkbenchServer(options = {}) {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("LOCAL_HOST_REQUIRED");
  const port = Number(options.port || 8787);
  const workspaceRoot = path.resolve(options.workspaceRoot || defaultWorkspaceRoot);
  const profileRoot = path.resolve(options.profileRoot || workspaceRoot);
  const databaseSource = options.databaseUrl || process.env.DATABASE_URL || options.databasePath || path.join(projectRoot, "data", "workbench.sqlite");
  const databasePath = /^postgres(?:ql)?:\/\//.test(databaseSource) ? databaseSource : path.resolve(databaseSource);
  const verifierPath = path.resolve(options.verifierPath || path.join(workspaceRoot, "tools", "verify-symphony-profile.py"));
  const doubaoVerifierPath = path.resolve(options.doubaoVerifierPath || path.join(workspaceRoot, "tools", "verify-doubao-profile.py"));
  const workerPath = path.resolve(options.workerPath || path.join(workspaceRoot, "tools", "run-image-to-video.py"));
  const generatedRoot = path.resolve(options.generatedRoot || path.join(projectRoot, "data", "generated"));
  const uploadRoot = path.resolve(options.uploadRoot || path.join(projectRoot, "data", "uploads"));
  const runtime = browserRuntime({ projectRoot, workspaceRoot, platform: options.runtimePlatform,
    pythonExecutable: options.pythonExecutable, launcherPath: options.launcherPath });
  const { launcherPath, pythonExecutable } = runtime;
  const desktopPort = runtime.windows ? null : Number(options.desktopPort || process.env.WORKBENCH_DESKTOP_PORT || 6080);
  const store = (await createStore(databasePath));
  const videoApiStore = (await createVideoApiStore(databasePath));
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
  const workbenchJobsPage = async ({ status, page, pageSize }) => {
    const listing = (await videoApiStore.listWorkbenchIndex({ status, page, pageSize }));
    const jobs = (await Promise.all(listing.items.map(async (item) => {
      if (item.source === "account_pool") {
        const job = (await store.getJob(item.id));
        return job ? { ...job, source: "account_pool" } : null;
      }
      const batch = (await videoApiStore.getWorkbenchBatch(Number(item.id)));
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
    }))).filter(Boolean);
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

  const pool = createAccountPool({ store, workerId: options.workerId || process.env.WORKBENCH_WORKER_ID || DEFAULT_WORKER_ID,
    enforceWorker: Boolean(options.workerId || process.env.WORKBENCH_WORKER_ID),
    capacity: maxConcurrentJobs, globalLimit: Number(process.env.WORKBENCH_GLOBAL_LIMIT || 100),
    keyFile: options.keyFile || process.env.WORKBENCH_KEY_FILE,
    enforceGroups: options.enforceGroups ?? process.env.WORKBENCH_REQUIRE_GROUPS === "1",
    requireProxyForNewAccounts: options.requireProxyForNewAccounts ?? process.env.WORKBENCH_REQUIRE_PROXY_FOR_NEW_ACCOUNTS === "1",
    requireMimicForNewAccounts: options.requireMimicForNewAccounts ?? process.env.WORKBENCH_REQUIRE_MIMIC_FOR_NEW_ACCOUNTS === "1" });
  let poolStarted = false;
  let poolTimer, residencyTimer, closing=false;
  const sessions = createBrowserSessions({pool,runtime,workspaceRoot,desktopPort,
    keepAlive: options.keepBrowsersAlive ?? true,
    enabled: !runtime.windows && (options.managedSessions ?? process.env.WORKBENCH_MANAGED_SESSIONS === "1"),
    checkEgress: config => privatePython(pythonExecutable,path.join(workspaceRoot,'tools','check-egress.py'),config)});
  const residency=createBrowserResidency({store,pool,sessions,locks:profileLaunchLocks,verificationLocks});
  const releaseViewer=async previous=>{
    if(!previous?.accountId)return;
    const account=await store.getAccount(previous.accountId),lease=await pool.accountLease(previous.accountId);
    if(account&&lease?.owner===pool.owner&&lease.purpose==='view')await sessions.idle(account,lease.token);
  };

  const parseVideoJob = async (body) => {
    const forceThirty = mentionsThirtySeconds(body.positivePrompt ?? body.prompt, body.negativePrompt);
    if (forceThirty) body = { ...body, model: THIRTY_SECOND_MODEL, durationSeconds: 30 };
    const unified = body.mode === undefined || body.concurrency !== undefined
      || body.negativePrompt !== undefined || body.positivePrompt !== undefined;
    const mode = boundedText(body.mode || "image_to_video", "MODE", 40);
    const model = boundedText(body.model, "MODEL", 80);
    if (!new Set(["image_to_video", "reference_to_video"]).has(mode)) throw new Error("ONLY_IMAGE_TO_VIDEO_SUPPORTED");
    if (!ALL_VIDEO_MODELS.includes(model)) throw new Error("INVALID_MODEL");
    if (unified && (mode !== "image_to_video" || model === AUTO_SELECTION)) throw new Error("INVALID_MODEL");
    let accountId = !body.accountId || body.accountId === AUTO_SELECTION ? null : safeAccountId(body.accountId);
    let targetAccount = accountId ? (await store.getAccount(accountId)) : null;
    if (accountId && !targetAccount) throw new Error("ACCOUNT_NOT_FOUND");
    if (forceThirty && targetAccount && targetAccount.service !== 'dola') {
      accountId = null;
      targetAccount = null;
    }
    const durationSeconds = Number(body.durationSeconds);
    if (!Number.isInteger(durationSeconds) || !ALL_VIDEO_DURATIONS.includes(durationSeconds)) throw new Error("INVALID_DURATION");
    const prompt = boundedText(body.positivePrompt ?? body.prompt, "PROMPT", 12_000);
    const aspectRatio = resolvePromptRatio(prompt, boundedText(body.aspectRatio || "9:16", "ASPECT_RATIO", 8));
    if (!VIDEO_RATIOS.includes(aspectRatio)) throw new Error("INVALID_ASPECT_RATIO");
    const negativePrompt = boundedText(body.negativePrompt || "", "NEGATIVE_PROMPT", 2_000, true);
    if (prompt.length + negativePrompt.length + (negativePrompt ? 32 : 0) > 12_000) {
      throw new Error("PROMPT_TOO_LONG");
    }
    const concurrency = body.concurrency === undefined ? 1 : Number(body.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new Error("INVALID_CONCURRENCY");
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

  const executeJob = async ({ job, account, reconciliation = false }, collectExisting = false) => {
    const expectedResultPath = path.join(generatedRoot, `${job.id}.mp4`);
    let worker;
    let workerError = null;
    try {
      if (job.collectOnly && !collectionUrl(job.remoteUrl, account.service)) {
        workerError = 'COLLECTION_REMOTE_URL_REQUIRED';
        throw new Error(workerError);
      }
      const browser = await sessions.open(account,{token:job.leaseToken});
      if (closing) {
        await store.updateJob(job.id, { status: job.collectOnly || job.remoteUrl ? 'reconciling' : 'queued',
          ...(job.collectOnly || job.remoteUrl ? { errorCode: 'WORKER_INTERRUPTED' } : {}), leaseToken: job.leaseToken });
        return;
      }
      worker = spawn(pythonExecutable, [workerPath], { cwd: workspaceRoot, windowsHide: true,
        env: browser.env, stdio: ["pipe", "pipe", "pipe"] });
      activeProcesses.add(worker);
      worker.stdin.end(JSON.stringify({ ...job, service: account.service,
        profilePath: account.profilePath, outputPath: expectedResultPath,
        collectExistingUrl: collectExisting || job.collectOnly ? job.remoteUrl : null,
        ...(reconciliation ? { collectionCheckSeconds: 90 } : {}) }));
      worker.stderr.on("data", () => {});
      const lines = readline.createInterface({ input: worker.stdout });
      let updates = Promise.resolve();
      lines.on("line", (line) => {
        updates = updates.then(async () => {
        if (line.length > 8_192) return;
        try {
          const item = JSON.parse(line);
          if (item.stage === "error") {
            workerError = /^[A-Z][A-Z0-9_]{2,80}$/.test(item.code) ? item.code : "BROWSER_AUTOMATION_FAILED";
            return;
          }
          if(item.stage==='conversation_restart'){
            if(item.code!=='CONVERSATION_CONTEXT_LIMIT')throw new Error('CONVERSATION_RESTART_UNSAFE');
            await store.restartJobConversation(job.id,job.leaseToken);
            return;
          }
          if (!new Set(["submitting", "submitted", "generating", "collecting", "success"]).has(item.stage)) return;
          const remoteUrl = validateRemoteUrl(account.service, item.remoteUrl);
          const resultPath = item.stage === "success" && item.resultPath === expectedResultPath
            && fs.existsSync(expectedResultPath) ? expectedResultPath : null;
          if (item.stage === "success" && !resultPath) throw new Error("RESULT_FILE_MISSING");
          (await store.updateJob(job.id, { leaseToken: job.leaseToken, status: item.stage, remoteUrl, resultPath,remoteMessageId:item.remoteMessageId }));
        } catch {
          workerError = "WORKER_PROTOCOL_ERROR";
          worker.kill();
        }
        });
      });
      const timeout = setTimeout(() => { workerError = "WORKER_TIMEOUT"; worker.kill(); },
        (account.service === "symphony" ? 22 : account.service === "dola"
          ? (job.model === "Dreamina Seedance 2.5" ? 75 : 18) : 12) * 60_000);
      try {
        await new Promise((resolve, reject) => {
          worker.once("error", reject);
          worker.once("close", resolve);
        });
      } finally { clearTimeout(timeout); }
      await updates;
      const current = (await store.getJob(job.id));
      if (current?.status !== "success") {
        const sessionEgress=await sessions.consumeEgressFailure(account);
        const possiblySubmitted = Boolean(current?.collectOnly || current?.remoteUrl)
          || new Set(["submitting", "submitted", "generating", "collecting", "reconciling"]).has(current?.status);
        const quotaExhausted = workerError === "DOUBAO_FREE_QUOTA_EXHAUSTED" || workerError === "DOLA_QUOTA_EXHAUSTED";
        const errorCode = sessionEgress || workerError || "WORKER_EXITED";
        if (EGRESS_ERRORS.has(errorCode)) await pool.markAccountEgressFailed(account.id);
        if (job.queuedAt != null && (quotaExhausted || !possiblySubmitted)) {
          if (errorCode === "PROFILE_IN_USE") profileRetryAfter.set(account.id, Date.now() + 5_000);
          if (MULTILOGIN_ERRORS.has(errorCode)) profileRetryAfter.set(account.id, Date.now() + 30_000);
          (await store.handleDispatchFailure(job.id, account.id, errorCode,
            { quotaExhausted, beforeSubmission: !possiblySubmitted, leaseToken: job.leaseToken }));
        } else {
          (await store.updateJob(job.id, { leaseToken: job.leaseToken, status: quotaExhausted || ["PLATFORM_GENERATION_FAILED","DOUBAO_SUBSCRIPTION_REQUIRED"].includes(errorCode) || !possiblySubmitted ? "failed" : "reconciling",
            errorCode }));
          if (quotaExhausted) (await store.markAccountQuotaExhausted(account.id, workerError));
        }
      }
    } catch (error) {
      const current = (await store.getJob(job.id));
      const sessionEgress=await sessions.consumeEgressFailure(account);
      const infraCode=sessionEgress || (INFRA_ERRORS.has(error?.message)?error.message:null);
      if(MULTILOGIN_ERRORS.has(infraCode))profileRetryAfter.set(account.id,Date.now()+30_000);
      if(infraCode && current?.status==='leased' && !current.collectOnly && !current.remoteUrl){
        await store.handleDispatchFailure(job.id,account.id,infraCode,
          {beforeSubmission:true,leaseToken:job.leaseToken});
        return;
      }
      if (current && !new Set(["queued", "success", "failed", "cancelled"]).has(current.status)) {
        (await store.updateJob(job.id, { leaseToken: job.leaseToken, status: current.status === "leased" && !current.collectOnly && !current.remoteUrl ? "failed" : "reconciling",
          errorCode: infraCode || workerError || "WORKER_LAUNCH_FAILED" }));
      }
    } finally {
      if (worker) activeProcesses.delete(worker);
      queueMicrotask(() => queueScheduler.wake());
      queueMicrotask(() => partnerApi.wake());
    }
  };

  if (options.seedAccount !== false && process.env.WORKBENCH_SEED_ACCOUNT !== "0" && (await store.listAccounts()).length === 0 && !(await store.hasAccountHistory())) {
    const defaultProfile = resolveProfilePath(profileRoot, DEFAULT_ACCOUNT_ID);
    (await store.ensureAccount({
      id: DEFAULT_ACCOUNT_ID,
      label: "豆包一号账号",
      loginType: "doubao",
      service: "doubao",
      workerId: DEFAULT_WORKER_ID,
      profilePath: defaultProfile,
      status: fs.existsSync(defaultProfile) ? "auth_required" : "provisioning",
    }));
  }

  const runVerification = async (account) => {
    if(options.verifyAccount) return options.verifyAccount(account);
    const selectedVerifier = account.loginType === "dola" ? path.join(workspaceRoot,"tools","verify-dola-profile.py") : account.loginType === "doubao" ? doubaoVerifierPath : verifierPath;
    if (!fs.existsSync(selectedVerifier)) throw new Error("VERIFIER_NOT_FOUND");
    if (!fs.existsSync(pythonExecutable)) throw new Error("PYTHON_NOT_CONFIGURED");
    if (!fs.existsSync(account.profilePath)) throw new Error("PROFILE_NOT_FOUND");
    const browser = await sessions.open(account);
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(pythonExecutable, [selectedVerifier, "--headed", "--profile", account.profilePath], {
        cwd: workspaceRoot,
        windowsHide: true,
        env: browser.env,
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      }));
    } catch (error) {
      stdout = typeof error.stdout === "string" ? error.stdout : "";
      if (!stdout.trim()) throw new Error(error.killed ? "VERIFIER_TIMEOUT" : "VERIFIER_FAILED");
    }
    const result=parseVerifierOutput(stdout, account.loginType);
    if(INFRA_ERRORS.has(result.error)){
      if(EGRESS_ERRORS.has(result.error))await pool.markAccountEgressFailed(account.id);
      throw new Error(result.error);
    }
    return result;
  };

  const resumeDola = createDolaRecovery({store,pool,sessions,locks:profileLaunchLocks,verificationLocks,
    inspect: input => privatePython(pythonExecutable,path.join(workspaceRoot,'tools',
      input.service === 'doubao' ? 'inspect_doubao_task.py' : 'inspect_dola_task.py'),input,85_000),
    confirm: input => privatePython(pythonExecutable,path.join(workspaceRoot,'tools','inspect_doubao_task.py'),
      {...input,confirmPending:true},85_000),
    verify:runVerification,wake:()=>queueMicrotask(queueScheduler.wake)});

  const reverifyAfterQueuedJob = async ({ job, account }) => {
    if (options.autoReverifyAfterQueuedJob === false) return;
    const current = (await store.getJob(job.id));
    const latestAccount = (await store.getAccount(account.id));
    if (!current || !latestAccount || new Set(["queued", "reconciling"]).has(current.status)
      || latestAccount.status === "cooling" || latestAccount.needsAttention || verificationLocks.has(account.id)) return;
    verificationLocks.add(account.id);
    (await store.setAccountChecking(account.id));
    try {
      const result = await runVerification(latestAccount);
      (await store.saveVerification(account.id, result, latestAccount));
    } catch (error) {
      (await store.saveVerificationFailure(account.id, String(error.message || "VERIFIER_FAILED").slice(0, 120)));
    } finally {
      verificationLocks.delete(account.id);
    }
  };

  const queueScheduler = createQueueScheduler({
    claim: async () => {
      const unavailableAccountIds = (await store.listAccounts()).filter((account) => {
        if (account.status !== "ready") return false;
        if (profileLaunchLocks.has(account.id) || verificationLocks.has(account.id)
          || (profileRetryAfter.get(account.id) || 0) > Date.now()) return true;
        profileRetryAfter.delete(account.id);
        // Local ownership checks avoid launching a second Chrome on a login profile.
        try { return !sessions.sessions.has(account.id) && (options.profileInUse || profileInUse)(account.profilePath); }
        catch { return true; }
      }).map((account) => account.id);
      return await store.claimNextReconciliation({ unavailableAccountIds, pool, maxConcurrent: Math.min(2, maxConcurrentJobs) })
        || await store.claimNextQueuedJob({ maxVerificationAgeMs, unavailableAccountIds, pool });
    },
    execute: executeJob,
    afterExecute: async assignment => {
      const current = await store.getJob(assignment.job.id);
      if (sessions.enabled && current?.status === "reconciling"
        && ["DOLA_HUMAN_VERIFICATION_REQUIRED", "DOUBAO_HUMAN_VERIFICATION_REQUIRED"].includes(current.errorCode)
        && sessions.sessions.has(assignment.account.id)) {
        await pool.handoffToManual(assignment.job.leaseToken);
        sessions.handoff(assignment.account, assignment.job.leaseToken);
        return;
      }
      try { await reverifyAfterQueuedJob(assignment); }
      finally { await sessions.idle(assignment.account,assignment.job.leaseToken); }
    },
    releaseClaim: async ({ job }) => {
      await store.updateJob(job.id, { status: job.collectOnly || job.remoteUrl ? 'reconciling' : 'queued',
        ...(job.collectOnly || job.remoteUrl ? { errorCode: 'WORKER_INTERRUPTED' } : {}), leaseToken: job.leaseToken });
      await pool.release(job.leaseToken);
    },
    canRun: async () => (await store.hasQueuedJobs()) && fs.existsSync(pythonExecutable) && fs.existsSync(workerPath),
    intervalMs: schedulerIntervalMs,
    maxConcurrent: maxConcurrentJobs,
    onError: async (error, assignment) => {
      console.error("QUEUE_DISPATCH_ERROR", String(error.message || error).slice(0, 160));
      if (!assignment) return;
      const current = (await store.getJob(assignment.job.id));
      if (current && !new Set(["success", "failed", "cancelled", "reconciling"]).has(current.status)) {
        (await store.updateJob(current.id, { leaseToken: assignment.job.leaseToken, status: current.status === "leased" && !current.collectOnly && !current.remoteUrl ? "failed" : "reconciling",
          errorCode: "QUEUE_DISPATCH_ERROR" }));
      }
    },
  });

  const partnerApi = (await createPartnerApi({ databasePath, generatedRoot, uploadRoot, port,
    wakeQueue: queueScheduler.wake, options: options.partnerApi,
    ...(options.partnerNow ? { now: options.partnerNow } : {}) }));

  const loginQueue = createLoginQueue({pool,store,sessions,verify:runVerification,
    assist: async (account,code,action) => privatePython(pythonExecutable,path.join(workspaceRoot,'tools','login-action.py'),{
      endpoint:sessions.sessions.get(account.id)?.endpoint,platform:account.loginType,action,code,
      credential:(await pool.runtime(account.id,{secrets:true})).credential}) });
  const handlePool = poolHttp({pool,store,profileRoot,workspaceRoot,pythonExecutable,readJson,json,login:loginQueue,
    keyFile:options.keyFile || process.env.WORKBENCH_KEY_FILE});

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

      if (await handlePool(request,response,pathname)) return;

      if (request.method === "GET" && pathname === "/pool") {
        response.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
        return fs.createReadStream(path.join(publicRoot,"pool.html")).pipe(response);
      }

      if (request.method === "GET" && pathname === "/api/health") {
        return json(response, 200, { ok: true, service: "symphony-pool-workbench", localOnly: true });
      }

      if (request.method === "GET" && pathname === "/api/overview") {
        return json(response, 200, {
          overview: (await store.overview()),
          accounts: (await store.listAccounts()).filter(account => LOGIN_TYPES.has(account.loginType)),
          busyAccountIds: (await store.listBusyAccountIds()),
          jobs: (await store.listJobs(50)),
          events: (await store.listEvents(60)),
          workerId: pool.workerId,
          automationEnabled: true,
          desktopPort,
        });
      }

      if (request.method === "GET" && pathname === "/api/accounts") {
        return json(response, 200, { accounts: (await store.listAccounts()).filter(account => LOGIN_TYPES.has(account.loginType)) });
      }

      if (request.method === "POST" && pathname === "/api/accounts") {
        const body = await readJson(request);
        const id = safeAccountId(body.accountId);
        const label = boundedText(body.label, "LABEL", 80);
        const loginType = body.loginType || "doubao";
        if (!LOGIN_TYPES.has(loginType)) throw new Error("INVALID_LOGIN_TYPE");
        const profilePath = resolveProfilePath(profileRoot, id);
        const account = await store.database.transaction(async()=>{
          if ((await store.listAccounts()).some((account) => account.id.toLowerCase() === id.toLowerCase())) {
            throw new Error("ACCOUNT_ALREADY_EXISTS");
          }
          if (pathEntryExists(profilePath)) throw new Error("ACCOUNT_PROFILE_ALREADY_EXISTS");
          const [workerId] = await pool.planNewAccountWorkers(1);
          const created=await store.ensureAccount({
            id,
            label,
            loginType,
            service: loginType,
            workerId,
            profilePath,
            status: "provisioning",
          });
          await pool.prepareNewAccount(id);
          return created;
        });
        return json(response, 201, { account });
      }

      const deleteAccountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (request.method === "DELETE" && deleteAccountMatch) {
        const id = safeAccountId(deleteAccountMatch[1]);
        const account = (await store.getAccount(id));
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (verificationLocks.has(id)) throw new Error("VERIFICATION_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        profileLaunchLocks.add(id);
        try {
        if ((await store.hasPendingJobForAccount(id))) throw new Error("ACCOUNT_HAS_PENDING_JOBS");
        const viewingLease=await pool.accountLease(id);
        if(sessions.enabled&&viewingLease?.owner===pool.owner&&viewingLease.purpose==='view'){
          await sessions.idle(account,viewingLease.token);
        }
        await pool.assertIdle(id);
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
          if(sessions.enabled&&sessions.sessions.has(id))await sessions.close(account);
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
        try { (await store.deleteAccount(id)); }
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
        } finally {profileLaunchLocks.delete(id);}
      }

      const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (request.method === "PATCH" && accountMatch) {
        const id = safeAccountId(accountMatch[1]);
        const body = await readJson(request);
        const nextId = safeAccountId(body.accountId ?? id);
        const label = boundedText(body.label, "LABEL", 80);
        const account = (await store.getAccount(id));
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (nextId === id) {
          return json(response, 200, { account: (await store.updateAccountLabel(id, label)) });
        }
        if (verificationLocks.has(id)) throw new Error("VERIFICATION_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        if ((await store.hasRunningJobForAccount(id))) throw new Error("ACCOUNT_ALREADY_RUNNING");
        await pool.assertIdle(id);
        if (nextId.toLowerCase() === id.toLowerCase()) throw new Error("ACCOUNT_ID_CASE_CONFLICT");
        if ((await store.listAccounts()).some((item) => item.id.toLowerCase() === nextId.toLowerCase())) {
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
          updated = (await store.updateAccountIdentity(id, nextId, label, nextProfilePath, (a,b)=>pool.renameBinding(a,b)));
        } catch (error) {
          if (movedProfile) {
            try { fs.renameSync(nextProfilePath, oldProfilePath); }
            catch { throw new Error("ACCOUNT_PROFILE_ROLLBACK_FAILED"); }
          }
          throw error;
        }
        return json(response, 200, { account: updated });
      }

      if(request.method==='GET'&&pathname==='/api/browser-sessions'){
        const residents=new Set(await pool.residentAccountIds());
        const accounts=(await store.listAccounts()).filter(a=>LOGIN_TYPES.has(a.loginType));
        return json(response,200,{managed:sessions.enabled,accounts:await Promise.all(accounts.map(async account=>({
          id:account.id,label:account.label,service:account.service,workerId:account.workerId,
          local:account.workerId===pool.workerId,resident:residents.has(account.id),
          running:sessions.isAlive(account),status:account.status,
          busy:await store.hasRunningJobForAccount(account.id),
          error:residency.failures.get(account.id)?.error||null,
        })))});
      }
      if(request.method==='POST'&&pathname==='/api/browser-viewer/detach'){
        const body=await readJson(request);await releaseViewer(sessions.detachViewer(body.viewerId));
        return json(response,200,{ok:true,keptOpen:true});
      }
      const openMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/open$/);
      if (request.method === "POST" && openMatch) {
        const id = safeAccountId(openMatch[1]);
        const account = (await store.getAccount(id));
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if ((await store.hasRunningJobForAccount(id))) throw new Error("ACCOUNT_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id) || verificationLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        if (!fs.existsSync(launcherPath)) return json(response, 500, { error: "LAUNCHER_NOT_FOUND" });
        if (!runtime.windows && !fs.existsSync(pythonExecutable)) {
          return json(response, 503, { error: "PYTHON_NOT_CONFIGURED" });
        }
        if (sessions.enabled) {
          const body=await readJson(request);
          const previous=body.viewerId?sessions.viewer(body.viewerId):null;
          const existing = sessions.sessions.get(id);
          const previousToken = existing?.token;
          const token = previousToken || await pool.reserve(account,await pool.isResident(id)?"view":"manual");
          if (!token) throw new Error("ACCOUNT_OR_WORKER_BUSY");
          profileLaunchLocks.add(id);
          try { const opened = await sessions.open(account,{manual:true,interactiveOnly:true,token}); await store.recordProfileOpened(id);
            const desktop=body.viewerId?sessions.selectViewer(account,body.viewerId):opened.desktop;
            if(previous?.accountId!==id)await releaseViewer(previous);
            return json(response,200,{ok:true,accountId:id,alreadyOpen:Boolean(existing),desktop,resident:await pool.isResident(id)});
          } catch (error) { try { if(!previousToken)await sessions.idle(account,token); } catch {} throw error; }
          finally{profileLaunchLocks.delete(id);}
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
        (await store.recordProfileOpened(id));
        return json(response, 202, { ok: true, accountId: id, alreadyOpen, ...(desktop ? { desktop } : {}) });
      }

      const closeLoginMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/close-login$/);
      if (request.method === "POST" && closeLoginMatch) {
        const id = safeAccountId(closeLoginMatch[1]);
        const account = (await store.getAccount(id));
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if (runtime.windows) return json(response, 409, { error: "PROFILE_CLOSE_UNSUPPORTED" });
        if ((await store.hasRunningJobForAccount(id))) throw new Error("ACCOUNT_ALREADY_RUNNING");
        if (profileLaunchLocks.has(id) || verificationLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        if (sessions.enabled) {
          const session=sessions.sessions.get(id);
          await sessions.idle(account,session?.token);
          return json(response,200,{ok:true,accountId:id,keptOpen:await pool.isResident(id)});
        }
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
        const account = (await store.getAccount(id));
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if ((await store.hasRunningJobForAccount(id))) throw new Error("ACCOUNT_ALREADY_RUNNING");
        const pending = await store.pendingDolaJobsForAccount(id);
        if (pending.length) return json(response,409,{error:"PENDING_TASK_RECOVERY_REQUIRED",
          loginUrl:`/accounts/${encodeURIComponent(id)}/login`,jobs:pending});
        if (verificationLocks.has(id)) return json(response, 409, { error: "VERIFICATION_ALREADY_RUNNING" });
        if (profileLaunchLocks.has(id)) throw new Error("ACCOUNT_PROFILE_IN_USE");
        let verificationToken;
        if(sessions.enabled){ verificationToken=sessions.sessions.get(id)?.token || await pool.reserve(account,"verify"); if(!verificationToken)throw new Error("ACCOUNT_OR_WORKER_BUSY"); }
        verificationLocks.add(id);
        (await store.setAccountChecking(id));
        try {
          const result = await runVerification(account);
          const updated = (await store.saveVerification(id, result, account));
          return json(response, result.ok ? 200 : 409, {
            ...(result.ok ? {} : { error: result.error || "VERIFICATION_FAILED" }),
            result,
            account: updated,
          });
        } catch (error) {
          const code = String(error.message || "VERIFIER_FAILED").slice(0, 120);
          (await store.saveVerificationFailure(id, code));
          return json(response, 500, { error: code });
        } finally {
          await sessions.idle(account,verificationToken);
          verificationLocks.delete(id);
          queueMicrotask(queueScheduler.wake);
        }
      }

      if (request.method === "GET" && pathname === "/api/workbench/jobs") {
        const status = requestUrl.searchParams.get("status") || "all";
        const page = Number(requestUrl.searchParams.get("page") || 1);
        const pageSize = Number(requestUrl.searchParams.get("pageSize") || 6);
        if (!JOB_FILTERS.has(status)) throw new Error("INVALID_JOB_FILTER");
        if (!Number.isSafeInteger(page) || page < 1
          || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
          throw new Error("INVALID_JOB_PAGE");
        }
        return json(response, 200, (await workbenchJobsPage({ status, page, pageSize })));
      }

      const workbenchResultMatch = pathname.match(/^\/api\/workbench\/video-results\/([^/]+)$/);
      if (request.method === "GET" && workbenchResultMatch) {
        const taskId = validateTaskId(workbenchResultMatch[1]);
        const task = (await videoApiStore.getLocalResult(taskId));
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
          if (!JOB_FILTERS.has(status)) throw new Error("INVALID_JOB_FILTER");
          if (!Number.isSafeInteger(page) || page < 1
            || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
            throw new Error("INVALID_JOB_PAGE");
          }
          return json(response, 200, (await store.listJobsPage({ status, page, pageSize })));
        }
        return json(response, 200, { jobs: (await store.listJobs(100)) });
      }

      if (request.method === "GET" && pathname === "/api/events") {
        const page = Number(requestUrl.searchParams.get("page") || 1);
        const pageSize = Number(requestUrl.searchParams.get("pageSize") || 10);
        if (!Number.isSafeInteger(page) || page < 1
          || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
          throw new Error("INVALID_EVENT_PAGE");
        }
        return json(response, 200, (await store.listEventsPage({ page, pageSize })));
      }

      if (request.method === "GET" && pathname === "/api/video-provider/models") {
        const key = apiKeyFromRequest(request);
        const models = await videoApi.models(key);
        await videoApiScheduler.attach(key);
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
        const batch = (await videoApiStore.enqueue(fingerprint, idempotencyKey, payload));
        await videoApiScheduler.attach(key);
        return json(response, 202, { batch });
      }

      if (request.method === "GET" && pathname === "/api/video-provider/history") {
        const key = apiKeyFromRequest(request);
        const fingerprint = apiKeyFingerprint(key);
        const page = Number(requestUrl.searchParams.get("page") || 1);
        if (!Number.isSafeInteger(page) || page < 1) throw new VideoApiError(400, "INVALID_VIDEO_API_PAGE");
        await videoApiScheduler.attach(key);
        return json(response, 200, (await videoApiStore.listBatches(fingerprint, { page })));
      }

      const providerRetryMatch = pathname.match(/^\/api\/video-provider\/batches\/(\d+)\/retry$/);
      if (request.method === "POST" && providerRetryMatch) {
        const key = apiKeyFromRequest(request);
        const batch = (await videoApiStore.retryBlocked(apiKeyFingerprint(key), Number(providerRetryMatch[1])));
        await videoApiScheduler.attach(key);
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
        (await videoApiStore.updateTask(apiKeyFingerprint(key), taskId, upstream));
        await videoApiScheduler.attach(key);
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
        const input = (await parseVideoJob({ ...body, mode: "image_to_video",
          concurrency: body.concurrency ?? 1, negativePrompt: body.negativePrompt ?? "" }));
        if (!fs.existsSync(pythonExecutable) || !fs.existsSync(workerPath)) throw new Error("WORKER_NOT_CONFIGURED");
        const idempotencyKey = boundedText(body.idempotencyKey || `generation-${randomUUID()}`,
          "IDEMPOTENCY_KEY", 160);
        let draft = (await store.getJobByIdempotencyKey(idempotencyKey));
        if (!draft) {
          try { draft = (await store.createDraftJob({ ...input, idempotencyKey })); }
          catch (error) {
            draft = (await store.getJobByIdempotencyKey(idempotencyKey));
            if (!draft) throw error;
          }
        }
        if (!sameGenerationRequest(draft, input)) throw new Error("IDEMPOTENCY_CONFLICT");
        if (draft.status !== "draft") {
          return json(response, 200, { batchId: draft.batchId || draft.id,
            jobs: (await store.listBatchJobs(draft.batchId || draft.id)) });
        }
        const started = (await store.enqueueBatch(draft.id)).map(job => ({ job }));
        queueMicrotask(queueScheduler.wake);
        return json(response, 202, { batchId: started[0].job.batchId || draft.id,
          jobs: started.map((assignment) => assignment.job) });
      }

      const generationMatch = pathname.match(/^\/api\/video-generations\/([^/]+)$/);
      if (request.method === "GET" && generationMatch) {
        const batchId = boundedText(generationMatch[1], "BATCH_ID", 160);
        const jobs = (await store.listBatchJobs(batchId));
        return jobs.length ? json(response, 200, { batchId, jobs })
          : json(response, 404, { error: "JOB_NOT_FOUND" });
      }

      if (request.method === "POST" && pathname === "/api/jobs") {
        const body = await readJson(request);
        const enqueue = body.enqueue === true;
        const parsedJob = (await parseVideoJob(body));

        const job = (await store.createDraftJob({
          idempotencyKey: boundedText(body.idempotencyKey || `draft-${randomUUID()}`, "IDEMPOTENCY_KEY", 160),
          ...parsedJob,
          enqueue: false,
        }));
        if (enqueue) await store.enqueueBatch(job.id);
        json(response, enqueue ? 202 : 201, { job: await store.getJob(job.id), automationEnabled: true });
        if (enqueue) queueMicrotask(queueScheduler.wake);
        return;
      }

      const getJobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (request.method === "GET" && getJobMatch) {
        const job = (await store.getJob(boundedText(getJobMatch[1], "JOB_ID", 160)));
        return job ? json(response, 200, { job }) : json(response, 404, { error: "JOB_NOT_FOUND" });
      }

      const editMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (request.method === "PATCH" && editMatch) {
        const id = boundedText(editMatch[1], "JOB_ID", 160);
        if (!(await store.getJob(id))) return json(response, 404, { error: "JOB_NOT_FOUND" });
        const job = (await store.updateDraftJob(id, (await parseVideoJob(await readJson(request)))));
        return json(response, 200, { job });
      }

      const startMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const id = boundedText(startMatch[1], "JOB_ID", 160);
        const job = (await store.getJob(id));
        if (!job) return json(response, 404, { error: "JOB_NOT_FOUND" });
        if (!fs.existsSync(pythonExecutable) || !fs.existsSync(workerPath)) throw new Error("WORKER_NOT_CONFIGURED");
        job.referenceAssets.forEach(validateImage);
        if (job.mode === "reference_to_video") validateVideo(job.referenceVideo);
        const started = (await store.enqueueBatch(id)).map(job => ({ job }));
        queueMicrotask(queueScheduler.wake);
        return json(response, 202, { job: started[0].job,
          jobs: started.map((assignment) => assignment.job), batchId: started[0].job.batchId || id });
      }

      const queueMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/queue$/);
      if (request.method === "POST" && queueMatch) {
        const id = boundedText(queueMatch[1], "JOB_ID", 160);
        const job = (await store.getJob(id));
        if (!job) return json(response, 404, { error: "JOB_NOT_FOUND" });

        job.referenceAssets.forEach(validateImage);
        if (job.mode === "reference_to_video") validateVideo(job.referenceVideo);
        const queued = (await store.enqueueBatch(id))[0];
        json(response, 202, { job: queued });
        queueMicrotask(queueScheduler.wake);
        return;
      }

      const resumeDolaMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume-after-verification$/);
      if (request.method === "POST" && resumeDolaMatch) {
        return json(response,202,await resumeDola(boundedText(resumeDolaMatch[1],"JOB_ID",160)));
      }

      const pendingVerification = pathname.match(/^\/api\/accounts\/([^/]+)\/pending-verification$/);
      if (request.method === "GET" && pendingVerification) {
        const id = safeAccountId(pendingVerification[1]);
        return json(response,200,{jobs:await store.pendingDolaJobsForAccount(id)});
      }

      const attachRemoteMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/attach-remote$/);
      if (request.method === "POST" && attachRemoteMatch) {
        const id = boundedText(attachRemoteMatch[1], "JOB_ID", 160);
        const job = await store.getJob(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        const account = await store.getAccount(job.accountId);
        if (account?.service !== "dola") throw new Error("SERVICE_NOT_CONNECTED");
        const input = await readJson(request);
        const remoteUrl = validateRemoteUrl(account.service, boundedText(input.remoteUrl, "REMOTE_URL", 2048));
        if (!remoteUrl) throw new Error("INVALID_REMOTE_URL");
        return json(response, 200, { job: await store.attachRemoteTask(id, remoteUrl) });
      }

      const recollectMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/recollect$/);
      if (request.method === "POST" && recollectMatch) {
        const id = boundedText(recollectMatch[1], "JOB_ID", 160);
        const job = (await store.getJob(id));
        if (!job) return json(response, 404, { error: "JOB_NOT_FOUND" });
        const account = (await store.getAccount(job.accountId));
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (!fs.existsSync(pythonExecutable) || !fs.existsSync(workerPath)) throw new Error("WORKER_NOT_CONFIGURED");
        const remoteUrl = validateRemoteUrl(account.service, job.remoteUrl);
        if (!remoteUrl || (account.service === "doubao" && !/^\/chat\/\d+$/.test(new URL(remoteUrl).pathname))
          || (account.service === "symphony" && !/^\d+$/.test(new URL(remoteUrl).searchParams.get("activeId") || ""))) {
          throw new Error("INVALID_REMOTE_URL");
        }
        const started = (await store.recollectJob(id));
        queueMicrotask(queueScheduler.wake);
        return json(response, 202, { job: started.job });
      }

      const resultMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/result$/);
      if ((request.method === "GET" || request.method === "HEAD") && resultMatch) {
        const job = (await store.getJob(boundedText(resultMatch[1], "JOB_ID", 160)));
        if (!job || job.status !== "success") return json(response, 404, { error: "RESULT_NOT_FOUND" });
        const expected = path.join(generatedRoot, `${job.id}.mp4`);
        if (job.resultPath !== expected || !fs.existsSync(expected)) return json(response, 404, { error: "RESULT_NOT_FOUND" });
        if (requestUrl.searchParams.get("original") === "1") {
          const original = path.join(generatedRoot, `${job.id}.original.mp4`);
          if (!fs.existsSync(original)) return json(response, 404, { error: "RESULT_NOT_FOUND" });
          return sendVideo(request, response, original, `${job.id}-original.mp4`);
        }
        if ((await store.getAccount(job.accountId))?.service === 'dola' || job.model?.startsWith('Dreamina Seedance')) {
          try { await assertTrackedDolaVideo(expected); }
          catch { return json(response, 409, { error: 'WATERMARK_REPAIR_FAILED' }); }
        }
        return sendVideo(request, response, expected, `${job.id}.mp4`, requestUrl.searchParams.get("preview") === "1");
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        (await store.cancelJob(boundedText(cancelMatch[1], "JOB_ID", 160)));
        return json(response, 200, { ok: true });
      }

      if (request.method === "GET" && !pathname.startsWith("/api/")) {
        const loginPage = pathname.match(/^\/accounts\/([^/]+)\/login$/);
        if (loginPage) {
          const id = safeAccountId(loginPage[1]);
          if (!(await store.getAccount(id))) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
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
      const rawCode = String(error.message || "INTERNAL_ERROR");
      const code = /^[A-Z][A-Z0-9_]{2,159}$/.test(rawCode) ? rawCode : "INTERNAL_ERROR";
      const status = code.includes("NOT_FOUND") ? 404
        : code.includes("NOT_CANCELLABLE") || code.includes("ALREADY_RUNNING") || code.includes("NOT_STARTABLE")
          || code.includes("NOT_EDITABLE") || code.includes("NOT_QUEUEABLE")
          || code.includes("NOT_RECOLLECTABLE") || code.includes("NOT_RECONCILABLE") || code === "REMOTE_TASK_ALREADY_BOUND"
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
    pool,
    async listen() {
      await pool.start(); poolStarted=true;
      await store.restoreReconciliation();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          poolTimer = setInterval(() => { void sessions.collectFailures().then(()=>pool.heartbeat()).then(()=>loginQueue.wake()).catch(() => { for (const child of activeProcesses) child.kill(); void queueScheduler.stop(); }); }, 20_000);
          poolTimer.unref();
          residencyTimer=setInterval(()=>void residency.wake()?.catch(()=>{}),20_000);
          residencyTimer.unref();void residency.wake()?.catch(()=>{});
          queueScheduler.start();
          videoApiScheduler.start();
          partnerApi.start();
          resolve({ host, port, url: `http://${host}:${port}` });
        });
      });
    },
    close() {
      closing=true;
      clearInterval(poolTimer);
      clearInterval(residencyTimer);
      const waitingForResidency=residency.stop();
      const waitingForQueue = queueScheduler.stop();
      const waitingForVideoApi = videoApiScheduler.stop();
      const waitingForPartner = partnerApi.stop();
      const waitingForLogin = loginQueue.stop();
      for (const child of activeProcesses) child.kill();
      return new Promise((resolve) => server.close(() => {
        const wait = () => activeProcesses.size ? setTimeout(wait, 100)
          : Promise.all([waitingForQueue, waitingForVideoApi, waitingForPartner, waitingForLogin,waitingForResidency]).then(async () => {
            for (const session of sessions.sessions.values()) {
              try { await sessions.close(session.account); await pool.release(session.token); } catch { /* Expiring leases prevent immediate reuse if the browser could not stop. */ }
            }
            if(poolStarted) await pool.stop(); await partnerApi.close(); (await videoApiStore.close()); (await store.close()); resolve();
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
  const app = (await createWorkbenchServer({
    host: process.env.WORKBENCH_HOST || "127.0.0.1",
    port: Number(process.env.WORKBENCH_PORT || 8787),
    databasePath: process.env.WORKBENCH_DATABASE_PATH,
    profileRoot: process.env.WORKBENCH_PROFILE_ROOT,
  }));
  const address = await app.listen();
  console.log(JSON.stringify({ status: "listening", ...address, localOnly: address.host === "127.0.0.1" }));

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
