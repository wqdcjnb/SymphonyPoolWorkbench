import tempfile
import shutil
import subprocess
import time
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_runtime import SharedContext
from task_pages import job_page, find_page, remember_page, begin_submission


class RealTaskPageTests(unittest.TestCase):
    def test_original_dom_survives_disconnect_and_a_new_worker_connection(self):
        with tempfile.TemporaryDirectory() as profile:
            process=subprocess.Popen([shutil.which('google-chrome'), '--headless=new', '--no-sandbox',
                '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0',
                '--user-data-dir='+profile, 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                port_file=Path(profile)/'DevToolsActivePort'
                deadline=time.monotonic()+10
                while not port_file.exists() and time.monotonic()<deadline:
                    time.sleep(0.1)
                endpoint='http://127.0.0.1:'+port_file.read_text().splitlines()[0]
                for service in ['doubao','dola']:
                    job={'id':'reconnect-'+service,'profilePath':profile}
                    with sync_playwright() as p:
                        context=SharedContext(p.chromium.connect_over_cdp(endpoint))
                        context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<p>Original</p>'))
                        page=job_page(context,job,service)
                        page.goto('https://www.'+service+'.com/chat/123')
                        page.evaluate('window.taskMarker="same-document"')
                        begin_submission(context,page,job,service)
                        remember_page(context,page,job,service,page.url)
                        context.close()
                    with sync_playwright() as p:
                        context=SharedContext(p.chromium.connect_over_cdp(endpoint))
                        requests=[]
                        context.on('request',lambda request:requests.append(request.url))
                        page=job_page(context,{**job,'collectExistingUrl':'https://www.'+service+'.com/chat/123'},service)
                        self.assertEqual(page.evaluate('window.taskMarker'),'same-document')
                        self.assertEqual(requests,[])
                        context.close()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(timeout=5)

    def test_target_id_remains_bound_across_worker_wrappers_without_navigating(self):
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True,args=['--no-sandbox'])
            try:
                context=browser.new_context()
                requested=[]
                def respond(route):
                    requested.append(route.request.url)
                    route.fulfill(status=200,content_type='text/html',body='<p>Original task</p>')
                context.route('**/*',respond)
                for service in ['doubao','dola']:
                    job={'id':'test-'+service,'profilePath':profile}
                    first=SharedContext(browser)
                    original=job_page(first,job,service)
                    original.goto('https://www.'+service+'.com/chat/123')
                    begin_submission(first,original,job,service)
                    remember_page(first,original,job,service,original.url)
                    first.close()
                    requests_before=list(requested)
                    second=SharedContext(browser)
                    found=find_page(second,{**job,'collectExistingUrl':original.url},service)
                    self.assertIs(found,original)
                    self.assertEqual(requested,requests_before)
                    second.close();self.assertFalse(original.is_closed())
            finally:
                browser.close()


if __name__=='__main__':
    unittest.main()
