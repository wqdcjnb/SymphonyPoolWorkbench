import { jobProgress } from '../public/js/job-progress.js';
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migratePool } from "./pool-schema.mjs";
import { openDatabase } from "./database.mjs";
import { resolveVideoTarget, videoTargetBlocker, VIDEO_MODELS } from "./job-routing.mjs";
import { creditDay, withDailyCredits, videoCreditCost } from "./daily-credits.mjs";
import { requiresHuman, loginErrors, challengeErrors, executionFaults } from './account-quality.mjs';
import { collectionUrl, reconciliationPlan } from './long-task.mjs';
import { isPlatformResultPending } from '../public/js/job-progress.js';

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
    needsAttention: Boolean(row.needsAttention) || row.status === 'auth_required',
    attentionReason: row.attentionReason || (row.status === 'auth_required' ? 'LOGIN_REQUIRED' : null),
    creditPageReady: Boolean(row.creditPageReady),
    createPageReady: Boolean(row.createPageReady),
    creditsEstimated: Boolean(row.creditsEstimated),
    models: parseJson(row.modelsJson, []).filter(model => VIDEO_MODELS[row.service]?.includes(model)),
    modelsJson: undefined,
  };
}

function asJob(row) {
  if (!row) return null;
  return {
    ...row,
    positivePrompt: row.prompt,
    progress: jobProgress(row),
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

export async function createStore(databasePath, { database = null } = {}) {
  // A live update can reuse the existing adapter so pool reservations and job
  // transactions keep the same transaction context without restarting workers.
  const db = database || await openDatabase(databasePath);
  const initialize = async () => {
  (await db.exec(`
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
  `));

  // Existing installations already have an accounts table. Add the new
  // read-only video fields without replacing their account or job data.
  const accountColumns = new Set((await db.prepare("PRAGMA table_info(accounts)").all()).map((column) => column.name));
  for (const [column, definition] of [
    ["videos_created_today", "INTEGER"],
    ["video_count_date", "TEXT"],
    ["credit_page_ready", "INTEGER NOT NULL DEFAULT 0"],
    ["create_page_ready", "INTEGER NOT NULL DEFAULT 0"],
    ["credits_estimated", "INTEGER NOT NULL DEFAULT 0"],
    ["quota_exhausted_date", "TEXT"],
    ["reliability_score", "INTEGER NOT NULL DEFAULT 80"],
    ["video_success_count", "INTEGER NOT NULL DEFAULT 0"],
    ["execution_failure_count", "INTEGER NOT NULL DEFAULT 0"],
    ["auth_failure_count", "INTEGER NOT NULL DEFAULT 0"],
    ["challenge_count", "INTEGER NOT NULL DEFAULT 0"],
    ["needs_attention", "INTEGER NOT NULL DEFAULT 0"],
    ["attention_reason", "TEXT"],
    ["attention_since", "INTEGER"],
    ["attention_penalty", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!accountColumns.has(column)) (await db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${definition}`));
  }
  (await db.exec(`UPDATE accounts SET quota_exhausted_date=video_count_date
    WHERE quota_exhausted_date IS NULL AND last_error_code='DOUBAO_FREE_QUOTA_EXHAUSTED'`));

  const jobColumns = new Set((await db.prepare("PRAGMA table_info(jobs)").all()).map((column) => column.name));
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
    ["credit_cost", "INTEGER NOT NULL DEFAULT 0"],
    ["credit_date", "TEXT"],
    ["credit_state", "TEXT"],
    ["reconcile_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["next_reconcile_at", "INTEGER"],
    ["reconcile_deadline_at", "INTEGER"],
    ["last_reconcile_at", "INTEGER"],
    ["last_observed_stage", "TEXT"],
    ["last_observed_at", "INTEGER"],
    ["remote_message_id", "TEXT"],
  ]) {
    if (!jobColumns.has(column)) (await db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`));
  }
  (await db.exec(`UPDATE jobs SET requested_account_id=account_id, requested_model=model
    WHERE requested_model IS NULL`));
  if (!jobColumns.has('last_observed_stage')) {
    // Preserve the last observed execution stage across interruptions and restarts.
    const observed = "event_type IN ('job.submitting','job.submitted','job.generating','job.collecting','job.success')";
    await db.exec(`UPDATE jobs SET last_observed_stage=(SELECT SUBSTR(event_type,5) FROM events
      WHERE job_id=jobs.id AND ${observed} ORDER BY created_at DESC LIMIT 1),
      last_observed_at=(SELECT created_at FROM events WHERE job_id=jobs.id AND ${observed}
        ORDER BY created_at DESC LIMIT 1)`);
  }

  await migratePool(db);

  if (!accountColumns.has('reliability_score')) {
    await db.exec(`UPDATE accounts SET video_success_count=(SELECT COUNT(*) FROM jobs
      WHERE jobs.account_id=accounts.id AND jobs.status='success')`);
    await db.exec(`UPDATE accounts SET reliability_score=CASE WHEN video_success_count >= 5 THEN 100
      ELSE 80 + video_success_count * 4 END`);
    await db.exec(`UPDATE accounts SET needs_attention=1, attention_reason=COALESCE(last_error_code,'LOGIN_REQUIRED'),
      attention_since=updated_at WHERE status='auth_required'`);
  }

  await db.exec("CREATE INDEX IF NOT EXISTS jobs_credit_idx ON jobs(credit_date,account_id)");
  await db.exec(`CREATE TABLE IF NOT EXISTS account_external_videos (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL, quota_date TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,video_id))`);
  await db.exec('CREATE INDEX IF NOT EXISTS external_videos_day_idx ON account_external_videos(quota_date,account_id)');
  // Backfill known-cost submissions, including existing 2.5 / 30-second videos.
  for (const job of await db.prepare(`SELECT id,model,duration_seconds,submitted_at,created_at FROM jobs
    WHERE account_id IS NOT NULL AND credit_state IS NULL AND (submitted_at IS NOT NULL
      OR status IN ('submitting','generating','collecting','reconciling','success'))`).all()) {
    const cost = videoCreditCost(job.model, job.duration_seconds);
    if (cost) await db.prepare("UPDATE jobs SET credit_cost=?,credit_date=?,credit_state='charged' WHERE id=?")
      .run(cost, creditDay(job.submitted_at || job.created_at), job.id);
  }
  await db.exec(`UPDATE accounts SET quota_exhausted_date=video_count_date
    WHERE quota_exhausted_date IS NULL AND last_error_code='DOLA_QUOTA_EXHAUSTED'`);

  // An interrupted browser may already have submitted a paid generation. Do not replay it.
  (await db.prepare(`UPDATE jobs SET status=CASE WHEN status='leased' AND collect_only=0 AND remote_url IS NULL THEN 'failed' ELSE 'reconciling' END,
    error_code='WORKER_INTERRUPTED', updated_at=?
    WHERE lease_token IS NULL AND status IN ('leased','submitting','submitted','generating','collecting')`).run(Date.now()));
  await db.exec("UPDATE jobs SET credit_cost=0,credit_date=NULL,credit_state='released' WHERE credit_state='reserved' AND status IN ('failed','cancelled')");
  };
  try { if (db.kind === 'postgres') await db.transaction(initialize); else await initialize(); }
  catch (error) { if (!database) await db.close(); throw error; }

  const jobSelect = `SELECT lease_token AS leaseToken, execution_worker AS executionWorker, collect_only AS collectOnly,
    remote_message_id AS remoteMessageId,
    last_observed_stage AS lastObservedStage,last_observed_at AS lastObservedAt,
    reconcile_attempts AS reconcileAttempts, next_reconcile_at AS nextReconcileAt,
    reconcile_deadline_at AS reconcileDeadlineAt, last_reconcile_at AS lastReconcileAt, id, idempotency_key AS idempotencyKey,
    account_id AS accountId, requested_account_id AS requestedAccountId,
    mode, model, requested_model AS requestedModel, duration_seconds AS durationSeconds,
    aspect_ratio AS aspectRatio, prompt, negative_prompt AS negativePrompt,
    concurrency, batch_id AS batchId, batch_index AS batchIndex, batch_size AS batchSize,
    cancel_requested AS cancelRequested,
    reference_assets_json AS referenceAssetsJson,
    reference_asset_names_json AS referenceAssetNamesJson,
    reference_video_path AS referenceVideo, reference_video_name AS referenceVideoName,
    priority, status, queued_at AS queuedAt,
    credit_cost AS creditCost, credit_date AS creditDate, credit_state AS creditState,
    asset_rights_confirmed AS assetRightsConfirmed, remote_url AS remoteUrl,
    result_path AS resultPath, error_code AS errorCode,
    submitted_at AS submittedAt, completed_at AS completedAt,
    created_at AS createdAt, updated_at AS updatedAt FROM jobs`;
  const eventSelect = `SELECT e.id, e.account_id AS accountId, a.label AS accountLabel,
    e.job_id AS jobId, e.event_type AS eventType, e.message,
    e.details_json AS detailsJson, e.created_at AS createdAt
    FROM events e LEFT JOIN accounts a ON a.id=e.account_id`;

  const transaction = async (callback) => (await db.transaction(callback));
  const budgetAccounts = async (accounts) => {
    const now = Date.now();
    const rows = await db.prepare(`SELECT account_id AS accountId, SUM(credit_cost) AS used,
      SUM(CASE WHEN credit_state='reserved' THEN credit_cost ELSE 0 END) AS reserved,
      SUM(CASE WHEN credit_state='reserved' THEN 1 ELSE 0 END) AS videoReserved,
      SUM(CASE WHEN credit_state='charged' AND NOT (status='failed' AND result_path IS NULL
        AND COALESCE(error_code,'') IN ('DOUBAO_SUBSCRIPTION_REQUIRED','DOUBAO_FREE_QUOTA_EXHAUSTED','DOLA_QUOTA_EXHAUSTED'))
        THEN 1 ELSE 0 END) AS videoUsed
      FROM jobs WHERE credit_date=? AND credit_state IN ('reserved','charged') GROUP BY account_id`).all(creditDay(now));
    const usage = new Map(rows.map(row => [row.accountId, row]));
    for (const row of await db.prepare(`SELECT account_id AS accountId,COUNT(*) AS externalVideos
      FROM account_external_videos WHERE quota_date=? GROUP BY account_id`).all(creditDay(now))) {
      usage.set(row.accountId,{...(usage.get(row.accountId)||{}),externalVideos:row.externalVideos});
    }
    return accounts.map(account => withDailyCredits(account, usage.get(account?.id), now));
  };
  const reserveCredits = async (job, model) => {
    if (job.collectOnly || job.creditState === 'charged') return;
    const cost = videoCreditCost(model, job.durationSeconds);
    if (cost) await db.prepare("UPDATE jobs SET credit_cost=?,credit_date=?,credit_state='reserved' WHERE id=?")
      .run(cost, creditDay(), job.id);
  };
  const releaseCredits = async (id) => db.prepare("UPDATE jobs SET credit_cost=0,credit_date=NULL,credit_state='released' WHERE id=?").run(id);

  const insertEvent = async ({ accountId = null, jobId = null, eventType, message, details = {} }) => {
    const timestamp = Date.now();
    (await db.prepare(`INSERT INTO events
      (id, account_id, job_id, event_type, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), accountId, jobId, eventType, message, JSON.stringify(details), timestamp));
  };

  // Called inside transactions. Repeated checks of one unresolved incident do
  // not repeatedly lower the score; only a verified recovery ends the incident.
  const flagAttention = async (id, errorCode) => {
    const current = await db.prepare('SELECT needs_attention,attention_penalty FROM accounts WHERE id=?').get(id);
    if (!current) throw new Error('ACCOUNT_NOT_FOUND');
    const incidentPenalty = Math.max(current.attention_penalty, loginErrors.has(errorCode) ? 20 : challengeErrors.has(errorCode) ? 15 : 0);
    const auth = loginErrors.has(errorCode) && current.attention_penalty < 20 ? 1 : 0;
    const challenge = challengeErrors.has(errorCode) && current.attention_penalty < 15 ? 1 : 0;
    const penalty = incidentPenalty - current.attention_penalty;
    await db.prepare(`UPDATE accounts SET needs_attention=1, attention_reason=?,
      attention_since=COALESCE(attention_since,?), attention_penalty=?, auth_failure_count=auth_failure_count+?,
      challenge_count=challenge_count+?, reliability_score=CASE WHEN reliability_score < ? THEN 0
        ELSE reliability_score-? END WHERE id=?`)
      .run(errorCode, Date.now(), incidentPenalty, auth, challenge, penalty, penalty, id);
    if (!current.needs_attention) await insertEvent({ accountId: id, eventType: 'account.attention_required',
      message: '账号暂停派发，等待人工处理并重新验收', details: { errorCode } });
  };

  const recordExecutionFault = async (accountId, jobId, errorCode) => {
    if (!accountId || !executionFaults.has(errorCode)) return;
    if (await db.prepare("SELECT 1 FROM events WHERE account_id=? AND job_id=? AND event_type='account.execution_fault'")
      .get(accountId, jobId)) return;
    await db.prepare(`UPDATE accounts SET execution_failure_count=execution_failure_count+1,
      reliability_score=CASE WHEN reliability_score < 10 THEN 0 ELSE reliability_score-10 END WHERE id=?`).run(accountId);
    await insertEvent({ accountId, jobId, eventType: 'account.execution_fault',
      message: '执行中断已计入账号稳定性', details: { errorCode } });
  };

  return {
    database: db,
    async close() {
      (await db.close());
    },

    async ensureAccount(input) {
      const timestamp = Date.now();
      return (await transaction(async () => {
        const inserted = (await db.prepare(`INSERT OR IGNORE INTO accounts
          (id, label, login_type, service, worker_id, profile_path, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.id, input.label, input.loginType, input.service || "symphony", input.workerId,
            input.profilePath, input.status || "provisioning", timestamp, timestamp));
        if (inserted.changes) {
          (await insertEvent({
            accountId: input.id,
            eventType: "account.created",
            message: "账号档案已加入工作台",
            details: { loginType: input.loginType, workerId: input.workerId },
          }));
        }
        const account = asAccount((await db.prepare(`SELECT id, label, login_type AS loginType, service,
          worker_id AS workerId, profile_path AS profilePath, status,
          health_score AS healthScore, reliability_score AS reliabilityScore,
        video_success_count AS videoSuccessCount, execution_failure_count AS executionFailureCount,
        auth_failure_count AS authFailureCount, challenge_count AS challengeCount,
        needs_attention AS needsAttention, attention_reason AS attentionReason, attention_since AS attentionSince,
        credits_remaining AS creditsRemaining,
          credits_total AS creditsTotal, credits_estimated AS creditsEstimated,
          credits_reset_at AS creditsResetAt, quota_exhausted_date AS quotaExhaustedDate,
          videos_created_today AS videosCreatedToday, video_count_date AS videoCountDate,
          credit_page_ready AS creditPageReady, create_page_ready AS createPageReady,
          reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
          last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
          created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id=?`).get(input.id)));
        return (await budgetAccounts([account]))[0];
      }));
    },

    async hasAccountHistory() {
      return Boolean((await db.prepare("SELECT 1 FROM events WHERE event_type IN ('account.created','account.deleted') LIMIT 1").get()));
    },

    async hasPendingJobForAccount(id) {
      return Boolean((await db.prepare(`SELECT 1 FROM jobs
        WHERE (account_id=? OR requested_account_id=?)
          AND status IN ('draft','queued','leased','submitting','submitted','generating','collecting','reconciling')
        LIMIT 1`).get(id, id)));
    },

    async deleteAccount(id) {
      return (await transaction(async () => {
        const account = (await this.getAccount(id));
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if ((await this.hasPendingJobForAccount(id))) throw new Error("ACCOUNT_HAS_PENDING_JOBS");
        (await db.prepare("DELETE FROM accounts WHERE id=?").run(id));
        (await insertEvent({ eventType: "account.deleted", message: "账号档案已删除",
          details: { accountId: id, label: account.label } }));
        return account;
      }));
    },

    async getAccount(id) {
      const account = asAccount((await db.prepare(`SELECT id, label, login_type AS loginType, service,
        worker_id AS workerId, profile_path AS profilePath, status,
        health_score AS healthScore, reliability_score AS reliabilityScore,
        video_success_count AS videoSuccessCount, execution_failure_count AS executionFailureCount,
        auth_failure_count AS authFailureCount, challenge_count AS challengeCount,
        needs_attention AS needsAttention, attention_reason AS attentionReason, attention_since AS attentionSince,
        credits_remaining AS creditsRemaining,
        credits_total AS creditsTotal, credits_estimated AS creditsEstimated,
        credits_reset_at AS creditsResetAt, quota_exhausted_date AS quotaExhaustedDate,
        videos_created_today AS videosCreatedToday, video_count_date AS videoCountDate,
        credit_page_ready AS creditPageReady, create_page_ready AS createPageReady,
        reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
        last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
        created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id=?`).get(id)));
      return (await budgetAccounts([account]))[0];
    },

    async updateAccountLabel(id, label) {
      return (await transaction(async () => {
        const account = (await this.getAccount(id));
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if (account.label === label) return account;
        (await db.prepare("UPDATE accounts SET label=?, updated_at=? WHERE id=?")
          .run(label, Date.now(), id));
        (await insertEvent({ accountId: id, eventType: "account.label_updated",
          message: "账号显示名称已修改", details: { previousLabel: account.label, label } }));
        return (await this.getAccount(id));
      }));
    },

    async updateAccountIdentity(oldId, newId, label, profilePath, renameBinding = null) {
      return (await transaction(async () => {
        const account = (await this.getAccount(oldId));
        if (!account) throw new Error("ACCOUNT_NOT_FOUND");
        if ((await this.getAccount(newId))) throw new Error("ACCOUNT_ALREADY_EXISTS");
        (await db.exec("PRAGMA defer_foreign_keys = ON"));
        (await db.prepare("UPDATE accounts SET id=?, label=?, profile_path=?, updated_at=? WHERE id=?")
          .run(newId, label, profilePath, Date.now(), oldId));
        await db.prepare('UPDATE account_external_videos SET account_id=? WHERE account_id=?').run(newId,oldId);
        (await db.prepare("UPDATE jobs SET account_id=? WHERE account_id=?").run(newId, oldId));
        (await db.prepare("UPDATE jobs SET requested_account_id=? WHERE requested_account_id=?")
          .run(newId, oldId));
        (await db.prepare("UPDATE events SET account_id=? WHERE account_id=?").run(newId, oldId));
        if(renameBinding)await renameBinding(oldId,newId);
        (await insertEvent({ accountId: newId, eventType: "account.identity_updated",
          message: "账号编号和显示名称已修改",
          details: { previousId: oldId, id: newId, previousLabel: account.label, label } }));
        return (await this.getAccount(newId));
      }));
    },

    async listAccounts() {
      const accounts = (await db.prepare(`SELECT id, label, login_type AS loginType, service,
        worker_id AS workerId, profile_path AS profilePath, status,
        health_score AS healthScore, reliability_score AS reliabilityScore,
        video_success_count AS videoSuccessCount, execution_failure_count AS executionFailureCount,
        auth_failure_count AS authFailureCount, challenge_count AS challengeCount,
        needs_attention AS needsAttention, attention_reason AS attentionReason, attention_since AS attentionSince,
        credits_remaining AS creditsRemaining,
        credits_total AS creditsTotal, credits_estimated AS creditsEstimated,
        credits_reset_at AS creditsResetAt, quota_exhausted_date AS quotaExhaustedDate,
        videos_created_today AS videosCreatedToday, video_count_date AS videoCountDate,
        credit_page_ready AS creditPageReady, create_page_ready AS createPageReady,
        reference_image_limit AS referenceImageLimit, models_json AS modelsJson,
        last_verified_at AS lastVerifiedAt, last_error_code AS lastErrorCode,
        created_at AS createdAt, updated_at AS updatedAt
        FROM accounts ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'checking' THEN 1 ELSE 2 END,
        lower(label)`).all()).map(asAccount);
      return budgetAccounts(accounts);
    },

    async setAccountChecking(id) {
      const timestamp = Date.now();
      const result = (await db.prepare("UPDATE accounts SET status='checking', updated_at=? WHERE id=?")
        .run(timestamp, id));
      if (!result.changes) throw new Error("ACCOUNT_NOT_FOUND");
      (await insertEvent({ accountId: id, eventType: "account.checking", message: "开始只读验收" }));
    },

    async saveVerification(id, result, previousAccount = null) {
      const timestamp = Date.now();
      if (result.error === "PROFILE_IN_USE") {
        return (await transaction(async () => {
          const wasCooling = previousAccount?.status === "cooling";
          (await db.prepare(`UPDATE accounts SET status=?, last_error_code=?, updated_at=? WHERE id=?`)
            .run(wasCooling ? "cooling" : "busy",
              wasCooling ? previousAccount.lastErrorCode : "PROFILE_IN_USE", timestamp, id));
          (await insertEvent({ accountId: id, eventType: "account.profile_in_use",
            message: "专用浏览器窗口未关闭，保留上次验收数据" }));
          return (await this.getAccount(id));
        }));
      }
      const todayBeijing = beijingDay(timestamp);
      const existing = (await this.getAccount(id));
      if (existing?.creditsSource === 'daily_budget') result = { ...result,
        remainingCredits: existing.creditsRemaining, totalCredits: existing.creditsTotal,
        creditsEstimated: false, nextRefresh: existing.creditsResetAt };
      const quotaExhaustedToday = existing?.quotaExhaustedDate === todayBeijing;
      const quotaError = existing?.service === 'dola' ? 'DOLA_QUOTA_EXHAUSTED' : 'DOUBAO_FREE_QUOTA_EXHAUSTED';
      const status = quotaExhaustedToday ? "cooling" : result.ok ? "ready"
        : result.loggedIn ? "degraded"
          : new Set(["LOGIN_REQUIRED", "PROFILE_NOT_FOUND"]).has(result.error) ? "auth_required" : "error";
      return (await transaction(async () => {
        const updated = (await db.prepare(`UPDATE accounts SET status=?, health_score=?,
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
            timestamp, quotaExhaustedToday ? quotaError : result.error || null, timestamp, id));
        if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
        if (result.loggedIn || result.ok) await db.prepare(`INSERT INTO resident_browsers(account_id,enabled_at)
          VALUES(?,?) ON CONFLICT(account_id) DO NOTHING`).run(id,timestamp);
        if (result.ok) await db.prepare('UPDATE accounts SET needs_attention=0,attention_reason=NULL,attention_since=NULL,attention_penalty=0 WHERE id=?').run(id);
        else if (!quotaExhaustedToday || requiresHuman(result.error)) await flagAttention(id, result.error || 'VERIFICATION_FAILED');
        (await insertEvent({
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
            error: quotaExhaustedToday ? quotaError : result.error || null,
          },
        }));
        return (await this.getAccount(id));
      }));
    },

    async confirmSessionFromTask(id) {
      return transaction(async () => {
        const account=await this.getAccount(id);
        if(!account)throw new Error('ACCOUNT_NOT_FOUND');
        const timestamp=Date.now(),cooling=account.quotaExhaustedDate===beijingDay(timestamp);
        // A matched conversation with a visible platform response confirms the
        // session. Preserve the existing model/credit evidence without visiting another page.
        await db.prepare(`UPDATE accounts SET status=?,last_verified_at=?,last_error_code=?,updated_at=?,
          needs_attention=0,attention_reason=NULL,attention_since=NULL,attention_penalty=0 WHERE id=?`)
          .run(cooling?'cooling':'ready',timestamp,cooling?account.lastErrorCode:null,timestamp,id);
        await db.prepare('INSERT INTO resident_browsers(account_id,enabled_at) VALUES(?,?) ON CONFLICT(account_id) DO NOTHING').run(id,timestamp);
        await insertEvent({accountId:id,eventType:'account.session_confirmed',message:'已在原任务对话确认登录状态，保留原页面'});
        return this.getAccount(id);
      });
    },

    async saveVerificationFailure(id, errorCode) {
      const timestamp = Date.now();
      return (await transaction(async () => {
        const account = await this.getAccount(id);
        const quotaExhaustedToday = account?.quotaExhaustedDate === beijingDay(timestamp);
        (await db.prepare("UPDATE accounts SET status=?, health_score=0, last_error_code=?, updated_at=? WHERE id=?")
          .run(quotaExhaustedToday ? "cooling" : "error",
            quotaExhaustedToday ? (account.service === 'dola' ? 'DOLA_QUOTA_EXHAUSTED' : 'DOUBAO_FREE_QUOTA_EXHAUSTED') : errorCode, timestamp, id));
        if (!quotaExhaustedToday || requiresHuman(errorCode)) await flagAttention(id, errorCode);
        (await insertEvent({
          accountId: id,
          eventType: "account.verification_error",
          message: "只读验收执行异常",
          details: { errorCode },
        }));
      }));
    },

    async recordProfileOpened(id) {
      return (await transaction(async () => {
        (await db.prepare("UPDATE accounts SET status=CASE WHEN status='provisioning' THEN 'auth_required' ELSE status END, updated_at=? WHERE id=?")
          .run(Date.now(), id));
        (await insertEvent({ accountId: id, eventType: "account.profile_opened", message: "已打开专用登录窗口" }));
      }));
    },

    async createDraftJob(input) {
      const enqueue = input.enqueue === true;
      const timestamp = Date.now();
      const id = `job-${randomUUID()}`;
      return (await transaction(async () => {
        (await db.prepare(`INSERT INTO jobs
          (id, idempotency_key, account_id, requested_account_id, mode, model, requested_model,
           duration_seconds, aspect_ratio, prompt, negative_prompt, concurrency,
           reference_assets_json, reference_asset_names_json, reference_video_path, reference_video_name,
           priority, asset_rights_confirmed, status, queued_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.idempotencyKey, input.accountId || null, input.accountId || null,
            input.mode, input.model, input.model, input.durationSeconds, input.aspectRatio || "9:16", input.prompt,
            input.negativePrompt || "", input.concurrency || 1,
            JSON.stringify(input.referenceAssets || []), JSON.stringify(input.referenceAssetNames || []),
            input.referenceVideo || null, input.referenceVideoName || null,
            input.priority, input.assetRightsConfirmed ? 1 : 0,
            enqueue ? "queued" : "draft", enqueue ? timestamp : null, timestamp, timestamp));
        (await insertEvent({
          accountId: input.accountId || null,
          jobId: id,
          eventType: enqueue ? "job.queued" : "job.draft_created",
          message: enqueue ? "任务已加入自动队列" : "已保存任务草稿，尚未提交生成",
          details: { mode: input.mode, model: input.model, durationSeconds: input.durationSeconds },
        }));
        return asJob((await db.prepare(`${jobSelect} WHERE id=?`).get(id)));
      }));
    },

    async updateDraftJob(id, input) {
      return (await transaction(async () => {
        const current = (await this.getJob(id));
        if (!current) throw new Error("JOB_NOT_FOUND");
        if (current.status !== "draft") throw new Error("JOB_NOT_EDITABLE");
        const timestamp = Date.now();
        (await db.prepare(`UPDATE jobs SET account_id=?, requested_account_id=?, mode=?, model=?, requested_model=?,
          duration_seconds=?, aspect_ratio=?,
          prompt=?, negative_prompt=?, concurrency=?, reference_assets_json=?, reference_asset_names_json=?,
          reference_video_path=?, reference_video_name=?, priority=?, updated_at=?
          WHERE id=? AND status='draft'`)
          .run(input.accountId || null, input.accountId || null, input.mode, input.model, input.model,
            input.durationSeconds,
            input.aspectRatio || "9:16", input.prompt, input.negativePrompt || "", input.concurrency || 1,
            JSON.stringify(input.referenceAssets || []),
            JSON.stringify(input.referenceAssetNames || []), input.referenceVideo || null,
            input.referenceVideoName || null, input.priority, timestamp, id));
        (await insertEvent({ accountId: input.accountId || null, jobId: id, eventType: "job.draft_updated",
          message: "任务草稿已修改", details: { model: input.model, durationSeconds: input.durationSeconds,
            aspectRatio: input.aspectRatio || "9:16", imageCount: input.referenceAssets.length,
            hasReferenceVideo: Boolean(input.referenceVideo) } }));
        return (await this.getJob(id));
      }));
    },

    async markAccountLoginRequired(id, errorCode = "LOGIN_REQUIRED") {
      return transaction(async () => {
      const updated = (await db.prepare("UPDATE accounts SET status='auth_required', last_error_code=?, updated_at=? WHERE id=?")
        .run(errorCode, Date.now(), id));
      if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
      await flagAttention(id, errorCode);
        (await insertEvent({ accountId: id, eventType: "account.session_expired",
          message: errorCode === "DOLA_HUMAN_VERIFICATION_REQUIRED" ? "平台要求人工验证，已暂停使用此账号" : "平台要求重新登录，已暂停使用此账号", details: { errorCode } }));
      });
    },

    async recordExternalVideoGeneration(id, { videoId, createdAt }) {
      if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(videoId)
        || !Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > Date.now() + 60_000) {
        throw new Error('INVALID_EXTERNAL_VIDEO');
      }
      return transaction(async () => {
        const account = await this.getAccount(id);
        if (!account || !['doubao','dola'].includes(account.service)) throw new Error('ACCOUNT_NOT_FOUND');
        const previous = await db.prepare('SELECT created_at FROM account_external_videos WHERE account_id=? AND video_id=?').get(id,videoId);
        if (previous) {
          if (previous.created_at !== createdAt) throw new Error('EXTERNAL_VIDEO_CONFLICT');
          return account;
        }
        const day = creditDay(createdAt);
        await db.prepare('INSERT INTO account_external_videos(account_id,video_id,quota_date,created_at) VALUES(?,?,?,?)')
          .run(id,videoId,day,createdAt);
        await insertEvent({accountId:id,eventType:'account.external_video_recorded',
          message:'已将工作台任务外的生成计入账号当日次数',details:{videoId,day}});
        return this.getAccount(id);
      });
    },

    async markAccountQuotaExhausted(id, errorCode = "DOUBAO_FREE_QUOTA_EXHAUSTED") {
      return (await transaction(async () => {
        const timestamp = Date.now();
        const account = await this.getAccount(id);
        if (!account || !["doubao", "dola"].includes(account.service)) throw new Error("ACCOUNT_NOT_FOUND");
        const code = account.service === "dola" ? "DOLA_QUOTA_EXHAUSTED" : "DOUBAO_FREE_QUOTA_EXHAUSTED";
        if (errorCode !== code) throw new Error("INVALID_QUOTA_ERROR");
        const updated = (await db.prepare(`UPDATE accounts SET status='cooling', credits_remaining=0,
            video_count_date=?, quota_exhausted_date=?,
            last_error_code=?, updated_at=?
          WHERE id=?`)
          .run(beijingDay(timestamp), beijingDay(timestamp), code, timestamp, id));
        if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
        (await insertEvent({ accountId: id, eventType: "account.quota_exhausted",
          message: "平台提示可用生成额度已用完", details: { errorCode: code } }));
        return (await this.getAccount(id));
      }));
    },

    async handleDispatchFailure(id, accountId, errorCode, { quotaExhausted = false,
      beforeSubmission = false, leaseToken = null } = {}) {
      if (!quotaExhausted && !beforeSubmission) throw new Error("JOB_FAILURE_NOT_RETRYABLE");
      return (await transaction(async () => {
        const job = (await this.getJob(id));
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.leaseToken && (job.leaseToken !== leaseToken || !await db.prepare('SELECT 1 FROM account_leases WHERE token=? AND expires_at>?').get(leaseToken,Date.now()))) throw new Error('STALE_JOB_LEASE');
        if (job.accountId !== accountId || new Set(["success", "failed", "cancelled"]).has(job.status)) {
          throw new Error("JOB_ALREADY_FINISHED");
        }
        const now = Date.now();
        const profileBusy = beforeSubmission && errorCode === "PROFILE_IN_USE";
        if (!job.collectOnly) await releaseCredits(id);
        if (quotaExhausted) {
          const account = await this.getAccount(accountId);
          const code = account?.service === "dola" ? "DOLA_QUOTA_EXHAUSTED" : "DOUBAO_FREE_QUOTA_EXHAUSTED";
          if (errorCode !== code) throw new Error("INVALID_QUOTA_ERROR");
          const updated = (await db.prepare(`UPDATE accounts SET status='cooling', credits_remaining=0,
            video_count_date=?, quota_exhausted_date=?, last_error_code=?, updated_at=?
            WHERE id=? AND service IN ('doubao','dola')`)
            .run(beijingDay(now), beijingDay(now), errorCode, now, accountId));
          if (!updated.changes) throw new Error("ACCOUNT_NOT_FOUND");
          (await insertEvent({ accountId, eventType: "account.quota_exhausted",
            message: "平台确认该账号可用生成额度已用完",
            details: { errorCode } }));
        } else if (requiresHuman(errorCode)) {
          (await this.markAccountLoginRequired(accountId, errorCode));
        } else if (!profileBusy) {
          (await db.prepare(`UPDATE accounts SET status='degraded', health_score=25,
            last_error_code=?, updated_at=? WHERE id=?`)
            .run(errorCode, now, accountId));
          (await insertEvent({ accountId, eventType: "account.dispatch_failed",
            message: "提交前执行失败，账号等待重新验收", details: { errorCode } }));
        }
        await recordExecutionFault(accountId, id, errorCode);
        const canRetry = job.queuedAt != null && (!job.requestedAccountId || profileBusy) && !job.cancelRequested;
        if (canRetry) {
          (await db.prepare(`UPDATE jobs SET account_id=NULL, model=requested_model, status='queued',
            remote_url=NULL, result_path=NULL, error_code=?, submitted_at=NULL,
            completed_at=NULL, updated_at=? WHERE id=?`)
            .run(profileBusy ? "ACCOUNT_BROWSER_BUSY" : null, now, id));
          (await insertEvent({ accountId, jobId: id, eventType: profileBusy ? "job.waiting_for_browser" : "job.failover_queued",
            message: profileBusy ? "账号浏览器暂被占用，释放后自动继续" : "已切换候选账号并重新排队",
            details: { errorCode, quotaExhausted } }));
        } else {
          const finalStatus = job.cancelRequested ? "cancelled" : "failed";
          (await db.prepare(`UPDATE jobs SET status=?, error_code=?, completed_at=?, updated_at=? WHERE id=?`)
            .run(finalStatus, errorCode, now, now, id));
          (await insertEvent({ accountId, jobId: id, eventType: `job.${finalStatus}`,
            message: "任务执行失败", details: { errorCode } }));
        }
        return (await this.getJob(id));
      }));
    },

    async listJobs(limit = 100) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      return (await db.prepare(`${jobSelect} ORDER BY updated_at DESC LIMIT ?`).all(safeLimit)).map(asJob);
    },

    async listJobsPage({ status = "all", page = 1, pageSize = 6 } = {}) {
      const where = status === "all" ? "" : status === "active"
        ? " WHERE status IN ('queued','leased','submitting','submitted','generating','collecting','reconciling')"
        : " WHERE status=?";
      const parameters = status === "all" || status === "active" ? [] : [status];
      const total = Number((await db.prepare(`SELECT COUNT(*) AS total FROM jobs${where}`).get(...parameters)).total);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(page, totalPages);
      const jobs = (await db.prepare(`${jobSelect}${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (currentPage - 1) * pageSize)).map(asJob);
      return { jobs, status, page: currentPage, pageSize, total, totalPages };
    },

    async getJob(id) {
      return asJob((await db.prepare(`${jobSelect} WHERE id=?`).get(id)));
    },

    async getJobByIdempotencyKey(key) {
      return asJob((await db.prepare(`${jobSelect} WHERE idempotency_key=?`).get(key)));
    },

    async listBatchJobs(batchId) {
      return (await db.prepare(`${jobSelect} WHERE batch_id=? OR id=? ORDER BY batch_index ASC`)
        .all(batchId, batchId)).map(asJob);
    },

    async listBusyAccountIds() {
      return (await db.prepare(`SELECT DISTINCT account_id AS id FROM jobs
        WHERE account_id IS NOT NULL AND status IN
        ('leased','submitting','submitted','generating','collecting','reconciling')`)
        .all()).map((row) => row.id);
    },

    async hasQueuedJobs() {
      return Boolean((await db.prepare(`SELECT 1 FROM jobs WHERE (status='queued' AND cancel_requested=0)
        OR (status='reconciling' AND next_reconcile_at<=?) LIMIT 1`).get(Date.now())));
    },

    async scheduleReconciliation(id) {
      return transaction(async () => {
        const job = await this.getJob(id);
        if (!job || job.status !== 'reconciling') return;
        const plan = job.accountId ? reconciliationPlan(job) : null;
        await db.prepare('UPDATE jobs SET next_reconcile_at=?,reconcile_deadline_at=? WHERE id=?')
          .run(plan?.next ?? null, plan ? plan.deadline : job.reconcileDeadlineAt, id);
        if (plan && plan.next === null) {
          await db.prepare("UPDATE jobs SET error_code='RECONCILIATION_NEEDS_ATTENTION' WHERE id=?").run(id);
          await flagAttention(job.accountId, 'RECONCILIATION_NEEDS_ATTENTION');
          await insertEvent({ accountId: job.accountId, jobId: id, eventType: 'job.reconciliation_attention',
            message: '自动核对已达到 24 小时，请人工确认原平台任务；未重新生成' });
        }
      });
    },

    async restoreReconciliation() {
      for (const row of await db.prepare("SELECT id FROM jobs WHERE status='reconciling' AND next_reconcile_at IS NULL").all()) {
        await this.scheduleReconciliation(row.id);
      }
    },

    async claimNextReconciliation({ unavailableAccountIds = [], pool = null, maxConcurrent = 2 } = {}) {
      return transaction(async () => {
        const now = Date.now();
        const occupied = await db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE collect_only=1
          AND status IN ('leased','submitting','submitted','generating','collecting')`).get();
        if (occupied.count >= maxConcurrent) return null;
        const unavailable = new Set([...unavailableAccountIds, ...(pool ? await pool.unavailableIds() : [])]);
        const pending = (await db.prepare(`${jobSelect} WHERE status='reconciling' AND next_reconcile_at<=?
          ORDER BY next_reconcile_at,created_at`).all(now)).map(asJob);
        for (const job of pending) {
          if (job.reconcileDeadlineAt != null && job.reconcileDeadlineAt <= now) { await this.scheduleReconciliation(job.id); continue; }
          const account = await this.getAccount(job.accountId);
          if (!account || account.status !== 'ready' || account.needsAttention || unavailable.has(account.id)
            || !collectionUrl(job.remoteUrl, account.service)) continue;
          if (await db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
            AND status IN ('leased','submitting','submitted','generating','collecting') LIMIT 1`).get(account.id, job.id)) continue;
          if (pool && !await pool.reserve(account, 'job', job.id)) return null;
          await db.prepare(`UPDATE jobs SET status='leased',collect_only=1,requested_account_id=account_id,reconcile_attempts=reconcile_attempts+1,
            next_reconcile_at=NULL,last_reconcile_at=?,updated_at=? WHERE id=?`).run(now, now, job.id);
          await insertEvent({ accountId: account.id, jobId: job.id, eventType: 'job.reconciliation_started',
            message: '自动核对原平台任务，仅收集结果，不重复生成或扣积分' });
          return { job: await this.getJob(job.id), account, reconciliation: true };
        }
        return null;
      });
    },

    async enqueueJob(id) {
      return (await transaction(async () => {
        const job = (await this.getJob(id));
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "draft") throw new Error("JOB_NOT_QUEUEABLE");
        const now = Date.now();
        (await db.prepare("UPDATE jobs SET status='queued', queued_at=?, error_code=NULL, updated_at=? WHERE id=?")
          .run(now, now, id));
        (await insertEvent({ accountId: job.accountId, jobId: id, eventType: "job.queued",
          message: "任务已加入自动队列" }));
        return (await this.getJob(id));
      }));
    },

    async enqueueBatch(id) {
      return transaction(async () => {
        const draft = await this.getJob(id);
        if (!draft) throw new Error('JOB_NOT_FOUND');
        if (draft.status !== 'draft') throw new Error('JOB_NOT_STARTABLE');
        const count = Number(draft.concurrency || 1);
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('INVALID_CONCURRENCY');
        const ids = [id];
        for (let index = 1; index < count; index++) {
          const child = await this.createDraftJob({ ...draft, accountId: draft.requestedAccountId,
            model: draft.requestedModel, concurrency: 1, idempotencyKey: `${id}:part:${index + 1}` });
          ids.push(child.id);
        }
        for (const [index, jobId] of ids.entries()) {
          await db.prepare('UPDATE jobs SET batch_id=?,batch_index=?,batch_size=? WHERE id=?').run(id,index+1,count,jobId);
          await this.enqueueJob(jobId);
        }
        return Promise.all(ids.map(jobId => this.getJob(jobId)));
      });
    },

    async claimNextQueuedJob({ maxVerificationAgeMs = 24 * 60 * 60_000, unavailableAccountIds = [], pool = null } = {}) {
      return (await transaction(async () => {
        const poolReasons = pool ? await pool.unavailableReasons() : new Map();
        const unavailable = new Set([...unavailableAccountIds, ...poolReasons.keys()]);
        const queued = (await db.prepare(`${jobSelect} WHERE status='queued' AND cancel_requested=0
          ORDER BY priority DESC, COALESCE(queued_at,created_at) ASC, rowid ASC`).all()).map(asJob);
        if (!queued.length) return null;
        const now = Date.now();
        const usageRows = await db.prepare(`SELECT account_id AS id,
          MAX(CASE WHEN status NOT IN ('draft','queued','cancelled') THEN COALESCE(submitted_at,updated_at) ELSE 0 END) AS last_used,
          MAX(CASE WHEN status IN ('leased','submitting','submitted','generating','collecting','reconciling') THEN 1 ELSE 0 END) AS busy
          FROM jobs WHERE account_id IS NOT NULL GROUP BY account_id`).all();
        const usage = new Map(usageRows.map(row => [row.id,row]));
        const accounts = (await this.listAccounts()).map(account => {
          const lastUsedAt=Number(usage.get(account.id)?.last_used||0),verifiedAt=Number(account.lastVerifiedAt||0);
          return {...account,status:account.status==='ready'&&(!verifiedAt||now-verifiedAt>maxVerificationAgeMs||verifiedAt<lastUsedAt)?'degraded':account.status,
            busy:Boolean(usage.get(account.id)?.busy)||unavailable.has(account.id),lastUsedAt};
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
                const candidate = resolveVideoTarget({ ...job, accountId: job.requestedAccountId, model: job.requestedModel },
                  accounts.map(account => ({ ...account, busy: Boolean(usage.get(account.id)?.busy) })));
                reason = poolReasons.get(candidate.account.id) || "ACCOUNT_BROWSER_BUSY";
              } catch { /* Another eligibility requirement also prevents dispatch. */ }
            }
            if (reason === 'NO_ELIGIBLE_ACCOUNT') reason = videoTargetBlocker({ ...job,
              accountId: job.requestedAccountId, model: job.requestedModel }, accounts) || reason;
            if (job.errorCode !== reason) {
              (await db.prepare("UPDATE jobs SET error_code=?,updated_at=? WHERE id=? AND status='queued'").run(reason, now, job.id));
            }
            continue;
          }
          if (pool && !(await pool.reserve(selected.account, 'job', job.id))) return null;
          await reserveCredits(job, selected.model);
          (await db.prepare(`UPDATE jobs SET account_id=?, model=?, status='leased', error_code=NULL,
            updated_at=? WHERE id=? AND status='queued'`)
            .run(selected.account.id, selected.model, now, job.id));
          (await insertEvent({ accountId: selected.account.id, jobId: job.id, eventType: "job.dispatched",
            message: "自动队列已分配账号并开始执行",
            details: { selectedModel: selected.model } }));
          return { job: (await this.getJob(job.id)), account: (await this.getAccount(selected.account.id)) };
        }
        return null;
      }));
    },

    async hasRunningJobForAccount(accountId) {
      return Boolean((await db.prepare(`SELECT 1 FROM jobs WHERE account_id=?
        AND status IN ('leased','submitting','submitted','generating','collecting') LIMIT 1`).get(accountId)));
    },

    async startJob(id) {
      return (await transaction(async () => {
        const job = (await this.getJob(id));
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "draft") throw new Error("JOB_NOT_STARTABLE");
        const occupancy = db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`);
        const lastUse = db.prepare(`SELECT MAX(COALESCE(submitted_at,updated_at)) AS value FROM jobs
          WHERE account_id=? AND id<>? AND status NOT IN ('draft','queued','cancelled')`);
        const accounts = (await Promise.all((await this.listAccounts()).map(async (account) => ({ ...account,
          busy: Boolean((await occupancy.get(account.id, id))),
          lastUsedAt: Number((await lastUse.get(account.id, id)).value || 0),
        }))));
        const selected = resolveVideoTarget(job, accounts);
        const account = selected.account;
        await reserveCredits(job, selected.model);
        (await db.prepare("UPDATE jobs SET account_id=?, model=?, status='leased', error_code=NULL, updated_at=? WHERE id=?")
          .run(account.id, selected.model, Date.now(), id));
        (await insertEvent({ accountId: account.id, jobId: id, eventType: "job.started",
          message: job.mode === "reference_to_video" ? "开始执行参考素材转视频任务" : "开始执行视频生成任务",
          details: { requestedAccountId: job.accountId || "auto", requestedModel: job.model,
            selectedModel: selected.model } }));
        return { job: (await this.getJob(id)), account };
      }));
    },

    async startJobBatch(id) {
      const draft = (await this.getJob(id));
      if (!draft) throw new Error("JOB_NOT_FOUND");
      if (draft.status !== "draft") throw new Error("JOB_NOT_STARTABLE");
      const count = Number(draft.concurrency || 1);
      if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("INVALID_CONCURRENCY");
      if (count === 1) return [(await this.startJob(id))];
      if (draft.mode !== "image_to_video" || draft.requestedAccountId) {
        throw new Error("CONCURRENCY_REQUIRES_AUTO_ACCOUNT");
      }
      return (await transaction(async () => {
        const current = (await this.getJob(id));
        if (current?.status !== "draft") throw new Error("JOB_NOT_STARTABLE");
        const occupancy = db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`);
        const lastUse = db.prepare(`SELECT MAX(COALESCE(submitted_at,updated_at)) AS value FROM jobs
          WHERE account_id=? AND id<>? AND status NOT IN ('draft','queued','cancelled')`);
        const accounts = (await Promise.all((await this.listAccounts()).map(async (account) => ({ ...account,
          busy: Boolean((await occupancy.get(account.id, id))),
          lastUsedAt: Number((await lastUse.get(account.id, id)).value || 0),
        }))));
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
        (await db.prepare(`UPDATE jobs SET account_id=?, model=?, status='leased', error_code=NULL,
          batch_id=?, batch_index=1, batch_size=?, updated_at=? WHERE id=?`)
          .run(selected[0].account.id, selected[0].model, id, count, now, id));
        for (let index = 1; index < count; index += 1) {
          const childId = `job-${randomUUID()}`;
          ids.push(childId);
          (await db.prepare(`INSERT INTO jobs
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
              current.priority, now, now));
        }
        for (let index = 0; index < count; index += 1) {
          await reserveCredits(await this.getJob(ids[index]), selected[index].model);
          (await insertEvent({ accountId: selected[index].account.id, jobId: ids[index],
            eventType: "job.started", message: `批次第 ${index + 1}/${count} 条视频生成任务已启动`,
            details: { batchId: id, batchIndex: index + 1, batchSize: count,
              selectedModel: selected[index].model } }));
        }
        return (await Promise.all(ids.map(async (jobId, index) => ({ job: (await this.getJob(jobId)),
          account: (await this.getAccount(selected[index].account.id)) }))));
      }));
    },

    async boundRemoteUrls(accountId, exceptId) {
      return (await db.prepare('SELECT remote_url FROM jobs WHERE account_id=? AND id<>? AND remote_url IS NOT NULL')
        .all(accountId, exceptId)).map(row => row.remote_url);
    },

    async pendingDolaJobsForAccount(accountId) {
      const rows = await db.prepare(`${jobSelect} WHERE account_id=? AND model IN ('Dreamina Seedance 2.0 Fast','Dreamina Seedance 2.5','Seedance 2.0 Fast','Seedance 2.0 Mini') AND status='reconciling' ORDER BY created_at DESC`).all(accountId);
      return rows.map(row=>({id:row.id,status:row.status,errorCode:row.errorCode,progress:jobProgress(row)}));
    },

    async attachRemoteTask(id, remoteUrl, remoteMessageId=null, recoveryLeaseToken=null) {
      return transaction(async () => {
        const job = await this.getJob(id);
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "reconciling" || job.remoteUrl) throw new Error("JOB_NOT_RECONCILABLE");
        const lease = await db.prepare("SELECT purpose,token FROM account_leases WHERE account_id=? AND expires_at>?").get(job.accountId, Date.now());
        if (lease && lease.purpose !== 'manual' && !(lease.purpose === 'view' && lease.token === recoveryLeaseToken)) {
          throw new Error("ACCOUNT_ALREADY_RUNNING");
        }
        if(remoteMessageId!==null&&(typeof remoteMessageId!=='string'||!/^(?!local_|draft_)[A-Za-z0-9_-]{1,160}$/.test(remoteMessageId)))throw new Error('INVALID_PLATFORM_MESSAGE_ID');
        const duplicate=remoteMessageId===null
          ? await db.prepare('SELECT 1 FROM jobs WHERE remote_url=? AND id<>?').get(remoteUrl,id)
          : await db.prepare('SELECT 1 FROM jobs WHERE remote_url=? AND id<>? AND remote_message_id=?').get(remoteUrl,id,remoteMessageId);
        if(duplicate)throw new Error('REMOTE_TASK_ALREADY_BOUND');
        await db.prepare("UPDATE jobs SET remote_url=?,remote_message_id=?,lease_token=NULL,error_code=NULL,updated_at=? WHERE id=?").run(remoteUrl,remoteMessageId, Date.now(), id);
        await insertEvent({ accountId: job.accountId, jobId: id, eventType: "job.remote_task_attached",
          message: "已核对并绑定平台任务，后续仅收集现有结果" });
        return this.getJob(id);
      });
    },

    async recollectJob(id) {
      return (await transaction(async () => {
        const job = (await this.getJob(id));
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (job.status !== "reconciling" || !job.remoteUrl) throw new Error("JOB_NOT_RECOLLECTABLE");
        const account = (await this.getAccount(job.accountId));
        if (!account || account.status !== "ready" || account.needsAttention) throw new Error("ACCOUNT_NOT_READY");
        const occupied = (await db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND id<>?
          AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1`)
          .get(job.accountId, id));
        if (occupied) throw new Error("ACCOUNT_ALREADY_RUNNING");
        (await db.prepare("UPDATE jobs SET status='queued',collect_only=1,requested_account_id=account_id,lease_token=NULL,error_code=NULL,queued_at=?,updated_at=? WHERE id=?")
          .run(Date.now(),Date.now(), id));
        (await insertEvent({ accountId: job.accountId, jobId: id, eventType: "job.recollecting", message: "正在从平台重新收集结果" }));
        return { job: (await this.getJob(id)), account };
      }));
    },

    async restartJobConversation(id,leaseToken) {
      return transaction(async()=>{
        const job=await this.getJob(id);
        if(!job)throw new Error('JOB_NOT_FOUND');
        if(job.collectOnly||!['leased','submitting','submitted','generating'].includes(job.status))throw new Error('CONVERSATION_RESTART_UNSAFE');
        if(job.leaseToken){
          const lease=await db.prepare('SELECT 1 FROM account_leases WHERE token=? AND expires_at>?').get(leaseToken,Date.now());
          if(job.leaseToken!==leaseToken||!lease)throw new Error('STALE_JOB_LEASE');
        }
        if(await db.prepare("SELECT 1 FROM events WHERE job_id=? AND event_type IN ('job.conversation_restarted','job.collecting','job.success')").get(id))throw new Error('CONVERSATION_RESTART_UNSAFE');
        const now=Date.now();
        await db.prepare("UPDATE jobs SET status='submitting',remote_url=NULL,remote_message_id=NULL,submitted_at=NULL,error_code=NULL,last_observed_stage='submitting',last_observed_at=?,updated_at=? WHERE id=?").run(now,now,id);
        await insertEvent({jobId:id,accountId:job.accountId,eventType:'job.conversation_restarted',
          message:'平台提示对话上下文过长，已新建对话继续本次任务（仅一次）',
          details:{reason:'CONVERSATION_CONTEXT_LIMIT',previousRemoteUrl:job.remoteUrl,previousRemoteMessageId:job.remoteMessageId}});
        return this.getJob(id);
      });
    },

    async beginTaskConfirmation(id) {
      return transaction(async () => {
        const job = await this.getJob(id);
        if (!job || job.status !== 'reconciling' || !job.remoteUrl) throw new Error('JOB_NOT_RECONCILABLE');
        if (await db.prepare("SELECT 1 FROM events WHERE job_id=? AND event_type='job.platform_confirmation_requested' LIMIT 1").get(id)) return false;
        await insertEvent({accountId:job.accountId,jobId:id,eventType:'job.platform_confirmation_requested',
          message:'已核对原会话参数，继续确认一次；不会重新发送提示词'});
        return true;
      });
    },

    async hasVerificationResubmission(id) {
      return Boolean(await db.prepare("SELECT 1 FROM events WHERE job_id=? AND event_type='job.verification_resubmitted' LIMIT 1").get(id));
    },

    async resubmitAfterVerification(id) {
      return transaction(async () => {
        const job = await this.getJob(id);
        if (!job) throw new Error('JOB_NOT_FOUND');
        if (await this.hasVerificationResubmission(id)) throw new Error('DOUBAO_VERIFICATION_RETRY_USED');
        if (job.status !== 'reconciling' || job.remoteUrl || job.submittedAt || job.resultPath || job.collectOnly
          || !['DOUBAO_HUMAN_VERIFICATION_REQUIRED','DOUBAO_VERIFIED_TASK_NOT_FOUND'].includes(job.errorCode)) {
          throw new Error('JOB_NOT_RECONCILABLE');
        }
        const account = await this.getAccount(job.accountId);
        if (account?.service !== 'doubao' || account.status !== 'ready' || account.needsAttention) throw new Error('ACCOUNT_NOT_READY');
        if (await db.prepare('SELECT 1 FROM account_leases WHERE account_id=? AND expires_at>?').get(account.id,Date.now())
          || await db.prepare("SELECT 1 FROM jobs WHERE account_id=? AND id<>? AND status IN ('leased','submitting','submitted','generating','collecting','reconciling') LIMIT 1").get(account.id,id)) {
          throw new Error('ACCOUNT_ALREADY_RUNNING');
        }
        // Keep the original API/job identity, account, model, and credit ledger.
        // The audit event and queue transition commit together, once per job.
        const now = Date.now();
        await db.prepare(`UPDATE jobs SET status='queued',collect_only=0,requested_account_id=account_id,
          requested_model=model,lease_token=NULL,error_code=NULL,next_reconcile_at=NULL,
          queued_at=?,updated_at=? WHERE id=?`).run(now,now,id);
        await insertEvent({accountId:account.id,jobId:id,eventType:'job.verification_resubmitted',
          message:'验证已通过，核对平台记录后补提交原请求一次，保留任务编号和扣点记录'});
        return {job:await this.getJob(id),account};
      });
    },

    async updateJob(id, update) {
      if (!JOB_STATUSES.has(update.status) || update.status === "draft") throw new Error("INVALID_JOB_STATUS");
      return (await transaction(async () => {
        const current = (await this.getJob(id));
        if (!current) throw new Error("JOB_NOT_FOUND");
        if (current.leaseToken) {
          const lease = await db.prepare('SELECT token FROM account_leases WHERE token=? AND expires_at>?').get(update.leaseToken, Date.now());
          if (!lease || current.leaseToken !== update.leaseToken) throw new Error('STALE_JOB_LEASE');
        }
        if (new Set(["success", "failed", "cancelled"]).has(current.status)) throw new Error("JOB_ALREADY_FINISHED");
        if(current.remoteUrl&&update.remoteUrl&&current.remoteUrl!==update.remoteUrl)throw new Error('TASK_CONVERSATION_CHANGED');
        if(update.remoteMessageId!=null){
          if(typeof update.remoteMessageId!=='string'||!/^(?!local_|draft_)[A-Za-z0-9_-]{1,160}$/.test(update.remoteMessageId))throw new Error('INVALID_PLATFORM_MESSAGE_ID');
          if(current.remoteMessageId&&current.remoteMessageId!==update.remoteMessageId)throw new Error('TASK_MESSAGE_MISMATCH');
          const remoteUrl=update.remoteUrl||current.remoteUrl;
          if(!remoteUrl)throw new Error('INVALID_REMOTE_URL');
          if(await db.prepare('SELECT 1 FROM jobs WHERE remote_url=? AND remote_message_id=? AND id<>?').get(remoteUrl,update.remoteMessageId,id))throw new Error('REMOTE_TASK_ALREADY_BOUND');
        }
        const now = Date.now();
        if (update.status === 'reconciling' && isPlatformResultPending({...current,...update})) {
          update = {...update,errorCode:'PLATFORM_RESULT_PENDING'};
        }
        if (current.accountId && requiresHuman(update.errorCode)) await this.markAccountLoginRequired(current.accountId, update.errorCode);
        if (['submitting','submitted','generating','collecting','success'].includes(update.status)
          && !(current.collectOnly && update.status === 'submitted' && ['generating','collecting'].includes(current.lastObservedStage))) {
          await db.prepare('UPDATE jobs SET last_observed_stage=?,last_observed_at=? WHERE id=?').run(update.status,now,id);
        }
        await recordExecutionFault(current.accountId, id, update.errorCode);
        if (update.status === 'success' && current.accountId
          && !await db.prepare("SELECT 1 FROM events WHERE job_id=? AND event_type='job.success'").get(id)) {
          await db.prepare(`UPDATE accounts SET video_success_count=video_success_count+1,
            reliability_score=CASE WHEN reliability_score > 96 THEN 100 ELSE reliability_score+4 END WHERE id=?`)
            .run(current.accountId);
        }
        if (!current.collectOnly) {
          if (['submitting','submitted','generating','collecting','success'].includes(update.status)
            && current.creditState !== 'charged' && current.accountId) {
            const cost = videoCreditCost(current.model, current.durationSeconds);
            if (cost) await db.prepare("UPDATE jobs SET credit_cost=?,credit_date=?,credit_state='charged' WHERE id=?")
              .run(cost, creditDay(now), id);
          } else if (['failed','cancelled'].includes(update.status) && current.creditState === 'reserved') {
            await releaseCredits(id);
          }
        }
        (await db.prepare(`UPDATE jobs SET status=?, remote_url=COALESCE(?,remote_url),remote_message_id=COALESCE(?,remote_message_id),
          result_path=COALESCE(?,result_path), error_code=?,
          submitted_at=CASE WHEN ?='submitted' THEN COALESCE(submitted_at,?) ELSE submitted_at END,
          completed_at=CASE WHEN ? IN ('success','failed') THEN ? ELSE completed_at END,
          updated_at=? WHERE id=?`)
          .run(update.status, update.remoteUrl || null, update.remoteMessageId || null, update.resultPath || null,
            update.errorCode || null, update.status, now, update.status, now, now, id));
        if (update.status === 'reconciling') await this.scheduleReconciliation(id);
        else if (['success','failed','cancelled'].includes(update.status)) {
          await db.prepare('UPDATE jobs SET next_reconcile_at=NULL WHERE id=?').run(id);
        }
        (await insertEvent({ accountId: current.accountId, jobId: id,
          eventType: `job.${update.status}`,
          message: ({ submitting: "正在向平台提交", submitted: "已提交到平台", generating: "平台正在生成",
            collecting: "正在保存结果", success: current.mode === "reference_to_video" ? "参考素材转视频已完成" : "视频生成已完成",
            failed: current.mode === "reference_to_video" ? "参考素材转视频执行失败" : "视频生成执行失败",
            reconciling: update.errorCode === 'PLATFORM_RESULT_PENDING' ? "等待平台结果，继续核对原任务" : "需检查平台任务状态" })[update.status] || "任务状态已更新",
          details: update.errorCode ? { errorCode: update.errorCode } : {},
        }));
        return (await this.getJob(id));
      }));
    },

    async cancelJob(id) {
      const timestamp = Date.now();
      return (await transaction(async () => {
        const job = (await db.prepare("SELECT status FROM jobs WHERE id=?").get(id));
        if (!job) throw new Error("JOB_NOT_FOUND");
        if (!new Set(["draft", "queued"]).has(job.status)) throw new Error("JOB_NOT_CANCELLABLE");
        (await db.prepare("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?").run(timestamp, id));
        await db.prepare("UPDATE jobs SET credit_cost=0,credit_date=NULL,credit_state='released' WHERE id=? AND credit_state='reserved'").run(id);
        (await insertEvent({ jobId: id, eventType: "job.cancelled", message: "任务草稿已取消" }));
      }));
    },

    async listEvents(limit = 60) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
      return (await db.prepare(`${eventSelect} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`)
        .all(safeLimit)).map(asEvent);
    },

    async listEventsPage({ page = 1, pageSize = 10 } = {}) {
      const total = Number((await db.prepare("SELECT COUNT(*) AS total FROM events").get()).total);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(page, totalPages);
      const events = (await db.prepare(`${eventSelect} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`)
        .all(pageSize, (currentPage - 1) * pageSize)).map(asEvent);
      return { events, page: currentPage, pageSize, total, totalPages };
    },

    async overview() {
      const visibleAccounts = (await this.listAccounts()).filter(account => ['doubao','dola'].includes(account.service));
      const accounts = { total: visibleAccounts.length,
        ready: visibleAccounts.filter(account => account.status === 'ready' && !account.needsAttention && account.freeVideosRemaining > 0).length,
        authRequired: visibleAccounts.filter(account => account.status === 'auth_required').length,
        needsAttention: visibleAccounts.filter(account => account.needsAttention || ['provisioning','auth_required','degraded','error'].includes(account.status)).length,
        availableFreeVideos: visibleAccounts.filter(account => account.status === 'ready' && !account.needsAttention)
          .reduce((sum, account) => sum + account.freeVideosRemaining, 0),
        availableCredits: visibleAccounts.filter(account => account.status === 'ready')
          .reduce((sum, account) => sum + account.creditsRemaining, 0) };
      const jobs = (await db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN status IN ('queued','leased','submitting','submitted','generating','collecting','reconciling') THEN 1 ELSE 0 END) AS active
        FROM jobs`).get());
      return {
        accounts: {
          total: Number(accounts.total || 0),
          ready: Number(accounts.ready || 0),
          authRequired: Number(accounts.authRequired || 0),
          needsAttention: Number(accounts.needsAttention || 0),
          availableCredits: Number(accounts.availableCredits || 0),
          availableFreeVideos: Number(accounts.availableFreeVideos || 0),
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
