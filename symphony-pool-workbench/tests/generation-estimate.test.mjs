import assert from 'node:assert/strict';
import test from 'node:test';
import {generationHistory, estimateKey, generationEstimate, stableGenerationEstimate} from '../lib/generation-estimate.mjs';

const started = Date.parse('2026-10-08T12:00:00Z');
const generating = {phase:'generating',platform_status:'generating'};
const item = {generationStartedAt:started,generationSamples:[178,190]};

test('only observed generation duration contributes; late downloads and interrupted samples do not', () => {
  const jobs = ['normal','delayed-download','human-pause','new-conversation','unobserved'].map(id=>({id,model:'Fast',duration_seconds:15}));
  const events = [];
  for (const [id,seconds] of [['normal',178],['delayed-download',190],['human-pause',7000],['new-conversation',9000]]) {
    events.push({job_id:id,event_type:'job.generating',created_at:started},
      {job_id:id,event_type:'job.collecting',created_at:started+seconds*1000},
      {job_id:id,event_type:'job.success',created_at:started+800_000_000});
  }
  events.push({job_id:'delayed-download',event_type:'job.reconciling',created_at:started+100_000,
    details_json:JSON.stringify({errorCode:'PLATFORM_RESULT_PENDING'})},
  {job_id:'delayed-download',event_type:'job.reconciling',created_at:started+200_000,
    details_json:JSON.stringify({errorCode:'DOUBAO_ORIGINAL_EXPORT_FAILED'})},
  {job_id:'human-pause',event_type:'job.reconciling',created_at:started+50_000,
    details_json:JSON.stringify({errorCode:'DOUBAO_HUMAN_VERIFICATION_REQUIRED'})},
  {job_id:'new-conversation',event_type:'job.conversation_restarted',created_at:started+50_000});
  const history = generationHistory(jobs,events);
  assert.deepEqual(history.get(estimateKey('Fast',15)).sort((a,b)=>a-b),[178,190]);
  assert.equal(history.has(estimateKey('Fast',30)),false);
});

test('countdown has a fixed expected time and ticking does not create webhook changes', () => {
  const first=generationEstimate(item,generating,started+10_000);
  const next=generationEstimate(item,generating,started+40_000);
  assert.equal(first.status,'available');assert.equal(first.source,'recent_history');
  assert.equal(first.estimated_total_seconds,210);assert.equal(first.estimated_remaining_seconds,200);
  assert.equal(next.estimated_remaining_seconds,170);
  assert.equal(first.estimated_completion_at,new Date(started+210_000).toISOString());
  assert.deepEqual(stableGenerationEstimate(first),stableGenerationEstimate(next));
});

test('exceeded estimates never report zero remaining or alter the generation status', () => {
  const estimate=generationEstimate(item,generating,started+3600_000);
  assert.equal(estimate.status,'exceeded');assert.equal(estimate.estimated_remaining_seconds,null);
  assert.equal(estimate.estimated_completion_at,new Date(started+210_000).toISOString());
  assert.deepEqual(generating,{phase:'generating',platform_status:'generating'});
});

test('queue, verification, missing history and completion do not invent a delivery deadline', () => {
  for (const phase of ['queued','submitting','awaiting_platform','awaiting_login','awaiting_verification','reconciling']) {
    const estimate=generationEstimate(item,{phase,platform_status:'unknown'},started+1000);
    assert.equal(estimate.status,'unavailable');assert.equal(estimate.estimated_completion_at,null);
    assert.equal(estimate.estimated_remaining_seconds,null);
  }
  assert.equal(generationEstimate({...item,generationSamples:[190]},generating,started+1000).status,'unavailable');
  assert.equal(generationEstimate({...item,generationStartedAt:null},generating,started+1000).status,'unavailable');
  for (const phase of ['completed','downloading','processing','download_blocked']) {
    assert.equal(generationEstimate(item,{phase,platform_status:'completed'},started+1000).status,'not_applicable');
  }
});
