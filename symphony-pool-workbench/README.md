# Symphony 号池工作台

独立、本机优先的 Symphony 账号控制面。第一阶段只负责账号档案、只读验收、积分状态、任务草稿和审计事件；不会自动上传素材或提交生成。

## 启动

```powershell
.\start-workbench.ps1
```

默认地址：`http://127.0.0.1:8787`

停止：

```powershell
.\stop-workbench.ps1
```

## 安全边界

- 服务只监听 `127.0.0.1`。
- 登录态只保存在工作区上级目录的独立 `*_sandbox_data` 浏览器档案。
- SQLite 不存密码、Cookie、验证码或页面正文。
- 只读验收使用可见持久化 Chrome；TikTok 当前拒绝该档案的 headless 导航。
- 任务只保存为 `draft`，自动生成执行层尚未启用。

## 数据

- SQLite：`data/workbench.sqlite`
- 日志：`logs/workbench.stdout.log`、`logs/workbench.stderr.log`
- 一号档案：`../xzkj-pc-01-symphony-01_sandbox_data`
