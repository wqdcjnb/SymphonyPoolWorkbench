[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$DataPath = Join-Path $ProjectRoot 'data'
$LogPath = Join-Path $ProjectRoot 'logs'
$PidPath = Join-Path $DataPath 'workbench.pid'
$StdoutPath = Join-Path $LogPath 'workbench.stdout.log'
$StderrPath = Join-Path $LogPath 'workbench.stderr.log'
$Url = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $DataPath, $LogPath | Out-Null

try {
  $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
  if ($health.ok) {
    if (-not $NoBrowser) { Start-Process $Url }
    Write-Output "Symphony 号池工作台已在运行：$Url"
    exit 0
  }
} catch { }

$process = Start-Process -FilePath 'node.exe' `
  -ArgumentList @('--disable-warning=ExperimentalWarning', 'server.mjs') `
  -WorkingDirectory $ProjectRoot `
  -RedirectStandardOutput $StdoutPath `
  -RedirectStandardError $StderrPath `
  -WindowStyle Hidden `
  -PassThru

[System.IO.File]::WriteAllText($PidPath, [string]$process.Id)

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
    if ($health.ok) { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}

if (-not $ready) {
  throw "工作台未能启动，请查看 $StderrPath"
}

if (-not $NoBrowser) { Start-Process $Url }
Write-Output "Symphony 号池工作台已启动：$Url"
Write-Output "PID：$($process.Id)"
