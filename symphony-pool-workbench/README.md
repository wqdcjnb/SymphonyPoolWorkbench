# Symphony 号池工作台

独立、本机优先的 Symphony 与豆包账号控制面。Symphony 支持账号档案、只读验收、积分状态和任务草稿；豆包支持独立账号档案和网页版登录状态验收。工作台不会自动上传素材或提交生成。

## 启动

需要 Node.js 24。只读验收还需要 Python、Chrome 或 Edge，并在项目目录安装 Python Playwright：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

若 `python` 指向 Windows Store 占位程序，请把第一行的 `python` 换成本机已安装的 `python.exe` 完整路径。

已安装的 Chrome 或 Edge 会被直接使用，不需要下载 Playwright 浏览器。

```powershell
.\start-workbench.ps1
```

默认地址：`http://127.0.0.1:8787`

## 接入豆包账号

1. 在“账号池”点击“新增账号”，选择“豆包网页版”，填写唯一账号编号和显示名称。
2. 点击该账号的“打开登录窗口”。工作台会用独立 Chrome 档案打开 [豆包网页版](https://www.doubao.com/chat/)；由你在这个窗口手动完成登录。
3. 登录成功后关闭这个专用浏览器窗口，再点击“只读验收”。验收脚本使用同一档案查看豆包页面是否仍要求登录，并将状态和验收时间写入 SQLite。

若专用窗口还开着，浏览器会锁定档案，验收会提示先关闭窗口。豆包目前只验收登录状态，不读取积分或模型，也不能作为 Symphony 任务草稿的目标账号。账号密码、Cookie 和页面正文不会写入 SQLite 或 Git。

停止：

```powershell
.\stop-workbench.ps1
```

## 安全边界

- 服务只监听 `127.0.0.1`。
- 登录态只保存在工作区上级目录的独立 `*_sandbox_data` 浏览器档案。
- SQLite 不存密码、Cookie、验证码或页面正文。
- 只读验收使用可见持久化 Chrome 或 Edge；TikTok 当前拒绝该档案的 headless 导航。
- 任务只保存为 `draft`，自动生成执行层尚未启用。

## 数据

- SQLite：`data/workbench.sqlite`
- 日志：`logs/workbench.stdout.log`、`logs/workbench.stderr.log`
- 一号档案：`../xzkj-pc-01-symphony-01_sandbox_data`
