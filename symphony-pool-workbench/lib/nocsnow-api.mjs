import { createHash } from "node:crypto";
import { isIP } from "node:net";

const DEFAULT_BASE_URL = "https://nocsnow.com/api/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export class VideoApiError extends Error {
  constructor(status, code, requestId = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function apiKeyFromRequest(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)
    || authorization.length > 1024) {
    throw new VideoApiError(401, "VIDEO_API_KEY_REQUIRED");
  }
  return authorization.slice(7);
}

export function apiKeyFingerprint(key) {
  return createHash("sha256").update(key).digest("hex");
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new VideoApiError(400, "INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}

export function validateTaskId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new VideoApiError(400, "INVALID_VIDEO_TASK_ID");
  }
  return value;
}

export function imageContentType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function boundedString(value, name, maxLength, required = true) {
  if (typeof value !== "string") throw new VideoApiError(400, `INVALID_${name}`);
  const result = value.trim();
  if ((required && !result) || result.length > maxLength) throw new VideoApiError(400, `INVALID_${name}`);
  return result;
}

export function validateGeneration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VideoApiError(400, "INVALID_GENERATION_REQUEST");
  }
  const allowed = new Set(["model", "prompt", "negative_prompt", "ratio", "duration", "resolution",
    "reference_asset_ids", "count"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new VideoApiError(400, "INVALID_GENERATION_REQUEST");
  }
  const model = boundedString(body.model, "MODEL", 120);
  const prompt = boundedString(body.prompt, "PROMPT", 5_000);
  const negativePrompt = boundedString(body.negative_prompt ?? "", "NEGATIVE_PROMPT", 2_000, false);
  const ratio = boundedString(body.ratio, "RATIO", 32);
  const resolution = boundedString(body.resolution, "RESOLUTION", 32);
  const duration = Number(body.duration);
  const count = Number(body.count ?? 1);
  if (!Number.isInteger(duration) || duration < 1 || duration > 120) {
    throw new VideoApiError(400, "INVALID_DURATION");
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new VideoApiError(400, "INVALID_VIDEO_COUNT");
  }
  const referenceAssetIds = body.reference_asset_ids ?? [];
  if (!Array.isArray(referenceAssetIds) || referenceAssetIds.length > 9
    || referenceAssetIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || new Set(referenceAssetIds).size !== referenceAssetIds.length) {
    throw new VideoApiError(400, "INVALID_REFERENCE_ASSET_IDS");
  }
  return { model, prompt, negative_prompt: negativePrompt, ratio, duration, resolution,
    generate_audio: false, reference_asset_ids: referenceAssetIds, count };
}

export function createVideoApiClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  const base = new URL(baseUrl.replace(/\/$/, "") + "/");
  if (base.protocol !== "https:" && !(base.protocol === "http:"
    && ["127.0.0.1", "localhost"].includes(base.hostname))) {
    throw new Error("INVALID_VIDEO_API_BASE_URL");
  }

  async function request(path, key, { method = "GET", headers = {}, body, timeoutMs = 30_000,
    redirect = "follow" } = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path.replace(/^\//, ""), base), {
        method, headers: { Authorization: `Bearer ${key}`, ...headers }, body,
        signal: AbortSignal.timeout(timeoutMs), redirect,
      });
    } catch {
      throw new VideoApiError(504, "VIDEO_API_UNAVAILABLE");
    }
    if (!response.ok && !(redirect === "manual" && response.status === 302)) {
      const payload = await response.json().catch(() => ({}));
      const code = String(payload?.error?.code || "VIDEO_API_UPSTREAM_ERROR");
      const safeCode = /^[A-Za-z][A-Za-z0-9_:-]{0,100}$/.test(code)
        ? code : "VIDEO_API_UPSTREAM_ERROR";
      const requestId = typeof payload?.error?.request_id === "string"
        && UUID.test(payload.error.request_id) ? payload.error.request_id : null;
      const error = new VideoApiError(response.status, safeCode, requestId);
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        error.retryAfterMs = Math.min(retryAfter * 1_000, 300_000);
      }
      throw error;
    }
    return response;
  }

  async function requestJson(path, key, options) {
    const response = await request(path, key, options);
    try { return await response.json(); }
    catch { throw new VideoApiError(502, "VIDEO_API_INVALID_RESPONSE"); }
  }

  return {
    models(key) { return requestJson("models", key); },
    upload(key, bytes, mime, filename) {
      return requestJson("uploads", key, { method: "POST", body: bytes,
        headers: { "Content-Type": mime, "X-Filename": filename }, timeoutMs: 60_000 });
    },
    create(key, payload, idempotencyKey) {
      return requestJson("generations", key, { method: "POST", body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        timeoutMs: 60_000 });
    },
    task(key, taskId) { return requestJson(`generations/${taskId}`, key); },
    async result(key, taskId, range) {
      const response = await request(`generations/${taskId}/result`, key, { redirect: "manual",
        headers: range ? { Range: range } : {}, timeoutMs: 60_000 });
      if (response.status !== 302) return response;
      const location = response.headers.get("location");
      if (!location) throw new VideoApiError(502, "VIDEO_API_INVALID_RESULT");
      let target;
      try { target = new URL(location, base); } catch { throw new VideoApiError(502, "VIDEO_API_INVALID_RESULT"); }
      if (target.protocol !== "https:" || target.username || target.password || isIP(target.hostname)
        || target.hostname === "localhost" || target.hostname.endsWith(".local")) {
        throw new VideoApiError(502, "VIDEO_API_INVALID_RESULT");
      }
      try {
        const redirected = await fetchImpl(target, { headers: range ? { Range: range } : {},
          redirect: "error", signal: AbortSignal.timeout(60_000) });
        if (!redirected.ok) throw new VideoApiError(redirected.status, "VIDEO_API_RESULT_UNAVAILABLE");
        return redirected;
      } catch (error) {
        if (error instanceof VideoApiError) throw error;
        throw new VideoApiError(504, "VIDEO_API_UNAVAILABLE");
      }
    },
  };
}
