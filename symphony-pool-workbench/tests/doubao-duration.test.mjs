import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const durationSource = fs.readFileSync(new URL('../../tools/doubao_duration.js', import.meta.url), 'utf8');
const jointSource = fs.readFileSync(new URL('../../tools/joint_submission.js', import.meta.url), 'utf8');
const endpoint = 'https://www.doubao.com/samantha/chat/completion';
const prompt = '请生成 15 秒的小猫视频，保留参考图片。';
const text = value => ({ block_type: 10000, content: { text_block: { text: value } } });
const reference = { block_type: 10052, content: { attachment_block: { attachments: [
  { image: { uri: 'existing-upload', width: 720, height: 1280 } },
  { video: { uri: 'reference-video', duration: 6 } },
] } } };
function payload(model='seedance_v2.0', depth=1) {
  let params = { duration: 10, ratio: '9:16', model, input_box_content: { user_input_content: prompt } };
  for (let i=0; i<depth; i++) params = JSON.stringify(params);
  return { chat_ability: { ability_type: 1, ability_param: params },
    messages: [{ local_message_id: 'ref', content_block: [reference] }, { local_message_id: 'text', content_block: [text(prompt)] }],
    option: { unique_key: 'original-idempotency-key', duration: 99 }, ext: { duration: 8 } };
}
function harness(model='Seedance 2.0 Fast', joint=false, confirmationOnly=false) {
  const calls=[];
  class XHR { open() {} send(body) { calls.push({ body }); } }
  const window = { location: { href: 'https://www.doubao.com/chat/create-image' },
    fetch: async(input, init) => {
      calls.push({ input, init, body: init?.body, signature: createHash('sha256').update(String(init?.body || '')).digest('hex') });
      return { ok: true };
    } };
  const config = { duration: 15, model, ratio: '9:16', confirmationOnly };
  const context = vm.createContext({ window, XMLHttpRequest: XHR, URL, Request, config,
    jointConfig: { service: 'doubao', prompt, images: 1, videos: 1 } });
  vm.runInContext('(' + durationSource + ')(config)', context);
  if (joint) vm.runInContext('(' + jointSource + ')(jointConfig)', context);
  return { calls, window, XHR };
}
const decode = value => { while (typeof value === 'string') value=JSON.parse(value); return value; };

test('Fast and Mini change only the generation duration, including encoded ability parameters', async()=>{
  for (const [label, model] of [['Seedance 2.0 Fast','seedance_v2.0'],['Seedance 2.0 Mini','seedance_v2.0_mini']]) {
    for (const depth of [0,1,2,3]) {
      const h=harness(label), original=payload(model,depth);
      await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(original)});
      const result=JSON.parse(h.calls[0].body);
      assert.equal(decode(result.chat_ability.ability_param).duration,15);
      assert.equal(decode(original.chat_ability.ability_param).duration,10);
      assert.deepEqual(result.messages,original.messages);
      assert.deepEqual(result.option,original.option);
      assert.deepEqual(result.ext,original.ext);
      assert.equal(decode(result.chat_ability.ability_param).model,model);
      assert.equal(decode(result.chat_ability.ability_param).input_box_content.user_input_content,prompt);
      assert.equal(h.window.__symphonyDoubaoDuration.patched,1);
    }
  }
});
test('the joint image/text guard composes with duration before the normal signer runs',async()=>{
  const h=harness('Seedance 2.0 Fast',true), original=payload();
  const signal=new AbortController().signal;
  await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(original),signal,credentials:'include'});
  const call=h.calls[0], result=JSON.parse(call.body);
  assert.equal(result.messages.length,1);
  assert.deepEqual(result.messages[0].content_block,original.messages.flatMap(m=>m.content_block));
  assert.equal(decode(result.chat_ability.ability_param).duration,15);
  assert.equal(result.messages[0].content_block[0].content.attachment_block.attachments[1].video.duration,6);
  assert.equal(call.signature,createHash('sha256').update(call.body).digest('hex'));
  assert.equal(call.init.signal,signal);assert.equal(call.init.credentials,'include');
});
test('Request and XHR submissions use the same duration adapter',async()=>{
  const h=harness(), body=JSON.stringify(payload());
  await h.window.fetch(new Request(endpoint,{method:'POST',body,headers:{'content-type':'application/json'}}));
  const xhr=new h.XHR();xhr.open('POST',endpoint);xhr.send(body);
  assert.equal(h.calls.length,2);
  for(const call of h.calls)assert.equal(decode(JSON.parse(call.body).chat_ability.ability_param).duration,15);
});
test('unknown schemas, model changes and ratio changes fail before network transmission',async()=>{
  const cases=[
    ['bad-json','DOUBAO_DURATION_PAYLOAD_UNSUPPORTED'],
    [JSON.stringify({messages:[]}),'DOUBAO_DURATION_PARAMETERS_MISSING'],
    [JSON.stringify(payload('wrong-model')),'PLATFORM_PARAMETERS_MISMATCH'],
    [JSON.stringify({...payload(),chat_ability:{ability_param:JSON.stringify({duration:10,model:'seedance_v2.0',ratio:'1:1'})}}),'PLATFORM_PARAMETERS_MISMATCH'],
    [JSON.stringify({...payload(),chat_ability:{ability_param:JSON.stringify({duration:15000,model:'seedance_v2.0',ratio:'9:16'})}}),'DOUBAO_DURATION_PARAMETERS_MISSING'],
  ];
  for(const [body,error] of cases){
    const h=harness();await assert.rejects(h.window.fetch(endpoint,{method:'POST',body}),{message:error});
    assert.equal(h.calls.length,0);assert.equal(h.window.__symphonyDoubaoDuration.error,error);
  }
});
test('only an exact follow-up confirmation can omit generation parameters',async()=>{
  const h=harness();
  const confirmation=JSON.stringify({messages:[{content_block:[text('确认生成')]}]});
  await assert.rejects(h.window.fetch(endpoint,{method:'POST',body:confirmation}));
  await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(payload())});
  await h.window.fetch(endpoint,{method:'POST',body:confirmation});
  assert.equal(h.calls[1].body,confirmation);
  assert.equal(h.window.__symphonyDoubaoDuration.confirmations,1);
  assert.equal(h.window.__symphonyDoubaoDuration.error,null);
  const different=JSON.stringify({messages:[{content_block:[text('另一个视频')]}]});
  await assert.rejects(h.window.fetch(endpoint,{method:'POST',body:different}));
  assert.equal(h.calls.length,2);
});
test('uploads, responses, Dola and unrelated domains are not modified',async()=>{
  const h=harness();
  for(const url of ['https://upload.doubao.com/video','https://www.dola.com/chat/completion','https://example.test/chat/completion']){
    await h.window.fetch(url,{method:'POST',body:'unchanged'});
  }
  await h.window.fetch(endpoint,{method:'GET'});
  assert.equal(h.calls.length,4);
  assert.equal(h.window.__symphonyDoubaoDuration.patched,0);
  for(const call of h.calls.slice(0,3))assert.equal(call.body,'unchanged');
});

test('recovered confirmation allows only the control message and cannot resend a prompt',async()=>{
  const h=harness('Seedance 2.0 Fast',false,true);
  const body=JSON.stringify({messages:[{content_block:[text('确认生成')]}]});
  await h.window.fetch(endpoint,{method:'POST',body});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].body,body);
  assert.equal(h.window.__symphonyDoubaoDuration.duration,15);
  for(const data of [payload(),{messages:[{content_block:[text('重新生成')]}]}]) {
    await assert.rejects(h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(data)}));
  }
  assert.equal(h.calls.length,1);
});

test('native slider text is removed without changing the original prompt or reference metadata',async()=>{
  const h=harness('Seedance 2.0 Fast',true), original=payload();
  const params=decode(original.chat_ability.ability_param);
  params.input_box_content.reply_message_format='生成视频：%s';
  original.chat_ability.ability_param=JSON.stringify(params);
  original.messages[1].content_block=[text(`生成视频：${prompt}，9:16，10s`)];
  await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(original)});
  const result=JSON.parse(h.calls[0].body);
  assert.equal(result.messages[0].content_block[1].content.text_block.text,`生成视频：${prompt}，9:16`);
  assert.equal(decode(result.chat_ability.ability_param).duration,15);
  assert.equal(decode(result.chat_ability.ability_param).input_box_content.user_input_content,prompt);
  assert.deepEqual(result.messages[0].content_block[0],reference);
  assert.equal(h.window.__symphonyDoubaoDuration.nativeDurationRemoved,1);
});

test('recovery can send a native video confirmation with the requested ability parameters',async()=>{
  const h=harness('Seedance 2.0 Fast',false,true), original=payload();
  const params=decode(original.chat_ability.ability_param);
  params.input_box_content={user_input_content:'确认生成',reply_message_format:'生成视频：%s'};
  original.chat_ability.ability_param=JSON.stringify(params);
  original.messages=[{content_block:[text('生成视频：确认生成，9:16，10s')]}];
  await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(original)});
  const result=JSON.parse(h.calls[0].body);
  assert.equal(result.messages[0].content_block[0].content.text_block.text,'生成视频：确认生成，9:16');
  assert.equal(decode(result.chat_ability.ability_param).duration,15);
  assert.equal(h.window.__symphonyDoubaoDuration.patched,1);
});

test('unknown generated prompt suffixes fail before transmission',async()=>{
  const h=harness(), original=payload();
  original.messages[1].content_block=[text(prompt+'，其他内容，10s')];
  await assert.rejects(h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(original)}),
    {message:'DOUBAO_DURATION_PAYLOAD_UNSUPPORTED'});
  assert.equal(h.calls.length,0);
});

test('an image request can send its native confirmation through both guards without re-uploading',async()=>{
  const h=harness('Seedance 2.0 Fast',true), initial=payload();
  await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(initial)});
  const confirmation=payload(), params=decode(confirmation.chat_ability.ability_param);
  params.input_box_content={user_input_content:'确认生成',reply_message_format:'生成视频：%s'};
  confirmation.chat_ability.ability_param=JSON.stringify(params);
  confirmation.messages=[{content_block:[text('生成视频：确认生成，9:16，10s')]}];
  await h.window.fetch(endpoint,{method:'POST',body:JSON.stringify(confirmation)});
  assert.equal(h.calls.length,2);
  const result=JSON.parse(h.calls[1].body);
  assert.equal(result.messages[0].content_block.length,1);
  assert.equal(result.messages[0].content_block[0].content.text_block.text,'生成视频：确认生成，9:16');
  assert.equal(h.window.__symphonyJointSubmission.accepted,1);
  assert.equal(h.window.__symphonyJointSubmission.error,null);
  assert.equal(h.window.__symphonyDoubaoDuration.patched,2);
});
