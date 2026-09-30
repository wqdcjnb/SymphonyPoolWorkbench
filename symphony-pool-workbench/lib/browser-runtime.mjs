import path from "node:path";

export function browserRuntime({ projectRoot, workspaceRoot, platform = process.platform,
  pythonExecutable, launcherPath, env = process.env }) {
  const windows = platform === "win32";
  return {
    windows,
    pythonExecutable: pythonExecutable || env.WORKBENCH_PYTHON || path.join(projectRoot,
      ".venv", windows ? "Scripts" : "bin", windows ? "python.exe" : "python"),
    launcherPath: path.resolve(launcherPath || path.join(workspaceRoot, "tools",
      windows ? "open-symphony-profile.ps1" : "open-browser-profile.py")),
  };
}

export function profileLaunchCommand(runtime, account) {
  return runtime.windows
    ? { executable: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      runtime.launcherPath, "-AccountId", account.id, "-LoginType", account.loginType] }
    : { executable: runtime.pythonExecutable, args: [runtime.launcherPath,
      "--profile", account.profilePath, "--login-type", account.loginType] };
}
