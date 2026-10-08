import fs from 'node:fs';
import { renderApiDocumentation } from '../lib/api-docs.mjs';
const root=new URL('../',import.meta.url);
const output=new URL('public/partner-api/',root);
fs.mkdirSync(output,{recursive:true});
for (const [source, target] of [['partner-client.mjs','client.mjs'],['partner-client.py','client.py'],['partner-webhook-verify.py','webhook_verify.py']]) {
  fs.copyFileSync(new URL('docs/examples/'+source,root),new URL(target,output));
}
const doc=JSON.parse(fs.readFileSync(new URL('docs/partner-openapi.json',root),'utf8'));
fs.writeFileSync(new URL('openapi.json',output),JSON.stringify(doc,null,2)+'\n');
const task=JSON.parse(fs.readFileSync(new URL('docs/examples/partner-task.json',root),'utf8'));
fs.writeFileSync(new URL('task.json',output),JSON.stringify(task,null,2)+'\n');
const content=renderApiDocumentation({baseUrl:'https://47.84.3.74/v1'})
  .replaceAll('href="/api-docs#','href="#')
  .replaceAll('href="/api-docs/openapi.json"','href="openapi.json"')
  .replaceAll('href="/api-docs/task-example.json"','href="task.json"');
fs.writeFileSync(new URL('index.html',output),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Symphony 视频 API · 合作方接入文档</title><style>
:root{--bg:#f5f7fa;--paper:#fff;--ink:#1c2b3c;--muted:#54677c;--accent:#146baf;--line:#dce4ec;--code:#eef3f8;--warning:#fff1d7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.8 "Segoe UI","Microsoft YaHei",sans-serif}header{background:var(--ink);color:var(--paper);padding:38px max(24px,calc((100% - 1120px)/2))}header p{margin:6px 0}header small{letter-spacing:2px;color:#b6d7f4}h1{font-size:32px;margin:8px 0 16px;line-height:1.4}header a{color:#c5e4ff}main{max-width:1168px;margin:auto;padding:28px 24px 60px}.api-doc-toc{background:var(--paper);padding:20px;border:1px solid var(--line);border-radius:12px}.api-doc-toc summary{font-weight:700;cursor:pointer}.api-doc-toc nav{display:grid;grid-template-columns:repeat(3,1fr);gap:7px 18px;margin-top:12px}.api-doc-toc a{font-size:14px;text-decoration:none}a{color:var(--accent);text-underline-offset:3px}article{margin-top:22px;padding:32px;background:var(--paper);border:1px solid var(--line);border-radius:12px}h2{font-size:24px;margin:36px 0 16px;border-top:1px solid var(--line);padding-top:26px;scroll-margin-top:20px}h3{font-size:19px;margin:24px 0 10px}p,li{overflow-wrap:anywhere}li{margin:6px 0}code{font:14px/1.8 Consolas,"Microsoft YaHei",monospace;background:var(--code);padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}.api-doc-code{margin:18px 0;border:1px solid var(--line);border-radius:9px;overflow:hidden}.api-doc-code>span{display:block;background:var(--code);padding:7px 16px;font-size:12px;color:var(--muted)}pre{margin:0;padding:16px;overflow:auto;background:var(--bg)}pre code{background:none;padding:0;white-space:pre}.api-doc-table{overflow:auto;margin:18px 0}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top;min-width:95px}th{background:var(--code)}.notice{background:var(--warning);padding:16px 20px;border-radius:10px;margin-bottom:22px}.flow{font-weight:600;color:var(--accent);padding:12px 0}.downloads{display:flex;flex-wrap:wrap;gap:16px}.downloads a{font-weight:600}.footer{color:var(--muted);font-size:13px;margin-top:24px}@media(max-width:720px){main{padding:16px}article{padding:20px}.api-doc-toc nav{grid-template-columns:1fr 1fr}header{padding:26px 20px}h1{font-size:27px}}@media print{header{background:none;color:var(--ink);padding:0}.api-doc-toc{display:none}main,article{padding:0;border:0}pre{white-space:pre-wrap}pre code{white-space:pre-wrap}h2{break-after:avoid}table{font-size:10pt}}
</style></head><body><header><small>SYMPHONY / DEVELOPER API</small><h1>视频生成 API 接入文档</h1><p>API v1 · 文档 ${doc.info.version} · 2026-10-08</p><p>Base URL：<b>https://47.84.3.74/v1</b></p></header><main><div class="notice"><b>豆包与 Dola 均交付无水印成品。</b> 豆包提供 15 秒视频，Dola Seedance 2.5 提供 30 秒视频。按下方示例提交任务，生成完成后查询或接收回调，获取 MP4 下载地址。</div><div class="downloads"><a href="openapi.json" download>下载 OpenAPI / 导入 Apifox</a><a href="task.json" download>下载请求 JSON</a><a href="client.py" download>Python 客户端</a><a href="client.mjs" download>Node.js 客户端</a><a href="webhook_verify.py" download>回调验签示例</a></div><p class="flow">提交提示词或图片 → 获取 task_id → 查询进度或接收回调 → 下载 MP4 → 校验 SHA-256</p>${content}<p class="footer">真实 API Key 由服务方单独提供。回调先登记；初次接入可使用轮询。</p></main></body></html>`);
const request=(name,method,route,extra={})=>({name,request:{method,header:[{key:'Authorization',value:'Bearer {{apiKey}}'}],url:{raw:'{{baseUrl}}'+route,host:['{{baseUrl}}'],path:route.slice(1).split('/')},...extra}});
const collection={info:{name:'Symphony 视频 API v1',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',description:'先配置 apiKey 并获取模型目录，再手动提交任务。豆包与 Dola 均交付无水印成品；豆包使用 official_original，Dola 显式选择 watermark_repair。不要直接运行整个集合。'},
  variable:[{key:'baseUrl',value:'https://47.84.3.74/v1'},{key:'apiKey',value:''},{key:'taskId',value:''},{key:'clientTaskId',value:'replace_with_unique_business_id'}],item:[
    request('01 获取模型目录','GET','/models'),
    {...request('02 创建一条任务（确认模型可用后执行）','POST','/videos',{body:{mode:'raw',raw:JSON.stringify({...task,client_task_id:'{{clientTaskId}}'},null,2),options:{raw:{language:'json'}}}}),event:[{listen:'test',script:{type:'text/javascript',exec:["if ([200,202].includes(pm.response.code)) { const data=pm.response.json(); if(data.task_id) pm.collectionVariables.set('taskId', data.task_id); }"]}}]},
    request('03 查询累计结果','GET','/videos/{{taskId}}'),request('04 下载第一条交付视频','GET','/videos/{{taskId}}/results/1'),
    request('05 取消未提交的条目','POST','/videos/{{taskId}}/cancel'),request('06 获取 OpenAPI','GET','/openapi.json'),
  ]};
collection.item[1].request.header.push({key:'Content-Type',value:'application/json'});
fs.writeFileSync(new URL('docs/examples/partner-postman.json',root),JSON.stringify(collection,null,2)+'\n');
console.log('Built public API reference and credential-free Postman collection.');
// The application CSP allows same-origin stylesheets; keep it strict.
const htmlPath=new URL('index.html',output);
const html=fs.readFileSync(htmlPath,'utf8');
const style=html.match(/<style>([\s\S]*?)<\/style>/);
if(!style) throw new Error('REFERENCE_STYLES_MISSING');
fs.writeFileSync(new URL('reference.css',output),style[1].trim()+'\n');
fs.writeFileSync(htmlPath,html.replace(style[0],'<link rel="stylesheet" href="reference.css">'));
