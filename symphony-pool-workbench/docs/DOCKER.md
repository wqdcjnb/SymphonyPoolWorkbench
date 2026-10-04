# 本机 Docker 局域网测试

适用于 Windows 上的 Docker Desktop（Linux / amd64 容器）。项目在自己的电脑上运行，合作方在同一局域网调用 API。这套配置与原生 Windows 工作台使用不同端口和数据。

## 1. 启动

在项目根目录的 PowerShell 执行：

```powershell
.\tools\start-docker-test.ps1
```

脚本自动选择带默认网关的 IPv4 网卡。多网卡时显式指定自己的局域网地址：

```powershell
.\tools\start-docker-test.ps1 -LanIp '192.168.1.100'
```

地址仅为示例，必须属于当前电脑。首次启动会下载依赖并构建镜像；后续修改代码后再次运行会复用构建缓存。只启动已构建镜像可加 `-SkipBuild`。并发默认 2，可用 `-Concurrency 4` 调整到 1–8，实际执行还受可用账号限制。

| 入口 | 默认地址 | 使用者 |
| --- | --- | --- |
| 合作方 API | `https://电脑局域网IP:9443/v1` | 同一局域网的测试方，使用测试 Key |
| 合作方文档 | `https://电脑局域网IP:9443/api-docs` | 测试方，文档中的地址已替换为本次测试地址 |
| 容器工作台 | `http://127.0.0.1:8788/accounts` | 自己的电脑 |
| 账号登录界面 | 从账号卡片的“打开登录窗口”进入，使用本机 6081 端口 | 自己的电脑 |

可用 `-ApiPort`、`-AdminPort`、`-DesktopPort` 改端口。API 只绑定选定局域网 IP；管理页与远程桌面只绑定宿主机回环地址。

Windows 先安装 [Xpra 原生客户端](https://github.com/Xpra-org/xpra/wiki/Download#Microsoft-Windows)，再运行下方的客户端配置脚本。Chrome 运行在容器内，Xpra 将它显示为 Windows 上的独立窗口；输入、剪贴板和窗口缩放由原生客户端处理。

已验证客户端版本为 6.5.4。Windows 用户名包含中文时，建议安装到英文目录（例如 `D:\Applications\Xpra`）。登录连接关闭启动进度窗和 OpenGL 探测；本机启动器指定 OpenH264 解码，关闭登录用不到的音频、麦克风、摄像头、打印及文件传输，减少启动时的组件加载。键盘和双向剪贴板保持启用。下载的连接文件采用相同设置。

在项目根目录运行客户端配置脚本；Windows 用户名包含中文时，它还会修复 `cx_Freeze` / `FileNotFoundError` 的乱码日志路径错误：

```powershell
.\tools\configure-xpra-client.ps1 -LogDirectory 'D:\Applications\Xpra\workbench-state\logs'
```

该脚本为当前用户设置 Xpra 官方支持的 `XPRA_LOG_FILENAME`，并从项目源码编译启动器。工作台使用 Xpra 原生 `xpra+ws` / `xpra+wss` 链接；启动器每次调用官方客户端前设置英文日志路径及日志目录下的 `pycache` 缓存路径，并保留普通 WebSocket 连接地址。音频及解码器等参数由启动器直接传给客户端，因为 Xpra 不接受 URL 中的这些选项。

脚本注册协议后通知 Windows 刷新，再核对当前进程解析到的启动命令。若点击入口无反应，或仍然出现原来的乱码日志路径报错，请在 Windows 资源管理器中双击脚本输出的 `register-workbench-xpra.reg`，确认导入后刷新登录页重试。示例文件位于 `D:\Applications\Xpra\workbench-state\logs\register-workbench-xpra.reg`。它只注册本机启动器路径，不包含账号连接凭据；当前进程能查到关联，并不保证桌面中的浏览器已使用它。

旧版工作台的专属链接仍兼容。使用 Windows 内置 .NET Framework 编译器，无需更改 PowerShell 执行策略。原设置保存在指定目录的 `previous-log-setting.json` 和 `previous-protocol-handlers.json`。目录可以换成你有写入权限的其他英文绝对路径。刷新账号登录页后再连接；Xpra 窗口已结束时，旧连接文件也会失效，需要从账号卡片重新进入。项目路径改变后重新运行该脚本，更新协议入口路径。若自动检测不到安装位置，增加 `-XpraExecutable 'X:\实际目录\Xpra.exe'`。

原理见 [Xpra Windows 启动代码](https://github.com/Xpra-org/xpra/blob/v6.5.4/xpra/platform/win32/__init__.py)。服务器无需因这个客户端问题重装。

## 2. 放行 Windows 防火墙

从项目根目录以管理员身份运行：

```powershell
.\tools\allow-docker-lan.ps1
```

脚本读取本次测试配置，只允许所选网卡同一子网访问 Docker Desktop 的测试 API TCP 端口，不关闭防火墙或修改网络分类。

如果 Windows 已创建“阻止 Docker 所有 TCP 入站”的规则，该规则优先于放行规则。脚本会先把原端口设置记录到 `.docker-local/firewall-backup.json`，保留其对其他端口的阻止，再单独允许测试端口。结果记录在 `.docker-local/firewall-result.json`。公司策略仍可能限制入站流量，需要网络管理员处理。

本机能访问局域网地址不等于另一台电脑已能连接。放行后让对方从其电脑调用 `/v1/models` 验证；连接超时应检查防火墙、访客 Wi-Fi 隔离和网段可达性。

## 3. 登录测试账号

1. 打开本机容器工作台，在账号池新增相应平台的账号。
2. 点击对应账号的“打开登录窗口”，等待账号窗口准备好，再点击首位的“直接打开 Xpra”；浏览器询问是否打开应用时选择打开。每次点击都会取得本账号的当前连接：窗口仍在时复用，已关闭时重新创建。可以在原登录页直接再次打开；若准备时间较长，页面会明确提示再点一次。
3. “下载连接文件”作为备用入口，下载后双击 `.xpra` 文件连接。若直接入口无反应，按前面的说明导入本机协议注册文件；启动器自身启动失败会显示错误提示。连接入口仅允许本机访问。
4. 在独立 Chrome 窗口完成登录，回到登录页点击“登录完成，结束窗口”，然后到账号池点击“只读验收”。

每个账号使用独立浏览器档案和 Xpra 会话。连接文件包含本次会话的访问凭据，应留在本机；结束窗口后自动失效，下次从账号卡片重新打开。关闭登录页或仅断开 Xpra 连接会保留服务器浏览器，仍然占用该账号。Windows 剪贴板属于本机共享资源，多个客户端同时连接时请确认当前正在操作的账号。

API 任务收到后自动进入调度。若账号登录窗口仍开着，任务等待档案释放；结束登录窗口后，队列默认每 2 秒重新调度。账号未登录或未通过验收时，需要先完成登录和验收。Xpra 改善远程操作通道，平台主动使登录失效时仍须重新登录与核对任务。

测试两条同时生成，需要两个支持同一模型且有额度的账号。Windows 原有浏览器档案与任务数据库不会挂载进容器；容器内重新登录同一个平台账号仍会消耗该平台账号原有额度。

## 4. 交给对方的文件

启动成功后，把 `.docker-local/partner-test/` 文件夹通过双方确认的渠道交给对方。该目录包含：

- `README.md`：实际 API 地址、鉴权、HTTPS、创建和查询示例。
- `connection.json`：本次连接地址及证书、Key 文件名。
- `root-ca.crt`：本次 HTTPS 的公开根证书；对方可为测试请求指定该证书，或导入自己的信任库。
- `api-key.txt`：测试 API Key。
- `task.json`：请求两条视频的 JSON 示例。

只交付这个子目录。其他本机文件包含下载签名密钥等服务端配置。所有 `.docker-local/` 内容均排除在 Git、Docker 构建上下文和干净发布包之外。

本次先使用查询流程：`callback_url` 保持空字符串。现有回调实现拒绝私有 IP 地址；若需要测试对方本地 Webhook，需另外配置受限的测试接入方式，不能直接填写局域网回调地址。

## 5. 停止、日志与数据

若 `docker compose` 命令未被当前终端识别，可使用启动脚本自动查找的 Docker Desktop Compose 可执行文件。以下示例适用于当前用户目录安装的 Docker Desktop：

```powershell
$compose = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\cli-plugins\docker-compose.exe"
$options = @('--env-file', '.docker-local/config.env', '-f', 'symphony-pool-workbench/deploy/docker/compose.yml')
& $compose @options ps
& $compose @options logs --tail 100
& $compose @options stop
& $compose @options up -d
```

项目名称固定为 `symphony-local-test`，不会操作其他项目的容器。数据卷分别保存数据库与结果、浏览器档案、公开文档和 HTTPS 证书。停止或重建容器会保留数据；不要使用 `down -v`，否则会删除测试数据和证书。

容器内程序继续监听回环地址，由共享网络命名空间的 Caddy 提供局域网 API 与仅本机的管理代理。上游 Host 和管理页 Origin 会经过限定校验后转换。镜像使用非 root 用户，浏览器运行在 Xvfb 虚拟桌面中。

账号档案存放在 `/profiles`，由 `WORKBENCH_PROFILE_ROOT` 指定；数据库与素材位于工作台 `data/` 挂载卷。默认资源上限为 4 CPU、8 GiB 内存、1 GiB 共享内存；这只是初始配置，真实容量需按平台页面与账号数量测量。

电脑需要保持开机、联网，Docker Desktop 需要运行。局域网 IP 变化后重新运行启动脚本并重新交付接入文件。保留 HTTPS 证书卷可保持根证书不变。

参考：[Docker 端口发布](https://docs.docker.com/engine/network/port-publishing/)、[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)、[Playwright Docker](https://playwright.dev/python/docs/docker)、[Caddy 本地证书](https://caddyserver.com/docs/caddyfile/directives/tls)。
