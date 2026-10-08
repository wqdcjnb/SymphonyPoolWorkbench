import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { createStore } from '../lib/db.mjs';

test('SQLite migration is read-only, atomic, path-aware and refuses nonempty PostgreSQL', {skip:!process.env.TEST_POSTGRES_URL,timeout:60000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'symphony-migration-'));
  const source=path.join(root,'source.sqlite'),schema='migration_'+randomUUID().replaceAll('-','');
  const client=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});
  let connected=false,store;
  const url=new URL(process.env.TEST_POSTGRES_URL);url.searchParams.set('options',`-csearch_path=${schema}`);
  const script=fileURLToPath(new URL('../scripts/migrate-sqlite-to-postgres.mjs',import.meta.url));
  const run=(...args)=>promisify(execFile)(process.execPath,[script,'--source',source,...args],{env:{...process.env,DATABASE_URL:url.href},timeout:25000,windowsHide:true});
  try{
    store=await createStore(source);
    await store.ensureAccount({id:'old-account',label:'Old account',loginType:'doubao',service:'doubao',profilePath:path.join(root,'old-profile'),workerId:'old-node'});
    const job=await store.createDraftJob({idempotencyKey:'migration-fixture',mode:'image_to_video',model:'Seedance 2.0 Fast',durationSeconds:5,aspectRatio:'16:9',prompt:'migration fixture',referenceAssets:[path.join(root,'uploads','fixture.png')],assetRightsConfirmed:true,priority:50,concurrency:1});
    await store.database.prepare("UPDATE jobs SET status='generating',account_id=? WHERE id=?").run('old-account',job.id);
    await store.close();
    const fingerprint=()=>createHash('sha256').update(fs.readFileSync(source)).digest('hex'),original=fingerprint();
    await client.connect();connected=true;await client.query(`CREATE SCHEMA ${schema}`);
    const dry=JSON.parse((await run()).stdout);assert.equal(dry.mode,'dry-run');assert.equal(dry.counts.accounts,1);
    assert.equal((await client.query('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=$1',[schema])).rows[0].count,'0');
    const badMap=path.join(root,'bad-map.json');fs.writeFileSync(badMap,JSON.stringify({[path.join(root,'uploads','fixture.png')]:'not-absolute'}));
    await assert.rejects(run('--apply','--profile-root','/profiles','--worker-id','cloud-sg-01','--data-root','/data','--path-map',badMap),error=>error.stderr.includes('INVALID_PATH_MAP'));
    assert.equal((await client.query(`SELECT COUNT(*) FROM ${schema}.accounts`)).rows[0].count,'0');
    const applied=JSON.parse((await run('--apply','--profile-root','/profiles','--worker-id','cloud-sg-01','--data-root','/data')).stdout);assert.equal(applied.mode,'applied');
    const account=(await client.query(`SELECT * FROM ${schema}.accounts`)).rows[0];assert.equal(account.profile_path,'/profiles/old-account_sandbox_data');assert.equal(account.worker_id,'cloud-sg-01');assert.equal(account.status,'auth_required');
    const migrated=(await client.query(`SELECT * FROM ${schema}.jobs`)).rows[0];assert.equal(migrated.status,'reconciling');assert.deepEqual(JSON.parse(migrated.reference_assets_json),['/data/uploads/fixture.png']);
    await assert.rejects(run('--apply','--profile-root','/profiles','--worker-id','cloud-sg-01','--data-root','/data'),error=>error.stderr.includes('TARGET_MUST_BE_EMPTY'));
    assert.equal(fingerprint(),original);
    assert.equal((await client.query(`SELECT COUNT(*) FROM ${schema}.jobs`)).rows[0].count,'1');
  }finally{
    await store?.close();
    if(connected){await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});
  }
});
