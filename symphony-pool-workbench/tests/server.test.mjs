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

test("feature routes render direct links with the matching active page", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-routes-test-"));
  const port = await freePort();
  const app = createWorkbenchServer({ port, databasePath: path.join(tempRoot, "test.sqlite") });
  try {
    await app.listen();
    for (const [route, page] of [["/", "jobs"],
      ["/accounts", "accounts"], ["/jobs", "jobs"],
      ["/events", "events"],
      ["/api-docs", "api-docs"],
      ["/index.html", "jobs"]]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type"), /^text\/html/);
      const html = await response.text();
      assert.match(html, new RegExp(`<section id="${page}" class="panel-section active-section">`));
      assert.match(html, new RegExp(`aria-current="page" href="/${page}"`));
      assert.equal((html.match(/class="panel-section active-section"/g) || []).length, 1);
      assert.match(html, /src="\/js\/app\.js"/);
      assert.doesNotMatch(html, /id="overview"|href="\/overview"|id="primaryAccount"|id="metricGrid"/);
      if (page === "jobs") {
        assert.match(html, /<h2>工作台<\/h2>/);
        assert.match(html, /<option value="active">正在生成<\/option>/);
        assert.match(html, /aria-current="page" href="\/jobs"[^>]*>.*工作台<\/a>/);
        assert.doesNotMatch(html, /jobTabPool|jobTabApi|id="videoApiForm"/);
        assert.doesNotMatch(html, /href="\/video-api"/);
        assert.match(html, /name="positivePrompt"/);
        assert.match(html, /name="negativePrompt"/);
        assert.match(html, /name="concurrency"/);
        assert.match(html, /id="jobStartButton"[^>]*>开始生成<\/button>/);
        assert.doesNotMatch(html, /id="jobSaveButton"|保存草稿|保存并开始生成/);
        assert.doesNotMatch(html, /id="jobMode"|id="jobVideoFile"|value="auto">自动选择模型/);
        assert.doesNotMatch(html, /jobRoutingHint|jobReferenceNote|平台没有独立负面提示词输入框|一次使用对应数量的不同账号/);
        assert.equal((html.match(/name="aspectRatio"/g) || []).length, 1);
      }
    }
    const legacy = await fetch(`http://127.0.0.1:${port}/video-api`, { redirect: "manual" });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/jobs");
    const removedPage = await fetch(`http://127.0.0.1:${port}/overview`, { redirect: "manual" });
    assert.equal(removedPage.status, 302);
    assert.equal(removedPage.headers.get("location"), "/jobs");
    const oldTab = await fetch(`http://127.0.0.1:${port}/jobs?tab=api`, { redirect: "manual" });
    assert.equal(oldTab.status, 302);
    assert.equal(oldTab.headers.get("location"), "/jobs");
    assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/js/app.js`)).status, 200);
    const docs = await fetch(`http://127.0.0.1:${port}/api-docs/openapi.json`);
    assert.equal(docs.status, 200);
    assert.equal((await docs.json()).openapi, "3.1.0");
    const example = await fetch(`http://127.0.0.1:${port}/api-docs/task-example.json`);
    assert.equal(example.status, 200);
    assert.equal((await example.json()).count, 4);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("job list paginates completed, failed and active jobs", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-jobs-page-test-"));
  const port = await freePort();
  const app = createWorkbenchServer({ port, databasePath: path.join(tempRoot, "test.sqlite") });
  try {
    await app.listen();
    for (let index = 0; index < 15; index += 1) {
      const job = app.store.createDraftJob({
        idempotencyKey: `page-test-${index}`, accountId: null, mode: "image_to_video",
        model: "auto", durationSeconds: 5, prompt: `任务 ${index}`,
        referenceAssets: [], priority: 50,
      });
      if (index < 10) app.store.updateJob(job.id, { status: "success" });
      else if (index < 13) app.store.updateJob(job.id, { status: "failed", errorCode: "TEST_FAILURE" });
    }
    const activeStatuses = ["leased", "submitting", "submitted", "generating", "collecting",
      "leased", "generating"];
    for (const [index, status] of [...activeStatuses, "queued", "reconciling"].entries()) {
      const job = app.store.createDraftJob({ idempotencyKey: `active-page-${index}`,
        accountId: null, mode: "image_to_video", model: "auto", durationSeconds: 5,
        prompt: `进行中 ${index}`, referenceAssets: [], priority: 50 });
      app.store.updateJob(job.id, { status });
    }

    const first = await get(port, "/api/jobs?status=success&page=1&pageSize=6");
    const second = await get(port, "/api/jobs?status=success&page=2&pageSize=6");
    assert.equal(first.status, 200);
    assert.equal(first.body.total, 10);
    assert.equal(first.body.totalPages, 2);
    assert.equal(first.body.jobs.length, 6);
    assert.equal(second.body.jobs.length, 4);
    assert.ok(first.body.jobs.every((job) => job.status === "success"));
    assert.ok(second.body.jobs.every((job) => job.status === "success"));
    assert.equal(new Set([...first.body.jobs, ...second.body.jobs].map((job) => job.id)).size, 10);

    const failed = await get(port, "/api/jobs?status=failed&page=1&pageSize=6");
    assert.equal(failed.body.total, 3);
    assert.ok(failed.body.jobs.every((job) => job.status === "failed"));

    const activeFirst = await get(port, "/api/jobs?status=active&page=1&pageSize=6");
    const activeSecond = await get(port, "/api/jobs?status=active&page=2&pageSize=6");
    assert.equal(activeFirst.status, 200);
    assert.equal(activeFirst.body.total, 7);
    assert.equal(activeFirst.body.totalPages, 2);
    assert.equal(activeFirst.body.jobs.length, 6);
    assert.equal(activeSecond.body.jobs.length, 1);
    assert.ok([...activeFirst.body.jobs, ...activeSecond.body.jobs]
      .every((job) => activeStatuses.includes(job.status)));
    assert.equal(new Set([...activeFirst.body.jobs, ...activeSecond.body.jobs]
      .map((job) => job.id)).size, 7);
    const unifiedActive = await get(port, "/api/workbench/jobs?status=active&page=1&pageSize=20");
    assert.equal(unifiedActive.body.total, 7);
    assert.ok(unifiedActive.body.jobs.every((job) => activeStatuses.includes(job.status)));

    const beyondLast = await get(port, "/api/jobs?status=success&page=999&pageSize=6");
    assert.equal(beyondLast.body.page, 2);
    assert.equal(beyondLast.body.jobs.length, 4);
    assert.equal((await get(port, "/api/jobs")).body.jobs.length, 24);
    assert.equal((await get(port, "/api/jobs?status=unknown&page=1")).status, 400);
    assert.equal((await get(port, "/api/jobs?status=all&page=0")).status, 400);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("audit events paginate the full history in a stable newest-first order", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-events-page-test-"));
  const port = await freePort();
  const app = createWorkbenchServer({ port, databasePath: path.join(tempRoot, "test.sqlite") });
  try {
    await app.listen();
    const initial = await get(port, "/api/events");
    assert.equal(initial.status, 200);
    const initialTotal = initial.body.total;

    for (let index = 0; index < 25; index += 1) {
      app.store.createDraftJob({
        idempotencyKey: `event-page-test-${index}`, accountId: null, mode: "image_to_video",
        model: "auto", durationSeconds: 5, prompt: `审计测试 ${index}`,
        referenceAssets: [], priority: 50,
      });
    }
    const total = initialTotal + 25;
    const totalPages = Math.ceil(total / 10);
    const pages = await Promise.all(Array.from({ length: totalPages }, (_, index) =>
      get(port, `/api/events?page=${index + 1}&pageSize=10`)));
    assert.deepEqual(pages.map((result) => result.body.events.length),
      Array.from({ length: totalPages }, (_, index) => Math.min(10, total - index * 10)));
    assert.ok(pages.every((result) => result.status === 200
      && result.body.total === total && result.body.totalPages === totalPages));
    const pagedIds = pages.flatMap((result) => result.body.events.map((event) => event.id));
    assert.equal(new Set(pagedIds).size, total);
    assert.deepEqual(pagedIds, app.store.listEvents(total).map((event) => event.id));
    assert.deepEqual((await get(port, "/api/overview")).body.events.slice(0, 5).map((event) => event.id),
      pagedIds.slice(0, 5));

    const beyondLast = await get(port, "/api/events?page=999&pageSize=10");
    assert.equal(beyondLast.body.page, totalPages);
    assert.equal(beyondLast.body.events.length, total - (totalPages - 1) * 10);
    assert.equal((await get(port, "/api/events?page=0")).status, 400);
    assert.equal((await get(port, "/api/events?pageSize=51")).status, 400);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Doubao accounts use their verifier and reject unsupported task modes", async () => {
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
    assert.equal(draft.body.error, "ONLY_IMAGE_TO_VIDEO_SUPPORTED");

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

    fs.writeFileSync(verifierPath, 'console.log(JSON.stringify({ok:false,loggedIn:false,error:"PROFILE_IN_USE"}));');
    const occupied = await post(port, `/api/accounts/${input.accountId}/verify`, {});
    assert.equal(occupied.status, 409);
    assert.equal(occupied.body.account.status, "busy");
    assert.equal(occupied.body.account.creditsRemaining, 7);
    assert.deepEqual(occupied.body.account.models, ["Seedance 2.0 Fast", "Seedance 2.0 Mini"]);

    fs.writeFileSync(verifierPath, 'console.log(JSON.stringify({ok:false,loggedIn:false,error:"LOGIN_REQUIRED"}));');
    const guest = await post(port, `/api/accounts/${input.accountId}/verify`, {});
    assert.equal(guest.status, 409);
    assert.equal(guest.body.account.status, "auth_required");
    assert.equal(guest.body.error, "LOGIN_REQUIRED");

    fs.writeFileSync(verifierPath, 'console.log(JSON.stringify({ok:false,loggedIn:false,error:"PROFILE_IN_USE"}));');
    const locked = await post(port, `/api/accounts/${input.accountId}/verify`, {});
    assert.equal(locked.status, 409);
    assert.equal(locked.body.account.status, "busy");
    assert.equal(locked.body.error, "PROFILE_IN_USE");
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("image-to-video draft starts through its account and serves the completed MP4", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-video-test-"));
  const port = await freePort();
  const uploadRoot = path.join(tempRoot, "uploads");
  const workerPath = path.join(tempRoot, "fake-worker.mjs");
  const generatedRoot = path.join(tempRoot, "generated");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(workerPath, `import fs from "node:fs";
import path from "node:path";
let input=""; for await (const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
console.log(JSON.stringify({stage:"submitting"}));
console.log(JSON.stringify({stage:"submitted",remoteUrl:"https://www.doubao.com/chat/123456"}));
fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});
fs.writeFileSync(job.outputPath,Buffer.from("fake-mp4"));
console.log(JSON.stringify({stage:"success",resultPath:job.outputPath}));`, "utf8");
  const app = createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "test.sqlite"), pythonExecutable: process.execPath,
    workerPath, generatedRoot, uploadRoot });
  try {
    await app.listen();
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/assets`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: imageBytes,
    });
    assert.equal(uploadResponse.status, 201);
    const uploaded = await uploadResponse.json();
    assert.equal(path.dirname(uploaded.path), uploadRoot);
    assert.deepEqual(fs.readFileSync(uploaded.path), imageBytes);
    const invalidUpload = await fetch(`http://127.0.0.1:${port}/api/assets`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from("not an image"),
    });
    assert.equal(invalidUpload.status, 400);
    assert.equal((await invalidUpload.json()).error, "REFERENCE_IMAGE_INVALID_FORMAT");
    const account = (await post(port, "/api/accounts", { accountId: "doubao-test-01", label: "豆包测试", loginType: "doubao", workerId: "pc" })).body.account;
    app.store.saveVerification(account.id, { ok: true, loggedIn: true, modelsObserved: ["Seedance 2.0 Mini"],
      remainingCredits: 9, totalCredits: 10, creditsEstimated: true, nextRefresh: null,
      videosCreatedToday: 1, videoCountDate: "2026-09-29", referenceImageLimit: null,
      creditPageReady: true, createPageReady: true });
    const input = { accountId: account.id, mode: "image_to_video", model: "Seedance 2.0 Mini",
      durationSeconds: 5, prompt: "纸飞机向前飞", referenceAssets: [uploaded.path] };
    const created = await post(port, "/api/jobs", input);
    assert.equal(created.status, 201);
    assert.equal(created.body.job.status, "draft");
    const editedResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.body.job.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, prompt: "纸飞机缓慢向前飞", aspectRatio: "9:16",
        referenceAssetNames: ["纸飞机.png"] }),
    });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()).job;
    assert.equal(edited.prompt, "纸飞机缓慢向前飞");
    assert.equal(edited.aspectRatio, "9:16");
    assert.deepEqual(edited.referenceAssetNames, ["纸飞机.png"]);
    const started = await post(port, `/api/jobs/${created.body.job.id}/start`, {});
    assert.equal(started.status, 202);
    assert.equal(started.body.job.aspectRatio, "9:16");
    const tooLate = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.body.job.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(tooLate.status, 409);
    for (let i = 0; i < 50 && app.store.getJob(created.body.job.id).status !== "success"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const job = app.store.getJob(created.body.job.id);
    assert.equal(job.status, "success");
    assert.equal(job.remoteUrl, "https://www.doubao.com/chat/123456");
    const repeat = await post(port, `/api/jobs/${job.id}/start`, {});
    assert.equal(repeat.status, 409);
    assert.equal(repeat.body.error, "JOB_NOT_STARTABLE");
    const result = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/result`);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "fake-mp4");
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reference video upload, draft editing and Doubao-only generation", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-reference-video-test-"));
  const port = await freePort();
  const workerPath = path.join(tempRoot, "fake-worker.mjs");
  fs.writeFileSync(workerPath, `import fs from "node:fs";
import path from "node:path";
let input=""; for await (const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
if (job.mode!=="reference_to_video" || job.service!=="doubao" || job.model!=="Seedance 2.0 Fast"
  || !job.referenceVideo.endsWith(".mov") || job.referenceAssets.length!==1) process.exit(2);
console.log(JSON.stringify({stage:"submitting"}));
console.log(JSON.stringify({stage:"submitted",remoteUrl:"https://www.doubao.com/chat/123456"}));
fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});
fs.writeFileSync(job.outputPath,Buffer.from("fake-mp4"));
console.log(JSON.stringify({stage:"success",resultPath:job.outputPath}));`, "utf8");
  const app = createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "test.sqlite"), pythonExecutable: process.execPath,
    workerPath, generatedRoot: path.join(tempRoot, "generated"), uploadRoot: path.join(tempRoot, "uploads") });
  try {
    await app.listen();
    const base = `http://127.0.0.1:${port}`;
    const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    const mov = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 113, 116, 32, 32, 0, 0, 0, 0]);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64");
    const upload = async (url, bytes) => {
      const response = await fetch(`${base}${url}`, { method: "POST", body: bytes });
      return { status: response.status, body: await response.json() };
    };
    const firstVideo = await upload("/api/assets/video", mp4);
    const secondVideo = await upload("/api/assets/video", mov);
    const referenceImage = await upload("/api/assets", image);
    assert.equal(firstVideo.status, 201);
    assert.ok(firstVideo.body.path.endsWith(".mp4"));
    assert.equal(secondVideo.status, 201);
    assert.ok(secondVideo.body.path.endsWith(".mov"));
    assert.equal(referenceImage.status, 201);
    const invalidVideo = await upload("/api/assets/video", image);
    assert.equal(invalidVideo.status, 400);
    assert.equal(invalidVideo.body.error, "REFERENCE_VIDEO_INVALID_FORMAT");

    const todayBeijing = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const addAccount = async (id, loginType, models) => {
      const account = (await post(port, "/api/accounts", { accountId: id, label: id,
        loginType, workerId: id })).body.account;
      app.store.saveVerification(id, { ok: true, loggedIn: true, modelsObserved: models,
        remainingCredits: 10, totalCredits: 10, creditsEstimated: false, nextRefresh: null,
        videosCreatedToday: 0, videoCountDate: todayBeijing, referenceImageLimit: null,
        creditPageReady: true, createPageReady: true });
      return account;
    };
    const fast = await addAccount("doubao-fast", "doubao", ["Seedance 2.0 Fast"]);
    const mini = await addAccount("doubao-mini", "doubao", ["Seedance 2.0 Mini"]);
    const tiktok = await addAccount("tiktok-pro", "tiktok", ["Video 1.5 Pro"]);
    const input = { accountId: "auto", mode: "reference_to_video", model: "auto",
      durationSeconds: 5, aspectRatio: "9:16", prompt: "让参考素材中的场景轻微运动",
      referenceAssets: [], referenceVideo: firstVideo.body.path, referenceVideoName: "clip.mp4" };
    const missing = await post(port, "/api/jobs", { ...input, referenceVideo: null });
    assert.equal(missing.body.error, "REFERENCE_VIDEO_REQUIRED");
    const onTiktok = await post(port, "/api/jobs", { ...input, accountId: tiktok.id });
    assert.equal(onTiktok.body.error, "JOB_PARAMETERS_INVALID");
    const onMini = await post(port, "/api/jobs", { ...input, model: "Seedance 2.0 Mini" });
    assert.equal(onMini.body.error, "JOB_PARAMETERS_INVALID");
    const tooManyImages = await post(port, "/api/jobs", { ...input,
      referenceAssets: Array(10).fill(referenceImage.body.path) });
    assert.equal(tooManyImages.body.error, "REFERENCE_IMAGE_COUNT_INVALID");
    const created = await post(port, "/api/jobs", input);
    assert.equal(created.status, 201);
    assert.equal(created.body.job.referenceVideo, firstVideo.body.path);
    assert.equal(created.body.job.referenceVideoName, "clip.mp4");
    assert.deepEqual(created.body.job.referenceAssets, []);

    const edit = await fetch(`${base}/api/jobs/${created.body.job.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, referenceVideo: secondVideo.body.path,
        referenceVideoName: "replacement.mov", referenceAssets: [referenceImage.body.path],
        referenceAssetNames: ["frame.png"] }),
    });
    assert.equal(edit.status, 200);
    const updated = (await edit.json()).job;
    assert.equal(updated.referenceVideoName, "replacement.mov");
    assert.deepEqual(updated.referenceAssetNames, ["frame.png"]);
    const started = await post(port, `/api/jobs/${created.body.job.id}/start`, {});
    assert.equal(started.status, 202);
    assert.equal(started.body.job.accountId, fast.id);
    assert.equal(started.body.job.model, "Seedance 2.0 Fast");
    for (let i = 0; i < 50 && app.store.getJob(created.body.job.id).status !== "success"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(app.store.getJob(created.body.job.id).status, "success");
    assert.notEqual(started.body.job.accountId, mini.id);

    fs.writeFileSync(workerPath, `console.log(JSON.stringify({stage:"submitted",remoteUrl:"https://www.doubao.com/chat/765432"}));
console.log(JSON.stringify({stage:"error",code:"DOUBAO_FREE_QUOTA_EXHAUSTED"}));
process.exit(1);`, "utf8");
    const quotaDraft = await post(port, "/api/jobs", { ...input, accountId: fast.id });
    assert.equal(quotaDraft.status, 201);
    const quotaStart = await post(port, `/api/jobs/${quotaDraft.body.job.id}/start`, {});
    assert.equal(quotaStart.status, 202);
    for (let i = 0; i < 50 && app.store.getJob(quotaDraft.body.job.id).status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(app.store.getJob(quotaDraft.body.job.id).errorCode, "DOUBAO_FREE_QUOTA_EXHAUSTED");
    assert.equal(app.store.getJob(quotaDraft.body.job.id).status, "failed");
    assert.equal(app.store.getAccount(fast.id).status, "cooling");
    assert.equal(app.store.getAccount(fast.id).creditsRemaining, 0);
    app.store.saveVerification(fast.id, { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Fast"], remainingCredits: 3, totalCredits: 10,
      creditsEstimated: true, nextRefresh: null, videosCreatedToday: 7,
      videoCountDate: todayBeijing, referenceImageLimit: null,
      creditPageReady: true, createPageReady: true });
    assert.equal(app.store.getAccount(fast.id).status, "cooling");
    assert.equal(app.store.getAccount(fast.id).creditsRemaining, 0);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("automatic selections resolve to TikTok at 12 seconds and Doubao at 5 seconds", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-routing-test-"));
  const port = await freePort();
  const imagePath = path.join(tempRoot, "首帧.png");
  const secondImagePath = path.join(tempRoot, "参考图.png");
  const workerPath = path.join(tempRoot, "fake-worker.mjs");
  fs.writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64"));
  fs.copyFileSync(imagePath, secondImagePath);
  fs.writeFileSync(workerPath, `import fs from "node:fs";
import path from "node:path";
let input=""; for await (const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
const remoteUrl=job.service==="symphony"
  ? "https://ads.tiktok.com/creative/creativestudio/image-to-video?activeId=123456"
  : "https://www.doubao.com/chat/123456";
console.log(JSON.stringify({stage:"submitting"}));
console.log(JSON.stringify({stage:"submitted",remoteUrl}));
fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});
fs.writeFileSync(job.outputPath,Buffer.from("fake-mp4"));
console.log(JSON.stringify({stage:"success",resultPath:job.outputPath}));`, "utf8");
  const app = createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "test.sqlite"), pythonExecutable: process.execPath,
    workerPath, generatedRoot: path.join(tempRoot, "generated") });
  try {
    await app.listen();
    const createAccount = async (id, loginType, model) => {
      const account = (await post(port, "/api/accounts", { accountId: id, label: id, loginType, workerId: "pc" })).body.account;
      app.store.saveVerification(id, { ok: true, loggedIn: true, modelsObserved: [model],
        remainingCredits: 100, totalCredits: 100, creditsEstimated: false, nextRefresh: null,
        videosCreatedToday: 0, videoCountDate: null, referenceImageLimit: null,
        creditPageReady: true, createPageReady: true });
      return account;
    };
    const doubao = await createAccount("doubao-auto", "doubao", "Seedance 2.0 Mini");
    const tiktok = await createAccount("tiktok-auto", "tiktok", "Video 1.5 Pro");
    const input = { accountId: "auto", mode: "image_to_video", model: "auto",
      durationSeconds: 12, aspectRatio: "9:16", prompt: "自动派号", referenceAssets: [imagePath] };
    const invalid = await post(port, "/api/jobs", { ...input, model: "Seedance 2.0 Mini" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "JOB_PARAMETERS_INVALID");
    const fifteen = await post(port, "/api/jobs", { ...input, durationSeconds: 15 });
    assert.equal(fifteen.status, 400);
    assert.equal(fifteen.body.error, "INVALID_DURATION");
    const proOnDoubao = await post(port, "/api/jobs", { ...input, accountId: doubao.id, model: "Video 1.5 Pro", durationSeconds: 5 });
    assert.equal(proOnDoubao.body.error, "JOB_PARAMETERS_INVALID");
    const multiOnTiktok = await post(port, "/api/jobs", { ...input, model: "Video 1.5 Pro", durationSeconds: 5,
      referenceAssets: [imagePath, secondImagePath] });
    assert.equal(multiOnTiktok.status, 201);
    const multiTwelve = await post(port, "/api/jobs", { ...input,
      referenceAssets: [imagePath, secondImagePath] });
    assert.equal(multiTwelve.status, 201);
    const fiveAssets = [imagePath, secondImagePath, imagePath, secondImagePath, imagePath];
    const fiveOnTiktok = await post(port, "/api/jobs", { ...input, accountId: tiktok.id, durationSeconds: 5,
      referenceAssets: fiveAssets });
    assert.equal(fiveOnTiktok.body.error, "JOB_PARAMETERS_INVALID");
    const fiveOnDoubao = await post(port, "/api/jobs", { ...input, durationSeconds: 5,
      referenceAssets: fiveAssets });
    assert.equal(fiveOnDoubao.status, 201);
    const tenImages = await post(port, "/api/jobs", { ...input, durationSeconds: 5,
      referenceAssets: [...fiveAssets, ...fiveAssets] });
    assert.equal(tenImages.body.error, "REFERENCE_IMAGE_COUNT_INVALID");
    const tiktokRatio = await post(port, "/api/jobs", { ...input, accountId: tiktok.id, durationSeconds: 5,
      aspectRatio: "9:16" });
    assert.equal(tiktokRatio.status, 201);
    const tiktokOtherRatio = await post(port, "/api/jobs", { ...input, accountId: tiktok.id, durationSeconds: 5,
      aspectRatio: "16:9" });
    assert.equal(tiktokOtherRatio.body.error, "JOB_PARAMETERS_INVALID");

    const twelve = await post(port, "/api/jobs", input);
    assert.equal(twelve.body.job.accountId, null);
    assert.equal(twelve.body.job.model, "auto");
    const startedTwelve = await post(port, `/api/jobs/${twelve.body.job.id}/start`, {});
    assert.equal(startedTwelve.status, 202);
    assert.equal(startedTwelve.body.job.accountId, tiktok.id);
    assert.equal(startedTwelve.body.job.model, "Video 1.5 Pro");
    assert.equal(startedTwelve.body.job.aspectRatio, "9:16");
    for (let i = 0; i < 50 && app.store.getJob(twelve.body.job.id).status !== "success"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(app.store.getJob(twelve.body.job.id).remoteUrl,
      "https://ads.tiktok.com/creative/creativestudio/image-to-video?activeId=123456");

    const five = await post(port, "/api/jobs", { ...input, durationSeconds: 5,
      referenceAssets: [imagePath, secondImagePath] });
    const startedFive = await post(port, `/api/jobs/${five.body.job.id}/start`, {});
    assert.equal(startedFive.status, 202);
    assert.equal(startedFive.body.job.accountId, doubao.id);
    assert.equal(startedFive.body.job.model, "Seedance 2.0 Mini");
    assert.equal(startedFive.body.job.referenceAssets.length, 2);
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("unified image generation reserves distinct accounts for the whole batch", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-unified-batch-"));
  const port = await freePort();
  const imagePath = path.join(tempRoot, "reference.png");
  const workerPath = path.join(tempRoot, "fake-worker.mjs");
  const generatedRoot = path.join(tempRoot, "generated");
  fs.writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64"));
  fs.writeFileSync(workerPath, `import fs from "node:fs";
import path from "node:path";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input);
fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
fs.writeFileSync(job.outputPath + ".json", JSON.stringify(job));
console.log(JSON.stringify({ stage: "submitting" }));
console.log(JSON.stringify({ stage: "submitted", remoteUrl: "https://www.doubao.com/chat/123456" }));
fs.writeFileSync(job.outputPath, Buffer.from("fake-mp4"));
console.log(JSON.stringify({ stage: "success", resultPath: job.outputPath }));`, "utf8");
  const app = createWorkbenchServer({ port, workspaceRoot: tempRoot,
    databasePath: path.join(tempRoot, "test.sqlite"), pythonExecutable: process.execPath,
    workerPath, generatedRoot });
  try {
    await app.listen();
    const addReadyAccount = async (id) => {
      const added = await post(port, "/api/accounts", { accountId: id, label: id,
        loginType: "doubao", workerId: "pc" });
      assert.equal(added.status, 201);
      app.store.saveVerification(id, { ok: true, loggedIn: true,
        modelsObserved: ["Seedance 2.0 Fast"], remainingCredits: 10, totalCredits: 10,
        creditsEstimated: true, nextRefresh: null, videosCreatedToday: 0,
        videoCountDate: null, referenceImageLimit: null,
        creditPageReady: true, createPageReady: true });
    };
    await addReadyAccount("batch-doubao-1");
    const input = { accountId: "auto", model: "Seedance 2.0 Fast",
      durationSeconds: 5, aspectRatio: "16:9", positivePrompt: "镜头缓慢移动",
      negativePrompt: "不要文字和水印", concurrency: 2,
      referenceAssets: [imagePath], referenceAssetNames: ["reference.png"] };
    for (const invalid of [{ ...input, model: "auto" },
      { ...input, aspectRatio: "auto" }, { ...input, concurrency: 9 }]) {
      const rejected = await post(port, "/api/jobs", invalid);
      assert.equal(rejected.status, 400);
    }
    const created = await post(port, "/api/jobs", input);
    assert.equal(created.status, 201);
    assert.equal(created.body.job.positivePrompt, input.positivePrompt);
    assert.equal(created.body.job.negativePrompt, input.negativePrompt);
    assert.equal(created.body.job.concurrency, 2);
    const batchId = created.body.job.id;
    const shortage = await post(port, `/api/jobs/${batchId}/start`, {});
    assert.equal(shortage.status, 400);
    assert.equal(shortage.body.error, "INSUFFICIENT_ELIGIBLE_ACCOUNTS");
    assert.equal(app.store.getJob(batchId).status, "draft");
    assert.equal(app.store.listJobs().length, 1);
    const oneStepInput = { ...input, idempotencyKey: "external-batch-test" };
    const oneStepShortage = await post(port, "/api/video-generations", oneStepInput);
    assert.equal(oneStepShortage.status, 400);
    assert.equal(oneStepShortage.body.error, "INSUFFICIENT_ELIGIBLE_ACCOUNTS");
    assert.equal(app.store.getJobByIdempotencyKey(oneStepInput.idempotencyKey).status, "draft");

    await addReadyAccount("batch-doubao-2");
    const started = await post(port, `/api/jobs/${batchId}/start`, {});
    assert.equal(started.status, 202);
    assert.equal(started.body.batchId, batchId);
    assert.equal(started.body.jobs.length, 2);
    assert.equal(new Set(started.body.jobs.map((job) => job.accountId)).size, 2);
    assert.deepEqual(started.body.jobs.map((job) => job.batchIndex), [1, 2]);
    assert.ok(started.body.jobs.every((job) => job.batchSize === 2
      && job.negativePrompt === input.negativePrompt && job.aspectRatio === "16:9"));
    for (let attempt = 0; attempt < 80 && started.body.jobs.some((job) =>
      app.store.getJob(job.id).status !== "success"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(started.body.jobs.every((job) => app.store.getJob(job.id).status === "success"));
    for (const job of started.body.jobs) {
      const workerInput = JSON.parse(fs.readFileSync(path.join(generatedRoot, `${job.id}.mp4.json`), "utf8"));
      assert.equal(workerInput.negativePrompt, input.negativePrompt);
      assert.equal(workerInput.positivePrompt, input.positivePrompt);
      assert.equal(workerInput.accountId, job.accountId);
    }
    const batch = await get(port, `/api/video-generations/${batchId}`);
    assert.equal(batch.status, 200);
    assert.equal(batch.body.jobs.length, 2);
    assert.ok(batch.body.jobs.every((job) => job.status === "success"));

    const oneStep = await post(port, "/api/video-generations", oneStepInput);
    assert.equal(oneStep.status, 202);
    assert.equal(oneStep.body.jobs.length, 2);
    const retry = await post(port, "/api/video-generations", oneStepInput);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body.jobs.map((job) => job.id), oneStep.body.jobs.map((job) => job.id));
    const conflict = await post(port, "/api/video-generations",
      { ...oneStepInput, negativePrompt: "不同的负面提示词" });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.error, "IDEMPOTENCY_CONFLICT");
    for (let attempt = 0; attempt < 80 && oneStep.body.jobs.some((job) =>
      app.store.getJob(job.id).status !== "success"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(oneStep.body.jobs.every((job) => app.store.getJob(job.id).status === "success"));
    const textOnly = await post(port, "/api/video-generations", {
      accountId: "auto", model: "Seedance 2.0 Fast", durationSeconds: 5,
      aspectRatio: "16:9", positivePrompt: "一只纸飞机穿过云层",
      negativePrompt: "不要字幕", concurrency: 2, idempotencyKey: "text-only-batch",
    });
    assert.equal(textOnly.status, 202);
    assert.equal(textOnly.body.jobs.length, 2);
    assert.ok(textOnly.body.jobs.every((job) => job.referenceAssets.length === 0));
    assert.equal(new Set(textOnly.body.jobs.map((job) => job.accountId)).size, 2);
    for (let attempt = 0; attempt < 80 && textOnly.body.jobs.some((job) =>
      app.store.getJob(job.id).status !== "success"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(textOnly.body.jobs.every((job) => app.store.getJob(job.id).status === "success"));
    for (const job of textOnly.body.jobs) {
      const workerInput = JSON.parse(fs.readFileSync(path.join(generatedRoot, `${job.id}.mp4.json`), "utf8"));
      assert.deepEqual(workerInput.referenceAssets, []);
      assert.equal(workerInput.prompt, "一只纸飞机穿过云层");
    }
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
