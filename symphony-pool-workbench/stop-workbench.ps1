[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$PidPath = Join-Path $ProjectRoot 'data\workbench.pid'

if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) {
  Write-Output '未发现工作台 PID 文件。'
  exit 0
}

$processId = 0
if (-not [int]::TryParse(([System.IO.File]::ReadAllText($PidPath).Trim()), [ref]$processId)) {
  throw '工作台 PID 文件格式无效。'
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $PidPath -Force
  Write-Output '工作台进程已不存在，PID 文件已清理。'
  exit 0
}

$serverPath = Join-Path $ProjectRoot 'server.mjs'
if ($process.Name -ne 'node.exe' -or
    [string]::IsNullOrEmpty($process.CommandLine) -or
    $process.CommandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "PID $processId 不是工作台 Node 进程，拒绝停止。"
}

Stop-Process -Id $processId
Remove-Item -LiteralPath $PidPath -Force
Write-Output 'Symphony 号池工作台已停止。'
