import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import http from "node:http";

export const DAY = 86_400_000;
export const MODELS = [
  { model: "Seedance 2.0 Fast", version: "2.0 Fast", durations: [5, 10], ratios: ["9:16", "16:9"], max_images: 9 },
  { model: "Seedance 2.0 Mini", version: "2.0 Mini", durations: [5, 10], ratios: ["9:16", "16:9"], max_images: 9 },
  { model: "Video 1.5 Pro", version: "1.5 Pro", durations: [5, 10, 12], ratios: ["9:16"], max_images: 4 },
];
export const ERRORS = {
  INVALID_PARAMETER: [400, "参数缺失、类型错误或超出范围"],
  INVALID_API_KEY: [401, "API Key 缺失或无效"],
  TASK_NOT_FOUND: [404, "任务不存在"],
  NOT_FOUND: [404, "接口不存在"],
  METHOD_NOT_ALLOWED: [405, "请求方法不支持"],
  ID_CONFLICT: [409, "client_task_id 已用于不同的参数或图片"],
  RESULT_NOT_READY: [409, "该视频尚无可下载结果"],
  RESULT_EXPIRED: [410, "视频文件已超过保留期"],
  RESULT_MISSING: [410, "视频文件已不可用"],
  UPLOAD_TOO_LARGE: [413, "图片或请求体超过限制"],
  UNSUPPORTED_IMAGE_FORMAT: [415, "仅支持 PNG、JPEG、WebP 图片"],
  UNSUPPORTED_MEDIA_TYPE: [415, "请使用 multipart/form-data 或无图片的 application/json"],
  INVALID_RANGE: [416, "不支持该下载范围"],
  UNSUPPORTED_COMBINATION: [422, "模型、时长、比例或图片数量组合不支持"],
  CALLBACK_NOT_ALLOWED: [422, "回调地址未在服务端登记"],
  INVALID_DOWNLOAD_SIGNATURE: [403, "下载签名无效"],
  DOWNLOAD_LINK_EXPIRED: [403, "下载链接已过期，请重新查询任务"],
  RATE_LIMITED: [429, "请求过于频繁，请稍后重试"],
  QUEUE_FULL: [503, "待处理任务已达上限，请稍后重试"],
  API_NOT_CONFIGURED: [503, "对外 API 尚未配置"],
  CALLBACK_NOT_CONFIGURED: [503, "回调签名密钥尚未配置"],
  INTERNAL_ERROR: [500, "服务暂时无法处理请求"],
};
export class PartnerError extends Error {
  constructor(code, message) {
    super(message || ERRORS[code]?.[1] || ERRORS.INTERNAL_ERROR[1]);
    this.code = code;
    this.status = ERRORS[code]?.[0] || 500;
  }
}
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const equalSecret = (left, right) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
export const signature = (secret, value) => createHmac("sha256", secret).update(value).digest("hex");
export const isTaskId = (value) => /^task-[a-f0-9-]{36}$/.test(value);

export function configurePartnerApi(input = {}, port = 8787) {
  const apiKey = input.apiKey ?? process.env.PARTNER_API_KEY ?? "";
  const downloadSecret = input.downloadSecret ?? process.env.PARTNER_DOWNLOAD_SECRET ?? "";
  const webhookSecret = input.webhookSecret ?? process.env.PARTNER_WEBHOOK_SECRET ?? "";
  for (const value of [apiKey, downloadSecret, webhookSecret]) {
    if (value && (typeof value !== "string" || Buffer.byteLength(value) < 32 || value.length > 512 || /\s/.test(value))) {
      throw new Error("PARTNER_SECRET_MUST_HAVE_32_TO_512_NONSPACE_CHARACTERS");
    }
  }
  const base = new URL(input.baseUrl ?? process.env.PARTNER_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}/v1`);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))
    || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, "") !== "/v1") {
    throw new Error("INVALID_PARTNER_PUBLIC_BASE_URL");
  }
  const config = { apiKey, downloadSecret, webhookSecret, baseUrl: base.href.replace(/\/$/, ""),
    enabled: Boolean(apiKey && downloadSecret), allowLocalCallbacks: input.allowLocalCallbacks === true,
    callbackUrls: input.callbackUrls ?? (process.env.PARTNER_CALLBACK_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    defaultCallbackUrl: input.defaultCallbackUrl ?? process.env.PARTNER_DEFAULT_CALLBACK_URL ?? "",
    intervalMs: input.intervalMs ?? 1_000, requestsPerMinute: input.requestsPerMinute ?? 300,
    maxPendingTasks: input.maxPendingTasks ?? 100 };
  if (![config.intervalMs, config.requestsPerMinute, config.maxPendingTasks].every((value) => Number.isSafeInteger(value) && value > 0)
    || config.intervalMs < 25 || !Array.isArray(config.callbackUrls)) throw new Error("INVALID_PARTNER_CONFIGURATION");
  config.callbackUrls = config.callbackUrls.map((url) => normalizeCallback(url, config));
  if (config.defaultCallbackUrl) config.defaultCallbackUrl = validateCallback(config.defaultCallbackUrl, config);
  return config;
}

function normalizeCallback(value, config) {
  let url;
  try { url = new URL(value); } catch { throw new PartnerError("CALLBACK_NOT_ALLOWED"); }
  if (typeof value !== "string" || value.length > 2048 || url.username || url.password || url.hash
    || (url.protocol !== "https:" && !(config.allowLocalCallbacks && url.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new PartnerError("CALLBACK_NOT_ALLOWED");
  return url.href;
}
export function validateCallback(value, config) {
  if (!value) return "";
  const url = normalizeCallback(value, config);
  if (!config.callbackUrls.includes(url)) throw new PartnerError("CALLBACK_NOT_ALLOWED");
  if (!config.webhookSecret) throw new PartnerError("CALLBACK_NOT_CONFIGURED");
  return url;
}

export function validateTask(body, imageCount, config) {
  const allowed = new Set(["client_task_id", "model", "duration", "ratio", "count", "prompt", "negative_prompt", "callback_url"]);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new PartnerError("INVALID_PARAMETER");
  }
  const { client_task_id, model, duration, ratio, count = 1, prompt, negative_prompt = "", callback_url } = body;
  if (typeof client_task_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(client_task_id)
    || typeof model !== "string" || !Number.isInteger(duration) || typeof ratio !== "string"
    || !Number.isInteger(count) || count < 1 || count > 100 || typeof prompt !== "string"
    || !prompt.trim() || [...prompt].length > 5_000 || typeof negative_prompt !== "string"
    || [...negative_prompt].length > 2_000 || (callback_url !== undefined && typeof callback_url !== "string")) {
    throw new PartnerError("INVALID_PARAMETER");
  }
  const selected = MODELS.find((item) => item.model === model);
  if (!selected || !selected.durations.includes(duration) || !selected.ratios.includes(ratio)
    || imageCount > selected.max_images) throw new PartnerError("UNSUPPORTED_COMBINATION");
  // The browser adapter has a UTF-16 prompt bound in addition to these public character limits.
  if (prompt.length + negative_prompt.length + 32 > 12_000) throw new PartnerError("INVALID_PARAMETER", "提示词总长度超过执行器限制");
  return { client_task_id, model, duration, ratio, count, prompt: prompt.trim(),
    negative_prompt: negative_prompt.trim(),
    callback_url: validateCallback(callback_url ?? config.defaultCallbackUrl, config) };
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw new PartnerError("UNSUPPORTED_IMAGE_FORMAT");
}
export async function readTaskRequest(request, config) {
  const contentType = request.headers["content-type"] || "";
  const isJson = /^application\/json(?:;|$)/i.test(contentType);
  if (!isJson && !/^multipart\/form-data(?:;|$)/i.test(contentType)) throw new PartnerError("UNSUPPORTED_MEDIA_TYPE");
  const limit = isJson ? 65_536 : 101 * 1024 * 1024;
  if (Number(request.headers["content-length"]) > limit) throw new PartnerError("UPLOAD_TOO_LARGE");
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw new PartnerError("UPLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  let body;
  const images = [];
  try {
    if (isJson) body = JSON.parse(buffer.toString("utf8"));
    else {
      const form = await new Request("http://localhost/", { method: "POST",
        headers: { "Content-Type": contentType }, body: buffer }).formData();
      if ([...form.keys()].some((key) => !["task", "images"].includes(key))
        || form.getAll("task").length !== 1 || typeof form.get("task") !== "string"
        || Buffer.byteLength(form.get("task")) > 65_536) throw new PartnerError("INVALID_PARAMETER");
      body = JSON.parse(form.get("task"));
      const files = form.getAll("images");
      if (files.length > 9) throw new PartnerError("UNSUPPORTED_COMBINATION");
      let imageBytes = 0;
      for (const file of files) {
        if (typeof file === "string" || typeof file.arrayBuffer !== "function") throw new PartnerError("INVALID_PARAMETER");
        imageBytes += file.size;
        if (file.size > 20 * 1024 * 1024 || imageBytes > 100 * 1024 * 1024) throw new PartnerError("UPLOAD_TOO_LARGE");
        const bytes = Buffer.from(await file.arrayBuffer());
        images.push({ bytes, extension: imageType(bytes), sha256: digest(bytes),
          name: file.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f]/g, "").slice(0, 180) || "image" });
      }
    }
  } catch (error) {
    if (error instanceof PartnerError) throw error;
    throw new PartnerError("INVALID_PARAMETER", "请求体或 multipart 格式无效");
  }
  const payload = validateTask(body, images.length, config);
  return { payload, images, hash: digest(JSON.stringify({ payload, images: images.map((file) => file.sha256) })) };
}

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24],
  ["198.18.0.0", 15], ["224.0.0.0", 3]]) blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) {
  blocked.addSubnet(ip, prefix, "ipv6");
}
export async function postWebhook(delivery, config, now) {
  const url = new URL(validateCallback(delivery.callback_url, config));
  const timestamp = String(Math.floor(now / 1_000));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let dnsTimer;
  let addresses;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([lookup(hostname, { all: true }), new Promise((_, reject) => {
        dnsTimer = setTimeout(() => reject(new Error("CALLBACK_DNS_TIMEOUT")), 10_000);
      })]);
  } finally { clearTimeout(dnsTimer); }
  const testLoopback = config.allowLocalCallbacks && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!addresses.length || (!testLoopback && addresses.some((item) => blocked.check(item.address, item.family === 4 ? "ipv4" : "ipv6")))) {
    throw new Error("CALLBACK_ADDRESS_BLOCKED");
  }
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "POST", agent: false, signal: AbortSignal.timeout(10_000),
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family),
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(delivery.body_json),
        "X-Webhook-Id": delivery.id, "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature": `sha256=${signature(config.webhookSecret, `${timestamp}.${delivery.body_json}`)}` },
    }, (res) => { const status = res.statusCode; res.destroy(); resolve(status); });
    req.once("error", reject);
    req.end(delivery.body_json);
  });
}
