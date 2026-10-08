import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStore } from '../lib/db.mjs';
import { creditDay, withDailyCredits } from '../lib/daily-credits.mjs';
import { resolveVideoTarget, videoTargetBlocker } from '../lib/job-routing.mjs';
import { MODELS } from '../lib/partner-protocol.mjs';

async function fixture(t,service) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'free-video-limit-'));
  const file=path.join(root,'workbench.sqlite');
  const store=await createStore(file);
  t.after(async()=>{await store.close();fs.rmSync(root,{recursive:true,force:true});});
  const model=service==='dola'?'Dreamina Seedance 2.5':'Seedance 2.0 Fast';
  const duration=service==='dola'?30:15;
  await store.ensureAccount({id:service,label:service,service,loginType:service,workerId:'test',profilePath:path.join(root,'profile')});
  const verify=()=>store.saveVerification(service,{ok:true,loggedIn:true,modelsObserved:[model],remainingCredits:null});
  await verify();
  let serial=0;
  const queue=()=>store.createDraftJob({idempotencyKey:'quota-'+serial++,accountId:service,model,
    mode:'image_to_video',durationSeconds:duration,aspectRatio:'9:16',prompt:'test',referenceAssets:[],priority:50,enqueue:true});
  const account=()=>store.getAccount(service);
  return {store,file,service,model,duration,verify,queue,account};
}

for(const service of ['doubao','dola']) {
  test(`${service}: external tests and workbench generations share exactly two slots`,async t=>{
    const f=await fixture(t,service),createdAt=Date.now();
    const video={videoId:'external-video-0001',createdAt};
    await f.store.recordExternalVideoGeneration(service,video);
    await f.store.recordExternalVideoGeneration(service,video);
    assert.equal((await f.account()).freeVideosRemaining,1);
    const first=await f.queue(),second=await f.queue();
    const claims=await Promise.all([f.store.claimNextQueuedJob(),f.store.claimNextQueuedJob()]);
    assert.equal(claims.filter(Boolean).length,1);
    assert.equal((await f.account()).freeVideosReserved,1);
    assert.equal((await f.account()).freeVideosRemaining,0);
    await f.store.updateJob(first.id,{status:'submitting'});
    await f.store.updateJob(first.id,{status:'success'});
    await f.verify();
    assert.equal((await f.account()).freeVideosUsed,2);
    assert.equal((await f.account()).freeVideosRemaining,0);
    assert.equal(await f.store.claimNextQueuedJob(),null);
    assert.equal((await f.store.getJob(second.id)).status,'queued');
    assert.equal((await f.store.getJob(second.id)).errorCode,'ACCOUNT_DAILY_VIDEO_LIMIT');
    const reopened=await createStore(f.file);
    try {assert.equal((await reopened.getAccount(service)).freeVideosRemaining,0);}
    finally {await reopened.close();}
    const rebound=await createStore(f.file,{database:f.store.database});
    assert.equal(rebound.database,f.store.database,'live updates preserve the pool transaction adapter');
    assert.equal((await rebound.getAccount(service)).freeVideosRemaining,0);
    await f.store.ensureAccount({id:'imported',label:'imported',service,loginType:service,workerId:'test',profilePath:path.join(os.tmpdir(),'imported')});
    await f.store.recordExternalVideoGeneration('imported',video);
    await f.store.updateAccountIdentity('imported','imported-renamed','renamed',path.join(os.tmpdir(),'profile-renamed'));
    assert.equal((await f.store.getAccount('imported-renamed')).freeVideosExternal,1);
  });
}

test('explicitly rejected generations release quota even if legacy credit ledger is depleted',async t=>{
  const f=await fixture(t,'doubao');
  for(let n=0;n<5;n++) {
    const job=await f.queue();
    assert.equal((await f.store.claimNextQueuedJob()).job.id,job.id);
    await f.store.updateJob(job.id,{status:'submitting'});
    await f.store.updateJob(job.id,{status:'failed',errorCode:'DOUBAO_SUBSCRIPTION_REQUIRED'});
    await f.verify();
    assert.equal((await f.account()).freeVideosRemaining,2);
  }
  assert.equal((await f.account()).creditsRemaining,0);
  const unknown=await f.queue();
  assert.equal((await f.store.claimNextQueuedJob()).job.id,unknown.id);
  await f.store.updateJob(unknown.id,{status:'submitting'});
  await f.store.updateJob(unknown.id,{status:'failed',errorCode:'UNKNOWN_AFTER_SUBMIT'});
  assert.equal((await f.account()).freeVideosRemaining,1,'uncertain submission still occupies a slot');
});

test('quota uses Beijing day, observations never inflate availability, and old results can still be collected',()=>{
  const at=Date.parse('2026-10-08T15:59:59Z');
  const account={id:'doubao',service:'doubao',status:'ready',models:['Seedance 2.0 Fast'],
    quotaExhaustedDate:'2026-10-08',videoCountDate:'2026-10-08',videosCreatedToday:2};
  assert.equal(withDailyCredits(account,{},at).freeVideosRemaining,0);
  const tomorrow=withDailyCredits({...account,status:'ready'},{},at+1000);
  assert.equal(tomorrow.freeVideosRemaining,2);
  assert.equal(tomorrow.freeVideosDate,'2026-10-09');
  assert.equal(creditDay(at+1000),'2026-10-09');
  const exhausted=withDailyCredits(account,{},at);
  const job={accountId:account.id,model:account.models[0],durationSeconds:15,aspectRatio:'9:16',referenceAssets:[]};
  assert.equal(videoTargetBlocker(job,[exhausted]),'ACCOUNT_DAILY_VIDEO_LIMIT');
  assert.equal(resolveVideoTarget({...job,collectOnly:true},[exhausted]).account.id,account.id);
  assert.throws(()=>resolveVideoTarget(job,[exhausted]),/NO_ELIGIBLE_ACCOUNT/);
  assert.equal(withDailyCredits({...account,quotaExhaustedDate:null}, {videoUsed:1,externalVideos:1},at).freeVideosRemaining,0);
  assert.equal(withDailyCredits({...account,quotaExhaustedDate:null}, {videoUsed:5},at).freeVideosRemaining,0);
});

test('model directory publishes video quota and labels old point fields as legacy',()=>{
  for(const model of MODELS) {
    assert.equal(model.daily_free_videos_per_account,2);
    assert.equal(model.quota_unit,'video');
    assert.equal(model.quota_timezone,'Asia/Shanghai');
    assert.equal(model.legacy_credits_deprecated,true);
  }
});
