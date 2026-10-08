import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { jobProgress, partnerProgress } from '../public/js/job-progress.js';
import { createStore } from '../lib/db.mjs';
import { reconciliationPlan } from '../lib/long-task.mjs';

test('accepted generation remains normal waiting beyond 70 minutes and 24 hours',()=>{
  const job={status:'reconciling',lastObservedStage:'generating',remoteUrl:'https://www.dola.com/chat/123',
    reconcileAttempts:100,reconcileDeadlineAt:1,submittedAt:1};
  for(const errorCode of ['PLATFORM_RESULT_PENDING','DOLA_GENERATION_TIMEOUT','DOUBAO_GENERATION_TIMEOUT']) {
    const waiting={...job,errorCode};
    const plan=reconciliationPlan(waiting,10*24*60*60_000);
    assert.equal(plan.deadline,null);assert.equal(plan.next,10*24*60*60_000+300_000);
    assert.equal(jobProgress(waiting).phase,'waiting_result');assert.equal(jobProgress(waiting).action,'none');
  }
  assert.equal(jobProgress({...job,errorCode:'LOGIN_EXPIRED_DURING_SUBMISSION'}).phase,'awaiting_login');
  assert.equal(jobProgress({...job,errorCode:'DOLA_HUMAN_VERIFICATION_REQUIRED'}).phase,'awaiting_verification');
  assert.equal(jobProgress({...job,errorCode:'BROWSER_DISCONNECTED'}).phase,'reconciling');
  assert.equal(jobProgress({...job,lastObservedStage:'collecting',errorCode:'DOLA_RESULT_MEDIA_PENDING'}).phase,'download_blocked');
  assert.equal(jobProgress({...job,status:'failed',errorCode:'PLATFORM_GENERATION_FAILED'}).phase,'failed');
  for(const status of ['leased','submitted','generating']) {
    assert.equal(jobProgress({...job,status,collectOnly:1}).phase,'waiting_result');
  }
});

test('queued work exposes the actual prerequisite in both UI and partner API',()=>{
  for (const [error,label] of Object.entries({ACCOUNTS_LOGIN_REQUIRED:'等待账号登录',
    ACCOUNTS_VERIFICATION_REQUIRED:'等待账号验证',ACCOUNT_ALREADY_RUNNING:'等待账号空闲',
    ACCOUNT_CREDITS_INSUFFICIENT:'等待可用额度',ACCOUNT_DAILY_VIDEO_LIMIT:'等待每日次数恢复',WORKER_CAPACITY_FULL:'等待节点空闲'})) {
    const progress=jobProgress({status:'queued',errorCode:error});
    assert.equal(progress.label,label);assert.equal(progress.phase,'queued');
    assert.equal(partnerProgress({state:'queued',jobStatus:'queued',jobError:error}).label,label);
  }
});

test('execution stages distinguish platform response, generation and validated delivery',()=>{
  for(const [status,phase] of Object.entries({queued:'queued',leased:'starting',submitting:'submitting',
    submitted:'awaiting_platform',generating:'generating',collecting:'downloading',success:'completed'})) {
    assert.equal(jobProgress({status}).phase,phase);
  }
  const result=jobProgress({status:'collecting'});
  assert.equal(result.platform_status,'completed');assert.equal(result.delivery_status,'downloading');
  assert.equal(partnerProgress({jobStatus:'success',state:'running'}).phase,'processing');
  assert.equal(partnerProgress({jobStatus:'success',state:'succeeded'}).delivery_status,'available');
});

test('verification, original download and unknown submission have different actions',()=>{
  for(const service of ['DOLA','DOUBAO'])assert.equal(jobProgress({status:'reconciling',errorCode:service+'_HUMAN_VERIFICATION_REQUIRED'}).action,'verify');
  const downloading=jobProgress({status:'reconciling',lastObservedStage:'collecting',errorCode:'BROWSER_DISCONNECTED'});
  assert.equal(downloading.phase,'download_blocked');assert.equal(downloading.action,'recollect');
  assert.equal(downloading.platform_status,'completed');
  assert.equal(jobProgress({status:'reconciling',errorCode:'WATERMARK_FREE_RESULT_REQUIRED'}).delivery_status,'blocked');
  assert.equal(jobProgress({status:'reconciling',errorCode:'DOUBAO_VERIFIED_TASK_NOT_FOUND'}).phase,'submission_unconfirmed');
  assert.equal(jobProgress({status:'reconciling',errorCode:'PLATFORM_PARAMETERS_MISMATCH'}).action,'resume');
  const checking=jobProgress({status:'reconciling',lastObservedStage:'generating',nextReconcileAt:100});
  assert.equal(checking.phase,'reconciling');assert.equal(checking.action,'none');
});

test('original-file retry is bounded and never submits a generation',()=>{
  const job={remoteUrl:'https://www.doubao.com/chat/123',errorCode:'DOUBAO_ORIGINAL_EXPORT_TIMEOUT'};
  assert.ok(reconciliationPlan({...job,reconcileAttempts:2},100).next);
  assert.equal(reconciliationPlan({...job,reconcileAttempts:3},100).next,null);
});

test('the last completed platform stage survives errors, restart and legacy migration',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'job-progress-'));const dbfile=path.join(dir,'db.sqlite');
  let store=await createStore(dbfile);
  try{
    const job=await store.createDraftJob({idempotencyKey:'observed',mode:'image_to_video',model:'Seedance 2.0 Fast',
      durationSeconds:15,aspectRatio:'9:16',prompt:'cat',referenceAssets:[],priority:50,enqueue:true});
    await store.updateJob(job.id,{status:'collecting'});
    await store.updateJob(job.id,{status:'reconciling',errorCode:'BROWSER_DISCONNECTED'});
    assert.equal((await store.getJob(job.id)).lastObservedStage,'collecting');
    await store.close();
    const legacy=new DatabaseSync(dbfile);
    legacy.exec('ALTER TABLE jobs DROP COLUMN last_observed_stage; ALTER TABLE jobs DROP COLUMN last_observed_at;');legacy.close();
    store=await createStore(dbfile);
    const restored=await store.getJob(job.id);
    assert.equal(restored.progress.platform_status,'completed');assert.equal(restored.progress.phase,'download_blocked');
    assert.ok(restored.lastObservedAt);
    assert.equal((await store.listJobsPage({status:'active'})).total,1);
  }finally{await store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
