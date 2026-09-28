import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../lib/db.mjs";

test("账号验收、草稿和审计流水写入同一 SQLite", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-workbench-"));
  const store = createStore(path.join(tempRoot, "test.sqlite"));
  try {
    const account = store.ensureAccount({
      id: "owner-pc-symphony-01",
      label: "测试账号",
      loginType: "tiktok",
      service: "symphony",
      workerId: "owner-pc",
      profilePath: path.join(tempRoot, "owner-pc-symphony-01_sandbox_data"),
      status: "auth_required",
    });
    assert.equal(account.status, "auth_required");

    store.setAccountChecking(account.id);
    const verified = store.saveVerification(account.id, {
      ok: true,
      loggedIn: true,
      remainingCredits: 16720,
      totalCredits: 24000,
      nextRefresh: "09-21",
      referenceImageLimit: 4,
      modelsObserved: ["Dreamina Seedance 2.0 Fast"],
      stage: "completed",
    });
    assert.equal(verified.status, "ready");
    assert.equal(verified.creditsRemaining, 16720);

    const draft = store.createDraftJob({
      idempotencyKey: "test-job-1",
      accountId: account.id,
      mode: "reference_to_video",
      model: "Dreamina Seedance 2.0 Fast",
      durationSeconds: 15,
      prompt: "测试提示词",
      referenceAssets: ["asset-a.png"],
      priority: 50,
    });
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.referenceAssets, ["asset-a.png"]);
    assert.equal(store.overview().accounts.ready, 1);
    assert.equal(store.overview().jobs.draft, 1);
    assert.ok(store.listEvents().length >= 4);
  } finally {
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("旧版账号数据库升级后保留账号并加入豆包视频字段", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-migration-"));
  const databasePath = path.join(tempRoot, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, login_type TEXT NOT NULL,
    service TEXT NOT NULL, worker_id TEXT NOT NULL, profile_path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL, health_score INTEGER NOT NULL DEFAULT 0,
    credits_remaining INTEGER, credits_total INTEGER, credits_reset_at TEXT,
    reference_image_limit INTEGER, models_json TEXT NOT NULL DEFAULT '[]',
    last_verified_at INTEGER, last_error_code TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  legacy.prepare(`INSERT INTO accounts
    (id,label,login_type,service,worker_id,profile_path,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "old-doubao", "旧豆包账号", "doubao", "doubao", "pc", path.join(tempRoot, "profile"),
    "ready", 1, 1,
  );
  legacy.close();

  const store = createStore(databasePath);
  try {
    assert.equal(store.getAccount("old-doubao").label, "旧豆包账号");
    store.saveVerification("old-doubao", {
      ok: true, loggedIn: true, creditPageReady: true, createPageReady: true,
      remainingCredits: null, totalCredits: null, nextRefresh: "2026-09-30T00:00:00+08:00",
      videosCreatedToday: 3, videoCountDate: "2026-09-29",
      referenceImageLimit: null, modelsObserved: ["Seedance 2.0 Fast"],
    });
    const account = store.getAccount("old-doubao");
    assert.equal(account.videosCreatedToday, 3);
    assert.equal(account.creditPageReady, true);
    assert.equal(account.createPageReady, true);
    assert.deepEqual(account.models, ["Seedance 2.0 Fast"]);
  } finally {
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
