import fs from "node:fs";
import { renderApiDocumentation, documentationFile } from "../../lib/api-docs.mjs";

const base = new URL(process.env.PARTNER_PUBLIC_BASE_URL);
if (base.protocol !== "https:" || base.pathname !== "/v1" || base.username || base.password
  || base.search || base.hash) throw new Error("INVALID_PUBLIC_DOCS_BASE_URL");
const escape = (value) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const rewrite = (text) => text
  .replaceAll("http://127.0.0.1:8787/v1", base.href)
  .replaceAll("http://127.0.0.1:8787/api-docs", `${base.origin}/api-docs`)
  .replaceAll("本机 API Base URL", "本次测试 API Base URL")
  .replaceAll("本机文档页面", "本次测试文档页面");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none'">
<title>symphony 局域网测试 API</title><style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#172336;background:#f5f7fb}
body{max-width:1080px;margin:32px auto;padding:0 24px;line-height:1.7}
h1,h2,h3{line-height:1.35}h2{margin-top:40px}a{color:#245fc4}code,pre{font-family:ui-monospace,monospace}
code{overflow-wrap:anywhere}pre{overflow:auto;background:#142033;color:#edf2ff;padding:18px;border-radius:8px}
pre code{overflow-wrap:normal}.intro,details{background:white;padding:20px;border:1px solid #dce3ed;border-radius:12px}
nav{display:flex;flex-wrap:wrap;gap:10px 22px}table{border-collapse:collapse;width:100%;background:white}
td,th{border:1px solid #dce3ed;padding:9px;text-align:left}.api-doc-table{overflow:auto}
.api-doc-code>span{font-size:12px;color:#65748c}li{margin:5px 0}
</style></head><body><h1>symphony 局域网测试 API</h1><section class="intro">
<p><strong>API Base URL：</strong><code>${escape(base.href)}</code></p>
<p>使用单独提供的测试 Key；客户端通过提供的根证书验证 HTTPS。先创建任务，再查询状态和下载结果。
本次环境未登记回调地址，创建任务时将 <code>callback_url</code> 设为空字符串。</p>
<a href="/api-docs/task-example.json" download>下载任务 JSON</a> ·
<a href="/api-docs/partner-api.md" download>下载完整文档</a></section>
${rewrite(renderApiDocumentation())}</body></html>`;
fs.mkdirSync("/public-docs", { recursive: true, mode: 0o755 });
fs.chmodSync("/public-docs", 0o755);
const write = (name, content) => {
  fs.writeFileSync(`/public-docs/${name}`, content, { mode: 0o644 });
  fs.chmodSync(`/public-docs/${name}`, 0o644);
};
write("index.html", html);
write("partner-api.md", rewrite(documentationFile("/api-docs/partner-api.md").content.toString("utf8")));
write("task-example.json", documentationFile("/api-docs/task-example.json").content);
const spec = JSON.parse(documentationFile("/api-docs/openapi.json").content);
spec.servers = [{ url: base.href, description: "局域网 Docker 测试环境；使用提供的根证书" }];
write("openapi.json", JSON.stringify(spec, null, 2));
