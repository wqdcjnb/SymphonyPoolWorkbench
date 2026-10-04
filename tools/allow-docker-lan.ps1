#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
$LocalRoot = Join-Path $ProjectRoot '.docker-local'
$Config = @{}
Get-Content -LiteralPath (Join-Path $LocalRoot 'config.env') | ForEach-Object {
  if ($_ -match '^(SYMPHONY_LAN_IP|SYMPHONY_API_PORT)=(.+)$') { $Config[$Matches[1]] = $Matches[2] }
}
$LanIp = $Config['SYMPHONY_LAN_IP']
$Port = [int]$Config['SYMPHONY_API_PORT']
if ($Port -lt 1024 -or $Port -gt 65534) { throw 'Invalid test API port.' }
$Address = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $LanIp } | Select-Object -First 1
if (-not $Address) { throw 'Configured LAN address is not assigned to this computer.' }
$Bytes = ([System.Net.IPAddress]::Parse($LanIp)).GetAddressBytes()
$Network = for ($Index = 0; $Index -lt 4; $Index++) {
  $Bits = [Math]::Min(8, [Math]::Max(0, $Address.PrefixLength - 8 * $Index))
  $Mask = if ($Bits -eq 0) { 0 } else { (255 -shl (8 - $Bits)) -band 255 }
  $Bytes[$Index] -band $Mask
}
$Subnet = ($Network -join '.') + '/' + $Address.PrefixLength
$DockerBin = Split-Path -Parent (Get-Command docker.exe).Source
$Backend = Join-Path (Split-Path -Parent $DockerBin) 'com.docker.backend.exe'
if (-not (Test-Path -LiteralPath $Backend)) { throw 'Docker Desktop backend executable was not found.' }
$Utf8 = [System.Text.UTF8Encoding]::new($false)
$BackupPath = Join-Path $LocalRoot 'firewall-backup.json'
$Backups = @()
if (Test-Path -LiteralPath $BackupPath) { $Backups = @(Get-Content -Raw -LiteralPath $BackupPath | ConvertFrom-Json) }

# Explicit block rules override allow rules. Preserve their block on every other TCP port.
$Rules = Get-NetFirewallRule -Enabled True -Direction Inbound -Action Block
foreach ($Rule in $Rules) {
  $Application = $Rule | Get-NetFirewallApplicationFilter
  if ($Application.Program -ine $Backend) { continue }
  $Filter = $Rule | Get-NetFirewallPortFilter
  if ($Filter.Protocol -notin @('TCP', '6')) { continue }
  if (@($Filter.LocalPort).Count -eq 1 -and $Filter.LocalPort -eq 'Any') {
    if (-not ($Backups | Where-Object { $_.RuleName -eq $Rule.Name })) {
      $Backups += [pscustomobject]@{ RuleName=$Rule.Name; LocalPort=@($Filter.LocalPort) }
      [IO.File]::WriteAllText($BackupPath, (ConvertTo-Json -InputObject @($Backups) -Depth 5), $Utf8)
    }
    $Ranges = @("1-$($Port - 1)", "$($Port + 1)-65535")
    $Filter | Set-NetFirewallPortFilter -LocalPort $Ranges | Out-Null
  }
}
$RuleName = 'SymphonyDockerLanTest'
$Existing = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($Existing) {
  if ($Existing.Group -ne 'Symphony local Docker test') { throw 'Firewall rule name belongs to another application.' }
  $Existing | Remove-NetFirewallRule
}
New-NetFirewallRule -Name $RuleName -DisplayName "Symphony Docker LAN Test ($Port)" `
  -Group 'Symphony local Docker test' -Direction Inbound -Action Allow -Protocol TCP `
  -LocalAddress $LanIp -LocalPort $Port -RemoteAddress $Subnet -Program $Backend `
  -Profile Any -EdgeTraversalPolicy Block | Out-Null
$Result = @{ status='configured'; local_address=$LanIp; local_port=$Port; remote_subnet=$Subnet; rule=$RuleName }
[IO.File]::WriteAllText((Join-Path $LocalRoot 'firewall-result.json'), ($Result | ConvertTo-Json), $Utf8)
Write-Output "Allowed TCP $LanIp`:$Port from $Subnet for Docker Desktop only."
