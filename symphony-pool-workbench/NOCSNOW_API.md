# Nocsnow 视频 API 接入

外部请求方通过下方接口将任务交给工作台，由工作台连接 [Nocsnow 视频 API](https://nocsnow.com/api-docs) 并自动排队生成。模型名称、时长、比例和分辨率由请求方按自己 Key 的 `GET /models` 配置提交，支持正向/负向提示词和最多 9 张参考图。参考图会直接上传到 Nocsnow，不会写入工作台的本地上传目录。工作台 `/jobs` 只有一份任务列表，会同时显示账号池任务和这些 API 请求；旧 `/video-api` 地址会跳转到 `/jobs`。

每次请求由调用方在 `Authorization: Bearer <API_KEY>` 传入自己的 Key。Key 不写入 SQLite、日志、Git 或浏览器持久存储。服务运行期间只在进程内暂存 Key 以便提交后续轮次、查询状态及保存视频；进程重启后，请求方需用同一个 Key 再次调用下方的历史接口，才能恢复调度与结果保存。不同 Key 的任务历史彼此隔离。不要把 Key 放在 URL 查询参数里。

## 公平队列

一次本地申请可填写 `count` 1–100。工作台按每轮最多 2 条调用上游生成接口；同一个 Key 同时最多有 2 条尚未结束的任务。上一轮任务全部成功或失败后，剩余数量回到队尾，再轮到其他 Key。一个 Key 的多份申请共享这 2 个名额。上游任务失败会计入该轮，不会自动付费重试。

工作台默认全局最多同时跟踪 8 条未结束的上游任务。队列、轮次、任务 ID、状态和请求参数保存在本地 SQLite；Key 本身不保存。每轮使用独立的幂等键，网络超时后会用同一键安全重试。若上游返回权限、额度或参数错误，批次变为“需要处理”，修正后可在页面点击“重新尝试本轮”。

## 本机程序调用

工作台默认仅监听 `http://127.0.0.1:8787`。下面的业务接口均使用调用方自己的 Bearer Key；来自其他电脑的请求尚不能直接连接到这个本机地址，需要另行部署受保护的入口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/video-provider/models` | 读取当前 Key 可用模型及配置 |
| `POST /api/video-provider/uploads` | 原始图片二进制上传；`Content-Type` 为真实图片格式，单张不超过 6 MiB |
| `POST /api/video-provider/generations` | 创建本地公平队列批次，必须有 `Idempotency-Key` 请求头 |
| `GET /api/video-provider/history?page=1` | 读取此 Key 的批次与任务状态；重启后调用可恢复调度 |
| `POST /api/video-provider/batches/{batchId}/retry` | 重新尝试被上游错误阻塞的轮次 |
| `GET /api/video-provider/generations/{taskId}` | 用此 Key 即时查询上游任务状态 |
| `GET /api/video-provider/generations/{taskId}/result` | 用此 Key 下载生成的 MP4；支持单段 `Range` |

工作台在生成成功后自动保存 MP4 到本机；本机 `/api/workbench/jobs` 汇总两种来源的任务，`/api/workbench/video-results/{taskId}` 提供已保存的 API 视频下载。这两个工作台接口仅随本机服务开放，不要求提交方的 Key。

创建请求示例（Key 由调用方在本机环境变量中设置；请勿写入脚本或 Git）：

```powershell
$headers = @{
  Authorization = "Bearer $env:VIDEO_API_KEY"
  'Idempotency-Key' = [guid]::NewGuid().ToString()
}
$body = @{
  model = '从模型接口读取的 ID'
  prompt = '窗边的小猫，电影质感'
  negative_prompt = '不要文字和水印'
  ratio = '9:16'
  duration = 5
  resolution = '720p'
  reference_asset_ids = @()
  count = 5
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/video-provider/generations' `
  -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

响应立即给出本地批次 ID 和状态，视频由工作台按轮次异步提交。`reference_asset_ids` 来自上传接口响应的 `data.id`；可以为空。模型 ID、画幅、时长、分辨率应使用当前 Key 的模型配置。不要将同一个 `Idempotency-Key` 用于不同参数；超时后用原键和原请求体重试。

目前的工作台仅供本机访问。要让其他机器或互联网用户直接调用，必须另设有用户认证、访问控制和 HTTPS 的接入层，不能直接开放这个本机监听端口。
