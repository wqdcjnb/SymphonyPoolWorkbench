[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8787,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$ServerPath = Join-Path $ProjectRoot 'server.mjs'
$DataPath = Join-Path $ProjectRoot 'data'
$LogPath = Join-Path $ProjectRoot 'logs'
$PidPath = Join-Path $DataPath 'workbench.pid'
$StdoutPath = Join-Path $LogPath 'workbench.stdout.log'
$StderrPath = Join-Path $LogPath 'workbench.stderr.log'
$Url = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $DataPath, $LogPath | Out-Null

try {
  $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
  if ($health.ok -and $health.service -eq 'symphony-pool-workbench' -and $health.localOnly) {
    if (-not $NoBrowser) { Start-Process $Url }
    Write-Output "Symphony 号池工作台已在运行：$Url"
    exit 0
  }
} catch { }

$previousPort = $env:WORKBENCH_PORT
$previousHost = $env:WORKBENCH_HOST
try {
  $env:WORKBENCH_PORT = [string]$Port
  $env:WORKBENCH_HOST = '127.0.0.1'
  $process = Start-Process -FilePath 'node.exe' `
    -ArgumentList @('--disable-warning=ExperimentalWarning', ('"{0}"' -f $ServerPath)) `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru
} finally {
  if ($null -eq $previousPort) {
    Remove-Item Env:WORKBENCH_PORT -ErrorAction SilentlyContinue
  } else {
    $env:WORKBENCH_PORT = $previousPort
  }
  if ($null -eq $previousHost) {
    Remove-Item Env:WORKBENCH_HOST -ErrorAction SilentlyContinue
  } else {
    $env:WORKBENCH_HOST = $previousHost
  }
}

[System.IO.File]::WriteAllText($PidPath, [string]$process.Id)

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
    if ($health.ok -and $health.service -eq 'symphony-pool-workbench' -and $health.localOnly) { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}

if (-not $ready) {
  throw "工作台未能启动，请查看 $StderrPath"
}

if (-not $NoBrowser) { Start-Process $Url }
Write-Output "Symphony 号池工作台已启动：$Url"
Write-Output "PID：$($process.Id)"
