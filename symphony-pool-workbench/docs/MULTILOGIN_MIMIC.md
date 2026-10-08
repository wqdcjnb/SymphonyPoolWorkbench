# Multilogin Mimic 云端接入

状态（2026-10-05）：代码和可选 Docker 镜像已准备；用户确认固定代理已备好，Multilogin 尚未安装或登录。隔离容器里用模拟 Mimic 进程验证了账号专属 Xpra 路由；**目前没有把 Mimic 部署到正式云端，也没有用真实 Multilogin 档案和代理做联调。**现有 Dola 账号及其 Chrome 档案保持原样。

## 运行方式

- 云端新账号写入 `browser_provider=multilogin`；旧账号未设置该字段，继续使用原 Chrome 档案。每个新账号绑定不同的 Multilogin Folder ID / Profile ID。首次领取登录或任务租约后，档案和出口绑定锁定。
- 一个出口组最多 10 个账号。组代理与预期公网 IP 存在工作台；每个 Mimic 档案也必须在 Multilogin 中设置**同一组的自定义固定代理**。本版不自动修改厂商档案代理。
- 开始登录/任务前检测工作台代理出口。Mimic 在该账号独立的 Xvfb + Xpra 桌面内启动，返回的 CDP 端口交给 Playwright。窗口启动时同时检测 Mimic 浏览器出口与视频下载出口；窗口运行期间每 10 秒复查。IP 不符或代理断开即停止该档案并标记出口组失败；任务不改用直连或其他代理。
- 同一执行容器内的 Mimic Agent **一次只服务一个账号**，以免不同账号的窗口落入同一 Xpra 桌面。其他账号保持排队。需要多个 Mimic 同时运行时，先实测并部署相互隔离的执行节点，不能直接提高当前容器的并发数。
- Multilogin 档案数据目录单独挂载在 `/data/symphony/v2/multilogin`。建议创建云存储档案；本地档案也必须备份此目录。工作台原有 `/profiles` 不保存 Mimic 的实际浏览器数据。

## 启用前准备

1. 在 Multilogin 中开通可用的 API 权限，建立一个**新的测试 Mimic 档案**，选择 Linux、云存储，并设置与测试出口组相同的自定义代理。记下 Folder ID 和 Profile ID。不要复用现有工作台账号。
2. 在 Multilogin 生成自动化 Token，**只在云服务器本地**保存到 `/data/symphony/v2/secrets/multilogin-token`，文件所有者为 UID 10001，权限 0600；不要发到聊天、写入 Git 或放进 Compose 环境变量。厂商文档：[获取自动化 Token](https://multilogin.com/help/automation-token)。
3. 在云服务器创建 `/data/symphony/v2/multilogin`，所有者 UID 10001，权限 0700。该目录要纳入档案备份。
4. 从[厂商 Linux Agent 指南](https://multilogin.com/help/en_US/agent/how-to-connect-the-agent-in-multilogin)的官方地址取得 `multiloginx-amd64.deb`，核对其 SHA-256，把校验值作为 `MULTILOGIN_AGENT_SHA256` 写在云端私有 `/data/symphony/v2.env`。可选 Dockerfile 会重新下载并验证；版本变更导致哈希不符时构建会停止。
5. 先构建基础工作台镜像，再用 `deploy/cloud/compose.multilogin.yml` 覆盖文件构建可选 Mimic 镜像。发布前确认现有任务和登录窗口已结束，备份数据库及档案；发布后先用**新的测试账号**验收。默认 `compose.v2.yml` 不安装厂商 Agent。

## 单账号验收

1. 在账号池新建一个固定代理组，容量不超过 10，输入代理及预期公网 IP，并点“检测”。不提供密钥给聊天。
2. 新建一个测试账号并选择该组。填入独立的 Multilogin Folder ID / Profile ID，或创建后在“管理登录资料”中绑定。没有 ID 时，系统拒绝登录和派单。
3. 打开账号的 Xpra 登录窗口，确认看到该测试 Mimic 档案。窗口启动时的浏览器出口与下载出口必须都等于组预期 IP。登录后完成平台验收，再试一条低成本任务和视频下载。
4. 在测试账号空闲时模拟代理断开和出口 IP 不符，检查任务排队、组状态变为失败/不符、没有直连请求。恢复原 IP 后手动重新检测，才恢复使用。
5. 关闭并重新打开测试账号窗口，确认 Cookie 和登录态保留；再验证容器重启后的档案持久性。通过后逐组扩容，不以账号数 100 作为固定配置值。

## 当前边界

厂商账号、自动化 Token、一个可启动的 Mimic 档案和真实固定代理尚未配置到云端，因此尚不能声称实际 Xpra/Mimic 联调通过。一个固定 IP 供 10 个账号使用只减少单 IP 集中登录，平台仍可能根据登录资料、设备信号、行为或账号关系关联它们。
