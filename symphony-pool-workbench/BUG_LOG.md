# 问题记录

## 已解决：严格 CSP 拦截积分进度条

- 现象：桌面与窄屏回归各出现一条 `style-src 'self'` 控制台错误。
- 根因：账号卡片通过 `style="width:..."` 写入动态宽度，被严格 CSP 正确拦截。
- 修复：改用带 `value/max` 的原生 `progress` 元素并由外部 CSS 渲染；同时补充本地 `favicon.svg` 消除图标 404。
- 验证：1440×960 与 390×844 均零控制台错误、零横向溢出。

## 环境约束

- TikTok 对该持久化档案的 headless 导航返回失败，因此只读验收固定使用 headed Chrome。
- `@playwright/cli --help` 在当前 Windows 环境完成输出后触发 libuv 断言退出；页面回归改用本机已安装的 Playwright 模块，应用本身不受影响。
