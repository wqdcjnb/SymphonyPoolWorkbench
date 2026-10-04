# 开发与维护

## 环境与结构

Node.js 24，原生 HTTP 服务和 SQLite；前端使用 HTML、CSS 与 JavaScript 模块，没有构建步骤或 npm 运行时依赖。Windows 使用 Python 3.13，Ubuntu 24.04 使用系统 Python 3.12；执行器使用固定版本的 Playwright。浏览器可显式设置为 Chrome、Edge 或 Playwright Chromium。

| 路径 | 职责 |
| --- | --- |
| `server.mjs` | 本地服务、业务 API、执行器与调度组装 |
| `lib/db.mjs` | SQLite、账号、任务及派号事务 |
| `lib/job-routing.mjs` | 平台、模型、参数兼容规则 |
| `lib/browser-runtime.mjs`、`../tools/browser_runtime.py` | 系统路径、登录启动命令与浏览器通道 |
| `lib/queue-scheduler.mjs` | 队列唤醒、领取与并发控制 |
| `lib/partner-*.mjs` | 合作方协议、任务持久化、下载与回调 |
| `lib/video-api-*.mjs`、`lib/nocsnow-api.mjs` | 可选上游视频服务接入 |
| `lib/pages.mjs`、`views/`、`public/` | 工作台页面、路由和静态资源 |
| `lib/api-docs.mjs`、`PARTNER_API.md` | 在线 API 文档渲染与内容 |
| `scripts/build-partner-openapi.mjs` | API 规范及请求样例生成 |
| `tests/`、`../tools/test_*.py` | 自动测试 |
| `../tools/` | 浏览器登录、账号验收、生成执行及发布工具 |
| `deploy/ubuntu/` | Ubuntu 安装器、桌面进程管理、用户服务及 HTTPS 代理示例 |
| `deploy/docker/` | Docker 镜像、Compose、局域网 HTTPS 代理和接入文档生成 |

## 账号池与自动队列

- 每 10 秒兜底扫描；入队、验收结束及任务完成时立即唤醒。无排队任务时不领取数据库写锁。优先级相同时按入队顺序处理，不兼容的等待任务不会阻塞后续可执行任务。
- SQLite 事务中检查并分配账号。同一账号只执行一个任务；自动队列默认全局并行上限 2，可通过进程环境变量 `WORKBENCH_MAX_CONCURRENT_JOBS` 设置为 1–8。
- 根据最近 24 小时的验收记录过滤：账号须就绪、上次使用后已重新验收、模型与参数兼容、当前空闲。每次任务提交前无需再打开浏览器预检。
- 同平台优先选记录额度较高的账号，再按最近使用情况排序。豆包估算额度只用于排序，TikTok 积分用于检查可用额度。
- 平台明确返回额度耗尽时，账号冷却、额度归零，自动派号任务可安全换号。提交前的浏览器故障会暂停该账号，等待重新验收；不能据此把额度归零。指定账号的任务不会自动切换账号。
- 已发出提交、结果不明时进入 `reconciling`，不在其他账号重复提交。只有能确认未开始生成的额度失败可在提交后换号。
- 自动队列任务结束后重新只读验收该账号。验收失败会暂停该账号派号，其他账号继续执行。
- 重启后继续处理排队任务。已领取但中断的任务按是否可能提交过处理为失败或需核对；不盲目重新生成。取消会阻止待执行部分继续生成或换号，已提交到平台的生成未必能停止。

### 接口分工

合作方使用 `/v1`，完整约定见 [PARTNER_API.md](../PARTNER_API.md)。`count` 是总条数，每批最多两条，回调失败只重试通知。

本机页面与本机程序使用 `/api`。`POST /api/jobs` 可保存兼容草稿，`enqueue: true` 可入队；已有草稿可 `POST /api/jobs/{id}/queue`。一步创建并开始见 [VIDEO_API.md](../VIDEO_API.md)。

`/api/video-provider` 是可选的外部视频服务连接器，见 [NOCSNOW_API.md](../NOCSNOW_API.md)；其上游 Key 与本项目提供给合作方的 Key 分别配置。

## 测试与文档生成

在 `symphony-pool-workbench` 目录执行：

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s ..\tools -p 'test_*.py'
npm run docs:partner
```

Node 测试覆盖路由、账号筛选、队列、任务 API、签名下载与回调等行为，使用临时数据库和模拟执行器，不向平台发起真实视频生成。Python 测试覆盖账号额度页面的文字解析。

Ubuntu 安装后将首条命令改为 `.runtime/node/bin/npm test`，Python 命令改为 `.venv/bin/python -B -m unittest discover -s ../tools -p 'test_*.py'`；可先将 `.runtime/node/bin` 加入当前终端 `PATH`。新增的跨平台测试检查 Linux 登录启动和 Windows 参数兼容；浏览器实际运行需要虚拟桌面。

接口约定变更时同步维护 `PARTNER_API.md`、协议及规范生成脚本，并重新生成 `docs/partner-openapi.json`、`docs/examples/partner-task.json`。保留 `PARTNER_API.md` 路径，在线文档读取此文件。

## 发布干净版本

在项目根目录执行：

```powershell
.\symphony-pool-workbench\.venv\Scripts\python.exe .\tools\build-release.py
```

发布版本取自 `symphony-pool-workbench/package.json`。脚本按源码白名单打包到根目录 `release/`，生成 ZIP 和同名 `.zip.sha256`；ZIP 内的 `SHA256SUMS.txt` 用于逐文件校验。

Ubuntu 打包使用 `./symphony-pool-workbench/.venv/bin/python ./tools/build-release.py`。Shell 脚本在发布包中使用 LF 换行及可执行权限；新增部署文件或工具时同步更新打包白名单。

允许打包的内容为源码、页面资源、测试、文档、启动脚本、依赖清单以及空密钥的 `.env.example`。脚本排除私有数据目录，拒绝打包符号链接或目录联接；不会把数据库、浏览器档案、上传图片、生成视频、日志、真实 `.env`、虚拟环境、Git 历史或备份装入发布包。

发布前运行测试，检查解压后可从空数据启动。接收方按根目录 README 重新安装运行环境、登录账号及配置密钥。虚拟环境不可直接复制到另一台机器使用。

## 本机维护

启动与停止脚本分别是 `start-workbench.ps1`、`stop-workbench.ps1`。停止前先确认没有正在执行的生成，避免进入需核对状态。不要依据文件为空就删除浏览器档案内文件或运行中的日志。

当前数据与配置的位置见[工作台说明](../README.md#数据位置)。发布打包不会修改这些数据。网页自动化需有可交互的桌面会话；验收使用可见浏览器，平台页面改版后需要真实账号单独验证。
