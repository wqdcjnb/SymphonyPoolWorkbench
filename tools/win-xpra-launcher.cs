// Windows protocol bridge for the local Symphony Xpra client.
// Build with the Windows .NET Framework C# compiler; no PowerShell policy changes.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

internal static class SymphonyXpraLauncher
{
    private static readonly Regex LocalConnection = new Regex(
        @"^symphony-xpras?://(?:127\.0\.0\.1|localhost):([0-9]{1,5})/[a-f0-9]{64}(?:\?[A-Za-z0-9_%+&=.@-]*)?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            return Fail("invalid-argument-count", "连接信息不完整，请刷新账号登录页后重新点击“直接打开 Xpra”。", 2);
        }
        string clientUrl;
        try
        {
            clientUrl = NormalizeConnection(args[0]);
        }
        catch (FormatException)
        {
            return Fail("invalid-uri", "连接地址无效，请刷新账号登录页后重新点击“直接打开 Xpra”。", 2);
        }

        try
        {
            string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "windows-launcher.paths");
            string[] settings = File.ReadAllLines(configPath);
            if (settings.Length != 2 ||
                !Path.IsPathRooted(settings[0]) || Path.GetFileName(settings[0]) != "Xpra.exe" ||
                !File.Exists(settings[0]) ||
                !Regex.IsMatch(settings[1], @"^[A-Za-z]:[\\/][\x20-\x7e]*$"))
            {
                return Fail("invalid-config", "Xpra 客户端配置无效，请重新运行工作台的客户端配置脚本。", 3);
            }

            var launch = new ProcessStartInfo(settings[0]);
            launch.UseShellExecute = false;
            launch.WorkingDirectory = Path.GetDirectoryName(settings[0]);
            // Xpra ignores window-close, decoder and audio options in URLs. Pass these local
            // login defaults on the command line so no extra probes are started.
            launch.Arguments = BuildArguments(clientUrl);
            launch.EnvironmentVariables["XPRA_LOG_FILENAME"] = settings[1];
            string cacheDirectory = Path.Combine(Path.GetDirectoryName(settings[1]), "pycache");
            Directory.CreateDirectory(cacheDirectory);
            launch.EnvironmentVariables["PYTHONPYCACHEPREFIX"] = cacheDirectory;
            // Record only the attempt time so failures can be diagnosed without logging the bearer.
            RecordEvent("start");
            Process.Start(launch);
            return 0;
        }
        catch (Exception error)
        {
            // Never include args[0] in diagnostics: the URI contains a session credential.
            return Fail("failed-" + error.GetType().Name,
                "无法启动 Xpra 客户端，请检查安装目录和日志目录是否可访问。", 4);
        }
    }

    internal static string BuildArguments(string clientUrl)
    {
        return "attach --splash=no --audio=no --speaker=disabled --microphone=disabled " +
            "--webcam=no --printing=no --file-transfer=no --open-files=no --open-url=no " +
            "--opengl=no --video-decoders=openh264 --window-close=disconnect " + QuoteArgument(clientUrl);
    }

    internal static string NormalizeConnection(string value)
    {
        if (string.IsNullOrEmpty(value)) throw new FormatException();
        foreach (char character in value)
            if (char.IsControl(character)) throw new FormatException();
        if (value.StartsWith("symphony-xpra", StringComparison.Ordinal))
        {
            Match match = LocalConnection.Match(value);
            int port;
            if (!match.Success || !int.TryParse(match.Groups[1].Value, out port) || port < 1 || port > 65535)
                throw new FormatException();
            return "xpra+ws" + value.Substring("symphony-xpra".Length);
        }
        Uri connection;
        if (!Uri.TryCreate(value, UriKind.Absolute, out connection) ||
            (connection.Scheme != "xpra+ws" && connection.Scheme != "xpra+wss") ||
            string.IsNullOrEmpty(connection.Host))
            throw new FormatException();
        return value;
    }

    // ProcessStartInfo on .NET Framework accepts one command-line string.
    // Quote a complete URI as one argument even if it contains quotes or backslashes.
    internal static string QuoteArgument(string value)
    {
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            quoted.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        return quoted.Append('"').ToString();
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr window, string text, string caption, uint type);

    private static int Fail(string status, string message, int exitCode)
    {
        RecordEvent(status);
        MessageBox(IntPtr.Zero, message, "Symphony Xpra", 0x10);
        return exitCode;
    }

    private static void RecordEvent(string status)
    {
        try
        {
            File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                "windows-launcher-events.log"), DateTime.UtcNow.ToString("o") + " " + status + "\n");
        }
        catch { }
    }
}
