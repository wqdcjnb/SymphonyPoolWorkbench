import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
