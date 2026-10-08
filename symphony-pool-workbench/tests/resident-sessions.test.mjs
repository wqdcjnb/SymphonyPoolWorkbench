import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createBrowserSessions} from '../lib/browser-sessions.mjs';

test('resident account viewing, task ownership and display revocation are independent',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'resident-sessions-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const desktopRoot=path.join(root,'desktops'),calls=[],released=[];
  const pool={runtime:async()=>({credential:{cookies:[{name:'example',value:'old'}]}}),isResident:async()=>true,release:async token=>released.push(token)};
  const sessions=createBrowserSessions({pool,keepAlive:true,enabled:true,workspaceRoot:root,desktopPort:6084,
    runtime:{windows:false,desktopRoot,pythonExecutable:'python',launcherPath:'launcher.py'},
    launch:async(_exe,args,options)=>{
      const accountId=args[args.indexOf('--account-id')+1],profile=args[args.indexOf('--profile')+1];
      calls.push({closing:args.includes('--close'),credential:options.env?.WORKBENCH_LOGIN_CREDENTIAL});
      if(args.includes('--close'))return {stdout:'{"ok":true}'};
      const token=(accountId==='one'?'a':'b').repeat(64);
      fs.writeFileSync(path.join(profile,'DevToolsActivePort'),'45000\n');
      fs.mkdirSync(path.join(desktopRoot,'routes'),{recursive:true});
      fs.writeFileSync(path.join(desktopRoot,'routes',token+'.json'),JSON.stringify({token,accountId}));
      return {stdout:JSON.stringify({ok:true,manualBrowser:false,desktop:{protocol:'xpra',accountId,token}})};
    }});
  const accounts=['one','two'].map(id=>({id,loginType:'doubao',profilePath:path.join(root,id)}));
  for(const account of accounts){fs.mkdirSync(account.profilePath);await sessions.open(account,{manual:true,interactiveOnly:true,token:'login-'+account.id});await sessions.idle(account,'login-'+account.id);}
  await sessions.open(accounts[0],{manual:true,token:'view'});
  const a=sessions.selectViewer(accounts[0],'c'.repeat(64));
  const independent=sessions.selectViewer(accounts[0],'d'.repeat(64));
  const b=sessions.selectViewer(accounts[1],'c'.repeat(64));
  assert.equal(fs.existsSync(path.join(desktopRoot,'routes',a.token+'.json')),false);
  assert.equal(fs.existsSync(path.join(desktopRoot,'routes',independent.token+'.json')),true);
  sessions.detachViewer('c'.repeat(64));
  assert.equal(fs.existsSync(path.join(desktopRoot,'routes',b.token+'.json')),false);
  await sessions.idle(accounts[0],'view');await sessions.open(accounts[0],{token:'job'});await sessions.idle(accounts[0],'job');
  assert.deepEqual(released,['login-one','login-two','view','job']);
  assert.equal(sessions.sessions.size,2);assert.equal(sessions.sessions.get('one').token,null);
  assert.equal(calls.some(c=>c.closing),false);assert.ok(calls.every(c=>c.credential==='{}'));
  assert.throws(()=>sessions.selectViewer(accounts[0],'../escape'),/INVALID_BROWSER_VIEWER/);
});
