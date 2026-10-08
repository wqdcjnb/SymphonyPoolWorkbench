import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { profileLaunchCommand } from './browser-runtime.mjs';

const exec=promisify(execFile);
export function createBrowserSessions({pool,runtime,workspaceRoot,desktopPort,enabled,keepAlive=false,launch=exec,checkEgress=null}) {
  const sessions=new Map();
  const checks=new Map();
  const viewerPattern=/^[a-f0-9]{64}$/;
  const viewers=path.join(runtime.desktopRoot,'viewers');
  function readState(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
  function writeState(file,value){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary=file+'.'+randomBytes(6).toString('hex')+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,file);
  }
  function viewerState(viewerId){
    if(!viewerPattern.test(viewerId||''))throw new Error('INVALID_BROWSER_VIEWER');
    return {file:path.join(viewers,viewerId+'.json'),value:readState(path.join(viewers,viewerId+'.json'))};
  }
  const marker=account=>path.join(runtime.desktopRoot,createHash('sha256').update(account.profilePath).digest('hex')+'.automation');
  const failureMarker=account=>path.join(runtime.desktopRoot,createHash('sha256').update(account.profilePath).digest('hex')+'.egress-failure');
  async function consumeEgressFailure(account){
    const file=failureMarker(account);
    if(!fs.existsSync(file))return null;
    let code='EGRESS_CHECK_FAILED';
    try{const recorded=JSON.parse(fs.readFileSync(file,'utf8'));if(['EGRESS_CHECK_FAILED','EGRESS_IP_MISMATCH'].includes(recorded.code))code=recorded.code;}catch{}
    await pool.markAccountEgressFailed(account.id);
    fs.rmSync(file,{force:true});
    return code;
  }
  async function env(account,secrets=false){
    const config=await pool.runtime(account.id,{secrets});
    return {...process.env,PYTHONIOENCODING:'utf-8',WORKBENCH_BROWSER_PROXY:config.proxy?JSON.stringify(config.proxy):'',
      WORKBENCH_EXPECTED_IP:config.expectedIp||'',WORKBENCH_LOGIN_CREDENTIAL:JSON.stringify(config.credential||{}),
      WORKBENCH_BROWSER_PROVIDER:config.browserProvider||'chrome',
      WORKBENCH_MULTILOGIN_FOLDER_ID:config.multiloginFolderId||'',
      WORKBENCH_MULTILOGIN_PROFILE_ID:config.multiloginProfileId||'',
      WORKBENCH_BROWSER_ENDPOINT:sessions.get(account.id)?.endpoint||''};
  }
  async function close(account){
    if(!enabled)return;
    const command=profileLaunchCommand(runtime,account);
    const result=await launch(command.executable,[...command.args,'--close'],{cwd:workspaceRoot,windowsHide:true,timeout:30000,maxBuffer:16384});
    if(JSON.parse(result.stdout).ok!==true)throw new Error('PROFILE_CLOSE_FAILED');
    await consumeEgressFailure(account);
    sessions.delete(account.id);fs.rmSync(marker(account),{force:true});
  }
  async function assertEgress(account){
    if(await consumeEgressFailure(account))throw new Error('EGRESS_NOT_READY');
    if(!checkEgress)return;
    const config=await pool.runtime(account.id,{requireHealthy:false});
    if(config.mode!=='proxy')return;
    let pending=checks.get(config.groupId);
    if(!pending){
      pending=(async()=>{
        let checked;
        try{checked=await checkEgress(config);}catch{checked={ok:false};}
        await pool.recordGroupCheck(config.groupId,checked?.ip||null,checked?.ok?null:'EGRESS_CHECK_FAILED');
        await pool.runtime(account.id);
      })();
      checks.set(config.groupId,pending);
      void pending.finally(()=>{if(checks.get(config.groupId)===pending)checks.delete(config.groupId);}).catch(()=>{});
    }
    await pending;
  }
  return {
    enabled, keepAlive, sessions, env, consumeEgressFailure,
    isAlive(account){
      if(!sessions.has(account.id))return false;
      const state=readState(path.join(runtime.desktopRoot,createHash('sha256').update(account.profilePath).digest('hex')+'.json'));
      if(state?.accountId!==account.id)return false;
      return ['manager','browser','xpra','xvfb'].every(kind=>{
        const identity=state[kind];if(!Number.isInteger(identity?.pid))return false;
        try{
          const stat=fs.readFileSync(`/proc/${identity.pid}/stat`,'utf8').split(')').slice(1).join(')').trim().split(/\s+/);
          return !['Z','X'].includes(stat[0])&&stat[19]===String(identity.start);
        }catch{return false;}
      });
    },
    viewer(viewerId){return viewerState(viewerId).value;},
    detachViewer(viewerId){
      const {file,value}=viewerState(viewerId);fs.rmSync(file,{force:true});
      if(viewerPattern.test(value?.token||''))fs.rmSync(path.join(runtime.desktopRoot,'routes',value.token+'.json'),{force:true});
      return value;
    },
    selectViewer(account,viewerId){
      const session=sessions.get(account.id);if(!session)throw new Error('PROFILE_SESSION_NOT_FOUND');
      const source=readState(path.join(runtime.desktopRoot,'routes',session.desktop.token+'.json'));
      if(source?.accountId!==account.id||source?.token!==session.desktop.token)throw new Error('PROFILE_SESSION_NOT_FOUND');
      const {file,value}=viewerState(viewerId),token=randomBytes(32).toString('hex');
      writeState(path.join(runtime.desktopRoot,'routes',token+'.json'),{...source,token,viewerId});
      writeState(file,{accountId:account.id,token});
      if(viewerPattern.test(value?.token||''))fs.rmSync(path.join(runtime.desktopRoot,'routes',value.token+'.json'),{force:true});
      return {...session.desktop,token};
    },
    async idle(account,token){
      if(enabled&&keepAlive&&await pool.isResident(account.id)){
        const session=sessions.get(account.id);
        if(session){session.token=null;fs.rmSync(marker(account),{force:true});}
      }else await close(account);
      await pool.release(token);
    },
    async collectFailures(){for(const session of sessions.values())await consumeEgressFailure(session.account);},
    async open(account,{manual=false,interactiveOnly=false,token=null}={}){
      if(!enabled)return {env:await env(account,manual)};
      await assertEgress(account);
      let session=sessions.get(account.id);
      if(manual&&session?.token&&session.token!==token)throw new Error('ACCOUNT_ALREADY_RUNNING');
      if(session?.manualBrowser&&!manual){
        // Verification and generation reconnect only after the ordinary browser
        // has saved and released the same profile. Keep the account's lease held.
        token=token||session.token;
        await close(account);session=null;
      }
      fs.mkdirSync(runtime.desktopRoot,{recursive:true});
      if(manual)fs.rmSync(marker(account),{force:true});else fs.writeFileSync(marker(account),'busy',{mode:0o600});
      try{
        const command=profileLaunchCommand(runtime,account);
        const launchEnv=await env(account,true);
        const nativeManual=session?session.manualBrowser:Boolean(!keepAlive&&manual&&interactiveOnly&&account.loginType==='doubao'
          &&!launchEnv.WORKBENCH_BROWSER_PROXY&&['',undefined,'chrome'].includes(launchEnv.WORKBENCH_BROWSER_CHANNEL));
        launchEnv.WORKBENCH_MANUAL_LOGIN=nativeManual?'1':'0';
        if(nativeManual)launchEnv.WORKBENCH_LOGIN_CREDENTIAL='';
        if(!manual)launchEnv.WORKBENCH_LOGIN_CREDENTIAL=JSON.stringify({cookies:JSON.parse(launchEnv.WORKBENCH_LOGIN_CREDENTIAL).cookies});
        // A resident profile owns the latest session cookies; don't re-import an old saved snapshot on restart.
        if(keepAlive&&await pool.isResident(account.id))launchEnv.WORKBENCH_LOGIN_CREDENTIAL='{}';
        const result=await launch(command.executable,command.args,{cwd:workspaceRoot,windowsHide:true,
          timeout:launchEnv.WORKBENCH_BROWSER_PROVIDER==='multilogin'?420000:45000,maxBuffer:16384,env:launchEnv});
        const detail=JSON.parse(result.stdout);
        if(!detail.ok||detail.desktop?.accountId!==account.id||!/^[a-f0-9]{64}$/.test(detail.desktop?.token||''))throw new Error('PROFILE_DESKTOP_FAILED');
        if(Boolean(detail.manualBrowser)!==Boolean(nativeManual))throw new Error('BROWSER_MODE_MISMATCH');
        let endpoint='';
        if(!nativeManual){
          const port=launchEnv.WORKBENCH_BROWSER_PROVIDER==='multilogin'?detail.endpointPort:
            Number(fs.readFileSync(path.join(account.profilePath,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);
          if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('BROWSER_ENDPOINT_NOT_READY');
          endpoint=`http://127.0.0.1:${port}`;
        }
        session={account,token:token||session?.token,endpoint,manualBrowser:nativeManual,desktop:{protocol:'xpra',accountId:account.id,port:desktopPort,token:detail.desktop.token}};
        sessions.set(account.id,session);
        // Existing native Xpra connections are closed by the gateway before automation starts.
        if(!manual)await new Promise(resolve=>setTimeout(resolve,400));
        return {desktop:session.desktop,env:await env(account)};
      }catch(error){
        if(!sessions.has(account.id))fs.rmSync(marker(account),{force:true});
        let code='PROFILE_SESSION_FAILED';
        try{const parsed=JSON.parse(error.stdout);if(/^[A-Z][A-Z0-9_]{2,80}$/.test(parsed.error))code=parsed.error;}catch{}
        if(/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message))code=error.message;
        if(['EGRESS_CHECK_FAILED','EGRESS_IP_MISMATCH'].includes(code))await pool.markAccountEgressFailed(account.id);
        throw new Error(code);
      }
    },
    handoff(account,token){
      const session=sessions.get(account.id);
      if(!session)throw new Error('PROFILE_SESSION_NOT_FOUND');
      session.token=token;
      fs.rmSync(marker(account),{force:true});
    },
    close,
  };
}
