import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/db.mjs';
import { creditDay, nextCreditReset } from '../lib/daily-credits.mjs';

test('credit reset uses the Beijing calendar boundary', () => {
  assert.equal(creditDay(Date.parse('2026-10-05T15:59:59Z')), '2026-10-05');
  assert.equal(creditDay(Date.parse('2026-10-05T16:00:00Z')), '2026-10-06');
  assert.equal(nextCreditReset(Date.parse('2026-10-05T15:59:59Z')), '2026-10-05T16:00:00.000Z');
});

for (const [service, model, duration, cost] of [
  ['doubao', 'Seedance 2.0 Mini', 15, 2], ['dola', 'Dreamina Seedance 2.5', 30, 4],
]) test(`${service}: reservations, refunds, daily limit, verification, restart and collection`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-credit-'));
  const file = path.join(root, 'db.sqlite');
  let store = await createStore(file);
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.ensureAccount({ id: service, label: service, service, loginType: service, workerId: 'test', profilePath: path.join(root, 'profile') });
  const verify = () => store.saveVerification(service, { ok: true, loggedIn: true, modelsObserved: [model], remainingCredits: null });
  await verify();
  const balance = async () => (await store.getAccount(service)).creditsRemaining;
  assert.equal(await balance(), 10);
  let sequence = 0;
  const queue = () => store.createDraftJob({ idempotencyKey: 'credit-' + sequence++, accountId: service, model,
    mode: 'image_to_video', durationSeconds: duration, aspectRatio: '9:16', prompt: 'test', priority: 50, referenceAssets: [], enqueue: true });

  const beforeSubmit = await queue();
  await store.claimNextQueuedJob();
  assert.equal(await balance(), 10 - cost);
  assert.equal((await store.getAccount(service)).creditsReserved, cost);
  await store.handleDispatchFailure(beforeSubmit.id, service, 'PROFILE_IN_USE', { beforeSubmission: true });
  assert.equal(await balance(), 10);
  await store.cancelJob(beforeSubmit.id);

  let successful;
  for (let n = 1; n <= 2; n++) {
    const draft = await queue();
    const claimed = await store.claimNextQueuedJob();
    assert.equal(claimed.job.id, draft.id);
    await store.updateJob(draft.id, { status: 'submitting' });
    await store.updateJob(draft.id, { status: 'submitted', remoteUrl: `https://www.${service}.com/chat/123456` });
    await store.updateJob(draft.id, { status: 'generating' });
    await store.updateJob(draft.id, { status: 'success' });
    successful = draft.id;
    await verify();
    assert.equal(await balance(), 10 - n * cost, 'verification and progress must not reset or double-charge');
    assert.equal((await store.getAccount(service)).freeVideosRemaining,2-n);
  }
  const waiting = await queue();
  assert.equal(await store.claimNextQueuedJob(), null, 'no overspending');
  assert.equal((await store.getJob(waiting.id)).status, 'queued');
  await store.close(); store = await createStore(file);
  assert.equal(await balance(), 10-2*cost, 'legacy ledger survives restart');
  assert.equal((await store.getAccount(service)).freeVideosRemaining,0);
  await store.database.prepare("UPDATE jobs SET status='reconciling',collect_only=1 WHERE id=?").run(successful);
  await store.updateJob(successful, { status: 'collecting' });
  await store.updateJob(successful, { status: 'success' });
  assert.equal(await balance(), 10-2*cost, 'collection does not charge again');
  assert.equal((await store.getAccount(service)).freeVideosRemaining,0);

  await store.database.prepare("UPDATE jobs SET credit_date='2020-01-01' WHERE credit_state='charged'").run();
  assert.equal(await balance(), 10, 'a new Beijing day resets the budget');
  await verify();
  assert.equal((await store.claimNextQueuedJob()).job.id, waiting.id);
  await store.updateJob(waiting.id, { status: 'submitting' });
  await store.updateJob(waiting.id, { status: 'failed', errorCode: 'UNKNOWN_AFTER_SUBMIT' });
  assert.equal(await balance(), 10 - cost, 'an uncertain submitted generation remains charged');
});
