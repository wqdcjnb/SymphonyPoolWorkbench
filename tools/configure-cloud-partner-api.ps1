$ErrorActionPreference = 'Stop'
$projectRoot = 'D:\Project\SymphonyPoolWorkbench-source'
$privateDirectory = Join-Path $projectRoot '.docker-local\cloud-access-v2\partner-api'
$configPath = Join-Path $privateDirectory 'partner-config.json'
New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $privateDirectory /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict the private configuration directory.' }
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($existing.apiKey -or $existing.downloadSecret) {
        throw 'Configuration already contains credentials. Existing keys were not changed.'
    }
}
function New-PrivateSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
$config = [ordered]@{
    apiKey = New-PrivateSecret
    downloadSecret = New-PrivateSecret
    webhookSecret = New-PrivateSecret
    baseUrl = 'https://47.84.3.74/v1'
    callbackUrls = @()
    defaultCallbackUrl = ''
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)
$client = [ordered]@{ baseUrl = $config.baseUrl; apiKey = $config.apiKey }
[System.IO.File]::WriteAllText((Join-Path $privateDirectory 'partner-client-access.json'), ($client | ConvertTo-Json), $utf8)
Write-Host 'Configured locally. Keys were saved only in the restricted private directory.'
Write-Host 'Reply in the chat that configuration is complete. Do not paste the keys.'
