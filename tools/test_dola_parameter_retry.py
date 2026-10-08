import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from playwright.sync_api import sync_playwright
import dola_video
from task_pages import remember_page, read_state, can_restart_context


def messages(reply, card=False):
    return ('<div data-message-role="user"><div data-testid="message_content" data-message-id="101">'
            'a blue cube</div></div><div data-message-role="assistant">'
            '<div data-testid="message_content" data-message-id="102">'+reply+'</div>'
            + ('<div class="block-video-result"></div>' if card else '') + '</div>')


class ParameterRetryTests(unittest.TestCase):
    def test_actual_proposal_opens_one_new_tab_and_keeps_specs_and_old_tab(self):
        proposal = '请确认以下参数：比例：9:16；时长：15 秒。确认后我直接生成。'
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
            try:
                context = browser.new_context()
                context.route('**/*', lambda route: route.fulfill(status=200,content_type='text/html',body='<body></body>'))
                job = {'id':'parameter-retry','accountId':'dola','profilePath':profile,'leaseToken':'private-test',
                       'prompt':'a blue cube','model':dola_video.DOLA_LONG_MODEL,'durationSeconds':30,
                       'aspectRatio':'9:16','referenceAssets':['original.png']}
                pages = []
                def execute(ctx, page, current, output, emit):
                    pages.append(page)
                    self.assertEqual(current['durationSeconds'],30)
                    self.assertEqual(current['referenceAssets'],['original.png'])
                    page.goto('https://www.dola.com/chat/'+str(len(pages)))
                    page.set_content(messages(proposal))
                    current.update(remoteUrl=page.url,remoteMessageId='101')
                    remember_page(ctx,page,current,'dola',page.url,submitting=True,details={'remoteMessageId':'101'})
                    dola_video.save_video(ctx,page,output,emit,job=current)
                emit = MagicMock()
                with patch.object(dola_video,'execute_dola',side_effect=execute), \
                     patch.object(dola_video,'reserve_parameter_retry',return_value=True) as reserve, \
                     self.assertRaisesRegex(RuntimeError,'PLATFORM_PARAMETERS_MISMATCH'):
                    dola_video.run_dola(context,job,Path(profile)/'result.mp4',emit)
                self.assertEqual(len(pages),2)
                self.assertIsNot(pages[0],pages[1])
                self.assertFalse(pages[0].is_closed())
                self.assertEqual(pages[0].url,'https://www.dola.com/chat/1')
                reserve.assert_called_once()
                emit.assert_not_called()
                state = read_state(job,'dola')
                self.assertEqual(state['contextRestarts'],1)
                self.assertEqual(state['contextRestartReason'],'DOLA_PARAMETER_CONFIRMATION')
                self.assertEqual(state['previousRejectedConversation']['remoteUrl'],pages[0].url)
            finally:
                browser.close()

    def test_generation_or_captcha_evidence_and_collect_only_never_trigger_fresh_submission(self):
        proposal = '请确认：时长：15 秒。确认后我直接生成。'
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome',headless=True,args=['--no-sandbox'])
            try:
                context = browser.new_context()
                context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<body></body>'))
                page=context.new_page();page.goto('https://www.dola.com/chat/123')
                job={'id':'guarded','accountId':'dola','profilePath':profile,'leaseToken':'private-test',
                     'prompt':'a blue cube','model':dola_video.DOLA_LONG_MODEL,'durationSeconds':30,
                     'aspectRatio':'9:16','remoteUrl':page.url,'remoteMessageId':'101'}
                remember_page(context,page,job,'dola',page.url,submitting=True,details={'remoteMessageId':'101'})
                page.set_content(messages(proposal))
                self.assertTrue(dola_video.can_retry_parameter_proposal(page,job))
                for change in [{'collectOnly':True},{'collectExistingUrl':page.url},{'generationAcknowledged':True},
                               {'leaseToken':None},{'remoteMessageId':None},{'durationSeconds':15}]:
                    self.assertFalse(dola_video.can_retry_parameter_proposal(page,{**job,**change}))
                page.set_content(messages(proposal,card=True))
                self.assertFalse(dola_video.can_retry_parameter_proposal(page,job))
                page.set_content(messages('The video will be generated.')+
                    '<div data-message-role="assistant"><div data-testid="message_content">'+proposal+'</div></div>')
                self.assertFalse(dola_video.can_retry_parameter_proposal(page,job))
                page.set_content(messages(proposal)+'<div id="captcha_container">Human verification</div>')
                self.assertFalse(dola_video.can_retry_parameter_proposal(page,job))
                page.set_content(messages(proposal))
                dola_video.acknowledge_generation(context,page,job)
                self.assertTrue(read_state(job,'dola')['generationAcknowledged'])
                reloaded={key:value for key,value in job.items() if key!='generationAcknowledged'}
                self.assertFalse(can_restart_context(reloaded,'dola'))
            finally:
                browser.close()

    def test_unreserved_retry_does_not_create_another_tab(self):
        context,page,emit=MagicMock(),MagicMock(),MagicMock()
        with patch.object(dola_video,'job_page',return_value=page), \
             patch.object(dola_video,'execute_dola',side_effect=RuntimeError('PLATFORM_PARAMETERS_MISMATCH')), \
             patch.object(dola_video,'can_retry_parameter_proposal',return_value=True), \
             patch.object(dola_video,'reserve_parameter_retry',return_value=False), \
             self.assertRaisesRegex(RuntimeError,'PLATFORM_PARAMETERS_MISMATCH'):
            dola_video.run_dola(context,{},Path('result.mp4'),emit)
        context.new_page.assert_not_called()
        emit.assert_not_called()


if __name__=='__main__':
    unittest.main()
