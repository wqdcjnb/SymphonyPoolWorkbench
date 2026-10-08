import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path
from runpy import run_path

from inspect_doubao_task import classify, classify_rows, task_url, recent_urls, confirm_existing, inspect
from doubao_challenge import check_human_verification


class DoubaoRecoveryTests(unittest.TestCase):
    job = {'prompt': '小猫喝水', 'model': 'Seedance 2.0 Fast', 'durationSeconds': 15, 'aspectRatio': '9:16'}

    def test_recovery_recognizes_formatted_prompt_and_keeps_confirmation_checks(self):
        job = {**self.job, 'prompt': '超市促销\n- 刚好 10 袋\n- 0.0-1.5 秒稳定镜头'}
        user = '生成视频：超市促销\n刚好 10 袋\n0.0-1.5 秒稳定镜头，9:16'
        reply = '视频生成参数确认\n模型：Seedance 2.0 Fast\n时长：15 秒\n比例：9:16\n确认后我再开始生成视频。'
        rows = [{'role': 'user', 'text': user}, {'role': 'assistant', 'text': reply}]
        self.assertEqual(classify_rows(job, rows), 'confirmation')
        rows[1]['text'] = reply.replace('15 秒', '10 秒')
        with self.assertRaisesRegex(RuntimeError, 'PLATFORM_PARAMETERS_MISMATCH'):
            classify_rows(job, rows)
        rows[0]['text'] = user.replace('10 袋', '8 袋')
        self.assertIsNone(classify_rows(job, rows))

    def test_visible_challenge_is_distinct_from_browser_failure(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 1
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_HUMAN_VERIFICATION_REQUIRED'):
            check_human_verification(page)
        page.locator.return_value.count.return_value = 0
        check_human_verification(page)

    def test_original_prompt_and_positive_generation_evidence_are_required(self):
        self.assertEqual(classify(self.job, ['生成视频：小猫喝水，9:16'], ['视频生成好后会通知你'], False), 'generating')
        self.assertEqual(classify(self.job, ['小猫喝水'], ['你的视频生成好了。'], False), 'ready')
        self.assertIsNone(classify(self.job, ['不同任务'], ['你的视频生成好了。'], True))
        self.assertEqual(classify(self.job, ['小猫喝水'], ['我可以帮你'], False), 'pending')
        self.assertEqual(classify(self.job, ['小猫喝水'], [''], False), 'pending')
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_TASK_AMBIGUOUS'):
            classify(self.job, ['小猫喝水', '小猫喝水'], ['你的视频生成好了。'], True)

    def test_confirmation_is_not_mistaken_for_generation(self):
        message = '视频生成参数确认\n模型：Seedance 2.0 Fast\n时长：15 秒\n比例：9:16'
        self.assertEqual(classify(self.job, ['小猫喝水'], [message], False), 'confirmation')
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_CONFIRMATION_UNCONFIRMED'):
            classify(self.job, ['小猫喝水', '确认生成'], [message], False)

    def test_observed_ten_second_confirmation_cannot_start_collection(self):
        message = ('视频生成参数确认\n模型：Seedance 2.0 Fast\n时长：10 秒\n比例：9:16\n'
                   '确认后我再开始生成视频。')
        with self.assertRaisesRegex(RuntimeError, 'PLATFORM_PARAMETERS_MISMATCH'):
            classify(self.job, ['小猫喝水'], [message], False)
        message = message.replace('10 秒', '15 秒')
        self.assertEqual(classify(self.job, ['小猫喝水'], [message], False), 'confirmation')
        self.assertEqual(classify(self.job, ['小猫喝水', '确认生成'],
                                 [message, '视频生成好后会通知你'], False), 'generating')

    def test_pinned_history_does_not_hide_newer_conversations(self):
        values = ['100', '105', '101', '108', '103', '104', '107', '102', '109', '999', '999', None, 'local_123']
        urls = recent_urls(values)
        self.assertEqual(urls[0], 'https://www.doubao.com/chat/999')
        self.assertIn('https://www.doubao.com/chat/109', urls)
        self.assertEqual(len(urls), 10)

    def test_native_confirmation_remains_bound_to_the_same_original_prompt(self):
        rows = [{'role':'user','text':'小猫喝水'},
                {'role':'assistant','text':'视频生成参数确认\n模型：Seedance 2.0 Fast\n时长：10 秒\n比例：9:16'},
                {'role':'user','text':'生成视频：确认生成，9:16'},
                {'role':'assistant','text':'视频生成好后会通知你'}]
        self.assertEqual(classify_rows(self.job, rows), 'generating')
        rows[2]['text'] = '生成视频：另一个任务，9:16'
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_TASK_AMBIGUOUS'):
            classify_rows(self.job, rows)

    def test_only_responses_after_the_matching_prompt_can_prove_generation(self):
        rows = [{'role':'user','text':'an older request'},
                {'role':'assistant','text':'你的视频生成好了。','hasVideo':True},
                {'role':'user','text':'小猫喝水'},
                {'role':'assistant','text':'正在思考'}]
        self.assertEqual(classify_rows(self.job, rows), 'pending')
        rows.append({'role':'assistant','text':'视频生成好后会通知你'})
        self.assertEqual(classify_rows(self.job, rows), 'generating')
        rows.append({'role':'user','text':'另一个请求'})
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_TASK_AMBIGUOUS'):
            classify_rows(self.job, rows)

    def test_recovery_sends_only_control_text_once_after_strict_confirmation(self):
        context, page = MagicMock(), MagicMock()
        page.url = 'https://www.doubao.com/chat/123'
        context.pages = [page]
        job = {**self.job, 'remoteUrl':page.url}
        with patch('inspect_doubao_task.conversation_state', side_effect=['confirmation', None, 'generating']), \
                patch('inspect_doubao_task.prepare_video_confirmation') as prepare, \
                patch('inspect_doubao_task.install_duration_submission') as install, \
                patch('inspect_doubao_task.confirm_duration_submission'):
            result = confirm_existing(context, job)
        self.assertEqual(result['platformState'], 'generating')
        prepare.assert_called_once_with(page, job)
        install.assert_called_once_with(page, job, confirmation_only=True)
        page.locator.return_value.first.fill.assert_called_once_with('确认生成')
        page.locator.return_value.click.assert_called_once()
        page.close.assert_not_called()

    def test_running_mismatched_and_already_confirmed_conversations_are_not_submitted(self):
        for state in ['generating', None, RuntimeError('DOUBAO_CONFIRMATION_UNCONFIRMED')]:
            context, page = MagicMock(), MagicMock()
            page.url = 'https://www.doubao.com/chat/123'
            context.pages = [page]
            with patch('inspect_doubao_task.conversation_state', side_effect=[state]):
                if state == 'generating':
                    self.assertEqual(confirm_existing(context, {**self.job, 'remoteUrl':page.url})['platformState'], state)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'DOUBAO_CONFIRMATION_UNCONFIRMED'):
                        confirm_existing(context, {**self.job, 'remoteUrl':page.url})
            page.locator.return_value.click.assert_not_called()
            page.locator.return_value.first.fill.assert_not_called()

    def test_local_placeholder_or_other_platform_cannot_be_bound(self):
        for value in ['https://www.doubao.com/chat/local_123', 'https://www.dola.com/chat/123', 'https://evil.invalid/chat/123']:
            with self.assertRaisesRegex(RuntimeError, 'INVALID_REMOTE_URL'):
                task_url(value)
        self.assertEqual(task_url('https://www.doubao.com/chat/123?tracking=1'), 'https://www.doubao.com/chat/123')

    def test_challenge_handoff_preserves_page_and_never_clicks_send(self):
        worker = run_path(str(Path(__file__).with_name('run-image-to-video.py')))
        context, page = MagicMock(), MagicMock()
        context.new_page.return_value = page
        with patch.dict(worker['run_doubao'].__globals__, {'_run_doubao_page': MagicMock(side_effect=RuntimeError('DOUBAO_HUMAN_VERIFICATION_REQUIRED'))}):
            with self.assertRaisesRegex(RuntimeError, 'DOUBAO_HUMAN_VERIFICATION_REQUIRED'):
                worker['run_doubao'](context, self.job, Path('result.mp4'))
        context.preserve_page.assert_called_once_with(page)
        page.bring_to_front.assert_called()
        page.locator.assert_not_called()

    def inspected_page(self, url='https://www.doubao.com/chat/123'):
        page = MagicMock()
        page.url = url
        page.get_by_role.return_value.is_visible.return_value = False
        page.locator.return_value.evaluate_all.return_value = ['123']
        return page

    def test_pending_message_counts_as_existing_submission(self):
        page, context = self.inspected_page(), MagicMock()
        context.pages = [page]
        with patch('inspect_doubao_task.check_human_verification'), \
                patch('inspect_doubao_task.conversation_state', return_value='pending'):
            result = inspect(context, self.job)
        self.assertTrue(result['ok'])
        self.assertEqual(result['platformState'], 'pending')
        self.assertNotIn('historyChecked', result)

    def test_missing_original_page_does_not_search_history_or_allow_resubmission(self):
        page, context = self.inspected_page(), MagicMock()
        context.pages = [page]
        with patch('inspect_doubao_task.check_human_verification'), \
                patch('inspect_doubao_task.conversation_state', return_value=None):
            result = inspect(context, self.job)
        self.assertFalse(result['ok'])
        self.assertFalse(result['historyChecked'])
        context.new_page.assert_not_called()
        page.goto.assert_not_called()

    def test_unloaded_or_local_placeholder_is_not_proof_that_resubmitting_is_safe(self):
        page, context = self.inspected_page(), MagicMock()
        context.pages = [page]
        page.locator.return_value.first.wait_for.side_effect = RuntimeError('PAGE_NOT_LOADED')
        with patch('inspect_doubao_task.check_human_verification'), \
                patch('inspect_doubao_task.conversation_state', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'PAGE_NOT_LOADED'):
                inspect(context, self.job)
        page = self.inspected_page('https://www.doubao.com/chat/local_123')
        context.pages = [page]
        with patch('inspect_doubao_task.check_human_verification'), \
                patch('inspect_doubao_task.conversation_state', return_value='pending'):
            with self.assertRaisesRegex(RuntimeError, 'DOUBAO_SUBMISSION_UNCONFIRMED'):
                inspect(context, self.job)


if __name__ == '__main__':
    unittest.main()
