import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBrowserSessions } from '../lib/browser-sessions.mjs';

function fixture(t, config={}, checkEgress=null, keepAlive=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-login-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const account={id:'test',loginType:'doubao',profilePath:path.join(root,'profile')};
  fs.mkdirSync(account.profilePath);
  const calls=[];
  let health='ready';
  const pool={
    isResident:async()=>keepAlive,
    release:async()=>{},
    runtime:async(_id,{requireHealthy=true}={})=>{
      if(requireHealthy&&health!=='ready')throw new Error('EGRESS_NOT_READY');
      return {groupId:'fixed',mode:'proxy',expectedIp:'198.51.100.1',credential:{identifier:'fixture'},...config};
    },
    recordGroupCheck:async(_id,ip,error)=>{health=error?'failed':ip==='198.51.100.1'?'ready':'mismatch';},
    markAccountEgressFailed:async()=>{health='failed';},
  };
  const sessions=createBrowserSessions({pool,enabled:true,keepAlive,workspaceRoot:root,desktopPort:6084,
    runtime:{windows:false,desktopRoot:path.join(root,'desktops'),pythonExecutable:'python',launcherPath:'launcher.py'},
    checkEgress,
    launch:async(_exe,args,options)=>{
      const closing=args.includes('--close');calls.push({closing,env:options.env});
      const launchedProfile=args[args.indexOf('--profile')+1],launchedAccount=args[args.indexOf('--account-id')+1];
      const manual=options.env?.WORKBENCH_MANUAL_LOGIN==='1';
      if(!closing&&!manual&&config.browserProvider!=='multilogin')
        fs.writeFileSync(path.join(launchedProfile,'DevToolsActivePort'),'45678\n');
      return {stdout:JSON.stringify(closing?{ok:true}:{ok:true,manualBrowser:manual,
        endpointPort:config.browserProvider==='multilogin'?45679:null,
        desktop:{accountId:launchedAccount,token:'a'.repeat(64)}})};
    }});
  return {sessions,account,calls,health:()=>health};
}

test('ordinary interactive login needs no CDP and transitions under the same lease before verification',async t=>{
  const {sessions,account,calls}=fixture(t);
  await sessions.open(account,{manual:true,interactiveOnly:true,token:'exclusive-lease'});
  assert.equal(sessions.sessions.get(account.id).manualBrowser,true);
  assert.equal(sessions.sessions.get(account.id).endpoint,'');
  assert.equal(calls[0].env.WORKBENCH_LOGIN_CREDENTIAL,'');
  assert.equal(calls[0].env.WORKBENCH_EXPECTED_IP,'198.51.100.1');
  await sessions.open(account);
  assert.deepEqual(calls.map(c=>c.closing),[false,true,false]);
  const current=sessions.sessions.get(account.id);
  assert.equal(current.token,'exclusive-lease');
  assert.equal(current.manualBrowser,false);
  assert.equal(current.endpoint,'http://127.0.0.1:45678');
});

test('resident browsers keep the same process mode across login, idle, viewing and a job without retaining a task lease',async t=>{
  const {sessions,account,calls}=fixture(t,{},null,true);
  await sessions.open(account,{manual:true,interactiveOnly:true,token:'login'});
  assert.equal(sessions.sessions.get(account.id).manualBrowser,false);
  assert.equal(calls[0].env.WORKBENCH_LOGIN_CREDENTIAL,'{}');
  await sessions.idle(account,'login');
  assert.equal(sessions.sessions.get(account.id).token,null);
  await sessions.open(account,{manual:true,token:'view'});
  await sessions.idle(account,'view');
  await sessions.open(account,{token:'job'});
  await sessions.idle(account,'job');
  assert.equal(calls.filter(c=>c.closing).length,0);
  assert.equal(sessions.sessions.has(account.id),true);
});

test('selecting another account revokes only the previous viewer link and leaves both browser sessions alive',async t=>{
  const {sessions,account}=fixture(t,{},null,true);
  const second={...account,id:'second',profilePath:path.join(path.dirname(account.profilePath),'second')};
  fs.mkdirSync(second.profilePath);await sessions.open(account,{token:'one'});await sessions.open(second,{token:'two'});
  const root=path.join(path.dirname(account.profilePath),'desktops');
  fs.mkdirSync(path.join(root,'routes'),{recursive:true});
  const b=sessions.sessions.get(second.id);b.desktop.token='b'.repeat(64);
  for(const a of [account,second]){
    const token=sessions.sessions.get(a.id).desktop.token;
    fs.writeFileSync(path.join(root,'routes',token+'.json'),JSON.stringify({accountId:a.id,token}));
  }
  const viewer='c'.repeat(64),otherViewer='d'.repeat(64);
  const a=sessions.selectViewer(account,viewer),independent=sessions.selectViewer(account,otherViewer);
  const selected=sessions.selectViewer(second,viewer);
  assert.equal(fs.existsSync(path.join(root,'routes',a.token+'.json')),false);
  assert.equal(fs.existsSync(path.join(root,'routes',independent.token+'.json')),true);
  assert.equal(sessions.viewer(viewer).accountId,second.id);
  sessions.detachViewer(viewer);
  assert.equal(fs.existsSync(path.join(root,'routes',selected.token+'.json')),false);
  assert.equal(sessions.sessions.size,2);
  assert.throws(()=>sessions.selectViewer(account,'../escape'),/INVALID_BROWSER_VIEWER/);
});

test('Mimic sessions use their own vendor profile and returned CDP port',async t=>{
  const {sessions,account,calls,health}=fixture(t,{browserProvider:'multilogin',
    multiloginFolderId:'11111111-1111-1111-1111-111111111111',
    multiloginProfileId:'22222222-2222-2222-2222-222222222222',
    proxy:{server:'http://proxy.invalid:8000'}});
  await sessions.open(account,{manual:true,token:'exclusive-lease'});
  assert.equal(calls[0].env.WORKBENCH_BROWSER_PROVIDER,'multilogin');
  assert.equal(calls[0].env.WORKBENCH_MULTILOGIN_PROFILE_ID,'22222222-2222-2222-2222-222222222222');
  assert.equal(sessions.sessions.get(account.id).endpoint,'http://127.0.0.1:45679');
  assert.equal(fs.existsSync(path.join(account.profilePath,'DevToolsActivePort')),false);
  const root=path.dirname(account.profilePath);
  const key=createHash('sha256').update(account.profilePath).digest('hex');
  fs.writeFileSync(path.join(root,'desktops',key+'.egress-failure'),JSON.stringify({code:'EGRESS_IP_MISMATCH'}));
  await sessions.collectFailures();
  assert.equal(health(),'failed');
  await assert.rejects(sessions.open(account),/EGRESS_NOT_READY/);
});

test('mismatched proxy exit pauses the group before any browser opens',async t=>{
  const checked=async()=>({ok:true,ip:'198.51.100.2'});
  const {sessions,account,calls,health}=fixture(t,{proxy:{server:'http://proxy.invalid:8000'}},checked);
  await assert.rejects(sessions.open(account,{manual:true,token:'lease'}),/EGRESS_NOT_READY/);
  assert.equal(health(),'mismatch');
  assert.equal(calls.length,0);
});

test('proxy, bulk credentials and other platforms retain managed automation sessions',async t=>{
  for(const setting of [{config:{proxy:{server:'http://proxy.invalid:8000'}},interactive:true},
    {config:{},interactive:false},{config:{},interactive:true,platform:'dola'}]){
    const {sessions,account,calls}=fixture(t,setting.config);
    if(setting.platform)account.loginType=setting.platform;
    await sessions.open(account,{manual:true,interactiveOnly:setting.interactive,token:'exclusive-lease'});
    assert.equal(calls[0].env.WORKBENCH_MANUAL_LOGIN,'0');
    assert.equal(JSON.parse(calls[0].env.WORKBENCH_LOGIN_CREDENTIAL).identifier,'fixture');
    if(setting.config.proxy)assert.equal(JSON.parse(calls[0].env.WORKBENCH_BROWSER_PROXY).server,setting.config.proxy.server);
    assert.equal(sessions.sessions.get(account.id).manualBrowser,false);
  }
});
