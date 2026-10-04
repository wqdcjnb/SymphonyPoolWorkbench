# symphony 号池视频生成 API 接入文档

文档版本：1.0.0 · API 版本：v1 · 2026-09-30

本文供调用本服务的合作方接入。任务进入本机号池，使用已登录的浏览器档案生成视频，再返回原始 MP4 下载地址。

- **服务名称：** `symphony`。
- **本机 API Base URL：** `http://127.0.0.1:8787/v1`
- **文档页面：** 工作台的 `/api-docs` 页面，无需 Key 即可查看和下载文档；测试部署也可单独提供文档访问地址。
- **公网 API Base URL：** 部署服务器时配置，例如 `https://symphony.example.com/v1`；此处仅为格式示例，正式地址由服务方提供。
- **鉴权：** `Authorization: Bearer <API_KEY>`，使用一个共享 Key，不使用 OAuth，不管理对方的终端用户。
- **机器可读规范：** [OpenAPI 3.1 JSON](docs/partner-openapi.json)，可导入 Apifox、Postman 等工具。
- **完整请求样例：** [partner-task.json](docs/examples/partner-task.json)。
- **工作流：** 创建任务 → 保存返回的 `task_id` → 接收回调或查询状态 → 下载视频。

`symphony` 是自定义服务名称。正式访问地址由服务器的域名解析、HTTPS 代理及 `PARTNER_PUBLIC_BASE_URL` 配置决定；文档中的示例名称不会自动创建可访问地址。本机地址仅供本机联调，合作方须使用部署后提供的完整地址。

## 1. 两个任务 ID

| 字段 | 谁提供 | 用途 |
| --- | --- | --- |
| `client_task_id` | 调用方 | 对方的业务任务 ID，以及防止重复生成的幂等键 |
| `task_id` | 本服务 | 本服务的任务 ID，用于查询、取消和下载 |
| `event_id` | 本服务 | 一次回调事件的 ID；通知重试时不变，用于接收方去重 |

创建请求传 `client_task_id`，响应和回调均包含两个任务 ID。请求不接受含义模糊的 `id` 字段。`event_id` 就是回调通知的编号，无需对方预先提供 `webhook_id`。

同一 `client_task_id`、相同规范化参数、相同图片字节及顺序再次提交，返回原任务，HTTP 200，`idempotent_replay: true`。首次受理返回 HTTP 202。相同 ID 改了参数、图片或图片顺序，返回 HTTP 409 `ID_CONFLICT`。图片文件名不影响幂等判断；提示词首尾空白会去除，省略的参数先应用默认值。`callback_url` 也参与幂等判断。

网络中断或创建接口返回超时，使用**相同 ID 和原始请求**重试。终态任务也不会因重复提交而重新生成；如确实需要重新生成，使用新的 `client_task_id`。ID 记录保留在本地数据库，轮换共享 Key 不会清空记录。

## 2. 模型和参数范围

`GET /models` 获取当前支持的名称、版本标签、组合及大小限制。模型名区分大小写。

| `model` | `version` | `duration` 秒 | `ratio` | 图片数量 |
| --- | --- | --- | --- | --- |
| `Seedance 2.0 Fast` | `2.0 Fast` | 5、10 | `9:16`、`16:9` | 0–9 |
| `Seedance 2.0 Mini` | `2.0 Mini` | 5、10 | `9:16`、`16:9` | 0–9 |
| `Video 1.5 Pro` | `1.5 Pro` | 5、10、12 | `9:16` | 0–4 |

版本号是当前平台界面和执行器使用的版本标签，平台没有提供内部构建版本。上表表示接口支持范围；实际开始时间取决于相应模型的可用账号。Video 1.5 Pro 当前浏览器入口使用平台默认竖屏输出，不能在网页中强制设置比例。

| 请求字段 | 类型 | 必填 | 约束与含义 |
| --- | --- | --- | --- |
| `client_task_id` | string | 是 | 1–128 个英文字母、数字、下划线或连字符 |
| `model` | string | 是 | 上表中的完整名称 |
| `duration` | integer | 是 | 秒，与模型匹配 |
| `ratio` | string | 是 | `9:16` 或 `16:9`，与模型匹配 |
| `count` | integer | 否 | 视频总条数，1–100，默认 1；不是并发数 |
| `prompt` | string | 是 | 非空正向提示词，最多 5000 个 Unicode 码点 |
| `negative_prompt` | string | 否 | 独立反向提示词，最多 2000 个 Unicode 码点，默认空字符串 |
| `callback_url` | string | 否 | 预登记的完整 HTTPS 回调地址；省略使用服务端默认地址，显式空字符串表示本任务只查询、不回调 |
| `images` | binary[] | 否 | multipart 的重复文件字段，不能放进 JSON；PNG/JPEG/WebP，每张 ≤20 MiB，合计 ≤100 MiB |

正、反提示词独立接收和保存。当前浏览器生成入口没有独立的负面提示词控件，执行时将反向提示词作为“请避免出现”要求加入平台提示词。由于执行器长度限制，两者合计的 UTF-16 长度还须 ≤11968。大部分中文字符各计 1，部分 emoji 各计 2。

图片随本次任务上传，保留上传顺序，不需要单独创建素材 ID。有图自动走图片生成，无图自动走文字生成。不接受 `resolution`、`mode`、`external_user_id`、`metadata`、`reference_video_id` 等未定义字段，也不接受本机文件路径或图片 URL 来替代上传。

## 3. 创建任务

`POST /videos`

### 3.1 无图片：application/json

```http
POST /v1/videos HTTP/1.1
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "client_task_id": "order_20260930_0001",
  "model": "Seedance 2.0 Mini",
  "duration": 5,
  "ratio": "9:16",
  "count": 4,
  "prompt": "海边日落，镜头缓慢向前推进，保持主体外观一致",
  "negative_prompt": "不要文字、水印、画面闪烁和肢体变形",
  "callback_url": "https://partner.example.com/hooks/video"
}
```

示例域名是占位值，须先由服务方登记真实回调地址。暂不回调时删掉 `callback_url`（且服务端无默认回调），或将它设为空字符串。

### 3.2 有图片：multipart/form-data

- `task`：上面 JSON 的**文本字符串**，只允许一个字段。
- `images`：重复的二进制图片文件字段。不要手动设置 multipart boundary。
- 可上传 1 张或多张，受模型图片上限约束；不允许其他文件字段。
- JSON 请求体最大 64 KiB，完整 multipart 请求体最大 101 MiB。

Windows PowerShell 示例（Key 由调用方本机环境变量提供）：

```powershell
$base = 'http://127.0.0.1:8787/v1'
curl.exe "$base/videos" `
  -H "Authorization: Bearer $env:PARTNER_API_KEY" `
  -F 'task=<docs/examples/partner-task.json' `
  -F 'images=@D:/images/first.png' `
  -F 'images=@D:/images/second.jpg'
```

无图片时可直接：

```powershell
curl.exe "$base/videos" `
  -H "Authorization: Bearer $env:PARTNER_API_KEY" `
  -H 'Content-Type: application/json' `
  --data-binary '@docs/examples/partner-task.json'
```

### 3.3 首次受理响应

HTTP 202 表示任务已保存并受理。创建 HTTP 请求不会保持到视频生成结束。`Location` 响应头给出查询地址。

```json
{
  "task_id": "task-550e8400-e29b-41d4-a716-446655440000",
  "client_task_id": "order_20260930_0001",
  "status": "queued",
  "model": "Seedance 2.0 Mini",
  "duration": 5,
  "ratio": "9:16",
  "count": 4,
  "completed_count": 0,
  "succeeded_count": 0,
  "failed_count": 0,
  "cancelled_count": 0,
  "created_at": "2026-09-30T06:00:00.000Z",
  "updated_at": "2026-09-30T06:00:00.000Z",
  "finished_at": null,
  "results": [
    { "index": 1, "batch_index": 1, "status": "queued" },
    { "index": 2, "batch_index": 1, "status": "queued" },
    { "index": 3, "batch_index": 2, "status": "queued" },
    { "index": 4, "batch_index": 2, "status": "queued" }
  ],
  "webhooks": [],
  "idempotent_replay": false
}
```

## 4. 两条一批的调度与结果

`count=5` 拆成 `2 + 2 + 1`。前一批全部结束后才提交下一批；批次内按账号可用情况执行，只有一个可用账号时可以依次完成两条。同一浏览器账号同时执行一条，全局队列默认并行上限为 2，与本地任务共用。

每批结束产生一次 `video.batch.completed` 回调，`results` 最多 2 项。每项可能成功、失败或取消，最后一个奇数批次只有 1 项。普通任务的最后一批 `is_final=true`。某条失败不阻止下一批，但已向平台提交、结果不明的条目进入 `reconciling`，该任务暂不启动下一批，等待服务方核对或收集已有结果。

号池从兼容、空闲、已验收的账号中优先选择记录额度较高的账号。明确额度耗尽时标记冷却并安全换号；提交前故障会暂停该账号并尝试其他账号。普通网络或浏览器故障不能证明额度为零。对已提交但结果不明的生成，不盲目换号重复提交。

回调 HTTP 失败只重试通知，不会重新生成视频，也不会阻塞下一批生成。

## 5. 查询任务

`GET /videos/{task_id}`，需要 Bearer Key。建议每 5–10 秒查询一次，停止于终态；每个共享 Key 默认最多 300 次控制接口请求/分钟，超限返回 429 和 `Retry-After`。

响应结构与创建一致，但没有 `idempotent_replay`。`results` 始终按序号包含本任务所有条目，查询返回累计结果；回调只包含本批结果。视频成功后对应条目变为：

```json
{
  "index": 1,
  "batch_index": 1,
  "status": "succeeded",
  "size_bytes": 18345290,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "retained_until": "2026-10-07T06:02:00.000Z",
  "video_url": "https://api.example.com/v1/videos/task-550e8400-e29b-41d4-a716-446655440000/results/1?expires=1790834520&signature=EXAMPLE_SIGNATURE",
  "expires_at": "2026-10-01T06:02:00.000Z"
}
```

上述文件大小、摘要和 URL 仅展示字段，实际使用响应返回的值。时间统一为 UTC ISO 8601。

| 任务状态 | 含义 | 终态 |
| --- | --- | --- |
| `queued` | 等待账号或执行槽位 | 否 |
| `running` | 正在生成、保存或继续下一批 | 否 |
| `reconciling` | 平台可能已提交，需服务方核对结果 | 否 |
| `cancelling` | 已停止未来条目，等待在途生成结束 | 否 |
| `succeeded` | 全部成功 | 是 |
| `partially_succeeded` | 部分成功、其余失败 | 是 |
| `failed` | 全部失败 | 是 |
| `cancelled` | 存在被取消条目，其余均已结束；仍可能有成功结果 | 是 |

`completed_count = succeeded_count + failed_count + cancelled_count`，表示已经结束的条目数，不仅指成功。`results[].status` 使用 `queued / running / reconciling / succeeded / failed / cancelled`。

单条失败包含 `error.code`：`GENERATION_FAILED` 或 `RESULT_MISSING`。文件保留期结束后，成功记录仍保留，但 `video_url`、`expires_at` 为 null，并带 `RESULT_EXPIRED`。

`webhooks` 可查看每个通知的 `event_id / state / attempts / last_http_status / last_error`。状态为 `pending / sending / delivered / failed / skipped`；未配置回调时为 `skipped`。通知失败不会改变视频成功状态。

## 6. 取消任务

`POST /videos/{task_id}/cancel`，需要 Bearer Key，无需请求体。

```powershell
curl.exe -X POST "$base/videos/$taskId/cancel" -H "Authorization: Bearer $env:PARTNER_API_KEY"
```

HTTP 200 返回任务快照：

- 尚未派出的条目立即取消，后续批次停止。
- 已交给执行器或已提交到平台的任务，继续收集结果；不能保证平台停止生成或退还额度。
- 取消中的条目遇到额度失败，不会再换账号重试。
- 已完成的视频保留可下载；全体已结束后返回终态。
- 重复取消或取消终态任务，返回当前任务，不重新生成。
- 若在途条目处于 `reconciling`，取消请求仍需等服务方核对；不能把未知的提交状态伪装成已取消。

存在取消请求的任务在全部结束后额外发送一次 `video.task.finished`，`batch_index:null`、`is_final:true`、`results:[]`，附最终计数。已经派出的批次仍会发送自己的批次事件。接收方可查询最终累计结果。

## 7. Webhook 回调格式

本服务向预登记 `callback_url` 发送 HTTPS POST。地址必须精确匹配服务端配置（包括路径及查询参数），不跟随重定向，不允许回调至内网、回环或保留地址。未确定回调地址时，可先只用查询接口。

```http
Content-Type: application/json; charset=utf-8
X-Webhook-Id: evt-550e8400-e29b-41d4-a716-446655440001
X-Webhook-Timestamp: 1790748120
X-Webhook-Signature: sha256=<hex_hmac>
```

```json
{
  "event_id": "evt-550e8400-e29b-41d4-a716-446655440001",
  "event": "video.batch.completed",
  "task_id": "task-550e8400-e29b-41d4-a716-446655440000",
  "client_task_id": "order_20260930_0001",
  "batch_index": 1,
  "is_final": false,
  "status": "running",
  "count": 4,
  "completed_count": 2,
  "succeeded_count": 2,
  "failed_count": 0,
  "cancelled_count": 0,
  "occurred_at": "2026-09-30T06:02:00.000Z",
  "results": [
    {
      "index": 1,
      "batch_index": 1,
      "status": "succeeded",
      "size_bytes": 18345290,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "retained_until": "2026-10-07T06:02:00.000Z",
      "video_url": "https://api.example.com/v1/videos/task-550e8400-e29b-41d4-a716-446655440000/results/1?expires=1790834520&signature=EXAMPLE_SIGNATURE_1",
      "expires_at": "2026-10-01T06:02:00.000Z"
    },
    {
      "index": 2,
      "batch_index": 1,
      "status": "succeeded",
      "size_bytes": 19450321,
      "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "retained_until": "2026-10-07T06:02:00.000Z",
      "video_url": "https://api.example.com/v1/videos/task-550e8400-e29b-41d4-a716-446655440000/results/2?expires=1790834520&signature=EXAMPLE_SIGNATURE_2",
      "expires_at": "2026-10-01T06:02:00.000Z"
    }
  ]
}
```

### 验签和重试

双方本地配置独立 `PARTNER_WEBHOOK_SECRET`，与 API Key 分开。

```text
signed_payload = X-Webhook-Timestamp + "." + 原始请求体字节
expected = "sha256=" + HMAC_SHA256(webhook_secret, signed_payload).hex()
```

先校验时间戳（建议与当前时间相差不超过 300 秒），再用常量时间比较核对签名，最后解析 JSON。不要对解析后的 JSON 重新序列化来验签。`X-Webhook-Id` 必须与 body 的 `event_id` 一致。

接收方将事件可靠写入自己的队列/数据库后，尽快返回任意 2xx；重复事件也应返回 2xx。下载视频可在后台完成。请求连接与响应超时为 10 秒，DNS 查询另设 10 秒上限。

非 2xx、网络错误、超时均会重试。等待约 10、20、40 秒逐步翻倍，最长间隔 1 小时，总投递窗口 24 小时。事件 ID 和 body 保持不变，每次投递使用新的时间戳和签名。进程重启继续恢复未完成投递。

这是**至少一次投递**，必须按 `event_id` 去重，不能依赖事件到达顺序；旧批次失败后可能晚于新批次到达。回调中的状态是事件创建时的快照，最终事实以查询结果为准。长时间重试后下载链接可能已过期，查询任务获得新链接即可。

## 8. 视频下载与有效期

下载 `video_url`，或使用 Bearer Key 请求 `GET /videos/{task_id}/results/{index}`。

- 回传的是保存好的原始 MP4 文件，不使用 Base64，不再压缩、转码或修改分辨率。
- 签名链接有效 **24 小时**；临近文件保留截止时有效期缩短，以 `expires_at` 为准。
- 每个视频从生成完成起保留 **7 天**，以 `retained_until` 为准；过期文件由后台清理，不能靠刷新链接延长保留期。
- `GET /videos/{task_id}` 在保留期内生成新的下载链接。文件到期返回 HTTP 410，签名链接到期返回 HTTP 403。
- 签名链接本身具有临时下载权限，无需另带 Key；不要公开分享链接中的签名。
- 支持 `HEAD`、单段 `Range: bytes=start-end` 和 `bytes=-length`，支持断点续传；不支持一次请求多个范围。
- `Content-Length` 是本次响应字节数，`ETag` 为带引号的 SHA-256，`Accept-Ranges: bytes`。范围下载返回 206，非法范围返回 416。
- 对方可计算完整文件 SHA-256 与响应 `sha256` 对比，确认传输无损。
- 实际速度取决于服务方上行和对方下载带宽；当前直接流式传输本机文件，尚未接入对象存储/CDN。

图片在所属任务结束 7 天后清理；仍排队、生成或待核对的任务继续保留图片。元数据、幂等记录和事件保留在数据库。

## 9. 错误码

控制接口错误统一为：

```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "参数缺失、类型错误或超出范围"
  }
}
```

| HTTP | code | 处理建议 |
| --- | --- | --- |
| 400 | `INVALID_PARAMETER` | 检查字段、类型、JSON 或 multipart 格式 |
| 401 | `INVALID_API_KEY` | 检查 Bearer Key |
| 403 | `INVALID_DOWNLOAD_SIGNATURE` | 使用完整的服务端下载 URL，不修改参数 |
| 403 | `DOWNLOAD_LINK_EXPIRED` | 重新查询任务获取链接 |
| 404 | `TASK_NOT_FOUND` | 检查本服务的 task_id |
| 404 | `NOT_FOUND` | 检查接口路径或结果序号 |
| 405 | `METHOD_NOT_ALLOWED` | 检查 GET/POST/HEAD 方法 |
| 409 | `ID_CONFLICT` | 同一业务 ID 的原请求才可重试；新任务换新 ID |
| 409 | `RESULT_NOT_READY` | 视频尚未成功，稍后查询 |
| 410 | `RESULT_EXPIRED` | 文件保留期已结束 |
| 410 | `RESULT_MISSING` | 文件丢失或不可用，联系服务方 |
| 413 | `UPLOAD_TOO_LARGE` | 减少单图或总请求大小 |
| 415 | `UNSUPPORTED_IMAGE_FORMAT` | 上传 PNG/JPEG/WebP 实际图片文件 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 使用 JSON 或 multipart/form-data |
| 416 | `INVALID_RANGE` | 使用合法单段 Range |
| 422 | `UNSUPPORTED_COMBINATION` | 检查模型/时长/比例/图片数量组合 |
| 422 | `CALLBACK_NOT_ALLOWED` | 服务方先登记精确 HTTPS 回调地址 |
| 429 | `RATE_LIMITED` | 按 Retry-After 等待；同时最多接收两个任务上传请求 |
| 503 | `QUEUE_FULL` | 当前未完成父任务达到 100，按 Retry-After 重试原请求 |
| 503 | `API_NOT_CONFIGURED` | 服务方尚未配置 API Key 或下载签名密钥 |
| 503 | `CALLBACK_NOT_CONFIGURED` | 服务方尚未配置回调签名密钥 |
| 500 | `INTERNAL_ERROR` | 稍后用原 client_task_id 重试 |

生成失败是异步结果：HTTP 200 的任务响应中 `results[].error.code=GENERATION_FAILED`，不等同于创建接口的 HTTP 错误。回调投递错误为 `CALLBACK_HTTP_ERROR / CALLBACK_UNREACHABLE / DELIVERY_EXPIRED`，出现在 `webhooks[].last_error`。

## 10. 服务方本机配置与交付

在 `symphony-pool-workbench` 目录复制模板，只在本机填入值：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

已有 `.env` 时直接编辑，避免覆盖。`.env` 已被 Git 忽略；启动程序会读取它，已有进程环境变量优先。Key 和签名密钥均需独立随机值，长度 32–512、不可包含空白。不要把真实 Key 写进本文、示例 JSON、提交记录或聊天。

| 配置项 | 含义 |
| --- | --- |
| `PARTNER_API_KEY` | 合作方请求使用的共享 Bearer Key |
| `PARTNER_DOWNLOAD_SECRET` | 本服务内部签发下载链接的密钥；不交给对方 |
| `PARTNER_PUBLIC_BASE_URL` | 本机联调地址或后续公网 `https://域名/v1` |
| `PARTNER_CALLBACK_URLS` | 已登记的完整 HTTPS 回调地址，多个用逗号分隔 |
| `PARTNER_DEFAULT_CALLBACK_URL` | 可选，须在登记列表中；请求省略 callback_url 时使用 |
| `PARTNER_WEBHOOK_SECRET` | 启用回调时设置，与对方本地配置一致 |

修改配置后重启服务。轮换下载密钥使旧签名链接失效，重新查询可获取新链接；轮换回调密钥要同步通知接收方，以其当前配置验签。生产回调需要可解析的公网 HTTPS 地址；测试中的回环回调仅通过程序选项启用，不通过 `.env` 开放。

```powershell
.\stop-workbench.ps1
.\start-workbench.ps1 -NoBrowser
```

重启前先确认工作台没有正在执行或验收的浏览器任务。配置为空时工作台仍可用，`/v1` 返回 503。这里不内置通用默认 Key。

公网接入时，继续让工作台监听 `127.0.0.1:8787`，由同机 HTTPS 反向代理只转发 `/v1/`。保留路径，并将上游 `Host` 设为 `127.0.0.1:8787`，否则工作台的 Host 校验会拒绝。请求体上限至少 101 MiB，给图片上传设置足够超时。后台管理的 `/api/`、`/accounts`、`/jobs` 等路由保持本机访问。下载 URL 使用显式配置的 Base URL，不从调用方的 Host 或转发头推断。

给对方的交付内容：

1. 此文档与 `docs/partner-openapi.json`、`docs/examples/partner-task.json`。
2. 确定后的公网 HTTPS Base URL。
3. 双方通过安全渠道配置的共享 API Key。
4. 回调地址登记结果和回调签名密钥（若使用回调）。
5. 一个双方联调通过的 `client_task_id` / `task_id`、视频文件及 SHA-256 校验结果。

当前域名和回调地址待确定，先完成本机配置即可联调。对方可以先根据 OpenAPI 开发创建、查询、取消和下载流程。

## 11. 维护与验证

实现：`lib/partner-api.mjs`、`lib/partner-store.mjs`、`lib/partner-protocol.mjs`。父任务、视频条目和回调发送记录持久化到现有 SQLite 的 `partner_*` 表，实际生成复用原有 `jobs` 队列。

```powershell
npm run docs:partner
npm test
```

规范生成器根据实现的模型和错误码生成 OpenAPI；如接口字段变更，同步更新此文档和生成器。自动测试使用临时数据库与模拟浏览器执行器，覆盖防重、上传、分批、取消、额度失败、重启恢复、回调签名与重试、原文件下载和链接过期，不消耗真实账号额度。真实公网及平台端到端联调需在域名、Key、回调和可用账号配置好后进行。
