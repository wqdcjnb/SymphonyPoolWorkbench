import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, MagicMock, patch
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from doubao_export import (ERROR, NOT_IN_LIBRARY, conversation_original, export_original,
                           save_original, select_original, workspace_original)


class OriginalExportTests(unittest.TestCase):
    def setUp(self):
        self.media = b'\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isomiso2' + bytes(range(64))
        self.original_url = 'https://v6-show.douyinvod.com/test-original.mp4?signature=test-only'
        self.model = {"video_id": "test-video", "status": 10, "video_list": {"video_1": {
            "vtype": "mp4", "encryption_method": "", "size": len(self.media),
            "file_hash": hashlib.md5(self.media).hexdigest(), "vwidth": 720, "vheight": 1280,
            "main_url": base64.b64encode(self.original_url.encode()).decode(), "bitrate": 100}}}
        self.payload = {"code": 0, "data": {"without_watermark": True, "download_video": {
            "test-video": {"vid": "test-video", "download_url": "https://v26-vdl.doubao.com/watermarked.mp4",
                           "video_model": json.dumps(self.model)}}}}

    def test_uses_original_stream_instead_of_watermarked_download(self):
        self.assertEqual(select_original(self.payload)["url"], self.original_url)

    def test_explicit_unwatermarked_marker_is_an_original_not_a_watermark(self):
        for marker in ('unwatermarked', 'no_watermark'):
            url = self.original_url + '&lr=' + marker
            self.model['video_list']['video_1']['main_url'] = base64.b64encode(url.encode()).decode()
            self.payload['data']['download_video']['test-video']['video_model'] = self.model
            self.assertEqual(select_original(self.payload)['url'], url)

    def test_requires_positive_platform_authorization(self):
        for flag in (False, None, 1, "true"):
            self.payload["data"]["without_watermark"] = flag
            with self.assertRaisesRegex(RuntimeError, ERROR): select_original(self.payload)

    def test_watermarked_stream_is_rejected_even_when_platform_flag_is_true(self):
        for query in ('lr=video_gen_watermark_dyn', 'logo_type=video_gen_watermark_dyn',
                      'lr=video_gen_watermark', 'lr=video_gen_watermark%5Fdyn',
                      'lr=unwatermarked_watermark', 'logo_type=no_watermark_watermark'):
            self.model['video_list']['video_1']['main_url'] = base64.b64encode(
                ('https://v26-vdl.doubao.com/result.mp4?' + query).encode()).decode()
            self.payload['data']['download_video']['test-video']['video_model'] = self.model
            with self.assertRaisesRegex(RuntimeError, ERROR): select_original(self.payload)

    def test_never_falls_back_to_download_url(self):
        del self.payload["data"]["download_video"]["test-video"]["video_model"]
        with self.assertRaisesRegex(RuntimeError, ERROR): select_original(self.payload)

    def test_rejects_wrong_video_identity_and_ambiguous_export(self):
        bad = copy.deepcopy(self.payload)
        bad["data"]["download_video"]["second"] = bad["data"]["download_video"]["test-video"]
        with self.assertRaisesRegex(RuntimeError, ERROR): select_original(bad)
        self.model["video_id"] = "different-video"
        self.payload["data"]["download_video"]["test-video"]["video_model"] = self.model
        with self.assertRaisesRegex(RuntimeError, ERROR): select_original(self.payload)

    def test_rejects_untrusted_or_unencrypted_urls(self):
        for url in ('https://doubao.com.attacker.invalid/x', 'http://v6-show.douyinvod.com/x',
                    'https://user:password@v6-show.douyinvod.com/x', 'https://127.0.0.1/x'):
            self.model["video_list"]["video_1"]["main_url"] = base64.b64encode(url.encode()).decode()
            self.payload["data"]["download_video"]["test-video"]["video_model"] = self.model
            with self.assertRaisesRegex(RuntimeError, ERROR): select_original(self.payload)

    def test_saves_identical_bytes_and_receipt_without_signed_url(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'result.mp4'
            def download(context, url, output, hosts):
                self.assertEqual(url, self.original_url)
                output.write_bytes(self.media)
            receipt = save_original(None, self.payload, target, download)
            self.assertEqual(target.read_bytes(), self.media)
            self.assertEqual(receipt['sha256'], hashlib.sha256(self.media).hexdigest())
            saved = Path(str(target) + '.delivery.json').read_text()
            self.assertNotIn('signature', saved)
            self.assertNotIn('https:', saved)
            self.assertTrue(json.loads(saved)['watermark_free'])

    def test_corrupt_download_never_becomes_deliverable(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'result.mp4'
            def download(context, url, output, hosts): output.write_bytes(self.media[:-1] + b'X')
            with self.assertRaisesRegex(RuntimeError, ERROR): save_original(None, self.payload, target, download)
            self.assertFalse(target.exists())
            self.assertFalse(Path(str(target) + '.delivery.json').exists())
            self.assertFalse(list(Path(root).iterdir()))

    def test_worker_download_failure_remains_retryable_without_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            target=Path(root)/'result.mp4'
            with self.assertRaisesRegex(RuntimeError,'DOUBAO_ORIGINAL_EXPORT_FAILED'):
                save_original(None,self.payload,target,Mock(side_effect=RuntimeError('VIDEO_DOWNLOAD_FAILED')))
            self.assertFalse(target.exists())
            self.assertFalse(Path(str(target)+'.delivery.json').exists())

    def test_official_backup_download_recovers_primary_cdn_failure(self):
        context,page=MagicMock(),MagicMock()
        backup='https://v6-backup.douyinvod.com/original.mp4?signature=test-only'
        page.evaluate.return_value={'video_id':'test-video','url':self.original_url,'backup_url':backup}
        calls=[]
        def download(c,url,out,hosts):
            calls.append(url)
            if len(calls)==1:raise RuntimeError('VIDEO_DOWNLOAD_FAILED')
            out.write_bytes(self.media)
            return {'size_bytes':len(self.media),'md5':hashlib.md5(self.media).hexdigest()}
        with tempfile.TemporaryDirectory() as root, patch('doubao_export.original_video_id',return_value='test-video'):
            target=Path(root)/'result.mp4'
            receipt=export_original(context,page,target,download)
            self.assertEqual(calls,[self.original_url,backup])
            self.assertTrue(receipt['watermark_free'])
            self.assertEqual(target.read_bytes(),self.media)

    def test_never_uses_an_untrusted_or_watermarked_backup(self):
        for backup in ('https://attacker.invalid/clip','https://v6-backup.douyinvod.com/clip?lr=video_gen_watermark_dyn'):
            context,page=MagicMock(),MagicMock()
            page.evaluate.return_value={'video_id':'test-video','url':self.original_url,'backup_url':backup}
            original=workspace_original(context,page,'test-video')
            self.assertEqual(original['backup_urls'],[])

    def test_worker_stream_uses_required_referrer_for_doubao_only(self):
        from stream_media import download_video
        for hosts,expected in [(('doubao.com','douyinvod.com'),{'Referer':'https://www.doubao.com/'}),
                               (('example.test',),{})]:
            with tempfile.TemporaryDirectory() as root, patch('stream_media.session_for_account') as factory, patch.dict(os.environ,{'WORKBENCH_EXPECTED_IP':''}):
                session=factory.return_value.__enter__.return_value
                response=session.get.return_value.__enter__.return_value
                response.status_code=200;response.headers={'Content-Type':'video/mp4'}
                response.iter_content.return_value=[self.media]
                target=Path(root)/'stream.mp4'
                download_video(None,'https://'+hosts[0]+'/original.mp4',target,hosts)
                self.assertEqual(target.read_bytes(),self.media)
                self.assertEqual(session.get.call_args.kwargs['headers'],expected)
                self.assertIs(session.get.call_args.kwargs['allow_redirects'],False)

    def test_transient_original_read_is_retried(self):
        response = SimpleNamespace(status=200, headers={'content-type': 'video/mp4'},
                                   body=lambda: self.media, dispose=Mock())
        request = SimpleNamespace(get=Mock(side_effect=[OSError('connection reset'), response]))
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'result.mp4'
            save_original(SimpleNamespace(request=request), self.payload, target)
            self.assertEqual(request.get.call_count, 2)
            self.assertEqual(target.read_bytes(), self.media)
            response.dispose.assert_called_once()

    def test_export_timeout_is_not_reported_as_denied_watermark_authorization(self):
        context, page = MagicMock(), MagicMock()
        page.locator.return_value.count.return_value = 0
        context.new_cdp_session.return_value.send.return_value = {'targetInfo':{}}
        page.expect_response.return_value.__exit__.side_effect = PlaywrightTimeoutError('timeout')
        with self.assertRaisesRegex(RuntimeError,'DOUBAO_ORIGINAL_EXPORT_TIMEOUT'):
            export_original(context,page,Path('unused.mp4'))
        context.new_cdp_session.return_value.send.assert_any_call('Browser.setDownloadBehavior',{'behavior':'default'})

    def test_non_successful_export_response_is_distinct_from_invalid_original(self):
        context, page = MagicMock(), MagicMock()
        page.locator.return_value.count.return_value = 0
        context.new_cdp_session.return_value.send.return_value = {'targetInfo':{}}
        page.expect_response.return_value.__enter__.return_value.value.status = 503
        with self.assertRaisesRegex(RuntimeError,'DOUBAO_ORIGINAL_EXPORT_FAILED'):
            export_original(context,page,Path('unused.mp4'))

    def test_rendered_video_uses_creation_library_original_without_native_download(self):
        context,page=MagicMock(),MagicMock()
        page.evaluate.return_value={'video_id':'test-video','url':self.original_url}
        context.request.head.return_value=SimpleNamespace(status=200,headers={
            'content-type':'video/mp4','content-length':str(len(self.media)),
            'etag':'"'+hashlib.md5(self.media).hexdigest()+'"'},dispose=Mock())
        with tempfile.TemporaryDirectory() as root, patch('doubao_export.original_video_id',return_value='test-video'):
            target=Path(root)/'result.mp4'
            def download(c,u,p,h):
                p.write_bytes(self.media)
                return {'size_bytes':len(self.media),'md5':hashlib.md5(self.media).hexdigest()}
            receipt=export_original(context,page,target,download)
            self.assertTrue(receipt['watermark_free']);self.assertEqual(target.read_bytes(),self.media)
            self.assertEqual(receipt['export_endpoint'],'samantha/aispace/get_download_info')
            self.assertEqual(receipt['source_checksum'],'http_etag_md5')
        page.get_by_test_id.assert_not_called();context.new_cdp_session.assert_not_called()

    def test_original_api_cannot_return_a_different_video_or_watermarked_preview(self):
        for result in ({'video_id':'different-video','url':self.original_url},{'error':'identity'},
                       {'video_id':'test-video','url':self.original_url+'&lr=video_gen_watermark_dyn'},
                       {'video_id':'test-video','url':'https://attacker.invalid/result.mp4'}):
            context,page=MagicMock(),MagicMock()
            page.evaluate.return_value=result;download=Mock()
            with patch('doubao_export.original_video_id',return_value='test-video'):
                with self.assertRaisesRegex(RuntimeError,ERROR):export_original(context,page,Path('unused.mp4'),download)
            download.assert_not_called();page.get_by_test_id.assert_not_called()

    def test_library_original_requires_actual_download_size_and_strong_checksum(self):
        for size,md5 in [(0,'a'*32),(500000001,'a'*32),(len(self.media),'W/"'+'a'*32+'"'),
                         (len(self.media),'multipart-2')]:
            context,page=MagicMock(),MagicMock()
            page.evaluate.return_value={'video_id':'test-video','url':self.original_url}
            with tempfile.TemporaryDirectory() as root, patch('doubao_export.original_video_id',return_value='test-video'):
                def download(c,u,p,h):
                    p.write_bytes(self.media)
                    return {'size_bytes':size,'md5':md5}
                target=Path(root)/'result.mp4'
                with self.assertRaisesRegex(RuntimeError,'DOUBAO_ORIGINAL_EXPORT_FAILED'):
                    export_original(context,page,target,download)
                self.assertFalse(target.exists())
            context.request.head.assert_not_called()

    @unittest.skipUnless(os.environ.get('WORKBENCH_HEADLESS_EXPORT_TEST') == '1',
                         'Set WORKBENCH_HEADLESS_EXPORT_TEST=1 for the creation-library browser test')
    def test_library_browser_matches_video_and_node_across_pages(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True,args=['--no-sandbox'])
            try:
                for wrong_node in (False,True):
                    page=browser.new_page();requests=[]
                    def route(route):
                        req=route.request;name=req.url.split('?')[0].rsplit('/',1)[-1]
                        if name=='fixture':return route.fulfill(content_type='text/html',body='<p>fixture</p>')
                        body=req.post_data_json;requests.append((name,body))
                        if name=='homepage':data={'children':[{'name':'我的创作','id':'root-node'}]}
                        elif name=='node_info' and not body.get('cursor'):
                            data={'children':[{'key':'unrelated-video','id':'wrong-node'}],
                                  'has_more':True,'next_cursor':'next-page'}
                        elif name=='node_info':data={'children':[{'key':'test-video','id':'original-node'}]}
                        elif name=='get_download_info':data={'download_infos':[{
                            'node_id':'wrong-node' if wrong_node else 'original-node','main_url':self.original_url}]}
                        else:raise AssertionError(name)
                        route.fulfill(json={'code':0,'data':data})
                    page.route('https://www.doubao.com/**',route)
                    page.goto('https://www.doubao.com/fixture')
                    context=MagicMock()
                    context.request.head.return_value=SimpleNamespace(status=200,headers={
                        'content-type':'video/mp4','content-length':str(len(self.media)),
                        'etag':'"'+hashlib.md5(self.media).hexdigest()+'"'},dispose=Mock())
                    if wrong_node:
                        with self.assertRaisesRegex(RuntimeError,ERROR):workspace_original(context,page,'test-video')
                        context.request.head.assert_not_called()
                    else:self.assertEqual(workspace_original(context,page,'test-video')['url'],self.original_url)
                    self.assertEqual([r[0] for r in requests],['homepage','node_info','node_info','get_download_info'])
                    self.assertEqual(requests[2][1]['cursor'],'next-page')
                    self.assertEqual(requests[-1][1],{'requests':[{'node_id':'original-node'}]})
                    page.close()
            finally:browser.close()

    def test_original_api_timeout_is_retryable_without_falling_back_to_preview(self):
        context,page=MagicMock(),MagicMock();page.evaluate.return_value={'error':'timeout'}
        with patch('doubao_export.original_video_id',return_value='test-video'):
            with self.assertRaisesRegex(RuntimeError,'DOUBAO_ORIGINAL_EXPORT_TIMEOUT'):
                export_original(context,page,Path('unused.mp4'))
        page.get_by_test_id.assert_not_called()

    def test_chat_result_missing_from_library_uses_same_video_authorized_export(self):
        context, page = MagicMock(), MagicMock()
        url = self.original_url + '&lr=unwatermarked'
        self.model['video_list']['video_1']['main_url'] = base64.b64encode(url.encode()).decode()
        self.payload['data']['download_video']['test-video']['video_model'] = self.model
        page.evaluate.side_effect = [{'error': 'not_found'}, {'payload': self.payload}]
        with tempfile.TemporaryDirectory() as root, patch('doubao_export.original_video_id', return_value='test-video'):
            target = Path(root)/'result.mp4'
            def download(context, actual_url, output, hosts):
                self.assertEqual(actual_url, url)
                output.write_bytes(self.media)
            receipt = export_original(context, page, target, download)
            self.assertEqual(target.read_bytes(), self.media)
            self.assertTrue(receipt['watermark_free'])
            self.assertEqual(receipt['source_checksum'], 'video_model_md5')
            self.assertEqual(receipt['export_endpoint'], 'creativity/resource/get_without_watermark')
            self.assertEqual(page.evaluate.call_args_list[-1].args[1], 'test-video')
        page.get_by_test_id.assert_not_called()
        context.new_cdp_session.assert_not_called()

    def test_identity_and_api_errors_never_trigger_a_different_export_route(self):
        for code, expected in [('identity', ERROR), ('timeout', 'DOUBAO_ORIGINAL_EXPORT_TIMEOUT'),
                               ('export_failed', 'DOUBAO_ORIGINAL_EXPORT_FAILED')]:
            page, download = MagicMock(), Mock()
            page.evaluate.return_value = {'error': code}
            with patch('doubao_export.original_video_id', return_value='test-video'):
                with self.assertRaisesRegex(RuntimeError, expected):
                    export_original(MagicMock(), page, Path('unused.mp4'), download)
            self.assertEqual(page.evaluate.call_count, 1)
            download.assert_not_called()

    def test_chat_export_requires_permission_and_exact_result_identity(self):
        for change in ('denied', 'other-video', 'ambiguous', 'preview'):
            payload = copy.deepcopy(self.payload)
            if change == 'denied':
                payload['data']['without_watermark'] = False
            elif change == 'other-video':
                payload['data']['download_video'] = {'other-video': payload['data']['download_video']['test-video']}
            elif change == 'ambiguous':
                payload['data']['download_video']['other-video'] = payload['data']['download_video']['test-video']
            else:
                model = json.loads(payload['data']['download_video']['test-video']['video_model'])
                model['video_list']['video_1']['main_url'] = base64.b64encode(
                    (self.original_url + '&lr=video_gen_watermark_dyn').encode()).decode()
                payload['data']['download_video']['test-video']['video_model'] = model
            page = MagicMock()
            page.evaluate.return_value = {'payload': payload}
            with self.assertRaisesRegex(RuntimeError, ERROR):
                conversation_original(page, 'test-video')

    @unittest.skipUnless(os.environ.get('WORKBENCH_HEADLESS_EXPORT_TEST') == '1',
                         'Set WORKBENCH_HEADLESS_EXPORT_TEST=1 for the export browser test')
    def test_browser_fallback_reads_only_exact_original_and_never_submits_generation(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
            try:
                page = browser.new_page()
                requests = []
                def route(route):
                    name = route.request.url.split('?')[0].rsplit('/', 1)[-1]
                    if name == 'fixture':
                        return route.fulfill(content_type='text/html', body='<p>fixture</p>')
                    requests.append((name, route.request.post_data_json))
                    if name == 'homepage':
                        payload = {'code':0, 'data':{'children':[{'name':'我的创作','id':'root-node'}]}}
                    elif name == 'node_info':
                        payload = {'code':0, 'data':{'children':[], 'has_more':False}}
                    elif name == 'get_without_watermark':
                        payload = self.payload
                    else:
                        raise AssertionError(name)
                    route.fulfill(json=payload)
                page.route('https://www.doubao.com/**', route)
                page.goto('https://www.doubao.com/fixture')
                with tempfile.TemporaryDirectory() as root, patch('doubao_export.original_video_id', return_value='test-video'):
                    target = Path(root)/'result.mp4'
                    export_original(None, page, target, lambda c,u,p,h: p.write_bytes(self.media))
                    self.assertEqual(target.read_bytes(), self.media)
                self.assertEqual([row[0] for row in requests], ['homepage','node_info','get_without_watermark'])
                self.assertEqual(requests[-1][1], {'uri':[], 'vid':['test-video']})
            finally:
                browser.close()

    @unittest.skipUnless(os.environ.get('WORKBENCH_BROWSER_EXPORT_TEST') == '1',
                         'Set WORKBENCH_BROWSER_EXPORT_TEST=1 for the Chrome regression test')
    def test_browser_blob_is_cancelled_and_original_is_delivered(self):
        from playwright.sync_api import sync_playwright
        html = '''<button data-testid="edit_image_download_button">Download</button>
        <script>document.querySelector('button').onclick = async () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob(['duplicate preview']));
          a.download = 'preview.mp4'; a.click();
          await fetch('/creativity/resource/get_without_watermark', {method:'POST'});
        };</script>'''
        with tempfile.TemporaryDirectory() as root, sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel='chrome', headless=False)
            context = browser.new_context(accept_downloads=True)
            try:
                page = context.new_page()
                def route(request):
                    if request.request.url.endswith('/get_without_watermark'):
                        request.fulfill(json=self.payload)
                    else:
                        request.fulfill(content_type='text/html', body=html)
                page.route('https://www.doubao.com/**', route)
                page.goto('https://www.doubao.com/export-fixture')
                downloads = []
                page.on('download', lambda download: downloads.append(download))
                target = Path(root) / 'result.mp4'
                def download(context, url, path, hosts):
                    self.assertEqual(url, self.original_url)
                    path.write_bytes(self.media)
                receipt = export_original(context, page, target, download)
                self.assertEqual(len(downloads), 1)
                self.assertTrue(downloads[0].failure())
                self.assertEqual(target.read_bytes(), self.media)
                self.assertTrue(receipt['watermark_free'])
                self.assertFalse(page.is_closed())
            finally:
                browser.close()


if __name__ == '__main__':
    unittest.main()
