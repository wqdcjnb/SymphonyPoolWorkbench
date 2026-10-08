import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseAccountCsv, parseCredentialCsv, parsePhoneCsv, importAccounts } from './account-import.mjs';
import {createAccountFileImport} from './account-file-import.mjs';

export function privatePython(python, script, input, timeout=30_000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let output='',done=false;
    const timer=setTimeout(()=>{child.kill();finish(new Error('BROWSER_OPERATION_TIMEOUT'));},timeout);
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>64000){child.kill();finish(new Error('BROWSER_PROTOCOL_ERROR'));}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>finish(new Error('PYTHON_NOT_CONFIGURED')));
    child.on('close',()=>{try{const result=JSON.parse(output.trim().split(/\r?\n/).at(-1));finish(null,result);}catch{finish(new Error('BROWSER_PROTOCOL_ERROR'));}});
    child.stdin.end(JSON.stringify(input));
  });
}

export function poolHttp({pool,store,profileRoot,workspaceRoot,pythonExecutable,readJson,json,login,keyFile}) {
  const fileImport=createAccountFileImport({pool,store,profileRoot,keyFile});
  return async(request,response,pathname)=>{
    if(!pathname.startsWith('/api/pool'))return false;
    let result;
    if(request.method==='GET'&&pathname==='/api/pool')result={...await pool.snapshot(),loginItems:await pool.loginItems()};
    else if(request.method==='GET'&&pathname.startsWith('/api/pool/identity/'))result=await pool.loginIdentity(pathname.slice('/api/pool/identity/'.length));
    else if(request.method==='POST'){
      const body=await readJson(request,pathname.startsWith('/api/pool/import-file/')?8*1024*1024:1_000_000);
      if(pathname==='/api/pool/groups'){await pool.putGroup(body);result={ok:true};}
      else if(pathname==='/api/pool/groups/enable'){await pool.enableGroup(body.id,body.enabled);result={ok:true};}
      else if(pathname==='/api/pool/groups/check'){
        const config=await pool.groupRuntime(body.id);
        const checked=await privatePython(pythonExecutable,path.join(workspaceRoot,'tools','check-egress.py'),config);
        await pool.recordGroupCheck(body.id,checked.ip||null,checked.ok?null:'EGRESS_CHECK_FAILED');result={ok:checked.ok};
      }
      else if(pathname==='/api/pool/bind'){await pool.bind(body.accountIds,body.groupId);result={ok:true};}
      else if(pathname==='/api/pool/credential'){await pool.credential(body.accountId,body);result={ok:true};}
      else if(pathname==='/api/pool/identity')result=await pool.saveLoginIdentity(body.accountId,body);
      else if(pathname==='/api/pool/identities')result=await pool.saveLoginIdentities(body.csv?parsePhoneCsv(body.csv).map(r=>({...r,source:body.source})):body.rows);
      else if(pathname==='/api/pool/identity/reveal')result=await pool.revealLoginIdentity(body.accountId);
      else if(pathname==='/api/pool/credentials')result=await pool.credentials(body.csv?parseCredentialCsv(body.csv):body.rows);
      else if(pathname==='/api/pool/import')result=await importAccounts({store,pool,profileRoot,rows:body.csv?parseAccountCsv(body.csv):body.rows,preview:body.preview===true});
      else if(pathname==='/api/pool/import-file/preview')result=await fileImport.preview(body);
      else if(pathname==='/api/pool/import-file/commit'){
        result=await fileImport.commit(body);if(result.loginBatchId)void login.wake()?.catch(()=>{});
      }
      else if(pathname==='/api/pool/login'){result={batchId:await pool.loginBatch(body.accountIds,{useSavedCredentials:body.useSavedCredentials===true})};void login.wake()?.catch(()=>{});}
      else if(pathname==='/api/pool/login/finish'){result=await login.finish(body.id,body.accountId);}
      else if(pathname==='/api/pool/login/code'){result=await login.code(body.id,body.code);}
      else if(pathname==='/api/pool/login/sms'){result=await login.sendSms(body.id);}
      else if(pathname==='/api/pool/login/sms-status'){result=await login.checkSms(body.id);}
      else if(pathname==='/api/pool/login/cancel'){result=await login.cancel(body.id);}
      else {json(response,404,{error:'NOT_FOUND'});return true;}
    }else{json(response,405,{error:'METHOD_NOT_ALLOWED'});return true;}
    json(response,200,result);return true;
  };
}
