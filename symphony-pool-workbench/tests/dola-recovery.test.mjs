import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createStore} from '../lib/db.mjs';
import {createAccountPool} from '../lib/account-pool.mjs';
import {createDolaRecovery} from '../lib/dola-recovery.mjs';

async function fixture(t, service='dola') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dola-recovery-'));
  const store=await createStore(path.join(root,'db.sqlite'));
  const pool=createAccountPool({store,workerId:'test',keyFile:path.join(root,'vault.key'),enforceWorker:false});
  await pool.start();
  t.after(async()=>{await pool.stop();await store.close();fs.rmSync(root,{recursive:true,force:true});});
  const model=service==='doubao'?'Seedance 2.0 Fast':'Dreamina Seedance 2.5';
  const account={id:service+'-test',label:'test',loginType:service,service,workerId:'test',profilePath:path.join(root,'profile')};
  await store.ensureAccount(account);
  const verified={ok:true,loggedIn:true,modelsObserved:[model]};
  await store.saveVerification(account.id,verified);
  const job=await store.createDraftJob({idempotencyKey:'challenge',accountId:account.id,mode:'image_to_video',model,
    durationSeconds:service==='doubao'?15:30,aspectRatio:'9:16',prompt:'a blue cube',negativePrompt:'letters',referenceAssets:[],priority:50,enqueue:true});
  const assignment=await store.claimNextQueuedJob({pool});
  const token=assignment.job.leaseToken;
  await store.updateJob(job.id,{status:'submitting',leaseToken:token});
  const challengeCode=service==='doubao'?'DOUBAO_HUMAN_VERIFICATION_REQUIRED':'DOLA_HUMAN_VERIFICATION_REQUIRED';
  await store.updateJob(job.id,{status:'reconciling',errorCode:challengeCode,leaseToken:token});
  await store.markAccountLoginRequired(account.id,challengeCode);
  await pool.handoffToManual(token);
  const sessions={enabled:true,sessions:new Map([[account.id,{token,endpoint:'http://127.0.0.1:45678'}]]),
    open:async()=>{},close:async a=>{sessions.sessions.delete(a.id);},handoff:()=>{}};
  const locks=new Set(),verificationLocks=new Set();
  let wakes=0,inspections=0,confirmations=0;
  const controls={observed:{ok:true,remoteUrl:`https://www.${service}.com/chat/123`,platformState:'ready'},verify:async()=>verified,
    confirm:async()=>({ok:true,remoteUrl:`https://www.${service}.com/chat/123`,platformState:'generating'})};
  const resume=createDolaRecovery({store,pool,sessions,locks,verificationLocks,
    inspect:async input=>{inspections++;assert.equal(input.job.prompt,job.prompt);assert.equal(input.service,service);return controls.observed;},
    confirm:async input=>{confirmations++;assert.equal((await store.getJob(job.id)).remoteUrl,input.job.remoteUrl);return controls.confirm(input);},
    verify:a=>controls.verify(a),wake:()=>wakes++});
  return {store,pool,job,account,sessions,resume,controls,locks,verificationLocks,get wakes(){return wakes;},get inspections(){return inspections;},get confirmations(){return confirmations;}};
}

test('recovery opens an inspectable browser after a completed login without replacing a retained challenge window',async t=>{
  const f=await fixture(t,'doubao');
  let opened;
  f.sessions.open=async(account,options)=>{opened=options;};
  f.controls.observed={ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND'};
  await assert.rejects(f.resume(f.job.id),/DOUBAO_EXISTING_TASK_NOT_FOUND/);
  assert.equal(opened.manual,true);assert.equal(opened.interactiveOnly,false);
  f.sessions.sessions.get(f.account.id).manualBrowser=true;
  await assert.rejects(f.resume(f.job.id),/DOUBAO_EXISTING_TASK_NOT_FOUND/);
  assert.equal(opened.manual,false);assert.equal(opened.interactiveOnly,false);
});

test('pending confirmation binds the original conversation before confirming and queues collection',async t=>{
  const f=await fixture(t,'doubao');
  f.controls.observed.platformState='confirmation';
  const result=await f.resume(f.job.id);
  assert.equal(result.job.id,f.job.id);assert.equal(result.job.collectOnly,1);
  assert.equal(f.confirmations,1);assert.equal(f.wakes,1);
  assert.equal(await f.store.beginTaskConfirmation(f.job.id).catch(e=>e.message),'JOB_NOT_RECONCILABLE');
});

test('an account viewer lease can resume its own task without reporting another running job',async t=>{
  for (const service of ['doubao','dola']) {
    const f=await fixture(t,service);
    await f.store.database.prepare("UPDATE account_leases SET purpose='view' WHERE account_id=?").run(f.account.id);
    await assert.rejects(f.store.attachRemoteTask(f.job.id,`https://www.${service}.com/chat/123`,'201','wrong-token'),/ACCOUNT_ALREADY_RUNNING/);
    if(service==='doubao')f.controls.observed.platformState='confirmation';
    f.controls.observed.remoteMessageId='201';
    const result=await f.resume(f.job.id);
    assert.equal(result.job.id,f.job.id);assert.equal(result.job.collectOnly,1);
    assert.equal(result.job.remoteMessageId,'201');
    assert.equal(f.confirmations,service==='doubao'?1:0);
  }
});

test('a running generation lease is never accepted as a viewer recovery lease',async t=>{
  const f=await fixture(t,'doubao');
  const token=f.sessions.sessions.get(f.account.id).token;
  await f.store.database.prepare("UPDATE account_leases SET purpose='job' WHERE account_id=?").run(f.account.id);
  await assert.rejects(f.store.attachRemoteTask(f.job.id,'https://www.doubao.com/chat/123','201',token),/ACCOUNT_ALREADY_RUNNING/);
});

test('a resolved challenge does not remain displayed after the original page is lost',async t=>{
  const f=await fixture(t);
  f.controls.observed={ok:false,error:'TASK_ORIGINAL_PAGE_LOST'};
  await assert.rejects(f.resume(f.job.id),/TASK_ORIGINAL_PAGE_LOST/);
  const job=await f.store.getJob(f.job.id);
  assert.equal(job.errorCode,'TASK_ORIGINAL_PAGE_LOST');
  assert.equal(job.progress.phase,'original_conversation_missing');
  assert.equal(f.confirmations,0);assert.equal(f.wakes,0);
});

test('a timed out confirmation is never submitted twice and can later be collected',async t=>{
  const f=await fixture(t,'doubao');
  f.controls.observed.platformState='confirmation';
  f.controls.confirm=async()=>({ok:false,error:'DOUBAO_HUMAN_VERIFICATION_REQUIRED'});
  await assert.rejects(f.resume(f.job.id),/DOUBAO_HUMAN_VERIFICATION_REQUIRED/);
  assert.equal((await f.store.getJob(f.job.id)).errorCode,'DOUBAO_HUMAN_VERIFICATION_REQUIRED');
  await assert.rejects(f.resume(f.job.id),/DOUBAO_CONFIRMATION_UNCONFIRMED/);
  assert.equal(f.confirmations,1);assert.equal(f.wakes,0);
  assert.equal((await f.store.getJob(f.job.id)).remoteUrl,'https://www.doubao.com/chat/123');
  f.controls.observed.platformState='generating';
  assert.equal((await f.resume(f.job.id)).job.collectOnly,1);
  assert.equal(f.confirmations,1);assert.equal(f.wakes,1);
});

test('human verification recovery binds observed URL, releases manual ownership, and queues collection only once',async t=>{
  const f=await fixture(t);
  assert.equal((await f.store.pendingDolaJobsForAccount(f.account.id)).length,1);
  const result=await f.resume(f.job.id);
  assert.equal(result.job.status,'queued');assert.equal(result.job.collectOnly,1);
  assert.equal(result.job.remoteUrl,'https://www.dola.com/chat/123');
  assert.equal((await f.pool.snapshot()).leases.length,0);
  assert.equal((await f.store.getAccount(f.account.id)).status,'ready');
  assert.equal((await f.resume(f.job.id)).alreadyResumed,true);
  assert.equal(f.wakes,1);assert.equal(f.inspections,1);
  assert.equal((await f.store.listJobs()).length,1);
  assert.equal((await f.store.pendingDolaJobsForAccount(f.account.id)).length,0);
});

test('a matched original conversation confirms the session without opening an account verification page',async t=>{
  const f=await fixture(t,'doubao');
  const before=await f.store.getAccount(f.account.id);
  f.controls.observed.sameConversation=true;
  f.controls.verify=async()=>{throw new Error('MUST_NOT_NAVIGATE_TO_VERIFICATION');};
  const result=await f.resume(f.job.id);
  const after=await f.store.getAccount(f.account.id);
  assert.equal(result.job.collectOnly,1);assert.equal(result.job.id,f.job.id);
  assert.equal(after.status,'ready');assert.deepEqual(after.models,before.models);
  assert.equal(after.creditsRemaining,before.creditsRemaining);assert.equal(f.wakes,1);
  assert.equal((await f.store.listEvents()).filter(e=>e.eventType==='account.session_confirmed').length,1);
});

test('Doubao verification resumes the same job in collection mode and rejects Dola URLs',async t=>{
  const f=await fixture(t,'doubao');
  assert.equal((await f.store.pendingDolaJobsForAccount(f.account.id)).length,1);
  f.controls.observed.remoteUrl='https://www.dola.com/chat/123';
  await assert.rejects(f.resume(f.job.id),/DOLA_TASK_MISMATCH/);
  f.controls.observed.remoteUrl='https://www.doubao.com/chat/123';
  const result=await f.resume(f.job.id);
  assert.equal(result.job.id,f.job.id);assert.equal(result.job.collectOnly,1);
  assert.equal(result.job.remoteUrl,'https://www.doubao.com/chat/123');
  assert.equal((await f.resume(f.job.id)).alreadyResumed,true);
  assert.equal(f.wakes,1);assert.equal((await f.store.listJobs()).length,1);
});

test('challenge, mismatch, and ambiguous observations keep the original task and browser for the operator',async t=>{
  const f=await fixture(t);
  for (const error of ['DOLA_HUMAN_VERIFICATION_REQUIRED','DOLA_EXISTING_TASK_NOT_FOUND','DOLA_TASK_AMBIGUOUS']) {
    f.controls.observed={ok:false,error};
    await assert.rejects(f.resume(f.job.id),new RegExp(error));
    const job=await f.store.getJob(f.job.id);
    assert.equal(job.status,'reconciling');assert.equal(job.remoteUrl,null);
    assert.equal(f.sessions.sessions.has(f.account.id),true);
    assert.equal((await f.pool.snapshot()).leases[0].purpose,'manual');
    assert.equal(f.locks.size,0);assert.equal(f.verificationLocks.size,0);assert.equal(f.wakes,0);
  }
  f.controls.observed={ok:true,remoteUrl:'https://evil.invalid/chat/123',platformState:'ready'};
  await assert.rejects(f.resume(f.job.id),/DOLA_TASK_MISMATCH/);
});

test('verification failure is recoverable without another generation or losing the observed URL',async t=>{
  const f=await fixture(t);
  f.controls.verify=async()=>{throw new Error('DOLA_PAGE_TIMEOUT');};
  await assert.rejects(f.resume(f.job.id),/DOLA_PAGE_TIMEOUT/);
  assert.equal((await f.store.getJob(f.job.id)).remoteUrl,'https://www.dola.com/chat/123');
  assert.equal((await f.store.getJob(f.job.id)).status,'reconciling');
  assert.equal(f.sessions.sessions.has(f.account.id),true);
  assert.equal(f.wakes,0);
  f.controls.verify=async()=>({ok:true,loggedIn:true,modelsObserved:[f.job.model]});
  assert.equal((await f.resume(f.job.id)).job.collectOnly,1);
});

test('concurrent recovery clicks cannot take over the same account or enqueue twice',async t=>{
  const f=await fixture(t);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.controls.verify=async()=>{await gate;return {ok:true,loggedIn:true,modelsObserved:[f.job.model]};};
  const first=f.resume(f.job.id);
  while(!f.verificationLocks.size)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(f.resume(f.job.id),/ACCOUNT_PROFILE_IN_USE/);
  release();await first;
  assert.equal(f.wakes,1);assert.equal((await f.store.listJobs()).length,1);
});

test('same-tick clicks are serialized before the asynchronous occupancy check',async t=>{
  const f=await fixture(t);
  const results=await Promise.allSettled([f.resume(f.job.id),f.resume(f.job.id)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/ACCOUNT_PROFILE_IN_USE/);
  assert.equal(f.inspections,1);assert.equal(f.wakes,1);assert.equal(f.locks.size,0);
});

test('an observed platform rejection ends the original job without queuing another generation',async t=>{
  const f=await fixture(t);
  f.controls.observed.platformState='failed';
  const result=await f.resume(f.job.id);
  assert.equal(result.job.status,'failed');
  assert.equal(result.job.errorCode,'PLATFORM_GENERATION_FAILED');
  assert.equal(result.platformState,'failed');
  assert.equal(f.wakes,0);
  assert.equal((await f.pool.snapshot()).leases.length,0);
  assert.equal((await f.store.listJobs()).length,1);
});

test('verified missing Doubao submission requeues the same job and account once without charging again',async t=>{
  const f=await fixture(t,'doubao');
  f.controls.observed={ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND',historyChecked:true};
  const before=await f.store.getJob(f.job.id);
  assert.equal(before.creditState,'charged');
  const result=await f.resume(f.job.id);
  assert.equal(result.resubmitted,true);assert.equal(result.job.id,before.id);
  assert.equal(result.job.status,'queued');assert.equal(result.job.collectOnly,0);
  assert.equal(result.job.requestedAccountId,f.account.id);
  assert.equal(result.job.requestedModel,before.model);
  for(const field of ['idempotencyKey','batchId','accountId','creditCost','creditState','creditDate'])assert.equal(result.job[field],before[field],field);
  assert.equal((await f.pool.snapshot()).leases.length,0);
  assert.equal((await f.resume(f.job.id)).alreadyResumed,true);
  assert.equal(f.inspections,1);assert.equal(f.wakes,1);
  const assignment=await f.store.claimNextQueuedJob({pool:f.pool});
  assert.equal(assignment.job.id,before.id);
  await f.store.updateJob(before.id,{status:'submitting',leaseToken:assignment.job.leaseToken});
  const after=await f.store.getJob(before.id);
  for(const field of ['creditCost','creditState','creditDate'])assert.equal(after[field],before[field],field);
  assert.equal((await f.resume(f.job.id)).alreadyResumed,true);
  assert.equal((await f.store.listJobs()).length,1);
  assert.equal((await f.store.listEvents()).filter(e=>e.eventType==='job.verification_resubmitted').length,1);
});

test('another CAPTCHA after the one-shot resubmission cannot repeatedly generate',async t=>{
  const f=await fixture(t,'doubao');
  f.controls.observed={ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND',historyChecked:true};
  await f.resume(f.job.id);
  const assignment=await f.store.claimNextQueuedJob({pool:f.pool});
  const token=assignment.job.leaseToken;
  await f.store.updateJob(f.job.id,{status:'reconciling',errorCode:'DOUBAO_HUMAN_VERIFICATION_REQUIRED',leaseToken:token});
  await f.pool.handoffToManual(token);
  f.sessions.sessions.set(f.account.id,{token,endpoint:'http://127.0.0.1:45678'});
  await assert.rejects(f.resume(f.job.id),/DOUBAO_VERIFICATION_RETRY_USED/);
  assert.equal(f.wakes,1);assert.equal((await f.store.listJobs()).length,1);
  assert.equal((await f.store.getJob(f.job.id)).errorCode,'DOUBAO_VERIFIED_TASK_NOT_FOUND');
  assert.equal((await f.store.getAccount(f.account.id)).status,'ready');
  assert.equal(f.sessions.sessions.has(f.account.id),true);
});

test('history inspection without a conclusive result never permits resubmission',async t=>{
  const f=await fixture(t,'doubao');
  for(const observed of [
    {ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND'},
    {ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND',historyChecked:false},
    {ok:false,error:'DOUBAO_SUBMISSION_UNCONFIRMED'},
    {ok:false,error:'DOUBAO_TASK_AMBIGUOUS'},
    {ok:false,error:'DOUBAO_HUMAN_VERIFICATION_REQUIRED'}
  ]){
    f.controls.observed=observed;
    await assert.rejects(f.resume(f.job.id),new RegExp(observed.error));
  }
  assert.equal(f.wakes,0);assert.equal(await f.store.hasVerificationResubmission(f.job.id),false);
});

test('a matching prompt with an unknown response is bound and never resubmitted',async t=>{
  const f=await fixture(t,'doubao');
  f.controls.observed.platformState='pending';
  const result=await f.resume(f.job.id);
  assert.equal(result.platformState,'pending');assert.equal(result.job.status,'reconciling');
  assert.equal(result.job.remoteUrl,'https://www.doubao.com/chat/123');
  assert.equal(result.job.errorCode,'DOUBAO_RESPONSE_PENDING');assert.equal(f.wakes,0);
  assert.equal(f.sessions.sessions.has(f.account.id),true);
  f.controls.observed={ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND',historyChecked:true};
  await assert.rejects(f.resume(f.job.id),/DOUBAO_EXISTING_TASK_NOT_FOUND/);
  assert.equal(await f.store.hasVerificationResubmission(f.job.id),false);
});

test('failed login verification cannot requeue an absent submission',async t=>{
  const f=await fixture(t,'doubao');
  f.controls.observed={ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND',historyChecked:true};
  f.controls.verify=async()=>({ok:false,loggedIn:false,error:'LOGIN_REQUIRED'});
  await assert.rejects(f.resume(f.job.id),/LOGIN_REQUIRED/);
  assert.equal(f.wakes,0);assert.equal(await f.store.hasVerificationResubmission(f.job.id),false);
  assert.equal(f.sessions.sessions.has(f.account.id),true);
});

test('a previously accepted submission cannot be resubmitted even when history is missing',async t=>{
  const f=await fixture(t,'doubao');
  await f.pool.release(f.sessions.sessions.get(f.account.id).token);
  await f.store.updateJob(f.job.id,{status:'submitted'});
  await f.store.updateJob(f.job.id,{status:'reconciling',errorCode:'DOUBAO_HUMAN_VERIFICATION_REQUIRED'});
  f.sessions.sessions.clear();
  f.controls.observed={ok:false,error:'DOUBAO_EXISTING_TASK_NOT_FOUND',historyChecked:true};
  await assert.rejects(f.resume(f.job.id),/DOUBAO_EXISTING_TASK_NOT_FOUND/);
  await assert.rejects(f.store.resubmitAfterVerification(f.job.id),/JOB_NOT_RECONCILABLE/);
  assert.equal(f.wakes,0);
});
