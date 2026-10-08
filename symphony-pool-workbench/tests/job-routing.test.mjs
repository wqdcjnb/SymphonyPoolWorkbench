import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVideoTarget, hasCompatibleService, VIDEO_MODELS, videoTargetBlocker } from '../lib/job-routing.mjs';

const accounts = [
  { id: 'doubao-1', service: 'doubao', status: 'ready', models: ['Seedance 2.0 Fast', 'Seedance 2.0 Mini'], creditsRemaining: 6, lastUsedAt: 200 },
  { id: 'doubao-2', service: 'doubao', status: 'ready', models: ['Seedance 2.0 Mini'], creditsRemaining: 10, lastUsedAt: 0 },
  { id: 'dola-1', service: 'dola', status: 'ready', models: ['Dreamina Seedance 2.5'], creditsRemaining: 10 },
];
const job = (durationSeconds = 15) => ({ model: 'auto', durationSeconds, aspectRatio: '9:16', referenceAssets: [] });

test('queue reasons distinguish login, account occupancy, quota and platform matching', () => {
  const dola = accounts[2];
  assert.equal(videoTargetBlocker(job(30), [accounts[0]]), 'NO_COMPATIBLE_ACCOUNT');
  assert.equal(videoTargetBlocker(job(30), [dola, {...dola,id:'dola-2',busy:true}]), null);
  assert.equal(videoTargetBlocker(job(30), [{...dola,busy:true},{...dola,id:'dola-2',status:'auth_required'}]), 'ACCOUNT_ALREADY_RUNNING');
  assert.equal(videoTargetBlocker(job(30), [1,2].map(i=>({...dola,id:'dola-'+i,status:'auth_required'}))), 'ACCOUNTS_LOGIN_REQUIRED');
  assert.equal(videoTargetBlocker(job(30), [{...dola,status:'auth_required',attentionReason:'DOLA_HUMAN_VERIFICATION_REQUIRED'}]), 'ACCOUNTS_VERIFICATION_REQUIRED');
  assert.equal(videoTargetBlocker(job(30), [{...dola,creditsRemaining:3}]), 'ACCOUNT_CREDITS_INSUFFICIENT');
  assert.equal(videoTargetBlocker(job(30), [{...dola,status:'degraded'}]), 'ACCOUNTS_NOT_READY');
  assert.equal(videoTargetBlocker(job(30), [{...dola,models:[]}]), 'MODEL_NOT_VERIFIED_FOR_ACCOUNT');
});

test('catalog contains only the three requested models with fixed durations and six fixed ratios', () => {
  assert.deepEqual(VIDEO_MODELS, { doubao: ['Seedance 2.0 Fast', 'Seedance 2.0 Mini'], dola: ['Dreamina Seedance 2.5'] });
  for (const [service, models] of Object.entries(VIDEO_MODELS)) for (const model of models) {
    const duration = service === 'doubao' ? 15 : 30;
    for (const ratio of ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9']) assert.equal(hasCompatibleService(service, model, duration, 0, ratio), true);
    assert.equal(hasCompatibleService(service, model, duration, 0, 'auto'), false);
    for (const other of [5, 10, 12, duration === 15 ? 30 : 15]) assert.equal(hasCompatibleService(service, model, other), false);
    for (const ratio of ['2:1', '5:4', 'unknown']) assert.equal(hasCompatibleService(service, model, duration, 0, ratio), false);
  }
  for (const model of ['Video 1.5 Pro', 'Dreamina Seedance 1.0', 'Dreamina Seedance 2.0 Fast']) assert.equal(hasCompatibleService(null, model, 30), false);
});

test('automatic selection uses duration, verified models and available credits', () => {
  assert.equal(resolveVideoTarget(job(), accounts).account.id, 'doubao-2');
  assert.equal(resolveVideoTarget(job(30), accounts).model, 'Dreamina Seedance 2.5');
  assert.equal(resolveVideoTarget({ ...job(), model: 'Seedance 2.0 Fast' }, accounts).account.id, 'doubao-1');
  assert.equal(resolveVideoTarget({ ...job(), referenceAssets: Array(9).fill('image.png') }, accounts).account.service, 'doubao');
  for (const count of [1, 9]) assert.equal(resolveVideoTarget({ ...job(30), referenceAssets: Array(count).fill('image.png') }, accounts).account.service, 'dola');
  assert.throws(() => resolveVideoTarget({ ...job(30), referenceAssets: Array(10).fill('image.png') }, accounts), /JOB_PARAMETERS_INVALID/);
  assert.throws(() => resolveVideoTarget({ ...job(), accountId: 'dola-1' }, accounts), /JOB_PARAMETERS_INVALID/);
});

test('dispatch refuses insufficient or unknown credits and busy accounts', () => {
  for (const [base, duration, cost] of [[accounts[0], 15, 2], [accounts[2], 30, 4]]) {
    for (const creditsRemaining of [0, cost - 1, null]) assert.throws(() => resolveVideoTarget(job(duration), [{ ...base, creditsRemaining }]), /NO_ELIGIBLE_ACCOUNT/);
    assert.equal(resolveVideoTarget(job(duration), [{ ...base, creditsRemaining: cost }]).account.id, base.id);
    assert.throws(() => resolveVideoTarget({ ...job(duration), accountId: base.id }, [{ ...base, busy: true }]), /ACCOUNT_ALREADY_RUNNING/);
    assert.throws(() => resolveVideoTarget({ ...job(duration), accountId: base.id }, [{ ...base, status: 'cooling' }]), /ACCOUNT_NOT_READY/);
  }
});

test('reference videos use Doubao Fast with up to nine optional images', () => {
  const supported = (service, model, count) => hasCompatibleService(service, model, 15, count, '16:9', 'reference_to_video');
  assert.equal(supported('doubao', 'Seedance 2.0 Fast', 9), true);
  assert.equal(supported('doubao', 'Seedance 2.0 Fast', 10), false);
  assert.equal(supported('doubao', 'Seedance 2.0 Mini', 0), false);
  assert.equal(supported('dola', 'auto', 0), false);
  assert.equal(resolveVideoTarget({ ...job(), mode: 'reference_to_video' }, accounts).model, 'Seedance 2.0 Fast');
});

test('collecting historical output can use its original model with no remaining credits', () => {
  const selected = resolveVideoTarget({ ...job(5), model: 'Dreamina Seedance 2.0 Fast', accountId: 'dola-1', collectOnly: true }, [{ ...accounts[2], creditsRemaining: 0 }]);
  assert.equal(selected.model, 'Dreamina Seedance 2.0 Fast');
  assert.equal(selected.account.id, 'dola-1');
});
