[CmdletBinding()]
param(
  [string]$Server = '47.84.3.74',
  [string]$User = 'ecs-user',
  [string]$KeyPath = (Join-Path $env:USERPROFILE 'Downloads\_symphony-ssh.pem'),
  [switch]$NoBrowser,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $projectRoot '.docker-local\cloud-access-v2'
$statePath = Join-Path $stateDirectory 'tunnel.json'
$workbenchUrl = 'http://127.0.0.1:8790'
$sshExecutable = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($Server, [ref]$parsedAddress) -or $User -notmatch '^[a-z_][a-z0-9_-]*$') {
  throw 'Invalid SSH address or user.'
}
if (-not (Test-Path -LiteralPath $sshExecutable -PathType Leaf)) { throw 'Windows OpenSSH client is required.' }

function Get-ManagedTunnel {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
  try {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $process = Get-Process -Id ([int]$state.processId) -ErrorAction Stop
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
    if ($process.ProcessName -ne 'ssh' -or $state.server -ne $Server -or $state.user -ne $User -or
        $process.StartTime.ToUniversalTime().ToString('o') -ne $state.startedAt -or
        $details.CommandLine -notlike '*127.0.0.1:8790:127.0.0.1:8790*' -or
        $details.CommandLine -notlike '*127.0.0.1:6084:127.0.0.1:6084*' -or
        $details.CommandLine -notlike "*$User@$Server*") { return $null }
    return $process
  } catch { return $null }
}

$tunnel = Get-ManagedTunnel
if ($Stop) {
  if ($null -ne $tunnel) {
    Stop-Process -Id $tunnel.Id
    Remove-Item -LiteralPath $statePath
    Write-Output 'Cloud SSH tunnel stopped. The server keeps running.'
  } else { Write-Output 'No managed cloud tunnel is running.' }
  return
}

if ($null -eq $tunnel) {
  if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw 'SSH key file was not found. Supply -KeyPath.' }
  foreach ($port in @(8790, 6084)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
      throw "Local port $port is already in use. The existing service was not changed."
    }
  }
  New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
  $logPath = Join-Path $stateDirectory 'ssh.log'
  $sshArguments = @(
    '-N', '-T', '-i', ('"' + $KeyPath + '"'), '-E', ('"' + $logPath + '"'),
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-L', '127.0.0.1:8790:127.0.0.1:8790',
    '-L', '127.0.0.1:6084:127.0.0.1:6084', "$User@$Server"
  )
  $tunnel = Start-Process -FilePath $sshExecutable -ArgumentList $sshArguments -WindowStyle Hidden -PassThru
  @{ processId = $tunnel.Id; startedAt = $tunnel.StartTime.ToUniversalTime().ToString('o'); server = $Server; user = $User } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

$ready = $false
for ($attempt = 0; $attempt -lt 25; $attempt++) {
  if ($tunnel.HasExited) { throw "SSH connection failed. See $stateDirectory\ssh.log" }
  try {
    $health = Invoke-RestMethod -Uri "$workbenchUrl/api/health" -TimeoutSec 2
    if ($health.ok -and $health.service -eq 'symphony-pool-workbench') { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'SSH started, but the cloud workbench health check failed.' }
Write-Output "Cloud workbench: $workbenchUrl/pool"
if (-not $NoBrowser) { Start-Process "$workbenchUrl/pool" }
