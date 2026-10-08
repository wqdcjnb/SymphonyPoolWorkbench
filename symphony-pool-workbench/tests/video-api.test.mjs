import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkbenchServer } from "../server.mjs";
import { createVideoApiStore } from "../lib/video-api-store.mjs";
import { createVideoApiScheduler } from "../lib/video-api-scheduler.mjs";
import { apiKeyFingerprint } from "../lib/nocsnow-api.mjs";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function eventually(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error("TEST_TIMED_OUT");
}

test("a two-video turn waits for both global slots when polling sees staggered completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-api-full-turn-"));
  const store = (await createVideoApiStore(path.join(root, "test.sqlite")));
  const a = apiKeyFingerprint("test-key-turn-a");
  const b = apiKeyFingerprint("test-key-turn-b");
  const payload = { model: "video-production-seedance-20", prompt: "test", negative_prompt: "",
    ratio: "9:16", duration: 5, resolution: "720p", reference_asset_ids: [], count: 2 };
  try {
    (await store.enqueue(a, "turn-a-123456", payload));
    (await store.enqueue(b, "turn-b-123456", payload));
    const first = (await store.reserveNextTurn([a, b], 2));
    const taskIds = [randomUUID(), randomUUID()];
    (await store.acceptTurn(first.id, { data: { tasks: taskIds.map(id => ({ id, status: "queued" })) } }));
    (await store.updateTask(a, taskIds[0], { data: { id: taskIds[0], status: "succeeded" } }));
    assert.equal((await store.reserveNextTurn([a, b], 2)), null, "one available slot cannot split a two-video turn");
    (await store.updateTask(a, taskIds[1], { data: { id: taskIds[1], status: "succeeded" } }));
    const next = (await store.reserveNextTurn([a, b], 2));
    assert.equal(next.fingerprint, b);
    assert.equal(next.count, 2);
  } finally {
    (await store.close());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("video API queues two per key, rotates users, and never persists keys", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-video-api-test-"));
  const databasePath = path.join(tempRoot, "test.sqlite");
  const mockPort = await freePort();
  const port = await freePort();
  const keyA = "test-key-A-super-secret";
  const keyB = "test-key-B-super-secret";
  const calls = [];
  const tasks = new Map();
  const idempotency = new Map();
  const uploads = [];
  const mock = http.createServer(async (request, response) => {
    const requestPath = new URL(request.url, `http://127.0.0.1:${mockPort}`).pathname;
    const key = String(request.headers.authorization || "").replace(/^Bearer /, "");
    response.setHeader("Content-Type", "application/json");
    if (![keyA, keyB].includes(key)) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
      return;
    }
    if (request.method === "GET" && requestPath === "/api/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "video-production-seedance-20", name: "Seedance 2.0",
        points_cost: 10, config: { durations: [5, 10], ratios: ["9:16", "16:9"],
          resolutions: ["720p"] } }] }));
      return;
    }
    if (request.method === "POST" && requestPath === "/api/v1/uploads") {
      const bytes = [];
      for await (const chunk of request) bytes.push(chunk);
      uploads.push({ key, mime: request.headers["content-type"], bytes: Buffer.concat(bytes) });
      response.writeHead(201);
      response.end(JSON.stringify({ data: { id: randomUUID() } }));
      return;
    }
    if (request.method === "POST" && requestPath === "/api/v1/generations") {
      const bytes = [];
      for await (const chunk of request) bytes.push(chunk);
      const payload = JSON.parse(Buffer.concat(bytes).toString("utf8"));
      assert.ok(payload.count >= 1 && payload.count <= 2);
      const token = `${key}:${request.headers["idempotency-key"]}`;
      if (!idempotency.has(token)) {
        const created = Array.from({ length: payload.count }, () => {
          const task = { id: randomUUID(), status: "queued", result_url: null };
          tasks.set(task.id, { ...task, key });
          return task;
        });
        idempotency.set(token, { data: { tasks: created } });
        calls.push({ key, count: payload.count, idempotencyKey: request.headers["idempotency-key"],
          taskIds: created.map((task) => task.id) });
      }
      response.writeHead(202);
      response.end(JSON.stringify(idempotency.get(token)));
      return;
    }
    const taskMatch = requestPath.match(/^\/api\/v1\/generations\/([^/]+)(\/result)?$/);
    if (request.method === "GET" && taskMatch) {
      const task = tasks.get(taskMatch[1]);
      if (!task || task.key !== key) { response.writeHead(404); response.end("{}"); return; }
      if (taskMatch[2]) {
        if (task.status !== "succeeded") { response.writeHead(409); response.end("{}"); return; }
        response.writeHead(200, { "Content-Type": "video/mp4" });
        response.end(Buffer.from("mock-mp4"));
      } else response.end(JSON.stringify({ data: { id: task.id, status: task.status,
        result_url: task.status === "succeeded" ? `/api/v1/generations/${task.id}/result` : null } }));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));
  const app = (await createWorkbenchServer({ port, workspaceRoot: tempRoot, databasePath,
    generatedRoot: path.join(tempRoot, "generated"),
    videoApiBaseUrl: `http://127.0.0.1:${mockPort}/api/v1`,
    videoApiSchedulerIntervalMs: 25, videoApiMaxActiveTasks: 2 }));
  const root = `http://127.0.0.1:${port}`;
  const headers = (key, idempotencyKey) => ({ Authorization: `Bearer ${key}`,
    "Content-Type": "application/json", "Idempotency-Key": idempotencyKey });
  const body = (count) => JSON.stringify({ model: "video-production-seedance-20",
    prompt: "A cat in snow", negative_prompt: "no text", ratio: "9:16", duration: 5,
    resolution: "720p", reference_asset_ids: [], count });
  const completeCall = (call, status = "succeeded") => call.taskIds.forEach((id) => {
    tasks.get(id).status = status;
  });
  try {
    await app.listen();
    const localDraft = (await app.store.createDraftJob({ idempotencyKey: "local-draft-unified-list",
      accountId: null, mode: "image_to_video", model: "auto", durationSeconds: 5,
      prompt: "Local account pool draft", referenceAssets: [], priority: 50 }));
    assert.equal((await fetch(`${root}/api/video-provider/models`)).status, 401);
    const models = await fetch(`${root}/api/video-provider/models`, { headers: headers(keyA) });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].name, "Seedance 2.0");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploaded = await fetch(`${root}/api/video-provider/uploads`, { method: "POST", body: png,
      headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "image/png" } });
    assert.equal(uploaded.status, 201);
    assert.ok((await uploaded.json()).data.id);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].key, keyA);

    const first = await fetch(`${root}/api/video-provider/generations`, { method: "POST",
      headers: headers(keyA, "batch-A-123456"), body: body(5) });
    assert.equal(first.status, 202);
    const batchA = (await first.json()).batch;
    const second = await fetch(`${root}/api/video-provider/generations`, { method: "POST",
      headers: headers(keyB, "batch-B-123456"), body: body(2) });
    assert.equal(second.status, 202);
    const batchB = (await second.json()).batch;
    await eventually(() => calls.length === 1);
    assert.deepEqual(calls.map((call) => [call.key, call.count]), [[keyA, 2]]);
    await eventually(async () => {
      const response = await fetch(`${root}/api/workbench/jobs?status=active`);
      const listing = await response.json();
      return listing.total === 1 && listing.jobs[0]?.providerBatchId === batchA.id
        && listing.jobs[0]?.status === "generating";
    });
    completeCall(calls[0]);
    await eventually(() => calls.length >= 2);
    assert.deepEqual(calls.slice(0, 2).map((call) => [call.key, call.count]),
      [[keyA, 2], [keyB, 2]]);
    completeCall(calls[1], "failed");
    await eventually(() => calls.length >= 3);
    assert.deepEqual(calls.slice(0, 3).map((call) => [call.key, call.count]),
      [[keyA, 2], [keyB, 2], [keyA, 2]]);
    completeCall(calls[2]);
    await eventually(() => calls.length >= 4);
    assert.deepEqual(calls.map((call) => [call.key, call.count]),
      [[keyA, 2], [keyB, 2], [keyA, 2], [keyA, 1]]);
    completeCall(calls[3]);
    await eventually(async () => {
      const history = await fetch(`${root}/api/video-provider/history`, { headers: headers(keyA) });
      return (await history.json()).batches[0]?.status === "completed";
    });
    const own = await fetch(`${root}/api/video-provider/history`, { headers: headers(keyA) });
    const ownBatches = (await own.json()).batches;
    assert.equal(ownBatches.length, 1);
    assert.equal(ownBatches[0].id, batchA.id);
    assert.equal(ownBatches[0].tasks.length, 5);
    const other = await fetch(`${root}/api/video-provider/history`, { headers: headers(keyB) });
    assert.equal((await other.json()).batches[0].id, batchB.id);
    await eventually(async () => {
      const response = await fetch(`${root}/api/workbench/jobs?status=success&pageSize=6`);
      const listing = await response.json();
      const item = listing.jobs.find((job) => job.providerBatchId === batchA.id);
      return item?.tasks.length === 5 && item.tasks.every((task) => task.resultReady);
    });
    const unifiedResponse = await fetch(`${root}/api/workbench/jobs?pageSize=2`);
    const unified = await unifiedResponse.json();
    assert.equal(unified.total, 3);
    assert.equal(unified.totalPages, 2);
    const nextPage = await (await fetch(`${root}/api/workbench/jobs?page=2&pageSize=2`)).json();
    assert.deepEqual(new Set([...unified.jobs, ...nextPage.jobs].map((job) => job.id)),
      new Set([localDraft.id, `video-api:${batchA.id}`, `video-api:${batchB.id}`]));
    assert.ok(unified.jobs.some((job) => job.source === "video_api")
      || nextPage.jobs.some((job) => job.source === "video_api"));
    assert.ok(!JSON.stringify([...unified.jobs, ...nextPage.jobs]).includes(keyA));
    const saved = await fetch(`${root}/api/workbench/video-results/${calls[0].taskIds[0]}`);
    assert.equal(saved.status, 200);
    assert.equal(await saved.text(), "mock-mp4");
    const succeeded = await (await fetch(`${root}/api/workbench/jobs?status=success`)).json();
    assert.equal(succeeded.total, 1);
    assert.ok(succeeded.jobs.every((job) => job.source === "video_api"));
    const failed = await (await fetch(`${root}/api/workbench/jobs?status=failed`)).json();
    assert.equal(failed.total, 1);
    assert.equal(failed.jobs[0].providerBatchId, batchB.id);
    const repeated = await fetch(`${root}/api/video-provider/generations`, { method: "POST",
      headers: headers(keyA, "batch-A-123456"), body: body(5) });
    assert.equal((await repeated.json()).batch.id, batchA.id);
    assert.equal(calls.length, 4);
    const conflict = await fetch(`${root}/api/video-provider/generations`, { method: "POST",
      headers: headers(keyA, "batch-A-123456"), body: body(4) });
    assert.equal(conflict.status, 409);
    const result = await fetch(`${root}/api/video-provider/generations/${calls[0].taskIds[0]}/result`,
      { headers: headers(keyA) });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "mock-mp4");
    const sqlite = fs.readFileSync(databasePath).toString("latin1");
    assert.ok(!sqlite.includes(keyA) && !sqlite.includes(keyB));
  } finally {
    await app.close();
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("two slots are shared across a key's batches and queue resumes after key re-entry", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-video-api-resume-test-"));
  const databasePath = path.join(tempRoot, "test.sqlite");
  const keyA = "resume-test-key-A";
  const keyB = "resume-test-key-B";
  const calls = [];
  const taskStatus = new Map();
  const client = {
    async create(key, payload) {
      const taskIds = Array.from({ length: payload.count }, () => randomUUID());
      for (const id of taskIds) taskStatus.set(id, "queued");
      calls.push({ key, count: payload.count, taskIds });
      return { data: { tasks: taskIds.map((id) => ({ id, status: "queued" })) } };
    },
    async task(_key, taskId) { return { data: { id: taskId, status: taskStatus.get(taskId) } }; },
  };
  const payload = (count) => ({ model: "video-production-seedance-20", prompt: "test",
    negative_prompt: "", ratio: "9:16", duration: 5, resolution: "720p",
    reference_asset_ids: [], generate_audio: false, count });
  let store = (await createVideoApiStore(databasePath));
  let scheduler = createVideoApiScheduler({ store, client, intervalMs: 25, maxActiveTasks: 4 });
  try {
    (await store.enqueue(apiKeyFingerprint(keyA), "resume-A-one", payload(3)));
    (await store.enqueue(apiKeyFingerprint(keyA), "resume-A-two", payload(2)));
    (await store.enqueue(apiKeyFingerprint(keyB), "resume-B-one", payload(2)));
    scheduler.start();
    scheduler.attach(keyA);
    scheduler.attach(keyB);
    await eventually(() => calls.length === 2);
    assert.deepEqual(calls.map((call) => [call.key, call.count]), [[keyA, 2], [keyB, 2]]);
    await scheduler.stop();
    (await store.close());
    store = (await createVideoApiStore(databasePath));
    scheduler = createVideoApiScheduler({ store, client, intervalMs: 25, maxActiveTasks: 4 });
    scheduler.start();
    calls[0].taskIds.forEach((id) => taskStatus.set(id, "succeeded"));
    await delay(100);
    assert.equal(calls.length, 2, "restart must not submit without the requester's Key");
    scheduler.attach(keyA);
    await eventually(() => calls.length === 3);
    assert.deepEqual([calls[2].key, calls[2].count], [keyA, 2]);
    calls[2].taskIds.forEach((id) => taskStatus.set(id, "succeeded"));
    await eventually(() => calls.length === 4);
    assert.deepEqual([calls[3].key, calls[3].count], [keyA, 1]);
  } finally {
    await scheduler.stop();
    (await store.close());
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
