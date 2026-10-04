# Symphony Pool Workbench · V1.3.0

支持 Windows 本机与 Ubuntu 24.04 LTS 部署的视频生成工作台，使用独立浏览器档案管理 Symphony / TikTok 和豆包账号。支持文字或图片生成视频、账号池调度，以及供合作方调用的任务 API。

## 本机 Docker 局域网测试

Windows Docker Desktop 使用 Linux 容器模式。在项目根目录打开 PowerShell：

```powershell
.\tools\start-docker-test.ps1
```

脚本创建独立的容器、数据卷、测试密钥和 HTTPS 证书。测试 API 默认使用电脑局域网 IP 的 9443 端口；容器管理页为 `http://127.0.0.1:8788/accounts`。安装 Windows Xpra 客户端后，从账号卡片打开独立 Chrome 登录窗口。对方使用脚本生成的 `.docker-local/partner-test/` 接入文件夹。

账号需要在容器里重新登录。Windows 防火墙放行步骤、证书使用和停止命令见 [Docker 局域网测试说明](symphony-pool-workbench/docs/DOCKER.md)。

## Ubuntu 24.04 LTS 服务器

完整步骤见 [Ubuntu 部署说明](symphony-pool-workbench/docs/UBUNTU.md)。使用有 sudo 权限的普通用户，从 GitHub 获取源码并安装：

```bash
git clone https://github.com/wqdcjnb/SymphonyPoolWorkbench.git
cd SymphonyPoolWorkbench/symphony-pool-workbench
bash deploy/ubuntu/install.sh
```

安装器自动识别 x86_64 / ARM64，准备 Node.js、Python、浏览器及虚拟桌面。随后按说明设置远程桌面密码并启动服务；首次登录账号通过 SSH 隧道连接远程桌面完成。服务器上实际登录和视频生成仍需部署时验收。

## Windows 安装与启动

需要 **Node.js 24、Python 3.13、Chrome 或 Edge**。交付包不包含运行环境和浏览器登录态。请先解压整个压缩包，再在解压目录打开 PowerShell：

```powershell
cd symphony-pool-workbench
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\start-workbench.ps1
```

若 `python` 指向 Windows Store 占位程序，改用已安装的 Python 完整路径。若 PowerShell 阻止运行脚本，可在当前窗口执行 `Set-ExecutionPolicy -Scope Process Bypass` 后重试。无需 `npm install`，也无需额外下载 Playwright 浏览器。

- 工作台：<http://127.0.0.1:8787/jobs>
- 账号池：<http://127.0.0.1:8787/accounts>
- API 文档：<http://127.0.0.1:8787/api-docs>
- 停止服务：在同一目录运行 `.\stop-workbench.ps1`。

首次启动会建立新数据库和一个未登录的初始账号记录。按“新增账号 → 打开登录窗口 → 手动登录 → 关闭专用窗口 → 只读验收”的顺序接入自己的账号，再开始生成。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [工作台使用说明](symphony-pool-workbench/README.md) | 账号、生成参数、调度规则、数据位置和故障处理 |
| [合作方 API 文档](symphony-pool-workbench/PARTNER_API.md) | 鉴权、创建、查询、取消、回调、下载及错误码 |
| [本机程序调用说明](symphony-pool-workbench/VIDEO_API.md) | 本机上传素材和开始生成 |
| [开发与维护](symphony-pool-workbench/docs/DEVELOPMENT.md) | 代码结构、队列实现、测试和发布打包 |
| [Ubuntu 部署](symphony-pool-workbench/docs/UBUNTU.md) | 自动识别架构、远程登录账号、后台服务与 HTTPS 接入 |
| [Docker 局域网测试](symphony-pool-workbench/docs/DOCKER.md) | 独立数据、局域网 API、测试 Key、证书和账号登录 |
| [版本说明](symphony-pool-workbench/CHANGELOG.md) | V1 功能与使用限制 |

## 对外 API 配置

复制 `symphony-pool-workbench/.env.example` 为同目录的 `.env`，在本机填写独立随机密钥。API Key 或下载签名密钥为空时，对外 `/v1` 接口返回 503，本机工作台仍可使用。

对外服务名称为 `symphony`。公网地址在服务器部署时设置为 `https://实际域名/v1`，例如 `https://symphony.example.com/v1`（仅示例，需替换）。将实际地址填入 `PARTNER_PUBLIC_BASE_URL`，视频下载链接也使用该地址。

公网域名及 HTTPS 回调地址另行配置；本机 `127.0.0.1` 地址不能直接发给合作方访问。具体设置见合作方 API 文档。密钥只在部署机器配置。

## 干净交付

按[开发与维护中的打包步骤](symphony-pool-workbench/docs/DEVELOPMENT.md#发布干净版本)生成 `release/SymphonyPoolWorkbench-v1.3.0.zip`，旁边的 `.zip.sha256` 文件用于校验压缩包。只需把这两个文件交给使用者。GitHub 仓库存放源码，`release/` 是本机生成目录，不提交到 Git。

交付包包含源码、启动脚本、依赖清单、文档和测试；不包含账号档案、任务数据库、图片、视频、日志、备份、Git 历史、虚拟环境或实际密钥。接收方解压后自行安装依赖、登录账号和配置 API。

本机已有数据继续存放在原安装目录，不会因打包而搬走。详见[数据位置](symphony-pool-workbench/README.md#数据位置)。
