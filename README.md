# Symphony Pool Workbench

视频生成与账号池工作台，支持豆包、Dola 和 Symphony / TikTok。正式代码位于 `D:\Project\SymphonyPoolWorkbench-source`，版本以 `symphony-pool-workbench/package.json` 为准。

## 访问与使用

| 入口 | 地址或路径 |
| --- | --- |
| 云端工作台 | https://47.84.3.74/jobs |
| 云端账号池 | https://47.84.3.74/accounts |
| 合作方在线文档 | https://47.84.3.74/partner-api/index.html |
| 本机工作台 | http://127.0.0.1:8787/jobs |
| 合作方 API | `/v1`，使用专用 Bearer Key |
| 工作台管理接口 | `/api`，由管理员登录保护 |

账号先完成登录与验收，再参与任务调度。人机验证由操作者在该账号的登录窗口完成；已有平台任务时继续收集原任务结果。接口调用方根据原 `task_id` 查询状态，`succeeded` 且提供视频地址后下载文件并校验 SHA-256。平台确认生成与工作台完成交付是两个阶段。

模型、时长、比例和图片限制以工作台控件、`GET /v1/models` 及 [合作方 API 文档](symphony-pool-workbench/PARTNER_API.md) 为准。Dola 的 `watermark_repair` 是局部修补与重新编码，不能标注为官方无水印原片。

Dola 的第三方参考图通过普通输入框“＋”的原生文件选择入口上传，确认附件缩略图后再选择视频参数，并将图片与完整提示词作为同一条消息提交。验证续传和原任务匹配允许 Markdown 列表符号的显示差异，仍严格核对正文、数字、范围及负号。

豆包图生视频也使用普通输入框“＋ → 上传文件或图片”，等待附件上传完成后再切换到视频生成。切换模式、模型和比例后再次核对附件数量，缺图时停止发送。参考视频任务仍使用视频生成工具自己的视频上传控件。

默认交付给第三方的视频必须无水印。豆包使用校验通过的官方无水印原片；Dola 按已约定的修补流程处理后交付。下载、修补或校验未完成时保留原任务并显示实际阻塞阶段，不得用带水印预览片代替成品，也不得将“平台已生成”提前标记为“已完成交付”。

豆包原片从“我的创作”的下载接口取得，按当前视频 ID 和创作节点逐项匹配，再核对文件大小、源文件校验值及 SHA-256。旧接口的 `without_watermark:true` 不能单独证明视频无水印；含水印标记的播放地址必须拦截，下载路径变更后须抽帧验收。

## Windows 本机运行

需要 Node.js 24、Python 3.13，以及 Chrome 或 Edge。首次安装在项目根目录执行：

```powershell
cd symphony-pool-workbench
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-video.txt
.\start-workbench.ps1
```

视频转换及水印修补需要系统可以运行 `ffmpeg` 和 `ffprobe`。已有安装直接使用 `symphony-pool-workbench/start-workbench.ps1`；停止使用同目录 `stop-workbench.ps1`。密钥只在本机私有配置中设置，发布包中的 `.env.example` 保持空密钥。

## 云端部署与数据

生产环境使用 `symphony-pool-workbench/deploy/cloud/compose.v2.yml` 和 `compose.public-v2.yml`。本机 SSH 隧道入口为 `tools/start-cloud-workbench-v2.ps1`，也可直接使用公网 HTTPS 工作台。

| 云端路径 | 用途 |
| --- | --- |
| `/data/symphony/current-v2` | 当前发布目录 |
| `/data/symphony/v2.env` | 当前镜像及运行配置 |
| `/data/symphony/v2/postgres` | PostgreSQL 数据 |
| `/data/symphony/v2/data` | 素材、视频、任务相关文件 |
| `/data/symphony/v2/profiles` | 账号浏览器档案 |
| `/data/symphony/v2/secrets` | API 密钥、数据库连接和加密密钥 |
| `/data/symphony/v2/backups` | 数据库备份 |

云端数据库备份使用 `deploy/cloud/backup-v2.sh` 与 `symphony-v2-backup.service`、`symphony-v2-backup.timer`。备份数据库以外，还需保存素材、视频、浏览器档案与对应密钥。更新服务前核对正在执行的任务及登录窗口。

正式运行时，账号浏览器默认常驻。刷新工作台、核对任务、切换账号和断开查看连接均应复用原浏览器；维护若需要关闭或重启账号浏览器，先取得用户明确同意，再保存登录态和原任务信息。当前排查阶段的临时操作授权不能沿用到正式运行。

工作台 Windows 启动器及下载的 Xpra 连接文件使用 `window-close=disconnect`：关闭查看窗口只断开客户端，服务器浏览器继续运行。网页 URI 会忽略该参数，因此 Windows 直接连接要使用 `tools/configure-xpra-client.ps1` 配置的最新版启动器；其他客户端使用新下载的连接文件。旧连接文件需要重新下载；在 Chrome 菜单中选择“退出”或关闭任务标签页仍会丢失原页面。验证码由用户本人完成，恢复应继续原任务，不能用新生成替代无法确认的旧结果。

本机数据库、素材和视频位于 `symphony-pool-workbench/data/`，日志位于 `logs/`，账号档案位于项目下各 `*_sandbox_data` 目录。运行数据、空日志、浏览器内部空文件以及密钥均不属于源码清理范围。

## 其他运行方式

- Docker 局域网测试：运行 `tools/start-docker-test.ps1`。脚本生成独立的测试数据和接入资料；客户端说明模板在 [CLIENT.md](symphony-pool-workbench/deploy/docker/CLIENT.md)。
- Ubuntu 原生安装：在 `symphony-pool-workbench` 目录运行 `bash deploy/ubuntu/install.sh`。
- 可选 Multilogin 接入的准备说明在本地 `symphony-pool-workbench/docs/MULTILOGIN_MIMIC.md`。它属于待实号验证的扩展，是否启用以实际部署为准。

## 开发与验证

项目使用原生 Node.js HTTP 服务、JavaScript 模块及 Python 浏览器执行器。页面不需要前端打包。

| 目录 | 内容 |
| --- | --- |
| `symphony-pool-workbench/lib` | 数据库、账号池、任务、恢复与 API |
| `symphony-pool-workbench/views`、`public` | 页面模板与静态资源 |
| `symphony-pool-workbench/tests`、`tools/test_*.py` | 自动化回归测试 |
| `tools` | 登录、生成、下载、视频处理与发布工具 |
| `symphony-pool-workbench/deploy` | 当前部署及维护脚本 |

在 `symphony-pool-workbench` 目录运行：

```powershell
npm test
.\.venv\Scripts\python.exe -B -m unittest discover -s ..\tools -p 'test_*.py'
npm run docs:partner
node scripts/build-partner-handoff.mjs
```

API 页面直接读取 `PARTNER_API.md`、`docs/partner-openapi.json` 和 `docs/examples/`；`public/partner-api/` 是对外发布产物。这些文件和测试素材仍有实际用途。

发布源码包，在项目根目录运行：

```powershell
.\symphony-pool-workbench\.venv\Scripts\python.exe .\tools\build-release.py
```

输出为 `release/` 下的 ZIP 与校验文件。打包排除账号、视频、数据库、浏览器档案、真实密钥、虚拟环境、缓存和历史发布目录。`release/` 只保留当前交付与当前维护记录；过期源码副本、临时工具和旧交接说明无需留在工作目录。
