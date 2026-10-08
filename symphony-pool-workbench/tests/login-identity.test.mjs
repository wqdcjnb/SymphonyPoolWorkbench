import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {createStore} from '../lib/db.mjs';
import {createAccountPool} from '../lib/account-pool.mjs';
import {createLoginQueue} from '../lib/login-queue.mjs';
import {createWorkbenchServer} from '../server.mjs';
import {secretVault,parseCookies} from '../lib/secret-vault.mjs';
import {parsePhoneCsv,importAccounts} from '../lib/account-import.mjs';

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'login-identity-')),keyFile=path.join(root,'key'),databasePath=path.join(root,'test.sqlite');
  fs.writeFileSync(keyFile,randomBytes(32));const store=await createStore(databasePath);
  const pool=createAccountPool({store,workerId:'test',keyFile,capacity:5});await pool.start();
  for(const [id,platform] of [['dola-a','dola'],['dola-b','dola'],['doubao-a','doubao'],['doubao-b','doubao']])
    await store.ensureAccount({id,label:id,service:platform,loginType:platform,workerId:'test',profilePath:path.join(root,id)});
  t.after(async()=>{await pool.stop();await store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,keyFile,databasePath,store,pool};
}

test('existing encrypted Cookies are identified without rewriting them or exposing them in snapshots',async t=>{
  const {store,pool,keyFile}=await fixture(t),vault=secretVault(keyFile),cookie='sessionid=legacy-private; csrf=legacy-csrf';
  const encrypted=vault.seal({cookies:parseCookies(cookie,'dola')},'account:dola-a');
  await store.database.prepare('INSERT INTO account_bindings(account_id,credential) VALUES(?,?)').run('dola-a',encrypted);
  const snapshot=await pool.snapshot(),identity=snapshot.bindings.find(b=>b.accountId==='dola-a');
  assert.equal(identity.loginMethod,'cookie');assert.equal(identity.recoverable,true);assert.equal(identity.cookieCount,2);assert.equal(identity.savedAt,null);
  assert.match(identity.cookieFingerprint,/^[a-f0-9]{12}$/);assert.equal(JSON.stringify(snapshot).includes('legacy-private'),false);
  assert.equal((await pool.revealLoginIdentity('dola-a')).cookies,cookie);
  assert.equal((await store.database.prepare('SELECT credential FROM account_bindings WHERE account_id=?').get('dola-a')).credential,encrypted);
});

test('phone and Cookie bindings survive reopen, preserve untouched secrets and follow account renames',async t=>{
  const {store,pool,root,databasePath,keyFile}=await fixture(t);
  await pool.saveLoginIdentity('dola-a',{cookies:'sessionid=first-private; csrf=one',source:'batch.txt · 第 2 行'});
  await pool.saveLoginIdentity('dola-b',{cookies:'sessionid=second-private'});
  await pool.saveLoginIdentity('doubao-a',{identifier:'+86 13800000000',source:'手机号清单'});
  await pool.saveLoginIdentity('dola-a',{cookies:'',source:'更新备注'});
  assert.equal((await pool.revealLoginIdentity('dola-a')).cookies,'sessionid=first-private; csrf=one');
  assert.equal((await pool.revealLoginIdentity('dola-b')).cookies,'sessionid=second-private');
  assert.equal((await pool.loginIdentity('doubao-a')).identifier,'+8613800000000');
  const other=await createStore(databasePath),reopened=createAccountPool({store:other,workerId:'read-only',keyFile});
  try{assert.equal((await reopened.revealLoginIdentity('dola-b')).cookies,'sessionid=second-private');}finally{await other.close();}
  await store.updateAccountIdentity('dola-a','dola-renamed','Renamed',path.join(root,'renamed'),(a,b)=>pool.renameBinding(a,b));
  assert.equal((await pool.revealLoginIdentity('dola-renamed')).cookies,'sessionid=first-private; csrf=one');
  const stored=await store.database.prepare('SELECT credential FROM account_bindings').all();
  const audit=await store.database.prepare('SELECT details_json FROM events').all();
  for(const secret of ['first-private','second-private','13800000000']){
    assert.equal(JSON.stringify(stored).includes(secret),false);assert.equal(JSON.stringify(audit).includes(secret),false);
  }
});

test('platform login rules and atomic batches prevent accidental mismatches or partial overwrites',async t=>{
  const {pool,store,root}=await fixture(t);
  await pool.saveLoginIdentity('doubao-a',{identifier:'13800000000'});
  await assert.rejects(pool.saveLoginIdentity('doubao-a',{cookies:'sessionid=wrong'}),/LOGIN_METHOD_MISMATCH/);
  await assert.rejects(pool.saveLoginIdentity('doubao-a',{identifier:'someone@example.invalid'}),/PHONE_NUMBER_INVALID/);
  await assert.rejects(pool.saveLoginIdentity('dola-a',{identifier:'13800000000'}),/LOGIN_METHOD_MISMATCH/);
  await assert.rejects(pool.saveLoginIdentity('dola-a',{cookies:'csrf=only'}),/DOLA_SESSION_COOKIE_REQUIRED/);
  await assert.rejects(pool.saveLoginIdentities([{id:'doubao-a',identifier:'13900000000'},{id:'doubao-b',identifier:'invalid'}]),/PHONE_NUMBER_INVALID/);
  assert.equal((await pool.loginIdentity('doubao-a')).identifier,'13800000000');
  await assert.rejects(pool.loginBatch(['doubao-a','dola-a'],{useSavedCredentials:true}),/LOGIN_IDENTITY_REQUIRED/);
  assert.equal((await pool.loginItems()).length,0);
  await pool.loginBatch(['doubao-a'],{useSavedCredentials:true});
  await assert.rejects(pool.saveLoginIdentity('doubao-a',{identifier:'13900000000'}),/LOGIN_ALREADY_QUEUED/);
  assert.deepEqual(parsePhoneCsv('id,phone\ndoubao-b,"+86 13900000000"'),[{id:'doubao-b',identifier:'+86 13900000000'}]);
  const imported=await importAccounts({store,pool,profileRoot:root,rows:[{id:'new-dola',label:'New',platform:'dola',cookies:'sessionid=new-private'}]});
  assert.equal(imported.ok,true);assert.equal((await pool.loginIdentity('new-dola')).recoverable,true);
});

test('Dola restores and verifies once while Doubao awaits the code for its saved phone',async t=>{
  const {pool,store}=await fixture(t),opened=[],closed=[],assisted=[];
  await pool.saveLoginIdentity('dola-a',{cookies:'sessionid=restore-private'});await pool.saveLoginIdentity('doubao-a',{identifier:'13800000000'});
  const sessions={enabled:true,open:async account=>opened.push({id:account.id,credential:(await pool.runtime(account.id,{secrets:true})).credential}),close:async account=>closed.push(account.id)};
  const queue=createLoginQueue({pool,store,sessions,verify:async a=>({ok:true,loggedIn:true,modelsObserved:[a.service==='dola'?'Dreamina Seedance 2.5':'Seedance 2.0 Fast']}),assist:async(a,code)=>{assisted.push({id:a.id,code});return {ok:true,reason:'manual'};}});
  t.after(()=>queue.stop());await pool.loginBatch(['dola-a','doubao-a'],{useSavedCredentials:true});await queue.wake();
  const items=await pool.loginItems(),dola=items.find(i=>i.accountId==='dola-a'),doubao=items.find(i=>i.accountId==='doubao-a');
  assert.equal(dola.state,'done');assert.equal(doubao.state,'manual');assert.deepEqual(closed,['dola-a']);
  assert.equal(opened.find(i=>i.id==='dola-a').credential.cookies[0].value,'restore-private');assert.equal(opened.find(i=>i.id==='doubao-a').credential.identifier,'13800000000');
  await assert.rejects(queue.finish(doubao.id,'dola-a'),/LOGIN_ACCOUNT_MISMATCH/);
  await queue.code(doubao.id,'654321');assert.equal(assisted.at(-1).code,'654321');await queue.finish(doubao.id,'doubao-a');
  assert.equal((await pool.snapshot()).leases.length,0);assert.equal(JSON.stringify(await pool.loginItems()).includes('654321'),false);
  assert.equal((await pool.loginIdentity('doubao-a')).identifier,'13800000000');
  // Finish's deferred wake does not launch either login a second time.
  await queue.wake();assert.equal(opened.length,2);
});

test('a rejected Dola Cookie remains saved and is not retried automatically',async t=>{
  const {pool,store}=await fixture(t);await pool.saveLoginIdentity('dola-a',{cookies:'sessionid=expired-private'});let verified=0;
  const queue=createLoginQueue({pool,store,sessions:{enabled:true,open:async()=>{},close:async()=>{}},verify:async()=>{verified++;return {ok:false,loggedIn:false,error:'DOLA_LOGIN_UNCONFIRMED'};}});
  t.after(()=>queue.stop());await pool.loginBatch(['dola-a'],{useSavedCredentials:true});await queue.wake();await queue.wake();
  assert.equal(verified,1);assert.equal((await pool.loginItems())[0].state,'failed');assert.equal((await pool.snapshot()).leases.length,0);
  assert.equal((await pool.revealLoginIdentity('dola-a')).cookies,'sessionid=expired-private');
});

test('restarting a worker releases interrupted login records without losing the saved phone',async t=>{
  const {pool,store,keyFile}=await fixture(t);await pool.saveLoginIdentity('doubao-a',{identifier:'13800000000'});
  const queue=createLoginQueue({pool,store,sessions:{enabled:true,open:async()=>{},close:async()=>{}},verify:async()=>({ok:true,loggedIn:true})});
  await pool.loginBatch(['doubao-a'],{useSavedCredentials:true});await queue.wake();const item=(await pool.loginItems())[0];
  assert.equal(item.state,'manual');await queue.stop();await pool.stop();
  const restarted=createAccountPool({store,workerId:'test',keyFile});await restarted.start();
  try{
    const previous=(await restarted.loginItems()).find(i=>i.id===item.id);assert.equal(previous.state,'failed');assert.equal(previous.reason,'LOGIN_SESSION_INTERRUPTED');
    assert.equal((await restarted.loginIdentity('doubao-a')).identifier,'13800000000');
    await restarted.loginBatch(['doubao-a'],{useSavedCredentials:true});assert.equal((await restarted.loginItems()).filter(i=>i.state==='queued').length,1);
  }finally{await restarted.stop();}
});

test('HTTP credential reveal is explicit, private, uncached and excluded from normal account responses',async t=>{
  const {root,keyFile}=await fixture(t),socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const app=await createWorkbenchServer({port,workspaceRoot:root,profileRoot:path.join(root,'profiles'),databasePath:path.join(root,'http.sqlite'),keyFile,seedAccount:false});
  await app.listen();try{const base=`http://127.0.0.1:${port}`;
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const created=await post('/api/pool/import',{rows:[{id:'dola-http',label:'Dola HTTP',platform:'dola',cookies:'sessionid=http-private',source:'test import'}]});assert.equal((await created.json()).ok,true);
  const summary=await (await fetch(base+'/api/pool')).text();assert.equal(summary.includes('http-private'),false);
  const revealed=await post('/api/pool/identity/reveal',{accountId:'dola-http'});assert.equal(revealed.status,200);assert.equal(revealed.headers.get('cache-control'),'no-store');assert.equal((await revealed.json()).cookies,'sessionid=http-private');
  assert.equal((await fetch(base+'/api/pool/identity/reveal')).status,404);
  assert.equal((await post('/api/pool/identity/reveal',{accountId:'dola-http'},{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await post('/api/pool/identity/reveal',{accountId:'dola-http'},{'X-Symphony-Api-Only':'1'})).status,404);
  }finally{await app.close();}
});
