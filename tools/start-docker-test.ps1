[CmdletBinding()]
param(
  [string]$LanIp,
  [ValidateRange(1024, 65535)][int]$ApiPort = 9443,
  [ValidateRange(1024, 65535)][int]$AdminPort = 8788,
  [ValidateRange(1024, 65535)][int]$DesktopPort = 6081,
  [ValidateRange(1, 8)][int]$Concurrency = 2,
  [switch]$PrepareOnly,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
$ComposeFile = Join-Path $ProjectRoot 'symphony-pool-workbench\deploy\docker\compose.yml'
$LocalRoot = Join-Path $ProjectRoot '.docker-local'
$SecretRoot = Join-Path $LocalRoot 'secrets'
$ClientRoot = Join-Path $LocalRoot 'partner-test'
$ConfigPath = Join-Path $LocalRoot 'config.env'
$ComposeCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\cli-plugins\docker-compose.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\resources\cli-plugins\docker-compose.exe')
)
$ComposeCommand = Get-Command docker-compose -ErrorAction SilentlyContinue
$ComposeExe = if ($ComposeCommand) { $ComposeCommand.Source } else {
  $ComposeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $ComposeExe) { throw 'Docker Compose is required. Install or repair Docker Desktop.' }
if (-not $LanIp) {
  $LanIp = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } |
    ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
}
$ParsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$ParsedIp) -or
    $ParsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [System.Net.IPAddress]::IsLoopback($ParsedIp) -or
    -not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $LanIp })) {
  throw 'LanIp must be an IPv4 address assigned to this computer.'
}
if (@($ApiPort, $AdminPort, $DesktopPort | Select-Object -Unique).Count -ne 3) {
  throw 'API, admin, and desktop ports must be distinct.'
}
New-Item -ItemType Directory -Force -Path $LocalRoot, $SecretRoot, $ClientRoot | Out-Null
$SecretReaders = @([Security.Principal.WindowsIdentity]::GetCurrent().User,
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$CurrentAcl = Get-Acl -LiteralPath $LocalRoot
$Rules = @($CurrentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$AlreadyPrivate = $CurrentAcl.AreAccessRulesProtected -and $Rules.Count -eq 3 -and
  @($Rules | Where-Object { $_.IdentityReference.Value -notin $SecretReaders.Value -or
    $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count -eq 0
if (-not $AlreadyPrivate) {
  $CurrentAcl.SetAccessRuleProtection($true, $false)
  foreach ($Rule in @($CurrentAcl.Access)) { [void]$CurrentAcl.RemoveAccessRuleSpecific($Rule) }
  foreach ($Sid in $SecretReaders) {
    $CurrentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  Set-Acl -LiteralPath $LocalRoot -AclObject $CurrentAcl
}
$Utf8 = [System.Text.UTF8Encoding]::new($false)
$Random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  foreach ($Name in @('api-key.txt', 'download-secret.txt', 'webhook-secret.txt')) {
    $SecretPath = Join-Path $SecretRoot $Name
    if (-not (Test-Path -LiteralPath $SecretPath)) {
      $Bytes = New-Object byte[] 32
      $Random.GetBytes($Bytes)
      $Value = [BitConverter]::ToString($Bytes).Replace('-', '').ToLowerInvariant()
      [IO.File]::WriteAllText($SecretPath, $Value + "`n", $Utf8)
    }
  }
} finally { $Random.Dispose() }
$Config = "SYMPHONY_LAN_IP=$LanIp`nSYMPHONY_API_PORT=$ApiPort`nSYMPHONY_ADMIN_PORT=$AdminPort`nSYMPHONY_DESKTOP_PORT=$DesktopPort`nSYMPHONY_CONCURRENCY=$Concurrency`n"
[IO.File]::WriteAllText($ConfigPath, $Config, $Utf8)
$ComposeArguments = @('--env-file', $ConfigPath, '-f', $ComposeFile)
& $ComposeExe @ComposeArguments config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose configuration validation failed.' }
if ($PrepareOnly) { Write-Output 'Docker configuration and local secret files prepared.'; return }
$UpArguments = @('up', '-d', '--wait', '--wait-timeout', '180')
if (-not $SkipBuild) { $UpArguments += '--build' }
& $ComposeExe @ComposeArguments @UpArguments
if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed. Inspect this project with Compose logs.' }
$GatewayId = & $ComposeExe @ComposeArguments ps -q gateway
if (-not $GatewayId) { throw 'Gateway container is missing.' }
$CertificatePath = Join-Path $ClientRoot 'root-ca.crt'
for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
  & docker exec $GatewayId test -s /data/caddy/pki/authorities/local/root.crt
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
& docker cp "${GatewayId}:/data/caddy/pki/authorities/local/root.crt" $CertificatePath
if ($LASTEXITCODE -ne 0) { throw 'Could not export the test CA certificate.' }
Copy-Item -LiteralPath (Join-Path $SecretRoot 'api-key.txt') -Destination (Join-Path $ClientRoot 'api-key.txt')
$Base = "https://${LanIp}:$ApiPort/v1"
$ClientReadme = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'symphony-pool-workbench\deploy\docker\CLIENT.md'))
[IO.File]::WriteAllText((Join-Path $ClientRoot 'README.md'), $ClientReadme.Replace('{{BASE_URL}}', $Base).Replace('{{DOCS_URL}}', "https://${LanIp}:$ApiPort/api-docs"), $Utf8)
$Example = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'symphony-pool-workbench\docs\examples\partner-task.json') | ConvertFrom-Json
$Example.count = 2
$Example.client_task_id = 'lan_test_001'
[IO.File]::WriteAllText((Join-Path $ClientRoot 'task.json'), ($Example | ConvertTo-Json -Depth 4), $Utf8)
$Connection = @{ api_base_url=$Base; api_docs_url="https://${LanIp}:$ApiPort/api-docs"; ca_file='root-ca.crt'; api_key_file='api-key.txt' }
[IO.File]::WriteAllText((Join-Path $ClientRoot 'connection.json'), ($Connection | ConvertTo-Json), $Utf8)
Write-Output "API: $Base"
Write-Output "Admin: http://127.0.0.1:$AdminPort/accounts"
Write-Output "Xpra: open an account login page from http://127.0.0.1:$AdminPort/accounts"
Write-Output "Partner test files: $ClientRoot"
Write-Output 'Install the Xpra native client. Account connection files work only while that login window is running.'
Write-Output 'Windows Firewall may require the dedicated allow-docker-lan.ps1 script, run as administrator.'
