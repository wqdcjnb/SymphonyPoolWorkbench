import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createWorkbenchServer } from "../server.mjs";
import { DAY, digest, signature, configurePartnerApi, validateTask } from "../lib/partner-protocol.mjs";

const key = "test-only-partner-key-never-use-in-production";
const downloadSecret = "test-only-download-secret-never-use-in-production";
const webhookSecret = "test-only-webhook-secret-never-use-in-production";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9eUIO1oAAAAASUVORK5CYII=", "base64");
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom\0\0\0\0isomiso2"), Buffer.alloc(100, 93)]);
const originalReceipt = { version: 1, source: "doubao_authorized_original", watermark_free: true,
  sha256: digest(mp4), source_md5: createHash("md5").update(mp4).digest("hex"), size_bytes: mp4.length };
const input = (id, count = 1) => ({ client_task_id: id, model: "Seedance 2.0 Mini", duration: 15,
  ratio: "9:16", count, prompt: "海边日落", negative_prompt: "不要文字和水印" });

test('generation ETA reaches polling and webhooks; waiting and exceeded forecasts never end the task',async t=>{
  const received=[];
  const receiver=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;received.push(JSON.parse(body));res.writeHead(204);res.end();
  });
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>receiver.close(resolve)));
  const callback=`http://127.0.0.1:${receiver.address().port}/eta`;
  const f=await fixture(t,{partnerApi:{allowLocalCallbacks:true,callbackUrls:[callback]}});
  const db=f.app.store.database, start=Date.now()-3600_000;
  for(const [index,seconds] of [180,240].entries()) {
    const id='job-'+randomUUID();
    await db.prepare(`INSERT INTO jobs(id,idempotency_key,mode,model,duration_seconds,aspect_ratio,prompt,priority,status,created_at,updated_at,completed_at)
      VALUES(?,?,'image_to_video','Seedance 2.0 Mini',15,'9:16','sample',50,'success',?,?,?)`).run(id,id,start,start+seconds*1000,start+seconds*1000);
    for(const [stage,time] of [['generating',start],['collecting',start+seconds*1000]]) {
      await db.prepare('INSERT INTO events(id,job_id,event_type,message,created_at) VALUES(?,?,?,?,?)')
        .run(randomUUID(),id,'job.'+stage,'sample',time);
    }
  }
  const created=(await f.request('/v1/videos',{...input('generation-eta'),callback_url:callback})).body;
  assert.equal(created.progress.generation_estimate.status,'unavailable');
  await f.app.partnerApi.wake();
  const task=await f.app.partnerApi.store.get(created.task_id), id=task.items[0].job_id;
  await f.app.store.updateJob(id,{status:'submitted',remoteUrl:'https://www.doubao.com/chat/123'});
  await f.app.store.updateJob(id,{status:'generating'});
  const current=(await f.request('/v1/videos/'+task.id)).body;
  const eta=current.progress.generation_estimate;
  assert.equal(eta.status,'available');assert.equal(eta.source,'recent_history');assert.equal(eta.sample_count,2);
  assert.equal(eta.estimated_total_seconds,240);assert.ok(eta.estimated_remaining_seconds>230);
  assert.deepEqual(eta,current.results[0].progress.generation_estimate);
  await f.app.partnerApi.deliver();
  const event=received.find(e=>e.event==='video.task.progress'&&e.progress.phase==='generating');
  assert.equal(event.progress.generation_estimate.estimated_total_seconds,240);
  const count=received.length;
  const again=(await f.request('/v1/videos/'+task.id)).body;
  await f.app.partnerApi.deliver();
  assert.equal(again.progress_sequence,current.progress_sequence);assert.equal(received.length,count);
  await db.prepare("UPDATE events SET created_at=? WHERE job_id=? AND event_type='job.generating'").run(start,id);
  await f.app.store.updateJob(id,{status:'reconciling',errorCode:'DOUBAO_GENERATION_TIMEOUT'});
  const overdue=(await f.request('/v1/videos/'+task.id)).body;
  assert.equal(overdue.status,'running');assert.equal(overdue.terminal,false);
  assert.equal(overdue.progress.generation_estimate.status,'exceeded');
  assert.equal(overdue.progress.generation_estimate.estimated_remaining_seconds,null);
  await f.app.store.updateJob(id,{status:'reconciling',errorCode:'DOUBAO_HUMAN_VERIFICATION_REQUIRED'});
  const paused=(await f.request('/v1/videos/'+task.id)).body;
  assert.equal(paused.progress.generation_estimate.status,'unavailable');
  assert.equal(paused.progress.generation_estimate.estimated_completion_at,null);
  await f.finish(task.items[0]);await f.app.partnerApi.wake();
  const done=(await f.request('/v1/videos/'+task.id)).body;
  assert.equal(done.status,'succeeded');assert.equal(done.progress.generation_estimate.status,'not_applicable');
});

test('accepted generation query and coordinator both keep the original API task running without a timeout error',async t=>{
  const f=await fixture(t);
  const created=await f.request('/v1/videos',input('accepted-waiting'));
  await f.app.partnerApi.wake();
  const task=await f.app.partnerApi.store.get(created.body.task_id),id=task.items[0].job_id;
  await f.app.store.updateJob(id,{status:'submitted',remoteUrl:'https://www.doubao.com/chat/123'});
  await f.app.store.updateJob(id,{status:'generating'});
  await f.app.store.updateJob(id,{status:'reconciling',errorCode:'DOUBAO_GENERATION_TIMEOUT'});
  for(let n=0;n<3;n++) {
    await f.app.partnerApi.wake();
    const response=(await f.request('/v1/videos/'+task.id)).body;
    assert.equal(response.task_id,task.id);assert.equal(response.client_task_id,'accepted-waiting');
    assert.equal(response.status,'running');assert.equal(response.terminal,false);
    assert.equal(response.results[0].status,'running');assert.equal(response.results[0].error,undefined);
    assert.equal(response.results[0].progress.phase,'waiting_result');
    assert.equal(response.results[0].recovery.mode,'automatic');
    assert.equal(response.results[0].recovery.deadline_at,null);
    assert.equal(response.results[0].video_url,undefined);
    assert.equal((await f.app.partnerApi.store.get(task.id)).items[0].error_code,null);
  }
  assert.equal((await f.app.store.listJobs()).length,1);
});

test('API reads current execution progress without waiting for the coordinator interval',async t=>{
  const f=await fixture(t);
  const created=await f.request('/v1/videos',input('live-progress'));
  await f.app.partnerApi.wake();
  const task=await f.app.partnerApi.store.get(created.body.task_id);const id=task.items[0].job_id;
  for(const [status,errorCode,phase] of [
    ['submitting',null,'submitting'],['submitted',null,'awaiting_platform'],['generating',null,'generating'],
    ['reconciling','DOUBAO_HUMAN_VERIFICATION_REQUIRED','awaiting_verification'],
    ['collecting',null,'downloading'],['reconciling','WATERMARK_FREE_RESULT_REQUIRED','download_blocked']
  ]){
    await f.app.store.updateJob(id,{status,errorCode});
    const response=(await f.request('/v1/videos/'+task.id)).body;
    const progress=(await f.app.store.getJob(id)).progress;
    assert.equal(response.results[0].progress.phase,phase);
    assert.equal(response.results[0].progress.label,progress.label);
    assert.equal(response.results[0].status,status==='reconciling'?'reconciling':'running');
    assert.equal(response.status,response.results[0].status);assert.equal(response.terminal,false);
    assert.equal(response.results[0].video_url,undefined);
  }
  assert.equal((await f.app.store.listJobs()).length,1);
  const response=(await f.request('/v1/videos/'+task.id)).body;
  assert.equal(response.results[0].progress.platform_status,'completed');
  assert.equal(response.results[0].progress.delivery_status,'blocked');
});

test('task-level progress exposes every execution phase and reason with a stable monotonic sequence',async t=>{
  const f=await fixture(t);
  const created=(await f.request('/v1/videos',input('all-progress'))).body;
  await f.app.partnerApi.wake();
  const saved=await f.app.partnerApi.store.get(created.task_id),id=saved.items[0].job_id;
  let sequence=created.progress_sequence;
  for(const [status,errorCode,phase] of [
    ['queued','ACCOUNTS_NOT_READY','queued'],['leased',null,'starting'],
    ['submitting',null,'submitting'],['submitted',null,'awaiting_platform'],['generating',null,'generating'],
    ['reconciling','DOUBAO_HUMAN_VERIFICATION_REQUIRED','awaiting_verification'],
    ['reconciling','LOGIN_REQUIRED','awaiting_login'],
    ['reconciling','TASK_ORIGINAL_PAGE_LOST','original_conversation_missing'],
    ['reconciling','PLATFORM_PARAMETERS_MISMATCH','parameter_mismatch'],
    ['reconciling','DOUBAO_CONFIRMATION_REQUIRED','awaiting_confirmation'],
    ['reconciling','DOUBAO_SUBMISSION_UNCONFIRMED','submission_unconfirmed'],
    ['collecting',null,'downloading'],['reconciling','VIDEO_DURATION_MISMATCH','download_blocked']
  ]) {
    await f.app.store.updateJob(id,{status,errorCode});
    const task=(await f.request('/v1/videos/'+saved.id)).body;
    assert.equal(task.progress.phase,phase);assert.deepEqual(task.progress,task.results[0].progress);
    assert.equal(task.progress.reason_code,errorCode);assert.equal(task.terminal,false);
    assert.ok(task.progress_sequence>sequence);sequence=task.progress_sequence;
    await f.app.partnerApi.wake();
    assert.equal((await f.request('/v1/videos/'+saved.id)).body.progress_sequence,sequence);
  }
  await f.restart();
  assert.equal((await f.request('/v1/videos/'+saved.id)).body.progress_sequence,sequence);
  await f.app.store.updateJob(id,{status:'failed',errorCode:'VIDEO_DURATION_MISMATCH'});
  await f.app.partnerApi.wake();
  const final=(await f.request('/v1/videos/'+saved.id)).body;
  assert.equal(final.progress.phase,'failed');assert.equal(final.terminal,true);
  assert.equal((await f.app.store.listJobs()).length,1);
});

test('progress callbacks include queue, verification, resumed generation and completion without repeat polling notifications',async t=>{
  const received=[];
  const receiver=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;received.push(JSON.parse(raw));res.writeHead(204);res.end();
  });
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>receiver.close(resolve)));
  const callback=`http://127.0.0.1:${receiver.address().port}/progress`;
  const f=await fixture(t,{partnerApi:{allowLocalCallbacks:true,callbackUrls:[callback]}});
  const created=(await f.request('/v1/videos',{...input('progress-callback'),callback_url:callback})).body;
  await f.app.partnerApi.wake();
  const item=(await f.app.partnerApi.store.get(created.task_id)).items[0];
  await f.app.partnerApi.deliver();
  for(const [status,errorCode] of [['generating',null],['reconciling','DOUBAO_HUMAN_VERIFICATION_REQUIRED'],['generating',null]]){
    await f.app.store.updateJob(item.job_id,{status,errorCode});
    await f.app.partnerApi.wake();await f.app.partnerApi.deliver();
    if(errorCode){
      const length=received.length;await f.restart();await f.app.partnerApi.deliver();
      assert.equal(received.length,length);
    }
  }
  const before=received.length;
  await f.request('/v1/videos/'+created.task_id);
  await f.app.partnerApi.wake();await f.app.partnerApi.deliver();
  assert.equal(received.length,before);
  await f.finish(item);await f.app.partnerApi.wake();await f.app.partnerApi.deliver();
  const updates=received.filter(e=>e.event==='video.task.progress');
  assert.deepEqual(updates.map(e=>e.progress.phase),['queued','generating','awaiting_verification','generating','completed']);
  assert.deepEqual(updates.map(e=>e.progress_sequence),[1,2,3,4,5]);
  assert.equal(updates.at(-1).terminal,true);assert.equal(updates.at(-1).is_final,true);
  assert.ok(updates.at(-1).results[0].video_url);
  assert.ok(received.some(e=>e.event==='video.batch.completed'));
  assert.equal((await f.app.store.listJobs()).length,1);
});

test('100 simultaneous requests persist, wait for accounts and survive restart without duplicate jobs', async t => {
  const f = await fixture(t, { seedAccount: false });
  const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => f.request('/v1/videos', input(`burst-${i}`))));
  assert.deepEqual(responses.map(r => r.status), Array(100).fill(202));
  assert.equal(new Set(responses.map(r => r.body.task_id)).size, 100);
  await f.app.partnerApi.wake();
  let jobs = await f.app.store.listJobs(200);
  assert.equal(jobs.length, 100); assert.ok(jobs.every(job => job.status === 'queued'));
  const ids = jobs.map(job => job.id).sort();
  await f.restart();
  jobs = await f.app.store.listJobs(200);
  assert.deepEqual(jobs.map(job => job.id).sort(), ids);
  const retries = await Promise.all(Array.from({ length: 8 }, () => f.request('/v1/videos', input('burst-0'))));
  assert.ok(retries.every(r => r.status === 200 && r.body.task_id === responses[0].body.task_id));
  assert.equal((await f.app.store.listJobs(200)).length, 100);
});

test('Dola repair is explicit and existing original requests keep their idempotency representation', () => {
  const config = configurePartnerApi({ apiKey: key, downloadSecret });
  assert.deepEqual(validateTask(input('old'), 0, config), validateTask({ ...input('old'), delivery_mode: 'official_original' }, 0, config));
  assert.throws(() => validateTask({ ...input('dola'), model: 'Dreamina Seedance 2.5', duration: 30 }, 0, config), /Dola/);
  assert.throws(() => validateTask({ ...input('doubao'), delivery_mode: 'watermark_repair' }, 0, config), /Dola/);
  assert.equal(validateTask({ ...input('dola'), model: 'Dreamina Seedance 2.5', duration: 30, delivery_mode: 'watermark_repair' }, 0, config).delivery_mode, 'watermark_repair');
});

test('partner catalog accepts six fixed ratios and prompt precedence reaches jobs and query responses', async t => {
  const f = await fixture(t);
  const models = (await f.request('/v1/models')).body.models;
  const spec = (await f.request('/v1/openapi.json')).body;
  assert.deepEqual(spec.components.schemas.TaskRequest.properties.ratio.enum, ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9']);
  for (const model of models) {
    assert.deepEqual(model.ratios, ['9:16','16:9','1:1','3:4','4:3','21:9']);
    for (const ratio of model.ratios) for (const multipart of [false, true]) {
      const body = { ...input('ratio-' + models.indexOf(model) + '-' + ratio.replace(':','-') + '-' + multipart),
        model:model.model, duration:model.durations[0], delivery_mode:model.delivery_modes?.[0] || 'official_original',
        ratio:ratio === '9:16' ? '16:9' : '9:16', prompt:`生成 ${ratio} 商品视频`, negative_prompt:'不要其他画幅' };
      const form = new FormData(); form.append('task', JSON.stringify(body));
      form.append('images', new Blob([png], {type:'image/png'}), 'reference.png');
      const created = await f.request('/v1/videos', multipart ? form : body);
      assert.equal(created.status, 202);
      assert.equal(created.body.ratio, ratio);
      const retry = await f.request('/v1/videos', multipart ? form : {...body, ratio});
      assert.equal(retry.status, 200);
      assert.equal(retry.body.task_id, created.body.task_id);
      assert.equal(retry.body.idempotent_replay, true);
      await f.app.partnerApi.wake();
      const saved = await f.app.partnerApi.store.get(created.body.task_id);
      const job = await f.app.store.getJob(saved.items[0].job_id);
      assert.equal(job.aspectRatio, ratio);
      assert.equal(job.prompt, body.prompt);
      assert.equal(job.referenceAssets.length, multipart ? 1 : 0);
      assert.equal((await f.request('/v1/videos/' + saved.id)).body.ratio, ratio);
    }
  }
  assert.equal((await f.app.store.listJobs()).length, 36);
  for (const [index, model] of models.entries()) {
    const unsupportedAuto = await f.request('/v1/videos', {...input('auto-' + index),model:model.model,
      duration:model.durations[0],delivery_mode:model.delivery_modes?.[0] || 'official_original',ratio:'auto'});
    assert.equal(unsupportedAuto.status,422);
  }
  for (const [prompt, error] of [['1:1 或 9:16', 'PROMPT_RATIO_CONFLICT'], ['比例2:1', 'PROMPT_RATIO_UNSUPPORTED']]) {
    const rejected = await f.request('/v1/videos', {...input('reject'), prompt});
    assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, error);
  }
  assert.equal((await f.app.store.listJobs()).length, 36);
});

test('upgrading prompt ratio policy preserves historical idempotency and original parameters', async t => {
  const f = await fixture(t);
  const request = {...input('pre-ratio-policy'), prompt:'生成1:1方形商品视频'};
  const payload = {...validateTask(input('pre-ratio-policy'),0,configurePartnerApi()),prompt:request.prompt};
  const id = 'task-' + randomUUID();
  await f.app.partnerApi.store.create({id,payload,assets:[],hash:digest(JSON.stringify({payload,images:[]})),now:Date.now()});
  const retry = await f.request('/v1/videos', request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.task_id, id);
  assert.equal(retry.body.ratio, '9:16');
  assert.equal(retry.body.idempotent_replay, true);
  assert.equal((await f.request('/v1/videos', {...request,prompt:'生成1:1不同视频'})).status,409);
});

test('workbench jobs share prompt precedence and report conflicts before saving', async t => {
  const f = await fixture(t);
  for (const field of ['prompt', 'positivePrompt']) {
    const request = {mode:'image_to_video',model:'Seedance 2.0 Mini',durationSeconds:15,
      aspectRatio:'9:16',[field]:'生成1:1商品视频',negativePrompt:'不要16:9',referenceAssets:[]};
    const created = await f.request('/api/jobs',request);
    assert.equal(created.status,201);
    assert.equal(created.body.job.aspectRatio,'1:1');
    assert.equal(created.body.job.prompt,request[field]);
    const conflict = await f.request('/api/jobs',{...request,[field]:'1:1 和 9:16'});
    assert.equal(conflict.status,400);
    assert.equal(conflict.body.error,'PROMPT_RATIO_CONFLICT');
  }
});

for (const service of ['dola','doubao']) test(service+' human verification is visible to API callers and clears after the same job resumes',async t=>{
  const f=await fixture(t);
  const code=service==='doubao'?'DOUBAO_HUMAN_VERIFICATION_REQUIRED':'DOLA_HUMAN_VERIFICATION_REQUIRED';
  const spec=service==='doubao'?{model:'Seedance 2.0 Fast',duration:15}:{model:'Dreamina Seedance 2.5',duration:30,delivery_mode:'watermark_repair'};
  const created=await f.request('/v1/videos',{...input('human-resume'),...spec});
  await f.app.partnerApi.wake();
  const task=await f.app.partnerApi.store.get(created.body.task_id);
  const jobId=task.items[0].job_id;
  await f.app.store.updateJob(jobId,{status:'reconciling',errorCode:code});
  await f.app.partnerApi.wake();
  const paused=await f.request('/v1/videos/'+task.id);
  assert.equal(paused.body.status,'reconciling');
  assert.equal(paused.body.results[0].error.code,code);
  await f.app.store.updateJob(jobId,{status:'generating'});
  await f.app.partnerApi.wake();
  const resumed=await f.request('/v1/videos/'+task.id);
  assert.equal(resumed.body.status,'running');
  assert.equal(resumed.body.results[0].error,undefined);
  assert.equal((await f.app.partnerApi.store.get(task.id)).items[0].job_id,jobId);
});

test('a definite platform rejection is terminal and the original task returns an actionable error',async t=>{
  const f=await fixture(t);
  const created=await f.request('/v1/videos',input('confirmed-platform-rejection'));
  await f.app.partnerApi.wake();
  const task=await f.app.partnerApi.store.get(created.body.task_id);
  await f.app.store.updateJob(task.items[0].job_id,{status:'failed',errorCode:'DOUBAO_SUBSCRIPTION_REQUIRED'});
  await f.app.partnerApi.wake();
  const result=await f.request('/v1/videos/'+task.id);
  assert.equal(result.body.task_id,task.id);assert.equal(result.body.terminal,true);
  assert.equal(result.body.status,'failed');assert.equal(result.body.poll_after_seconds,0);
  assert.equal(result.body.results[0].error.code,'DOUBAO_SUBSCRIPTION_REQUIRED');
  assert.equal(result.body.results[0].video_url,undefined);
});

test('long task query distinguishes automatic recovery, local polling and a completed result', async t => {
  const f = await fixture(t, { seedAccount: false });
  const created = await f.request('/v1/videos', input('long-poll'));
  assert.equal(created.body.terminal, false);
  assert.equal(created.body.poll_after_seconds, 60);
  assert.equal(created.headers.get('retry-after'), '60');
  assert.equal(created.body.notification_mode, 'poll');
  await f.app.partnerApi.wake();
  const task = await f.app.partnerApi.store.get(created.body.task_id);
  const item = task.items[0];
  await f.app.store.updateJob(item.job_id, { status: 'reconciling', remoteUrl: 'https://www.doubao.com/chat/123', errorCode: 'DOUBAO_GENERATION_TIMEOUT' });
  await f.app.store.ensureAccount({ id: 'long', label: 'long', loginType: 'doubao', service: 'doubao', workerId: 'qa', profilePath: path.join(f.root, 'profile') });
  await f.app.store.saveVerification('long', { ok: true, modelsObserved: ['Seedance 2.0 Mini'] });
  await f.app.store.database.prepare('UPDATE jobs SET account_id=? WHERE id=?').run('long', item.job_id);
  await f.app.store.scheduleReconciliation(item.job_id);
  await f.app.partnerApi.wake();
  const pending = await f.request('/v1/videos/' + task.id);
  assert.equal(pending.body.status, 'reconciling');
  assert.equal(pending.body.terminal, false);
  assert.equal(pending.body.failed_count, 0);
  assert.equal(pending.body.results[0].error, undefined);
  assert.equal(pending.body.results[0].recovery.mode, 'automatic');
  assert.ok(Date.parse(pending.body.results[0].recovery.next_check_at) > Date.now());
  assert.equal(pending.body.status_url, f.url + '/v1/videos/' + task.id);
  await f.finish(item);
  await f.app.partnerApi.wake();
  const completed = await f.request('/v1/videos/' + task.id);
  assert.equal(completed.body.status, 'succeeded');
  assert.equal(completed.body.terminal, true);
  assert.equal(completed.body.poll_after_seconds, 0);
  assert.equal(completed.headers.get('retry-after'), null);
  assert.equal(completed.body.results[0].recovery, undefined);
  assert.equal((await f.app.store.listJobs()).length, 1);
});

test('30s multipart overrides Mini with Dola, retains the raw prompt and image, and replays one task', async t => {
  const f = await fixture(t);
  const payload = { ...input('thirty-routing'), prompt: '生成30s广告，适配Seedance 2.0 Mini。展示30袋商品。' };
  const form = () => {
    const value = new FormData();
    value.set('task', JSON.stringify(payload));
    value.append('images', new Blob([png], { type: 'image/png' }), 'reference.png');
    return value;
  };
  const response = await f.request('/v1/videos', form());
  assert.equal(response.status, 202);
  assert.equal(response.body.model, 'Dreamina Seedance 2.5');
  assert.equal(response.body.duration, 30);
  assert.equal(response.body.delivery_mode, 'watermark_repair');
  await f.app.partnerApi.wake();
  const task = await f.app.partnerApi.store.get(response.body.task_id);
  const job = await f.app.store.getJob(task.items[0].job_id);
  assert.equal(job.model, 'Dreamina Seedance 2.5');
  assert.equal(job.durationSeconds, 30);
  assert.equal(job.prompt, payload.prompt);
  assert.equal(job.negativePrompt, payload.negative_prompt);
  assert.equal(job.referenceAssets.length, 1);
  assert.deepEqual(fs.readFileSync(job.referenceAssets[0]), png);
  const replay = await f.request('/v1/videos', form());
  assert.equal(replay.status, 200);
  assert.equal(replay.body.task_id, task.id);
  const query = await f.request('/v1/videos/' + task.id);
  assert.equal(query.body.model, 'Dreamina Seedance 2.5');
  assert.equal(query.body.duration, 30);
  assert.equal((await f.app.store.listJobs()).length, 1);
});

test('workbench 30-second drafts override model and incompatible account selection without changing other drafts', async t => {
  const f = await fixture(t);
  await f.app.store.ensureAccount({ id: 'doubao-test', label: 'Test', loginType: 'doubao', service: 'doubao',
    workerId: 'qa', profilePath: path.join(f.root, 'profile') });
  const base = { model: 'Seedance 2.0 Mini', durationSeconds: 15, aspectRatio: '9:16', accountId: 'doubao-test' };
  const changed = await f.request('/api/jobs', { ...base, positivePrompt: '30秒蓝色商品' });
  assert.equal(changed.status, 201);
  assert.equal(changed.body.job.model, 'Dreamina Seedance 2.5');
  assert.equal(changed.body.job.durationSeconds, 30);
  assert.equal(changed.body.job.requestedAccountId, null);
  assert.equal(changed.body.job.prompt, '30秒蓝色商品');
  const normal = await f.request('/api/jobs', { ...base, positivePrompt: '30袋蓝色商品' });
  assert.equal(normal.status, 201);
  assert.equal(normal.body.job.model, base.model);
  assert.equal(normal.body.job.durationSeconds, 15);
  assert.equal(normal.body.job.requestedAccountId, 'doubao-test');
});

test('Dola 2.5 multipart images reach the queued job in order for both ratios', async t => {
  const f = await fixture(t);
  const catalog = (await f.request('/v1/models')).body.models.find(model => model.model === 'Dreamina Seedance 2.5');
  assert.equal(catalog.max_images, 9);
  for (const ratio of ['9:16', '16:9']) for (const count of [1, 9]) {
    const form = new FormData();
    form.set('task', JSON.stringify({ ...input(`dola-images-${ratio.replace(':','-')}-${count}`),
      model: catalog.model, duration: 30, ratio, delivery_mode: 'watermark_repair' }));
    for (let n = 0; n < count; n++) form.append('images', new Blob([png], { type: 'image/png' }), `reference-${n}.png`);
    const response = await f.request('/v1/videos', form);
    assert.equal(response.status, 202);
    await f.app.partnerApi.wake();
    const task = await f.app.partnerApi.store.get(response.body.task_id);
    const job = await f.app.store.getJob(task.items[0].job_id);
    assert.equal(job.model, catalog.model);
    assert.equal(job.durationSeconds, 30);
    assert.equal(job.aspectRatio, ratio);
    assert.equal(job.referenceAssets.length, count);
    assert.deepEqual(job.referenceAssetNames, Array.from({ length: count }, (_, n) => `reference-${n}.png`));
    for (const file of job.referenceAssets) assert.deepEqual(fs.readFileSync(file), png);
  }
  assert.throws(() => validateTask({ ...input('too-many-dola-images'), model: catalog.model,
    duration: 30, delivery_mode: 'watermark_repair' }, 10, configurePartnerApi({ apiKey: key, downloadSecret })), /不支持|组合|UNSUPPORTED/);
});

test('Dola source becomes a labelled downloadable derivative without changing its original',
  { skip: !process.env.PARTNER_REPAIR_FIXTURE }, async t => {
  const f = await fixture(t);
  const created = await f.request('/v1/videos', { ...input('real-media-repair'), model: 'Dreamina Seedance 2.5', duration: 30, delivery_mode: 'watermark_repair' });
  assert.equal(created.status, 202);
  await f.app.partnerApi.wake();
  const task = await f.app.partnerApi.store.get(created.body.task_id);
  const item = task.items[0];
  await f.finish(item);
  const originalPath = path.join(f.root, 'generated', item.job_id+'.original.mp4');
  fs.copyFileSync(process.env.PARTNER_REPAIR_FIXTURE, originalPath);
  const originalHash = digest(fs.readFileSync(originalPath));
  await f.app.partnerApi.wake();
  const snapshot = await f.request('/v1/videos/'+task.id);
  assert.equal(snapshot.body.status, 'succeeded');
  const result = snapshot.body.results[0];
  assert.equal(result.delivery_mode, 'watermark_repair');
  assert.equal(result.postprocessed, true);
  assert.equal(result.watermark_free, null);
  assert.equal(result.processing.method, 'opencv_temporal_inpaint');
  assert.equal(digest(fs.readFileSync(originalPath)), originalHash);
  assert.notEqual(result.sha256, originalHash);
  const downloaded = await fetch(result.video_url);
  assert.equal(downloaded.status, 200);
  assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), result.sha256);
  const run = promisify(execFile);
  const env = { ...process.env, PARTNER_API_KEY: key, PARTNER_API_BASE_URL: f.url+'/v1' };
  for (const [name, command, script] of [
    ['python', process.env.WORKBENCH_PYTHON || 'python', '../docs/examples/partner-client.py'],
    ['node', process.execPath, '../docs/examples/partner-client.mjs'],
  ]) {
    const out = path.join(f.root, name+'-repaired');
    const args = [fileURLToPath(new URL(script, import.meta.url)), 'wait', task.id,
      ...(name === 'python' ? ['--output', out] : [out])];
    const report = JSON.parse((await run(command, args, { env, timeout: 20000 })).stdout);
    assert.equal(report.status, 'succeeded');
    assert.equal(digest(fs.readFileSync(report.files[0])), result.sha256);
  }
  const target = path.join(f.root, 'generated', item.job_id+'.repaired.mp4');
  fs.writeFileSync(target+'.delivery.json', JSON.stringify(originalReceipt));
  assert.equal((await fetch(result.video_url)).status, 409);
  assert.equal((await f.request('/v1/videos/'+task.id)).body.results[0].video_url, null);
});

test('landscape delivery preserves the requested 16:9 frame of a real 30-second source',
  { skip: !process.env.PARTNER_REPAIR_FIXTURE }, async t => {
  const f = await fixture(t);
  const created = await f.request('/v1/videos', { ...input('landscape-delivery'),
    model: 'Dreamina Seedance 2.5', duration: 30, delivery_mode: 'watermark_repair', ratio: '16:9' });
  assert.equal(created.status, 202);
  await f.app.partnerApi.wake();
  const task = await f.app.partnerApi.store.get(created.body.task_id), item = task.items[0];
  await f.finish(item);
  const source = path.join(f.root, 'generated', item.job_id + '.original.mp4');
  fs.copyFileSync(process.env.PARTNER_REPAIR_FIXTURE, source);
  const originalHash = digest(fs.readFileSync(source));
  const workbenchOutput = path.join(f.root, 'generated', item.job_id + '.mp4');
  await promisify(execFile)(process.env.WORKBENCH_PYTHON || 'python', [
    fileURLToPath(new URL('../../tools/watermark_repair.py', import.meta.url)),
    '--input', source, '--output', workbenchOutput, '--ratio', '16:9', '--duration', '30'], {timeout:360000});
  const workbenchHash = digest(fs.readFileSync(workbenchOutput));
  await f.app.partnerApi.wake();
  const snapshot = (await f.request('/v1/videos/' + task.id)).body;
  assert.equal(snapshot.status, 'succeeded');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'generated', item.job_id + '.repaired.mp4.delivery.json')));
  assert.equal(receipt.requested_ratio, '16:9');
  assert.deepEqual([receipt.media.width, receipt.media.height], [1280, 720]);
  assert.equal(digest(fs.readFileSync(source)), originalHash);
  const response = await fetch(snapshot.results[0].video_url);
  assert.equal(response.status, 200);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), snapshot.results[0].sha256);
  assert.equal(snapshot.results[0].sha256, workbenchHash, 'API must reuse the accepted workbench bytes');
  const preview = await fetch(f.url + '/api/jobs/' + item.job_id + '/result?preview=1');
  assert.equal(preview.status, 200);
  assert.equal(digest(Buffer.from(await preview.arrayBuffer())), workbenchHash);
});

test('portrait delivery can be repaired and retried after a layout fix without another generation',
  {skip:!process.env.PARTNER_PORTRAIT_FIXTURE},async t=>{
  const f=await fixture(t);
  // An already stored 2.0 / 10-second task must remain downloadable after catalog changes.
  const id='task-'+randomUUID();
  await f.app.partnerApi.store.create({id,payload:{...input('portrait-delivery'),model:'Dreamina Seedance 2.0 Fast',duration:10,delivery_mode:'watermark_repair',callback_url:''},assets:[],hash:'historical-fixture',now:Date.now()});
  await f.app.partnerApi.wake();
  const task=await f.app.partnerApi.store.get(id),item=task.items[0];
  await f.finish(item);
  const source=path.join(f.root,'generated',item.job_id+'.original.mp4');
  fs.copyFileSync(process.env.PARTNER_PORTRAIT_FIXTURE,source);
  const originalHash=digest(fs.readFileSync(source));
  await f.app.partnerApi.store.updateItem(item,'failed',{errorCode:'WATERMARK_REPAIR_UNSUPPORTED_LAYOUT'},Date.now());
  const retry=await f.app.partnerApi.store.retryDelivery(task.id,Date.now());
  assert.equal(retry.state,'running');assert.equal(retry.finished_at,null);
  await f.app.partnerApi.wake();
  const snapshot=(await f.request('/v1/videos/'+task.id)).body;
  assert.equal(snapshot.status,'succeeded');
  assert.equal(snapshot.results[0].processing.preset,'dola-tracked-glyph-v1');
  const receipt=JSON.parse(fs.readFileSync(path.join(f.root,'generated',item.job_id+'.repaired.mp4.delivery.json')));
  assert.equal(receipt.requested_ratio,'9:16');
  assert.deepEqual([receipt.media.width,receipt.media.height],[720,1280]);
  assert.equal(digest(fs.readFileSync(source)),originalHash);
  const response=await fetch(snapshot.results[0].video_url);
  assert.equal(response.status,200);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())),snapshot.results[0].sha256);
  assert.equal((await f.app.store.listJobs()).length,1);
  assert.equal((await f.app.store.getJob(item.job_id)).status,'success');
  await assert.rejects(f.app.partnerApi.store.retryDelivery(task.id,Date.now()),/DELIVERY_NOT_RETRYABLE/);
});

test('delivery retry refuses callback-enabled tasks and platform generation failures',async t=>{
  const callback='https://hooks.example.com/videos';
  const f=await fixture(t,{partnerApi:{callbackUrls:[callback]}});
  for(const [id,url] of [['callback',callback],['platform-failure','']]) {
    const created=await f.request('/v1/videos',{...input(id),model:'Dreamina Seedance 2.5',duration:30,delivery_mode:'watermark_repair',callback_url:url});
    assert.equal(created.status,202);
    await f.app.partnerApi.wake();
    const task=await f.app.partnerApi.store.get(created.body.task_id),item=task.items[0];
    await f.finish(item,url?'success':'failed');
    await f.app.partnerApi.store.updateItem(item,'failed',{errorCode:'WATERMARK_REPAIR_UNSUPPORTED_LAYOUT'},Date.now());
    await assert.rejects(f.app.partnerApi.store.retryDelivery(task.id,Date.now()),new RegExp(url?'CALLBACK_COORDINATION':'DELIVERY_NOT_RETRYABLE'));
    assert.equal((await f.app.partnerApi.store.get(task.id)).state,'failed');
  }
});

test("packaged Python and Node clients submit, poll and verify downloaded bytes", async t => {
  const f = await fixture(t);
  const run = promisify(execFile);
  const python = process.env.PARTNER_TEST_PYTHON || (process.platform === 'win32' ? 'python' : '/opt/venv/bin/python');
  const options = { cwd: f.root, env: { ...process.env, PARTNER_API_KEY: key, PARTNER_API_BASE_URL: f.url+'/v1' }, timeout: 20000 };
  for (const [name, command, script] of [
    ['python', python, fileURLToPath(new URL('../docs/examples/partner-client.py', import.meta.url))],
    ['node', process.execPath, fileURLToPath(new URL('../docs/examples/partner-client.mjs', import.meta.url))],
  ]) {
    const taskFile = path.join(f.root, name+'-task.json');
    fs.writeFileSync(taskFile, JSON.stringify(input('sdk-'+name)));
    const created = JSON.parse((await run(command,[script,'submit',taskFile],options)).stdout);
    assert.equal(created.terminal,false);
    assert.equal(created.poll_after_seconds,60);
    const pendingArgs=[script,'wait',created.task_id,'--timeout','0.5'];
    const pending=JSON.parse((await run(command,pendingArgs,options)).stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(pending.terminal,false);assert.equal(pending.wait_expired,true);
    const journal=fs.readFileSync(path.join(f.root,'.symphony-tasks',created.task_id+'.json'),'utf8');
    assert.equal(JSON.parse(journal).task_id,created.task_id);assert.ok(!journal.includes(key));assert.ok(!journal.includes('signature='));
    await f.app.partnerApi.wake();
    const task = await f.app.partnerApi.store.get(created.task_id);
    await f.finish(task.items[0]);
    await f.app.partnerApi.wake();
    const output = path.join(f.root, name+'-downloads');
    const args = name === 'python' ? [script,'wait',task.id,'--output',output] : [script,'wait',task.id,output];
    const downloaded = JSON.parse((await run(command,args,options)).stdout);
    assert.equal(downloaded.status, 'succeeded');
    assert.equal(downloaded.files.length, 1);
    assert.equal(digest(fs.readFileSync(downloaded.files[0])), digest(mp4));
  }
});

test("private configuration enables only partner credentials and rejects unsafe options without leaking values", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-partner-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "private.json");
  const saved = { apiKey: key, downloadSecret, webhookSecret, baseUrl: "https://192.0.2.10/v1",
    callbackUrls: [], defaultCallbackUrl: "" };
  fs.writeFileSync(configFile, JSON.stringify(saved));
  const config = configurePartnerApi({ configFile });
  assert.equal(config.enabled, true);
  assert.equal(config.apiKey, key);
  assert.equal(config.baseUrl, saved.baseUrl);
  assert.equal(config.allowLocalCallbacks, false);
  fs.writeFileSync(configFile, JSON.stringify({ ...saved, allowLocalCallbacks: true }));
  assert.throws(() => configurePartnerApi({ configFile }), /^Error: INVALID_PARTNER_CONFIG_FILE$/);
  fs.writeFileSync(configFile, JSON.stringify({ ...saved, apiKey: "short" }));
  assert.throws(() => configurePartnerApi({ configFile }), /PARTNER_SECRET_MUST_HAVE_32_TO_512_NONSPACE_CHARACTERS/);
});
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-partner-"));
  const port = await freePort();
  const options = { port, databasePath: path.join(root, "db.sqlite"), uploadRoot: path.join(root, "uploads"),
    generatedRoot: path.join(root, "generated"), workspaceRoot: root,
    pythonExecutable: path.join(root, "disabled-worker"), workerPath: path.join(root, "disabled-worker.py"),
    partnerApi: { apiKey: key, downloadSecret, webhookSecret, intervalMs: 60_000, ...overrides.partnerApi },
    ...overrides };
  if (overrides.partnerApi) options.partnerApi = { apiKey: key, downloadSecret, webhookSecret,
    intervalMs: 60_000, ...overrides.partnerApi };
  overrides.prepare?.(options, root);
  let app = (await createWorkbenchServer(options));
  await app.listen();
  await app.partnerApi.wake();
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  return { root, port, url, get app() { return app; },
    async restart() { await app.close(); app = (await createWorkbenchServer(options)); await app.listen(); await app.partnerApi.wake(); },
    async request(route, body, headers = {}) {
      const multipart = body instanceof FormData;
      const response = await fetch(url + route, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${key}`, Connection: "close",
          ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }), ...headers },
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async finish(item, state = "success") {
      let resultPath;
      if (state === "success") {
        resultPath = path.join(root, "generated", `${item.job_id}.mp4`);
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, mp4);
        fs.writeFileSync(`${resultPath}.delivery.json`, JSON.stringify(originalReceipt));
      }
      (await app.store.updateJob(item.job_id, { status: state, resultPath,
        errorCode: state === "failed" ? "BROWSER_AUTOMATION_FAILED" : undefined }));
    },
  };
}

test("unverified files are withheld and old signed links cannot bypass the original check", async (t) => {
  const f = await fixture(t);
  const missing = await f.request("/v1/videos", input("missing-original-proof"));
  await f.app.partnerApi.wake();
  const pending = await f.app.partnerApi.store.get(missing.body.task_id);
  await f.finish(pending.items[0]);
  const firstPath = path.join(f.root, "generated", `${pending.items[0].job_id}.mp4`);
  fs.unlinkSync(`${firstPath}.delivery.json`);
  await f.app.partnerApi.wake();
  const rejected = await f.request(`/v1/videos/${pending.id}`);
  assert.equal(rejected.body.status, "failed");
  assert.equal(rejected.body.results[0].error.code, "WATERMARK_FREE_RESULT_REQUIRED");
  assert.equal(rejected.body.results[0].video_url, undefined);

  const accepted = await f.request("/v1/videos", input("verified-original-proof"));
  await f.app.partnerApi.wake();
  const task = await f.app.partnerApi.store.get(accepted.body.task_id);
  await f.finish(task.items[0]);
  await f.app.partnerApi.wake();
  const result = await f.request(`/v1/videos/${task.id}`);
  assert.equal(result.body.results[0].watermark_free, true);
  const signedUrl = result.body.results[0].video_url;
  const resultPath = path.join(f.root, "generated", `${task.items[0].job_id}.mp4`);
  fs.writeFileSync(`${resultPath}.delivery.json`, JSON.stringify({ ...originalReceipt, sha256: "0".repeat(64) }));
  const withheld = await f.request(`/v1/videos/${task.id}`);
  assert.equal(withheld.body.results[0].video_url, null);
  assert.equal(withheld.body.results[0].watermark_free, false);
  const download = await fetch(signedUrl);
  assert.equal(download.status, 409);
  assert.equal((await download.json()).error.code, "WATERMARK_FREE_RESULT_REQUIRED");
});

test("partner authentication, strict parameters, and same-request image upload with atomic idempotency", async (t) => {
  const f = await fixture(t);
  const unauthorized = await f.request("/v1/models", undefined, { Authorization: "Bearer incorrect" });
  assert.equal(unauthorized.status, 401);
  const models = await f.request("/v1/models");
  assert.equal(models.body.models.length, 3);
  const spec = await f.request("/v1/openapi.json");
  assert.equal(spec.status, 200);
  assert.equal(spec.body.openapi, "3.1.0");
  assert.equal(spec.body.servers[0].url, `${f.url}/v1`);
  assert.deepEqual(spec.body.components.schemas.TaskRequest.properties.model.enum,
    models.body.models.map((model) => model.model));
  for (const change of [{ resolution: "1080p" }, { count: 0 }, { count: "2" }, { prompt: " " },
    { client_task_id: "../unsafe" }, { negative_prompt: "a".repeat(2001) }]) {
    assert.equal((await f.request("/v1/videos", { ...input("invalid"), ...change })).status, 400);
  }
  assert.equal((await f.request("/v1/videos", { ...input("invalid-model"), duration: 12 })).status, 422);
  assert.equal((await f.request("/v1/videos", { ...input("invalid-url"), callback_url: "https://receiver.example/result" })).status, 422);
  const make = (bytes = png) => {
    const form = new FormData();
    form.set("task", JSON.stringify(input("upload-1", 5)));
    form.append("images", new Blob([bytes], { type: "image/png" }), "reference.png");
    form.append("images", new Blob([png], { type: "image/png" }), "second.png");
    return form;
  };
  const submissions = await Promise.all([f.request("/v1/videos", make()), f.request("/v1/videos", make())]);
  assert.deepEqual(submissions.map((r) => r.status).sort(), [200, 202]);
  assert.equal(submissions[0].body.task_id, submissions[1].body.task_id);
  const id = submissions[0].body.task_id;
  await f.app.partnerApi.wake();
  let task = (await f.app.partnerApi.store.get(id));
  assert.equal(task.items.filter((i) => i.job_id).length, 2);
  assert.equal(task.assets.length, 2);
  assert.deepEqual(fs.readFileSync(task.assets[0].path), png);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "uploads", "partner")), [id]);
  const job = (await f.app.store.getJob(task.items[0].job_id));
  assert.equal(job.negativePrompt, input("x").negative_prompt);
  assert.equal(job.concurrency, 1);
  assert.equal(job.batchSize, 5);
  assert.equal((await f.request("/v1/videos", make(Buffer.concat([png, Buffer.from("changed")])))).status, 409);
  await f.restart();
  assert.equal((await f.request("/v1/videos", make())).body.task_id, id);
  task = (await f.app.partnerApi.store.get(id));
  assert.equal(task.items.filter((i) => i.job_id).length, 2);
  assert.equal(task.assets.length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, "db.sqlite")).includes(Buffer.from(key)), false);
});

test("five outputs advance 2+2+1, persist callback batches, and stream original bytes with renewable links", async (t) => {
  let time = Date.now();
  const f = await fixture(t, { partnerNow: () => time });
  const accepted = await f.request("/v1/videos", input("five", 5));
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.results.length, 5);
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  let task = (await f.app.partnerApi.store.get(id));
  await f.finish(task.items[0]);
  await f.app.partnerApi.wake();
  assert.equal((await f.app.partnerApi.store.get(id)).items.filter((i) => i.job_id).length, 2);
  await f.finish(task.items[1]);
  await f.app.partnerApi.wake();
  task = (await f.app.partnerApi.store.get(id));
  assert.equal(task.items.filter((i) => i.job_id).length, 4);
  assert.equal((await f.app.partnerApi.store.deliverySummary(id)).length, 1);
  await f.finish(task.items[2], "failed");
  await f.finish(task.items[3]);
  await f.app.partnerApi.wake();
  task = (await f.app.partnerApi.store.get(id));
  assert.equal(task.items.filter((i) => i.job_id).length, 5);
  await f.finish(task.items[4]);
  await f.app.partnerApi.wake();
  let response = await f.request(`/v1/videos/${id}`);
  assert.equal(response.body.status, "partially_succeeded");
  assert.equal(response.body.completed_count, 5);
  assert.equal(response.body.succeeded_count, 4);
  assert.equal(response.body.webhooks.length, 3);
  assert.equal(response.body.results[2].error.code, "GENERATION_FAILED");
  assert.equal(response.body.results[0].sha256, digest(mp4));
  const signed = response.body.results[0].video_url;
  const all = await fetch(signed);
  assert.equal(all.status, 200);
  assert.deepEqual(Buffer.from(await all.arrayBuffer()), mp4);
  const partial = await fetch(signed, { headers: { Range: "bytes=5-19" } });
  assert.equal(partial.status, 206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), mp4.subarray(5, 20));
  const suffix = await fetch(signed, { headers: { Range: "bytes=-4" } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), mp4.subarray(-4));
  const head = await fetch(signed, { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), mp4.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(signed, { headers: { Range: "bytes=900-999" } })).status, 416);
  assert.equal((await fetch(signed, { headers: { Range: "bytes=0-1,3-4" } })).status, 416);
  const tampered = new URL(signed); tampered.searchParams.set("signature", "0".repeat(64));
  assert.equal((await fetch(tampered)).status, 403);
  time += DAY + 1000;
  assert.equal((await fetch(signed)).status, 403);
  response = await f.request(`/v1/videos/${id}`);
  assert.notEqual(response.body.results[0].video_url, signed);
  assert.equal((await fetch(response.body.results[0].video_url)).status, 200);
  await f.restart();
  assert.equal((await f.app.partnerApi.store.deliverySummary(id)).length, 3);
  assert.equal((await f.app.store.listJobs()).length, 5);
  time += 7 * DAY;
  await f.app.partnerApi.wake();
  assert.equal((await f.request(`/v1/videos/${id}`)).body.results[0].video_url, null);
  const expired = await fetch(`${f.url}/v1/videos/${id}/results/1`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(expired.status, 410);
  assert.equal(fs.existsSync(path.join(f.root, "generated", `${task.items[0].job_id}.mp4`)), false);
});

test("cancel stops future rounds and account failover while preserving a submitted result", async (t) => {
  const f = await fixture(t);
  const accepted = await f.request("/v1/videos", input("cancel-active", 5));
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  for (const [accountId, balance] of [["high", 10], ["low", 5]]) {
    (await f.app.store.ensureAccount({ id: accountId, label: accountId, loginType: "doubao", service: "doubao",
      workerId: "pc", profilePath: path.join(f.root, accountId), status: "auth_required" }));
    (await f.app.store.saveVerification(accountId, { ok: true, loggedIn: true,
      modelsObserved: ["Seedance 2.0 Mini"], remainingCredits: balance, totalCredits: 10,
      creditPageReady: true, createPageReady: true }));
  }
  const first = (await f.app.store.claimNextQueuedJob());
  const second = (await f.app.store.claimNextQueuedJob());
  assert.equal(first.account.id, "high");
  (await f.app.store.updateJob(first.job.id, { status: "submitting" }));
  (await f.app.store.updateJob(second.job.id, { status: "submitted" }));
  const cancelled = await f.request(`/v1/videos/${id}/cancel`, {});
  assert.equal(cancelled.body.status, "cancelling");
  assert.equal(cancelled.body.cancelled_count, 3);
  const failed = (await f.app.store.handleDispatchFailure(first.job.id, first.account.id, "DOUBAO_FREE_QUOTA_EXHAUSTED", { quotaExhausted: true }));
  assert.equal(failed.status, "cancelled");
  assert.equal((await f.app.store.getAccount("high")).creditsRemaining, 0);
  const task = (await f.app.partnerApi.store.get(id));
  await f.finish(task.items.find((i) => i.job_id === second.job.id));
  await f.app.partnerApi.wake();
  const result = await f.request(`/v1/videos/${id}`);
  assert.equal(result.body.status, "cancelled");
  assert.equal(result.body.succeeded_count, 1);
  assert.equal(result.body.cancelled_count, 4);
  assert.equal((await f.app.store.listJobs()).length, 2);
  assert.equal((await f.app.store.claimNextQueuedJob()), null);
  assert.equal((await f.request(`/v1/videos/${id}/cancel`, {})).body.status, "cancelled");
});

test("ambiguous submission survives restart as reconciling without duplicate generation", async (t) => {
  const f = await fixture(t);
  const accepted = await f.request("/v1/videos", input("uncertain", 4));
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  let task = (await f.app.partnerApi.store.get(id));
  (await f.app.store.updateJob(task.items[0].job_id, { status: "submitting" }));
  await f.finish(task.items[1]);
  await f.restart();
  task = (await f.app.partnerApi.store.get(id));
  assert.equal(task.state, "reconciling");
  assert.equal(task.items.filter((i) => i.job_id).length, 2);
  assert.equal((await f.request("/v1/videos", input("uncertain", 4))).status, 200);
});

test("webhook retries persist across restart with the same ID/body, HMAC, and no new jobs", async (t) => {
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (JSON.parse(raw).event === 'video.task.progress') { res.writeHead(204);res.end();return; }
    received.push({ raw, headers: req.headers });
    res.writeHead(received.length === 1 ? 500 : 204); res.end();
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const callback = `http://127.0.0.1:${receiver.address().port}/result`;
  let time = Date.now();
  const f = await fixture(t, { partnerNow: () => time,
    partnerApi: { allowLocalCallbacks: true, callbackUrls: [callback] } });
  const accepted = await f.request("/v1/videos", { ...input("callback", 2), callback_url: callback });
  const id = accepted.body.task_id;
  await f.app.partnerApi.wake();
  for (const item of (await f.app.partnerApi.store.get(id)).items) await f.finish(item);
  await f.app.partnerApi.wake();
  await f.app.partnerApi.deliver();
  assert.equal(received.length, 1);
  const event = JSON.parse(received[0].raw);
  assert.equal(event.is_final, true);
  assert.equal(event.results.length, 2);
  assert.equal(event.batch_index, 1);
  assert.equal(event.client_task_id, "callback");
  assert.equal(received[0].headers["x-webhook-signature"], `sha256=${signature(webhookSecret,
    `${received[0].headers["x-webhook-timestamp"]}.${received[0].raw}`)}`);
  await f.restart();
  assert.equal(received.length, 1);
  time += 11_000;
  await f.app.partnerApi.deliver();
  assert.equal(received.length, 2);
  assert.equal(received[0].raw, received[1].raw);
  assert.equal(received[0].headers["x-webhook-id"], received[1].headers["x-webhook-id"]);
  assert.equal((await f.app.partnerApi.store.deliverySummary(id)).find(d=>d.event_id===event.event_id).state, "delivered");
  assert.equal((await f.app.store.listJobs()).length, 2);
});

test("unconfigured API stays closed, queue cap and rate limit return actionable errors", async (t) => {
  const closed = await fixture(t, { partnerApi: { apiKey: "", downloadSecret: "", webhookSecret: "" } });
  assert.equal((await closed.request("/v1/models")).body.error.code, "API_NOT_CONFIGURED");
  const capped = await fixture(t, { partnerApi: { maxPendingTasks: 1 } });
  const first = await capped.request("/v1/videos", input("cap-1"));
  assert.equal(first.status, 202);
  assert.equal((await capped.request("/v1/videos", input("cap-1"))).status, 200);
  assert.equal((await capped.request("/v1/videos", input("cap-2"))).body.error.code, "QUEUE_FULL");
  assert.equal((await capped.request(`/v1/videos/${first.body.task_id}/cancel`, {})).body.status, "cancelled");
  assert.equal((await capped.request("/v1/videos", input("cap-2"))).status, 202);
  const limited = await fixture(t, { partnerApi: { requestsPerMinute: 1 } });
  assert.equal((await limited.request("/v1/models")).status, 200);
  const exceeded = await limited.request("/v1/models");
  assert.equal(exceeded.status, 429);
  assert.ok(Number(exceeded.headers.get("retry-after")) > 0);
});

test("accepted text task executes through the shared browser queue and finishes all rounds", async (t) => {
  const f = await fixture(t, { prepare(options, root) {
    options.pythonExecutable = process.execPath;
    options.workerPath = path.join(root, "worker.mjs");
    options.doubaoVerifierPath = path.join(root, "verify.mjs");
    options.schedulerIntervalMs = 25;
    options.partnerApi.intervalMs = 25;
    fs.mkdirSync(path.join(root, "profile"));
    fs.writeFileSync(options.doubaoVerifierPath, `console.log(JSON.stringify({ ok: true, loggedIn: true,
      creditPageReady: true, createPageReady: true, remainingCredits: 8, totalCredits: 10,
      modelsObserved: ["Seedance 2.0 Mini"], stage: "completed" }));`);
    fs.writeFileSync(options.workerPath, `import fs from "node:fs"; import path from "node:path";
      let data=""; for await (const chunk of process.stdin) data+=chunk; const job=JSON.parse(data);
      if(job.referenceAssets.length || job.negativePrompt !== "不要文字和水印") process.exit(1);
      console.log(JSON.stringify({stage:"submitting"}));
      console.log(JSON.stringify({stage:"submitted",remoteUrl:"https://www.doubao.com/chat/123456"}));
      fs.mkdirSync(path.dirname(job.outputPath),{recursive:true});
      fs.writeFileSync(job.outputPath,Buffer.from("${mp4.toString("base64")}","base64"));
      fs.writeFileSync(job.outputPath+".delivery.json",JSON.stringify(${JSON.stringify(originalReceipt)}));
      console.log(JSON.stringify({stage:"success",resultPath:job.outputPath}));`);
  } });
  (await f.app.store.ensureAccount({ id: "browser", label: "Browser", loginType: "doubao", service: "doubao",
    workerId: "pc", profilePath: path.join(f.root, "profile"), status: "auth_required" }));
  (await f.app.store.saveVerification("browser", { ok: true, loggedIn: true, modelsObserved: ["Seedance 2.0 Mini"],
    remainingCredits: 9, totalCredits: 10, creditPageReady: true, createPageReady: true }));
  fs.mkdirSync(path.join(f.root,'profile-2'));
  await f.app.store.ensureAccount({id:'browser-2',label:'Browser 2',loginType:'doubao',service:'doubao',
    workerId:'pc',profilePath:path.join(f.root,'profile-2')});
  await f.app.store.saveVerification('browser-2',{ok:true,loggedIn:true,modelsObserved:['Seedance 2.0 Mini']});
  const accepted = await f.request("/v1/videos", input("real-queue", 3));
  let task;
  const deadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    task = (await f.app.partnerApi.store.get(accepted.body.task_id));
  } while (!task.finished_at && Date.now() < deadline);
  assert.equal(task.state, "succeeded");
  assert.equal(task.items.length, 3);
  const jobs=await f.app.store.listJobs();
  assert.ok(['browser','browser-2'].every(id=>jobs.filter(j=>j.accountId===id).length<=2));
  assert.equal((await f.app.partnerApi.store.deliverySummary(task.id)).length, 2);
});
