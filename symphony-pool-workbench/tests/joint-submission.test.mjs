import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../../tools/joint_submission.js', import.meta.url), 'utf8');
const prompt = 'Animate the reference\nKeep the logo and colors.\nVideo settings: 30 seconds, aspect ratio 9:16.';
const imageBlock = (id) => ({ block_type: 10052, block_id: id, parent_id: '', content: { attachment_block: {
  attachments: [{ identifier: id, image: { uri: 'private-upload-'+id, width: 720, height: 1280 }, upload_status: 2 }],
} } });
const textBlock = (text=prompt) => ({ block_type: 10000, block_id: 'text', parent_id: '', content: { text_block: { text: 'Create a video: '+text } } });
function payload() {
  return { messages: [
    { local_message_id: 'reference-message', message_status: 0, content_block: [imageBlock('reference')] },
    { local_message_id: 'text-message', message_status: 0, content_block: [textBlock()] },
  ], option: { unique_key: 'same-idempotency-key', model_config: { model: 'keep-selected-model' } },
  chat_ability: { ability_param: JSON.stringify({ duration: 30, ratio: '9:16', input_box_content: { user_input_content: prompt } }) } };
}
function harness(service='dola', images=1, videos=0, selectedPrompt=prompt, confirmationText) {
  const calls=[];
  class XHR {
    open(...args) { this.openArgs=args; }
    send(body) { calls.push({ xhr: this, body }); }
  }
  const window={ location:{href:`https://www.${service}.com/chat/`},
    fetch:async(input, init)=>{calls.push({input,init,signature:createHash('sha256').update(String(init?.body||'')).digest('hex')});return {ok:true};} };
  const context=vm.createContext({window,XMLHttpRequest:XHR,URL,Request,config:{service,prompt:selectedPrompt,images,videos,confirmationText}});
  vm.runInContext('('+source+')(config)',context);
  return { window, calls, XHR, install(nextPrompt) { context.config={service,prompt:nextPrompt,images,videos};vm.runInContext('('+source+')(config)',context); },
    endpoint:`https://www.${service}.com/${service==='doubao'?'samantha/':''}chat/completion` };
}

test('Dola and Doubao send image and full text as one user message and preserve other request data', async()=>{
  for(const service of ['dola','doubao']) {
    const h=harness(service);const body=payload();
    const signal=new AbortController().signal;
    await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(body),credentials:'include',headers:{'content-type':'application/json'},signal});
    assert.equal(h.calls.length,1);
    const actual=JSON.parse(h.calls[0].init.body);
    assert.equal(actual.messages.length,1);
    assert.equal(actual.messages[0].local_message_id,'text-message');
    assert.deepEqual(actual.messages[0].content_block,body.messages.flatMap(m=>m.content_block));
    assert.deepEqual(actual.option,body.option);
    assert.deepEqual(actual.chat_ability,body.chat_ability);
    assert.equal(h.calls[0].init.credentials,'include');assert.equal(h.calls[0].init.signal,signal);
    assert.equal(h.calls[0].signature,createHash('sha256').update(h.calls[0].init.body).digest('hex'));
    assert.notEqual(h.calls[0].signature,createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    assert.equal(h.window.__symphonyJointSubmission.images,1);
    assert.equal(h.window.__symphonyJointSubmission.messages,1);
    assert.deepEqual(Array.from(h.window.__symphonyJointSubmission.attachmentMessageIds),['reference-message']);
  }
});
test('multiple references preserve order and an already joint message stays intact',async()=>{
  const h=harness('dola',2);const body=payload();
  body.messages[0].content_block.push(imageBlock('second'));
  await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(body)});
  const joint=JSON.parse(h.calls[0].init.body);
  assert.deepEqual(joint.messages[0].content_block,body.messages.flatMap(m=>m.content_block));
  await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(joint)});
  assert.deepEqual(JSON.parse(h.calls[1].init.body),joint);
});
test('missing text, lost references, extra references and unknown payloads cannot reach the network',async()=>{
  const cases=[
    [d=>d.messages.pop(),'MULTIMODAL_PROMPT_MISSING'],
    [d=>d.messages.shift(),'MULTIMODAL_ATTACHMENTS_MISMATCH'],
    [d=>d.messages[0].content_block.push(imageBlock('unexpected')),'MULTIMODAL_ATTACHMENTS_MISMATCH'],
    [d=>d.messages[1].content_block[0]=textBlock('different prompt'),'MULTIMODAL_PROMPT_MISSING'],
    [d=>d.messages[1].content_block[0].block_type=99999,'MULTIMODAL_UNSUPPORTED_PAYLOAD'],
    [d=>d.messages=[{content:'unknown-schema'}],'MULTIMODAL_UNSUPPORTED_PAYLOAD'],
  ];
  for(const [edit,code] of cases){const h=harness();const d=payload();edit(d);
    await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(d)}),{message:code});
    assert.equal(h.calls.length,0);assert.equal(h.window.__symphonyJointSubmission.error,code);
  }
});
test('Request inputs, XHR, and challenge resubmissions all keep the joint message',async()=>{
  const h=harness();const d=JSON.stringify(payload());
  const request=new Request(h.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:d});
  await h.window.fetch(request);
  assert.equal(JSON.parse(h.calls[0].init.body).messages.length,1);
  // The page guard remains installed after the worker disconnects for a CAPTCHA.
  await h.window.fetch(h.endpoint,{method:'POST',body:d});
  const xhr=new h.XHR();xhr.open('POST',h.endpoint,true);xhr.send(d);
  assert.equal(JSON.parse(h.calls[2].body).messages.length,1);
  assert.equal(h.window.__symphonyJointSubmission.accepted,3);
});
test('Dola native attachment-only retry restores its original full message and video settings',async()=>{
  for (const xhr of [false,true]) {
    const h=harness(), original=payload();
    await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(original)});
    const retry={...structuredClone(original),messages:[structuredClone(original.messages[0])],
      option:{...original.option,resend:true},chat_ability:{ability_param:'{}'}};
    if(xhr){const request=new h.XHR();request.open('POST',h.endpoint,true);request.send(JSON.stringify(retry));}
    else await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(retry)});
    const actual=JSON.parse(xhr?h.calls[1].body:h.calls[1].init.body);
    assert.equal(actual.messages.length,1);
    assert.equal(actual.messages[0].local_message_id,retry.messages[0].local_message_id);
    assert.deepEqual(actual.messages[0].content_block,original.messages.flatMap(m=>m.content_block));
    assert.deepEqual(actual.chat_ability,original.chat_ability);
    assert.deepEqual(actual.option,retry.option);
    assert.equal(h.window.__symphonyJointSubmission.restoredRetries,1);
    assert.equal(h.window.__symphonyJointSubmission.error,null);
  }
});
test('attachment retry restoration rejects another message, changed media or nonempty different text',async()=>{
  for(const edit of [
    d=>d.messages[0].local_message_id='unrelated-message',
    d=>delete d.messages[0].local_message_id,
    d=>d.messages[0].content_block[0]=imageBlock('different-image'),
    d=>d.messages[0].content_block.push(textBlock('another video')),
  ]) {
    const h=harness(),original=payload();
    await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(original)});
    const retry={...structuredClone(original),messages:[structuredClone(original.messages[0])]};edit(retry);
    await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(retry)}));
    assert.equal(h.calls.length,1);assert.equal(h.window.__symphonyJointSubmission.restoredRetries,0);
  }
  const h=harness();const first=payload();first.messages=[first.messages[0]];
  await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(first)}));
  assert.equal(h.calls.length,0);
});
test('uploads and foreign requests are unchanged; Doubao confirmation does not repeat references',async()=>{
  const h=harness('doubao');
  await h.window.fetch('https://upload.doubao.com/image',{method:'POST',body:'binary-image'});
  await h.window.fetch('https://example.test/chat/completion',{method:'POST',body:'unchanged'});
  assert.equal(h.calls[0].init.body,'binary-image');assert.equal(h.calls[1].init.body,'unchanged');
  await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(payload())});
  const confirmation={messages:[{content_block:[{block_type:10000,content:{text_block:{text:'确认生成'}}}]}]};
  const original=JSON.stringify(confirmation);
  await h.window.fetch(h.endpoint,{method:'POST',body:original});
  assert.equal(h.calls.at(-1).init.body,original);
});

test('a native CAPTCHA retry with rendered Markdown lists retains the full prompt and joint references',async()=>{
  const full='产品锁定\n- 6 组欧美人物；\n- old-money 风格；\n* 24-28mm 镜头；\n+ -5°C 雪景。';
  const rendered=full.replace(/^[ \t]{0,3}[-*+][ \t]+(?=\S)/gm,'');
  for(const xhr of [false,true]) {
    const h=harness('dola',1,0,full), first=payload();first.messages[1].content_block=[textBlock(full)];
    await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(first)});
    const retry=JSON.parse(h.calls[0].init.body);
    retry.messages[0].content_block.find(b=>b.block_type===10000).content.text_block.text='Generated video: '+rendered+', 9:16';
    retry.option.human_verification='completed-by-user';
    if(xhr){const request=new h.XHR();request.open('POST',h.endpoint,true);request.send(JSON.stringify(retry));}
    else await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(retry)});
    const actual=JSON.parse(xhr?h.calls[1].body:h.calls[1].init.body);
    assert.deepEqual(actual.messages[0].content_block,retry.messages[0].content_block);
    assert.equal(actual.messages[0].local_message_id,'text-message');
    assert.equal(actual.option.unique_key,first.option.unique_key);
    assert.equal(actual.option.human_verification,'completed-by-user');
    assert.deepEqual(actual.chat_ability,first.chat_ability);
    assert.equal(h.window.__symphonyJointSubmission.accepted,2);
    assert.equal(h.window.__symphonyJointSubmission.error,null);
  }
});

test('format normalization does not accept missing content or changed counts, ranges, minus signs and hyphenated words',async()=>{
  const full='产品锁定\n- 6 组欧美人物；\n- old-money 风格；\n* 24-28mm 镜头；\n+ -5°C 雪景。';
  const rendered=full.replace(/^[ \t]{0,3}[-*+][ \t]+(?=\S)/gm,'');
  for(const changed of [
    rendered.replace('6 组','5 组'),
    rendered.replace('old-money','oldmoney'),
    rendered.replace('24-28mm','2428mm'),
    rendered.replace('-5°C','5°C'),
    rendered.slice(0,20),
  ]) {
    const h=harness('dola',1,0,full), first=payload();first.messages[1].content_block=[textBlock(full)];
    await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(first)});
    const retry=JSON.parse(h.calls[0].init.body);
    retry.messages[0].content_block.find(b=>b.block_type===10000).content.text_block.text='Generated video: '+changed+', 9:16';
    await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(retry)}),{message:'MULTIMODAL_PROMPT_MISSING'});
    assert.equal(h.calls.length,1);
  }
});

test('a reused page replaces its previous guard without changing the native transport',async()=>{
  const h=harness();await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(payload())});
  const nextPrompt='A different complete video request';h.install(nextPrompt);
  const next=payload();next.messages[1].content_block=[textBlock(nextPrompt)];
  await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(next)});
  assert.equal(h.calls.length,2);
  assert.equal(h.window.__symphonyJointSubmission.accepted,1);
  assert.equal(JSON.parse(h.calls[1].init.body).messages[0].content_block[1].content.text_block.text,'Create a video: '+nextPrompt);
});

test('native video confirmations require a previous full request and exact control text',async()=>{
  const native=()=>({messages:[{content_block:[{block_type:10000,content:{text_block:{text:'生成视频：确认生成，9:16，10s'}}}]}],
    chat_ability:{ability_param:JSON.stringify({ratio:'9:16',duration:10,input_box_content:{user_input_content:'确认生成',reply_message_format:'生成视频：%s'}})}});
  const h=harness('doubao');
  await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(native())}));
  assert.equal(h.calls.length,0);
  await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(payload())});
  const body=JSON.stringify(native());
  await h.window.fetch(h.endpoint,{method:'POST',body});
  assert.equal(h.calls[1].init.body,body);
  for(const edit of [d=>d.messages[0].content_block[0].content.text_block.text+='再生成一个',
                     d=>d.chat_ability.ability_param='{}',
                     d=>d.messages.push(d.messages[0])]) {
    const invalid=native();edit(invalid);
    await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(invalid)}));
  }
  const xhr=new h.XHR();xhr.open('POST',h.endpoint);xhr.send(body);
  assert.equal(h.calls.at(-1).body,body);
  assert.equal(h.calls.length,3);
  assert.equal(h.window.__symphonyJointSubmission.error,null);
});

test('explicit chat creation control requires the original joint upload and exact original specifications',async()=>{
  const control='请生成视频：使用 Seedance 2.0 Fast，按上文已确认的 15 秒、9:16 参数，根据本对话已上传的全部 5 张参考图和原剧情分镜生成实际视频。参数已确认，请开始制作。';
  const h=harness('doubao',5,0,prompt,control);
  const message=text=>JSON.stringify({messages:[{content_block:[{block_type:10000,content:{text_block:{text}}}]}]});
  await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:message(control)}));
  assert.equal(h.calls.length,0);
  const body=payload();body.messages[0].content_block=[1,2,3,4,5].map(n=>imageBlock(String(n)));
  await h.window.fetch(h.endpoint,{method:'POST',body:JSON.stringify(body)});
  await h.window.fetch(h.endpoint,{method:'POST',body:message(control)});
  assert.equal(h.calls.at(-1).init.body,message(control));
  assert.equal(h.window.__symphonyJointSubmission.accepted,1);
  for(const changed of [control.replace('15 秒','30 秒'),control.replace('5 张','1 张'),control+'再来一条'])
    await assert.rejects(h.window.fetch(h.endpoint,{method:'POST',body:message(changed)}));
  assert.equal(h.calls.length,2);
});
