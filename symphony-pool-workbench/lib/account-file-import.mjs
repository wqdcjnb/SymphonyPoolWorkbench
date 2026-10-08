import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {secretVault} from './secret-vault.mjs';
import {readAccountFile} from './account-file-reader.mjs';
import {credentialIdentity,phoneIdentity} from './account-file-content.mjs';
import {suggestAccount} from '../public/js/account-suggestion.js';

const scope='account-file-preview:v1';
const existingKey=(platform,b)=>platform==='dola'?b.cookieFingerprint:b.identifier?phoneIdentity(b.identifier):null;
const rowKey=(platform,row)=>platform==='dola'?credentialIdentity(platform,row).slice(0,12):credentialIdentity(platform,row);

export function createAccountFileImport({store,pool,profileRoot,keyFile,now=Date.now}) {
  const vault=secretVault(keyFile);
  return {
    async preview(input){
      const parsed=await readAccountFile(input);
      const bindings=(await pool.snapshot()).bindings;
      const known=new Map(bindings.filter(b=>b.loginMethod===(input.platform==='dola'?'cookie':'phone_sms'))
        .map(b=>[existingKey(input.platform,b),b.accountId]));
      const filename=input.filename.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g,'').slice(0,100);
      const data={id:'import-'+randomUUID(),expiresAt:now()+15*60_000,platform:input.platform,filename,rows:parsed.rows};
      const rows=parsed.rows.map(row=>({line:row.line,
        ...(input.platform==='dola'?{cookieFingerprint:rowKey('dola',row)}:{phone:row.identifier}),
        existingAccountId:known.get(rowKey(input.platform,row))||null}));
      return {ok:true,token:vault.seal(data,scope),platform:input.platform,filename,rows,
        newCount:rows.filter(r=>!r.existingAccountId).length,existingCount:rows.filter(r=>r.existingAccountId).length,
        duplicateCount:parsed.duplicateCount,issues:parsed.issues};
    },
    async commit({token,groupId='',startLogin=true}){
      if(typeof token!=='string'||token.length>4*1024*1024)throw new Error('IMPORT_PREVIEW_INVALID');
      const parts=token.split('.');
      if(parts.length!==3||parts.some(p=>!p||Buffer.from(p,'base64').toString('base64')!==p))throw new Error('IMPORT_PREVIEW_INVALID');
      let input;try{input=vault.open(token,scope);}catch{throw new Error('IMPORT_PREVIEW_INVALID');}
      if(!input?.id||!Array.isArray(input.rows)||!['dola','doubao'].includes(input.platform))throw new Error('IMPORT_PREVIEW_INVALID');
      return store.database.transaction(async()=>{
        const saved=await store.database.prepare('SELECT result_json FROM pool_import_receipts WHERE id=?').get(input.id);
        if(saved)return {...JSON.parse(saved.result_json),replayed:true};
        if(input.expiresAt<=now())throw new Error('IMPORT_PREVIEW_EXPIRED');
        const snapshot=await pool.snapshot();
        const known=new Set(snapshot.bindings.filter(b=>b.loginMethod===(input.platform==='dola'?'cookie':'phone_sms'))
          .map(b=>existingKey(input.platform,b)).filter(Boolean));
        const rows=input.rows.filter(row=>!known.has(rowKey(input.platform,row)));
        const accounts=await store.listAccounts(),created=[],needsSetup=[];
        const groups=snapshot.groups.filter(g=>g.health!=='disabled'&&(!pool.requireProxyForNewAccounts||g.mode==='proxy'))
          .map(g=>({...g,accounts:Number(g.accounts)}));
        if(groupId&&!groups.some(g=>g.id===groupId))throw new Error('GROUP_NOT_FOUND');
        if(groupId&&groups.find(g=>g.id===groupId).capacity-groups.find(g=>g.id===groupId).accounts<rows.length)
          throw new Error('GROUP_CAPACITY_EXCEEDED');
        const workers=rows.length?await pool.planNewAccountWorkers(rows.length):[];
        for(const [index,row] of rows.entries()){
          let suggested,profilePath;
          do{
            suggested=suggestAccount(accounts,input.platform);
            accounts.push({id:suggested.id});profilePath=path.join(profileRoot,`${suggested.id}_sandbox_data`);
          }while(fs.existsSync(profilePath));
          const account=await store.ensureAccount({id:suggested.id,label:suggested.label,
            loginType:input.platform,service:input.platform,workerId:workers[index],profilePath,status:'auth_required'});
          await pool.prepareNewAccount?.(account.id);
          const group=groupId?groups.find(g=>g.id===groupId):groups.filter(g=>g.accounts<g.capacity&&(g.mode==='direct'||g.health==='ready'))
            .sort((a,b)=>a.accounts-b.accounts||a.id.localeCompare(b.id))[0];
          if(group){await pool.bind([account.id],group.id);group.accounts++;}
          await pool.saveLoginIdentity(account.id,{...row,source:`${input.filename} · 第 ${row.line} 行`});
          created.push(account);
        }
        const eligible=[];
        for(const account of created){
          try{await pool.runtime(account.id);eligible.push(account.id);}
          catch(error){needsSetup.push({accountId:account.id,code:/^[A-Z_]+$/.test(error.message)?error.message:'LOGIN_SETUP_REQUIRED'});}
        }
        const loginBatchId=startLogin&&eligible.length?await pool.loginBatch(eligible,{useSavedCredentials:true}):null;
        const result={ok:true,created:created.length,existing:input.rows.length-created.length,
          accountIds:created.map(a=>a.id),assignments:created.map(a=>({accountId:a.id,workerId:a.workerId})),needsSetup,loginBatchId};
        await store.database.prepare('INSERT INTO pool_import_receipts(id,result_json,created_at) VALUES(?,?,?)')
          .run(input.id,JSON.stringify(result),now());
        await store.database.prepare('DELETE FROM pool_import_receipts WHERE created_at<?').run(now()-7*24*60*60_000);
        return result;
      });
    },
  };
}
