import fs from "node:fs";
import { MODELS, ERRORS } from "../lib/partner-protocol.mjs";
import { VIDEO_RATIOS } from "../public/js/video-policy.js";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const integer = (description, extra = {}) => ({ type: "integer", description, ...extra });
const nullableDate = { type: ["string", "null"], format: "date-time" };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const taskId = str("本服务生成的任务 ID", { pattern: "^task-[a-f0-9-]{36}$", example: "task-550e8400-e29b-41d4-a716-446655440000" });
const clientId = str("调用方生成的业务任务 ID；本服务内永久防重；轮换 Key 不清空记录", { pattern: "^[A-Za-z0-9_-]{1,128}$", example: "order_20260930_0001" });
const taskStatus = str("终态：succeeded、partially_succeeded、failed、cancelled；reconciling 为核对中，按 recovery 区分自动核对和人工处理，继续查询原任务", {
  enum: ["queued", "running", "reconciling", "cancelling", "succeeded", "partially_succeeded", "failed", "cancelled"] });
const counters = Object.fromEntries(["completed_count", "succeeded_count", "failed_count", "cancelled_count"].map((key) => [key, { type: "integer", minimum: 0 }]));
const taskRequest = object({ client_task_id: clientId,
  model: str("固定模型名称，区分大小写；正反提示词出现 30s、30秒等表达时优先采用 Dreamina Seedance 2.5，响应返回最终模型；版本标签见 /models", { enum: MODELS.map((m) => m.model) }),
  duration: integer("秒；豆包固定 15，Dola 固定 30。正反提示词出现 30 秒表达时覆盖为 30，响应返回最终时长", { enum: [15, 30] }),
  ratio: str("仅支持六种固定比例：1:1、3:4、4:3、9:16、16:9、21:9；正向 prompt 明确指定的比例优先于本字段，negative_prompt 不参与比例覆盖。响应 ratio 为最终采用的比例；多个冲突比例返回 PROMPT_RATIO_CONFLICT", { enum: VIDEO_RATIOS }),
  delivery_mode: str("默认 official_original；Dola 使用 watermark_repair（局部修补与重新编码）。命中提示词 30 秒优先规则时自动采用 watermark_repair，其余 Dola 请求须显式选择；响应返回最终交付方式", { enum: ['official_original', 'watermark_repair'], default: 'official_original' }),
  count: integer("请求视频总条数，每轮最多 2 条；不是并发数", { minimum: 1, maximum: 100, default: 1 }),
  prompt: str("正向提示词，不能为空白；与反向提示词总 UTF-16 长度不得超过 11968。原文保留；Dola 30 秒提交时清理 30 秒文字、旧模型名称，合法分镜秒数改为进度比例，实际参数仍为 30 秒", { minLength: 1, maxLength: 5000 }),
  negative_prompt: str("反向提示词；独立接收和存储，执行时作为排除要求加入平台文本，同样适用 30 秒检测和清理规则", { maxLength: 2000, default: "" }),
  callback_url: str("预登记的完整 HTTPS 回调地址；省略使用服务端默认值，空字符串关闭该任务回调", { maxLength: 2048 }),
}, ["client_task_id", "model", "duration", "ratio", "prompt"]);
const schemas = {
  Progress: object({
    phase: str('具体执行阶段；界面展示以此字段和 label 为准', {enum:['draft','queued','starting','submitting','awaiting_platform','generating','downloading','processing','download_blocked','awaiting_verification','awaiting_login','awaiting_confirmation','submission_unconfirmed','parameter_mismatch','reconciling','needs_review','completed','failed','cancelled']}),
    label: str('阶段中文名称'),description: str('当前阶段及阻塞原因'),
    action: str('服务方处理方式；调用方继续查询原 task_id',{enum:['none','verify','resume','recollect','inspect']}),
    platform_status: str('最近确认的平台状态，不代表交付完成',{enum:['not_submitted','unknown','generating','completed','failed']}),
    delivery_status: str('文件交付状态',{enum:['pending','downloading','processing','blocked','available']}),
    updated_at: nullableDate,last_observed_at: nullableDate,
  }),
  TaskRequest: taskRequest,
  Error: object({ error: object({ code: str("机器可读错误码", { enum: Object.keys(ERRORS) }), message: str("错误说明") }) }),
  Result: object({ index: integer("视频序号，从 1 开始", { minimum: 1 }), batch_index: integer("批次，从 1 开始", { minimum: 1 }),
    status: str("该条视频状态", { enum: ["queued", "running", "reconciling", "succeeded", "failed", "cancelled"] }),
    progress: ref('Progress'),
    recovery: object({ mode: str('核对方式', {enum:['automatic','manual']}), attempts: integer('已执行核对次数'),
      next_check_at: nullableDate, deadline_at: nullableDate }),
    video_url: { type: ["string", "null"], description: "按所选交付模式校验的文件下载 URL；失败或到期后为 null", format: "uri" },
    delivery_mode: taskRequest.properties.delivery_mode,
    postprocessed: { type: 'boolean', description: 'true 为局部修补并重新编码的版本' },
    processing: { type: 'object', additionalProperties: true, description: '修补方法、规则版本、矩形区域与画质提示' },
    watermark_free: { type: ["boolean", "null"], description: "官方无水印原片为 true；修补版为 null，不宣称是官方无水印原片或经过逐帧无水印识别" },
    expires_at: nullableDate, retained_until: nullableDate,
    size_bytes: integer("交付 MP4 字节数", { minimum: 1 }), sha256: str("交付 MP4 SHA-256 十六进制摘要", { pattern: "^[a-f0-9]{64}$" }),
    error: object({ code: str("结果错误码；DOLA_HUMAN_VERIFICATION_REQUIRED 为暂停等待服务方操作，非失败终态", { enum: ["GENERATION_FAILED", "RESULT_MISSING", "RESULT_EXPIRED", "WATERMARK_FREE_RESULT_REQUIRED", "WATERMARK_REPAIR_FAILED", "WATERMARK_REPAIR_UNSUPPORTED_LAYOUT", "DOLA_HUMAN_VERIFICATION_REQUIRED"] }), message: str("错误说明") }),
  }, ["index", "batch_index", "status"]),
  Delivery: object({ event_id: str("回调事件 ID；重复投递时不变"),
    state: str("通知状态", { enum: ["pending", "sending", "delivered", "failed", "skipped"] }),
    attempts: { type: "integer", minimum: 0 }, last_http_status: { type: ["integer", "null"] },
    last_error: { type: ["string", "null"], enum: [null, "CALLBACK_HTTP_ERROR", "CALLBACK_UNREACHABLE", "DELIVERY_EXPIRED"] } }),
  Task: object({ task_id: taskId, client_task_id: clientId, status: taskStatus,
    terminal: {type:'boolean',description:'只有 true 才是任务终态；HTTP 超时、查询失败和 reconciling 不表示生成失败'},
    poll_after_seconds: integer('建议查询间隔秒数，默认 60；终态为 0'),
    status_url: str('原任务查询地址',{format:'uri'}),
    notification_mode: str('未提供对方回调地址时使用查询模式',{enum:['poll','webhook_and_poll']}),
    model: taskRequest.properties.model, duration: taskRequest.properties.duration, ratio: taskRequest.properties.ratio, delivery_mode: taskRequest.properties.delivery_mode,
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
      durations: { type: "array", items: { type: "integer" } }, ratios: { type: "array", items: { type: "string" } }, max_images: { type: "integer" },
      daily_credits: integer('每账号每日积分', { const: 10 }), credits_per_video: integer('每条视频积分消耗', { enum: [2, 4] }),
      delivery_modes: { type: 'array', items: taskRequest.properties.delivery_mode }, note: str('模型限制说明') }, ['model','version','durations','ratios','max_images']), example: MODELS },
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
const example = { client_task_id: "order_20261004_0001", model: "Dreamina Seedance 2.5", delivery_mode: 'watermark_repair', duration: 30, ratio: "9:16", count: 1,
  prompt: "海边日落，镜头缓慢向前推进，保持主体外观一致", negative_prompt: "不要文字、水印、画面闪烁和肢体变形", callback_url: "" };
const doc = { openapi: "3.1.0", info: { title: "Symphony 号池视频生成 API", version: "1.5.2",
  description: "共享 Bearer Key；异步任务；每批最多 2 条。Dola 须选择 watermark_repair，修补并重新编码后交付；角落可能模糊，不是官方无水印原片。其他模型仍使用原片校验。" },
  servers: [{ url: "https://47.84.3.74/v1", description: "云端 HTTPS 接口；需要专用 Bearer Key" }],
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
      responses: responses({ 200: { description: "任务快照；按 poll_after_seconds 或 Retry-After 查询，默认 60 秒并适当错开", content: content(ref("Task")) } }) } },
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
