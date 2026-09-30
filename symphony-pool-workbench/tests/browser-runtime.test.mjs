import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserRuntime, profileLaunchCommand } from "../lib/browser-runtime.mjs";
import { createWorkbenchServer } from "../server.mjs";

test("Python and login launcher follow the host OS without changing Windows arguments", () => {
  const root = path.resolve("runtime fixture");
  const base = { projectRoot: path.join(root, "app"), workspaceRoot: root, env: {} };
  const linux = browserRuntime({ ...base, platform: "linux" });
  assert.equal(linux.pythonExecutable, path.join(root, "app", ".venv", "bin", "python"));
  assert.equal(path.basename(linux.launcherPath), "open-browser-profile.py");
  const windows = browserRuntime({ ...base, platform: "win32" });
  assert.equal(windows.pythonExecutable, path.join(root, "app", ".venv", "Scripts", "python.exe"));
  const command = profileLaunchCommand(windows, { id: "pc-doubao-01", loginType: "doubao" });
  assert.equal(command.executable, "powershell.exe");
  assert.deepEqual(command.args.slice(-4), ["-AccountId", "pc-doubao-01", "-LoginType", "doubao"]);
  assert.equal(browserRuntime({ ...base, platform: "linux", env: { WORKBENCH_PYTHON: "/custom/python" } }).pythonExecutable, "/custom/python");
});

test("Linux account login invokes its configured launcher with the stored profile and sanitized errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linux launcher test "));
  const launcher = path.join(root, "launcher.mjs");
  const capture = path.join(root, "arguments.json");
  fs.writeFileSync(launcher, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));`);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const app = createWorkbenchServer({ port, workspaceRoot: root, databasePath: path.join(root, "test.sqlite"),
    runtimePlatform: "linux", launcherPath: launcher, pythonExecutable: process.execPath });
  try {
    await app.listen();
    const account = app.store.listAccounts()[0];
    const url = `http://127.0.0.1:${port}/api/accounts/${account.id}/open`;
    assert.equal((await fetch(url, { method: "POST" })).status, 202);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), ["--profile", account.profilePath, "--login-type", "tiktok"]);
    fs.writeFileSync(launcher, `console.log(JSON.stringify({ok:false,error:'DISPLAY_NOT_CONFIGURED'}));process.exit(1);`);
    const unavailable = await fetch(url, { method: "POST" });
    assert.equal(unavailable.status, 500);
    assert.equal((await unavailable.json()).error, "DISPLAY_NOT_CONFIGURED");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
