import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ACCOUNT_STATUSES = new Set([
  "provisioning",
  "auth_required",
  "checking",
  "ready",
  "busy",
  "cooling",
  "degraded",
  "disabled",
  "error",
]);

const JOB_STATUSES = new Set([
  "draft",
  "queued",
  "leased",
  "reconciling",
  "success",
  "failed",
  "cancelled",
]);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function asAccount(row) {
  if (!row) return null;
  return {
    ...row,
    models: parseJson(row.modelsJson, []),
    modelsJson: undefined,
  };
}

function asJob(row) {
  if (!row) return null;
  return {
    ...row,
    referenceAssets: parseJson(row.referenceAssetsJson, []),
    referenceAssetsJson: undefined,
  };
}

export function createStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      login_type TEXT NOT NULL CHECK(login_type IN ('tiktok','doubao')),
      service TEXT NOT NULL DEFAULT 'symphony',
      worker_id TEXT NOT NULL,
      profile_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'provisioning',
      health_score INTEGER NOT NULL DEFAULT 0 CHECK(health_score BETWEEN 0 AND 100),
      credits_remaining INTEGER,
      credits_total INTEGER,
      credits_reset_at TEXT,
      reference_image_limit INTEGER,
      models_json TEXT NOT NULL DEFAULT '[]',
      last_verified_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS accounts_dispatch_idx
      ON accounts(service, status, health_score, updated_at);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      mode TEXT NOT NULL,
      model TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 60),
      prompt TEXT NOT NULL,
      reference_assets_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS jobs_queue_idx
      ON jobs(status, priority DESC, created_at ASC);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS events_recent_idx ON events(created_at DESC);
  `);

  const transaction = (callback) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  };

  const insertEvent = ({ accountId = null, jobId = null, eventType, message, details = {} }) => {
    const timestamp = Date.now();
    db.prepare(`INSERT INTO events
      (id, account_id, job_id, event_type, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), accountId, jobId, eventType, message, JSON.stringify(details), timestamp);
  };

  return {
    close() {
      db.close();
    },

    ensureAccount(input) {
      const timestamp = Date.now();
      return transaction(() => {
        const inserted = db.prepare(`INSERT OR IGNORE INTO accounts
          (id, label, login_type, service, worker_id, profile_path, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.id, input.label, input.loginType, input.service || "symphony", input.workerId,
            input.profilePath, input.status || "provisioning", timestamp, timestamp);
        if (inserted.changes) {
          insertEvent({
            accountId: input.id,
            eventType: "account.created",
            message: "账号档案已加入工作台",
            details: { loginType: input.loginType, workerId: input.workerId },
          });
        }
        return asAccount(db.prepare(`SELECT id, label, login_type AS loginType, service,
          worker_id AS workerId, profile_path AS profilePath, status,
          health_score AS healthScore, credits_remaining AS creditsRemaining,
          credits_total AS creditsTotal, credits_reset_at AS creditsResetAt,
          reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
          last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
          created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id=?`).get(input.id));
      });
    },

    getAccount(id) {
      return asAccount(db.prepare(`SELECT id, label, login_type AS loginType, service,
        worker_id AS workerId, profile_path AS profilePath, status,
        health_score AS healthScore, credits_remaining AS creditsRemaining,
        credits_total AS creditsTotal, credits_reset_at AS creditsResetAt,
        reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
        last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
        created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id=?`).get(id));
    },

    listAccounts() {
      return db.prepare(`SELECT id, label, login_type AS loginType, service,
        worker_id AS workerId, profile_path AS profilePath, status,
        health_score AS healthScore, credits_remaining AS creditsRemaining,
        credits_total AS creditsTotal, credits_reset_at AS creditsResetAt,
        reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
        last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
        created_at AS createdAt, updated_at AS updatedAt
        FROM accounts ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'checking' THEN 1 ELSE 2 END,
        label COLLATE NOCASE`).all().map(asAccount);
    },

    setAccountChecking(id) {
      const timestamp = Date.now();
      const result = db.prepare("UPDATE accounts SET status='checking', updated_at=? WHERE id=?")
        .run(timestamp, id);
      if (!result.changes) throw new Error("ACCOUNT_NOT_FOUND");
      insertEvent({ accountId: id, eventType: "account.checking", message: "开始只读验收" });
    },

    saveVerification(id, result) {
      const timestamp = Date.now();
      const status = result.ok ? "ready"
        : result.loggedIn ? "degraded"
          : new Set(["LOGIN_REQUIRED", "PROFILE_NOT_FOUND"]).has(result.error) ? "auth_required" : "error";
      return transaction(() => {
        const updated = db.prepare(`UPDATE accounts SET status=?, health_score=?,
          credits_remaining=?, credits_total=?, credits_reset_at=?, reference_image_limit=?,
          models_json=?, last_verified_at=?, last_error_code=?, updated_at=? WHERE id=?`)
          .run(status, result.ok ? 100 : 25, result.remainingCredits, result.totalCredits,
            result.nextRefresh, result.referenceImageLimit, JSON.stringify(result.modelsObserved || []),
            timestamp, result.error || null, timestamp, id);
        if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
        insertEvent({
          accountId: id,
          eventType: result.ok ? "account.verified" : "account.verification_failed",
          message: result.ok ? "只读验收通过" : "只读验收未通过",
          details: {
            status,
            stage: result.stage || null,
            remainingCredits: result.remainingCredits ?? null,
            totalCredits: result.totalCredits ?? null,
            error: result.error || null,
          },
        });
        return this.getAccount(id);
      });
    },

    saveVerificationFailure(id, errorCode) {
      const timestamp = Date.now();
      return transaction(() => {
        db.prepare("UPDATE accounts SET status='error', health_score=0, last_error_code=?, updated_at=? WHERE id=?")
          .run(errorCode, timestamp, id);
        insertEvent({
          accountId: id,
          eventType: "account.verification_error",
          message: "只读验收执行异常",
          details: { errorCode },
        });
      });
    },

    recordProfileOpened(id) {
      return transaction(() => {
        db.prepare("UPDATE accounts SET status=CASE WHEN status='provisioning' THEN 'auth_required' ELSE status END, updated_at=? WHERE id=?")
          .run(Date.now(), id);
        insertEvent({ accountId: id, eventType: "account.profile_opened", message: "已打开专用登录窗口" });
      });
    },

    createDraftJob(input) {
      if (!JOB_STATUSES.has("draft")) throw new Error("INVALID_JOB_STATUS");
      const timestamp = Date.now();
      const id = `job-${randomUUID()}`;
      return transaction(() => {
        db.prepare(`INSERT INTO jobs
          (id, idempotency_key, account_id, mode, model, duration_seconds, prompt,
           reference_assets_json, priority, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
          .run(id, input.idempotencyKey, input.accountId || null, input.mode, input.model,
            input.durationSeconds, input.prompt, JSON.stringify(input.referenceAssets || []),
            input.priority, timestamp, timestamp);
        insertEvent({
          accountId: input.accountId || null,
          jobId: id,
          eventType: "job.draft_created",
          message: "已保存任务草稿，尚未提交生成",
          details: { mode: input.mode, model: input.model, durationSeconds: input.durationSeconds },
        });
        return asJob(db.prepare(`SELECT id, idempotency_key AS idempotencyKey,
          account_id AS accountId, mode, model, duration_seconds AS durationSeconds,
          prompt, reference_assets_json AS referenceAssetsJson, priority, status,
          created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id=?`).get(id));
      });
    },

    listJobs(limit = 100) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      return db.prepare(`SELECT id, idempotency_key AS idempotencyKey,
        account_id AS accountId, mode, model, duration_seconds AS durationSeconds,
        prompt, reference_assets_json AS referenceAssetsJson, priority, status,
        created_at AS createdAt, updated_at AS updatedAt
        FROM jobs ORDER BY created_at DESC LIMIT ?`).all(safeLimit).map(asJob);
    },

    cancelJob(id) {
      const timestamp = Date.now();
      return transaction(() => {
        const job = db.prepare("SELECT status FROM jobs WHERE id=?").get(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (!new Set(["draft", "queued"]).has(job.status)) throw new Error("JOB_NOT_CANCELLABLE");
        db.prepare("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?").run(timestamp, id);
        insertEvent({ jobId: id, eventType: "job.cancelled", message: "任务草稿已取消" });
      });
    },

    listEvents(limit = 60) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
      return db.prepare(`SELECT e.id, e.account_id AS accountId, a.label AS accountLabel,
        e.job_id AS jobId, e.event_type AS eventType, e.message,
        e.details_json AS detailsJson, e.created_at AS createdAt
        FROM events e LEFT JOIN accounts a ON a.id=e.account_id
        ORDER BY e.created_at DESC LIMIT ?`).all(safeLimit).map((row) => ({
          ...row,
          details: parseJson(row.detailsJson, {}),
          detailsJson: undefined,
        }));
    },

    overview() {
      const accounts = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN status='auth_required' THEN 1 ELSE 0 END) AS authRequired,
        SUM(CASE WHEN status IN ('provisioning','auth_required','degraded','error') THEN 1 ELSE 0 END) AS needsAttention,
        COALESCE(SUM(CASE WHEN service='symphony' AND status='ready' THEN credits_remaining ELSE 0 END), 0) AS availableCredits
        FROM accounts`).get();
      const jobs = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN status IN ('queued','leased','reconciling') THEN 1 ELSE 0 END) AS active
        FROM jobs`).get();
      return {
        accounts: {
          total: Number(accounts.total || 0),
          ready: Number(accounts.ready || 0),
          authRequired: Number(accounts.authRequired || 0),
          needsAttention: Number(accounts.needsAttention || 0),
          availableCredits: Number(accounts.availableCredits || 0),
        },
        jobs: {
          total: Number(jobs.total || 0),
          draft: Number(jobs.draft || 0),
          active: Number(jobs.active || 0),
        },
      };
    },
  };
}

export { ACCOUNT_STATUSES, JOB_STATUSES };
