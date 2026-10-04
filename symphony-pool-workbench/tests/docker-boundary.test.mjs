import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWorkbenchServer } from "../server.mjs";

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test("deletion protects a live Linux profile owner and succeeds after it exits leaving locks", {
  skip: process.platform !== "linux",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-profile-"));
  const app = createWorkbenchServer({ port: await freePort(), workspaceRoot: root,
    databasePath: path.join(root, "test.sqlite") });
  let owner, exited;
  try {
    const { url } = await app.listen();
    const account = app.store.listAccounts()[0];
    fs.mkdirSync(account.profilePath);
    const marker = path.join(account.profilePath, "account-data");
    fs.writeFileSync(marker, "preserve while running");
    // A harmless process with Chrome's argv layout exercises the real /proc ownership check.
    const executable = path.join(root, "chrome");
    fs.symlinkSync(process.execPath, executable);
    owner = spawn(executable, ["-e", "setInterval(() => {}, 1000)", "--",
      `--user-data-dir=${account.profilePath}`], { stdio: "ignore" });
    exited = once(owner, "exit");
    await once(owner, "spawn");
    fs.symlinkSync(`${os.hostname()}-${owner.pid}`, path.join(account.profilePath, "SingletonLock"));
    fs.symlinkSync("/tmp/old-chrome/SingletonSocket", path.join(account.profilePath, "SingletonSocket"));
    const remove = () => fetch(`${url}/api/accounts/${account.id}`, { method: "DELETE" });
    const busy = await remove();
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, "ACCOUNT_PROFILE_IN_USE");
    assert.equal(fs.readFileSync(marker, "utf8"), "preserve while running");
    assert.ok(app.store.getAccount(account.id));
    owner.kill();
    await exited;
    assert.equal((await remove()).status, 200);
    assert.equal(fs.existsSync(account.profilePath), false);
    assert.equal(app.store.getAccount(account.id), null);
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      owner.kill();
      await exited;
    }
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persistent profile directory remains separate from source code during creation and rename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-profile-"));
  const profiles = path.join(root, "persistent-profiles");
  fs.mkdirSync(profiles);
  const app = createWorkbenchServer({ port: await freePort(), workspaceRoot: path.join(root, "code"),
    profileRoot: profiles, databasePath: path.join(root, "test.sqlite") });
  try {
    const { url } = await app.listen();
    assert.equal(path.dirname(app.store.listAccounts()[0].profilePath), profiles);
    const response = await fetch(`${url}/api/accounts`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "docker-doubao-01", label: "Docker test", loginType: "doubao" }) });
    assert.equal(response.status, 201);
    const { account } = await response.json();
    assert.equal(path.dirname(account.profilePath), profiles);
    fs.mkdirSync(account.profilePath);
    fs.writeFileSync(path.join(account.profilePath, "marker"), "persistent");
    const rename = await fetch(`${url}/api/accounts/${account.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: "docker-doubao-02", label: "Renamed" }) });
    assert.equal(rename.status, 200);
    const moved = (await rename.json()).account;
    assert.equal(path.dirname(moved.profilePath), profiles);
    assert.equal(fs.readFileSync(path.join(moved.profilePath, "marker"), "utf8"), "persistent");

    const draft = app.store.createDraftJob({ idempotencyKey: "account-delete-draft",
      accountId: moved.id, mode: "image_to_video", model: "Seedance 2.0 Fast",
      durationSeconds: 5, prompt: "测试删除保护", referenceAssets: [], priority: 50 });
    const deleteUrl = `${url}/api/accounts/${moved.id}`;
    const pending = await fetch(deleteUrl, { method: "DELETE" });
    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).error, "ACCOUNT_HAS_PENDING_JOBS");
    assert.ok(fs.existsSync(moved.profilePath));
    app.store.cancelJob(draft.id);

    if (process.platform === "linux") {
      // Container restarts retain broken Chromium symlinks in the persistent profile volume.
      fs.symlinkSync(`${os.hostname()}-2147483647`, path.join(moved.profilePath, "SingletonLock"));
      fs.symlinkSync("/tmp/old-chrome/SingletonSocket", path.join(moved.profilePath, "SingletonSocket"));
    }

    const deleted = await fetch(deleteUrl, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, accountId: moved.id, profileCleanupPending: false });
    assert.equal(app.store.getAccount(moved.id), null);
    assert.equal(app.store.getJob(draft.id).status, "cancelled");
    assert.equal(app.store.getJob(draft.id).accountId, null);
    assert.equal(fs.existsSync(moved.profilePath), false);
    assert.ok(app.store.listEvents().some((event) => event.eventType === "account.deleted"));

    const defaultId = "xzkj-pc-01-symphony-01";
    assert.equal((await fetch(`${url}/api/accounts/${defaultId}`, { method: "DELETE" })).status, 200);
    assert.equal(app.store.listAccounts().length, 0);
    const reopened = createWorkbenchServer({ port: await freePort(), workspaceRoot: path.join(root, "code"),
      profileRoot: profiles, databasePath: path.join(root, "test.sqlite") });
    try { assert.equal(reopened.store.listAccounts().length, 0); }
    finally { await reopened.close(); }
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public gateway requests cannot reach management routes after URL normalization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-boundary-"));
  const key = "gateway-test-api-key-".repeat(3);
  const app = createWorkbenchServer({ port: await freePort(), workspaceRoot: root,
    databasePath: path.join(root, "test.sqlite"),
    partnerApi: { apiKey: key, downloadSecret: "gateway-test-download-secret-".repeat(3),
      baseUrl: "https://192.168.1.100:9443/v1" } });
  try {
    const { url } = await app.listen();
    const headers = { "X-Symphony-Api-Only": "1", Authorization: `Bearer ${key}` };
    assert.equal((await fetch(`${url}/v1/models`, { headers })).status, 200);
    for (const route of ["/api/health", "/api/accounts", "/accounts", "/v1/../api/health", "/v1/\\../api/health"]) {
      assert.equal((await fetch(url + route, { headers })).status, 404, route);
    }
    assert.equal((await fetch(`${url}/api/accounts`, { method: "POST", headers, body: "{}" })).status, 404);
    assert.equal((await fetch(`${url}/api/accounts/xzkj-pc-01-symphony-01`, { method: "DELETE", headers })).status, 404);
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    const docs = await (await fetch(`${url}/api-docs`)).text();
    assert.ok(docs.includes("https://192.168.1.100:9443/v1"));
    assert.ok(!docs.includes("http://127.0.0.1:8787/v1"));
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
