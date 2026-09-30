import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { VideoApiError, validateTaskId } from "./nocsnow-api.mjs";

const TERMINAL = new Set(["succeeded", "failed"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function createVideoApiStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS video_api_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_fingerprint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      requested_count INTEGER NOT NULL,
      dispatched_count INTEGER NOT NULL DEFAULT 0,
      queue_seq INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(key_fingerprint, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS video_api_batches_owner_idx
      ON video_api_batches(key_fingerprint, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS video_api_batches_queue_idx
      ON video_api_batches(status, queue_seq);
    CREATE TABLE IF NOT EXISTS video_api_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES video_api_batches(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      count INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitting',
      retry_after INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(batch_id, turn_index)
    );
    CREATE TABLE IF NOT EXISTS video_api_tasks (
      id TEXT PRIMARY KEY,
      turn_id INTEGER NOT NULL REFERENCES video_api_turns(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      raw_status TEXT,
      points_cost REAL,
      status_url TEXT,
      result_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS video_api_tasks_turn_idx ON video_api_tasks(turn_id);
  `);
  const taskColumns = new Set(db.prepare("PRAGMA table_info(video_api_tasks)")
    .all().map((column) => column.name));
  if (!taskColumns.has("local_result_path")) {
    db.exec("ALTER TABLE video_api_tasks ADD COLUMN local_result_path TEXT");
  }
  if (!taskColumns.has("result_error_code")) {
    db.exec("ALTER TABLE video_api_tasks ADD COLUMN result_error_code TEXT");
  }
  if (!taskColumns.has("result_retry_after")) {
    db.exec("ALTER TABLE video_api_tasks ADD COLUMN result_retry_after INTEGER NOT NULL DEFAULT 0");
  }

  const transaction = (callback) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const nextQueueSequence = () => Number(db.prepare(
    "SELECT COALESCE(MAX(queue_seq),0)+1 AS next FROM video_api_batches").get().next);
  const batchRow = (id) => db.prepare(`SELECT id,key_fingerprint AS fingerprint,
    idempotency_key AS idempotencyKey,payload_json AS payloadJson,
    requested_count AS requestedCount,dispatched_count AS dispatchedCount,
    status,error_code AS errorCode,created_at AS createdAt,updated_at AS updatedAt
    FROM video_api_batches WHERE id=?`).get(id);
  const tasksForBatch = db.prepare(`SELECT t.id,t.status,t.raw_status AS rawStatus,
    t.points_cost AS pointsCost,t.result_url AS resultUrl,
    t.local_result_path IS NOT NULL AS resultSaved,t.result_error_code AS resultErrorCode,
    t.created_at AS createdAt,t.updated_at AS updatedAt
    FROM video_api_tasks t JOIN video_api_turns r ON r.id=t.turn_id
    WHERE r.batch_id=? ORDER BY r.turn_index,t.rowid`);
  const asBatch = (row) => ({ id: row.id, idempotencyKey: row.idempotencyKey,
    payload: JSON.parse(row.payloadJson), requestedCount: row.requestedCount,
    dispatchedCount: row.dispatchedCount, status: row.status, errorCode: row.errorCode,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    tasks: tasksForBatch.all(row.id).map((task) => ({ ...task,
      resultSaved: Boolean(task.resultSaved) })) });

  return {
    close() { db.close(); },

    enqueue(fingerprint, idempotencyKey, payload) {
      return transaction(() => {
        const payloadJson = JSON.stringify(payload);
        const payloadHash = digest(payloadJson);
        const existing = db.prepare(`SELECT id,payload_hash AS payloadHash FROM video_api_batches
          WHERE key_fingerprint=? AND idempotency_key=?`).get(fingerprint, idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== payloadHash) throw new VideoApiError(409, "IDEMPOTENCY_CONFLICT");
          return asBatch(batchRow(existing.id));
        }
        const now = Date.now();
        const inserted = db.prepare(`INSERT INTO video_api_batches
          (key_fingerprint,idempotency_key,payload_hash,payload_json,
           requested_count,queue_seq,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(fingerprint, idempotencyKey, payloadHash, payloadJson,
          payload.count, nextQueueSequence(), now, now);
        return asBatch(batchRow(Number(inserted.lastInsertRowid)));
      });
    },

    getBatch(fingerprint, batchId) {
      const row = batchRow(batchId);
      return row?.fingerprint === fingerprint ? asBatch(row) : null;
    },

    listBatches(fingerprint, { page = 1, pageSize = 10 } = {}) {
      const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM video_api_batches
        WHERE key_fingerprint=?`).get(fingerprint).total);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(page, totalPages);
      const rows = db.prepare(`SELECT id FROM video_api_batches WHERE key_fingerprint=?
        ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
        .all(fingerprint, pageSize, (currentPage - 1) * pageSize);
      return { batches: rows.map((row) => asBatch(batchRow(row.id))),
        page: currentPage, pageSize, total, totalPages };
    },

    listWorkbenchIndex({ status = "all", page = 1, pageSize = 6 } = {}) {
      const accountWhere = status === "all" ? "1=1" : status === "active"
        ? "status IN ('leased','submitting','submitted','generating','collecting')" : "status=?";
      const accountArgs = status === "all" || status === "active" ? [] : [status];
      const failedTask = `EXISTS (SELECT 1 FROM video_api_tasks t
        JOIN video_api_turns r ON r.id=t.turn_id
        WHERE r.batch_id=b.id AND t.status='failed')`;
      const apiWhere = status === "success"
        ? `b.status='completed' AND NOT ${failedTask}`
        : status === "failed"
          ? `(b.status='blocked' OR (b.status='completed' AND ${failedTask}))`
          : status === "active"
            ? "b.status='running'"
          : "1=1";
      const accountTotal = Number(db.prepare(`SELECT COUNT(*) AS total FROM jobs
        WHERE ${accountWhere}`).get(...accountArgs).total);
      const apiTotal = Number(db.prepare(`SELECT COUNT(*) AS total FROM video_api_batches b
        WHERE ${apiWhere}`).get().total);
      const total = accountTotal + apiTotal;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(page, totalPages);
      const items = db.prepare(`SELECT source,id,updated_at AS updatedAt FROM (
        SELECT 'account_pool' AS source,id,updated_at FROM jobs WHERE ${accountWhere}
        UNION ALL
        SELECT 'video_api' AS source,CAST(b.id AS TEXT) AS id,b.updated_at
        FROM video_api_batches b WHERE ${apiWhere}
      ) ORDER BY updatedAt DESC,source DESC,id DESC LIMIT ? OFFSET ?`)
        .all(...accountArgs, pageSize, (currentPage - 1) * pageSize);
      return { items, status, page: currentPage, pageSize, total, totalPages };
    },

    getWorkbenchBatch(batchId) {
      const row = batchRow(batchId);
      return row ? asBatch(row) : null;
    },

    getLocalResult(taskId) {
      return db.prepare(`SELECT t.status,t.local_result_path AS path FROM video_api_tasks t
        WHERE t.id=?`).get(taskId) || null;
    },

    hasPendingResults(fingerprint) {
      return Boolean(db.prepare(`SELECT 1 FROM video_api_tasks t
        JOIN video_api_turns r ON r.id=t.turn_id
        JOIN video_api_batches b ON b.id=r.batch_id
        WHERE b.key_fingerprint=? AND t.status='succeeded'
          AND t.local_result_path IS NULL LIMIT 1`).get(fingerprint));
    },

    pendingResults(fingerprints, limit = 8) {
      if (!fingerprints.length) return [];
      const rows = [];
      for (let index = 0; index < fingerprints.length; index += 100) {
        const chunk = fingerprints.slice(index, index + 100);
        const placeholders = chunk.map(() => "?").join(",");
        rows.push(...db.prepare(`SELECT t.id,b.key_fingerprint AS fingerprint,
          t.updated_at AS updatedAt FROM video_api_tasks t
          JOIN video_api_turns r ON r.id=t.turn_id
          JOIN video_api_batches b ON b.id=r.batch_id
          WHERE t.status='succeeded' AND t.local_result_path IS NULL
            AND t.result_retry_after<=?
            AND b.key_fingerprint IN (${placeholders})
          ORDER BY t.updated_at ASC LIMIT ?`).all(Date.now(), ...chunk, limit));
      }
      return rows.sort((left, right) => left.updatedAt - right.updatedAt).slice(0, limit);
    },

    markResultSaved(fingerprint, taskId, resultPath) {
      db.prepare(`UPDATE video_api_tasks SET local_result_path=?,result_error_code=NULL,
        result_retry_after=0,
        updated_at=? WHERE id=? AND status='succeeded' AND turn_id IN (
          SELECT r.id FROM video_api_turns r JOIN video_api_batches b ON b.id=r.batch_id
          WHERE b.key_fingerprint=?)`).run(resultPath, Date.now(), taskId, fingerprint);
    },

    markResultError(fingerprint, taskId, errorCode, retryAfterMs = 15_000) {
      const now = Date.now();
      db.prepare(`UPDATE video_api_tasks SET result_error_code=?,result_retry_after=?,updated_at=?
        WHERE id=? AND status='succeeded' AND local_result_path IS NULL AND turn_id IN (
          SELECT r.id FROM video_api_turns r JOIN video_api_batches b ON b.id=r.batch_id
          WHERE b.key_fingerprint=?)`).run(errorCode, now + retryAfterMs, now,
          taskId, fingerprint);
    },

    hasOpenWork(fingerprint) {
      return Boolean(db.prepare(`SELECT 1 FROM video_api_batches WHERE key_fingerprint=?
        AND status IN ('queued','running') LIMIT 1`).get(fingerprint));
    },

    activeTasks(fingerprints, limit = 40) {
      if (!fingerprints.length) return [];
      const rows = [];
      for (let index = 0; index < fingerprints.length; index += 100) {
        const chunk = fingerprints.slice(index, index + 100);
        const placeholders = chunk.map(() => "?").join(",");
        rows.push(...db.prepare(`SELECT t.id,t.status,r.batch_id AS batchId,
          b.key_fingerprint AS fingerprint,t.updated_at AS updatedAt
          FROM video_api_tasks t JOIN video_api_turns r ON r.id=t.turn_id
          JOIN video_api_batches b ON b.id=r.batch_id
          WHERE r.status='active' AND t.status NOT IN ('succeeded','failed')
          AND b.key_fingerprint IN (${placeholders})
          ORDER BY t.updated_at ASC LIMIT ?`).all(...chunk, limit));
      }
      return rows.sort((left, right) => left.updatedAt - right.updatedAt).slice(0, limit);
    },

    reserveNextTurn(fingerprints, maxActiveTasks = 8, excludeTurnIds = []) {
      if (!fingerprints.length) return null;
      return transaction(() => {
        const allowed = new Set(fingerprints);
        const active = db.prepare(`SELECT b.key_fingerprint AS fingerprint,
          SUM(CASE WHEN r.status='submitting' THEN r.count ELSE
            (SELECT COUNT(*) FROM video_api_tasks t WHERE t.turn_id=r.id
              AND t.status NOT IN ('succeeded','failed')) END) AS count
          FROM video_api_turns r JOIN video_api_batches b ON b.id=r.batch_id
          WHERE r.status IN ('submitting','active')
          GROUP BY b.key_fingerprint`).all();
        const perKey = new Map(active.map((item) => [item.fingerprint, Number(item.count)]));
        const globalActive = active.filter((item) => allowed.has(item.fingerprint))
          .reduce((sum, item) => sum + Number(item.count), 0);
        const now = Date.now();
        const excluded = new Set(excludeTurnIds);
        const retry = db.prepare(`SELECT r.id,r.batch_id AS batchId,r.count,
          r.idempotency_key AS idempotencyKey,b.key_fingerprint AS fingerprint,
          b.payload_json AS payloadJson FROM video_api_turns r
          JOIN video_api_batches b ON b.id=r.batch_id
          WHERE r.status='submitting' AND r.retry_after<=?
          ORDER BY r.created_at,r.id`).all(now)
          .find((item) => allowed.has(item.fingerprint) && !excluded.has(item.id));
        if (retry) return { ...retry, payload: { ...JSON.parse(retry.payloadJson), count: retry.count } };
        if (globalActive >= maxActiveTasks) return null;
        const candidates = db.prepare(`SELECT id,key_fingerprint AS fingerprint,
          payload_json AS payloadJson,requested_count AS requestedCount,
          dispatched_count AS dispatchedCount FROM video_api_batches
          WHERE status='queued' AND dispatched_count<requested_count
          ORDER BY queue_seq,id`).all();
        const nextCount = (item) => Math.min(2, item.requestedCount - item.dispatchedCount);
        const batch = candidates.find((item) => allowed.has(item.fingerprint)
          && 2 - (perKey.get(item.fingerprint) || 0) >= nextCount(item)
          && maxActiveTasks - globalActive >= nextCount(item));
        if (!batch) return null;
        const count = nextCount(batch);
        if (count < 1) return null;
        const turnIndex = Number(db.prepare(`SELECT COALESCE(MAX(turn_index),0)+1 AS next
          FROM video_api_turns WHERE batch_id=?`).get(batch.id).next);
        const idempotencyKey = `wb-${digest(`${batch.fingerprint}:${batch.id}:${turnIndex}`)}`;
        const inserted = db.prepare(`INSERT INTO video_api_turns
          (batch_id,turn_index,count,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?)`).run(batch.id, turnIndex, count, idempotencyKey, now, now);
        db.prepare(`UPDATE video_api_batches SET dispatched_count=dispatched_count+?,
          status='running',error_code=NULL,updated_at=? WHERE id=?`).run(count, now, batch.id);
        return { id: Number(inserted.lastInsertRowid), batchId: batch.id, count,
          idempotencyKey, fingerprint: batch.fingerprint,
          payload: { ...JSON.parse(batch.payloadJson), count } };
      });
    },

    acceptTurn(turnId, response) {
      const tasks = response?.data?.tasks;
      const turn = db.prepare("SELECT count FROM video_api_turns WHERE id=?").get(turnId);
      if (!turn || !Array.isArray(tasks) || tasks.length !== turn.count
        || tasks.some((task) => {
          try { validateTaskId(task.id); } catch { return true; }
          return typeof task.status !== "string";
        })) {
        throw new VideoApiError(502, "VIDEO_API_INVALID_RESPONSE");
      }
      transaction(() => {
        const now = Date.now();
        db.prepare(`UPDATE video_api_turns SET status='active',error_code=NULL,
          retry_after=0,updated_at=? WHERE id=?`).run(now, turnId);
        const insert = db.prepare(`INSERT INTO video_api_tasks
          (id,turn_id,status,raw_status,points_cost,status_url,result_url,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status,
            raw_status=excluded.raw_status,points_cost=excluded.points_cost,
            status_url=excluded.status_url,result_url=excluded.result_url,updated_at=excluded.updated_at`);
        for (const task of tasks) insert.run(task.id, turnId, task.status, task.raw_status || null,
          Number.isFinite(Number(task.points_cost)) ? Number(task.points_cost) : null,
          task.status_url || null, task.result_url || null, now, now);
      });
      this.completeFinishedTurns();
    },

    deferTurn(turnId, error, retryAfterMs = 15_000) {
      const blocked = error.status >= 400 && error.status < 500 && error.status !== 429;
      const turn = db.prepare("SELECT batch_id AS batchId FROM video_api_turns WHERE id=?").get(turnId);
      if (!turn) return;
      transaction(() => {
        const now = Date.now();
        db.prepare(`UPDATE video_api_turns SET status=?,error_code=?,retry_after=?,updated_at=? WHERE id=?`)
          .run(blocked ? "blocked" : "submitting", error.code || "VIDEO_API_UNAVAILABLE",
            blocked ? 0 : now + retryAfterMs, now, turnId);
        if (blocked) db.prepare(`UPDATE video_api_batches SET status='blocked',error_code=?,updated_at=?
          WHERE id=?`).run(error.code || "VIDEO_API_UPSTREAM_ERROR", now, turn.batchId);
      });
    },

    retryBlocked(fingerprint, batchId) {
      return transaction(() => {
        const batch = batchRow(batchId);
        if (!batch || batch.fingerprint !== fingerprint) throw new VideoApiError(404, "VIDEO_API_BATCH_NOT_FOUND");
        if (batch.status !== "blocked") throw new VideoApiError(409, "VIDEO_API_BATCH_NOT_BLOCKED");
        const now = Date.now();
        db.prepare(`UPDATE video_api_turns SET status=CASE WHEN EXISTS (
          SELECT 1 FROM video_api_tasks t WHERE t.turn_id=video_api_turns.id
          ) THEN 'active' ELSE 'submitting' END,
          retry_after=0,error_code=NULL,updated_at=?
          WHERE batch_id=? AND status='blocked'`).run(now, batchId);
        db.prepare(`UPDATE video_api_batches SET status='running',error_code=NULL,updated_at=? WHERE id=?`)
          .run(now, batchId);
        return asBatch(batchRow(batchId));
      });
    },

    blockBatch(batchId, code) {
      transaction(() => {
        const now = Date.now();
        db.prepare(`UPDATE video_api_batches SET status='blocked',error_code=?,updated_at=? WHERE id=?`)
          .run(code, now, batchId);
        db.prepare(`UPDATE video_api_turns SET status='blocked',error_code=?,updated_at=?
          WHERE batch_id=? AND status IN ('submitting','active')`).run(code, now, batchId);
      });
    },

    updateTask(fingerprint, taskId, response) {
      const item = response?.data?.task || response?.data || response?.task || response;
      if (!item || typeof item.status !== "string") return;
      db.prepare(`UPDATE video_api_tasks SET status=?,raw_status=?,points_cost=COALESCE(?,points_cost),
        result_url=COALESCE(?,result_url),updated_at=? WHERE id=? AND turn_id IN (
          SELECT r.id FROM video_api_turns r JOIN video_api_batches b ON b.id=r.batch_id
          WHERE b.key_fingerprint=?)`)
        .run(item.status, item.raw_status || null,
          Number.isFinite(Number(item.points_cost)) ? Number(item.points_cost) : null,
          item.result_url || null, Date.now(), taskId, fingerprint);
      this.completeFinishedTurns();
    },

    completeFinishedTurns() {
      transaction(() => {
        const turns = db.prepare(`SELECT r.id,r.batch_id AS batchId FROM video_api_turns r
          WHERE r.status='active' AND NOT EXISTS (
            SELECT 1 FROM video_api_tasks t WHERE t.turn_id=r.id
            AND t.status NOT IN ('succeeded','failed'))`).all();
        for (const turn of turns) {
          const taskCount = Number(db.prepare("SELECT COUNT(*) AS count FROM video_api_tasks WHERE turn_id=?")
            .get(turn.id).count);
          if (!taskCount) continue;
          const now = Date.now();
          db.prepare("UPDATE video_api_turns SET status='completed',updated_at=? WHERE id=?")
            .run(now, turn.id);
          const batch = batchRow(turn.batchId);
          if (batch.dispatchedCount >= batch.requestedCount) {
            db.prepare(`UPDATE video_api_batches SET status='completed',updated_at=? WHERE id=?`)
              .run(now, turn.batchId);
          } else {
            db.prepare(`UPDATE video_api_batches SET status='queued',queue_seq=?,updated_at=? WHERE id=?`)
              .run(nextQueueSequence(), now, turn.batchId);
          }
        }
      });
    },
  };
}
