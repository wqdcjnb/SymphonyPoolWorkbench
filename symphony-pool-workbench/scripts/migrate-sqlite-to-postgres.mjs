// Dry-run by default. Profiles and videos must be copied separately while workers are stopped.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../lib/db.mjs';
import { createPartnerStore } from '../lib/partner-store.mjs';
import { createVideoApiStore } from '../lib/video-api-store.mjs';
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
if(!args.includes('--source')||!process.env.DATABASE_URL)throw new Error('SOURCE_AND_DATABASE_URL_REQUIRED');
const sourcePath=path.resolve(value('--source'));
if(!fs.statSync(sourcePath).isFile())throw new Error('SOURCE_FILE_REQUIRED');
const source=new DatabaseSync(sourcePath,{readOnly:true}),handles=[];
try{
  if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL))throw new Error('POSTGRES_TARGET_REQUIRED');
  const tables=['accounts','jobs','events','video_api_batches','video_api_turns','video_api_tasks','partner_tasks','partner_items','partner_deliveries'];
  const available=new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name)), counts={};
  for(const table of tables){if(available.has(table))counts[table]=source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;}
  if(available.has('account_bindings')&&source.prepare('SELECT COUNT(*) AS n FROM account_bindings').get().n)throw new Error('V2_CREDENTIAL_MIGRATION_REQUIRES_SEPARATE_EXPORT');
  if(!args.includes('--apply')){console.log(JSON.stringify({mode:'dry-run',counts,profileCopyRequired:true,videoCopyRequired:true}));}
  else{
    if(!args.includes('--profile-root')||!args.includes('--worker-id')||!args.includes('--data-root'))throw new Error('TARGET_PROFILE_DATA_ROOT_AND_WORKER_REQUIRED');
    if(!path.posix.isAbsolute(value('--profile-root'))||!path.posix.isAbsolute(value('--data-root')))throw new Error('TARGET_LINUX_PATH_REQUIRED');
    const mapping=args.includes('--path-map')?JSON.parse(fs.readFileSync(value('--path-map'),'utf8')):{};
    const mapFile=file=>{
      if(!file)return file;
      const explicit=mapping[file];
      if(explicit){if(!path.posix.isAbsolute(explicit))throw new Error('INVALID_PATH_MAP');return explicit;}
      const relative=path.relative(path.dirname(sourcePath),file);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('EXTERNAL_ASSET_PATH_MAP_REQUIRED');
      return path.posix.join(value('--data-root'),relative.split(path.sep).join('/'));
    };
    const preflight=new pg.Client({connectionString:process.env.DATABASE_URL});await preflight.connect();
    try{for(const table of tables){const exists=await preflight.query('SELECT to_regclass($1) AS value',[table]);if(exists.rows[0].value){const count=await preflight.query(`SELECT COUNT(*) AS n FROM ${table}`);if(Number(count.rows[0].n))throw new Error('TARGET_MUST_BE_EMPTY');}}}finally{await preflight.end();}
    const main=await createStore(process.env.DATABASE_URL);handles.push(main);
    handles.push(await createVideoApiStore(process.env.DATABASE_URL),await createPartnerStore(process.env.DATABASE_URL));
    const db=main.database;
    await db.transaction(async()=>{
      for(const table of tables){
        if(!available.has(table))continue;
        const columns=new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).map(c=>c.name));
        if(!columns.size)throw new Error('MIGRATION_TABLE_UNSUPPORTED');
        if((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n)throw new Error('TARGET_MUST_BE_EMPTY');
        for(const row of source.prepare(`SELECT * FROM ${table}`).all()){
          if(table==='accounts'){row.profile_path=path.posix.join(value('--profile-root'),`${row.id}_sandbox_data`);row.status='auth_required';row.last_verified_at=null;row.worker_id=value('--worker-id');}
          if(table==='jobs'&&['leased','submitting','submitted','generating','collecting'].includes(row.status)){row.status='reconciling';row.error_code='MIGRATION_REQUIRES_REVIEW';}
          for(const field of ['reference_video_path','result_path','local_result_path'])if(row[field])row[field]=mapFile(row[field]);
          if(row.reference_assets_json)row.reference_assets_json=JSON.stringify(JSON.parse(row.reference_assets_json).map(mapFile));
          if(row.assets_json)row.assets_json=JSON.stringify(JSON.parse(row.assets_json).map(asset=>({...asset,path:mapFile(asset.path)})));
          const names=Object.keys(row).filter(k=>columns.has(k)&&k!=='_row_order');
          await db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(k=>row[k]));
        }
        if((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n!==counts[table])throw new Error('MIGRATION_COUNT_MISMATCH');
      }
      for(const table of ['video_api_batches','video_api_turns']){
        await db.exec(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT MAX(id) FROM ${table}),1),(SELECT COUNT(*)>0 FROM ${table}))`);
      }
    });
    console.log(JSON.stringify({mode:'applied',counts,requiresVerification:true}));
  }
}finally{source.close();for(const handle of handles.reverse())await handle.close();}
