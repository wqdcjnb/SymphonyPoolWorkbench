import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const ITEM_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function createPartnerStore(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS partner_tasks (
      id TEXT PRIMARY KEY, client_task_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL, assets_json TEXT NOT NULL, count INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', cancel_requested INTEGER NOT NULL DEFAULT 0,
      notifications_complete INTEGER NOT NULL DEFAULT 0, assets_purged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS partner_items (
      task_id TEXT NOT NULL REFERENCES partner_tasks(id), item_index INTEGER NOT NULL,
      batch_index INTEGER NOT NULL, job_id TEXT UNIQUE REFERENCES jobs(id),
      state TEXT NOT NULL DEFAULT 'pending', error_code TEXT, result_path TEXT,
      size_bytes INTEGER, sha256 TEXT, completed_at INTEGER, retention_until INTEGER,
      purged_at INTEGER, PRIMARY KEY(task_id,item_index)
    );
    CREATE INDEX IF NOT EXISTS partner_items_work ON partner_items(state,job_id);
    CREATE TABLE IF NOT EXISTS partner_deliveries (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES partner_tasks(id), event_key TEXT NOT NULL,
      body_json TEXT NOT NULL, callback_url TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      last_http_status INTEGER, last_error TEXT, UNIQUE(task_id,event_key)
    );
    CREATE INDEX IF NOT EXISTS partner_deliveries_due ON partner_deliveries(state,next_attempt_at);
    UPDATE partner_deliveries SET state='pending' WHERE state='sending';`);
  const tx = (action) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const task = (row) => row ? { ...row, payload: JSON.parse(row.payload_json),
    assets: JSON.parse(row.assets_json), items: db.prepare(
      "SELECT * FROM partner_items WHERE task_id=? ORDER BY item_index").all(row.id) } : null;
  const get = (id) => task(db.prepare("SELECT * FROM partner_tasks WHERE id=?").get(id));
  const updateSummary = (id, now) => {
    const current = get(id);
    const states = current.items.map((item) => item.state);
    const finished = states.every((state) => ITEM_TERMINAL.has(state));
    const successes = states.filter((state) => state === "succeeded").length;
    const state = finished
      ? states.includes("cancelled") ? "cancelled" : successes === current.count ? "succeeded"
        : successes ? "partially_succeeded" : "failed"
      : current.cancel_requested ? "cancelling" : states.includes("reconciling") ? "reconciling"
        : states.some((value) => !["pending", "queued"].includes(value)) ? "running" : "queued";
    db.prepare(`UPDATE partner_tasks SET state=?,updated_at=?,
      finished_at=CASE WHEN ? THEN COALESCE(finished_at,?) ELSE finished_at END WHERE id=?`)
      .run(state, now, finished ? 1 : 0, now, id);
    return get(id);
  };
  return {
    close() { db.close(); },
    get,
    find(clientId) { return task(db.prepare("SELECT * FROM partner_tasks WHERE client_task_id=?").get(clientId)); },
    create({ id, payload, assets, hash, now, maxPendingTasks = 100 }) {
      return tx(() => {
        const previous = this.find(payload.client_task_id);
        if (previous) {
          if (previous.request_hash !== hash) throw new Error("ID_CONFLICT");
          return { created: false, task: previous };
        }
        if (db.prepare("SELECT COUNT(*) AS n FROM partner_tasks WHERE finished_at IS NULL").get().n >= maxPendingTasks) {
          throw new Error("QUEUE_FULL");
        }
        db.prepare(`INSERT INTO partner_tasks
          (id,client_task_id,request_hash,payload_json,assets_json,count,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(id, payload.client_task_id, hash, JSON.stringify(payload),
          JSON.stringify(assets), payload.count, now, now);
        const insert = db.prepare("INSERT INTO partner_items(task_id,item_index,batch_index) VALUES (?,?,?)");
        for (let index = 1; index <= payload.count; index++) insert.run(id, index, Math.ceil(index / 2));
        return { created: true, task: get(id) };
      });
    },
    dispatchRounds(now) {
      return tx(() => {
        const pending = db.prepare(`SELECT * FROM partner_tasks WHERE finished_at IS NULL
          AND cancel_requested=0 ORDER BY updated_at,created_at,rowid`).all();
        let dispatched = 0;
        for (const row of pending) {
          const current = task(row);
          if (current.items.some((item) => item.job_id && !ITEM_TERMINAL.has(item.state))) continue;
          const first = current.items.find((item) => item.state === "pending");
          if (!first) continue;
          const members = current.items.filter((item) => item.batch_index === first.batch_index);
          for (const item of members) {
            const jobId = `job-${randomUUID()}`;
            const p = current.payload;
            db.prepare(`INSERT INTO jobs
              (id,idempotency_key,mode,model,requested_model,duration_seconds,aspect_ratio,prompt,
               negative_prompt,concurrency,batch_id,batch_index,batch_size,reference_assets_json,
               reference_asset_names_json,priority,status,queued_at,created_at,updated_at)
              VALUES (?,?,'image_to_video',?,?,?,?,?,?,1,?,?,?,?,?,50,'queued',?,?,?)`)
              .run(jobId, `partner:${current.id}:${item.item_index}`, p.model, p.model, p.duration,
                p.ratio, p.prompt, p.negative_prompt, current.id, item.item_index, current.count,
                JSON.stringify(current.assets.map((asset) => asset.path)),
                JSON.stringify(current.assets.map((asset) => asset.name)), now, now, now);
            db.prepare("UPDATE partner_items SET job_id=?,state='queued' WHERE task_id=? AND item_index=?")
              .run(jobId, current.id, item.item_index);
            db.prepare(`INSERT INTO events(id,job_id,event_type,message,details_json,created_at)
              VALUES (?,?,'job.queued','合作方 API 任务已加入队列',?,?)`)
              .run(randomUUID(), jobId, JSON.stringify({ taskId: current.id,
                clientTaskId: current.client_task_id, index: item.item_index }), now);
            dispatched++;
          }
          db.prepare("UPDATE partner_tasks SET updated_at=? WHERE id=?").run(now, current.id);
        }
        return dispatched;
      });
    },
    unsettledItems() {
      return db.prepare(`SELECT i.*,j.status AS job_status,j.result_path AS job_result_path,
        j.error_code AS job_error,j.completed_at AS job_completed_at
        FROM partner_items i JOIN jobs j ON j.id=i.job_id
        WHERE i.state NOT IN ('succeeded','failed','cancelled')`).all();
    },
    updateItem(item, state, extra, now) {
      tx(() => {
        db.prepare(`UPDATE partner_items SET state=?,error_code=?,result_path=?,size_bytes=?,sha256=?,
          completed_at=?,retention_until=? WHERE task_id=? AND item_index=?
          AND state NOT IN ('succeeded','failed','cancelled')`)
          .run(state, extra.errorCode ?? null, extra.path ?? null, extra.size ?? null, extra.sha256 ?? null,
            ITEM_TERMINAL.has(state) ? extra.completedAt ?? now : null, extra.retentionUntil ?? null,
            item.task_id, item.item_index);
        updateSummary(item.task_id, now);
      });
    },
    cancel(id, now) {
      return tx(() => {
        const current = get(id);
        if (!current) throw new Error("TASK_NOT_FOUND");
        if (current.finished_at) return current;
        db.prepare("UPDATE partner_tasks SET cancel_requested=1,updated_at=? WHERE id=?").run(now, id);
        for (const item of current.items) {
          if (ITEM_TERMINAL.has(item.state)) continue;
          if (item.job_id) {
            db.prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?").run(item.job_id);
            const job = db.prepare("SELECT status FROM jobs WHERE id=?").get(item.job_id);
            if (!["draft", "queued"].includes(job.status)) continue;
            db.prepare("UPDATE jobs SET status='cancelled',completed_at=?,updated_at=? WHERE id=?")
              .run(now, now, item.job_id);
            db.prepare(`INSERT INTO events(id,job_id,event_type,message,created_at)
              VALUES (?,?,'job.cancelled','合作方取消了尚未提交的任务',?)`).run(randomUUID(), item.job_id, now);
          }
          db.prepare("UPDATE partner_items SET state='cancelled',completed_at=? WHERE task_id=? AND item_index=?")
            .run(now, id, item.item_index);
        }
        return updateSummary(id, now);
      });
    },
    notificationsPending() {
      return db.prepare("SELECT * FROM partner_tasks WHERE notifications_complete=0 ORDER BY created_at").all().map(task);
    },
    hasEvent(id, key) { return Boolean(db.prepare("SELECT 1 FROM partner_deliveries WHERE task_id=? AND event_key=?").get(id, key)); },
    recordEvents(id, entries, finished) {
      tx(() => {
        for (const entry of entries) {
          db.prepare(`INSERT OR IGNORE INTO partner_deliveries
            (id,task_id,event_key,body_json,callback_url,state,created_at,next_attempt_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(entry.body.event_id, id, entry.key, JSON.stringify(entry.body),
              entry.url || null, entry.url ? "pending" : "skipped", entry.now, entry.now);
        }
        if (finished) db.prepare("UPDATE partner_tasks SET notifications_complete=1 WHERE id=?").run(id);
      });
    },
    takeDelivery(now) {
      return tx(() => {
        db.prepare(`UPDATE partner_deliveries SET state='failed',last_error='DELIVERY_EXPIRED'
          WHERE state='pending' AND created_at<=?`).run(now - 86_400_000);
        const item = db.prepare(`SELECT * FROM partner_deliveries WHERE state='pending'
          AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT 1`).get(now);
        if (!item) return null;
        db.prepare("UPDATE partner_deliveries SET state='sending',attempts=attempts+1 WHERE id=?").run(item.id);
        return { ...item, attempts: item.attempts + 1 };
      });
    },
    completeDelivery(item, status, error, now) {
      const ok = status >= 200 && status < 300;
      const delay = Math.min(3_600_000, 10_000 * (2 ** Math.min(12, item.attempts - 1)));
      db.prepare(`UPDATE partner_deliveries SET state=?,last_http_status=?,last_error=?,next_attempt_at=? WHERE id=?`)
        .run(ok ? "delivered" : now + delay >= item.created_at + 86_400_000 ? "failed" : "pending",
          status || null, ok ? null : error || "CALLBACK_HTTP_ERROR", now + delay, item.id);
    },
    deliverySummary(id) {
      return db.prepare(`SELECT id AS event_id,state,attempts,last_http_status,last_error
        FROM partner_deliveries WHERE task_id=? ORDER BY created_at,rowid`).all(id);
    },
    expiredFiles(now) {
      return db.prepare("SELECT * FROM partner_items WHERE retention_until<=? AND purged_at IS NULL").all(now);
    },
    markPurged(item, now) {
      db.prepare("UPDATE partner_items SET purged_at=? WHERE task_id=? AND item_index=?").run(now, item.task_id, item.item_index);
    },
    expiredAssets(now, retentionMs) {
      return db.prepare("SELECT * FROM partner_tasks WHERE finished_at<=? AND assets_purged=0")
        .all(now - retentionMs).map(task);
    },
    markAssetsPurged(id) { db.prepare("UPDATE partner_tasks SET assets_purged=1 WHERE id=?").run(id); },
  };
}
