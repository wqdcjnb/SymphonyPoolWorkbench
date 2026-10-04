# Ubuntu 24.04 LTS 部署

适用于 Ubuntu 24.04.x LTS，包括 24.04.3。安装脚本自动检测 CPU，无需手动判断型号：x86_64 安装 Chrome，ARM64 安装 Playwright Chromium。ARM64 的实际平台登录、视频预览和下载能力需要单独验收。

程序用 Xvfb 提供虚拟显示器，Chrome 以有界面模式运行。Windows 安装 Xpra 原生客户端后，可以在独立窗口中操作服务器浏览器；服务由 systemd 管理。

## 1. 准备部署用户与源码

使用一个有 sudo 权限的普通用户，浏览器和工作台均以这个用户运行。若目前只有 root 用户，可先执行：

```bash
adduser symphony
usermod -aG sudo symphony
```

随后用新用户重新登录 SSH，建立正常的用户会话。从 GitHub 获取源码：

```bash
sudo apt-get update
sudo apt-get install -y git
cd ~
git clone https://github.com/wqdcjnb/SymphonyPoolWorkbench.git
```

也可以将干净的 V1.3.0 ZIP 上传并解压到该用户拥有的目录；后续命令中的项目路径替换为实际解压目录。

Windows 的 `.venv`、账号浏览器档案和数据库含有机器相关路径；本次服务器部署使用干净包，在服务器重新登录账号。

## 2. 自动安装

进入源码中的工作台目录：

```bash
cd ~/SymphonyPoolWorkbench/symphony-pool-workbench
bash deploy/ubuntu/install.sh --check
bash deploy/ubuntu/install.sh
```

`--check` 只显示系统、架构与浏览器选择。正式安装需要 sudo 和联网能力，将执行：

- 安装 Ubuntu 的 Python 3.12、虚拟环境、Xvfb、Openbox、字体以及官方 Xpra 6.5.4 服务端和编码器。
- 下载固定版本 Node.js 24.21.0，校验官方 SHA-256 后放入 `.runtime/`。
- 在 `.venv/` 安装 `requirements.txt` 中的固定版本依赖。
- x86_64 使用系统 Chrome；尚未安装时通过 Playwright 安装。ARM64 安装当前用户的 Playwright Chromium。
- 创建本机 `.env`、显示认证文件和 `~/.config/systemd/user/symphony-workbench.service`。

安装器保留已填写的 `.env` 参数，不自动填写 API 密钥。如果现有 `WORKBENCH_BROWSER_CHANNEL` 与自动选择不同，请确认对应浏览器也已安装。可以重复运行安装器修复依赖。

## 3. 启动服务

仍在工作台目录执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now symphony-workbench.service
sudo loginctl enable-linger "$(id -un)"
```

最后一条使该用户的服务在退出 SSH 后及开机时继续运行。显示认证文件、会话凭据及 `.env` 都排除在 Git 和交付包之外。Xpra 连接通过 SSH 隧道和每次登录生成的独立会话凭据访问。

检查服务：

```bash
systemctl --user status symphony-workbench --no-pager
curl --fail http://127.0.0.1:8787/api/health
```

健康检查应返回 `ok: true`。整套服务包含虚拟桌面、窗口管理器、远程桌面与 Node 工作台；其中一个主要进程退出时，systemd 会重新启动整套服务。

## 4. 在自己电脑上打开工作台和远程桌面

在自己的电脑终端建立 SSH 隧道，把示例用户名和服务器地址换成实际值：

```bash
ssh -N -L 8787:127.0.0.1:8787 -L 6080:127.0.0.1:6080 symphony@服务器地址
```

保持此 SSH 窗口打开，然后访问：

- 工作台：<http://127.0.0.1:8787/accounts>
- 账号登录界面：Windows 先安装 [Xpra 原生客户端](https://github.com/Xpra-org/xpra/wiki/Download#Microsoft-Windows)，点击账号卡片的“打开登录窗口”，再点击“打开 Xpra”。连接通过本机 6080 端口的 SSH 隧道。

如果自己电脑已有本地工作台占用 8787，先停止本地服务再建隧道；或者将服务器 `.env` 的 `WORKBENCH_PORT` 改为另一空闲端口，重启服务并把隧道两端及访问地址一起改为该端口。仅修改隧道本地端口会触发工作台的 Host 校验。

账号登录顺序：

1. 在“账号池”新增账号，点击“打开登录窗口”。
2. 点击“打开 Xpra”，在独立 Chrome 窗口中完成登录；若客户端未启动，下载连接文件并双击打开。重复打开同一账号会复用它的会话。
3. 在登录页点击“登录完成，结束窗口”，返回工作台点击“只读验收”。
4. 账号就绪后开始视频任务。以后登录失效时再通过远程桌面处理。

输入和复制粘贴由 Xpra 原生客户端处理。每个账号有独立档案和虚拟显示器，Windows 剪贴板仍是本机共享资源。连接文件含临时访问凭据，不要分享。

Windows 中文用户名导致 `cx_Freeze` / `Xpra.log` 路径报错时，在 Windows 电脑运行 `tools/configure-xpra-client.ps1` 设置英文日志目录，操作见 [Windows 客户端说明](DOCKER.md#1-启动)。

登录后点击登录页的“登录完成，结束窗口”，等待浏览器正常关闭、保存档案，再进行验收和生成。仅关闭网页或断开 Xpra 不会释放档案。结束窗口后旧连接失效；下次从账号卡片重新打开。管理页面与 6080 网关只供本机或 SSH 隧道访问；内部临时端口无需转发。

## 5. 配置合作方 API 和公网域名

服务名使用 `symphony`。部署时在自己的域名下配置实际地址，例如 `https://symphony.example.com/v1`（仅格式示例）。域名须解析到服务器并配置 HTTPS，再将完整地址提供给合作方。

在服务器编辑 `.env`，设置 `PARTNER_API_KEY`、`PARTNER_DOWNLOAD_SECRET`、`PARTNER_PUBLIC_BASE_URL`，需要回调时再配置回调地址和签名密钥。完整字段见 [合作方 API 文档](../PARTNER_API.md)。

公网 API 通过同机 Nginx 等 HTTPS 代理转发到 `127.0.0.1:8787`。配置片段见 [nginx-api.conf.example](../deploy/ubuntu/nginx-api.conf.example)，需要放入已配置真实域名及证书的 HTTPS server 块。

- 公网转发 `/v1/`，上传上限至少 101 MiB。
- 上游 `Host` 必须设为 `127.0.0.1:8787`，并保留 `/v1/` 路径。
- 如果改过工作台端口，同时修改代理目标及 Host。
- `.env` 中的公开地址填写 `https://实际域名/v1`，下载链接由此生成。

修改配置后重启工作台。公网域名未确定时，可先完成本机健康检查、账号登录和浏览器验收。

## 6. 日常维护

```bash
# 查看最近日志
journalctl --user -u symphony-workbench -n 100 --no-pager

# 停止 / 启动 / 重启
systemctl --user stop symphony-workbench
systemctl --user start symphony-workbench
systemctl --user restart symphony-workbench
```

重启前确认没有正在生成或验收的任务。重启时浏览器也会关闭；提交结果不明确的任务需要核对已有平台记录。

账号档案在项目根目录的 `*_sandbox_data/`，数据库、素材与视频位于工作台的 `data/`。保持部署目录固定；改目录需重新生成服务文件，并处理数据库中已有的绝对路径。

常见问题：

| 现象 | 检查项 |
| --- | --- |
| `systemctl --user` 连不上用户总线 | 用部署用户重新登录 SSH；避免只用 `su` 切换用户 |
| 缺少桌面认证文件 | 重新执行安装器生成 Xauthority |
| `DISPLAY_NOT_CONFIGURED` | 通过提供的用户服务启动，使浏览器继承虚拟显示配置 |
| 显示器或端口占用 | 后台使用显示器 `:99`、6080 和默认 API 端口 8787；账号登录按需分配 `:100` 起的空闲显示器及内部回环端口 |
| `PROFILE_DESKTOP_FAILED` | 检查 Xvfb、Xpra 是否已安装，查看 `data/login-desktops/*.xpra.log`；确认服务用户能写入该目录 |
| 浏览器启动失败 | 查看日志，检查浏览器安装、内存以及 `.env` 中的浏览器通道 |
| 账号验收提示档案占用 | 在登录页点击“登录完成，结束窗口”，再验收 |
| 服务器打不开平台 | 检查服务器网络可达性及平台返回的登录或验证提示 |

## 7. 上线验收

自动测试覆盖 API、调度、路径和启动逻辑；真实平台登录与生成仍需在这台服务器实测。部署完成后至少验证：

1. 登录一个实际账号，关闭登录窗口后成功只读验收。
2. 用一条测试任务完成生成、保存和下载，核对 MP4 可以播放。
3. 关闭 SSH 隧道后任务仍继续；重新连接可看到结果。
4. 公网 `/v1` 鉴权、批次结果、下载链接和回调联调通过。

参考：[Playwright 有界面运行](https://playwright.dev/python/docs/ci#running-headed)、[浏览器选择与媒体编码支持](https://playwright.dev/python/docs/browsers#media-codecs)。
