# 视频生成本地 API

服务默认只监听 `http://127.0.0.1:8787`。其他本机程序可以传入图片和生成参数；每条任务由一个已登录、已验收且当前空闲的账号执行。

## 一步创建并开始

纯文字生成时无需上传图片，`referenceAssets` 可省略或传空数组。使用参考图片时，先把图片文件的原始字节 `POST /api/assets`（`Content-Type: image/png`、`image/jpeg` 或 `image/webp`），响应中的 `path` 是服务端保存的绝对路径。若调用程序和工作台位于同一台电脑，也可以直接提供服务端可访问的图片绝对路径。图片必须为 PNG、JPG 或 WebP，单张不超过 20 MB，数量为 0–9 张。

随后调用 `POST /api/video-generations`，请求体为 JSON：

```json
{
  "idempotencyKey": "order-12345",
  "accountId": "auto",
  "model": "Seedance 2.0 Fast",
  "durationSeconds": 5,
  "aspectRatio": "16:9",
  "positivePrompt": "人物保持外观，镜头缓慢推进",
  "negativePrompt": "不要文字、闪烁和水印",
  "concurrency": 2,
  "referenceAssets": ["C:\\path\\returned-by-upload-1.png"],
  "referenceAssetNames": ["产品图.png"]
}
```

`idempotencyKey` 建议由调用方为每次生成请求提供唯一值。用同一键及相同参数重试时，会返回原批次，不会再次生成；同一键对应不同参数会返回 `IDEMPOTENCY_CONFLICT`。`accountId` 可填 `auto` 或一个账号 ID；并发数大于 1 时必须填 `auto`。`referenceAssetNames` 可省略。负面提示词可为空；两平台当前自动化入口没有独立负面提示词控件，执行器会将其作为“请避免出现”的要求附加到提示词。

成功启动返回 HTTP 202，包含 `batchId` 与 `jobs` 数组。每个元素有独立的 `id`、`accountId`、`status`、`batchIndex` 和 `batchSize`。并发数 N 表示同时占用 N 个不同账号，各生成一条视频；若符合条件的空闲账号少于 N，返回 `INSUFFICIENT_ELIGIBLE_ACCOUNTS`，整批不启动。若提供了 `idempotencyKey`，补足账号后可用同一请求重试。

通过 `GET /api/video-generations/{batchId}` 查询整批状态，完成后通过 `GET /api/jobs/{jobId}/result` 下载各条 MP4。重复的一步调用返回 HTTP 200 与已有批次。本页接口供同机程序使用；合作方通过带鉴权的 `/v1` 接口接入，见 [合作方 API 文档](PARTNER_API.md)。

## 参数限制

| 参数 | 允许值 |
| --- | --- |
| `model` | `Seedance 2.0 Fast`、`Seedance 2.0 Mini`、`Video 1.5 Pro`，必须明确指定 |
| `durationSeconds` | `5`、`10`、`12`；12 秒仅支持 `Video 1.5 Pro` |
| `aspectRatio` | `9:16`、`16:9`；16:9 仅支持豆包模型 |
| `concurrency` | 1–8 的整数，默认 1；大于 1 时账号必须自动分配 |
| `positivePrompt` | 必填，最多 12,000 字符；也接受兼容字段 `prompt` |
| `negativePrompt` | 可选，最多 2,000 字符；与正向提示词合并后不得超过 12,000 字符 |
| `referenceAssets` | 可省略，或传 0–9 个图片绝对路径；0 张时纯文字生成，TikTok 模型最多 4 张，豆包模型最多 9 张 |

两个 Seedance 模型只使用豆包账号，`Video 1.5 Pro` 只使用 TikTok 账号。TikTok 的 9:16 使用平台默认比例，网页没有独立比例设置控件。平台的实际生成结果仍取决于对应网页服务。

## 草稿接口

兼容接口 `POST /api/jobs` 可保存草稿，传入上述参数即可；返回的 `job.id` 可通过 `POST /api/jobs/{jobId}/start` 开始，响应同样包含 `batchId` 和 `jobs` 数组。`PATCH /api/jobs/{jobId}` 可在启动前修改草稿。当前页面点击“开始生成”会保存并立即尝试启动；历史草稿仍可编辑、启动或取消。新请求统一走视频生成流程，`mode` 可省略；兼容字段值 `image_to_video` 同时适用于纯文字与图片参考，不要传参考视频。历史任务数据仍可查询。
