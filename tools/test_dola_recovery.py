"""Read-only recovery selection and real Chromium DOM checks."""
import unittest
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
from playwright.sync_api import sync_playwright
from inspect_dola_task import classify, inspect
from dola_prompt import build_prompt, MODEL
import dola_video

JOB = {'prompt': 'a blue cube', 'negativePrompt': 'letters'}
USER = 'Generated video: a blue cube\n\nAvoid: letters, 1:1'


class RecoveryTests(unittest.TestCase):
    def test_existing_confirmation_is_reported_without_submission_or_generation(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
            try:
                context = browser.new_context()
                context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<body></body>'))
                page = context.new_page()
                page.goto('https://www.dola.com/chat/123')
                page.set_content('<div data-message-role="user"><div data-testid="message_content" data-message-id="101">'+USER+'</div></div>'
                    '<div data-message-role="assistant"><div data-testid="message_content">请确认以下参数：'
                    '比例：9:16；时长：15 秒。确认后我直接生成。</div></div><button onclick="window.sent=true">确认</button>')
                job = {**JOB, 'durationSeconds':30, 'aspectRatio':'9:16', 'collectExistingUrl':page.url}
                emit = MagicMock()
                with self.assertRaisesRegex(RuntimeError, 'PLATFORM_PARAMETERS_MISMATCH'):
                    inspect(context, job)
                with self.assertRaisesRegex(RuntimeError, 'PLATFORM_PARAMETERS_MISMATCH'):
                    dola_video.execute_dola(context, page, job, Path('output.mp4'), emit)
                self.assertEqual([call.args[0] for call in emit.call_args_list], ['submitted'])
                self.assertFalse(page.evaluate('Boolean(window.sent)'))
                self.assertFalse(page.is_closed())
                self.assertEqual(len(context.pages), 1)
            finally:
                browser.close()

    def test_local_submission_reports_guard_failure_without_sending_or_claiming_acceptance(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
            try:
                context = browser.new_context()
                context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<body></body>'))
                page = context.new_page()
                page.goto('https://www.dola.com/chat/local_123')
                page.set_content('<div data-message-role="user"><div data-testid="message_content">'+USER+'</div></div>')
                requests = []
                page.on('request', lambda request: requests.append(request.method))
                page.evaluate('window.__symphonyJointSubmission={accepted:1,error:"MULTIMODAL_PROMPT_MISSING"}')
                with self.assertRaisesRegex(RuntimeError, 'MULTIMODAL_PROMPT_MISSING'):
                    inspect(context, JOB)
                page.evaluate('window.__symphonyJointSubmission.error=null')
                with self.assertRaisesRegex(RuntimeError, 'DOLA_SUBMISSION_UNCONFIRMED'):
                    inspect(context, JOB)
                self.assertEqual(requests, [])
                self.assertEqual(page.url, 'https://www.dola.com/chat/local_123')
                self.assertFalse(page.is_closed())
            finally:
                browser.close()

    def test_collection_accepts_rendered_lists_but_keeps_message_and_content_checks(self):
        raw = '产品锁定\n- 6 组人物；\n- old-money 风格；\n- 24-28mm 镜头；\n- -5°C 雪景。'
        rendered = ('Generated video: 产品锁定<ul><li>6 组人物；</li><li>old-money 风格；</li>'
                    '<li>24-28mm 镜头；</li><li>-5°C 雪景。</li></ul><p>Avoid: 字幕, 9:16</p>')
        def message(identifier, content):
            return f'<div data-message-role="user"><div data-testid="message_content" data-message-id="{identifier}">{content}</div></div>'
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
            try:
                context = browser.new_context()
                context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<body></body>'))
                page = context.new_page()
                page.goto('https://www.dola.com/chat/123')
                job = {'id':'rendered-list','profilePath':profile,'remoteMessageId':'101',
                       'collectExistingUrl':page.url,'prompt':raw,'negativePrompt':'字幕'}
                requests = []
                page.on('request', lambda request: requests.append(request.method))
                page.set_content(message('101', rendered) + '<button onclick="window.sent=true">Send</button>')
                with patch.object(dola_video, 'save_video') as save, patch.object(dola_video, 'open_composer') as composer:
                    dola_video.execute_dola(context, page, job, Path(profile)/'video.mp4', MagicMock())
                    save.assert_called_once()
                    composer.assert_not_called()
                self.assertFalse(page.evaluate('Boolean(window.sent)'))
                for wrong in [rendered.replace('6 组', '5 组'), rendered.replace('24-28mm', '2428mm'),
                              rendered.replace('-5°C', '5°C'), rendered.replace('字幕', '水印')]:
                    # Even an exact matching prompt on another message cannot
                    # replace the bound message's different subject/settings.
                    page.set_content(message('101', wrong) + message('102', rendered))
                    with self.subTest(content=wrong), self.assertRaisesRegex(RuntimeError, 'DOLA_TASK_MISMATCH'):
                        dola_video.wait_for_collection_message(page, job, timeout=0)
                page.set_content(message('102', rendered))
                with self.assertRaisesRegex(RuntimeError, 'DOLA_TASK_MISMATCH'):
                    dola_video.wait_for_collection_message(page, job, timeout=0)
                page.set_content(message('101', rendered))
                page.evaluate('html => {const target=document.querySelector("[data-message-id]");target.innerText="";setTimeout(()=>target.innerHTML=html,50)}', rendered)
                dola_video.wait_for_collection_message(page, job, timeout=2)
                self.assertEqual(requests, [])
            finally:
                browser.close()

    def test_cleaned_prompt_recovers_original_job_and_blocks_ambiguous_variants(self):
        job = {'prompt': '30s蓝色立方体', 'negativePrompt': '水印', 'model': MODEL, 'durationSeconds': 30}
        cleaned = build_prompt(job)
        old = '30s蓝色立方体\nVideo settings: 30 seconds\nAvoid: 水印'
        for text in [cleaned, old]:
            self.assertEqual(classify(job, [text], ['Your video is ready.'], 1, None), 'ready')
        with self.assertRaisesRegex(RuntimeError, 'DOLA_TASK_AMBIGUOUS'):
            classify(job, [cleaned, old], ['Your video is ready.'], 1, None)
        self.assertIsNone(classify(job, ['蓝色立方体', 'Avoid: 水印'], ['Your video is ready.'], 1, None))

    def test_generation_ack_or_card_is_required(self):
        self.assertIsNone(classify(JOB, [USER], ['I cannot generate a video'], 0, None))
        self.assertIsNone(classify(JOB, ['another prompt'], ['Your video is ready.'], 1, None))
        self.assertIsNone(classify(JOB, ['a blue cube'], ['Your video is ready.'], 1, None))
        self.assertEqual(classify(JOB, [USER], ['The video will be generated in 1-3 minutes.'], 0, None), 'generating')
        self.assertEqual(classify(JOB, [USER], ['Your video is ready.'], 1, None), 'ready')
        self.assertEqual(classify(JOB, [USER], ["I can't generate the video and didn't use any credit for this generation."], 0, 'failed'), 'failed')

    def test_verification_and_duplicate_messages_block_resume(self):
        with self.assertRaisesRegex(RuntimeError, 'DOLA_HUMAN_VERIFICATION_REQUIRED'):
            classify(JOB, [USER], [], 0, 'human')
        with self.assertRaisesRegex(RuntimeError, 'DOLA_TASK_AMBIGUOUS'):
            classify(JOB, [USER, USER], [], 2, None)

    def test_real_dom_keeps_the_original_conversation_and_never_browses_history(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
            context = browser.new_context()
            posts = []
            home = '<div data-testid="conversation-list-v2-item" data-conversation-id="100">Main chat</div><div data-testid="conversation-list-v2-item" data-conversation-id="123">Recent</div>'
            chat = '<div data-message-role="user"><div data-testid="message_content">' + USER + '</div></div><div data-message-role="assistant"><div data-testid="message_content">Your video is ready.</div><div class="block-video-result"></div></div>'
            def respond(route):
                if route.request.method != 'GET':
                    posts.append(route.request.method)
                route.fulfill(status=200, content_type='text/html', body=home if route.request.url.endswith('/chat/') else chat)
            context.route('**/*', respond)
            page = context.new_page()
            page.goto('https://www.dola.com/chat/')
            try:
                with self.assertRaisesRegex(RuntimeError, 'DOLA_EXISTING_TASK_NOT_FOUND'):
                    inspect(context, JOB)
                self.assertEqual(len(context.pages),1)
                original_job={**JOB,'remoteUrl':'https://www.dola.com/chat/123'}
                result = inspect(context, original_job)
                self.assertEqual(result['remoteUrl'], 'https://www.dola.com/chat/123')
                self.assertTrue(result['sameConversation'])
                self.assertEqual(len(context.pages), 2)
                self.assertEqual(page.url, 'https://www.dola.com/chat/')
                with self.assertRaisesRegex(RuntimeError, 'DOLA_EXISTING_TASK_NOT_FOUND'):
                    inspect(context, JOB, ['https://www.dola.com/chat/123'])
                page=context.pages[-1]
                other = context.new_page()
                other.goto('https://www.dola.com/chat/456')
                with self.assertRaisesRegex(RuntimeError, 'DOLA_TASK_AMBIGUOUS'):
                    inspect(context, JOB)
                other.close()
                page.locator('[data-message-role="assistant"]').evaluate("(node, text) => { node.innerHTML = '<div data-testid=\"message_content\"></div>'; node.firstChild.textContent = text; }", "I can't generate the video and didn't use any credit for this generation.")
                self.assertEqual(inspect(context, JOB)['platformState'], 'failed')
                other=context.new_page()
                other.goto('https://www.dola.com/chat/456')
                other.set_content('<div id="captcha_container">Human required</div>')
                self.assertEqual(inspect(context,original_job)['platformState'],'failed')
                with self.assertRaisesRegex(RuntimeError, 'DOLA_HUMAN_VERIFICATION_REQUIRED'):
                    inspect(context, JOB)
                self.assertFalse(other.is_closed())
                self.assertEqual(posts, [])
            finally:
                browser.close()


if __name__ == '__main__':
    unittest.main()
