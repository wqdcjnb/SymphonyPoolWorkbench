import { openDatabase } from "./database.mjs";
import { randomUUID } from "node:crypto";

export const ITEM_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export async function createPartnerStore(databasePath) {
  const db = await openDatabase(databasePath);
  const initialize = async () => {
  (await db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
    CREATE INDEX IF NOT EXISTS partner_deliveries_due ON partner_deliveries(state,next_attempt_at);`));
  };
  try { if (db.kind === 'postgres') await db.transaction(initialize); else await initialize(); }
  catch (error) { await db.close(); throw error; }
  const tx = async (action) => (await db.transaction(action));
  const task = async (row) => row ? { ...row, payload: JSON.parse(row.payload_json),
    assets: JSON.parse(row.assets_json), items: (await db.prepare(
      `SELECT i.*,j.status AS jobStatus,j.error_code AS jobError,j.updated_at AS jobUpdatedAt,
      j.last_observed_stage AS lastObservedStage,j.last_observed_at AS lastObservedAt,
      j.collect_only AS collectOnly,j.remote_url AS remoteUrl,j.next_reconcile_at AS nextReconcileAt,
      j.reconcile_attempts AS reconcileAttempts,j.reconcile_deadline_at AS reconcileDeadlineAt
      FROM partner_items i LEFT JOIN jobs j ON j.id=i.job_id WHERE task_id=? ORDER BY item_index`).all(row.id)) } : null;
  const get = async (id) => (await task((await db.prepare("SELECT * FROM partner_tasks WHERE id=?").get(id))));
  const updateSummary = async (id, now) => {
    const current = (await get(id));
    const states = current.items.map((item) => item.state);
    const finished = states.every((state) => ITEM_TERMINAL.has(state));
    const successes = states.filter((state) => state === "succeeded").length;
    const state = finished
      ? states.includes("cancelled") ? "cancelled" : successes === current.count ? "succeeded"
        : successes ? "partially_succeeded" : "failed"
      : current.cancel_requested ? "cancelling" : states.includes("reconciling") ? "reconciling"
        : states.some((value) => !["pending", "queued"].includes(value)) ? "running" : "queued";
    (await db.prepare(`UPDATE partner_tasks SET state=?,updated_at=?,
      finished_at=CASE WHEN ? THEN COALESCE(finished_at,?) ELSE finished_at END WHERE id=?`)
      .run(state, now, finished ? 1 : 0, now, id));
    return (await get(id));
  };
  return {
    async syncProgress(id, now) {
      return tx(async () => {
        const current = await get(id);
        if (!current) return null;
        for (const item of current.items) {
          if (ITEM_TERMINAL.has(item.state) || !item.jobStatus || ['success','failed','cancelled'].includes(item.jobStatus)) continue;
          const state = item.jobStatus === 'reconciling' ? 'reconciling'
            : ['draft','queued'].includes(item.jobStatus) ? 'queued' : 'running';
          if (state !== item.state || item.error_code !== item.jobError) {
            await this.updateItem(item,state,{errorCode:item.jobError || null},now);
          }
        }
        return get(id);
      });
    },
    async close() { (await db.close()); },
    get,
    async find(clientId) { return (await task((await db.prepare("SELECT * FROM partner_tasks WHERE client_task_id=?").get(clientId)))); },
    async create({ id, payload, assets, hash, legacyRatioHash, now, maxPendingTasks = 1000 }) {
      return (await tx(async () => {
        const previous = (await this.find(payload.client_task_id));
        if (previous) {
          if (previous.request_hash !== hash && previous.request_hash !== legacyRatioHash) throw new Error("ID_CONFLICT");
          return { created: false, task: previous };
        }
        if ((await db.prepare("SELECT COUNT(*) AS n FROM partner_tasks WHERE finished_at IS NULL").get()).n >= maxPendingTasks) {
          throw new Error("QUEUE_FULL");
        }
        (await db.prepare(`INSERT INTO partner_tasks
          (id,client_task_id,request_hash,payload_json,assets_json,count,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(id, payload.client_task_id, hash, JSON.stringify(payload),
          JSON.stringify(assets), payload.count, now, now));
        const insert = db.prepare("INSERT INTO partner_items(task_id,item_index,batch_index) VALUES (?,?,?)");
        for (let index = 1; index <= payload.count; index++) (await insert.run(id, index, Math.ceil(index / 2)));
        return { created: true, task: (await get(id)) };
      }));
    },
    async dispatchRounds(now) {
      return (await tx(async () => {
        const pending = (await db.prepare(`SELECT * FROM partner_tasks WHERE finished_at IS NULL
          AND cancel_requested=0 ORDER BY updated_at,created_at,rowid`).all());
        let dispatched = 0;
        for (const row of pending) {
          const current = (await task(row));
          if (current.items.some((item) => item.job_id && !ITEM_TERMINAL.has(item.state))) continue;
          const first = current.items.find((item) => item.state === "pending");
          if (!first) continue;
          const members = current.items.filter((item) => item.batch_index === first.batch_index);
          for (const item of members) {
            const jobId = `job-${randomUUID()}`;
            const p = current.payload;
            (await db.prepare(`INSERT INTO jobs
              (id,idempotency_key,mode,model,requested_model,duration_seconds,aspect_ratio,prompt,
               negative_prompt,concurrency,batch_id,batch_index,batch_size,reference_assets_json,
               reference_asset_names_json,priority,status,queued_at,created_at,updated_at)
              VALUES (?,?,'image_to_video',?,?,?,?,?,?,1,?,?,?,?,?,50,'queued',?,?,?)`)
              .run(jobId, `partner:${current.id}:${item.item_index}`, p.model, p.model, p.duration,
                p.ratio, p.prompt, p.negative_prompt, current.id, item.item_index, current.count,
                JSON.stringify(current.assets.map((asset) => asset.path)),
                JSON.stringify(current.assets.map((asset) => asset.name)), now, now, now));
            (await db.prepare("UPDATE partner_items SET job_id=?,state='queued' WHERE task_id=? AND item_index=?")
              .run(jobId, current.id, item.item_index));
            (await db.prepare(`INSERT INTO events(id,job_id,event_type,message,details_json,created_at)
              VALUES (?,?,'job.queued','合作方 API 任务已加入队列',?,?)`)
              .run(randomUUID(), jobId, JSON.stringify({ taskId: current.id,
                clientTaskId: current.client_task_id, index: item.item_index }), now));
            dispatched++;
          }
          (await db.prepare("UPDATE partner_tasks SET updated_at=? WHERE id=?").run(now, current.id));
        }
        return dispatched;
      }));
    },
    async unsettledItems() {
      return (await db.prepare(`SELECT i.*,j.status AS job_status,j.result_path AS job_result_path,
        j.error_code AS job_error,j.completed_at AS job_completed_at
        FROM partner_items i JOIN jobs j ON j.id=i.job_id
        WHERE i.state NOT IN ('succeeded','failed','cancelled')`).all());
    },
    async updateItem(item, state, extra, now) {
      (await tx(async () => {
        (await db.prepare(`UPDATE partner_items SET state=?,error_code=?,result_path=?,size_bytes=?,sha256=?,
          completed_at=?,retention_until=? WHERE task_id=? AND item_index=?
          AND state NOT IN ('succeeded','failed','cancelled')`)
          .run(state, extra.errorCode ?? null, extra.path ?? null, extra.size ?? null, extra.sha256 ?? null,
            ITEM_TERMINAL.has(state) ? extra.completedAt ?? now : null, extra.retentionUntil ?? null,
            item.task_id, item.item_index));
        (await updateSummary(item.task_id, now));
      }));
    },
    async cancel(id, now) {
      return (await tx(async () => {
        const current = (await get(id));
        if (!current) throw new Error("TASK_NOT_FOUND");
        if (current.finished_at) return current;
        (await db.prepare("UPDATE partner_tasks SET cancel_requested=1,updated_at=? WHERE id=?").run(now, id));
        for (const item of current.items) {
          if (ITEM_TERMINAL.has(item.state)) continue;
          if (item.job_id) {
            (await db.prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?").run(item.job_id));
            const job = (await db.prepare("SELECT status FROM jobs WHERE id=?").get(item.job_id));
            if (!["draft", "queued"].includes(job.status)) continue;
            (await db.prepare("UPDATE jobs SET status='cancelled',completed_at=?,updated_at=? WHERE id=?")
              .run(now, now, item.job_id));
            (await db.prepare(`INSERT INTO events(id,job_id,event_type,message,created_at)
              VALUES (?,?,'job.cancelled','合作方取消了尚未提交的任务',?)`).run(randomUUID(), item.job_id, now));
          }
          (await db.prepare("UPDATE partner_items SET state='cancelled',completed_at=? WHERE task_id=? AND item_index=?")
            .run(now, id, item.item_index));
        }
        return (await updateSummary(id, now));
      }));
    },
    // Operator-only retry for a corrected delivery processor; never requeues a
    // platform job. Callback-enabled tasks need a separately agreed correction.
    async retryDelivery(id, now) {
      return tx(async()=>{
        const current=await get(id);
        if(!current)throw new Error('TASK_NOT_FOUND');
        if(current.payload.callback_url || await db.prepare("SELECT 1 FROM partner_deliveries WHERE task_id=? AND state<>'skipped'").get(id)) {
          throw new Error('DELIVERY_RETRY_REQUIRES_CALLBACK_COORDINATION');
        }
        const items=current.items.filter(item=>item.state==='failed'
          && ['WATERMARK_REPAIR_FAILED','WATERMARK_REPAIR_UNSUPPORTED_LAYOUT'].includes(item.error_code));
        if(current.payload.delivery_mode!=='watermark_repair' || current.cancel_requested || !current.finished_at || !items.length) {
          throw new Error('DELIVERY_NOT_RETRYABLE');
        }
        for(const item of items){
          const job=await db.prepare('SELECT status FROM jobs WHERE id=?').get(item.job_id);
          if(job?.status!=='success')throw new Error('DELIVERY_NOT_RETRYABLE');
          await db.prepare("UPDATE partner_items SET state='running',error_code=NULL,completed_at=NULL WHERE task_id=? AND item_index=?")
            .run(id,item.item_index);
          await db.prepare(`INSERT INTO events(id,job_id,event_type,message,details_json,created_at)
            VALUES (?,?,'partner.delivery_retry','已修复交付处理，重新处理现有视频；不重新生成',?,?)`)
            .run(randomUUID(),item.job_id,JSON.stringify({taskId:id,previousError:item.error_code}),now);
        }
        await db.prepare('UPDATE partner_tasks SET finished_at=NULL,notifications_complete=0 WHERE id=?').run(id);
        return updateSummary(id,now);
      });
    },
    async notificationsPending() {
      return (await Promise.all((await db.prepare("SELECT * FROM partner_tasks WHERE notifications_complete=0 ORDER BY created_at").all()).map(task)));
    },
    async hasEvent(id, key) { return Boolean((await db.prepare("SELECT 1 FROM partner_deliveries WHERE task_id=? AND event_key=?").get(id, key))); },
    async recordEvents(id, entries, finished) {
      (await tx(async () => {
        for (const entry of entries) {
          (await db.prepare(`INSERT OR IGNORE INTO partner_deliveries
            (id,task_id,event_key,body_json,callback_url,state,created_at,next_attempt_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(entry.body.event_id, id, entry.key, JSON.stringify(entry.body),
              entry.url || null, entry.url ? "pending" : "skipped", entry.now, entry.now));
        }
        if (finished) (await db.prepare("UPDATE partner_tasks SET notifications_complete=1 WHERE id=?").run(id));
      }));
    },
    async takeDelivery(now) {
      return (await tx(async () => {
        await db.prepare("UPDATE partner_deliveries SET state='pending' WHERE state='sending' AND next_attempt_at<=?").run(now);
        (await db.prepare(`UPDATE partner_deliveries SET state='failed',last_error='DELIVERY_EXPIRED'
          WHERE state='pending' AND created_at<=?`).run(now - 86_400_000));
        const item = (await db.prepare(`SELECT * FROM partner_deliveries WHERE state='pending'
          AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT 1`).get(now));
        if (!item) return null;
        (await db.prepare("UPDATE partner_deliveries SET state='sending',attempts=attempts+1,next_attempt_at=? WHERE id=?").run(now+90_000,item.id));
        return { ...item, attempts: item.attempts + 1 };
      }));
    },
    async completeDelivery(item, status, error, now) {
      const ok = status >= 200 && status < 300;
      const delay = Math.min(3_600_000, 10_000 * (2 ** Math.min(12, item.attempts - 1)));
      (await db.prepare(`UPDATE partner_deliveries SET state=?,last_http_status=?,last_error=?,next_attempt_at=? WHERE id=? AND attempts=? AND state='sending'`)
        .run(ok ? "delivered" : now + delay >= item.created_at + 86_400_000 ? "failed" : "pending",
          status || null, ok ? null : error || "CALLBACK_HTTP_ERROR", now + delay, item.id,item.attempts));
    },
    async deliverySummary(id) {
      return (await db.prepare(`SELECT id AS event_id,state,attempts,last_http_status,last_error
        FROM partner_deliveries WHERE task_id=? ORDER BY created_at,rowid`).all(id));
    },
    async expiredFiles(now) {
      return (await db.prepare("SELECT * FROM partner_items WHERE retention_until<=? AND purged_at IS NULL").all(now));
    },
    async markPurged(item, now) {
      (await db.prepare("UPDATE partner_items SET purged_at=? WHERE task_id=? AND item_index=?").run(now, item.task_id, item.item_index));
    },
    async expiredAssets(now, retentionMs) {
      return (await Promise.all((await db.prepare("SELECT * FROM partner_tasks WHERE finished_at<=? AND assets_purged=0")
        .all(now - retentionMs)).map(task)));
    },
    async markAssetsPurged(id) { (await db.prepare("UPDATE partner_tasks SET assets_purged=1 WHERE id=?").run(id)); },
  };
}
