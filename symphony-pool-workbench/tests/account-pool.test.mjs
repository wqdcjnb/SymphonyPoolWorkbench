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

test('postgres: adding Mimic columns preserves a legacy direct account',{skip:!process.env.TEST_POSTGRES_URL},async()=>{
  const schema='test_'+randomUUID().replaceAll('-','');
  const admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mimic-pg-upgrade-'));
  const keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  let store,pool;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);
    store=await createStore(url.href);
    await store.ensureAccount({id:'legacy',label:'Legacy',loginType:'doubao',service:'doubao',
      workerId:'cloud',profilePath:path.join(root,'legacy-profile'),status:'auth_required'});
    await store.database.prepare("INSERT INTO egress_groups(id,label,capacity,mode,health) VALUES('direct','Legacy',10,'direct','direct')").run();
    await store.database.prepare("INSERT INTO account_bindings(account_id,group_id) VALUES('legacy','direct')").run();
    await store.database.exec('ALTER TABLE account_bindings DROP COLUMN browser_locked_at, DROP COLUMN multilogin_profile_id, DROP COLUMN multilogin_folder_id, DROP COLUMN browser_provider');
    await store.close();store=null;
    store=await createStore(url.href);
    pool=createAccountPool({store,workerId:'cloud',keyFile,enforceGroups:true,
      requireProxyForNewAccounts:true,requireMimicForNewAccounts:true});
    assert.equal((await pool.runtime('legacy')).browserProvider,'chrome');
    assert.equal((await pool.runtime('legacy')).mode,'direct');
    const columns=(await store.database.prepare('PRAGMA table_info(account_bindings)').all()).map(c=>c.name);
    assert.ok(columns.includes('multilogin_profile_id'));
    assert.ok(columns.includes('browser_locked_at'));
  }finally{
    if(store)await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('new cloud accounts use fixed proxy groups and keep their assigned exit after login starts',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-egress-'));
  const keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  const store=await createStore(path.join(root,'db.sqlite'));
  const pool=createAccountPool({store,workerId:'cloud',capacity:2,keyFile,enforceGroups:true,
    requireProxyForNewAccounts:true});
  try{
    await pool.start();
    await pool.putGroup({id:'fixed',label:'Fixed',server:'http://proxy.example:8000',expectedIp:'198.51.100.10'});
    await pool.recordGroupCheck('fixed','198.51.100.10');
    await pool.putGroup({id:'direct',label:'Legacy direct',mode:'direct'});
    await store.ensureAccount({id:'legacy',label:'Legacy',loginType:'doubao',service:'doubao',
      workerId:'cloud',profilePath:path.join(root,'legacy-profile'),status:'auth_required'});
    await store.database.prepare('INSERT INTO account_bindings(account_id,group_id) VALUES(?,?)').run('legacy','direct');
    assert.equal((await pool.runtime('legacy')).mode,'direct');
    const row={id:'new-account',label:'New account',platform:'doubao',groupId:'fixed'};
    assert.equal((await importAccounts({store,pool,profileRoot:root,rows:[{...row,groupId:''}],preview:true})).errors[0].code,'FIXED_PROXY_REQUIRED');
    assert.equal((await importAccounts({store,pool,profileRoot:root,rows:[{...row,groupId:'direct'}],preview:true})).errors[0].code,'FIXED_PROXY_REQUIRED');
    assert.equal((await importAccounts({store,pool,profileRoot:root,rows:[row]})).ok,true);
    const account=await store.getAccount(row.id);
    const lease=await pool.reserve(account,'login');assert.ok(lease);
    await pool.release(lease);
    await assert.rejects(pool.bind([row.id],'direct'),/ACCOUNT_EGRESS_LOCKED/);
    await assert.rejects(pool.putGroup({id:'fixed',label:'Changed',server:'http://other.example:8000',expectedIp:'198.51.100.11'}),/GROUP_HAS_ACCOUNTS/);
    await pool.putGroup({id:'fixed',label:'Renamed',server:'http://proxy.example:8000',expectedIp:'198.51.100.10'});
    assert.equal((await pool.snapshot()).groups.find(g=>g.id==='fixed').health,'ready');
  }finally{await pool.stop();await store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('new Mimic accounts require one unique profile and lock it after first lease',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mimic-binding-'));
  const keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  const store=await createStore(path.join(root,'db.sqlite'));
  const pool=createAccountPool({store,workerId:'cloud',capacity:2,keyFile,enforceGroups:true,
    requireProxyForNewAccounts:true,requireMimicForNewAccounts:true});
  const folder=randomUUID(),first=randomUUID(),second=randomUUID();
  try{
    await pool.start();
    await pool.putGroup({id:'fixed',label:'Fixed',server:'http://proxy.example:8000',expectedIp:'198.51.100.10'});
    await pool.recordGroupCheck('fixed','198.51.100.10');
    await pool.putGroup({id:'direct',label:'Legacy',mode:'direct'});
    await store.ensureAccount({id:'legacy',label:'Legacy',loginType:'doubao',service:'doubao',
      workerId:'cloud',profilePath:path.join(root,'legacy-profile'),status:'auth_required'});
    await store.database.prepare('INSERT INTO account_bindings(account_id,group_id) VALUES(?,?)').run('legacy','direct');
    assert.equal((await pool.runtime('legacy')).browserProvider,'chrome');
    const rows=[{id:'new-1',label:'New 1',platform:'doubao',groupId:'fixed'},
      {id:'new-2',label:'New 2',platform:'doubao',groupId:'fixed'}];
    assert.equal((await importAccounts({store,pool,profileRoot:root,rows})).ok,true);
    assert.equal((await pool.snapshot()).bindings.find(b=>b.accountId==='new-1').browserProvider,'multilogin');
    await assert.rejects(pool.runtime('new-1'),/MULTILOGIN_PROFILE_REQUIRED/);
    await assert.rejects(pool.loginBatch(['new-1']),/MULTILOGIN_PROFILE_REQUIRED/);
    await assert.rejects(pool.bindMultiloginProfile('legacy',folder,first),/BROWSER_PROVIDER_LOCKED/);
    await assert.rejects(pool.bindMultiloginProfile('new-1','bad',first),/INVALID_MULTILOGIN_PROFILE/);
    await pool.bindMultiloginProfile('new-1',folder,first);
    await assert.rejects(pool.bindMultiloginProfile('new-2',folder,first),/MULTILOGIN_PROFILE_IN_USE/);
    await pool.bindMultiloginProfile('new-2',folder,second);
    assert.equal((await pool.runtime('new-1')).multiloginProfileId,first);
    const lease=await pool.reserve(await store.getAccount('new-1'),'login');assert.ok(lease);
    await pool.release(lease);
    await assert.rejects(pool.bindMultiloginProfile('new-1',folder,randomUUID()),/BROWSER_PROFILE_LOCKED/);
    assert.equal((await pool.snapshot()).bindings.find(b=>b.accountId==='new-1').browserLocked,true);
  }finally{await pool.stop();await store.close();fs.rmSync(root,{recursive:true,force:true});}
});
