# Use an ASCII log path for Xpra Windows builds affected by non-ASCII usernames.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$LogDirectory,
    [string]$XpraExecutable
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This helper is for the Windows Xpra client.' }
if ($LogDirectory -notmatch '^[A-Za-z]:[\\/]' -or $LogDirectory -match '[^\x20-\x7e]') {
    throw 'Use an absolute local directory containing ASCII characters only.'
}
$xpraLogs = [IO.Path]::GetFullPath($LogDirectory)
New-Item -ItemType Directory -Path $xpraLogs -Force | Out-Null
$xpraLogFile = Join-Path $xpraLogs 'Xpra.log'
$launcherSource = Join-Path $PSScriptRoot 'win-xpra-launcher.cs'
if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) { throw 'Xpra launcher source is missing.' }
$windowsCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $windowsCompiler -PathType Leaf)) {
    $windowsCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $windowsCompiler -PathType Leaf)) { throw 'Windows .NET Framework C# compiler is missing.' }
if (-not $XpraExecutable) {
    $effectiveCommand = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\xpra+ws\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
    if ($effectiveCommand -match '^"([^"]+\\Xpra\.exe)"') {
        $XpraExecutable = $Matches[1]
    } else {
        $savedPaths = Join-Path $PSScriptRoot '..\.docker-local\xpra\windows-launcher.paths'
        if (Test-Path -LiteralPath $savedPaths) {
            $XpraExecutable = [string](Get-Content -LiteralPath $savedPaths -Encoding UTF8 -TotalCount 1)
        } else {
            $saved = Join-Path $PSScriptRoot '..\.docker-local\xpra\windows-launcher.json'
            if (Test-Path -LiteralPath $saved) {
                $XpraExecutable = [string](Get-Content -LiteralPath $saved -Raw -Encoding UTF8 | ConvertFrom-Json).XpraExecutable
            }
        }
    }
}
if (-not $XpraExecutable -or -not (Test-Path -LiteralPath $XpraExecutable -PathType Leaf) -or
    [IO.Path]::GetFileName($XpraExecutable) -ne 'Xpra.exe') {
    throw 'Specify the installed Xpra.exe with -XpraExecutable.'
}
$previousSettingFile = Join-Path $xpraLogs 'previous-log-setting.json'
if (-not (Test-Path -LiteralPath $previousSettingFile)) {
    @{ XPRA_LOG_FILENAME = [Environment]::GetEnvironmentVariable('XPRA_LOG_FILENAME', 'User') } |
        ConvertTo-Json | Set-Content -LiteralPath $previousSettingFile -Encoding UTF8
}
# Xpra reads this before its configuration files and GUI are initialized.
[Environment]::SetEnvironmentVariable('XPRA_LOG_FILENAME', $xpraLogFile, 'User')
$env:XPRA_LOG_FILENAME = $xpraLogFile
$launcherDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.docker-local\xpra'))
New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
$launcherExecutable = Join-Path $launcherDirectory 'SymphonyXpraLauncher.exe'
$launcherSettings = Join-Path $launcherDirectory 'windows-launcher.paths'
& $windowsCompiler /nologo /codepage:65001 /target:winexe "/out:$launcherExecutable" $launcherSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) {
    throw 'The local Xpra protocol launcher could not be compiled.'
}
@([IO.Path]::GetFullPath($XpraExecutable), $xpraLogFile) |
    Set-Content -LiteralPath $launcherSettings -Encoding UTF8
$protocolBackup = Join-Path $xpraLogs 'previous-protocol-handlers.json'
if (-not (Test-Path -LiteralPath $protocolBackup)) {
    $oldHandlers = @{}
    foreach ($scheme in @('xpra+ws', 'xpra+wss')) {
        $oldHandlers[$scheme] = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\$scheme\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
    }
    $oldHandlers | ConvertTo-Json | Set-Content -LiteralPath $protocolBackup -Encoding UTF8
}
$openCommand = '"{0}" "%1"' -f $launcherExecutable
$schemes = @('xpra+ws', 'xpra+wss', 'symphony-xpra', 'symphony-xpras')
foreach ($scheme in $schemes) {
    $schemeKey = "HKCU:\Software\Classes\$scheme"
    New-Item -Path "$schemeKey\shell\open\command" -Force | Out-Null
    Set-Item -Path $schemeKey -Value 'URL:Symphony Xpra login'
    New-ItemProperty -Path $schemeKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -Path "$schemeKey\shell" -Value 'open'
    Set-Item -Path "$schemeKey\shell\open\command" -Value $openCommand
}
# A standard import is available when the desktop shell cannot see registration
# performed by the configuring process. It contains local paths, never session URLs.
function ConvertTo-RegistryString([string]$Value) {
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}
$registration = [Collections.Generic.List[string]]::new()
$registration.Add('Windows Registry Editor Version 5.00')
foreach ($scheme in $schemes) {
    $registration.Add('')
    $registration.Add("[HKEY_CURRENT_USER\Software\Classes\$scheme]")
    $registration.Add('@="URL:Symphony Xpra login"')
    $registration.Add('"URL Protocol"=""')
    $registration.Add('')
    $registration.Add("[HKEY_CURRENT_USER\Software\Classes\$scheme\shell]")
    $registration.Add('@="open"')
    $registration.Add('')
    $registration.Add("[HKEY_CURRENT_USER\Software\Classes\$scheme\shell\open\command]")
    $registration.Add('@=' + (ConvertTo-RegistryString $openCommand))
}
$registration.Add('')
$registrationPath = Join-Path $xpraLogs 'register-workbench-xpra.reg'
$registration | Set-Content -LiteralPath $registrationPath -Encoding Unicode
if (-not ('SymphonyXpraAssociations' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SymphonyXpraAssociations {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    private static extern uint AssocQueryString(uint flags, uint field, string association,
        string verb, StringBuilder output, ref uint length);
    public static string Command(string scheme) {
        uint length = 32768;
        var output = new StringBuilder((int)length);
        uint result = AssocQueryString(0x1000, 1, scheme, "open", output, ref length);
        if (result != 0) throw new InvalidOperationException("Protocol lookup failed: " + result.ToString("X8"));
        return output.ToString();
    }
}
'@
}
# Notify the running Windows shell after updating protocol associations.
[SymphonyXpraAssociations]::SHChangeNotify(0x08000000, 0x1003, [IntPtr]::Zero, [IntPtr]::Zero)
foreach ($scheme in $schemes) {
    if ([SymphonyXpraAssociations]::Command($scheme) -ne $openCommand) {
        throw "Windows resolved $scheme to a different application."
    }
}
Write-Output "Xpra log file: $xpraLogFile"
Write-Output 'Windows protocol associations refreshed and verified.'
Write-Output "Desktop registration file: $registrationPath"
Write-Output 'Refresh the account login page to get a current connection.'
