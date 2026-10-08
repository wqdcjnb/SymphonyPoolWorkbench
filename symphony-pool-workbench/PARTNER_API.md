# symphony 号池视频生成 API 接入文档

文档版本：1.5.2 · API 版本：v1 · 2026-10-06

本文供调用本服务的合作方接入。调用方通过 HTTPS 提交任务，服务端使用账号池执行，完成后按请求的交付模式返回可下载的 MP4 地址。调用方无需登录管理后台或安装 Xpra。

- **服务名称：** `symphony`。
- **API Base URL：** `https://47.84.3.74/v1`
- **在线文档：** `https://47.84.3.74/partner-api/index.html`
- **鉴权：** `Authorization: Bearer <API_KEY>`；专用 API Key 由服务方单独交付，不使用管理员密码、Cookie 或 OAuth。
- **调用位置：** 调用方自己的后端服务器。不要把 API Key 写入网页前端或移动客户端；当前不提供浏览器跨域调用。
- **机器可读规范：** [OpenAPI 3.1 JSON](docs/partner-openapi.json)，可导入 Apifox、Postman。
- **请求样例：** [task.json](docs/examples/partner-task.json)。
- **工作流：** 提交提示词/图片 → 返回 task_id → 查询或接收回调 → 获取 video_url → 下载并校验 SHA-256。

### 当前开放状态（2026-10-06）

Dola 支持选择 `delivery_mode: "watermark_repair"`：平台生成 → 保存带水印原片 → 追踪并修复水印 → 检查残余字样、时长、尺寸与文件哈希 → 返回修复版视频。

修补采用周边像素插值，右下角可能模糊，不保证复杂背景无痕；不裁剪主体。原片保留在服务方工作台。修补器根据原片尺寸匹配不同大小的水印字形并追踪位置；无法确认水印或处理超出范围的原片时返回明确错误。固定比例输出等比缩放、必要时补边，保留完整画面。

新任务支持豆包与 Dola 的全部六种固定比例：`1:1`、`3:4`、`4:3`、`9:16`、`16:9`、`21:9`。正向提示词中的比例优先于 `ratio` 字段。Dola 修补版的固定输出尺寸依次为 960×960、960×1280、1280×960、720×1280、1280×720、1260×540。

Dola 官方无水印原片尚未验证，因此不能使用默认 `official_original` 模式。豆包 继续使用该默认模式；云端实号生成取决于已登录并验收通过的账号。模型目录表示协议支持范围，不能代表可用账号或平台额度。

本版使用单一合作方共享 Key，持有 Key 的调用方可访问本服务的合作方任务；尚无多租户数据隔离。多个独立合作方接入前，需要服务方先配置独立实例或扩展租户隔离。

### Dola 人机验证后如何继续

- 平台要求验证时，原任务保持 `reconciling`，对应结果提供 `error.code: "DOLA_HUMAN_VERIFICATION_REQUIRED"`。这表示需要服务方处理，并不表示平台仍在生成。
- 服务方在工作台“打开账号处理验证”，使用该账号的 Xpra Chrome 完成验证，保留窗口，再点击“验证完成，继续任务”。系统会检查匹配的原平台会话、恢复账号并只收集原任务；无法确认时显示具体原因。
- 工作台状态“生成中”表示已恢复跟踪，“保存视频中”表示正在下载；API 随后经历 `running` → `succeeded`（如有多条任务，以实际批次结果为准）。只有返回可用 `video_url` 才代表视频交付完成。
- 调用方继续查询同一个 `task_id`。示例客户端会保持等待；`recovery.mode:manual` 表示需联系服务方处理。客户端重启后，重新执行 `wait` 命令并传入原 `task_id` 即可。不要换 `client_task_id` 重建任务。
- 平台验证码仍需人工完成；本功能接续验证后的任务，不代替人工验证。

## 1. 两个任务 ID

| 字段 | 谁提供 | 用途 |
| --- | --- | --- |
| `client_task_id` | 调用方 | 对方的业务任务 ID，以及防止重复生成的幂等键 |
| `task_id` | 本服务 | 本服务的任务 ID，用于查询、取消和下载 |
| `event_id` | 本服务 | 一次回调事件的 ID；通知重试时不变，用于接收方去重 |

创建请求传 `client_task_id`，响应和回调均包含两个任务 ID。请求不接受含义模糊的 `id` 字段。`event_id` 就是回调通知的编号，无需对方预先提供 `webhook_id`。

同一 `client_task_id`、相同规范化参数、相同图片字节及顺序再次提交，返回原任务，HTTP 200，`idempotent_replay: true`。首次受理返回 HTTP 202。相同 ID 改了参数、图片或图片顺序，返回 HTTP 409 `ID_CONFLICT`。图片文件名不影响幂等判断；提示词首尾空白会去除，省略的参数先应用默认值。`callback_url` 和 `delivery_mode` 也参与幂等判断。省略或显式填写默认 `official_original` 等价，历史任务幂等不变。

网络中断或创建接口返回超时，使用**相同 ID 和原始请求**重试。终态任务也不会因重复提交而重新生成；如确实需要重新生成，使用新的 `client_task_id`。ID 记录保留在本地数据库，轮换共享 Key 不会清空记录。

## 2. 模型和参数范围

`GET /models` 获取当前支持的名称、版本标签、组合及大小限制。模型名区分大小写。

| `model` | `version` | `duration` 秒 | `ratio` | 图片数量 |
| --- | --- | --- | --- | --- |
| `Seedance 2.0 Fast` | `2.0 Fast` | 15 | `1:1`、`3:4`、`4:3`、`9:16`、`16:9`、`21:9` | 0–9 |
| `Seedance 2.0 Mini` | `2.0 Mini` | 15 | `1:1`、`3:4`、`4:3`、`9:16`、`16:9`、`21:9` | 0–9 |
| `Dreamina Seedance 2.5`（Dola 修补版） | `2.5` | 30 | `1:1`、`3:4`、`4:3`、`9:16`、`16:9`、`21:9` | 0–9 |

版本号是当前平台界面和执行器使用的版本标签，平台没有提供内部构建版本。上表表示接口支持范围；实际开始时间取决于相应模型的可用账号。两个平台每账号每日默认 10 积分；豆包 15 秒视频每条 2 积分，Dola 30 秒每条 4 积分。工作台在北京时间 00:00 重置每日预算，派号时预留积分，确认提交前失败会退还；验收和重收原视频不会重复扣分。模型目录返回 `daily_credits` 和 `credits_per_video`。

| 请求字段 | 类型 | 必填 | 约束与含义 |
| --- | --- | --- | --- |
| `client_task_id` | string | 是 | 1–128 个英文字母、数字、下划线或连字符 |
| `model` | string | 是 | 上表中的完整名称；提示词包含 30 秒表达时覆盖为 `Dreamina Seedance 2.5` |
| `duration` | integer | 是 | 秒，与模型匹配；提示词包含 30 秒表达时覆盖为 30 |
| `ratio` | string | 是 | 六种固定比例（见上表）；正向提示词中的目标比例优先，响应返回实际采用的比例 |
| `delivery_mode` | string | 否 | 默认 `official_original`；Dola 使用 `watermark_repair`，表示接受局部修补、可能模糊及重新编码。命中下述 30 秒规则时自动设为 `watermark_repair`；其余 Dola 请求须显式传入 |
| `count` | integer | 否 | 视频总条数，1–100，默认 1；不是并发数 |
| `prompt` | string | 是 | 非空正向提示词，最多 5000 个 Unicode 码点 |
| `negative_prompt` | string | 否 | 独立反向提示词，最多 2000 个 Unicode 码点，默认空字符串 |
| `callback_url` | string | 否 | 预登记的完整 HTTPS 回调地址；省略使用服务端默认地址，显式空字符串表示本任务只查询、不回调 |
| `images` | binary[] | 否 | multipart 的重复文件字段，不能放进 JSON；PNG/JPEG/WebP，每张 ≤20 MiB，合计 ≤100 MiB |

正、反提示词独立接收和保存。当前浏览器生成入口没有独立的负面提示词控件，执行时将反向提示词作为“请避免出现”要求加入平台提示词。由于执行器长度限制，两者合计的 UTF-16 长度还须 ≤11968。大部分中文字符各计 1，部分 emoji 各计 2。

图片随本次任务上传，保留上传顺序，不需要单独创建素材 ID。豆包和 Dola 均支持参考图片生成；有图走图片生成，无图走文字生成。不接受 `resolution`、`mode`、`external_user_id`、`metadata`、`reference_video_id` 等未定义字段，也不接受本机文件路径或图片 URL 来替代上传。

### 提示词比例优先

- 正向 `prompt` 中出现上述任一固定比例时，覆盖 `ratio` 字段；例如字段为 `9:16`，提示词为“生成 1:1 方形商品视频”，最终生成和响应 `ratio` 都为 `1:1`。
- 支持全角数字、全角冒号和空格，例如 `１：１`、`16 ： 9`。提示词没有比例时，使用 `ratio` 字段。原始提示词仍保留。
- `negative_prompt` 不参与比例选择；正向提示词中紧邻“不要”“避免”或 `avoid` 等排除词的比例也不作为目标，例如“生成 1:1 视频，不要 9:16”。
- 多次出现同一个比例正常受理；出现多个不同的目标比例时返回 HTTP 422 `PROMPT_RATIO_CONFLICT`，请只保留一个目标比例。暂不支持的比例（如 `2:1`）返回 HTTP 422 `PROMPT_RATIO_UNSUPPORTED`，不会改成其他比例生成。
- 创建响应、查询响应、内部任务和平台提交使用同一最终比例；调用方应以响应的 `ratio` 为准。页面下拉框和 API 均只提供上述六种固定比例。
- 本规则适用于升级后受理的新任务；相同 ID 重试升级前的原始请求时返回原任务及原参数，不改变已提交任务或重复生成。

### Dola 图文和时长填写

- 图片与文字放在同一个 multipart 请求中：`task` 包含完整 `prompt`，`images` 包含参考图片。服务端等待图片上传完成后联合提交，保留图片顺序。
- **30 秒优先规则：** `prompt` 或 `negative_prompt` 中出现 `30s`、`30秒`、`30 seconds`、`三十秒` 等表达时，无论原先选择什么模型，都使用 `Dreamina Seedance 2.5`、`duration:30`、`delivery_mode:watermark_repair`。比例按上述提示词优先规则确定，图片顺序和条数保持请求值；创建与查询响应中的 `model`、`duration`、`delivery_mode` 表示最终采用的参数。参数类型和图片限制仍须满足接口要求。
- Dola 30 秒任务在提交平台前清理上述时长文字和旧的 Seedance 1.0/2.0 模型说明；`0–5秒`、`22–30秒` 等合法分镜范围转换为全片进度比例。实际时长由结构化参数设置为 30 秒，服务端不再往文字中追加秒数。
- 原始正反提示词保留在任务记录中，清理仅作用于发给 Dola 的文本；任务恢复同时识别原文和清理后的文本。`30袋商品`、`30fps`、`130s` 等不会触发此规则。若清理后没有画面描述，或包含无法正确转换的 30 秒分镜范围，任务会提示修改提示词。
- 例如：传入 `model:"Seedance 2.0 Mini"`、`duration:15`、`prompt:"生成30s商品广告"`，返回并执行 `model:"Dreamina Seedance 2.5"`、`duration:30`、`delivery_mode:"watermark_repair"`；平台收到的文字为“生成商品广告”。无需调用方提前清理提示词。
- Dola 的聊天回复可能建议缩短时长；这类请求会报告生成失败，不会自动改成 15 秒交付。进入平台队列后仍需等待生成和下载，最终结果按请求时长校验。

## 3. 创建任务

`POST /videos`

### Dola 修补版最小请求

```json
{
  "client_task_id": "dola_order_unique_001",
  "model": "Dreamina Seedance 2.5",
  "delivery_mode": "watermark_repair",
  "duration": 30,
  "ratio": "9:16",
  "count": 1,
  "prompt": "蓝色立方体和橙色小球，固定镜头，柔和光线",
  "callback_url": ""
}
```

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
  "duration": 15,
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
$base = 'https://47.84.3.74/v1'
curl.exe "$base/videos" `
  -H "Authorization: Bearer $env:PARTNER_API_KEY" `
  -F 'task=<task.json' `
  -F 'images=@D:/images/first.png' `
  -F 'images=@D:/images/second.jpg'
```

无图片时可直接：

```powershell
curl.exe "$base/videos" `
  -H "Authorization: Bearer $env:PARTNER_API_KEY" `
  -H 'Content-Type: application/json' `
  --data-binary '@task.json'
```

### 3.3 首次受理响应

HTTP 202 表示任务已保存并受理。创建 HTTP 请求不会保持到视频生成结束。`Location` 和 `status_url` 给出查询地址，`Retry-After` 和 `poll_after_seconds` 给出建议查询间隔。收到受理响应后，调用方应保存两个任务 ID，并在自己的后台持续跟踪结果。

```json
{
  "task_id": "task-550e8400-e29b-41d4-a716-446655440000",
  "client_task_id": "order_20260930_0001",
  "status": "queued",
  "terminal": false,
  "poll_after_seconds": 60,
  "status_url": "https://47.84.3.74/v1/videos/task-550e8400-e29b-41d4-a716-446655440000",
  "notification_mode": "poll",
  "model": "Seedance 2.0 Mini",
  "duration": 15,
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

`count=5` 拆成 `2 + 2 + 1`。前一批全部结束后才提交下一批；批次内按账号可用情况执行，只有一个可用账号时可以依次完成两条。同一浏览器账号同时执行一条，与工作台任务共用执行槽位。当前云端节点配置 10 个槽位、软件全局上限 100；实际承载与账号可用性需单独验收，count 不代表同时运行数量。

每批结束产生一次 `video.batch.completed` 回调，`results` 最多 2 项。每项可能成功、失败或取消，最后一个奇数批次只有 1 项。普通任务的最后一批 `is_final=true`。某条失败不阻止下一批，但已向平台提交、结果不明的条目进入 `reconciling`，该任务暂不启动下一批，等待服务方核对或收集已有结果。

号池从兼容、空闲、已验收的账号中，先选择稳定性较好的账号，同档优先选择可用积分较多的账号。明确额度耗尽时标记冷却并安全换号；提交前故障会暂停该账号并尝试其他账号。普通网络或浏览器故障不能证明额度为零。对已提交但结果不明的生成，继续核对原任务。

回调 HTTP 失败只重试通知，不会重新生成视频，也不会阻塞下一批生成。

## 5. 查询任务

`GET /videos/{task_id}`，需要 Bearer Key。按 `poll_after_seconds` 查询，默认每 60 秒一次，并增加 0–15% 随机延迟以错开请求。每个共享 Key 默认最多 300 次控制接口请求/分钟，超限返回 429 和 `Retry-After`；收到 429 时至少等待该头部指定的时间。100 个任务每 60 秒查询约产生 100 次请求/分钟，创建、取消等控制请求也计入同一限额。

响应结构与创建一致，但没有 `idempotent_replay`。`results` 始终按序号包含本任务所有条目，查询返回累计结果；回调只包含本批结果。视频成功后对应条目变为：

```json
{
  "index": 1,
  "batch_index": 1,
  "status": "succeeded",
  "size_bytes": 18345290,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "watermark_free": true,
  "retained_until": "2026-10-07T06:02:00.000Z",
  "video_url": "https://47.84.3.74/v1/videos/task-550e8400-e29b-41d4-a716-446655440000/results/1?expires=1790834520&signature=EXAMPLE_SIGNATURE",
  "expires_at": "2026-10-01T06:02:00.000Z"
}
```

上述文件大小、摘要和 URL 仅展示字段，实际使用响应返回的值。时间统一为 UTC ISO 8601。

| 任务状态 | 含义 | 终态 |
| --- | --- | --- |
| `queued` | 等待账号或执行槽位 | 否 |
| `running` | 正在生成、保存或继续下一批 | 否 |
| `reconciling` | 正在核对原平台任务，按 `recovery.mode` 区分自动核对或人工处理 | 否 |
| `cancelling` | 已停止未来条目，等待在途生成结束 | 否 |
| `succeeded` | 全部成功 | 是 |
| `partially_succeeded` | 部分成功、其余失败 | 是 |
| `failed` | 全部失败 | 是 |
| `cancelled` | 存在被取消条目，其余均已结束；仍可能有成功结果 | 是 |

`completed_count = succeeded_count + failed_count + cancelled_count`，表示已经结束的条目数，不仅指成功。`results[].status` 使用 `queued / running / reconciling / succeeded / failed / cancelled`。

#### 具体进度：`results[].progress`

`status` 保留原有枚举兼容轮询。前端展示具体进度时使用 `progress.label`、`progress.description` 和 `progress.phase`，不要把所有 `running` 都显示成“生成中”，或把所有 `reconciling` 都显示成“需验证”。查询直接读取当前执行阶段，不必等待下一轮协调器刷新。

| `phase` | 含义 |
| --- | --- |
| `queued` / `starting` / `submitting` | 排队、准备浏览器素材、发送请求 |
| `awaiting_platform` | 已进入会话，尚未确认开始生成 |
| `generating` | 平台已确认开始生成 |
| `awaiting_verification` / `awaiting_login` | 等待本人验证或重新登录 |
| `awaiting_confirmation` / `submission_unconfirmed` / `parameter_mismatch` | 原请求确认或参数需要核对 |
| `downloading` / `processing` | 平台已生成，正在下载、处理或校验交付文件 |
| `download_blocked` | 视频已生成，原片下载、无水印处理或文件校验受阻 |
| `reconciling` / `needs_review` | 最新平台状态尚待确认，以说明及自动核对计划为准 |
| `completed` / `failed` / `cancelled` | 已完成交付、失败、取消 |

`platform_status` 是最近确认的平台状态，`delivery_status` 是交付状态，`last_observed_at` 是最近观察到执行阶段的时间。`progress.action` 指服务方应执行的操作；调用方仍使用原 `task_id` 查询。`platform_status:completed` 不等于可以下载，只有 `succeeded` 且返回可用 `video_url` 才能领取成品。

默认交付必须无水印：豆包使用校验通过的官方无水印原片，Dola 使用约定的修补流程。原片下载、修补或校验失败时保留原任务处理，不回传带水印预览片。下载接口超时不代表平台已拒绝无水印权限。

豆包原片通过创作库按视频 ID 匹配取得，并校验文件大小、来源校验值和 SHA-256。平台单独返回 `without_watermark:true` 不足以完成交付校验，带水印标记的播放地址会被拦截。

单条失败包含 `error.code`：`GENERATION_FAILED`、`RESULT_MISSING` 或 `WATERMARK_FREE_RESULT_REQUIRED`。文件保留期结束后，成功记录仍保留，但 `video_url`、`expires_at` 为 null，并带 `RESULT_EXPIRED`。

`webhooks` 可查看每个通知的 `event_id / state / attempts / last_http_status / last_error`。状态为 `pending / sending / delivered / failed / skipped`；未配置回调时为 `skipped`。通知失败不会改变视频成功状态。

### 5.1 长任务与超时处理（所有模型）

- `terminal:false` 表示任务尚未结束，`poll_after_seconds` 默认为 60；终态为 `terminal:true`、间隔为 0。`status_url` 始终指向原任务。`notification_mode:poll` 表示仅查询，`webhook_and_poll` 表示已启用回调且仍可查询。
- 连接超时、查询失败、429、临时 5xx 和回调投递失败只说明本次通信没有成功。调用方应保留任务号、退避后继续查询；不能据此把视频标为生成失败。
- `queued`、`running`、`reconciling`、`cancelling` 都是未结束状态。生成期间 `updated_at` 可能长时间不变，它不是心跳时间。只有任务或条目返回明确的失败终态，才能记为生成失败。
- 豆包和 Dola 已返回原平台任务地址后，生成等待超时或可恢复的执行中断会安排自动核对。核对只打开原任务并收集结果，不重新点击生成，也不重复扣积分。任务号、平台地址和核对计划保存在数据库，服务重启后恢复。
- 核对间隔从 1 分钟递增至最多 15 分钟；单次等待平台结果约 90 秒，下载与处理另需时间。自动核对共用视频执行槽位，同时最多占 2 个。自首次安排核对起，最长自动核对 24 小时；之后保留 `reconciling` 并转人工确认。
- 缺少可信的平台任务地址、登录失效或平台要求人机验证时，暂停自动处理，由服务方处理原账号和原任务。账号在此期间不再接收新任务。

核对中的条目会增加以下字段：

```json
{
  "index": 1,
  "batch_index": 1,
  "status": "reconciling",
  "recovery": {
    "mode": "automatic",
    "attempts": 2,
    "next_check_at": "2026-10-06T12:05:00.000Z",
    "deadline_at": "2026-10-06T11:00:00.000Z"
  }
}
```

`mode:automatic` 表示已安排下一次核对；`mode:manual` 表示需要服务方处理，`next_check_at` 为 null。调用方仍保留原 `task_id` 查询结果，不改业务 ID 重发生成。

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

回调地址由调用方系统提供：调用方实现接收通知的 HTTPS 接口，将准确 URL 提供给服务方登记，并约定验签密钥后，在创建请求中传入 `callback_url`。目前尚未登记回调地址，可先使用 `callback_url:""` 和查询接口完成接入。

本服务向预登记 `callback_url` 发送 HTTPS POST。地址必须精确匹配服务端配置（包括路径及查询参数），不跟随重定向，不允许回调至内网、回环或保留地址。接入回调后也应定期查询未结束任务，补偿丢失或延迟的通知。

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
      "watermark_free": true,
      "retained_until": "2026-10-07T06:02:00.000Z",
      "video_url": "https://47.84.3.74/v1/videos/task-550e8400-e29b-41d4-a716-446655440000/results/1?expires=1790834520&signature=EXAMPLE_SIGNATURE_1",
      "expires_at": "2026-10-01T06:02:00.000Z"
    },
    {
      "index": 2,
      "batch_index": 1,
      "status": "succeeded",
      "size_bytes": 19450321,
      "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "watermark_free": true,
      "retained_until": "2026-10-07T06:02:00.000Z",
      "video_url": "https://47.84.3.74/v1/videos/task-550e8400-e29b-41d4-a716-446655440000/results/2?expires=1790834520&signature=EXAMPLE_SIGNATURE_2",
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

交付模式随创建请求确定，查询和回调的成功结果会标明模式：

| 模式 | 结果标记 | 文件 |
| --- | --- | --- |
| `official_original`（默认） | `watermark_free:true`、`postprocessed:false` | 校验通过的平台无水印原片，保持原始字节 |
| `watermark_repair`（Dola） | `watermark_free:null`、`postprocessed:true` | 追踪水印并局部修复后编码的 H.264 MP4，SHA-256 对应处理后的文件 |

新成片的 `processing` 包含 `method:opencv_temporal_inpaint`、引擎 `preset`、模板哈希、轨迹数、帧数、残余匹配统计和画质提示；历史已交付文件可能仍使用 `method:ffmpeg_delogo`。`watermark_free:null` 表示没有官方无水印原片证明，局部修复也无法保证任意画面完全无痕。成功且 `video_url` 非空才可下载；客户端应确认结果模式与请求一致。

原片模式仍要求平台来源和哈希证明，失败为 `WATERMARK_FREE_RESULT_REQUIRED`。修补失败为 `WATERMARK_REPAIR_FAILED`，布局不匹配为 `WATERMARK_REPAIR_UNSUPPORTED_LAYOUT`，均不返回该条下载链接；历史下载链接也复核文件证明。处理失败不会重新向平台提交生成任务，应由服务方检查已有原片。

- 回传保存好的 MP4 文件，不使用 Base64；修补版重新编码为 H.264，保留音频（如有）。
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
| 409 | `WATERMARK_FREE_RESULT_REQUIRED` | 无水印原片尚未验证，联系服务方核对或收集原片 |
| 409 | `WATERMARK_REPAIR_FAILED` | 修补或文件校验失败，联系服务方处理已有原片 |
| 409 | `WATERMARK_REPAIR_UNSUPPORTED_LAYOUT` | Dola 原片布局变化，需检查修补区域 |
| 410 | `RESULT_EXPIRED` | 文件保留期已结束 |
| 410 | `RESULT_MISSING` | 文件丢失或不可用，联系服务方 |
| 413 | `UPLOAD_TOO_LARGE` | 减少单图或总请求大小 |
| 415 | `UNSUPPORTED_IMAGE_FORMAT` | 上传 PNG/JPEG/WebP 实际图片文件 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 使用 JSON 或 multipart/form-data |
| 416 | `INVALID_RANGE` | 使用合法单段 Range |
| 422 | `UNSUPPORTED_COMBINATION` | 检查模型/时长/比例/图片数量组合 |
| 422 | `CALLBACK_NOT_ALLOWED` | 服务方先登记精确 HTTPS 回调地址 |
| 429 | `RATE_LIMITED` | 按 Retry-After 等待；默认每分钟最多 300 次控制请求 |
| 503 | `QUEUE_FULL` | 未完成父任务达到 1000，或上传等待队列已满 / 超时，按 Retry-After 重试原请求 |
| 503 | `API_NOT_CONFIGURED` | 服务方尚未配置 API Key 或下载签名密钥 |
| 503 | `CALLBACK_NOT_CONFIGURED` | 服务方尚未配置回调签名密钥 |
| 500 | `INTERNAL_ERROR` | 稍后用原 client_task_id 重试 |

生成失败是异步结果：HTTP 200 的任务响应中 `results[].error.code=GENERATION_FAILED`，不等同于创建接口的 HTTP 错误。回调投递错误为 `CALLBACK_HTTP_ERROR / CALLBACK_UNREACHABLE / DELIVERY_EXPIRED`，出现在 `webhooks[].last_error`。

## 10. 最小接入流程

1. 从服务方单独领取专用 API Key，在自己的服务器配置环境变量 `PARTNER_API_KEY`。`PARTNER_API_BASE_URL` 设置为 `https://47.84.3.74/v1`。
2. 先调用 `GET /models`，确认返回 JSON 200；若为 401 检查 Key，若为 503 `API_NOT_CONFIGURED` 联系服务方。
3. Dola 使用 `Dreamina Seedance 2.5`，显式选择 `delivery_mode:"watermark_repair"`；接受局部模糊和重新编码后，再提交业务任务。
4. 使用唯一 `client_task_id`、`count:1` 和 `callback_url:""` 提交。网络异常时用相同 ID、参数和图片重试。
5. 按 `poll_after_seconds` 查询，默认 60 秒并随机错开。`reconciling` 继续等待，`recovery.mode:manual` 时联系服务方；保留 task_id，不改 ID 重发生成。
6. 对成功条目，确认交付模式与请求一致：原片 `watermark_free:true`，修补版 `postprocessed:true` 且 `watermark_free:null`；`video_url` 非空后下载到自己的存储，核对完整文件 SHA-256。根据 `expires_at` 和 `retained_until` 及时保存。
7. 初次建议使用轮询；需要回调时，把准确的 HTTPS 回调 URL 提供给服务方登记，单独约定 webhook 签名密钥，再进行回调联调。

接入包内包含 `client.py`（Python 标准库）、`client.mjs`（Node.js 22+）、`webhook_verify.py`、Postman Collection、OpenAPI 和任务 JSON。示例读取环境变量，文档及示例不含真实 Key。

### Python

```powershell
python client.py models
python client.py submit task.json
python client.py submit task.json --image first.png --image second.jpg
python client.py wait task-实际任务ID --output ./videos
python client.py cancel task-实际任务ID
```

`wait` 默认持续等待，没有 20 分钟结束限制；它会重试临时断网、限流和临时服务错误，经过 `reconciling` 后继续查询。需要限制本次命令等待时间时，可加 `--timeout 1200`（秒）。达到此时限返回 `wait_expired:true, terminal:false` 和原任务号，退出码为 0，表示“本次等待结束，任务仍未完成”；不会取消云端任务或标记生成失败。实际失败、部分失败或取消的终态退出码为 2，鉴权或参数错误退出码为 1。

示例在 `.symphony-tasks/<task_id>.json` 保存任务号、状态和计数，可用 `--state-dir` 更改目录；不保存 API Key、提示词或带签名下载链接。命令中断或机器重启后，用文件中的原任务号再次执行 `wait`。生产系统应把任务号保存在自己的数据库，并由后台任务持续查询，网页请求只负责提交和展示进度。

### Node.js

```powershell
node client.mjs models
node client.mjs submit task.json
node client.mjs wait task-实际任务ID ./videos
node client.mjs cancel task-实际任务ID
```

Node 示例展示无图片任务；图片上传可使用 Python 或本文 multipart 示例。

## 11. 联调记录与支持

协议回归使用隔离测试数据验证鉴权、上传、幂等、分批、取消、回调签名与重试、原文件下载和过期行为；它不能替代真实平台生成验收。接入包中的验收说明会分别列出公网协议检查与真实平台检查。

提供给服务方的问题信息：时间（含时区）、HTTP 状态、error.code、client_task_id、task_id。不要把 API Key 或完整带签名的下载链接放进公共日志。

更换 API Key 不会清空幂等记录。共享 Key 的 client_task_id 在整个服务内唯一，轮换 Key 后同一 ID 仍返回原任务。文件保留期与下载链接有效期是两件事：刷新链接不能延长文件保留期。


### 排队与账号选择

- 同平台优先选择稳定性较好的账号，同档优先选择可用积分较多的账号；每号同时执行一个任务。
- 登录失效或需要验证的账号暂停派发，人工处理并验收通过后恢复；恢复登录不会清空历史稳定性记录。
- 无空闲账号时，已接收的任务保存在数据库排队，服务重启后继续处理。收到 `202` 表示已持久化，请按原 task_id 查询，避免重复下单。
- 默认容纳 1000 个未结束的父任务（含排队、运行、待核对），每个任务仍可请求 1–100 条视频、每轮最多 2 条。
- 上传解析同时最多 2 个请求，额外最多 200 个请求等待解析，等待最长 30 秒；达到接收或任务上限时返回 `503 QUEUE_FULL` 与 `Retry-After`。未收到成功响应时用相同 client_task_id 重试。
- 当前云端视频执行容量仍为 10，队列容量不等于同时生成数。按优先级、同优先级按进入队列时间派发。
