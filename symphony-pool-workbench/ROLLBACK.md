# 回滚说明

- 项目位于独立目录 `symphony-pool-workbench`，未修改素材工厂生产源码或数据库。
- 停止服务使用 `stop-workbench.ps1`；如放弃项目，可在确认服务已停止后整体归档该目录。
- 不要删除上级目录的 `xzkj-pc-01-symphony-01_sandbox_data`，该目录包含人工登录态，不属于工作台 SQLite。
- 工作台业务状态只在 `data/workbench.sqlite`；回退代码时优先使用本项目 Git 基线，不要覆盖或移动账号浏览器档案。
- 若只需重建本地台账，先停止服务并备份 `data/workbench.sqlite`，再处理该精确文件；不得对上级 `*_sandbox_data` 目录执行递归删除。
