import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveVideoTarget } from "./job-routing.mjs";

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
  "submitting",
  "submitted",
  "generating",
  "collecting",
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

function beijingDay(timestamp) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

function asAccount(row) {
  if (!row) return null;
  return {
    ...row,
    creditPageReady: Boolean(row.creditPageReady),
    createPageReady: Boolean(row.createPageReady),
    creditsEstimated: Boolean(row.creditsEstimated),
    models: parseJson(row.modelsJson, []),
    modelsJson: undefined,
  };
}

function asJob(row) {
  if (!row) return null;
  return {
    ...row,
    positivePrompt: row.prompt,
    referenceAssets: parseJson(row.referenceAssetsJson, []),
    referenceAssetNames: parseJson(row.referenceAssetNamesJson, []),
    assetRightsConfirmed: Boolean(row.assetRightsConfirmed),
    referenceAssetsJson: undefined,
    referenceAssetNamesJson: undefined,
  };
}

function asEvent(row) {
  return {
    ...row,
    details: parseJson(row.detailsJson, {}),
    detailsJson: undefined,
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
      credits_estimated INTEGER NOT NULL DEFAULT 0,
      credits_reset_at TEXT,
      quota_exhausted_date TEXT,
      videos_created_today INTEGER,
      video_count_date TEXT,
      credit_page_ready INTEGER NOT NULL DEFAULT 0,
      create_page_ready INTEGER NOT NULL DEFAULT 0,
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
      requested_account_id TEXT,
      mode TEXT NOT NULL,
      model TEXT NOT NULL,
      requested_model TEXT,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 60),
      aspect_ratio TEXT NOT NULL DEFAULT 'auto',
      prompt TEXT NOT NULL,
      negative_prompt TEXT NOT NULL DEFAULT '',
      concurrency INTEGER NOT NULL DEFAULT 1,
      batch_id TEXT,
      batch_index INTEGER,
      batch_size INTEGER,
      reference_assets_json TEXT NOT NULL DEFAULT '[]',
      reference_asset_names_json TEXT NOT NULL DEFAULT '[]',
      reference_video_path TEXT,
      reference_video_name TEXT,
      priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'draft',
      queued_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS jobs_queue_idx
      ON jobs(status, priority DESC, created_at ASC);

    CREATE INDEX IF NOT EXISTS jobs_filter_idx
      ON jobs(status, updated_at DESC, id DESC);

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

  // Existing installations already have an accounts table. Add the new
  // read-only video fields without replacing their account or job data.
  const accountColumns = new Set(db.prepare("PRAGMA table_info(accounts)").all().map((column) => column.name));
  for (const [column, definition] of [
    ["videos_created_today", "INTEGER"],
    ["video_count_date", "TEXT"],
    ["credit_page_ready", "INTEGER NOT NULL DEFAULT 0"],
    ["create_page_ready", "INTEGER NOT NULL DEFAULT 0"],
    ["credits_estimated", "INTEGER NOT NULL DEFAULT 0"],
    ["quota_exhausted_date", "TEXT"],
  ]) {
    if (!accountColumns.has(column)) db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`UPDATE accounts SET quota_exhausted_date=video_count_date
    WHERE quota_exhausted_date IS NULL AND last_error_code='DOUBAO_FREE_QUOTA_EXHAUSTED'`);

  const jobColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  for (const [column, definition] of [
    ["aspect_ratio", "TEXT NOT NULL DEFAULT 'auto'"],
    ["reference_asset_names_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["reference_video_path", "TEXT"],
    ["reference_video_name", "TEXT"],
    ["asset_rights_confirmed", "INTEGER NOT NULL DEFAULT 0"],
    ["remote_url", "TEXT"],
    ["result_path", "TEXT"],
    ["error_code", "TEXT"],
    ["submitted_at", "INTEGER"],
    ["completed_at", "INTEGER"],
    ["queued_at", "INTEGER"],
    ["requested_account_id", "TEXT"],
    ["requested_model", "TEXT"],
    ["negative_prompt", "TEXT NOT NULL DEFAULT ''"],
    ["concurrency", "INTEGER NOT NULL DEFAULT 1"],
    ["batch_id", "TEXT"],
    ["batch_index", "INTEGER"],
    ["batch_size", "INTEGER"],
    ["cancel_requested", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!jobColumns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`UPDATE jobs SET requested_account_id=account_id, requested_model=model
    WHERE requested_model IS NULL`);

  // An interrupted browser may already have submitted a paid generation. Do not replay it.
  db.prepare(`UPDATE jobs SET status=CASE WHEN status='leased' THEN 'failed' ELSE 'reconciling' END,
    error_code='WORKER_INTERRUPTED', updated_at=?
    WHERE status IN ('leased','submitting','submitted','generating','collecting')`).run(Date.now());

  const jobSelect = `SELECT id, idempotency_key AS idempotencyKey,
    account_id AS accountId, requested_account_id AS requestedAccountId,
    mode, model, requested_model AS requestedModel, duration_seconds AS durationSeconds,
    aspect_ratio AS aspectRatio, prompt, negative_prompt AS negativePrompt,
    concurrency, batch_id AS batchId, batch_index AS batchIndex, batch_size AS batchSize,
    cancel_requested AS cancelRequested,
    reference_assets_json AS referenceAssetsJson,
    reference_asset_names_json AS referenceAssetNamesJson,
    reference_video_path AS referenceVideo, reference_video_name AS referenceVideoName,
    priority, status, queued_at AS queuedAt,
    asset_rights_confirmed AS assetRightsConfirmed, remote_url AS remoteUrl,
    result_path AS resultPath, error_code AS errorCode,
    submitted_at AS submittedAt, completed_at AS completedAt,
    created_at AS createdAt, updated_at AS updatedAt FROM jobs`;
  const eventSelect = `SELECT e.id, e.account_id AS accountId, a.label AS accountLabel,
    e.job_id AS jobId, e.event_type AS eventType, e.message,
    e.details_json AS detailsJson, e.created_at AS createdAt
    FROM events e LEFT JOIN accounts a ON a.id=e.account_id`;

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
          credits_total AS creditsTotal, credits_estimated AS creditsEstimated,
          credits_reset_at AS creditsResetAt, quota_exhausted_date AS quotaExhaustedDate,
          videos_created_today AS videosCreatedToday, video_count_date AS videoCountDate,
          credit_page_ready AS creditPageReady, create_page_ready AS createPageReady,
          reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
          last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
          created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id=?`).get(input.id));
      });
    },

    hasAccountHistory() {
      return Boolean(db.prepare("SELECT 1 FROM events WHERE event_type IN ('account.created','account.deleted') LIMIT 1").get());
    },

    hasPendingJobForAccount(id) {
      return Boolean(db.prepare(`SELECT 1 FROM jobs
        WHERE (account_id=? OR requested_account_id=?)
          AND status IN ('draft','queued','leased','submitting','submitted','generating','collecting','reconciling')
        LIMIT 1`).get(id, id));
    },

    deleteAccount(id) {
      return transaction(() => {
        const account = this.getAccount(id);
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (this.hasPendingJobForAccount(id)) throw new Error("ACCOUNT_HAS_PENDING_JOBS");
        db.prepare("DELETE FROM accounts WHERE id=?").run(id);
        insertEvent({ eventType: "account.deleted", message: "账号档案已删除",
          details: { accountId: id, label: account.label } });
        return account;
      });
    },

    getAccount(id) {
      return asAccount(db.prepare(`SELECT id, label, login_type AS loginType, service,
        worker_id AS workerId, profile_path AS profilePath, status,
        health_score AS healthScore, credits_remaining AS creditsRemaining,
        credits_total AS creditsTotal, credits_estimated AS creditsEstimated,
        credits_reset_at AS creditsResetAt, quota_exhausted_date AS quotaExhaustedDate,
        videos_created_today AS videosCreatedToday, video_count_date AS videoCountDate,
        credit_page_ready AS creditPageReady, create_page_ready AS createPageReady,
        reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
        last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
        created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id=?`).get(id));
    },

    updateAccountLabel(id, label) {
      return transaction(() => {
        const account = this.getAccount(id);
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (account.label === label) return account;
        db.prepare("UPDATE accounts SET label=?, updated_at=? WHERE id=?")
          .run(label, Date.now(), id);
        insertEvent({ accountId: id, eventType: "account.label_updated",
          message: "账号显示名称已修改", details: { previousLabel: account.label, label } });
        return this.getAccount(id);
      });
    },

    updateAccountIdentity(oldId, newId, label, profilePath) {
      return transaction(() => {
        const account = this.getAccount(oldId);
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (this.getAccount(newId)) throw new Error("ACCOUNT_ALREADY_EXISTS");
        db.exec("PRAGMA defer_foreign_keys = ON");
        db.prepare("UPDATE accounts SET id=?, label=?, profile_path=?, updated_at=? WHERE id=?")
          .run(newId, label, profilePath, Date.now(), oldId);
        db.prepare("UPDATE jobs SET account_id=? WHERE account_id=?").run(newId, oldId);
        db.prepare("UPDATE jobs SET requested_account_id=? WHERE requested_account_id=?")
          .run(newId, oldId);
        db.prepare("UPDATE events SET account_id=? WHERE account_id=?").run(newId, oldId);
        insertEvent({ accountId: newId, eventType: "account.identity_updated",
          message: "账号编号和显示名称已修改",
          details: { previousId: oldId, id: newId, previousLabel: account.label, label } });
        return this.getAccount(newId);
      });
    },

    listAccounts() {
      return db.prepare(`SELECT id, label, login_type AS loginType, service,
        worker_id AS workerId, profile_path AS profilePath, status,
        health_score AS healthScore, credits_remaining AS creditsRemaining,
        credits_total AS creditsTotal, credits_estimated AS creditsEstimated,
        credits_reset_at AS creditsResetAt, quota_exhausted_date AS quotaExhaustedDate,
        videos_created_today AS videosCreatedToday, video_count_date AS videoCountDate,
        credit_page_ready AS creditPageReady, create_page_ready AS createPageReady,
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

    saveVerification(id, result, previousAccount = null) {
      const timestamp = Date.now();
      if (result.error === "PROFILE_IN_USE") {
        return transaction(() => {
          const wasCooling = previousAccount?.status === "cooling";
          db.prepare(`UPDATE accounts SET status=?, last_error_code=?, updated_at=? WHERE id=?`)
            .run(wasCooling ? "cooling" : "busy",
              wasCooling ? previousAccount.lastErrorCode : "PROFILE_IN_USE", timestamp, id);
          insertEvent({ accountId: id, eventType: "account.profile_in_use",
            message: "专用浏览器窗口未关闭，保留上次验收数据" });
          return this.getAccount(id);
        });
      }
      const todayBeijing = beijingDay(timestamp);
      const existing = this.getAccount(id);
      const quotaExhaustedToday = existing?.quotaExhaustedDate === todayBeijing;
      const status = quotaExhaustedToday ? "cooling" : result.ok ? "ready"
        : result.loggedIn ? "degraded"
          : new Set(["LOGIN_REQUIRED", "PROFILE_NOT_FOUND"]).has(result.error) ? "auth_required" : "error";
      return transaction(() => {
        const updated = db.prepare(`UPDATE accounts SET status=?, health_score=?,
          credits_remaining=?, credits_total=?, credits_estimated=?, credits_reset_at=?,
          videos_created_today=?, video_count_date=?, credit_page_ready=?, create_page_ready=?,
          reference_image_limit=?,
          models_json=?, last_verified_at=?, last_error_code=?, updated_at=? WHERE id=?`)
          .run(status, result.ok ? 100 : 25, quotaExhaustedToday ? 0 : result.remainingCredits ?? null,
            result.totalCredits ?? null, result.creditsEstimated ? 1 : 0, result.nextRefresh ?? null,
            result.videosCreatedToday ?? null,
            quotaExhaustedToday ? todayBeijing : result.videoCountDate ?? null,
            result.creditPageReady ? 1 : 0, result.createPageReady ? 1 : 0,
            result.referenceImageLimit ?? null, JSON.stringify(result.modelsObserved || []),
            timestamp, quotaExhaustedToday ? "DOUBAO_FREE_QUOTA_EXHAUSTED" : result.error || null, timestamp, id);
        if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
        insertEvent({
          accountId: id,
          eventType: result.ok ? "account.verified" : "account.verification_failed",
          message: result.ok ? "只读验收通过" : "只读验收未通过",
          details: {
            status,
            stage: result.stage || null,
            remainingCredits: quotaExhaustedToday ? 0 : result.remainingCredits ?? null,
            totalCredits: result.totalCredits ?? null,
            creditsEstimated: Boolean(result.creditsEstimated),
            videosCreatedToday: result.videosCreatedToday ?? null,
            videoCountDate: quotaExhaustedToday ? todayBeijing : result.videoCountDate ?? null,
            error: quotaExhaustedToday ? "DOUBAO_FREE_QUOTA_EXHAUSTED" : result.error || null,
          },
        });
        return this.getAccount(id);
      });
    },

    saveVerificationFailure(id, errorCode) {
      const timestamp = Date.now();
      return transaction(() => {
        const quotaExhaustedToday = this.getAccount(id)?.quotaExhaustedDate === beijingDay(timestamp);
        db.prepare("UPDATE accounts SET status=?, health_score=0, last_error_code=?, updated_at=? WHERE id=?")
          .run(quotaExhaustedToday ? "cooling" : "error",
            quotaExhaustedToday ? "DOUBAO_FREE_QUOTA_EXHAUSTED" : errorCode, timestamp, id);
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
      const enqueue = input.enqueue === true;
      const timestamp = Date.now();
      const id = `job-${randomUUID()}`;
      return transaction(() => {
        db.prepare(`INSERT INTO jobs
          (id, idempotency_key, account_id, requested_account_id, mode, model, requested_model,
           duration_seconds, aspect_ratio, prompt, negative_prompt, concurrency,
           reference_assets_json, reference_asset_names_json, reference_video_path, reference_video_name,
           priority, asset_rights_confirmed, status, queued_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.idempotencyKey, input.accountId || null, input.accountId || null,
            input.mode, input.model, input.model, input.durationSeconds, input.aspectRatio || "auto", input.prompt,
            input.negativePrompt || "", input.concurrency || 1,
            JSON.stringify(input.referenceAssets || []), JSON.stringify(input.referenceAssetNames || []),
            input.referenceVideo || null, input.referenceVideoName || null,
            input.priority, input.assetRightsConfirmed ? 1 : 0,
            enqueue ? "queued" : "draft", enqueue ? timestamp : null, timestamp, timestamp);
        insertEvent({
          accountId: input.accountId || null,
          jobId: id,
          eventType: enqueue ? "job.queued" : "job.draft_created",
          message: enqueue ? "任务已加入自动队列" : "已保存任务草稿，尚未提交生成",
          details: { mode: input.mode, model: input.model, durationSeconds: input.durationSeconds },
        });
        return asJob(db.prepare(`${jobSelect} WHERE id=?`).get(id));
      });
    },

    updateDraftJob(id, input) {
      return transaction(() => {
        const current = this.getJob(id);
        if (!current) throw new Error("JOB_NOT_FOUND");
        if (current.status !== "draft") throw new Error("JOB_NOT_EDITABLE");
        const timestamp = Date.now();
        db.prepare(`UPDATE jobs SET account_id=?, requested_account_id=?, mode=?, model=?, requested_model=?,
          duration_seconds=?, aspect_ratio=?,
          prompt=?, negative_prompt=?, concurrency=?, reference_assets_json=?, reference_asset_names_json=?,
          reference_video_path=?, reference_video_name=?, priority=?, updated_at=?
          WHERE id=? AND status='draft'`)
          .run(input.accountId || null, input.accountId || null, input.mode, input.model, input.model,
            input.durationSeconds,
            input.aspectRatio || "auto", input.prompt, input.negativePrompt || "", input.concurrency || 1,
            JSON.stringify(input.referenceAssets || []),
            JSON.stringify(input.referenceAssetNames || []), input.referenceVideo || null,
            input.referenceVideoName || null, input.priority, timestamp, id);
        insertEvent({ accountId: input.accountId || null, jobId: id, eventType: "job.draft_updated",
          message: "任务草稿已修改", details: { model: input.model, durationSeconds: input.durationSeconds,
            aspectRatio: input.aspectRatio || "auto", imageCount: input.referenceAssets.length,
            hasReferenceVideo: Boolean(input.referenceVideo) } });
        return this.getJob(id);
      });
    },

    markAccountLoginRequired(id, errorCode = "LOGIN_REQUIRED") {
      const updated = db.prepare("UPDATE accounts SET status='auth_required', last_error_code=?, updated_at=? WHERE id=?")
        .run(errorCode, Date.now(), id);
      if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
      insertEvent({ accountId: id, eventType: "account.session_expired",
        message: "平台要求重新登录，已暂停使用此账号", details: { errorCode } });
    },

    markAccountQuotaExhausted(id) {
      return transaction(() => {
        const timestamp = Date.now();
        const updated = db.prepare(`UPDATE accounts SET status='cooling', credits_remaining=0,
            video_count_date=?, quota_exhausted_date=?,
            last_error_code='DOUBAO_FREE_QUOTA_EXHAUSTED', updated_at=?
          WHERE id=? AND service='doubao'`)
          .run(beijingDay(timestamp), beijingDay(timestamp), timestamp, id);
        if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
        insertEvent({ accountId: id, eventType: "account.quota_exhausted",
          message: "豆包提示今日免费生成次数已用完" });
        return this.getAccount(id);
      });
    },

    handleDispatchFailure(id, accountId, errorCode, { quotaExhausted = false,
      beforeSubmission = false } = {}) {
      if (!quotaExhausted && !beforeSubmission) throw new Error("JOB_FAILURE_NOT_RETRYABLE");
      return transaction(() => {
        const job = this.getJob(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.accountId !== accountId || new Set(["success", "failed", "cancelled"]).has(job.status)) {
          throw new Error("JOB_ALREADY_FINISHED");
        }
        const now = Date.now();
        const profileBusy = beforeSubmission && errorCode === "PROFILE_IN_USE";
        if (quotaExhausted) {
          const updated = db.prepare(`UPDATE accounts SET status='cooling', credits_remaining=0,
            video_count_date=?, quota_exhausted_date=?, last_error_code=?, updated_at=?
            WHERE id=? AND service='doubao'`)
            .run(beijingDay(now), beijingDay(now), errorCode, now, accountId);
          if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
          insertEvent({ accountId, eventType: "account.quota_exhausted",
            message: "平台确认该账号今日免费生成次数已用完",
            details: { errorCode } });
        } else if (errorCode === "LOGIN_REQUIRED") {
          this.markAccountLoginRequired(accountId);
        } else if (!profileBusy) {
          db.prepare(`UPDATE accounts SET status='degraded', health_score=25,
            last_error_code=?, updated_at=? WHERE id=?`)
            .run(errorCode, now, accountId);
          insertEvent({ accountId, eventType: "account.dispatch_failed",
            message: "提交前执行失败，账号等待重新验收", details: { errorCode } });
        }
        const canRetry = job.queuedAt != null && (!job.requestedAccountId || profileBusy) && !job.cancelRequested;
        if (canRetry) {
          db.prepare(`UPDATE jobs SET account_id=NULL, model=requested_model, status='queued',
            remote_url=NULL, result_path=NULL, error_code=?, submitted_at=NULL,
            completed_at=NULL, updated_at=? WHERE id=?`)
            .run(profileBusy ? "ACCOUNT_BROWSER_BUSY" : null, now, id);
          insertEvent({ accountId, jobId: id, eventType: profileBusy ? "job.waiting_for_browser" : "job.failover_queued",
            message: profileBusy ? "账号浏览器暂被占用，释放后自动继续" : "已切换候选账号并重新排队",
            details: { errorCode, quotaExhausted } });
        } else {
          const finalStatus = job.cancelRequested ? "cancelled" : "failed";
          db.prepare(`UPDATE jobs SET status=?, error_code=?, completed_at=?, updated_at=? WHERE id=?`)
            .run(finalStatus, errorCode, now, now, id);
          insertEvent({ accountId, jobId: id, eventType: `job.${finalStatus}`,
            message: "任务执行失败", details: { errorCode } });
        }
        return this.getJob(id);
      });
    },

    listJobs(limit = 100) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      return db.prepare(`${jobSelect} ORDER BY updated_at DESC LIMIT ?`).all(safeLimit).map(asJob);
    },

    listJobsPage({ status = "all", page = 1, pageSize = 6 } = {}) {
      const where = status === "all" ? "" : status === "active"
        ? " WHERE status IN ('leased','submitting','submitted','generating','collecting')"
        : " WHERE status=?";
      const parameters = status === "all" || status === "active" ? [] : [status];
      const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM jobs${where}`).get(...parameters).total);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(page, totalPages);
      const jobs = db.prepare(`${jobSelect}${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (currentPage - 1) * pageSize).map(asJob);
      return { jobs, status, page: currentPage, pageSize, total, totalPages };
    },

    getJob(id) {
      return asJob(db.prepare(`${jobSelect} WHERE id=?`).get(id));
    },

    getJobByIdempotencyKey(key) {
      return asJob(db.prepare(`${jobSelect} WHERE idempotency_key=?`).get(key));
    },

    listBatchJobs(batchId) {
      return db.prepare(`${jobSelect} WHERE batch_id=? OR id=? ORDER BY batch_index ASC`)
        .all(batchId, batchId).map(asJob);
    },

    listBusyAccountIds() {
      return db.prepare(`SELECT DISTINCT account_id AS id FROM jobs
        WHERE account_id IS NOT NULL AND status IN
        ('leased','submitting','submitted','generating','collecting','reconciling')`)
        .all().map((row) => row.id);
    },

    hasQueuedJobs() {
      return Boolean(db.prepare("SELECT 1 FROM jobs WHERE status='queued' AND cancel_requested=0 LIMIT 1").get());
    },

    enqueueJob(id) {
      return transaction(() => {
        const job = this.getJob(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "draft") throw new Error("JOB_NOT_QUEUEABLE");
        const now = Date.now();
        db.prepare("UPDATE jobs SET status='queued', queued_at=?, error_code=NULL, updated_at=? WHERE id=?")
          .run(now, now, id);
        insertEvent({ accountId: job.accountId, jobId: id, eventType: "job.queued",
          message: "任务已加入自动队列" });
        return this.getJob(id);
      });
    },

    claimNextQueuedJob({ maxVerificationAgeMs = 24 * 60 * 60_000, unavailableAccountIds = [] } = {}) {
      return transaction(() => {
        const unavailable = new Set(unavailableAccountIds);
        const queued = db.prepare(`${jobSelect} WHERE status='queued' AND cancel_requested=0
          ORDER BY priority DESC, COALESCE(queued_at,created_at) ASC, rowid ASC`).all().map(asJob);
        if (!queued.length) return null;
        const now = Date.now();
        const occupancy = db.prepare(`SELECT 1 FROM jobs WHERE account_id=?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`);
        const lastUse = db.prepare(`SELECT MAX(COALESCE(submitted_at,updated_at)) AS value FROM jobs
          WHERE account_id=? AND status NOT IN ('draft','queued','cancelled')`);
        const accounts = this.listAccounts().map((account) => {
          const lastUsedAt = Number(lastUse.get(account.id).value || 0);
          const verifiedAt = Number(account.lastVerifiedAt || 0);
          return { ...account,
            status: account.status === "ready" && (!verifiedAt
              || now - verifiedAt > maxVerificationAgeMs || verifiedAt < lastUsedAt)
              ? "degraded" : account.status,
            busy: Boolean(occupancy.get(account.id)) || unavailable.has(account.id), lastUsedAt,
          };
        });
        for (const job of queued) {
          let selected;
          try {
            selected = resolveVideoTarget({ ...job, accountId: job.requestedAccountId,
              model: job.requestedModel }, accounts);
          } catch (error) {
            let reason = String(error.message || "NO_ELIGIBLE_ACCOUNT").slice(0, 80);
            if (unavailable.size && ["NO_ELIGIBLE_ACCOUNT", "ACCOUNT_ALREADY_RUNNING"].includes(reason)) {
              try {
                resolveVideoTarget({ ...job, accountId: job.requestedAccountId, model: job.requestedModel },
                  accounts.map((account) => ({ ...account, busy: Boolean(occupancy.get(account.id)) })));
                reason = "ACCOUNT_BROWSER_BUSY";
              } catch { /* Another eligibility requirement also prevents dispatch. */ }
            }
            if (job.errorCode !== reason) {
              db.prepare("UPDATE jobs SET error_code=? WHERE id=? AND status='queued'").run(reason, job.id);
            }
            continue;
          }
          db.prepare(`UPDATE jobs SET account_id=?, model=?, status='leased', error_code=NULL,
            updated_at=? WHERE id=? AND status='queued'`)
            .run(selected.account.id, selected.model, now, job.id);
          insertEvent({ accountId: selected.account.id, jobId: job.id, eventType: "job.dispatched",
            message: "自动队列已分配账号并开始执行",
            details: { selectedModel: selected.model } });
          return { job: this.getJob(job.id), account: this.getAccount(selected.account.id) };
        }
        return null;
      });
    },

    hasRunningJobForAccount(accountId) {
      return Boolean(db.prepare(`SELECT 1 FROM jobs WHERE account_id=?
        AND status IN ('leased','submitting','submitted','generating','collecting') LIMIT 1`).get(accountId));
    },

    startJob(id) {
      return transaction(() => {
        const job = this.getJob(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "draft") throw new Error("JOB_NOT_STARTABLE");
        const occupancy = db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`);
        const lastUse = db.prepare(`SELECT MAX(COALESCE(submitted_at,updated_at)) AS value FROM jobs
          WHERE account_id=? AND id<>? AND status NOT IN ('draft','queued','cancelled')`);
        const accounts = this.listAccounts().map((account) => ({ ...account,
          busy: Boolean(occupancy.get(account.id, id)),
          lastUsedAt: Number(lastUse.get(account.id, id).value || 0),
        }));
        const selected = resolveVideoTarget(job, accounts);
        const account = selected.account;
        db.prepare("UPDATE jobs SET account_id=?, model=?, status='leased', error_code=NULL, updated_at=? WHERE id=?")
          .run(account.id, selected.model, Date.now(), id);
        insertEvent({ accountId: account.id, jobId: id, eventType: "job.started",
          message: job.mode === "reference_to_video" ? "开始执行参考素材转视频任务" : "开始执行视频生成任务",
          details: { requestedAccountId: job.accountId || "auto", requestedModel: job.model,
            selectedModel: selected.model } });
        return { job: this.getJob(id), account };
      });
    },

    startJobBatch(id) {
      const draft = this.getJob(id);
      if (!draft) throw new Error("JOB_NOT_FOUND");
      if (draft.status !== "draft") throw new Error("JOB_NOT_STARTABLE");
      const count = Number(draft.concurrency || 1);
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("INVALID_CONCURRENCY");
      if (count === 1) return [this.startJob(id)];
      if (draft.mode !== "image_to_video" || draft.requestedAccountId) {
        throw new Error("CONCURRENCY_REQUIRES_AUTO_ACCOUNT");
      }
      return transaction(() => {
        const current = this.getJob(id);
        if (current?.status !== "draft") throw new Error("JOB_NOT_STARTABLE");
        const occupancy = db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`);
        const lastUse = db.prepare(`SELECT MAX(COALESCE(submitted_at,updated_at)) AS value FROM jobs
          WHERE account_id=? AND id<>? AND status NOT IN ('draft','queued','cancelled')`);
        const accounts = this.listAccounts().map((account) => ({ ...account,
          busy: Boolean(occupancy.get(account.id, id)),
          lastUsedAt: Number(lastUse.get(account.id, id).value || 0),
        }));
        const selected = [];
        for (let index = 0; index < count; index += 1) {
          let next;
          try { next = resolveVideoTarget(current, accounts); }
          catch (error) {
            if (error.message === "NO_ELIGIBLE_ACCOUNT") throw new Error("INSUFFICIENT_ELIGIBLE_ACCOUNTS");
            throw error;
          }
          next.account.busy = true;
          selected.push(next);
        }
        const now = Date.now();
        const ids = [id];
        db.prepare(`UPDATE jobs SET account_id=?, model=?, status='leased', error_code=NULL,
          batch_id=?, batch_index=1, batch_size=?, updated_at=? WHERE id=?`)
          .run(selected[0].account.id, selected[0].model, id, count, now, id);
        for (let index = 1; index < count; index += 1) {
          const childId = `job-${randomUUID()}`;
          ids.push(childId);
          db.prepare(`INSERT INTO jobs
            (id, idempotency_key, account_id, requested_account_id, mode, model, requested_model,
             duration_seconds, aspect_ratio, prompt, negative_prompt, concurrency,
             batch_id, batch_index, batch_size,
             reference_assets_json, reference_asset_names_json, priority,
             status, created_at, updated_at)
            VALUES (?, ?, ?, NULL, 'image_to_video', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'leased', ?, ?)`)
            .run(childId, `batch-${randomUUID()}`, selected[index].account.id, selected[index].model,
              current.requestedModel || current.model, current.durationSeconds, current.aspectRatio,
              current.prompt, current.negativePrompt || "", id, index + 1, count,
              JSON.stringify(current.referenceAssets), JSON.stringify(current.referenceAssetNames),
              current.priority, now, now);
        }
        for (let index = 0; index < count; index += 1) {
          insertEvent({ accountId: selected[index].account.id, jobId: ids[index],
            eventType: "job.started", message: `批次第 ${index + 1}/${count} 条视频生成任务已启动`,
            details: { batchId: id, batchIndex: index + 1, batchSize: count,
              selectedModel: selected[index].model } });
        }
        return ids.map((jobId, index) => ({ job: this.getJob(jobId),
          account: this.getAccount(selected[index].account.id) }));
      });
    },

    recollectJob(id) {
      return transaction(() => {
        const job = this.getJob(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "reconciling" || !job.remoteUrl) throw new Error("JOB_NOT_RECOLLECTABLE");
        const account = this.getAccount(job.accountId);
        if (!account || account.status !== "ready") throw new Error("ACCOUNT_NOT_READY");
        const occupied = db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`)
          .get(job.accountId, id);
        if (occupied) throw new Error("ACCOUNT_ALREADY_RUNNING");
        db.prepare("UPDATE jobs SET status='collecting', error_code=NULL, updated_at=? WHERE id=?")
          .run(Date.now(), id);
        insertEvent({ accountId: job.accountId, jobId: id, eventType: "job.recollecting", message: "正在从平台重新收集结果" });
        return { job: this.getJob(id), account };
      });
    },

    updateJob(id, update) {
      if (!JOB_STATUSES.has(update.status) || update.status === "draft") throw new Error("INVALID_JOB_STATUS");
      return transaction(() => {
        const current = this.getJob(id);
        if (!current) throw new Error("JOB_NOT_FOUND");
        if (new Set(["success", "failed", "cancelled"]).has(current.status)) throw new Error("JOB_ALREADY_FINISHED");
        const now = Date.now();
        db.prepare(`UPDATE jobs SET status=?, remote_url=COALESCE(?,remote_url),
          result_path=COALESCE(?,result_path), error_code=?,
          submitted_at=CASE WHEN ?='submitted' THEN COALESCE(submitted_at,?) ELSE submitted_at END,
          completed_at=CASE WHEN ? IN ('success','failed') THEN ? ELSE completed_at END,
          updated_at=? WHERE id=?`)
          .run(update.status, update.remoteUrl || null, update.resultPath || null,
            update.errorCode || null, update.status, now, update.status, now, now, id);
        insertEvent({ accountId: current.accountId, jobId: id,
          eventType: `job.${update.status}`,
          message: ({ submitting: "正在向平台提交", submitted: "已提交到平台", generating: "平台正在生成",
            collecting: "正在保存结果", success: current.mode === "reference_to_video" ? "参考素材转视频已完成" : "视频生成已完成",
            failed: current.mode === "reference_to_video" ? "参考素材转视频执行失败" : "视频生成执行失败",
            reconciling: "需检查平台任务状态" })[update.status] || "任务状态已更新",
          details: update.errorCode ? { errorCode: update.errorCode } : {},
        });
        return this.getJob(id);
      });
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
      return db.prepare(`${eventSelect} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`)
        .all(safeLimit).map(asEvent);
    },

    listEventsPage({ page = 1, pageSize = 10 } = {}) {
      const total = Number(db.prepare("SELECT COUNT(*) AS total FROM events").get().total);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(page, totalPages);
      const events = db.prepare(`${eventSelect} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`)
        .all(pageSize, (currentPage - 1) * pageSize).map(asEvent);
      return { events, page: currentPage, pageSize, total, totalPages };
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
        SUM(CASE WHEN status IN ('queued','leased','submitting','submitted','generating','collecting','reconciling') THEN 1 ELSE 0 END) AS active
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
