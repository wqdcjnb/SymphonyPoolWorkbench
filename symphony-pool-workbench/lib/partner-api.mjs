import { createIntakeQueue } from './intake-queue.mjs';
import { POLL_AFTER_SECONDS } from './long-task.mjs';
import { partnerProgress } from '../public/js/job-progress.js';
import { promises as files } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createPartnerStore, ITEM_TERMINAL } from "./partner-store.mjs";
import { assertDelivery, deliveryReceiptPath, WATERMARK_ERROR } from "./media-delivery.mjs";
import { repairDolaVideo } from './watermark-repair.mjs';
import { DAY, MODELS, ERRORS, PartnerError, configurePartnerApi, equalSecret,
  signature, isTaskId, readTaskRequest, postWebhook } from "./partner-protocol.mjs";

const iso = (time) => time == null ? null : new Date(time).toISOString();
const deliveryErrors = new Set([WATERMARK_ERROR, 'WATERMARK_REPAIR_FAILED', 'WATERMARK_REPAIR_UNSUPPORTED_LAYOUT']);
const deliveryMode = task => task.payload.delivery_mode || 'official_original';
const publicFailure = (code) => code === 'DOUBAO_SUBSCRIPTION_REQUIRED'
  ? {code,message:'豆包已拒绝本次视频生成：当前账号需要订阅标准套餐。任务已结束，不会自动重试。'}
  : deliveryErrors.has(code)
  ? { code, message: ERRORS[code][1] }
  : { code: code === "RESULT_FILE_MISSING" ? "RESULT_MISSING" : "GENERATION_FAILED",
    message: code === "RESULT_FILE_MISSING" ? "生成结果文件不可用" : "该条视频生成失败" };
const openapiPath = fileURLToPath(new URL("../docs/partner-openapi.json", import.meta.url));

export async function createPartnerApi({ databasePath, generatedRoot, uploadRoot, port, wakeQueue,
  options = {}, now = Date.now, onError = (code) => console.error(code) }) {
  const config = configurePartnerApi(options, port);
  const store = (await createPartnerStore(databasePath));
  const intakeQueue = createIntakeQueue({ maxWaiting: config.maxQueuedIntakes, waitMs: config.intakeWaitMs });
  const assetRoot = path.resolve(uploadRoot, "partner");
  const outputRoot = path.resolve(generatedRoot);
  let timer, stopped = true, ticking, delivering, lastCleanup = 0;
  let rateWindow = now(), rateCount = 0;
  const expectedPath = (item, mode = 'official_original') => {
    if (!/^job-[a-f0-9-]{36}$/.test(item.job_id)) throw new Error("INVALID_RESULT_PATH");
    const target = path.join(outputRoot, `${item.job_id}${mode === 'watermark_repair' ? '.repaired' : ''}.mp4`);
    if (path.resolve(item.result_path || item.job_result_path || "") !== target) throw new Error("INVALID_RESULT_PATH");
    return target;
  };
  const counts = (task) => ({ completed_count: task.items.filter((i) => ITEM_TERMINAL.has(i.state)).length,
    succeeded_count: task.items.filter((i) => i.state === "succeeded").length,
    failed_count: task.items.filter((i) => i.state === "failed").length,
    cancelled_count: task.items.filter((i) => i.state === "cancelled").length });
  const result = (task, item, time) => {
    const value = { index: item.item_index, batch_index: item.batch_index,
      status: item.state === "pending" ? "queued" : item.state,progress:partnerProgress(item) };
    if (item.state === 'reconciling') value.recovery = {
      mode: item.nextReconcileAt ? 'automatic' : 'manual',
      attempts: item.reconcileAttempts || 0, next_check_at: iso(item.nextReconcileAt),
      deadline_at: iso(item.reconcileDeadlineAt),
    };
    if (item.state === "failed") value.error = publicFailure(item.error_code);
    if (item.state === "reconciling" && item.error_code === WATERMARK_ERROR) value.error = publicFailure(item.error_code);
    if (item.state === "reconciling" && ['DOLA_HUMAN_VERIFICATION_REQUIRED','DOUBAO_HUMAN_VERIFICATION_REQUIRED'].includes(item.error_code)) {
      value.error = {code:item.error_code,message:"等待服务方完成平台人机验证并恢复原任务；保留 task_id 继续查询，勿重新创建"};
    }
    if (item.state === "succeeded") {
      value.size_bytes = item.size_bytes;
      value.sha256 = item.sha256;
      value.retained_until = iso(item.retention_until);
      const available = !item.purged_at && item.retention_until > time;
      if (!available) {
        value.video_url = null;
        value.expires_at = null;
        value.error = { code: "RESULT_EXPIRED", message: ERRORS.RESULT_EXPIRED[1] };
        return value;
      }
      try {
        const mode = deliveryMode(task);
        const receipt = assertDelivery(expectedPath(item, mode), { sha256: item.sha256, sizeBytes: item.size_bytes }, mode);
        value.delivery_mode = mode;
        value.postprocessed = mode === 'watermark_repair';
        value.watermark_free = mode === 'official_original' ? true : null;
        if (mode === 'watermark_repair') value.processing = receipt.processing;
      } catch (error) {
        value.watermark_free = false;
        value.video_url = null;
        value.expires_at = null;
        value.error = publicFailure(deliveryMode(task) === 'watermark_repair' ? 'WATERMARK_REPAIR_FAILED' : WATERMARK_ERROR);
        return value;
      }
      const expires = Math.floor(Math.min(time + DAY, item.retention_until) / 1_000);
      const token = signature(config.downloadSecret, `${task.id}:${item.item_index}:${expires}`);
      value.video_url = available ? `${config.baseUrl}/videos/${task.id}/results/${item.item_index}?expires=${expires}&signature=${token}` : null;
      value.expires_at = available ? iso(expires * 1_000) : null;
      if (!available) value.error = { code: "RESULT_EXPIRED", message: ERRORS.RESULT_EXPIRED[1] };
    }
    return value;
  };
  const serialize = async (task, time = now()) => {
    task = await store.syncProgress(task.id,time) || task;
    return { task_id: task.id, client_task_id: task.client_task_id,
    terminal: task.finished_at != null, poll_after_seconds: task.finished_at != null ? 0 : POLL_AFTER_SECONDS,
    status_url: `${config.baseUrl}/videos/${task.id}`,
    notification_mode: task.payload.callback_url ? 'webhook_and_poll' : 'poll',
    status: task.state, model: task.payload.model, duration: task.payload.duration,
    ratio: task.payload.ratio, delivery_mode: deliveryMode(task), count: task.count, ...counts(task),
    created_at: iso(task.created_at), updated_at: iso(Math.max(task.updated_at,...task.items.map(item=>item.jobUpdatedAt || 0))), finished_at: iso(task.finished_at),
    results: task.items.map((item) => result(task, item, time)),
    webhooks: (await store.deliverySummary(task.id)) };
  };
  const json = (response, status, body) => {
    if (body.task_id && body.terminal === false) response.setHeader('Retry-After', POLL_AFTER_SECONDS);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(body));
  };
  async function inspectResult(item) {
    const task = await store.get(item.task_id);
    const mode = deliveryMode(task);
    let target = expectedPath(item);
    if (mode === 'watermark_repair') {
      if (!['Dreamina Seedance 2.0 Fast','Dreamina Seedance 2.5'].includes(task.payload.model)) throw new Error('WATERMARK_REPAIR_FAILED');
      const reusable = target;
      const source = target.replace(/\.mp4$/, '.original.mp4');
      target = target.replace(/\.mp4$/, '.repaired.mp4');
      // A single coordinator tick processes derivatives sequentially; ffmpeg
      // is capped at two threads and never starts another platform generation.
      await repairDolaVideo(source, target, task.payload, reusable);
    }
    const handle = await files.open(target, "r");
    try {
      const stat = await handle.stat();
      const header = Buffer.alloc(8);
      await handle.read(header, 0, 8, 0);
      if (!stat.isFile() || stat.size < 12 || header.toString("ascii", 4, 8) !== "ftyp") throw new Error("INVALID_MP4");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      const sha256 = hash.digest("hex");
      assertDelivery(target, { sha256, sizeBytes: stat.size }, mode);
      return { path: target, size: stat.size, sha256,
        completedAt: item.job_completed_at ?? now(), retentionUntil: (item.job_completed_at ?? now()) + 7 * DAY };
    } finally { await handle.close(); }
  }
  async function recordNotifications(time) {
    for (const task of (await store.notificationsPending())) {
      const entries = [];
      const batches = [...new Set(task.items.filter((i) => i.job_id).map((i) => i.batch_index))];
      for (const batch of batches) {
        const items = task.items.filter((i) => i.batch_index === batch);
        const key = `batch:${batch}`;
        if (!items.every((i) => ITEM_TERMINAL.has(i.state)) || (await store.hasEvent(task.id, key))) continue;
        entries.push({ key, url: task.payload.callback_url, now: time, body: {
          event_id: `evt-${randomUUID()}`, event: "video.batch.completed", task_id: task.id,
          client_task_id: task.client_task_id, batch_index: batch,
          is_final: Boolean(task.finished_at) && !task.cancel_requested && batch === Math.ceil(task.count / 2),
          status: task.state, count: task.count, ...counts(task), occurred_at: iso(time),
          results: items.map((item) => result(task, item, time)),
        } });
      }
      if (task.finished_at && task.cancel_requested && !(await store.hasEvent(task.id, "cancel:finished"))) {
        entries.push({ key: "cancel:finished", url: task.payload.callback_url, now: time, body: {
          event_id: `evt-${randomUUID()}`, event: "video.task.finished", task_id: task.id,
          client_task_id: task.client_task_id, batch_index: null, is_final: true,
          status: task.state, count: task.count, ...counts(task), occurred_at: iso(time), results: [],
        } });
      }
      if (entries.length || task.finished_at) (await store.recordEvents(task.id, entries, Boolean(task.finished_at)));
    }
  }
  async function removeAssets(id, assets) {
    if (!isTaskId(id)) throw new Error("INVALID_ASSET_PATH");
    const dir = path.join(assetRoot, id);
    for (const asset of assets) {
      const target = path.resolve(asset.path);
      if (path.dirname(target) !== dir) throw new Error("INVALID_ASSET_PATH");
      await files.unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    await files.rmdir(dir).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  async function cleanup(time) {
    if (lastCleanup && time - lastCleanup < 3_600_000) return;
    for (const item of (await store.expiredFiles(time))) {
      const target = expectedPath(item, deliveryMode(await store.get(item.task_id)));
      await files.unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await files.unlink(deliveryReceiptPath(target)).catch((error) => { if (error.code !== "ENOENT") throw error; });
      (await store.markPurged(item, time));
    }
    for (const task of (await store.expiredAssets(time, 7 * DAY))) {
      await removeAssets(task.id, task.assets);
      (await store.markAssetsPurged(task.id));
    }
    lastCleanup = time;
  }
  async function tick() {
    for (const item of (await store.unsettledItems())) {
      if (item.job_status === "success") {
        try { (await store.updateItem(item, "succeeded", await inspectResult(item), now())); }
        catch (error) { (await store.updateItem(item, "failed", {
          errorCode: deliveryErrors.has(error.message) ? error.message : "RESULT_FILE_MISSING" }, now())); }
      } else if (["failed", "cancelled"].includes(item.job_status)) {
        (await store.updateItem(item, item.job_status, { errorCode: item.job_error }, now()));
      } else {
        const state = item.job_status === "reconciling" ? "reconciling"
          : ["draft", "queued"].includes(item.job_status) ? "queued" : "running";
        if (state !== item.state || item.error_code !== item.job_error) {
          (await store.updateItem(item, state, { errorCode: item.job_error || null }, now()));
        }
      }
    }
    (await recordNotifications(now()));
    if (!stopped && (await store.dispatchRounds(now()))) wakeQueue();
    await cleanup(now());
  }
  const wake = () => {
    if (stopped || !config.enabled) return Promise.resolve();
    if (!ticking) ticking = tick().catch(() => onError("PARTNER_COORDINATOR_ERROR")).finally(() => { ticking = null; });
    return ticking;
  };
  const deliver = () => {
    if (stopped || !config.enabled || delivering) return delivering || Promise.resolve();
    delivering = (async () => {
      // Bounded work per wake keeps shutdown predictable; slow receivers never block generation.
      for (let i = 0; i < 4 && !stopped; i++) {
        const item = (await store.takeDelivery(now()));
        if (!item) break;
        let status = null, error = null;
        try { status = await postWebhook(item, config, now()); }
        catch { error = "CALLBACK_UNREACHABLE"; }
        (await store.completeDelivery(item, status, error, now()));
      }
    })().catch(() => onError("PARTNER_DELIVERY_ERROR")).finally(() => { delivering = null; });
    return delivering;
  };
  async function download(request, response, url, id, index) {
    const bearer = request.headers.authorization || "";
    if (!equalSecret(bearer, `Bearer ${config.apiKey}`)) {
      const expires = url.searchParams.get("expires") || "";
      const token = url.searchParams.get("signature") || "";
      if (!/^\d{1,12}$/.test(expires) || !/^[a-f0-9]{64}$/.test(token)
        || !equalSecret(token, signature(config.downloadSecret, `${id}:${index}:${expires}`))) {
        throw new PartnerError("INVALID_DOWNLOAD_SIGNATURE");
      }
      if (Number(expires) * 1_000 <= now()) throw new PartnerError("DOWNLOAD_LINK_EXPIRED");
    }
    const task = (await store.get(id));
    if (!task) throw new PartnerError("TASK_NOT_FOUND");
    const item = task.items.find((i) => i.item_index === index);
    if (!item) throw new PartnerError("NOT_FOUND");
    if (item.state !== "succeeded") throw new PartnerError("RESULT_NOT_READY");
    if (item.purged_at || item.retention_until <= now()) throw new PartnerError("RESULT_EXPIRED");
    const mode = deliveryMode(task);
    try { assertDelivery(expectedPath(item, mode), { sha256: item.sha256, sizeBytes: item.size_bytes }, mode); }
    catch { throw new PartnerError(mode === 'watermark_repair' ? 'WATERMARK_REPAIR_FAILED' : WATERMARK_ERROR); }
    let handle;
    try { handle = await files.open(expectedPath(item, mode), "r"); }
    catch { throw new PartnerError("RESULT_MISSING"); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== item.size_bytes) throw new PartnerError("RESULT_MISSING");
      const etag = `"${item.sha256}"`;
      let start = 0, end = stat.size - 1, status = 200;
      const range = request.headers.range;
      if (range && (!request.headers["if-range"] || request.headers["if-range"] === etag)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const invalid = () => { response.setHeader("Content-Range", `bytes */${stat.size}`); throw new PartnerError("INVALID_RANGE"); };
        if (!match || (!match[1] && !match[2])) invalid();
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) invalid();
          start = Math.max(0, stat.size - suffix);
        } else {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(Number(match[2] || end)) || start > end || start >= stat.size) invalid();
        }
        status = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      }
      response.writeHead(status, { "Content-Type": "video/mp4", "Content-Length": end - start + 1,
        "Content-Disposition": `attachment; filename="${id}-${index}.mp4"`,
        "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", ETag: etag,
        "X-Content-Type-Options": "nosniff" });
      if (request.method === "HEAD") response.end();
      else await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
    } finally { await handle.close(); }
  }
  async function handle(request, response, url, pathname) {
    try {
      if (!config.enabled) throw new PartnerError("API_NOT_CONFIGURED");
      const downloadMatch = /^\/v1\/videos\/(task-[a-f0-9-]{36})\/results\/(\d{1,3})$/.exec(pathname);
      if (downloadMatch) {
        if (!["GET", "HEAD"].includes(request.method)) throw new PartnerError("METHOD_NOT_ALLOWED");
        return await download(request, response, url, downloadMatch[1], Number(downloadMatch[2]));
      }
      if (!equalSecret(request.headers.authorization || "", `Bearer ${config.apiKey}`)) throw new PartnerError("INVALID_API_KEY");
      if (now() - rateWindow >= 60_000) { rateWindow = now(); rateCount = 0; }
      if (++rateCount > config.requestsPerMinute) {
        response.setHeader("Retry-After", Math.max(1, Math.ceil((rateWindow + 60_000 - now()) / 1_000)));
        throw new PartnerError("RATE_LIMITED");
      }
      if (pathname === "/v1/models") {
        if (request.method !== "GET") throw new PartnerError("METHOD_NOT_ALLOWED");
        return json(response, 200, { api_version: "v1", models: MODELS,
          limits: { count: { min: 1, max: 100 }, batch_size: 2, max_pending_tasks: config.maxPendingTasks,
            max_waiting_uploads: config.maxQueuedIntakes, prompt_max_characters: 5_000,
            negative_prompt_max_characters: 2_000, image_max_bytes: 20 * 1024 * 1024,
            images_max_bytes: 100 * 1024 * 1024, image_formats: ["png", "jpeg", "webp"],
            download_link_seconds: DAY / 1_000, result_retention_seconds: 7 * DAY / 1_000 } });
      }
      if (pathname === "/v1/openapi.json") {
        if (request.method !== "GET") throw new PartnerError("METHOD_NOT_ALLOWED");
        const doc = JSON.parse(await files.readFile(openapiPath, "utf8"));
        doc.servers = [{ url: config.baseUrl }];
        return json(response, 200, doc);
      }
      if (pathname === "/v1/videos") {
        if (request.method !== "POST") throw new PartnerError("METHOD_NOT_ALLOWED");
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        let release;

        const id = `task-${randomUUID()}`, assets = [];
        let committed = false, cleaned = false;
        try {
          release = await intakeQueue.acquire(controller.signal);
          const input = await readTaskRequest(request, config);
          // Check before writing assets, and again atomically in create() for simultaneous retries.
          const previous = (await store.find(input.payload.client_task_id));
          if (previous) {
            if (previous.request_hash !== input.hash && previous.request_hash !== input.legacyRatioHash) throw new PartnerError("ID_CONFLICT");
            return json(response, 200, { ...(await serialize(previous)), idempotent_replay: true });
          }
          if (input.images.length) await files.mkdir(path.join(assetRoot, id), { recursive: true });
          for (const [i, image] of input.images.entries()) {
            const target = path.join(assetRoot, id, `${i + 1}.${image.extension}`);
            assets.push({ path: target, name: image.name });
            await files.writeFile(target, image.bytes, { flag: "wx" });
          }
          if (request.aborted) return;
          const accepted = (await store.create({ id, ...input, assets, now: now(), maxPendingTasks: config.maxPendingTasks }));
          committed = accepted.created;
          if (!committed) { await removeAssets(id, assets); cleaned = true; }
          response.setHeader("Location", `${config.baseUrl}/videos/${accepted.task.id}`);
          json(response, accepted.created ? 202 : 200, { ...(await serialize(accepted.task)), idempotent_replay: !accepted.created });
          queueMicrotask(wake);
        } finally {
          release?.();
          request.off('aborted', abort);
          response.off('close', abort);
          if (!committed && !cleaned) await removeAssets(id, assets);
        }
        return;
      }
      const taskMatch = /^\/v1\/videos\/(task-[a-f0-9-]{36})(\/cancel)?$/.exec(pathname);
      if (taskMatch) {
        const cancelling = Boolean(taskMatch[2]);
        if (request.method !== (cancelling ? "POST" : "GET")) throw new PartnerError("METHOD_NOT_ALLOWED");
        if (cancelling) request.resume();
        const task = cancelling ? (await store.cancel(taskMatch[1], now())) : (await store.get(taskMatch[1]));
        if (!task) throw new PartnerError("TASK_NOT_FOUND");
        if (cancelling) queueMicrotask(wake);
        return json(response, 200, (await serialize(task)));
      }
      throw new PartnerError("NOT_FOUND");
    } catch (error) {
      if (request.aborted || response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const safe = error instanceof PartnerError ? error : new PartnerError(
        ["ID_CONFLICT", "QUEUE_FULL", "TASK_NOT_FOUND"].includes(error.message) ? error.message : "INTERNAL_ERROR");
      if (safe.status === 500) onError("PARTNER_REQUEST_ERROR");
      if (!request.complete) { response.setHeader("Connection", "close"); request.resume(); }
      if (safe.code === "QUEUE_FULL") response.setHeader("Retry-After", "30");
      json(response, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  }
  return { handle, store, wake, deliver, baseUrl: config.baseUrl,
    start() {
      if (!stopped) return;
      stopped = false;
      if (!config.enabled) return;
      timer = setInterval(() => { void wake(); void deliver(); }, config.intervalMs);
      timer.unref();
      void wake();
      void deliver();
    },
    async stop() { stopped = true; intakeQueue.stop(); clearInterval(timer); await Promise.all([ticking, delivering]); },
    async close() { (await store.close()); },
  };
}
