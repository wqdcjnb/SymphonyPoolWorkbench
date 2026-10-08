import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mentionsThirtySeconds, resolvePromptRatio } from '../lib/prompt-policy.mjs';
import { configurePartnerApi, validateTask } from '../lib/partner-protocol.mjs';

test('positive prompt ratio overrides the selected field; full-width, spacing and exclusions work', () => {
  for (const [prompt, expected] of [
    ['生成1:1方形商品视频', '1:1'], ['画幅 １ ： １', '1:1'], ['aspect ratio 16 ∶ 9', '16:9'],
    ['9:16竖屏，保持9:16', '9:16'], ['生成 1:1 视频，不要 9:16', '1:1'],
    ['Create 1:1 video; avoid 16:9', '1:1'], ['不要使用1:1', '16:9'],
    ['00:01–00:15 展示商品', '16:9'], ['01:01:01 timecode, ID_a1:1b', '16:9'],
    ['海边日落', '16:9'],
  ]) assert.equal(resolvePromptRatio(prompt, '16:9'), expected, prompt);
  assert.throws(() => resolvePromptRatio('1:1 或 9:16', '9:16'), /PROMPT_RATIO_CONFLICT/);
  assert.throws(() => resolvePromptRatio('画面比例 2:1', '9:16'), /PROMPT_RATIO_UNSUPPORTED/);
});

test('ratio precedence composes with duration precedence without changing source prompts', () => {
  const config = configurePartnerApi();
  const input = { client_task_id:'prompt-square', model:'Seedance 2.0 Mini', duration:15, ratio:'9:16',
    prompt:'生成30s、1:1方形商品广告', negative_prompt:'不要16:9、不要9:16' };
  const before = structuredClone(input);
  const result = validateTask(input, 1, config);
  assert.equal(result.ratio, '1:1');
  assert.equal(result.model, 'Dreamina Seedance 2.5');
  assert.equal(result.duration, 30);
  assert.equal(result.prompt, input.prompt);
  assert.deepEqual(input, before);
  assert.equal(validateTask({...input,prompt:'海边日落',negative_prompt:'1:1'},0,config).ratio,'9:16');
});

test('shared duration detection excludes product counts, identifiers and other durations', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/thirty-seconds.json', import.meta.url), 'utf8'));
  for (const [expected, texts] of Object.entries(cases)) {
    for (const text of texts) assert.equal(mentionsThirtySeconds(text), expected === 'yes', text);
  }
  assert.equal(mentionsThirtySeconds('时长:30s'), true);
  assert.equal(mentionsThirtySeconds('时长：30秒'), true);
  assert.equal(mentionsThirtySeconds(null, 30, {}, ''), false);
});

test('30-second text has priority over every requested model and duration; input remains intact', () => {
  const config = configurePartnerApi();
  for (const model of ['Seedance 2.0 Mini', 'Seedance 2.0 Fast', 'Dreamina Seedance 2.5', 'Old model']) {
    for (const field of ['prompt', 'negative_prompt']) {
      const input = { client_task_id: 'priority', model, duration: 15, ratio: '9:16',
        prompt: '蓝色商品', negative_prompt: '', [field]: '30s蓝色商品' };
      const before = structuredClone(input);
      const actual = validateTask(input, 1, config);
      assert.equal(actual.model, 'Dreamina Seedance 2.5');
      assert.equal(actual.duration, 30);
      assert.equal(actual.delivery_mode, 'watermark_repair');
      assert.equal(actual[field], before[field]);
      assert.deepEqual(input, before);
    }
  }
  const original = { client_task_id: 'counts', model: 'Seedance 2.0 Mini', duration: 15, ratio: '9:16', prompt: '30袋商品、30fps' };
  assert.equal(validateTask(original, 0, config).model, original.model);
  assert.throws(() => validateTask({ ...original, prompt: '30s商品', ratio: '2:1' }, 0, config), /组合/);
});
