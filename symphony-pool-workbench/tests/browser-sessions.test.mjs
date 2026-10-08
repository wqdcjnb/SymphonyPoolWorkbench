import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserSessions } from '../lib/browser-sessions.mjs';

function fixture(t, config={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-login-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const account={id:'test',loginType:'doubao',profilePath:path.join(root,'profile')};
  fs.mkdirSync(account.profilePath);
  const calls=[];
  const pool={runtime:async()=>({expectedIp:'198.51.100.1',credential:{identifier:'fixture'},...config})};
  const sessions=createBrowserSessions({pool,enabled:true,workspaceRoot:root,desktopPort:6084,
    runtime:{windows:false,desktopRoot:path.join(root,'desktops'),pythonExecutable:'python',launcherPath:'launcher.py'},
    launch:async(_exe,args,options)=>{
      const closing=args.includes('--close');calls.push({closing,env:options.env});
      const manual=options.env?.WORKBENCH_MANUAL_LOGIN==='1';
      if(!closing&&!manual)fs.writeFileSync(path.join(account.profilePath,'DevToolsActivePort'),'45678\n');
      return {stdout:JSON.stringify(closing?{ok:true}:{ok:true,manualBrowser:manual,
        desktop:{accountId:account.id,token:'a'.repeat(64)}})};
    }});
  return {sessions,account,calls};
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
