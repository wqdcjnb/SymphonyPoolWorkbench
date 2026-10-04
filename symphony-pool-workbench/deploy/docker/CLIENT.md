# symphony 局域网 API 测试

- API Base URL：`{{BASE_URL}}`
- API 文档：`{{DOCS_URL}}`
- 测试 Key：同目录 `api-key.txt`，仅供本次联调。
- HTTPS 根证书：同目录 `root-ca.crt`。证书和 Key 请通过双方已确认的文件渠道传递。

## 1. 先检查连接与鉴权

在本目录打开 PowerShell：

```powershell
$base = '{{BASE_URL}}'
$key = (Get-Content -Raw -LiteralPath '.\api-key.txt').Trim()
curl.exe --ssl-revoke-best-effort --cacert '.\root-ca.crt' "$base/models" -H "Authorization: Bearer $key"
```

返回模型列表表示地址、HTTPS 和 Key 正常。不要将 Key 发回聊天或提交到代码库。

Windows 自带 curl 的 `--ssl-revoke-best-effort` 用于处理测试 CA 没有吊销查询地址的情况，仍然验证证书链和目标 IP；不要使用 `-k` 跳过证书验证。其他系统使用 curl 时通常只需 `--cacert`。

浏览器打开文档前，可以在自己的电脑将这个根证书导入“当前用户 → 受信任的根证书颁发机构”；程序也可以仅为本次请求指定该 CA 文件，无需修改系统信任。

Python 标准库验证示例：

```python
import json, ssl, urllib.request
from pathlib import Path
base = '{{BASE_URL}}'
context = ssl.create_default_context(cafile='root-ca.crt')
key = Path('api-key.txt').read_text().strip()
request = urllib.request.Request(base + '/models', headers={'Authorization': 'Bearer ' + key})
with urllib.request.urlopen(request, context=context) as response:
    print(json.load(response))
```

## 2. 创建、查询与取消

请先让服务方在 Docker 工作台登录并验收测试账号。`task.json` 请求两条视频，实际执行将消耗所用平台账号的额度。

```powershell
curl.exe --ssl-revoke-best-effort --cacert '.\root-ca.crt' "$base/videos" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data-binary '@task.json'
```

保存返回的 `task_id`。相同任务重试保持 `client_task_id` 和请求内容一致；新任务更换 `client_task_id`。

```powershell
$taskId = '替换为返回的 task_id'
curl.exe --ssl-revoke-best-effort --cacert '.\root-ca.crt' "$base/videos/$taskId" -H "Authorization: Bearer $key"
curl.exe --ssl-revoke-best-effort --cacert '.\root-ca.crt' -X POST "$base/videos/$taskId/cancel" -H "Authorization: Bearer $key"
```

完成后下载返回的 `video_url`，下载请求也须信任同一根证书。结果是原始 MP4 字节，可核对响应中的 SHA-256。

## 本次测试约定

- 先使用查询方式，`callback_url` 保持空字符串。当前实现不会向局域网私有地址发送回调。
- 管理页面和远程桌面由服务方在自己的电脑操作，对测试方只开放 API 和文档。
- 电脑关机、休眠或断网会导致接口暂时不可用。
- 局域网 IP 变化后，服务方需要重新配置地址和证书，并重新提供本目录文件。
