import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {createStore} from '../lib/db.mjs';
import {openDatabase} from '../lib/database.mjs';
import {reserveDolaConversationRetry, RETRY_EVENT} from '../scripts/dola-new-conversation.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dola-new-chat-'));
  const databasePath = path.join(root, 'db.sqlite');
  const store = await createStore(databasePath);
  const db = await openDatabase(databasePath);
  t.after(async () => {
    await db.close(); await store.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'dola-new-chat-'));
    fs.rmSync(root, {recursive:true,force:true});
  });
  await store.ensureAccount({id:'dola', label:'Dola', loginType:'dola',service:'dola',workerId:'test',profilePath:path.join(root,'profile')});
  await store.saveVerification('dola',{ok:true,loggedIn:true,modelsObserved:['Dreamina Seedance 2.5']});
  const job = await store.createDraftJob({idempotencyKey:'original-api-request',accountId:'dola',mode:'image_to_video',
    model:'Dreamina Seedance 2.5',durationSeconds:30,aspectRatio:'9:16',prompt:'six people with original food',
    negativePrompt:'letters',referenceAssets:['original.png'],priority:50});
  await store.updateJob(job.id,{status:'submitting'});
  await store.updateJob(job.id,{status:'submitted',remoteUrl:'https://www.dola.com/chat/123',remoteMessageId:'101'});
  const token = 'test-private-lease-value';
  await db.prepare('UPDATE jobs SET lease_token=? WHERE id=?').run(token,job.id);
  await db.prepare('INSERT INTO account_leases(account_id,worker_id,owner,token,purpose,job_id,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run('dola','test','test',token,'job',job.id,Date.now()+60000);
  return {db,store,databasePath,input:{id:job.id,accountId:'dola',leaseToken:token,
    remoteUrl:'https://www.dola.com/chat/123',remoteMessageId:'101',reason:'DOLA_PARAMETER_CONFIRMATION'}};
}

test('one fresh conversation preserves task identity, original specs and charged credits', async t => {
  const {db,store,input} = await fixture(t);
  const before = await store.getJob(input.id);
  assert.deepEqual(await reserveDolaConversationRetry(db,input),{ok:true});
  const after = await store.getJob(input.id);
  for (const field of ['id','idempotencyKey','accountId','model','durationSeconds','aspectRatio','prompt','negativePrompt',
    'referenceAssets','creditState','creditCost','creditDate','leaseToken']) assert.deepEqual(after[field],before[field],field);
  assert.equal(after.status,'submitting');assert.equal(after.remoteUrl,null);assert.equal(after.remoteMessageId,null);
  assert.equal(after.submittedAt,null);
  const event = await db.prepare('SELECT details_json FROM events WHERE job_id=? AND event_type=?').get(input.id,RETRY_EVENT);
  assert.equal(JSON.parse(event.details_json).previousRemoteMessageId,'101');
  await store.updateJob(input.id,{leaseToken:input.leaseToken,status:'submitted',remoteUrl:'https://www.dola.com/chat/456',remoteMessageId:'201'});
  await assert.rejects(reserveDolaConversationRetry(db,{...input,remoteUrl:'https://www.dola.com/chat/456',remoteMessageId:'201'}),/RETRY_USED/);
  assert.equal((await store.getJob(input.id)).remoteMessageId,'201');
});

test('stale leases and a different conversation cannot authorize a retry', async t => {
  const {db,store,input} = await fixture(t);
  for (const change of [{leaseToken:null},{leaseToken:'different'}, {accountId:'other'}, {remoteMessageId:'102'},
    {remoteUrl:'https://www.dola.com/chat/456'}, {reason:'BROWSER_AUTOMATION_FAILED'}]) {
    await assert.rejects(reserveDolaConversationRetry(db,{...input,...change}),/RETRY_UNSAFE|STALE_JOB_LEASE/);
  }
  await db.prepare('UPDATE account_leases SET expires_at=?').run(Date.now()-1);
  await assert.rejects(reserveDolaConversationRetry(db,input),/STALE_JOB_LEASE/);
  assert.equal((await store.getJob(input.id)).remoteMessageId,'101');
});

test('generation evidence, collection, cancellation and a prior user retry all prevent another submission', async t => {
  for (const change of ["collect_only=1", "cancel_requested=1", "last_observed_stage='generating'", "result_path='video.mp4'"]) {
    await t.test(change,async child=>{
      const {db,input} = await fixture(child);
      await db.exec('UPDATE jobs SET '+change);
      await assert.rejects(reserveDolaConversationRetry(db,input),/RETRY_UNSAFE/);
    });
  }
  for (const event of ['job.generating','job.collecting','job.success','job.conversation_restarted','job.user_new_conversation_20261008_01']) {
    await t.test(event,async child=>{
      const {db,input} = await fixture(child);
      await db.prepare('INSERT INTO events(id,account_id,job_id,event_type,message,details_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run('evidence','dola',input.id,event,'previous evidence','{}',Date.now());
      await assert.rejects(reserveDolaConversationRetry(db,input),/RETRY_USED/);
    });
  }
});

test('private CLI works with the existing worker environment and does not output lease credentials', async t => {
  const {store,databasePath,input} = await fixture(t);
  const result = spawnSync(process.execPath,['scripts/dola-new-conversation.mjs'],{
    cwd:path.resolve(import.meta.dirname,'..'),input:JSON.stringify(input),encoding:'utf8',
    env:{...process.env,WORKBENCH_DATABASE_SOURCE:databasePath},timeout:15000});
  assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{ok:true});
  assert.ok(!result.stdout.includes(input.leaseToken));assert.ok(!result.stderr.includes(input.leaseToken));
  assert.equal((await store.getJob(input.id)).status,'submitting');
});
