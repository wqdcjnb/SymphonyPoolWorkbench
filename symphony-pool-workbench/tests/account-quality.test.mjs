import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createStore } from '../lib/db.mjs';
import { resolveVideoTarget } from '../lib/job-routing.mjs';
import { qualityTier } from '../public/js/account-quality.js';

const model = 'Seedance 2.0 Mini';
const request = { model, durationSeconds: 15, aspectRatio: '9:16', referenceAssets: [] };
const verified = { ok: true, loggedIn: true, modelsObserved: [model] };

test('legacy migration backfills completed videos and manual holds without changing jobs or credits', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-migration-')), source = path.join(root, 'old.sqlite');
  let store = await createStore(source);
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.ensureAccount({ id: 'legacy', label: 'legacy', loginType: 'doubao', service: 'doubao', workerId: 'test', profilePath: path.join(root, 'profile') });
  await store.saveVerification('legacy', verified);
  const job = await store.createDraftJob({ ...request, mode: 'image_to_video', prompt: 'test', idempotencyKey: 'legacy', accountId: 'legacy', priority: 50, enqueue: true });
  await store.claimNextQueuedJob(); await store.updateJob(job.id, { status: 'success' });
  await store.markAccountLoginRequired('legacy');
  const originalJob = await store.getJob(job.id);
  for (const column of ['reliability_score','video_success_count','execution_failure_count','auth_failure_count',
    'challenge_count','needs_attention','attention_reason','attention_since','attention_penalty']) {
    await store.database.exec(`ALTER TABLE accounts DROP COLUMN ${column}`);
  }
  await store.close(); store = await createStore(source);
  assert.deepEqual(await store.getJob(job.id), originalJob);
  const migrated = await store.getAccount('legacy');
  assert.equal(migrated.needsAttention, true); assert.equal(migrated.videoSuccessCount, 1);
  assert.equal(migrated.reliabilityScore, 84); assert.equal(migrated.creditsRemaining, 8);
  await store.saveVerification('legacy', verified);
  await store.markAccountLoginRequired('legacy');
  await store.close(); store = await createStore(source);
  assert.equal((await store.getAccount('legacy')).reliabilityScore, 64, 'migration must never reset existing history');
});

test('stable accounts outrank flaky high balances; within a tier high balance wins', () => {
  const account = { service: 'doubao', status: 'ready', models: [model], videoSuccessCount: 1 };
  const stable = { ...account, id: 'stable', reliabilityScore: 84, creditsRemaining: 6 };
  const flaky = { ...account, id: 'flaky', reliabilityScore: 40, creditsRemaining: 10 };
  assert.equal(resolveVideoTarget(request, [flaky, stable]).account.id, 'stable');
  assert.equal(resolveVideoTarget(request, [stable, { ...flaky, reliabilityScore: 80 }]).account.id, 'flaky');
  assert.equal(resolveVideoTarget(request, [{ ...stable, busy: true }, flaky]).account.id, 'flaky');
  assert.equal(resolveVideoTarget(request, [{ ...stable, creditsRemaining: 1 }, flaky]).account.id, 'flaky');
  assert.throws(() => resolveVideoTarget(request, [{ ...stable, needsAttention: true }]), /NO_ELIGIBLE_ACCOUNT/);
  assert.throws(() => resolveVideoTarget({ ...request, accountId: stable.id }, [{ ...stable, needsAttention: true }]), /ACCOUNT_NOT_READY/);
});

for (const backend of ['sqlite', 'postgres']) test(`${backend}: quality and manual hold survive recovery and restart; saturation queues`,
  { skip: backend === 'postgres' && !process.env.TEST_POSTGRES_URL }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-quality-'));
  const schema = 'quality_' + randomUUID().replaceAll('-', '');
  let source = path.join(root, 'db.sqlite'), admin, store;
  t.after(async () => {
    await store?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (backend === 'postgres') {
    admin = new pg.Client({ connectionString: process.env.TEST_POSTGRES_URL });
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_POSTGRES_URL); url.searchParams.set('options', `-csearch_path=${schema}`); source = url.href;
  }
  store = await createStore(source);
  for (const id of ['stable', 'flaky']) {
    await store.ensureAccount({ id, label: id, loginType: 'doubao', service: 'doubao', workerId: 'test', profilePath: path.join(root, id) });
    await store.saveVerification(id, verified);
  }
  const get = id => store.getAccount(id);
  for (let i = 0; i < 2; i++) {
    await store.markAccountLoginRequired('flaky');
    await store.saveVerification('flaky', { ok: false, loggedIn: false, error: 'LOGIN_REQUIRED' });
    assert.equal((await get('flaky')).authFailureCount, i + 1, 'one penalty per unresolved incident');
    await store.saveVerification('flaky', verified);
  }
  assert.equal((await get('flaky')).reliabilityScore, 40, 'verification must not erase reliability history');
  assert.equal((await get('flaky')).needsAttention, false);
  await store.markAccountLoginRequired('flaky', 'DOLA_HUMAN_VERIFICATION_REQUIRED');
  const held = await get('flaky');
  assert.equal(held.needsAttention, true); assert.equal(held.challengeCount, 1);
  await store.close(); store = await createStore(source);
  assert.equal((await get('flaky')).attentionReason, 'DOLA_HUMAN_VERIFICATION_REQUIRED');
  assert.equal((await get('flaky')).reliabilityScore, held.reliabilityScore);

  const queue = () => store.createDraftJob({ ...request, mode: 'image_to_video', prompt: 'test',
    idempotencyKey: randomUUID(), accountId: null, priority: 50, enqueue: true });
  const first = await queue(), second = await queue();
  const selected = await store.claimNextQueuedJob();
  assert.equal(selected.job.id, first.id); assert.equal(selected.account.id, 'stable');
  assert.equal(await store.claimNextQueuedJob(), null, 'busy plus manual hold keeps next task queued');
  assert.equal((await store.getJob(second.id)).status, 'queued');
  await store.updateJob(first.id, { status: 'success' });
  await store.saveVerification('stable', verified);
  assert.equal((await get('stable')).videoSuccessCount, 1);
  assert.equal((await get('stable')).reliabilityScore, 84);
  assert.equal((await store.claimNextQueuedJob()).job.id, second.id, 'capacity release starts the next task');
  await store.updateJob(second.id, { status: 'reconciling', errorCode: 'BROWSER_DISCONNECTED' });
  await store.updateJob(second.id, { status: 'reconciling', errorCode: 'BROWSER_DISCONNECTED' });
  assert.equal((await get('stable')).executionFailureCount, 1, 'reconciliation does not count a fault twice');
  assert.equal(qualityTier(await get('stable')), 1);
  await store.updateJob(second.id, { status: 'success' });
  await store.database.prepare("UPDATE jobs SET status='reconciling',collect_only=1 WHERE id=?").run(second.id);
  await store.updateJob(second.id, { status: 'success' });
  assert.equal((await get('stable')).videoSuccessCount, 2, 'collecting the same result does not add another success');
  await store.saveVerificationFailure('stable', 'VERIFIER_TIMEOUT');
  assert.equal((await get('stable')).needsAttention, true);
  const beforeAuth = (await get('stable')).reliabilityScore;
  await store.saveVerification('stable', { ok: false, error: 'LOGIN_REQUIRED' });
  assert.equal((await get('stable')).reliabilityScore, beforeAuth - 20, 'confirmed logout after an unknown failure counts once');
  await store.saveVerification('stable', verified);
  await store.saveVerification('flaky', verified);
  const creditJob = await queue();
  const claimed = await store.claimNextQueuedJob();
  const beforeBusy = await get(claimed.account.id);
  await store.handleDispatchFailure(creditJob.id, claimed.account.id, 'PROFILE_IN_USE', { beforeSubmission: true });
  assert.equal((await get(claimed.account.id)).reliabilityScore, beforeBusy.reliabilityScore, 'occupied browser is not an account fault');
});
