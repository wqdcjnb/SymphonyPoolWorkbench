# Symphony 号池工作台

独立、本机优先的 Symphony 与豆包账号控制面。Symphony 支持账号档案、只读验收、积分状态和任务草稿；豆包支持独立账号档案，以及免费网页版的视频入口、模型和创作记录只读验收。工作台不会自动上传素材或提交生成。

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
3. 登录成功后关闭这个专用浏览器窗口，再点击“只读验收”。验收脚本使用同一档案检查登录、视频生成入口和“我的创作”页面，读取无需升级的模型，并统计北京时间当天可见的视频作品数量。

若专用窗口还开着，浏览器会锁定档案，验收会提示先关闭窗口。工作台将今日视频数、统计日期、次日零点重置时间、页面就绪状态和当前账号页面可用的视频模型写入 SQLite；模型只记录网页菜单中实际出现且未标“升级”的选项。当前接入聚焦免费版的 Seedance 2.0 Mini 和 2.0 Fast。今日视频数来自“我的创作”作品卡片。豆包账号不能作为 Symphony 任务草稿的目标账号。账号密码、Cookie、作品图片和页面正文不会写入 SQLite 或 Git。

工作台按当前免费网页版规则配置每日 10 额度，北京时间 0 点重置；5 秒视频消耗 1 额度，10 秒视频消耗 2 额度。验收器只读打开当天已完成视频的预览，读取播放时长后推算已用额度及剩余额度，并用 `creditsEstimated` 标记估算值。作品时长无法读取、不是 5 秒或 10 秒，或创作记录未完整加载时，剩余额度保持空值；失败、进行中或其他未展示的消耗也可能使估算值与平台实际剩余额度不同。这个规则不是豆包网页实时返回的额度数字。若网页未显示当前页面的参考图上限，该字段同样保持空值。

[Seedance 2.0 官方说明](https://seed.bytedance.com/zh/blog/official-launch-of-seedance-2-0)中的全模态参考任务最多可输入 9 张图片。这是模型规格，工作台单独展示，不把它写成当前账号所有免费模型或网页上传控件的已验收上限。

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
