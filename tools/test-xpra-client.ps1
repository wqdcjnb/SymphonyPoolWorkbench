# Validate URI handling without opening a browser, invoking a protocol, or starting Xpra.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This check uses the Windows command-line parser.' }
$source = Get-Content (Join-Path $PSScriptRoot 'win-xpra-launcher.cs') -Raw -Encoding UTF8
$checks = @'
public static class SymphonyXpraClientChecks {
    [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern System.IntPtr CommandLineToArgvW(string command, out int count);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern System.IntPtr LocalFree(System.IntPtr memory);

    public static int Run() {
        int checks = 0;
        string token = new string('a', 64);
        string[] accepted = {
            "xpra+ws://127.0.0.1:6081/" + token + "?opengl=no&title=%40title%40+-+%40session-name%40",
            "xpra+wss://example.test:443/session?clipboard=yes",
            "xpra+ws://[::1]:6081/session"
        };
        foreach (string value in accepted) {
            if (SymphonyXpraLauncher.NormalizeConnection(value) != value)
                throw new System.Exception("An existing Xpra connection changed.");
            checks++;
        }
        string legacy = "symphony-xpra://localhost:6081/" + token;
        if (SymphonyXpraLauncher.NormalizeConnection(legacy) != "xpra+ws://localhost:6081/" + token)
            throw new System.Exception("Legacy workbench connection was not preserved.");
        checks++;
        string[] rejected = {
            "file:///C:/Windows/notepad.exe", "https://example.test/", "xpra+ssh://example.test/",
            "xpra+ws:///missing-host", "xpra+ws://localhost/session\n--start-child=bad",
            "symphony-xpra://example.test:6081/" + token,
            "symphony-xpra://localhost:0/" + token
        };
        foreach (string value in rejected) {
            bool rejectedValue = false;
            try { SymphonyXpraLauncher.NormalizeConnection(value); }
            catch (System.FormatException) { rejectedValue = true; }
            if (!rejectedValue) throw new System.Exception("An invalid connection was accepted.");
            checks++;
        }
        string[] arguments = { accepted[0], "", "url with spaces", "url\" --option=bad", "ends\\", "slash\\\"quote" };
        foreach (string value in arguments) {
            int count;
            System.IntPtr parsed = CommandLineToArgvW("client " + SymphonyXpraLauncher.QuoteArgument(value), out count);
            if (parsed == System.IntPtr.Zero) throw new System.Exception("Windows argument parsing failed.");
            try {
                if (count != 2 || System.Runtime.InteropServices.Marshal.PtrToStringUni(
                    System.Runtime.InteropServices.Marshal.ReadIntPtr(parsed, System.IntPtr.Size)) != value)
                    throw new System.Exception("The URI did not remain one argument.");
            } finally { LocalFree(parsed); }
            checks++;
        }
        int launchCount;
        System.IntPtr launchArgs = CommandLineToArgvW("client " + SymphonyXpraLauncher.BuildArguments(accepted[0]), out launchCount);
        if (launchArgs == System.IntPtr.Zero) throw new System.Exception("Launcher argument parsing failed.");
        try {
            int disconnectFlags = 0;
            for (int index = 0; index < launchCount; index++) {
                string value = System.Runtime.InteropServices.Marshal.PtrToStringUni(
                    System.Runtime.InteropServices.Marshal.ReadIntPtr(launchArgs, System.IntPtr.Size * index));
                if (value == "--window-close=disconnect") disconnectFlags++;
                if (index == launchCount - 1 && value != accepted[0])
                    throw new System.Exception("Launcher changed the connection URL.");
            }
            if (disconnectFlags != 1) throw new System.Exception("Viewer close must only disconnect.");
        } finally { LocalFree(launchArgs); }
        checks++;
        return checks;
    }
}
'@
Add-Type -TypeDefinition ($source + [Environment]::NewLine + $checks)
$count = [SymphonyXpraClientChecks]::Run()
Write-Output "$count Windows Xpra client checks passed; no client session was started."
