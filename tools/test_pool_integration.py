"""Opt-in full account-pool / Xpra / CDP integration, using only disposable accounts."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import requests
from playwright.sync_api import sync_playwright
from desktop_routes import existing_session, DesktopRoutes


@unittest.skipUnless(os.environ.get('WORKBENCH_TEST_POOL') == '1', 'Requires Linux Docker runtime')
class PoolIntegration(unittest.TestCase):
    def test_bulk_login_handoff_cdp_reuse_and_private_ui(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'key').write_bytes(os.urandom(32))
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            options={'port':port,'databasePath':str(root/'db.sqlite'),'profileRoot':str(root/'profiles'),
                     'seedAccount':False,'managedSessions':True,'enforceGroups':True,'workerId':'test-node',
                     'maxConcurrentJobs':2,'keyFile':str(root/'key')}
            script=root/'server.mjs'
            script.write_text('import {createWorkbenchServer} from "/app/symphony-pool-workbench/server.mjs";\n'
                'const app=await createWorkbenchServer({...'+json.dumps(options)+',verifyAccount:async()=>({ok:false,loggedIn:true,error:"DOLA_VIDEO_CAPABILITY_UNVERIFIED"})});await app.listen();'
                'process.on("SIGTERM",async()=>{await app.close();process.exit(0)});',encoding='utf-8')
            process=subprocess.Popen(['node',str(script)],env={**os.environ,'DISPLAY':':99','WORKBENCH_DESKTOP_ROOT':str(root/'desktops')},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            base=f'http://127.0.0.1:{port}'
            def post(route,body):
                response=requests.post(base+route,json=body,timeout=90)
                self.assertEqual(response.status_code,200,response.text)
                return response.json()
            try:
                for _ in range(100):
                    try:
                        if requests.get(base+'/api/health',timeout=.5).ok:break
                    except requests.RequestException:pass
                    time.sleep(.1)
                post('/api/pool/groups',{'id':'test-direct','label':'Explicit direct test','mode':'direct'})
                post('/api/pool/import',{'rows':[{'id':'dola-qa','label':'Dola QA','platform':'dola','groupId':'test-direct'}]})
                post('/api/pool/credential',{'accountId':'dola-qa','cookies':'fixture=nonsecret'})
                post('/api/pool/login',{'accountIds':['dola-qa']})
                item=None
                for _ in range(450):
                    item=requests.get(base+'/api/pool',timeout=2).json()['loginItems'][0]
                    if item['state'] in ('manual','failed'):break
                    time.sleep(.1)
                self.assertEqual(item['state'],'manual',item)
                profile=root/'profiles/dola-qa_sandbox_data'
                session=existing_session(root/'desktops',profile,'dola-qa')
                self.assertIsNotNone(session)
                endpoint='http://127.0.0.1:'+profile.joinpath('DevToolsActivePort').read_text().splitlines()[0]
                with sync_playwright() as playwright:
                    browser=playwright.chromium.connect_over_cdp(endpoint)
                    self.assertTrue(any(c['name']=='fixture' for c in browser.contexts[0].cookies()))
                # A second CDP transport sees the same process and the same cookie store.
                self.assertEqual(existing_session(root/'desktops',profile,'dola-qa')['browser'],session['browser'])
                with sync_playwright() as playwright:
                    browser=playwright.chromium.connect_over_cdp(endpoint)
                    page=browser.contexts[0].new_page()
                    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                    page.goto(base+'/pool');page.locator('input[data-account="dola-qa"]').wait_for()
                    self.assertEqual(page.locator('#capacity').inner_text(),'全局上限 100 · 在线节点容量 2 · 当前占用 1')
                    self.assertFalse(errors,errors)
                    if os.environ.get('POOL_SCREENSHOT'):
                        page.screenshot(path=os.environ['POOL_SCREENSHOT'],full_page=True)
                    page.close()
                result=post('/api/pool/login/finish',{'id':item['id']})
                self.assertTrue(result['ok']);self.assertFalse(result['ready'])
                self.assertIsNone(DesktopRoutes(root/'desktops').lookup(session['token']))
                self.assertEqual(requests.get(base+'/api/pool').json()['leases'],[])
                self.assertEqual(requests.get(base+'/api/accounts').json()['accounts'][0]['status'],'degraded')
                print('PASS: bulk login, encrypted cookie import, same Chrome/CDP session, UI and lease release.',flush=True)
            finally:
                process.terminate()
                try:process.wait(timeout=40)
                except subprocess.TimeoutExpired:process.kill();process.wait()
                if process.returncode:print('SERVER_EXIT',process.returncode,process.stderr.read().decode()[-1000:])
                process.stderr.close()


if __name__=='__main__':unittest.main()
