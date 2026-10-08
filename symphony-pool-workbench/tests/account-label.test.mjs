import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchServer } from "../server.mjs";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("account ID and name edits preserve the browser profile and job links", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "account-label-test-"));
  const port = await freePort();
  const app = (await createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "test.sqlite") }));
  try {
    await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const createdResponse = await fetch(`${base}/api/accounts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "pc-doubao-01", label: "原名称",
        loginType: "doubao", workerId: "pc" }),
    });
    assert.equal(createdResponse.status, 201);
    const { account: created } = await createdResponse.json();

    const renamedResponse = await fetch(`${base}/api/accounts/${created.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "  新名称  " }),
    });
    assert.equal(renamedResponse.status, 200);
    const { account: renamed } = await renamedResponse.json();
    assert.equal(renamed.label, "新名称");
    assert.equal(renamed.id, created.id);
    assert.equal(renamed.profilePath, created.profilePath);
    assert.equal(renamed.loginType, created.loginType);
    assert.equal((await app.store.getAccount(created.id)).label, "新名称");
    assert.equal((await app.store.listEvents()).find((event) => event.eventType === "account.label_updated")?.accountId,
      created.id);

    fs.mkdirSync(created.profilePath);
    fs.writeFileSync(path.join(created.profilePath, "profile-marker.txt"), "session stays here");
    const job = (await app.store.createDraftJob({
      idempotencyKey: "account-rename-draft", accountId: created.id,
      mode: "image_to_video", model: "auto", durationSeconds: 15,
      prompt: "测试账号关联", referenceAssets: [], priority: 50,
    }));
    const duplicateResponse = await fetch(`${base}/api/accounts/${created.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "xzkj-pc-01-doubao-01", label: "冲突" }),
    });
    assert.equal(duplicateResponse.status, 409);
    assert.equal((await app.store.getAccount(created.id)).label, "新名称");
    assert.ok(fs.existsSync(created.profilePath));

    const newId = "pc-doubao-03";
    const occupiedProfilePath = path.join(tempRoot, `${newId}_sandbox_data`);
    fs.mkdirSync(occupiedProfilePath);
    const occupiedResponse = await fetch(`${base}/api/accounts/${created.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: newId, label: "三号账号" }),
    });
    assert.equal(occupiedResponse.status, 409);
    assert.ok(fs.existsSync(created.profilePath));
    assert.equal((await app.store.getAccount(created.id)).label, "新名称");
    fs.rmdirSync(occupiedProfilePath);

    const movedResponse = await fetch(`${base}/api/accounts/${created.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: newId, label: "三号账号" }),
    });
    assert.equal(movedResponse.status, 200);
    const { account: moved } = await movedResponse.json();
    assert.equal(moved.id, newId);
    assert.equal(moved.label, "三号账号");
    assert.equal(moved.loginType, created.loginType);
    assert.equal(moved.workerId, created.workerId);
    assert.equal((await app.store.getAccount(created.id)), null);
    assert.equal((await app.store.getAccount(newId)).profilePath, moved.profilePath);
    assert.equal(fs.existsSync(created.profilePath), false);
    assert.equal(fs.readFileSync(path.join(moved.profilePath, "profile-marker.txt"), "utf8"),
      "session stays here");
    assert.equal((await app.store.getJob(job.id)).accountId, newId);
    assert.equal((await app.store.getJob(job.id)).requestedAccountId, newId);
    assert.ok((await app.store.listEvents()).filter((event) => event.accountId === newId).length >= 3);

    const invalidResponse = await fetch(`${base}/api/accounts/${newId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "   " }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await app.store.getAccount(newId)).label, "三号账号");
    const missingResponse = await fetch(`${base}/api/accounts/missing-account`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "新名称" }),
    });
    assert.equal(missingResponse.status, 404);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("renaming the initial account does not recreate its old ID on restart", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "account-default-rename-"));
  const databasePath = path.join(tempRoot, "test.sqlite");
  const oldId = "xzkj-pc-01-doubao-01";
  const newId = "pc-symphony-main";
  const port = await freePort();
  const app = (await createWorkbenchServer({ port, workspaceRoot: tempRoot, databasePath }));
  try {
    await app.listen();
    const response = await fetch(`http://127.0.0.1:${port}/api/accounts/${oldId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: newId, label: "主账号" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await app.store.getAccount(oldId)), null);
  } finally {
    await app.close();
  }
  const reopened = (await createWorkbenchServer({ port: await freePort(), workspaceRoot: tempRoot,
    databasePath }));
  try {
    assert.equal((await reopened.store.getAccount(oldId)), null);
    assert.equal((await reopened.store.getAccount(newId)).label, "主账号");
    assert.equal((await reopened.store.listAccounts()).length, 1);
  } finally {
    await reopened.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
