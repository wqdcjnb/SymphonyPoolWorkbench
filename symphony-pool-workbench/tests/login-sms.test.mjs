import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createStore} from '../lib/db.mjs';
import {createAccountPool} from '../lib/account-pool.mjs';
import {createLoginQueue} from '../lib/login-queue.mjs';

for(const backend of ['sqlite','postgres'])test(`${backend}: phone login is globally ordered, serialized and rate limited`,
  {skip:backend==='postgres'&&!process.env.TEST_POSTGRES_URL,timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sms-queue-')),keyFile=path.join(root,'key');
  fs.writeFileSync(keyFile,randomBytes(32));
  const schema='test_'+randomUUID().replaceAll('-','');
  let source=path.join(root,'db.sqlite'),admin;const stores=[],pools=[],queues=[],opened=[],sent=[];
  let now=Date.now(),valid=false,codeCalls=0,unlockCode;
  try{
    if(backend==='postgres'){
      admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);source=url.href;
    }
    for(const workerId of ['001','002']){
      const store=await createStore(source);stores.push(store);
      const pool=createAccountPool({store,workerId,keyFile,now:()=>now});await pool.start();pools.push(pool);
      queues.push(createLoginQueue({store,pool,now:()=>now,pollMs:1e7,
        sessions:{enabled:true,open:async a=>opened.push(a.id),close:async()=>{}},
        verify:async()=>({ok:valid,loggedIn:valid,modelsObserved:['Seedance 2.0 Fast']}),
        assist:async(a,code,action)=>{
          if(action==='send_sms'){sent.push({id:a.id,at:now});return {ok:true,smsState:'challenge',reason:'LOGIN_CHALLENGE_REQUIRED'};}
          if(action==='status')return {ok:true,smsState:'awaiting_code',reason:'SMS_CODE_REQUIRED'};
          codeCalls++;if(code==='123456')await new Promise(resolve=>{unlockCode=resolve;});
          return {ok:true,submitted:true};
        }}));
    }
    const store=stores[0],pool=pools[0];
    for(const [id,workerId,phone] of [['phone-first','001','13800000000'],['phone-second','002','13900000000']]){
      await store.ensureAccount({id,label:id,service:'doubao',loginType:'doubao',workerId,profilePath:path.join(root,id)});
      await pool.saveLoginIdentity(id,{identifier:phone});
    }
    await pool.loginBatch(['phone-first','phone-second'],{useSavedCredentials:true});
    await queues[1].wake();assert.deepEqual(opened,[],'other node must wait for the first listed phone');
    await Promise.all(queues.map(q=>q.wake()));assert.deepEqual(opened,['phone-first']);assert.equal(sent.length,1);
    let items=await pool.loginItems(),first=items.find(i=>i.accountId==='phone-first'),second=items.find(i=>i.accountId==='phone-second');
    assert.equal(first.smsState,'challenge');assert.equal(second.state,'queued');
    await queues[0].checkSms(first.id);assert.equal(sent.length,1,'checking a completed challenge must not send SMS');
    assert.equal((await queues[0].sendSms(first.id)).reason,'SMS_SEND_COOLDOWN');assert.equal(sent.length,1);
    await queues[0].code(first.id,'000000');assert.equal((await pool.loginItems()).find(i=>i.id===first.id).state,'manual');
    valid=true;
    const pending=queues[0].code(first.id,'123456');
    for(let i=0;i<100&&!unlockCode;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(unlockCode);await assert.rejects(queues[0].code(first.id,'123456'),/VERIFICATION_ALREADY_RUNNING/);
    unlockCode();await pending;assert.equal(codeCalls,2);
    assert.equal((await pool.loginItems()).find(i=>i.id===first.id).state,'done');
    now+=5000;await queues[1].wake();assert.deepEqual(opened,['phone-first']);
    // Restart the second worker: the shared cooldown must survive process-local state loss.
    await queues[1].stop();await pools[1].stop();
    const restarted=createAccountPool({store:stores[1],workerId:'002',keyFile,now:()=>now});await restarted.start();pools.push(restarted);
    const account=await store.getAccount('phone-second'),token=await restarted.reserve(account,'login');
    assert.equal((await restarted.beginLogin(second.id,token)).reason,'SMS_SEND_COOLDOWN');
    now+=55000;await pool.heartbeat();await restarted.heartbeat();
    assert.equal((await restarted.beginLogin(second.id,token)).ok,true);
    const send=await restarted.claimSmsSend(second.id,token);assert.equal(send.ok,true);assert.equal(send.nextSendAt,now+60000);
    assert.equal((await restarted.claimSmsSend(second.id,token)).reason,'SMS_SEND_COOLDOWN');
    assert.equal(JSON.stringify(await pool.loginItems()).includes('123456'),false);
    await restarted.release(token);
  }finally{
    for(const queue of queues)await queue.stop();for(const pool of pools)await pool.stop();
    for(const store of stores)await store.close();
    if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
