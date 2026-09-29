import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

function get(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
  });
}

function post(port, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      let result = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { result += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(result) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("malformed URLs and foreign hosts are rejected without stopping the server", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-http-test-"));
  const port = await freePort();
  const app = createWorkbenchServer({ port, databasePath: path.join(tempRoot, "test.sqlite") });
  try {
    await app.listen();
    const malformed = await get(port, "/%ZZ");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "INVALID_URL");

    const foreignHost = await get(port, "/api/overview", { Host: "example.invalid" });
    assert.equal(foreignHost.status, 403);
    assert.equal(foreignHost.body.error, "HOST_NOT_ALLOWED");

    const health = await get(port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.service, "symphony-pool-workbench");
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("public listening addresses are rejected", () => {
  assert.throws(() => createWorkbenchServer({ host: "0.0.0.0" }), /LOCAL_HOST_REQUIRED/);
});

test("Doubao accounts use their verifier and cannot receive Symphony drafts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-doubao-test-"));
  const port = await freePort();
  const verifierPath = path.join(tempRoot, "doubao-verifier.mjs");
  const tikTokVerifierPath = path.join(tempRoot, "tiktok-verifier.mjs");
  fs.writeFileSync(verifierPath, `console.log(JSON.stringify({
    ok:true, loggedIn:true, creditPageReady:true, createPageReady:true,
    videosCreatedToday:2, videoCountDate:"2026-09-29",
    nextRefresh:"2026-09-30T00:00:00+08:00", referenceImageLimit:null,
    totalCredits:10, remainingCredits:7, creditsEstimated:true,
    modelsObserved:["Seedance 2.0 Fast","Seedance 2.0 Mini","Unknown model"], stage:"completed"
  }));`);
  fs.writeFileSync(tikTokVerifierPath, 'throw new Error("wrong verifier");');
  const app = createWorkbenchServer({
    port,
    workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "test.sqlite"),
    pythonExecutable: process.execPath,
    verifierPath: tikTokVerifierPath,
    doubaoVerifierPath: verifierPath,
  });
  try {
    await app.listen();
    const input = { accountId: "test-doubao-01", label: "豆包测试", loginType: "doubao", workerId: "test-pc" };
    const created = await post(port, "/api/accounts", input);
    assert.equal(created.status, 201);
    assert.equal(created.body.account.service, "doubao");
    assert.equal(created.body.account.loginType, "doubao");
    assert.equal(created.body.account.status, "provisioning");
    assert.equal(app.store.overview().accounts.needsAttention, 2);

    const duplicate = await post(port, "/api/accounts", input);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "ACCOUNT_ALREADY_EXISTS");

    const draft = await post(port, "/api/jobs", {
      accountId: input.accountId,
      mode: "text_to_video",
      model: "Dreamina Seedance 2.0",
      durationSeconds: 5,
      prompt: "不应提交给豆包",
    });
    assert.equal(draft.status, 400);
    assert.equal(draft.body.error, "ACCOUNT_NOT_SUPPORTED_FOR_SYMPHONY_JOB");

    fs.mkdirSync(created.body.account.profilePath, { recursive: true });
    const verified = await post(port, `/api/accounts/${input.accountId}/verify`, {});
    assert.equal(verified.status, 200);
    assert.equal(verified.body.account.status, "ready");
    assert.equal(verified.body.account.creditsRemaining, 7);
    assert.equal(verified.body.account.creditsTotal, 10);
    assert.equal(verified.body.account.creditsEstimated, true);
    assert.equal(verified.body.account.videosCreatedToday, 2);
    assert.equal(verified.body.account.videoCountDate, "2026-09-29");
    assert.equal(verified.body.account.creditsResetAt, "2026-09-30T00:00:00+08:00");
    assert.equal(verified.body.account.creditPageReady, true);
    assert.equal(verified.body.account.createPageReady, true);
    assert.deepEqual(verified.body.account.models, ["Seedance 2.0 Fast", "Seedance 2.0 Mini"]);
    assert.equal(app.store.overview().accounts.availableCredits, 0);
    assert.equal(app.store.overview().accounts.needsAttention, 1);

    fs.writeFileSync(verifierPath, 'console.log(JSON.stringify({ok:false,loggedIn:false,error:"LOGIN_REQUIRED"}));');
    const guest = await post(port, `/api/accounts/${input.accountId}/verify`, {});
    assert.equal(guest.status, 409);
    assert.equal(guest.body.account.status, "auth_required");
    assert.equal(guest.body.error, "LOGIN_REQUIRED");

    fs.writeFileSync(verifierPath, 'console.log(JSON.stringify({ok:false,loggedIn:false,error:"PROFILE_IN_USE"}));');
    const locked = await post(port, `/api/accounts/${input.accountId}/verify`, {});
    assert.equal(locked.status, 409);
    assert.equal(locked.body.account.status, "error");
    assert.equal(locked.body.error, "PROFILE_IN_USE");
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
