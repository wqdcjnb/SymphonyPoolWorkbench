import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import { createStore } from '../lib/db.mjs';
import { createAccountPool } from '../lib/account-pool.mjs';
import { importAccounts,parseAccountCsv,parseCredentialCsv } from '../lib/account-import.mjs';
import { secretVault,parseCookies } from '../lib/secret-vault.mjs';

for(const backend of ['sqlite','postgres'])test(`${backend}: 100 slots, competing workers, capacity, fencing, atomic import`,{skip:backend==='postgres'&&!process.env.TEST_POSTGRES_URL,timeout:120000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'symphony-v2-')),keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  const schema='test_'+randomUUID().replaceAll('-','');let source=path.join(root,'db.sqlite'),admin,store;
  const pools=[];
  try{
    if(backend==='postgres'){
      admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
      const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);source=url.href;
    }
    if(backend==='postgres'){
      const handles=await Promise.all(Array.from({length:3},()=>createStore(source)));store=handles.shift();for(const handle of handles)await handle.close();
    }else store=await createStore(source);
    for(let i=0;i<5;i++){const p=createAccountPool({store,workerId:`node-${i}`,capacity:20,keyFile,enforceGroups:true});await p.start();pools.push(p);}
    const p=pools[0];
    for(let i=0;i<10;i++){
      await p.putGroup({id:`group-${i}`,label:`Group ${i}`,capacity:10,server:`http://proxy-${i}.example:8000`,expectedIp:`198.51.100.${i+1}`});
      await p.recordGroupCheck(`group-${i}`,`198.51.100.${i+1}`);
    }
    const rows=Array.from({length:100},(_,i)=>({id:`account-${i}`,label:`Account ${i}`,platform:i===99?'dola':'doubao',groupId:`group-${Math.floor(i/10)}`,workerId:`node-${Math.floor(i/20)}`}));
    const imported=await importAccounts({store,pool:p,profileRoot:root,rows});assert.equal(imported.ok,true);
    await p.credential('account-99',{cookies:'sessionid=test-secret; csrf=other'});
    await assert.rejects(p.credentials([{id:'account-0',identifier:'test@example.invalid'},{id:'missing',password:'unused'}]),/ACCOUNT_NOT_FOUND/);
    assert.equal((await p.runtime('account-0',{secrets:true})).credential,null);
    await p.credentials([{id:'account-0',identifier:'test@example.invalid',password:' private password '}]);
    await p.credential('account-0',{password:'updated'});
    assert.equal((await p.runtime('account-0',{secrets:true})).credential.identifier,'test@example.invalid');
    await p.saveLoginIdentity('account-0',{identifier:'13800000000',source:'Phone fixture'});
    await p.saveLoginIdentity('account-99',{cookies:'',source:'Existing Cookie fixture'});
    assert.equal((await p.loginIdentity('account-0')).identifier,'13800000000');
    assert.equal((await p.runtime('account-0',{secrets:true})).credential.password,undefined);
    assert.equal((await p.revealLoginIdentity('account-99')).cookies,'sessionid=test-secret; csrf=other');
    await p.enableGroup('group-9',false);assert.equal((await pools[4].unavailableReasons()).get('account-99'),'GROUP_DISABLED');
    await p.enableGroup('group-9',true);await p.recordGroupCheck('group-9','198.51.100.10');
    assert.equal(JSON.stringify(await p.snapshot()).includes('test-secret'),false);
    const stored=await store.database.prepare("SELECT credential FROM account_bindings WHERE account_id='account-99'").get();assert.equal(stored.credential.includes('test-secret'),false);
    await assert.rejects(p.bind(['account-99'],'group-0'),/GROUP_CAPACITY_EXCEEDED/);
    const invalid=await importAccounts({store,pool:p,profileRoot:root,rows:[{id:'extra',label:'Extra',platform:'doubao'},{id:'account-1',label:'Duplicate',platform:'doubao'}]});assert.equal(invalid.ok,false);assert.equal(await store.getAccount('extra'),null);
    // Dola capabilities must be independently verified. Use a mocked Doubao account for the load contract.
    await store.database.prepare("UPDATE accounts SET login_type='doubao',service='doubao' WHERE id='account-99'").run();
    for(const account of await store.listAccounts())await store.saveVerification(account.id,{ok:true,loggedIn:true,modelsObserved:['Seedance 2.0 Fast'],remainingCredits:10});
    const draft=await store.createDraftJob({idempotencyKey:'hundred',mode:'image_to_video',model:'Seedance 2.0 Fast',durationSeconds: 15,aspectRatio:'16:9',prompt:'simulation only',priority:50,referenceAssets:[],concurrency:100});
    assert.equal((await store.enqueueBatch(draft.id)).length,100);
    const claims=(await Promise.all(Array.from({length:110},(_,i)=>store.claimNextQueuedJob({pool:pools[i%5]})))).filter(Boolean);
    assert.equal(claims.length,100);assert.equal(new Set(claims.map(c=>c.job.id)).size,100);assert.equal(new Set(claims.map(c=>c.account.id)).size,100);
    assert.equal((await p.snapshot()).leases.length,100);
    await assert.rejects(p.bind(['account-0'],'group-0'),/ACCOUNT_ALREADY_RUNNING/);
    const first=claims[0];await assert.rejects(store.updateJob(first.job.id,{status:'success',leaseToken:'stale'}),/STALE_JOB_LEASE/);
    // Opening another data handle must not interrupt another worker's live tasks.
    const second=await createStore(source);assert.equal((await second.getJob(first.job.id)).status,'leased');await second.close();
    await store.updateJob(first.job.id,{status:'submitting',leaseToken:first.job.leaseToken});
    await store.database.prepare('UPDATE account_leases SET expires_at=0 WHERE token=?').run(first.job.leaseToken);
    await p.heartbeat();assert.equal((await store.getJob(first.job.id)).status,'reconciling');
    await assert.rejects(store.updateJob(first.job.id,{status:'success',leaseToken:first.job.leaseToken}),/STALE_JOB_LEASE/);
    await p.recordGroupCheck('group-1','198.51.100.1');assert.equal((await p.snapshot()).groups.filter(g=>g.health==='conflict').length,2);
    assert.equal((await store.getJob(first.job.id)).status,'reconciling');
  }finally{
    for(const p of pools)await p.stop();if(store)await store.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}fs.rmSync(root,{recursive:true,force:true});
  }
});

test('CSV quoting and authenticated credential encryption',()=>{
  assert.equal(parseCredentialCsv('id,identifier,password\na,test@example.invalid," leading,trailing "')[0].password,' leading,trailing ');
  const rows=parseAccountCsv('id,label,platform,identifier,groupId,workerId\na,"中文, 名称",dola,,,');assert.equal(rows[0].label,'中文, 名称');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vault-')),keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  try{const vault=secretVault(keyFile),sealed=vault.seal({password:'private'},'a');assert.deepEqual(vault.open(sealed,'a'),{password:'private'});assert.throws(()=>vault.open(sealed,'b'),/CREDENTIAL_DECRYPT_FAILED/);assert.throws(()=>parseCookies('a=one;a=two','dola'),/INVALID_COOKIE_INPUT/);assert.equal(parseCookies('a=1','dola')[0].url,'https://www.dola.com/');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
