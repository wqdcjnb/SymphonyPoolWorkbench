import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createStore} from '../lib/db.mjs';
import {createAccountPool} from '../lib/account-pool.mjs';
import {createBrowserResidency} from '../lib/browser-residency.mjs';

for(const backend of ['sqlite','postgres'])test(`${backend}: residency survives logout and restart, backfills verified accounts, and cascades on deletion`,{skip:backend==='postgres'&&!process.env.TEST_POSTGRES_URL},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'resident-db-'));
  const schema='test_resident_'+randomUUID().replaceAll('-','');
  let file=path.join(root,'db.sqlite'),admin,store;
  const makePool=()=>createAccountPool({store,workerId:'node',keyFile:path.join(root,'key')});
  try{
    if(backend==='postgres'){
      admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);file=url.href;
    }
    store=await createStore(file);
    const pool=makePool();
    await store.ensureAccount({id:'dola',label:'Dola',loginType:'dola',service:'dola',workerId:'node',profilePath:path.join(root,'profile')});
    assert.deepEqual(await pool.residentAccountIds(),[]);
    await store.saveVerification('dola',{ok:false,loggedIn:true,error:'DOLA_PAGE_TIMEOUT'});
    assert.equal(await pool.isResident('dola'),true);
    await store.saveVerification('dola',{ok:false,loggedIn:false,error:'LOGIN_REQUIRED'});
    await store.ensureAccount({id:'history',label:'Historical login',loginType:'dola',service:'dola',workerId:'node',profilePath:path.join(root,'history')});
    await store.saveVerification('history',{ok:true,loggedIn:true});
    await store.database.prepare('DELETE FROM resident_browsers WHERE account_id=?').run('history');
    await store.close();store=await createStore(file);
    assert.deepEqual((await makePool().residentAccountIds()).sort(),['dola','history']);
    await store.deleteAccount('dola');await store.deleteAccount('history');assert.deepEqual(await makePool().residentAccountIds(),[]);
  }finally{
    if(store)await store.close();
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('startup restores only persisted accounts, skips in-flight jobs and leaves healthy processes untouched',async()=>{
  const accounts=new Map(['idle','working','healthy'].map(id=>[id,{id}]));
  const opened=[],released=[],locks=new Set(),alive=new Set(['healthy']);let tokenCounter=0;
  const pool={residentAccountIds:async()=>[...accounts.keys()],accountLease:async id=>id==='working'?{purpose:'job'}:null,
    reserve:async()=>`lease-${++tokenCounter}`,release:async token=>released.push(token)};
  const sessions={enabled:true,keepAlive:true,isAlive:a=>alive.has(a.id),
    open:async(a,{token})=>{assert.equal(locks.has(a.id),true);opened.push(a.id);alive.add(a.id);},
    idle:async(a,token)=>pool.release(token)};
  const manager=createBrowserResidency({pool,sessions,store:{getAccount:async id=>accounts.get(id)},locks,verificationLocks:new Set()});
  await Promise.all([manager.wake(),manager.wake()]);await manager.wake();
  assert.deepEqual(opened,['idle']);assert.equal(released.length,1);assert.equal(locks.size,0);
  await manager.stop();alive.clear();await manager.wake();assert.deepEqual(opened,['idle']);
});

test('a crashed browser is retried with backoff and does not restart unrelated healthy accounts',async()=>{
  let time=0,attempts=0,released=0;
  const pool={residentAccountIds:async()=>['broken'],accountLease:async()=>null,reserve:async()=> 'lease',release:async()=>released++};
  const manager=createBrowserResidency({pool,store:{getAccount:async id=>({id})},locks:new Set(),verificationLocks:new Set(),now:()=>time,
    sessions:{enabled:true,keepAlive:true,isAlive:()=>false,open:async()=>{attempts++;throw new Error('PROFILE_LAUNCH_FAILED');}}});
  await manager.wake();await manager.wake();assert.equal(attempts,1);assert.equal(released,1);
  time=30_001;await manager.wake();assert.equal(attempts,2);
  assert.equal(manager.failures.get('broken').error,'PROFILE_LAUNCH_FAILED');await manager.stop();
});
