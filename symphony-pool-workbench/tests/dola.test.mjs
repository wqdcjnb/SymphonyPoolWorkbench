import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createWorkbenchServer } from '../server.mjs';
import { createStore } from '../lib/db.mjs';
import { createAccountPool } from '../lib/account-pool.mjs';
import { hasCompatibleService, resolveVideoTarget } from '../lib/job-routing.mjs';

const model = 'Dreamina Seedance 2.5';
const account = { id: 'dola-test', label: 'Dola test', loginType: 'dola', service: 'dola', workerId: 'test', status: 'ready', models: [model], creditsRemaining: 10 };
test('Dola dispatch stays on its platform and accepts verified 30-second parameters within daily credits', () => {
  assert.equal(resolveVideoTarget({ model, durationSeconds: 30, aspectRatio: '16:9', referenceAssets: [] }, [account]).account.id, account.id);
  assert.equal(hasCompatibleService('dola', model, 30, 0, '9:16'), true);
  assert.equal(hasCompatibleService('dola', model, 30, 9, '9:16'), true);
  assert.equal(hasCompatibleService('dola', model, 30, 9, '16:9'), true);
  assert.equal(hasCompatibleService('dola', model, 30, 10, '16:9'), false);
  assert.equal(hasCompatibleService('dola', model, 12, 1), false);
  assert.equal(hasCompatibleService('dola', model, 5, 10), false);
  assert.equal(hasCompatibleService('dola', 'Seedance 2.0 Fast', 5, 1), false);
  assert.equal(hasCompatibleService('dola', model, 5, 1, '9:16', 'reference_to_video'), false);
  assert.throws(() => resolveVideoTarget({ model, durationSeconds: 30 }, [{ ...account, status: 'cooling' }]), /NO_ELIGIBLE_ACCOUNT/);
});

test('Dola quota exhaustion pauses the account until the next daily reset without resubmitting its explicit task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dola-quota-'));
  const store = await createStore(path.join(root, 'test.sqlite'));
  try {
    await store.ensureAccount({ ...account, profilePath: path.join(root, 'profile') });
    await store.saveVerification(account.id, { ok: true, loggedIn: true, modelsObserved: [model] });
    const job = await store.createDraftJob({ idempotencyKey: 'quota', accountId: account.id, mode: 'image_to_video', model,
      durationSeconds: 30, aspectRatio: '9:16', prompt: 'test', referenceAssets: [], priority: 50, enqueue: true });
    await store.claimNextQueuedJob();
    await store.handleDispatchFailure(job.id, account.id, 'DOLA_QUOTA_EXHAUSTED', { quotaExhausted: true });
    const saved = await store.getAccount(account.id);
    assert.equal(saved.status, 'cooling');
    assert.equal(saved.lastErrorCode, 'DOLA_QUOTA_EXHAUSTED');
    assert.equal(saved.quotaExhaustedDate, new Date(Date.now()+8*3600000).toISOString().slice(0,10));
    assert.equal(saved.creditsRemaining,0);
    assert.ok(Date.parse(saved.creditsResetAt)>Date.now());
    assert.equal((await store.getJob(job.id)).status, 'failed');
    assert.equal(await store.claimNextQueuedJob(), null);
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Dola runs through the HTTP job queue, stores its task URL, and serves seekable preview and download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dola-http-'));
  const images = ['first.png', 'second.png'].map(name => path.join(root, name));
  for (const image of images) fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=', 'base64'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const workerPath = path.join(root, 'worker.mjs');
  fs.writeFileSync(workerPath, `import fs from 'node:fs';import path from 'node:path';
    let input='';for await(const chunk of process.stdin)input+=chunk;const job=JSON.parse(input);
    if(job.service!=='dola')throw new Error('wrong platform');
    if(job.referenceAssets.length!==2 || path.basename(job.referenceAssets[0])!=='first.png' || path.basename(job.referenceAssets[1])!=='second.png')throw new Error('reference order lost');
    console.log(JSON.stringify({stage:'submitting'}));
    console.log(JSON.stringify({stage:'submitted',remoteUrl:'https://www.dola.com/chat/123456?tracking=discard'}));
    fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});fs.writeFileSync(job.outputPath,'0123456789abcdef');
    console.log(JSON.stringify({stage:'success',resultPath:job.outputPath}));`);
  const app = await createWorkbenchServer({ port, workspaceRoot: root, databasePath: path.join(root, 'test.sqlite'),
    seedAccount: false, pythonExecutable: process.execPath, workerPath, generatedRoot: path.join(root, 'generated'),
    schedulerIntervalMs: 25, verifyAccount: async () => ({ ok: true, loggedIn: true, modelsObserved: [model] }) });
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await app.listen();
    const created = await post('/api/accounts', { accountId: account.id, label: account.label, loginType: 'dola', workerId: 'test' });
    assert.equal(created.status, 201);
    await app.store.saveVerification(account.id, { ok: true, loggedIn: true, modelsObserved: [model] });
    const draft = await post('/api/jobs', { accountId: account.id, model, mode: 'image_to_video', durationSeconds: 30, aspectRatio: '16:9', prompt: 'test', referenceAssets: images });
    assert.equal(draft.status, 201);
    const id = draft.body.job.id;
    assert.equal((await post(`/api/jobs/${id}/start`, {})).status, 202);
    for (let i = 0; i < 100 && (await app.store.getJob(id)).status !== 'success'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const job = await app.store.getJob(id);
    assert.equal(job.status, 'success');
    assert.deepEqual(job.referenceAssets, images);
    assert.equal(job.creditCost, 4);
    assert.equal((await app.store.getAccount(account.id)).creditsRemaining, 6);
    assert.equal(job.remoteUrl, 'https://www.dola.com/chat/123456');
    const listing = await fetch(`http://127.0.0.1:${port}/api/workbench/jobs?status=all&page=1&pageSize=6`);
    assert.equal(listing.status, 200);
    const url = `http://127.0.0.1:${port}/api/jobs/${id}/result`;
    // Legacy browser conversions have no repair proof and must not be served
    // through either default download or preview, including HEAD requests.
    assert.equal((await fetch(url)).status, 409);
    assert.equal((await fetch(url+'?preview=1', {method:'HEAD'})).status, 409);
    const output = path.join(root, 'generated', `${id}.mp4`);
    const original = path.join(root, 'generated', `${id}.original.mp4`);
    fs.writeFileSync(original, 'original watermark fixture');
    assert.equal(await (await fetch(url+'?original=1')).text(), 'original watermark fixture');
    const receipt = { version:3, source:'dola_postprocessed', delivery_mode:'watermark_repair',
      watermark_free:null, postprocessed:true, source_sha256:'a'.repeat(64),
      sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex'), size_bytes:16,
      processing:{method:'opencv_temporal_inpaint',preset:'dola-tracked-glyph-v1',template_sha256:'b'.repeat(64)} };
    fs.writeFileSync(output+'.delivery.json', JSON.stringify(receipt));
    const preview = await fetch(url + '?preview=1', { headers: { Range: 'bytes=4-7' } });
    assert.equal(preview.status, 206);
    assert.equal(preview.headers.get('content-range'), 'bytes 4-7/16');
    assert.match(preview.headers.get('content-disposition'), /^inline;/);
    assert.equal(await preview.text(), '4567');
    const tail = await fetch(url, { headers: { Range: 'bytes=-4' } });
    assert.equal(await tail.text(), 'cdef');
    for (const range of ['bytes=20-', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=9-2']) {
      assert.equal((await fetch(url, { headers: { Range: range } })).status, 416);
    }
    const download = await fetch(url);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await download.text(), '0123456789abcdef');
    fs.appendFileSync(output, 'tampered');
    assert.equal((await fetch(url)).status, 409);
    assert.equal((await fetch(url+'?preview=1',{method:'HEAD'})).status, 409);
    assert.equal((await post(`/api/jobs/${id}/start`, {})).status, 409);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('human verification keeps exclusive manual ownership and binds a task only once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dola-handoff-'));
  const store = await createStore(path.join(root, 'test.sqlite'));
  const pool = createAccountPool({ store, workerId: 'test', keyFile: path.join(root, 'vault.key'), enforceWorker: false });
  try {
    await pool.start();
    await store.ensureAccount({ ...account, profilePath: path.join(root, 'profile') });
    await store.saveVerification(account.id, { ok: true, loggedIn: true, modelsObserved: [model] });
    const job = await store.createDraftJob({ idempotencyKey: 'challenge', accountId: account.id, mode: 'image_to_video', model,
      durationSeconds: 30, aspectRatio: '9:16', prompt: 'test', referenceAssets: [], priority: 50, enqueue: true });
    const assignment = await store.claimNextQueuedJob({ pool });
    const token = assignment.job.leaseToken;
    await assert.rejects(store.attachRemoteTask(job.id, 'https://www.dola.com/chat/789'), /JOB_NOT_RECONCILABLE/);
    await store.updateJob(job.id, { status: 'reconciling', errorCode: 'DOLA_HUMAN_VERIFICATION_REQUIRED', leaseToken: token });
    await assert.rejects(store.attachRemoteTask(job.id, 'https://www.dola.com/chat/789'), /ACCOUNT_ALREADY_RUNNING/);
    await pool.handoffToManual(token);
    const snapshot = await pool.snapshot();
    assert.equal(snapshot.leases[0].purpose, 'manual');
    assert.equal(snapshot.leases[0].jobId, null);
    assert.equal((await store.getJob(job.id)).leaseToken, null);
    assert.equal(await pool.reserve(account, 'job', job.id), null);
    assert.equal((await store.attachRemoteTask(job.id, 'https://www.dola.com/chat/789')).status, 'reconciling');
    await assert.rejects(store.attachRemoteTask(job.id, 'https://www.dola.com/chat/790'), /JOB_NOT_RECONCILABLE/);
    await pool.release(token);
  } finally { await pool.stop(); await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
