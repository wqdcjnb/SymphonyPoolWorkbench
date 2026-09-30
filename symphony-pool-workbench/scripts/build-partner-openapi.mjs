import fs from "node:fs";
import { MODELS, ERRORS } from "../lib/partner-protocol.mjs";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const integer = (description, extra = {}) => ({ type: "integer", description, ...extra });
const nullableDate = { type: ["string", "null"], format: "date-time" };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const taskId = str("本服务生成的任务 ID", { pattern: "^task-[a-f0-9-]{36}$", example: "task-550e8400-e29b-41d4-a716-446655440000" });
const clientId = str("调用方生成的业务任务 ID；同一 Key 下永久防重", { pattern: "^[A-Za-z0-9_-]{1,128}$", example: "order_20260930_0001" });
const taskStatus = str("终态：succeeded、partially_succeeded、failed、cancelled；reconciling 需服务方核对，不能重复创建", {
  enum: ["queued", "running", "reconciling", "cancelling", "succeeded", "partially_succeeded", "failed", "cancelled"] });
const counters = Object.fromEntries(["completed_count", "succeeded_count", "failed_count", "cancelled_count"].map((key) => [key, { type: "integer", minimum: 0 }]));
const taskRequest = object({ client_task_id: clientId,
  model: str("固定模型名称，区分大小写；平台提供的版本标签见 /models", { enum: MODELS.map((m) => m.model) }),
  duration: integer("秒；Seedance 为 5/10，Video 1.5 Pro 为 5/10/12", { enum: [5, 10, 12] }),
  ratio: str("Seedance 支持 9:16/16:9；Video 1.5 Pro 只支持 9:16", { enum: ["9:16", "16:9"] }),
  count: integer("请求视频总条数，每轮最多 2 条；不是并发数", { minimum: 1, maximum: 100, default: 1 }),
  prompt: str("正向提示词，不能为空白；与反向提示词总 UTF-16 长度不得超过 11968", { minLength: 1, maxLength: 5000 }),
  negative_prompt: str("反向提示词；独立接收和存储，浏览器执行器将其作为排除要求加入平台提示词", { maxLength: 2000, default: "" }),
  callback_url: str("预登记的完整 HTTPS 回调地址；省略使用服务端默认值，空字符串关闭该任务回调", { maxLength: 2048 }),
}, ["client_task_id", "model", "duration", "ratio", "prompt"]);
const schemas = {
  TaskRequest: taskRequest,
  Error: object({ error: object({ code: str("机器可读错误码", { enum: Object.keys(ERRORS) }), message: str("错误说明") }) }),
  Result: object({ index: integer("视频序号，从 1 开始", { minimum: 1 }), batch_index: integer("批次，从 1 开始", { minimum: 1 }),
    status: str("该条视频状态", { enum: ["queued", "running", "reconciling", "succeeded", "failed", "cancelled"] }),
    video_url: { type: ["string", "null"], description: "成功结果的带签名下载 URL；保留期后为 null", format: "uri" },
    expires_at: nullableDate, retained_until: nullableDate,
    size_bytes: integer("原 MP4 字节数", { minimum: 1 }), sha256: str("原 MP4 SHA-256 十六进制摘要", { pattern: "^[a-f0-9]{64}$" }),
    error: object({ code: str("结果错误码", { enum: ["GENERATION_FAILED", "RESULT_MISSING", "RESULT_EXPIRED"] }), message: str("错误说明") }),
  }, ["index", "batch_index", "status"]),
  Delivery: object({ event_id: str("回调事件 ID；重复投递时不变"),
    state: str("通知状态", { enum: ["pending", "sending", "delivered", "failed", "skipped"] }),
    attempts: { type: "integer", minimum: 0 }, last_http_status: { type: ["integer", "null"] },
    last_error: { type: ["string", "null"], enum: [null, "CALLBACK_HTTP_ERROR", "CALLBACK_UNREACHABLE", "DELIVERY_EXPIRED"] } }),
  Task: object({ task_id: taskId, client_task_id: clientId, status: taskStatus,
    model: taskRequest.properties.model, duration: taskRequest.properties.duration, ratio: taskRequest.properties.ratio,
    count: taskRequest.properties.count, ...counters, created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" }, finished_at: nullableDate,
    results: { type: "array", items: ref("Result"), maxItems: 100 }, webhooks: { type: "array", items: ref("Delivery") },
    idempotent_replay: { type: "boolean", description: "仅创建响应包含；true 表示返回已有任务" },
  }, ["task_id", "client_task_id", "status", "model", "duration", "ratio", "count", ...Object.keys(counters),
    "created_at", "updated_at", "finished_at", "results", "webhooks"]),
  Webhook: object({ event_id: str("通知唯一 ID，作为接收方去重键"),
    event: str("批次结束，或取消请求最终结束", { enum: ["video.batch.completed", "video.task.finished"] }),
    task_id: taskId, client_task_id: clientId, batch_index: { type: ["integer", "null"], minimum: 1 },
    is_final: { type: "boolean" }, status: taskStatus, count: taskRequest.properties.count, ...counters,
    occurred_at: { type: "string", format: "date-time" }, results: { type: "array", maxItems: 2, items: ref("Result") } }),
  Models: object({ api_version: { type: "string", const: "v1" },
    models: { type: "array", items: object({ model: str("请求使用的名称"), version: str("平台界面版本标签，不代表内部构建版本"),
      durations: { type: "array", items: { type: "integer" } }, ratios: { type: "array", items: { type: "string" } }, max_images: { type: "integer" } }), example: MODELS },
    limits: { type: "object", additionalProperties: true, description: "数量、上传大小、提示词、链接和文件保留期限制" } }),
};
const content = (schema) => ({ "application/json": { schema } });
const failures = Object.fromEntries([...new Set(Object.values(ERRORS).map(([status]) => status))].map((status) => [status, {
  description: Object.entries(ERRORS).filter(([, value]) => value[0] === status).map(([code, [, message]]) => `${code}: ${message}`).join("；"),
  content: content(ref("Error")), ...(status === 429 || status === 503 ? { headers: { "Retry-After": { schema: { type: "integer" }, description: "适用时返回建议等待秒数" } } } : {}),
}]));
const responses = (success) => ({ ...success, ...failures });
const param = { name: "task_id", in: "path", required: true, schema: taskId };
const resultParams = [param, { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: 100 } },
  { name: "expires", in: "query", schema: { type: "integer" }, description: "签名链接的到期 Unix 秒；使用 Bearer 时可省略" }];
const resultSecurity = [{ bearerAuth: [] }, { downloadSignature: [] }];
const example = { client_task_id: "order_20260930_0001", model: "Seedance 2.0 Mini", duration: 5, ratio: "9:16", count: 4,
  prompt: "海边日落，镜头缓慢向前推进，保持主体外观一致", negative_prompt: "不要文字、水印、画面闪烁和肢体变形", callback_url: "" };
const doc = { openapi: "3.1.0", info: { title: "Symphony 号池视频生成 API", version: "1.0.0",
  description: "共享 Bearer Key；异步任务；每批最多 2 条；图片与任务一起上传。此 API 经本地浏览器号池执行。" },
  servers: [{ url: "http://127.0.0.1:8787/v1", description: "本机联调；公网 HTTPS 域名待配置" }],
  security: [{ bearerAuth: [] }], paths: {
    "/models": { get: { operationId: "listModels", summary: "模型名称、版本标签与限制",
      responses: responses({ 200: { description: "当前接口支持的模型", content: content(ref("Models")) } }) } },
    "/videos": { post: { operationId: "createVideoTask", summary: "创建视频任务",
      description: "返回受理后结束 HTTP 请求。相同 client_task_id 与规范化参数、图片字节及顺序返回原任务；冲突返回 409。无图片可用 JSON，有图片使用 multipart。",
      requestBody: { required: true, content: {
        "application/json": { schema: ref("TaskRequest"), example },
        "multipart/form-data": { schema: object({ task: str("TaskRequest 的 JSON 字符串", { example: JSON.stringify(example) }),
          images: { type: "array", maxItems: 9, description: "重复 images 字段，原始二进制图片；PNG/JPEG/WebP，每张 20 MiB、合计 100 MiB；顺序保留", items: { type: "string", format: "binary" } } }, ["task"]) },
      } }, responses: responses({ 202: { description: "已持久化并受理", headers: { Location: { schema: { type: "string", format: "uri" } } }, content: content(ref("Task")) },
        200: { description: "幂等重试，返回原任务", content: content(ref("Task")) } }) } },
    "/videos/{task_id}": { get: { operationId: "getVideoTask", parameters: [param], summary: "查询累计结果并刷新下载链接",
      responses: responses({ 200: { description: "任务快照；建议每 5–10 秒查询", content: content(ref("Task")) } }) } },
    "/videos/{task_id}/cancel": { post: { operationId: "cancelVideoTask", parameters: [param], summary: "取消尚未提交的生成",
      description: "不需要请求体。平台已提交的生成继续收集；返回 cancelling 或最终状态；重复取消不会重复操作。",
      responses: responses({ 200: { description: "取消请求已记录，或已处于终态", content: content(ref("Task")) } }) } },
    "/videos/{task_id}/results/{index}": {
      get: { operationId: "downloadVideo", summary: "原 MP4 下载，支持单段 Range", security: resultSecurity,
        parameters: [...resultParams, { name: "Range", in: "header", schema: { type: "string" }, example: "bytes=0-1023" },
          { name: "If-Range", in: "header", schema: { type: "string" }, description: "ETag 不一致返回完整文件" }],
        responses: responses(Object.fromEntries([200, 206].map((status) => [status, { description: status === 200 ? "原始视频文件" : "单段字节内容",
          headers: { "Content-Length": { schema: { type: "integer" } }, "Accept-Ranges": { schema: { type: "string", const: "bytes" } },
            "Content-Range": { schema: { type: "string" } }, ETag: { schema: { type: "string" }, description: "带双引号的 SHA-256" } },
          content: { "video/mp4": { schema: { type: "string", format: "binary" } } } }]))) },
      head: { operationId: "inspectVideo", summary: "查看原视频大小及校验标识", parameters: resultParams, security: resultSecurity,
        responses: { 200: { description: "返回 Content-Length、Content-Type、ETag、Accept-Ranges，无响应体" },
          default: { description: "与 GET 相同状态码，无响应体" } } },
    },
    "/openapi.json": { get: { operationId: "getOpenApi", summary: "获取本接口规范", responses: responses({
      200: { description: "OpenAPI 3.1 JSON，servers 使用当前配置地址", content: content({ type: "object" }) } }) } },
  }, webhooks: { videoResults: { post: { summary: "批次结果或取消完成通知",
    description: "HTTPS POST 至预登记 callback_url。按 event_id 去重；验签 timestamp + '.' + 原始请求体。签名重试更新、事件 ID 和请求体不变。最长重试 24 小时；不能依赖到达顺序。",
    security: [], parameters: [
      { name: "X-Webhook-Id", in: "header", required: true, schema: { type: "string" } },
      { name: "X-Webhook-Timestamp", in: "header", required: true, schema: { type: "string" }, description: "Unix 秒；建议允许正负 300 秒" },
      { name: "X-Webhook-Signature", in: "header", required: true, schema: { type: "string" }, description: "sha256=HMAC-SHA256(webhook_secret, timestamp + '.' + raw_body)" },
    ], requestBody: { required: true, content: content(ref("Webhook")) },
    responses: { "2XX": { description: "接收方已可靠保存事件，重复事件也应返回 2xx" }, default: { description: "发送方稍后重试同一事件" } },
  } } }, components: { securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", description: "服务端本机配置的共享 API Key；不使用 OAuth" },
    downloadSignature: { type: "apiKey", in: "query", name: "signature", description: "使用服务器完整签名下载 URL；必须同时保留 expires 参数" },
  }, schemas } };
const docs = new URL("../docs/", import.meta.url);
fs.mkdirSync(new URL("examples/", docs), { recursive: true });
fs.writeFileSync(new URL("partner-openapi.json", docs), JSON.stringify(doc, null, 2) + "\n");
fs.writeFileSync(new URL("examples/partner-task.json", docs), JSON.stringify(example, null, 2) + "\n");
console.log("Updated docs/partner-openapi.json and docs/examples/partner-task.json");
