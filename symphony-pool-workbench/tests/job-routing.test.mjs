import assert from "node:assert/strict";
import test from "node:test";
import { resolveVideoTarget, hasCompatibleService } from "../lib/job-routing.mjs";

const accounts = [
  { id: "doubao-1", service: "doubao", status: "ready", models: ["Seedance 2.0 Fast", "Seedance 2.0 Mini"],
    creditsRemaining: 6, lastUsedAt: 200, busy: false },
  { id: "doubao-2", service: "doubao", status: "ready", models: ["Seedance 2.0 Mini"],
    creditsRemaining: 10, lastUsedAt: 0, busy: false },
  { id: "tiktok-1", service: "symphony", status: "ready", models: ["Video 1.5 Pro"],
    creditsRemaining: 395, lastUsedAt: 0, busy: false },
];

test("model and duration combinations restrict the platform", () => {
  assert.equal(hasCompatibleService("doubao", "Video 1.5 Pro", 5), false);
  assert.equal(hasCompatibleService("symphony", "Seedance 2.0 Fast", 5), false);
  assert.equal(hasCompatibleService(null, "Seedance 2.0 Mini", 12), false);
  assert.equal(hasCompatibleService(null, "auto", 12), true);
  assert.equal(hasCompatibleService(null, "auto", 10), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 5, 2), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 5, 4), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 5, 5), false);
  assert.equal(hasCompatibleService("doubao", "Seedance 2.0 Mini", 5, 9), true);
  assert.equal(hasCompatibleService("doubao", "Seedance 2.0 Mini", 5, 10), false);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 5, 1, "9:16"), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 12, 4, "9:16"), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 5, 1, "16:9"), false);
  assert.equal(hasCompatibleService("doubao", "Seedance 2.0 Mini", 5, 1, "9:16"), true);
  assert.equal(hasCompatibleService("doubao", "Seedance 2.0 Mini", 5, 2), true);
  assert.equal(hasCompatibleService("doubao", "Seedance 2.0 Mini", 5, 0, "16:9"), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 12, 0, "9:16"), true);
  assert.equal(hasCompatibleService("symphony", "Video 1.5 Pro", 5, 0, "16:9"), false);
});

test("automatic dispatch selects a ready account and writes its actual model", () => {
  const five = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 5 }, accounts);
  assert.equal(five.account.id, "doubao-2");
  assert.equal(five.model, "Seedance 2.0 Mini");

  const twelve = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 12 }, accounts);
  assert.equal(twelve.account.id, "tiktok-1");
  assert.equal(twelve.model, "Video 1.5 Pro");

  const pro = resolveVideoTarget({ accountId: null, model: "Video 1.5 Pro", durationSeconds: 5 }, accounts);
  assert.equal(pro.account.service, "symphony");

  const fast = resolveVideoTarget({ accountId: null, model: "Seedance 2.0 Fast", durationSeconds: 5 }, accounts);
  assert.equal(fast.account.id, "doubao-1");
  const multiple = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 5,
    referenceAssets: ["first.png", "second.png"] }, accounts);
  assert.equal(multiple.account.service, "doubao");
  const tiktokMulti = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 12,
    referenceAssets: ["first.png", "second.png"] }, accounts);
  assert.equal(tiktokMulti.account.service, "symphony");
  const fiveImages = Array.from({ length: 5 }, (_, index) => `image-${index}.png`);
  assert.equal(resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 5,
    referenceAssets: fiveImages }, accounts).account.service, "doubao");
  assert.throws(() => resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 12,
    referenceAssets: fiveImages }, accounts), /JOB_PARAMETERS_INVALID/);
  assert.equal(resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 5,
    aspectRatio: "16:9" }, accounts).account.service, "doubao");
  assert.equal(resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 12,
    aspectRatio: "9:16" }, accounts).account.service, "symphony");
  assert.equal(resolveVideoTarget({ accountId: null, model: "Video 1.5 Pro", durationSeconds: 12,
    aspectRatio: "9:16", referenceAssets: [] }, accounts).account.id, "tiktok-1");
});

test("Doubao uses its recorded estimate for priority, not a duration cost gate", () => {
  const candidates = accounts.map((account) => ({ ...account }));
  candidates[0].creditsRemaining = 8;
  candidates[0].lastUsedAt = 900;
  candidates[1].creditsRemaining = 2;
  candidates[1].lastUsedAt = 0;
  const preferred = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 5 }, candidates);
  assert.equal(preferred.account.id, "doubao-1");

  candidates[0].creditsRemaining = 0;
  const lowerEstimate = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 10 }, candidates);
  assert.equal(lowerEstimate.account.id, "doubao-2");
  candidates[1].creditsRemaining = 1;
  assert.equal(resolveVideoTarget({ accountId: "doubao-2", model: "auto", durationSeconds: 10 }, candidates)
    .account.id, "doubao-2");
});

test("automatic dispatch skips busy and platform-exhausted accounts", () => {
  const candidates = accounts.map((account) => ({ ...account }));
  candidates[0].busy = true;
  candidates[1].status = "cooling";
  candidates[1].creditsRemaining = 0;
  const ten = resolveVideoTarget({ accountId: null, model: "auto", durationSeconds: 10 }, candidates);
  assert.equal(ten.account.id, "tiktok-1");
  assert.throws(() => resolveVideoTarget({ accountId: "doubao-2", model: "auto", durationSeconds: 10 }, candidates),
    /ACCOUNT_NOT_READY/);
});

test("compatible Symphony accounts prefer the higher remaining balance", () => {
  const candidates = [accounts[2], { ...accounts[2], id: "tiktok-2",
    creditsRemaining: 400, lastUsedAt: 999 }];
  const selected = resolveVideoTarget({ accountId: null, model: "Video 1.5 Pro",
    durationSeconds: 12 }, candidates);
  assert.equal(selected.account.id, "tiktok-2");
});

test("reference video dispatch uses only Doubao Fast with zero to nine optional images", () => {
  const supports = (service, model, duration, images, ratio = "auto") =>
    hasCompatibleService(service, model, duration, images, ratio, "reference_to_video");
  assert.equal(supports("doubao", "auto", 5, 0), true);
  assert.equal(supports("doubao", "Seedance 2.0 Fast", 10, 9, "16:9"), true);
  assert.equal(supports("doubao", "Seedance 2.0 Mini", 5, 1), false);
  assert.equal(supports("symphony", "auto", 5, 1), false);
  assert.equal(supports(null, "Video 1.5 Pro", 5, 1), false);
  assert.equal(supports(null, "auto", 12, 1), false);
  assert.equal(supports(null, "auto", 5, 10), false);

  const job = { mode: "reference_to_video", accountId: null, model: "auto", durationSeconds: 5,
    referenceAssets: [], referenceVideo: "sample.mp4" };
  const selected = resolveVideoTarget(job, accounts);
  assert.equal(selected.account.id, "doubao-1");
  assert.equal(selected.model, "Seedance 2.0 Fast");
  assert.throws(() => resolveVideoTarget({ ...job, accountId: "tiktok-1" }, accounts), /JOB_PARAMETERS_INVALID/);
  assert.throws(() => resolveVideoTarget({ ...job, model: "Seedance 2.0 Mini" }, accounts), /JOB_PARAMETERS_INVALID/);
});
