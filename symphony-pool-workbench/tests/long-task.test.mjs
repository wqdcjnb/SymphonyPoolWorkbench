import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createStore } from '../lib/db.mjs';
import { createAccountPool } from '../lib/account-pool.mjs';
import { createWorkbenchServer } from '../server.mjs';
import { Client } from '../docs/examples/partner-client.mjs';

const taskId='task-550e8400-e29b-41d4-a716-446655440000';
test('Node client watches beyond 20 minutes, retries network and rate limits, and waits through reconciliation',async()=>{
  let now=0,calls=0;const sleeps=[],progress=[];
  const client=new Client({key:'test-only',clock:()=>now,random:()=>0,sleep:async ms=>{sleeps.push(ms);now+=ms;},fetcher:async()=>{
    calls++;
    if(calls===1)throw new TypeError('fetch failed');
    if(calls===2)return new Response(JSON.stringify({error:{code:'RATE_LIMITED'}}),{status:429,headers:{'Retry-After':'125'}});
    return new Response(JSON.stringify({task_id:taskId,status:now>36*60_000?'succeeded':calls%2?'reconciling':'running',results:[],poll_after_seconds:60}));
  }});
  const result=await client.wait(taskId,{onProgress:p=>progress.push(p)});
  assert.equal(result.status,'succeeded');assert.equal(result.terminal,true);assert.ok(now>36*60_000);
  assert.equal(sleeps[1],125000);assert.ok(progress.some(p=>p.status==='reconciling'));
  assert.ok(sleeps.every(ms=>ms>=60000));
});

test('Node local wait expiration is resumable and a lost creation response reuses its business ID',async()=>{
  let now=0,calls=0;const bodies=[];
  const client=new Client({key:'test-only',clock:()=>now,random:()=>0,sleep:async ms=>{now+=ms;},fetcher:async(url,options)=>{
    if(options.method==='POST'){
      bodies.push(options.body);if(++calls===1)throw new TypeError('connection closed after server committed');
      return new Response(JSON.stringify({task_id:taskId,status:'queued'}));
    }
    return new Response(JSON.stringify({task_id:taskId,status:'running',results:[]}));
  }});
  await client.submit({client_task_id:'same-business-id',prompt:'test'});
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
  const result=await client.wait(taskId,{timeout:120});
  assert.equal(result.wait_expired,true);assert.equal(result.terminal,false);assert.equal(result.status,'running');
});

for(const backend of ['sqlite','postgres']) for(const service of ['doubao','dola'])
test(`${backend}/${service}: timeout recovery is durable, fenced, read-only and charged once`,
  {skip:backend==='postgres'&&!process.env.TEST_POSTGRES_URL},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-task-')),schema='long_'+randomUUID().replaceAll('-','');
  let source=path.join(root,'db.sqlite'),admin,store,pool;
  t.after(async()=>{await pool?.stop();await store?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}fs.rmSync(root,{recursive:true,force:true});});
  if(backend==='postgres'){
    admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);source=url.href;
  }
  store=await createStore(source);
  const startPool=async()=>{pool=createAccountPool({store,workerId:'qa',keyFile:path.join(root,'key'),capacity:4,enforceWorker:false});await pool.start();};
  await startPool();
  const model=service==='dola'?'Dreamina Seedance 2.5':'Seedance 2.0 Mini',durationSeconds=service==='dola'?30:15,cost=service==='dola'?4:2;
  await store.ensureAccount({id:service,label:service,loginType:service,service,workerId:'qa',profilePath:path.join(root,'profile')});
  await store.saveVerification(service,{ok:true,loggedIn:true,modelsObserved:[model]});
  const job=await store.createDraftJob({idempotencyKey:'long',accountId:service,mode:'image_to_video',model,durationSeconds,aspectRatio:'9:16',prompt:'test',referenceAssets:[],priority:50,enqueue:true});
  const initial=await store.claimNextQueuedJob({pool}),remoteUrl=`https://www.${service}.com/chat/123456`;
  await store.updateJob(job.id,{status:'submitted',remoteUrl,leaseToken:initial.job.leaseToken});
  await store.updateJob(job.id,{status:'reconciling',errorCode:service==='dola'?'DOLA_GENERATION_TIMEOUT':'DOUBAO_GENERATION_TIMEOUT',leaseToken:initial.job.leaseToken});
  await pool.release(initial.job.leaseToken);
  const waiting=await store.getJob(job.id);
  assert.ok(waiting.nextReconcileAt>Date.now());assert.ok(waiting.reconcileDeadlineAt>Date.now());
  assert.equal((await store.getAccount(service)).reliabilityScore,80,'slow generation is not an account fault');
  assert.equal((await store.getAccount(service)).creditsRemaining,10-cost);
  await pool.stop();await store.close();store=await createStore(source);await startPool();await store.restoreReconciliation();
  assert.equal((await store.getJob(job.id)).nextReconcileAt,waiting.nextReconcileAt);
  await store.database.prepare('UPDATE jobs SET next_reconcile_at=0 WHERE id=?').run(job.id);
  const recovered=await store.claimNextReconciliation({pool});
  assert.equal(recovered.job.id,job.id);assert.equal(recovered.job.collectOnly,1);assert.equal(recovered.job.remoteUrl,remoteUrl);
  assert.equal(await store.claimNextReconciliation({pool}),null);
  await assert.rejects(store.updateJob(job.id,{status:'success',leaseToken:initial.job.leaseToken}),/STALE_JOB_LEASE/);
  await store.updateJob(job.id,{status:'reconciling',errorCode:'WORKER_TIMEOUT',leaseToken:recovered.job.leaseToken});
  await pool.release(recovered.job.leaseToken);
  assert.ok((await store.getJob(job.id)).nextReconcileAt>=Date.now()+110000);
  await store.database.prepare('UPDATE jobs SET next_reconcile_at=0,cancel_requested=1 WHERE id=?').run(job.id);
  const last=await store.claimNextReconciliation({pool});
  assert.ok(last,'cancelling a submitted task must still collect its original result');
  await store.updateJob(job.id,{status:'success',leaseToken:last.job.leaseToken});await pool.release(last.job.leaseToken);
  assert.equal((await store.getAccount(service)).creditsRemaining,10-cost);
  assert.equal((await store.getAccount(service)).videoSuccessCount,1);
  assert.equal((await store.listJobs()).length,1);
});

test('automatic collections share a two-slot limit and a restart keeps each original account and task', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-slots-')),source=path.join(root,'db.sqlite');
  let store=await createStore(source);
  t.after(async()=>{await store.close();fs.rmSync(root,{recursive:true,force:true});});
  const jobs=[];
  for(let i=0;i<3;i++){
    const id='account-'+i;
    await store.ensureAccount({id,label:id,service:'doubao',loginType:'doubao',workerId:'qa',profilePath:path.join(root,id)});
    await store.saveVerification(id,{ok:true,modelsObserved:['Seedance 2.0 Mini']});
    const job=await store.createDraftJob({idempotencyKey:id,accountId:id,mode:'image_to_video',model:'Seedance 2.0 Mini',durationSeconds:15,aspectRatio:'9:16',prompt:'test',referenceAssets:[],priority:50,enqueue:true});
    await store.claimNextQueuedJob();
    await store.updateJob(job.id,{status:'submitted',remoteUrl:'https://www.doubao.com/chat/'+(100+i)});
    await store.updateJob(job.id,{status:'reconciling',errorCode:'DOUBAO_GENERATION_TIMEOUT'});
    jobs.push(job);
  }
  await store.database.prepare("UPDATE jobs SET next_reconcile_at=0 WHERE status='reconciling'").run();
  const first=await store.claimNextReconciliation(),second=await store.claimNextReconciliation();
  assert.ok(first&&second);
  assert.notEqual(first.account.id,second.account.id);
  assert.equal(await store.claimNextReconciliation(),null);
  await store.close();store=await createStore(source);await store.restoreReconciliation();
  for(const assignment of [first,second]){
    const job=await store.getJob(assignment.job.id);
    assert.equal(job.status,'reconciling');assert.ok(job.nextReconcileAt>Date.now());
    assert.equal(job.accountId,assignment.account.id);assert.equal(job.requestedAccountId,assignment.account.id);
    assert.equal(job.remoteUrl,assignment.job.remoteUrl);assert.equal(job.creditState,'charged');
  }
  assert.equal((await store.listJobs()).length,jobs.length);
});

test('missing task URL and human verification stay manual; an expired recovery window requires attention',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-manual-')),store=await createStore(path.join(root,'db.sqlite'));
  t.after(async()=>{await store.close();fs.rmSync(root,{recursive:true,force:true});});
  await store.ensureAccount({id:'dola',label:'dola',loginType:'dola',service:'dola',workerId:'qa',profilePath:path.join(root,'profile')});
  await store.saveVerification('dola',{ok:true,modelsObserved:['Dreamina Seedance 2.5']});
  const job=await store.createDraftJob({idempotencyKey:'manual',accountId:'dola',mode:'image_to_video',model:'Dreamina Seedance 2.5',durationSeconds:30,aspectRatio:'9:16',prompt:'test',referenceAssets:[],priority:50,enqueue:true});
  await store.claimNextQueuedJob();await store.updateJob(job.id,{status:'reconciling',errorCode:'WORKER_TIMEOUT'});
  assert.equal((await store.getJob(job.id)).nextReconcileAt,null);
  await store.updateJob(job.id,{status:'reconciling',errorCode:'DOLA_HUMAN_VERIFICATION_REQUIRED',remoteUrl:'https://www.dola.com/chat/123'});
  assert.equal((await store.getJob(job.id)).nextReconcileAt,null);assert.equal((await store.getAccount('dola')).needsAttention,true);
  await store.saveVerification('dola',{ok:true,modelsObserved:['Dreamina Seedance 2.5']});
  await store.updateJob(job.id,{status:'reconciling',errorCode:'DOLA_GENERATION_TIMEOUT'});
  await store.database.prepare('UPDATE jobs SET reconcile_deadline_at=1,next_reconcile_at=0 WHERE id=?').run(job.id);
  assert.equal(await store.claimNextReconciliation(),null);
  const final=await store.getJob(job.id);assert.equal(final.status,'reconciling');assert.equal(final.errorCode,'RECONCILIATION_NEEDS_ATTENTION');
  assert.equal(final.nextReconcileAt,null);assert.equal((await store.getAccount('dola')).needsAttention,true);
});

test('server automatically recollects a long task, including collection launch errors, without resubmitting',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-server-')),workerPath=path.join(root,'worker.mjs');
  fs.writeFileSync(workerPath,`import fs from 'node:fs';import path from 'node:path';
    let raw='';for await(const chunk of process.stdin)raw+=chunk;const j=JSON.parse(raw);
    const log=path.join(path.dirname(j.outputPath),'attempts.txt');fs.mkdirSync(path.dirname(log),{recursive:true});
    fs.appendFileSync(log,j.collectOnly?'collect\\n':'submit\\n');
    if(!j.collectOnly){console.log(JSON.stringify({stage:'submitted',remoteUrl:'https://www.doubao.com/chat/123'}));console.log(JSON.stringify({stage:'error',code:'DOUBAO_GENERATION_TIMEOUT'}));}
    else if(fs.readFileSync(log,'utf8').trim().split('\\n').length===2){console.log(JSON.stringify({stage:'error',code:'BROWSER_AUTOMATION_FAILED'}));}
    else{if(j.collectExistingUrl!=='https://www.doubao.com/chat/123'||j.collectionCheckSeconds!==90)throw Error('unsafe recovery');fs.writeFileSync(j.outputPath,'video');console.log(JSON.stringify({stage:'success',resultPath:j.outputPath}));}`);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const app=await createWorkbenchServer({port,workspaceRoot:root,databasePath:path.join(root,'db.sqlite'),generatedRoot:path.join(root,'generated'),seedAccount:false,
    workerPath,pythonExecutable:process.execPath,profileInUse:()=>false,autoReverifyAfterQueuedJob:false,schedulerIntervalMs:25});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  await app.store.ensureAccount({id:'doubao',label:'doubao',loginType:'doubao',service:'doubao',workerId:'qa',profilePath:path.join(root,'profile')});
  await app.store.saveVerification('doubao',{ok:true,modelsObserved:['Seedance 2.0 Mini']});
  const job=await app.store.createDraftJob({idempotencyKey:'auto',mode:'image_to_video',model:'Seedance 2.0 Mini',durationSeconds:15,aspectRatio:'9:16',prompt:'test',referenceAssets:[],priority:50,enqueue:true});
  await app.listen();
  const wait=async state=>{for(let i=0;i<200;i++){if((await app.store.getJob(job.id)).status===state&&!app.queueScheduler.runningCount)return;await new Promise(resolve=>setTimeout(resolve,15));}throw Error('state timeout: '+state);};
  await wait('reconciling');
  for(const expected of ['reconciling','success']){
    await app.store.database.prepare('UPDATE jobs SET next_reconcile_at=0 WHERE id=?').run(job.id);app.queueScheduler.wake();
    await new Promise(resolve=>setTimeout(resolve,50));await wait(expected);
  }
  assert.equal(fs.readFileSync(path.join(root,'generated/attempts.txt'),'utf8'),'submit\ncollect\ncollect\n');
  assert.equal((await app.store.getAccount('doubao')).creditsRemaining,8);assert.equal((await app.store.listJobs()).length,1);
});
