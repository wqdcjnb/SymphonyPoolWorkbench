import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createStore} from '../lib/db.mjs';
import {createAccountPool} from '../lib/account-pool.mjs';
import {importAccounts,parseAccountCsv} from '../lib/account-import.mjs';
import {createWorkbenchServer} from '../server.mjs';
import {suggestAccount} from '../public/js/account-suggestion.js';

for(const backend of ['sqlite','postgres']) {
  test(`${backend}: account assignment balances 20 nodes, mixed platforms and concurrent imports`,
    {skip:backend==='postgres'&&!process.env.TEST_POSTGRES_URL,timeout:120000},async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-assignment-'));
    const keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
    const schema='test_'+randomUUID().replaceAll('-','');
    let admin,store,other,source=path.join(root,'db.sqlite');
    const pools=[];
    try {
      if(backend==='postgres'){
        admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();
        await admin.query(`CREATE SCHEMA ${schema}`);
        const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);source=url.href;
      }
      store=await createStore(source);other=await createStore(source);
      let time=Date.now();
      for(let i=1;i<=20;i++){
        const pool=createAccountPool({store,workerId:`node-${String(i).padStart(3,'0')}`,keyFile,now:()=>time});
        await pool.start();pools.push(pool);
      }
      const row=(i)=>({id:`account-${i}`,label:`Account ${i}`,platform:i%2?'dola':'doubao',workerId:'node-020'});
      const rows=Array.from({length:40},(_,i)=>row(i));
      const preview=await importAccounts({store,pool:pools[0],profileRoot:root,rows,preview:true});
      assert.equal(preview.ok,true);assert.equal((await store.listAccounts()).length,0);
      assert.deepEqual(preview.assignments.map(a=>a.workerId),[...pools,...pools].map(p=>p.workerId));
      assert.ok((await pools[0].snapshot()).workers.every(w=>w.accountCount===0));
      const result=await importAccounts({store,pool:pools[0],profileRoot:root,rows});
      assert.deepEqual(result.assignments,preview.assignments);
      assert.ok((await pools[0].snapshot()).workers.every(w=>w.accountCount===2));
      // Platforms do not partition the pool: add the other platform to node-001.
      const mixed=await importAccounts({store,pool:pools[1],profileRoot:root,rows:[row(101)]});
      assert.equal(mixed.assignments[0].workerId,'node-001');
      const assigned=await store.listAccounts();
      assert.deepEqual(new Set(assigned.filter(a=>a.workerId==='node-001').map(a=>a.service)),new Set(['doubao','dola']));
      // Concurrent creation through two database handles must count each committed account.
      const concurrent=await Promise.all(Array.from({length:39},(_,i)=>importAccounts({store:i%2?other:store,
        pool:pools[i%20],profileRoot:root,rows:[row(200+i)]})));
      assert.ok(concurrent.every(r=>r.ok));
      assert.ok((await pools[0].snapshot()).workers.every(w=>w.accountCount===4));
      // Deleting an account leaves a real deficit, regardless of the other accounts' statuses.
      await store.database.prepare('DELETE FROM accounts WHERE id=?').run('account-7');
      const refill=await importAccounts({store,pool:pools[0],profileRoot:root,rows:[row(300)]});
      assert.equal(refill.assignments[0].workerId,'node-008');
      // Nodes without a current heartbeat, and disabled nodes, receive no new accounts.
      await store.database.prepare('UPDATE pool_workers SET enabled=0 WHERE id=?').run('node-001');
      await store.database.prepare('UPDATE pool_workers SET heartbeat_at=? WHERE id=?').run(time-60_000,'node-002');
      const active=await importAccounts({store,pool:pools[0],profileRoot:root,rows:[row(301)]});
      assert.equal(active.assignments[0].workerId,'node-003');
      // No eligible node is a recoverable error; a failed batch must not create any account.
      time+=61_000;
      await assert.rejects(importAccounts({store,pool:pools[0],profileRoot:root,rows:[row(302)]}),/NO_AVAILABLE_WORKER/);
      assert.equal(await store.getAccount('account-302'),null);
      await pools[3].heartbeat();
      const invalid=await importAccounts({store,pool:pools[3],profileRoot:root,rows:[row(303),row(303)]});
      assert.equal(invalid.ok,false);assert.equal(await store.getAccount('account-303'),null);
    }finally{
      for(const pool of pools)await pool.stop();
      if(other)await other.close();if(store)await store.close();
      if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
}

test('single account and bulk HTTP routes use the same atomic node assignment',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-assignment-http-'));
  const app=await createWorkbenchServer({port:0,workspaceRoot:root,databasePath:path.join(root,'db.sqlite'),
    workerId:'node-001',seedAccount:false});
  const peers=[];
  try{
    await app.listen();
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const keyFile=path.join(root,'peer-key');fs.writeFileSync(keyFile,randomBytes(32));
    for(const workerId of ['node-002','node-003']){
      const pool=createAccountPool({store:app.store,workerId,keyFile});await pool.start();peers.push(pool);
    }
    const post=async(route,body)=>{
      const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json()};
    };
    const first=await post('/api/accounts',{accountId:'first',label:'First',loginType:'dola',workerId:'nonexistent'});
    assert.equal(first.status,201);assert.equal(first.body.account.workerId,'node-001');
    const responses=await Promise.all(Array.from({length:11},(_,i)=>i%2
      ?post('/api/accounts',{accountId:`single-${i}`,label:'Single',loginType:'doubao',workerId:'node-001'})
      :post('/api/pool/import',{rows:[{id:`bulk-${i}`,label:'Bulk',platform:'dola',workerId:'node-001'}]})));
    assert.ok(responses.every(r=>r.status===200||r.status===201));
    assert.ok((await app.pool.snapshot()).workers.every(w=>w.accountCount===4));
    const duplicates=await Promise.all(['FIRST','First'].map(accountId=>post('/api/accounts',{accountId,label:'Duplicate',loginType:'dola'})));
    assert.ok(duplicates.every(r=>r.body.error==='ACCOUNT_ALREADY_EXISTS'));
    assert.equal((await app.store.listAccounts()).length,12);
    const html=await (await fetch(base+'/accounts')).text();
    assert.doesNotMatch(html,/accountWorkerIdInput|name="workerId"|豆包网页版/);
    assert.match(html,/<option value="doubao">豆包<\/option>/);
  }finally{
    for(const peer of peers)await peer.stop();await app.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

test('new CSV and account suggestions no longer require a worker id',()=>{
  assert.equal(parseAccountCsv('id,label,platform,identifier,groupId\na,Account,dola,,')[0].workerId,undefined);
  assert.equal(parseAccountCsv('id,label,platform,identifier,groupId,workerId\na,Account,dola,,,legacy')[0].workerId,'legacy');
  assert.deepEqual(suggestAccount([{id:'DOLA-05'},{id:'doubao-03'}],'dola'),{id:'dola-06',label:'Dola 六号账号'});
  assert.deepEqual(suggestAccount([],'doubao'),{id:'doubao-01',label:'豆包一号账号'});
});
