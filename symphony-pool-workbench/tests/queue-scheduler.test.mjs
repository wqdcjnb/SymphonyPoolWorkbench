import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../lib/db.mjs";
import { createWorkbenchServer } from "../server.mjs";

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function post(port, route, body = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("queued jobs wait for a verified account, honor priority, and survive restart", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-queue-store-"));
  const databasePath = path.join(tempRoot, "queue.sqlite");
  let store = createStore(databasePath);
  try {
    store.ensureAccount({ id: "account-1", label: "Account 1", loginType: "doubao", service: "doubao",
      workerId: "pc", profilePath: path.join(tempRoot, "account-1_sandbox_data"), status: "auth_required" });
    const input = (key, priority) => ({ idempotencyKey: key, accountId: null, mode: "image_to_video",
      model: "Seedance 2.0 Mini", durationSeconds: 5, aspectRatio: "auto", prompt: key,
      referenceAssets: ["image.png"], referenceAssetNames: ["image.png"], priority, enqueue: true });
    const low = store.createDraftJob(input("low", 10));
    const high = store.createDraftJob(input("high", 90));
    const blocked = store.createDraftJob({ ...input("needs-symphony", 100),
      model: "Video 1.5 Pro", durationSeconds: 12 });
    assert.equal(store.claimNextQueuedJob(), null);
    assert.equal(store.getJob(high.id).errorCode, "NO_ELIGIBLE_ACCOUNT");

    store.saveVerification("account-1", { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: 5, totalCredits: 10,
      creditPageReady: true, createPageReady: true });
    const first = store.claimNextQueuedJob();
    assert.equal(first.job.id, high.id);
    assert.equal(store.getJob(blocked.id).status, "queued");
    assert.equal(first.job.accountId, "account-1");
    assert.equal(store.claimNextQueuedJob(), null);
    assert.equal(store.getJob(low.id).status, "queued");

    store.updateJob(high.id, { status: "success" });
    assert.equal(store.claimNextQueuedJob(), null);
    store.saveVerification("account-1", { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: 4, totalCredits: 10,
      creditPageReady: true, createPageReady: true });
    const second = store.claimNextQueuedJob();
    assert.equal(second.job.id, low.id);
    const waiting = store.createDraftJob(input("waiting", 50));
    store.close();
    store = createStore(databasePath);
    assert.equal(store.getJob(low.id).status, "failed");
    assert.equal(store.getJob(waiting.id).status, "queued");
    assert.equal(store.claimNextQueuedJob(), null);
    store.saveVerification("account-1", { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: 3, totalCredits: 10,
      creditPageReady: true, createPageReady: true });
    assert.equal(store.claimNextQueuedJob().job.id, waiting.id);
    assert.equal(store.getJob(blocked.id).status, "queued");
  } finally {
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a pre-submission failure switches accounts without falsifying the credit balance", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-queue-pre-submit-"));
  const store = createStore(path.join(tempRoot, "queue.sqlite"));
  try {
    for (const [id, balance] of [["high", 10], ["low", 5]]) {
      store.ensureAccount({ id, label: id, loginType: "doubao", service: "doubao",
        workerId: "pc", profilePath: path.join(tempRoot, id), status: "auth_required" });
      store.saveVerification(id, { ok: true, loggedIn: true,
        modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: balance,
        totalCredits: 10, creditPageReady: true, createPageReady: true });
    }
    const queued = store.createDraftJob({ idempotencyKey: "switch-before-submit", enqueue: true,
      accountId: null, mode: "image_to_video", model: "auto", durationSeconds: 5,
      aspectRatio: "auto", prompt: "test", referenceAssets: ["image.png"],
      referenceAssetNames: ["image.png"], priority: 50 });
    assert.equal(store.claimNextQueuedJob().account.id, "high");
    const retry = store.handleDispatchFailure(queued.id, "high", "BROWSER_AUTOMATION_FAILED",
      { beforeSubmission: true });
    assert.equal(retry.status, "queued");
    assert.equal(retry.accountId, null);
    assert.equal(retry.model, "auto");
    assert.equal(store.getAccount("high").status, "degraded");
    assert.equal(store.getAccount("high").creditsRemaining, 10);
    assert.equal(store.claimNextQueuedJob().account.id, "low");
  } finally {
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("login occupancy skips accounts, preserves their quota, and resumes the original job", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-login-busy-"));
  const store = createStore(path.join(root, "test.sqlite"));
  try {
    for (const [id, balance] of [["high", 10], ["low", 5]]) {
      store.ensureAccount({ id, label: id, loginType: "doubao", service: "doubao",
        workerId: "pc", profilePath: path.join(root, id), status: "auth_required" });
      store.saveVerification(id, { ok: true, loggedIn: true, modelsObserved: ["Seedance 2.0 Mini"],
        remainingCredits: balance, totalCredits: 10, creditPageReady: true, createPageReady: true });
    }
    const job = store.createDraftJob({ idempotencyKey: "busy-login", enqueue: true,
      accountId: null, mode: "image_to_video", model: "Seedance 2.0 Mini", durationSeconds: 5,
      aspectRatio: "auto", prompt: "test", referenceAssets: [], priority: 50 });
    assert.equal(store.claimNextQueuedJob({ unavailableAccountIds: ["high", "low"] }), null);
    assert.equal(store.getJob(job.id).errorCode, "ACCOUNT_BROWSER_BUSY");
    assert.equal(store.getAccount("high").status, "ready");
    assert.equal(store.claimNextQueuedJob({ unavailableAccountIds: ["high"] }).account.id, "low");
    const before = store.getAccount("low");
    store.handleDispatchFailure(job.id, "low", "PROFILE_IN_USE", { beforeSubmission: true });
    assert.deepEqual(store.getAccount("low"), before);
    assert.equal(store.getJob(job.id).status, "queued");
    const retry = store.claimNextQueuedJob();
    assert.equal(retry.job.id, job.id);
    assert.equal(retry.account.id, "high");
    assert.equal(store.getAccount("high").creditsRemaining, 10);
    assert.equal(store.listJobs().length, 1);
    store.handleDispatchFailure(job.id, "high", "PROFILE_IN_USE", { beforeSubmission: true });
    store.cancelJob(job.id);
    const pinned = store.createDraftJob({ idempotencyKey: "busy-pinned-login", enqueue: true,
      accountId: "high", mode: "image_to_video", model: "Seedance 2.0 Mini", durationSeconds: 5,
      aspectRatio: "auto", prompt: "test", referenceAssets: [], priority: 50 });
    assert.equal(store.claimNextQueuedJob().account.id, "high");
    store.handleDispatchFailure(pinned.id, "high", "PROFILE_IN_USE", { beforeSubmission: true });
    assert.equal(store.getJob(pinned.id).status, "queued");
    assert.equal(store.getJob(pinned.id).requestedAccountId, "high");
    assert.equal(store.claimNextQueuedJob().job.id, pinned.id);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("server waits for login release and automatically executes without another verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-login-release-"));
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, `import fs from 'node:fs';import path from 'node:path';
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const job=JSON.parse(input);fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});
    fs.writeFileSync(job.outputPath,'test-result');
    console.log(JSON.stringify({stage:'success',resultPath:job.outputPath}));`);
  let loginOpen = true;
  const app = createWorkbenchServer({ port: await freePort(), workspaceRoot: root,
    databasePath: path.join(root, "test.sqlite"), generatedRoot: path.join(root, "generated"),
    workerPath, pythonExecutable: process.execPath, schedulerIntervalMs: 25,
    profileInUse: () => loginOpen, autoReverifyAfterQueuedJob: false });
  try {
    app.store.ensureAccount({ id: "login", label: "login", loginType: "doubao", service: "doubao",
      workerId: "pc", profilePath: path.join(root, "profile"), status: "auth_required" });
    app.store.saveVerification("login", { ok: true, loggedIn: true, modelsObserved: ["Seedance 2.0 Mini"],
      remainingCredits: 10, totalCredits: 10, creditPageReady: true, createPageReady: true });
    const job = app.store.createDraftJob({ idempotencyKey: "wait-login-release", enqueue: true,
      mode: "image_to_video", model: "Seedance 2.0 Mini", durationSeconds: 5, prompt: "test",
      referenceAssets: [], priority: 50 });
    await app.listen();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(app.store.getJob(job.id).status, "queued");
    assert.equal(app.store.getJob(job.id).errorCode, "ACCOUNT_BROWSER_BUSY");
    assert.equal(app.store.getAccount("login").status, "ready");
    loginOpen = false;
    for (let i = 0; i < 100 && app.store.getJob(job.id).status !== "success"; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(app.store.getJob(job.id).status, "success");
    assert.equal(app.store.listJobs().length, 1);
    assert.equal(app.store.listEvents().filter(event => event.eventType === "job.dispatched").length, 1);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("session expiry after submit preserves quota and never replays on a second account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-session-expired-"));
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, `for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({stage:'submitting'}));
    console.log(JSON.stringify({stage:'error',code:'LOGIN_EXPIRED_DURING_SUBMISSION'}));`);
  const app = createWorkbenchServer({ port: await freePort(), workspaceRoot: root,
    databasePath: path.join(root, "test.sqlite"), generatedRoot: path.join(root, "generated"),
    workerPath, pythonExecutable: process.execPath, schedulerIntervalMs: 25,
    profileInUse: () => false });
  try {
    for (const [id, balance] of [["high", 10], ["low", 5]]) {
      app.store.ensureAccount({ id, label: id, loginType: "doubao", service: "doubao",
        workerId: "pc", profilePath: path.join(root, id), status: "auth_required" });
      app.store.saveVerification(id, { ok: true, loggedIn: true, modelsObserved: ["Seedance 2.0 Mini"],
        remainingCredits: balance, totalCredits: 10, creditPageReady: true, createPageReady: true });
    }
    const job = app.store.createDraftJob({ idempotencyKey: "session-expired", enqueue: true,
      mode: "image_to_video", model: "Seedance 2.0 Mini", durationSeconds: 5,
      prompt: "test", referenceAssets: [], priority: 50 });
    await app.listen();
    for (let i = 0; i < 100; i++) {
      if (app.store.getJob(job.id).status === "reconciling" && !app.queueScheduler.runningCount) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    app.queueScheduler.wake();
    assert.equal(app.store.getJob(job.id).status, "reconciling");
    assert.equal(app.store.getJob(job.id).errorCode, "LOGIN_EXPIRED_DURING_SUBMISSION");
    assert.equal(app.store.getJob(job.id).accountId, "high");
    assert.equal(app.store.getAccount("high").status, "auth_required");
    assert.equal(app.store.getAccount("high").creditsRemaining, 10);
    assert.equal(app.store.getAccount("high").quotaExhaustedDate, null);
    assert.equal(app.store.getAccount("low").status, "ready");
    assert.equal(app.store.listJobs().length, 1);
    assert.equal(app.store.listEvents().filter(event => event.eventType === "job.dispatched").length, 1);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("HTTP queue runs one job per account and serves both completed results", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-queue-http-"));
  const port = await freePort();
  const imagePath = path.join(tempRoot, "image.png");
  const workerPath = path.join(tempRoot, "fake-worker.mjs");
  const verifierPath = path.join(tempRoot, "fake-verifier.mjs");
  fs.mkdirSync(path.join(tempRoot, "profile"));
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(verifierPath, `console.log(JSON.stringify({ ok: true, loggedIn: true,
    creditPageReady: true, createPageReady: true, remainingCredits: 8, totalCredits: 10,
    modelsObserved: ["Seedance 2.0 Mini"], stage: "completed" }));`, "utf8");
  fs.writeFileSync(workerPath, `import fs from "node:fs";
import path from "node:path";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input);
const marker = path.join(path.dirname(job.outputPath), "queue-markers.txt");
fs.mkdirSync(path.dirname(marker), { recursive: true });
fs.appendFileSync(marker, "start " + job.id + "\\n");
console.log(JSON.stringify({ stage: "submitting" }));
await new Promise((resolve) => setTimeout(resolve, 180));
console.log(JSON.stringify({ stage: "submitted", remoteUrl: "https://www.doubao.com/chat/123456" }));
fs.writeFileSync(job.outputPath, Buffer.from("fake-mp4"));
console.log(JSON.stringify({ stage: "success", resultPath: job.outputPath }));
fs.appendFileSync(marker, "end " + job.id + "\\n");`, "utf8");
  const app = createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "queue.sqlite"), workerPath, pythonExecutable: process.execPath,
    generatedRoot: path.join(tempRoot, "generated"), doubaoVerifierPath: verifierPath,
    schedulerIntervalMs: 25, maxConcurrentJobs: 2 });
  try {
    const account = app.store.ensureAccount({ id: "doubao-queue", label: "Queue Account", loginType: "doubao",
      service: "doubao", workerId: "pc", profilePath: path.join(tempRoot, "profile"), status: "auth_required" });
    app.store.saveVerification(account.id, { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: 9, totalCredits: 10,
      creditPageReady: true, createPageReady: true });
    await app.listen();
    const input = (prompt, enqueue) => ({ accountId: "auto", mode: "image_to_video",
      model: "Seedance 2.0 Mini", durationSeconds: 5, prompt, referenceAssets: [imagePath], enqueue });
    const first = await post(port, "/api/jobs", input("first", true));
    const second = await post(port, "/api/jobs", input("second", true));
    const third = await post(port, "/api/jobs", input("cancel me", false));
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(third.status, 201);
    const queued = await post(port, `/api/jobs/${third.body.job.id}/queue`);
    assert.equal(queued.status, 202);
    assert.equal(queued.body.job.status, "queued");
    const repeatQueue = await post(port, `/api/jobs/${third.body.job.id}/queue`);
    assert.equal(repeatQueue.status, 409);
    assert.equal(repeatQueue.body.error, "JOB_NOT_QUEUEABLE");
    assert.equal((await post(port, `/api/jobs/${third.body.job.id}/cancel`)).status, 200);

    const ids = [first.body.job.id, second.body.job.id];
    for (let i = 0; i < 100 && ids.some((id) => app.store.getJob(id).status !== "success"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(ids.map((id) => app.store.getJob(id).status), ["success", "success"]);
    assert.equal(app.store.getJob(third.body.job.id).status, "cancelled");
    for (let i = 0; i < 50 && app.queueScheduler.runningCount; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(app.store.getAccount(account.id).status, "ready");
    const markers = fs.readFileSync(path.join(tempRoot, "generated", "queue-markers.txt"), "utf8")
      .trim().split(/\r?\n/);
    assert.equal(markers.length, 4);
    let active = 0;
    for (const marker of markers) {
      active += marker.startsWith("start ") ? 1 : -1;
      assert.ok(active >= 0 && active <= 1, `account overlap: ${markers.join(", ")}`);
    }
    for (const id of ids) {
      const lookup = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`);
      assert.equal(lookup.status, 200);
      assert.equal((await lookup.json()).job.status, "success");
      const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}/result`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "fake-mp4");
    }
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("confirmed quota failure changes accounts, while uncertain submission is not replayed", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-queue-failover-"));
  const port = await freePort();
  const imagePath = path.join(tempRoot, "image.png");
  const workerPath = path.join(tempRoot, "fake-worker.mjs");
  const verifierPath = path.join(tempRoot, "fake-verifier.mjs");
  const highProfile = path.join(tempRoot, "high-profile");
  const lowProfile = path.join(tempRoot, "low-profile");
  fs.mkdirSync(highProfile);
  fs.mkdirSync(lowProfile);
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(verifierPath, `console.log(JSON.stringify({ ok: true, loggedIn: true,
    creditPageReady: true, createPageReady: true, remainingCredits: 5, totalCredits: 10,
    modelsObserved: ["Seedance 2.0 Mini"], stage: "completed" }));`, "utf8");
  fs.writeFileSync(workerPath, `import fs from "node:fs";
import path from "node:path";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input);
if (job.profilePath.includes("high-profile")) {
  console.log(JSON.stringify({ stage: "submitting" }));
  console.log(JSON.stringify({ stage: "submitted", remoteUrl: "https://www.doubao.com/chat/123456" }));
  console.log(JSON.stringify({ stage: "error", code: "DOUBAO_FREE_QUOTA_EXHAUSTED" }));
} else if (job.prompt === "uncertain") {
  console.log(JSON.stringify({ stage: "submitting" }));
  console.log(JSON.stringify({ stage: "error", code: "BROWSER_AUTOMATION_FAILED" }));
} else {
  fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
  fs.writeFileSync(job.outputPath, Buffer.from("success-after-failover"));
  console.log(JSON.stringify({ stage: "success", resultPath: job.outputPath }));
}`, "utf8");
  const app = createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "queue.sqlite"), workerPath, pythonExecutable: process.execPath,
    generatedRoot: path.join(tempRoot, "generated"), doubaoVerifierPath: verifierPath,
    schedulerIntervalMs: 25, maxConcurrentJobs: 2 });
  try {
    for (const [id, profilePath, credits] of [
      ["high", highProfile, 10], ["low", lowProfile, 5],
    ]) {
      app.store.ensureAccount({ id, label: id, loginType: "doubao", service: "doubao",
        workerId: "pc", profilePath, status: "auth_required" });
      app.store.saveVerification(id, { ok: true, loggedIn: true,
        modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: credits,
        totalCredits: 10, creditPageReady: true, createPageReady: true });
    }
    await app.listen();
    const body = (prompt) => ({ accountId: "auto", mode: "image_to_video",
      model: "auto", durationSeconds: 5, prompt, referenceAssets: [imagePath], enqueue: true });
    const first = await post(port, "/api/jobs", body("quota then success"));
    assert.equal(first.status, 202);
    const firstId = first.body.job.id;
    for (let i = 0; i < 120 && app.store.getJob(firstId).status !== "success"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(app.store.getJob(firstId).status, "success");
    assert.equal(app.store.getJob(firstId).accountId, "low");
    assert.equal(app.store.getJob(firstId).requestedAccountId, null);
    assert.equal(app.store.getJob(firstId).requestedModel, "auto");
    assert.equal(app.store.getAccount("high").status, "cooling");
    assert.equal(app.store.getAccount("high").creditsRemaining, 0);
    app.store.saveVerification("high", { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: 10,
      totalCredits: 10, creditPageReady: true, createPageReady: true });
    assert.equal(app.store.getAccount("high").status, "cooling");
    assert.equal(app.store.getAccount("high").creditsRemaining, 0);
    app.store.saveVerificationFailure("high", "VERIFIER_FAILED");
    assert.equal(app.store.getAccount("high").status, "cooling");
    assert.ok(app.store.listEvents().some((event) => event.jobId === firstId
      && event.eventType === "job.failover_queued"));
    const result = await fetch(`http://127.0.0.1:${port}/api/jobs/${firstId}/result`);
    assert.equal(await result.text(), "success-after-failover");

    const second = await post(port, "/api/jobs", body("uncertain"));
    const secondId = second.body.job.id;
    for (let i = 0; i < 120 && app.store.getJob(secondId).status !== "reconciling"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(app.store.getJob(secondId).status, "reconciling");
    assert.equal(app.store.getJob(secondId).accountId, "low");
    assert.ok(!app.store.listEvents().some((event) => event.jobId === secondId
      && event.eventType === "job.failover_queued"));
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
