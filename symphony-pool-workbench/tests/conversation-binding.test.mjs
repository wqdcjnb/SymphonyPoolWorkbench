import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createStore} from '../lib/db.mjs';

test('jobs can share a video conversation only when bound to different original messages',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-binding-'));
  const store=await createStore(path.join(root,'db.sqlite'));
  t.after(async()=>{await store.close();fs.rmSync(root,{recursive:true,force:true});});
  await store.ensureAccount({id:'doubao',label:'test',loginType:'doubao',service:'doubao',workerId:'test',profilePath:path.join(root,'profile')});
  await store.saveVerification('doubao',{ok:true,loggedIn:true,modelsObserved:['Seedance 2.0 Fast']});
  const jobs=[];
  for(let index=0;index<4;index++){
    const job=await store.createDraftJob({idempotencyKey:'job-'+index,accountId:'doubao',mode:'image_to_video',model:'Seedance 2.0 Fast',durationSeconds:5,aspectRatio:'9:16',prompt:'a blue cube',referenceAssets:[],priority:50});
    await store.updateJob(job.id,{status:'reconciling'});jobs.push(job);
  }
  const url='https://www.doubao.com/chat/123';
  await store.attachRemoteTask(jobs[0].id,url,'101');
  await store.attachRemoteTask(jobs[1].id,url,'201');
  assert.equal((await store.getJob(jobs[1].id)).remoteMessageId,'201');
  await assert.rejects(store.attachRemoteTask(jobs[2].id,url,'101'),/REMOTE_TASK_ALREADY_BOUND/);
  await assert.rejects(store.attachRemoteTask(jobs[3].id,url),/REMOTE_TASK_ALREADY_BOUND/);
  await assert.rejects(store.updateJob(jobs[1].id,{status:'generating',remoteMessageId:'101'}),/TASK_MESSAGE_MISMATCH/);
  await assert.rejects(store.updateJob(jobs[1].id,{status:'generating',remoteUrl:'https://www.doubao.com/chat/456'}),/TASK_CONVERSATION_CHANGED/);
  await store.updateJob(jobs[1].id,{status:'collecting',remoteMessageId:'201'});
  assert.equal((await store.getJob(jobs[0].id)).remoteMessageId,'101');
  await store.updateJob(jobs[2].id,{status:'submitted',remoteUrl:'https://www.doubao.com/chat/789',remoteMessageId:'301'});
  const before=await store.getJob(jobs[2].id);
  const restarted=await store.restartJobConversation(jobs[2].id,null);
  assert.equal(restarted.id,before.id);assert.equal(restarted.remoteUrl,null);assert.equal(restarted.remoteMessageId,null);
  assert.equal(restarted.creditState,before.creditState);assert.equal(restarted.creditCost,before.creditCost);
  await assert.rejects(store.restartJobConversation(jobs[2].id,null),/CONVERSATION_RESTART_UNSAFE/);
  await assert.rejects(store.restartJobConversation(jobs[1].id,null),/CONVERSATION_RESTART_UNSAFE/);
});
