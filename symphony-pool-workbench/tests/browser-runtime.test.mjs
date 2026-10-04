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
  const reply = (account = 'process.argv[process.argv.indexOf("--account-id") + 1]') =>
    `console.log(JSON.stringify({ok:true,alreadyOpen:true,desktop:{protocol:'xpra',accountId:${account},token:'a'.repeat(64)}}));`;
  fs.writeFileSync(launcher, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))); ${reply()}`);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const app = createWorkbenchServer({ port, workspaceRoot: root, databasePath: path.join(root, "test.sqlite"),
    runtimePlatform: "linux", launcherPath: launcher, pythonExecutable: process.execPath, desktopPort: 6080 });
  try {
    await app.listen();
    const account = app.store.listAccounts()[0];
    const url = `http://127.0.0.1:${port}/api/accounts/${account.id}/open`;
    assert.equal((await fetch(url, { method: "POST" })).status, 202);
    const args = JSON.parse(fs.readFileSync(capture));
    assert.deepEqual(args.slice(0, 7), ["--profile", account.profilePath, "--login-type", "tiktok", "--account-id", account.id, "--desktop-root"]);
    assert.equal(path.basename(args[7]), "login-desktops");
    const loginPage = await fetch(`http://127.0.0.1:${port}/accounts/${account.id}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /\/js\/account-login.js/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/accounts/nonexistent/login`)).status, 404);
    fs.writeFileSync(launcher, reply());
    const alreadyOpen = await fetch(url, { method: "POST" });
    assert.equal(alreadyOpen.status, 202);
    const opened = await alreadyOpen.json();
    assert.equal(opened.alreadyOpen, true);
    assert.deepEqual(opened.desktop, { protocol: "xpra", port: 6080, accountId: account.id, token: 'a'.repeat(64) });
    const closeUrl = url.replace(/\/open$/, "/close-login");
    assert.equal((await fetch(closeUrl, { method: "POST" })).status, 200);
    assert.equal((await fetch(closeUrl.replace(account.id, "unknown"), { method: "POST" })).status, 404);
    fs.writeFileSync(launcher, `console.log(JSON.stringify({ok:false}));`);
    assert.equal((await fetch(closeUrl, { method: "POST" })).status, 500);
    // A mismatched or missing desktop must never fall back to a shared login page.
    fs.writeFileSync(launcher, reply('"different-account"'));
    const mismatched = await fetch(url, { method: "POST" });
    assert.equal(mismatched.status, 500);
    assert.equal((await mismatched.json()).error, "PROFILE_DESKTOP_FAILED");
    fs.writeFileSync(launcher, `console.log(JSON.stringify({ok:true}));`);
    assert.equal((await fetch(url, { method: "POST" })).status, 500);
    fs.writeFileSync(launcher, `console.log(JSON.stringify({ok:false,error:'DISPLAY_NOT_CONFIGURED'}));process.exit(1);`);
    const unavailable = await fetch(url, { method: "POST" });
    assert.equal(unavailable.status, 500);
    assert.equal((await unavailable.json()).error, "DISPLAY_NOT_CONFIGURED");

    const ready = path.join(root, "launch-started");
    const release = path.join(root, "launch-release");
    fs.writeFileSync(launcher, `import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) {
          clearInterval(timer); ${reply()}
        }
      }, 10);
      setTimeout(() => process.exit(1), 5000).unref();`);
    const opening = fetch(url, { method: "POST" });
    try {
      for (let i = 0; i < 100 && !fs.existsSync(ready); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(fs.existsSync(ready));
      const deletion = await fetch(url.replace(/\/open$/, ""), { method: "DELETE" });
      assert.equal(deletion.status, 409);
      assert.equal((await deletion.json()).error, "ACCOUNT_PROFILE_IN_USE");
      assert.ok(app.store.getAccount(account.id));
    } finally { fs.writeFileSync(release, "continue"); }
    assert.equal((await opening).status, 202);
    assert.equal((await fetch(url.replace(/\/open$/, ""), { method: "DELETE" })).status, 200);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
