import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchServer } from "../server.mjs";
import { DAY, digest, signature } from "../lib/partner-protocol.mjs";

const key = "test-only-partner-key-never-use-in-production";
const downloadSecret = "test-only-download-secret-never-use-in-production";
const webhookSecret = "test-only-webhook-secret-never-use-in-production";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64");
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom\0\0\0\0isomiso2"), Buffer.alloc(100, 93)]);
const input = (id, count = 1) => ({ client_task_id: id, model: "Seedance 2.0 Mini", duration: 5,
  ratio: "9:16", count, prompt: "海边日落", negative_prompt: "不要文字和水印" });
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-partner-"));
  const port = await freePort();
  const options = { port, databasePath: path.join(root, "db.sqlite"), uploadRoot: path.join(root, "uploads"),
    generatedRoot: path.join(root, "generated"), workspaceRoot: root,
    pythonExecutable: path.join(root, "disabled-worker"), workerPath: path.join(root, "disabled-worker.py"),
    partnerApi: { apiKey: key, downloadSecret, webhookSecret, intervalMs: 60_000, ...overrides.partnerApi },
    ...overrides };
  if (overrides.partnerApi) options.partnerApi = { apiKey: key, downloadSecret, webhookSecret,
    intervalMs: 60_000, ...overrides.partnerApi };
  overrides.prepare?.(options, root);
  let app = createWorkbenchServer(options);
  await app.listen();
  await app.partnerApi.wake();
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  return { root, port, url, get app() { return app; },
    async restart() { await app.close(); app = createWorkbenchServer(options); await app.listen(); await app.partnerApi.wake(); },
    async request(route, body, headers = {}) {
      const multipart = body instanceof FormData;
      const response = await fetch(url + route, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${key}`, Connection: "close",
          ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }), ...headers },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async finish(item, state = "success") {
      let resultPath;
      if (state === "success") {
        resultPath = path.join(root, "generated", `${item.job_id}.mp4`);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, mp4);
      }
      app.store.updateJob(item.job_id, { status: state, resultPath,
        errorCode: state === "failed" ? "BROWSER_AUTOMATION_FAILED" : undefined });
    },
  };
}

test("partner authentication, strict parameters, and same-request image upload with atomic idempotency", async (t) => {
  const f = await fixture(t);
  const unauthorized = await f.request("/v1/models", undefined, { Authorization: "Bearer incorrect" });
  assert.equal(unauthorized.status, 401);
  const models = await f.request("/v1/models");
  assert.equal(models.body.models.length, 3);
  const spec = await f.request("/v1/openapi.json");
  assert.equal(spec.status, 200);
  assert.equal(spec.body.openapi, "3.1.0");
  assert.equal(spec.body.servers[0].url, `${f.url}/v1`);
  assert.deepEqual(spec.body.components.schemas.TaskRequest.properties.model.enum,
    models.body.models.map((model) => model.model));
  for (const change of [{ resolution: "1080p" }, { count: 0 }, { count: "2" }, { prompt: " " },
    { client_task_id: "../unsafe" }, { negative_prompt: "a".repeat(2001) }]) {
    assert.equal((await f.request("/v1/videos", { ...input("invalid"), ...change })).status, 400);
  }
  assert.equal((await f.request("/v1/videos", { ...input("invalid-model"), duration: 12 })).status, 422);
  assert.equal((await f.request("/v1/videos", { ...input("invalid-url"), callback_url: "https://receiver.example/result" })).status, 422);
  const make = (bytes = png) => {
    const form = new FormData();
    form.set("task", JSON.stringify(input("upload-1", 5)));
    form.append("images", new Blob([bytes], { type: "image/png" }), "reference.png");
    form.append("images", new Blob([png], { type: "image/png" }), "second.png");
    return form;
  };
  const submissions = await Promise.all([f.request("/v1/videos", make()), f.request("/v1/videos", make())]);
  assert.deepEqual(submissions.map((r) => r.status).sort(), [200, 202]);
  assert.equal(submissions[0].body.task_id, submissions[1].body.task_id);
  const id = submissions[0].body.task_id;
  await f.app.partnerApi.wake();
  let task = f.app.partnerApi.store.get(id);
  assert.equal(task.items.filter((i) => i.job_id).length, 2);
  assert.equal(task.assets.length, 2);
  assert.deepEqual(fs.readFileSync(task.assets[0].path), png);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "uploads", "partner")), [id]);
  const job = f.app.store.getJob(task.items[0].job_id);
  assert.equal(job.negativePrompt, input("x").negative_prompt);
  assert.equal(job.concurrency, 1);
  assert.equal(job.batchSize, 5);
  assert.equal((await f.request("/v1/videos", make(Buffer.concat([png, Buffer.from("changed")])))).status, 409);
  await f.restart();
  assert.equal((await f.request("/v1/videos", make())).body.task_id, id);
  task = f.app.partnerApi.store.get(id);
  assert.equal(task.items.filter((i) => i.job_id).length, 2);
  assert.equal(task.assets.length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, "db.sqlite")).includes(Buffer.from(key)), false);
});

test("five outputs advance 2+2+1, persist callback batches, and stream original bytes with renewable links", async (t) => {
  let time = Date.now();
  const f = await fixture(t, { partnerNow: () => time });
  const accepted = await f.request("/v1/videos", input("five", 5));
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.results.length, 5);
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  let task = f.app.partnerApi.store.get(id);
  await f.finish(task.items[0]);
  await f.app.partnerApi.wake();
  assert.equal(f.app.partnerApi.store.get(id).items.filter((i) => i.job_id).length, 2);
  await f.finish(task.items[1]);
  await f.app.partnerApi.wake();
  task = f.app.partnerApi.store.get(id);
  assert.equal(task.items.filter((i) => i.job_id).length, 4);
  assert.equal(f.app.partnerApi.store.deliverySummary(id).length, 1);
  await f.finish(task.items[2], "failed");
  await f.finish(task.items[3]);
  await f.app.partnerApi.wake();
  task = f.app.partnerApi.store.get(id);
  assert.equal(task.items.filter((i) => i.job_id).length, 5);
  await f.finish(task.items[4]);
  await f.app.partnerApi.wake();
  let response = await f.request(`/v1/videos/${id}`);
  assert.equal(response.body.status, "partially_succeeded");
  assert.equal(response.body.completed_count, 5);
  assert.equal(response.body.succeeded_count, 4);
  assert.equal(response.body.webhooks.length, 3);
  assert.equal(response.body.results[2].error.code, "GENERATION_FAILED");
  assert.equal(response.body.results[0].sha256, digest(mp4));
  const signed = response.body.results[0].video_url;
  const all = await fetch(signed);
  assert.equal(all.status, 200);
  assert.deepEqual(Buffer.from(await all.arrayBuffer()), mp4);
  const partial = await fetch(signed, { headers: { Range: "bytes=5-19" } });
  assert.equal(partial.status, 206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), mp4.subarray(5, 20));
  const suffix = await fetch(signed, { headers: { Range: "bytes=-4" } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), mp4.subarray(-4));
  const head = await fetch(signed, { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), mp4.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(signed, { headers: { Range: "bytes=900-999" } })).status, 416);
  assert.equal((await fetch(signed, { headers: { Range: "bytes=0-1,3-4" } })).status, 416);
  const tampered = new URL(signed); tampered.searchParams.set("signature", "0".repeat(64));
  assert.equal((await fetch(tampered)).status, 403);
  time += DAY + 1000;
  assert.equal((await fetch(signed)).status, 403);
  response = await f.request(`/v1/videos/${id}`);
  assert.notEqual(response.body.results[0].video_url, signed);
  assert.equal((await fetch(response.body.results[0].video_url)).status, 200);
  await f.restart();
  assert.equal(f.app.partnerApi.store.deliverySummary(id).length, 3);
  assert.equal(f.app.store.listJobs().length, 5);
  time += 7 * DAY;
  await f.app.partnerApi.wake();
  assert.equal((await f.request(`/v1/videos/${id}`)).body.results[0].video_url, null);
  const expired = await fetch(`${f.url}/v1/videos/${id}/results/1`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(expired.status, 410);
  assert.equal(fs.existsSync(path.join(f.root, "generated", `${task.items[0].job_id}.mp4`)), false);
});

test("cancel stops future rounds and account failover while preserving a submitted result", async (t) => {
  const f = await fixture(t);
  const accepted = await f.request("/v1/videos", input("cancel-active", 5));
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  for (const [accountId, balance] of [["high", 10], ["low", 5]]) {
    f.app.store.ensureAccount({ id: accountId, label: accountId, loginType: "doubao", service: "doubao",
      workerId: "pc", profilePath: path.join(f.root, accountId), status: "auth_required" });
    f.app.store.saveVerification(accountId, { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: balance, totalCredits: 10,
      creditPageReady: true, createPageReady: true });
  }
  const first = f.app.store.claimNextQueuedJob();
  const second = f.app.store.claimNextQueuedJob();
  assert.equal(first.account.id, "high");
  f.app.store.updateJob(first.job.id, { status: "submitting" });
  f.app.store.updateJob(second.job.id, { status: "submitted" });
  const cancelled = await f.request(`/v1/videos/${id}/cancel`, {});
  assert.equal(cancelled.body.status, "cancelling");
  assert.equal(cancelled.body.cancelled_count, 3);
  const failed = f.app.store.handleDispatchFailure(first.job.id, first.account.id, "DOUBAO_FREE_QUOTA_EXHAUSTED", { quotaExhausted: true });
  assert.equal(failed.status, "cancelled");
  assert.equal(f.app.store.getAccount("high").creditsRemaining, 0);
  const task = f.app.partnerApi.store.get(id);
  await f.finish(task.items.find((i) => i.job_id === second.job.id));
  await f.app.partnerApi.wake();
  const result = await f.request(`/v1/videos/${id}`);
  assert.equal(result.body.status, "cancelled");
  assert.equal(result.body.succeeded_count, 1);
  assert.equal(result.body.cancelled_count, 4);
  assert.equal(f.app.store.listJobs().length, 2);
  assert.equal(f.app.store.claimNextQueuedJob(), null);
  assert.equal((await f.request(`/v1/videos/${id}/cancel`, {})).body.status, "cancelled");
});

test("ambiguous submission survives restart as reconciling without duplicate generation", async (t) => {
  const f = await fixture(t);
  const accepted = await f.request("/v1/videos", input("uncertain", 4));
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  let task = f.app.partnerApi.store.get(id);
  f.app.store.updateJob(task.items[0].job_id, { status: "submitting" });
  await f.finish(task.items[1]);
  await f.restart();
  task = f.app.partnerApi.store.get(id);
  assert.equal(task.state, "reconciling");
  assert.equal(task.items.filter((i) => i.job_id).length, 2);
  assert.equal((await f.request("/v1/videos", input("uncertain", 4))).status, 200);
});

test("webhook retries persist across restart with the same ID/body, HMAC, and no new jobs", async (t) => {
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received.push({ raw, headers: req.headers });
    res.writeHead(received.length === 1 ? 500 : 204); res.end();
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const callback = `http://127.0.0.1:${receiver.address().port}/result`;
  let time = Date.now();
  const f = await fixture(t, { partnerNow: () => time,
    partnerApi: { allowLocalCallbacks: true, callbackUrls: [callback] } });
  const accepted = await f.request("/v1/videos", { ...input("callback", 2), callback_url: callback });
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  for (const item of f.app.partnerApi.store.get(id).items) await f.finish(item);
  await f.app.partnerApi.wake();
  await f.app.partnerApi.deliver();
  assert.equal(received.length, 1);
  const event = JSON.parse(received[0].raw);
  assert.equal(event.is_final, true);
  assert.equal(event.results.length, 2);
  assert.equal(event.batch_index, 1);
  assert.equal(event.client_task_id, "callback");
  assert.equal(received[0].headers["x-webhook-signature"], `sha256=${signature(webhookSecret,
    `${received[0].headers["x-webhook-timestamp"]}.${received[0].raw}`)}`);
  await f.restart();
  assert.equal(received.length, 1);
  time += 11_000;
  await f.app.partnerApi.deliver();
  assert.equal(received.length, 2);
  assert.equal(received[0].raw, received[1].raw);
  assert.equal(received[0].headers["x-webhook-id"], received[1].headers["x-webhook-id"]);
  assert.equal(f.app.partnerApi.store.deliverySummary(id)[0].state, "delivered");
  assert.equal(f.app.store.listJobs().length, 2);
});

test("unconfigured API stays closed, queue cap and rate limit return actionable errors", async (t) => {
  const closed = await fixture(t, { partnerApi: { apiKey: "", downloadSecret: "", webhookSecret: "" } });
  assert.equal((await closed.request("/v1/models")).body.error.code, "API_NOT_CONFIGURED");
  const capped = await fixture(t, { partnerApi: { maxPendingTasks: 1 } });
  const first = await capped.request("/v1/videos", input("cap-1"));
  assert.equal(first.status, 202);
  assert.equal((await capped.request("/v1/videos", input("cap-1"))).status, 200);
  assert.equal((await capped.request("/v1/videos", input("cap-2"))).body.error.code, "QUEUE_FULL");
  assert.equal((await capped.request(`/v1/videos/${first.body.task_id}/cancel`, {})).body.status, "cancelled");
  assert.equal((await capped.request("/v1/videos", input("cap-2"))).status, 202);
  const limited = await fixture(t, { partnerApi: { requestsPerMinute: 1 } });
  assert.equal((await limited.request("/v1/models")).status, 200);
  const exceeded = await limited.request("/v1/models");
  assert.equal(exceeded.status, 429);
  assert.ok(Number(exceeded.headers.get("retry-after")) > 0);
});

test("accepted text task executes through the shared browser queue and finishes all rounds", async (t) => {
  const f = await fixture(t, { prepare(options, root) {
    options.pythonExecutable = process.execPath;
    options.workerPath = path.join(root, "worker.mjs");
    options.doubaoVerifierPath = path.join(root, "verify.mjs");
    options.schedulerIntervalMs = 25;
    options.partnerApi.intervalMs = 25;
    fs.mkdirSync(path.join(root, "profile"));
    fs.writeFileSync(options.doubaoVerifierPath, `console.log(JSON.stringify({ ok: true, loggedIn: true,
      creditPageReady: true, createPageReady: true, remainingCredits: 8, totalCredits: 10,
      modelsObserved: ["Seedance 2.0 Mini"], stage: "completed" }));`);
    fs.writeFileSync(options.workerPath, `import fs from "node:fs"; import path from "node:path";
      let data=""; for await (const chunk of process.stdin) data+=chunk; const job=JSON.parse(data);
      if(job.referenceAssets.length || job.negativePrompt !== "不要文字和水印") process.exit(1);
      console.log(JSON.stringify({stage:"submitting"}));
      console.log(JSON.stringify({stage:"submitted",remoteUrl:"https://www.doubao.com/chat/123456"}));
      fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});
      fs.writeFileSync(job.outputPath,Buffer.from("${mp4.toString("base64")}","base64"));
      console.log(JSON.stringify({stage:"success",resultPath:job.outputPath}));`);
  } });
  f.app.store.ensureAccount({ id: "browser", label: "Browser", loginType: "doubao", service: "doubao",
    workerId: "pc", profilePath: path.join(f.root, "profile"), status: "auth_required" });
  f.app.store.saveVerification("browser", { ok: true, loggedIn: true, modelsObserved: ["Seedance 2.0 Mini"],
    remainingCredits: 9, totalCredits: 10, creditPageReady: true, createPageReady: true });
  const accepted = await f.request("/v1/videos", input("real-queue", 3));
  let task;
  const deadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    task = f.app.partnerApi.store.get(accepted.body.task_id);
  } while (!task.finished_at && Date.now() < deadline);
  assert.equal(task.state, "succeeded");
  assert.equal(task.items.length, 3);
  assert.equal(f.app.partnerApi.store.deliverySummary(task.id).length, 2);
});
