// Estimates describe platform generation only; they never change task state.
export const HISTORY_WINDOW_MS = 30 * 86_400_000;
export const HISTORY_MIN_SAMPLES = 2;
const NORMAL_WAIT = new Set(['PLATFORM_RESULT_PENDING','DOLA_GENERATION_TIMEOUT',
  'DOUBAO_GENERATION_TIMEOUT','PLATFORM_GENERATION_TIMEOUT']);
export const estimateKey = (model, duration) => JSON.stringify([model, Number(duration)]);

export function generationHistory(jobs, events) {
  const grouped = new Map();
  for (const event of events) {
    if (!grouped.has(event.job_id)) grouped.set(event.job_id, []);
    grouped.get(event.job_id).push(event);
  }
  const samples = new Map();
  for (const job of jobs) {
    const rows = grouped.get(job.id) || [];
    const first = type => Math.min(...rows.filter(e => e.event_type === type).map(e => Number(e.created_at)));
    const began = first('job.generating'), collected = first('job.collecting');
    // Use the first result observation, not final download/delivery completion.
    if (!Number.isFinite(began) || !Number.isFinite(collected) || collected - began < 5_000) continue;
    const interrupted = rows.some(e => {
      if (Number(e.created_at) < began || Number(e.created_at) > collected) return false;
      if (e.event_type === 'job.conversation_restarted') return true;
      if (e.event_type !== 'job.reconciling') return false;
      try { return !NORMAL_WAIT.has(JSON.parse(e.details_json || '{}').errorCode); }
      catch { return true; }
    });
    if (interrupted) continue;
    const key = estimateKey(job.model, job.duration_seconds);
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push({ seconds: Math.ceil((collected - began) / 1_000), collected });
  }
  return new Map([...samples].map(([key, rows]) => [key,
    rows.sort((a,b) => b.collected - a.collected).slice(0,20).map(r => r.seconds)]));
}

export function generationEstimate(item, progress, time = Date.now()) {
  const base = { status:'unavailable',source:null,scope:'platform_generation',sample_count:0,
    estimated_total_seconds:null,estimated_remaining_seconds:null,estimated_completion_at:null,
    started_at:null,calculated_at:new Date(time).toISOString() };
  if (['completed','failed'].includes(progress.platform_status)
    || ['completed','partially_completed','failed','cancelled','downloading','processing','download_blocked'].includes(progress.phase)) {
    return {...base,status:'not_applicable'};
  }
  if (!['generating','waiting_result'].includes(progress.phase)) return base;
  const started = Number(item.generationStartedAt);
  if (!Number.isSafeInteger(started) || started <= 0 || started > time) return base;
  base.started_at = new Date(started).toISOString();
  const samples = (item.generationSamples || []).filter(v => Number.isSafeInteger(v) && v >= 5).sort((a,b) => a-b);
  base.sample_count = samples.length;
  if (samples.length < HISTORY_MIN_SAMPLES) return base;
  // The recent P80, rounded up to 30 seconds, is a forecast, not a deadline.
  const seconds = Math.ceil(samples[Math.ceil(samples.length * 0.8) - 1] / 30) * 30;
  const finish = started + seconds * 1_000;
  const exceeded = time >= finish;
  return {...base,status:exceeded?'exceeded':'available',source:'recent_history',
    estimated_total_seconds:seconds,estimated_remaining_seconds:exceeded?null:Math.ceil((finish-time)/1_000),
    estimated_completion_at:new Date(finish).toISOString()};
}

export function stableGenerationEstimate(value) {
  // Countdown ticks are not webhook events; changed predictions and exceeding
  // a prediction are meaningful updates. Neither produces a task timeout.
  return Object.fromEntries(['status','source','scope','sample_count','estimated_total_seconds',
    'estimated_completion_at','started_at'].map(key => [key,value[key]]));
}
