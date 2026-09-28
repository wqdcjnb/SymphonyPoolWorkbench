[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
  [string]$AccountId = 'xzkj-pc-01-symphony-01',

  [ValidateSet('tiktok', 'doubao')]
  [string]$LoginType = 'tiktok'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProfilePath = Join-Path $ProjectRoot ("{0}_sandbox_data" -f $AccountId)
$StartUrl = if ($LoginType -eq 'doubao') {
  'https://www.doubao.com/chat/'
} else {
  'https://ads.tiktok.com/creative/creativestudio/settings/credit'
}

$candidatePaths = [System.Collections.Generic.List[string]]::new()
foreach ($basePath in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ([string]::IsNullOrWhiteSpace($basePath)) {
    continue
  }
  $candidatePaths.Add((Join-Path $basePath 'Google\Chrome\Application\chrome.exe'))
  $candidatePaths.Add((Join-Path $basePath 'Microsoft\Edge\Application\msedge.exe'))
}

$BrowserPath = $candidatePaths |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1

if ([string]::IsNullOrWhiteSpace($BrowserPath)) {
  throw '未找到 Google Chrome 或 Microsoft Edge。'
}

if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
  New-Item -ItemType Directory -Path $ProfilePath -Force | Out-Null
}

$arguments = @(
  "--user-data-dir=`"$ProfilePath`""
  '--profile-directory=Default'
  '--new-window'
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-background-mode'
  $StartUrl
)

$process = Start-Process -FilePath $BrowserPath -ArgumentList $arguments -PassThru

[pscustomobject]@{
  AccountId   = $AccountId
  LoginType   = $LoginType
  ProfilePath = $ProfilePath
  BrowserPath = $BrowserPath
  ProcessId   = $process.Id
  StartUrl    = $StartUrl
}
