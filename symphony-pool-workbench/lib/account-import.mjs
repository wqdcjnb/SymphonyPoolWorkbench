import path from 'node:path';
import fs from 'node:fs';
import {loginCredential} from './login-identity.mjs';

function csvRows(text,trim=true) {
  if(typeof text!=='string'||text.length>500_000)throw new Error('INVALID_CSV');
  const rows=[];let row=[],value='',quoted=false;
  text=text.replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
  for(let i=0;i<=text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===','||c==='\n'||c===undefined)){row.push(trim?value.trim():value);value='';if(c!==','){if(row.some(Boolean))rows.push(row);row=[];}}
    else if(c!==undefined)value+=c;
  }
  if(quoted||rows.length<2||rows.length>101)throw new Error('INVALID_CSV');
  return rows;
}

export function parseAccountCsv(text) {
  const rows=csvRows(text),headers=rows.shift();
  if(!['id,label,platform,identifier,groupId',
    'id,label,platform,identifier,groupId,multiloginFolderId,multiloginProfileId',
    'id,label,platform,identifier,groupId,workerId',
    'id,label,platform,identifier,groupId,workerId,multiloginFolderId,multiloginProfileId']
    .includes(headers.join(',')))throw new Error('CSV_HEADERS_INVALID');
  return rows.map((values,index)=>{if(values.length!==headers.length)throw new Error(`CSV_ROW_${index+2}_INVALID`);return Object.fromEntries(headers.map((key,i)=>[key,values[i]]));});
}

export function parseCredentialCsv(text) {
  const rows=csvRows(text,false),headers=rows.shift().map(s=>s.trim());
  if(headers.join(',')!=='id,identifier,password')throw new Error('CREDENTIAL_CSV_HEADERS_INVALID');
  return rows.map((values,index)=>{if(values.length!==3)throw new Error(`CSV_ROW_${index+2}_INVALID`);return {id:values[0].trim(),identifier:values[1].trim(),password:values[2]};});
}

export function parsePhoneCsv(text) {
  const rows=csvRows(text),headers=rows.shift();
  if(headers.join(',')!=='id,phone')throw new Error('PHONE_CSV_HEADERS_INVALID');
  return rows.map((values,index)=>{if(values.length!==2)throw new Error(`CSV_ROW_${index+2}_INVALID`);return {id:values[0],identifier:values[1]};});
}

export async function importAccounts({store,pool,profileRoot,rows,preview=false}) {
  if(!Array.isArray(rows)||!rows.length||rows.length>100)throw new Error('INVALID_ACCOUNT_LIST');
  return store.database.transaction(async()=>{
    const existing=new Set((await store.listAccounts()).map(a=>a.id.toLowerCase()));
    const snapshot=await pool.snapshot(),groups=snapshot.groups,counts=new Map(groups.map(g=>[g.id,Number(g.accounts)]));
    const usedProfiles=new Set(snapshot.bindings.map(b=>b.multiloginProfileId?.toLowerCase()).filter(Boolean));
    const errors=[];
    const normalized=rows.map((r,index)=>{
      let code=null;
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.id||''))code='INVALID_ACCOUNT_ID';
      else if(existing.has(r.id.toLowerCase()))code='ACCOUNT_ALREADY_EXISTS';
      else if(fs.existsSync(path.join(profileRoot,`${r.id}_sandbox_data`)))code='PROFILE_ALREADY_EXISTS';
      else if(!['doubao','dola'].includes(r.platform))code='INVALID_LOGIN_TYPE';
      else if(typeof r.label!=='string'||!r.label.trim()||r.label.length>80)code='INVALID_LABEL';
      else if(pool.requireProxyForNewAccounts&&!r.groupId)code='FIXED_PROXY_REQUIRED';
      else if(!pool.requireMimicForNewAccounts&&(r.multiloginFolderId||r.multiloginProfileId))code='BROWSER_PROVIDER_LOCKED';
      else if(Boolean(r.multiloginFolderId)!==Boolean(r.multiloginProfileId))code='MULTILOGIN_PROFILE_REQUIRED';
      else if(r.multiloginFolderId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.multiloginFolderId))
        code='INVALID_MULTILOGIN_PROFILE';
      else if(r.multiloginProfileId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.multiloginProfileId))
        code='INVALID_MULTILOGIN_PROFILE';
      if(!code&&r.multiloginProfileId&&usedProfiles.has(r.multiloginProfileId.toLowerCase()))
        code='MULTILOGIN_PROFILE_IN_USE';
      if(!code&&(r.identifier||r.cookies)){try{loginCredential(r.platform,r);}catch(error){code=error.message;}}
      if(r.id)existing.add(r.id.toLowerCase());
      if(r.multiloginProfileId)usedProfiles.add(r.multiloginProfileId.toLowerCase());
      if(r.groupId){const group=groups.find(g=>g.id===r.groupId);if(!group)code='GROUP_NOT_FOUND';else{
        if(pool.requireProxyForNewAccounts&&group.mode!=='proxy')code='FIXED_PROXY_REQUIRED';
        counts.set(group.id,counts.get(group.id)+1);if(counts.get(group.id)>group.capacity)code='GROUP_CAPACITY_EXCEEDED';}}
      if(code)errors.push({row:index+2,code});
      return {id:r.id,label:r.label,loginType:r.platform,service:r.platform,
        profilePath:path.join(profileRoot,`${r.id}_sandbox_data`),status:'auth_required',
        groupId:r.groupId||null,multiloginFolderId:r.multiloginFolderId||null,
        multiloginProfileId:r.multiloginProfileId||null,
        identifier:r.identifier||null,cookies:r.cookies||null,source:r.source};
    });
    if(errors.length)return {ok:false,count:rows.length,errors};
    // Legacy CSV workerId values are accepted but assignment is always automatic.
    // The transaction serializes this plan with both single and bulk account creation.
    const workerIds=await pool.planNewAccountWorkers(normalized.length);
    const assignments=normalized.map((account,index)=>{
      account.workerId=workerIds[index];
      return {accountId:account.id,workerId:account.workerId};
    });
    if(preview)return {ok:true,count:rows.length,errors:[],assignments};
    for(const account of normalized){
      await store.ensureAccount(account);
      await pool.prepareNewAccount(account.id);
      if(account.groupId)await pool.bind([account.id],account.groupId);
      if(account.multiloginProfileId)await pool.bindMultiloginProfile(account.id,account.multiloginFolderId,account.multiloginProfileId);
      if(account.identifier||account.cookies)await pool.saveLoginIdentity(account.id,account);
    }
    return {ok:true,count:rows.length,errors:[],assignments};
  });
}
