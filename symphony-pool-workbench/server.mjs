import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createStore } from "./lib/db.mjs";

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
const MODE_OPTIONS = new Set(["reference_to_video", "image_to_video", "text_to_video"]);

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
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
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

function sameOriginAllowed(request, host, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return new Set([`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]).has(origin);
}

function parseVerifierOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("EMPTY_VERIFIER_OUTPUT");
  const parsed = JSON.parse(lines.at(-1));
  return {
    ok: Boolean(parsed.ok),
    loggedIn: Boolean(parsed.loggedIn),
    creditPageReady: Boolean(parsed.creditPageReady),
    createPageReady: Boolean(parsed.createPageReady),
    remainingCredits: Number.isInteger(parsed.remainingCredits) ? parsed.remainingCredits : null,
    totalCredits: Number.isInteger(parsed.totalCredits) ? parsed.totalCredits : null,
    nextRefresh: typeof parsed.nextRefresh === "string" ? parsed.nextRefresh : null,
    referenceImageLimit: Number.isInteger(parsed.referenceImageLimit) ? parsed.referenceImageLimit : null,
    modelsObserved: Array.isArray(parsed.modelsObserved)
      ? parsed.modelsObserved.filter((item) => MODEL_OPTIONS.has(item))
      : [],
    stage: typeof parsed.stage === "string" ? parsed.stage.slice(0, 80) : null,
    error: typeof parsed.error === "string" ? parsed.error.slice(0, 160) : null,
  };
}

export function createWorkbenchServer(options = {}) {
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("LOCAL_HOST_REQUIRED");
  const port = Number(options.port || 8787);
  const workspaceRoot = path.resolve(options.workspaceRoot || defaultWorkspaceRoot);
  const databasePath = path.resolve(options.databasePath || path.join(projectRoot, "data", "workbench.sqlite"));
  const verifierPath = path.resolve(options.verifierPath || path.join(workspaceRoot, "tools", "verify-symphony-profile.py"));
  const doubaoVerifierPath = path.resolve(options.doubaoVerifierPath || path.join(workspaceRoot, "tools", "verify-doubao-profile.py"));
  const launcherPath = path.resolve(options.launcherPath || path.join(workspaceRoot, "tools", "open-symphony-profile.ps1"));
  const pythonExecutable = options.pythonExecutable || process.env.WORKBENCH_PYTHON ||
    path.join(projectRoot, ".venv", "Scripts", "python.exe");
  const store = createStore(databasePath);
  const verificationLocks = new Set();

  const defaultProfile = resolveProfilePath(workspaceRoot, DEFAULT_ACCOUNT_ID);
  store.ensureAccount({
    id: DEFAULT_ACCOUNT_ID,
    label: "Symphony TK 一号账号",
    loginType: "tiktok",
    service: "symphony",
    workerId: DEFAULT_WORKER_ID,
    profilePath: defaultProfile,
    status: fs.existsSync(defaultProfile) ? "auth_required" : "provisioning",
  });

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
    return parseVerifierOutput(stdout);
  };

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
          jobs: store.listJobs(50),
          events: store.listEvents(60),
          automationEnabled: false,
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
        const account = store.ensureAccount({
          id,
          label,
          loginType,
          service: loginType === "doubao" ? "doubao" : "symphony",
          workerId,
          profilePath: resolveProfilePath(workspaceRoot, id),
          status: "provisioning",
        });
        return json(response, 201, { account });
      }

      const openMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/open$/);
      if (request.method === "POST" && openMatch) {
        const id = safeAccountId(openMatch[1]);
        const account = store.getAccount(id);
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if (!fs.existsSync(launcherPath)) return json(response, 500, { error: "LAUNCHER_NOT_FOUND" });
        try {
          await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
            "-AccountId", id, "-LoginType", account.loginType], {
            cwd: workspaceRoot,
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 16 * 1024,
          });
        } catch (error) {
          return json(response, 500, { error: error.killed ? "PROFILE_LAUNCH_TIMEOUT" : "PROFILE_LAUNCH_FAILED" });
        }
        store.recordProfileOpened(id);
        return json(response, 202, { ok: true, accountId: id });
      }

      const verifyMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/verify$/);
      if (request.method === "POST" && verifyMatch) {
        const id = safeAccountId(verifyMatch[1]);
        const account = store.getAccount(id);
        if (!account) return json(response, 404, { error: "ACCOUNT_NOT_FOUND" });
        if (verificationLocks.has(id)) return json(response, 409, { error: "VERIFICATION_ALREADY_RUNNING" });
        verificationLocks.add(id);
        store.setAccountChecking(id);
        try {
          const result = await runVerification(account);
          const updated = store.saveVerification(id, result);
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
        }
      }

      if (request.method === "GET" && pathname === "/api/jobs") {
        return json(response, 200, { jobs: store.listJobs(100) });
      }

      if (request.method === "POST" && pathname === "/api/jobs") {
        const body = await readJson(request);
        const mode = boundedText(body.mode, "MODE", 40);
        const model = boundedText(body.model, "MODEL", 80);
        if (!MODE_OPTIONS.has(mode)) throw new Error("INVALID_MODE");
        if (!MODEL_OPTIONS.has(model)) throw new Error("INVALID_MODEL");
        const durationSeconds = Number(body.durationSeconds);
        if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
          throw new Error("INVALID_DURATION");
        }
        const prompt = boundedText(body.prompt, "PROMPT", 12_000);
        const priority = Number.isInteger(Number(body.priority)) ? Math.max(0, Math.min(100, Number(body.priority))) : 50;
        const referenceAssets = Array.isArray(body.referenceAssets)
          ? body.referenceAssets.map((item) => boundedText(item, "REFERENCE_ASSET", 500)).slice(0, 4)
          : [];
        if ((body.referenceAssets || []).length > 4) throw new Error("TOO_MANY_REFERENCE_ASSETS");
        const accountId = body.accountId ? safeAccountId(body.accountId) : null;
        const targetAccount = accountId ? store.getAccount(accountId) : null;
        if (accountId && !targetAccount) throw new Error("ACCOUNT_NOT_FOUND");
        if (targetAccount && targetAccount.service !== "symphony") {
          throw new Error("ACCOUNT_NOT_SUPPORTED_FOR_SYMPHONY_JOB");
        }
        const job = store.createDraftJob({
          idempotencyKey: boundedText(body.idempotencyKey || `draft-${randomUUID()}`, "IDEMPOTENCY_KEY", 160),
          accountId,
          mode,
          model,
          durationSeconds,
          prompt,
          referenceAssets,
          priority,
        });
        return json(response, 201, { job, automationEnabled: false });
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        store.cancelJob(boundedText(cancelMatch[1], "JOB_ID", 160));
        return json(response, 200, { ok: true });
      }

      if (request.method === "GET" && !pathname.startsWith("/api/")) {
        const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const filePath = path.resolve(publicRoot, relative);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`) && filePath !== path.join(publicRoot, "index.html")) {
          response.writeHead(403);
          return response.end("Forbidden");
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          response.writeHead(404);
          return response.end("Not found");
        }
        response.writeHead(200, {
          "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
          "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=300",
        });
        return fs.createReadStream(filePath).pipe(response);
      }

      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const code = String(error.message || "INTERNAL_ERROR").slice(0, 160);
      const status = code.includes("NOT_FOUND") ? 404
        : code.includes("NOT_CANCELLABLE") || code.includes("ALREADY_RUNNING") ? 409
          : code === "PAYLOAD_TOO_LARGE" ? 413
            : code === "INTERNAL_ERROR" ? 500 : 400;
      return json(response, status, { error: code });
    }
  });

  return {
    server,
    store,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve({ host, port, url: `http://${host}:${port}` }));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => {
        store.close();
        resolve();
      }));
    },
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const app = createWorkbenchServer({
    host: process.env.WORKBENCH_HOST || "127.0.0.1",
    port: Number(process.env.WORKBENCH_PORT || 8787),
    databasePath: process.env.WORKBENCH_DATABASE_PATH,
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
