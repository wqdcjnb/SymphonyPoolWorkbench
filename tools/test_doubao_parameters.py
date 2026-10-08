"""Regression tests for incorrect and streaming platform confirmations."""

import unittest
from unittest.mock import MagicMock

from doubao_parameters import confirmation_matches, video_prompt, select_ratio, response_state, prompt_matches, prepare_video_confirmation, VIDEO_PARAMS_PANEL
from unittest.mock import patch
from doubao_parameters import is_confirmation_message


class DoubaoParameterTests(unittest.TestCase):
    def test_native_confirmation_display_suffix_is_not_a_new_video_prompt(self):
        job={'aspectRatio':'9:16','durationSeconds':15}
        for text in ['确认生成','生成视频：确认生成，9:16','生成视频：确认生成，9:16，10s','生成视频：确认生成，9:16，15s']:
            self.assertTrue(is_confirmation_message(text,job))
        for text in ['重新生成','生成视频：确认生成，1:1，10s','生成视频：确认生成，9:16，5s','生成视频：确认生成，9:16，10s 再来一次']:
            self.assertFalse(is_confirmation_message(text,job))

    def test_confirmation_reenters_video_tool_before_applying_the_original_model_and_ratio(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.get_by_text.return_value.last.locator.return_value.inner_text.return_value = '免费模型'
        with patch('doubao_duration.select_base_duration') as duration, patch('doubao_parameters.select_ratio') as ratio:
            prepare_video_confirmation(page, {'model': 'Seedance 2.0 Fast', 'aspectRatio': '9:16'})
        page.locator.return_value.get_by_text.assert_called_once_with('视频生成', exact=True)
        duration.assert_called_once_with(page)
        ratio.assert_called_once_with(page, '9:16')
        self.assertIn('$=', VIDEO_PARAMS_PANEL)

    def test_rendered_list_bullets_do_not_hide_the_original_submitted_prompt(self):
        prompt = '生成促销视频\n- 包装文字 sun-dried cherry tomatoes\n- 0.0-1.5 秒展示\n- 刚好 10 袋'
        rendered = '生成视频：生成促销视频\n包装文字 sun-dried cherry tomatoes\n0.0-1.5 秒展示\n刚好 10 袋，9:16'
        self.assertTrue(prompt_matches(prompt, rendered))
        self.assertTrue(prompt_matches(prompt, '生成视频：' + prompt + '，9:16'))
        for changed in [rendered.replace('10 袋', '8 袋'), rendered.replace('sun-dried', 'sundried'),
                        rendered.replace('0.0-1.5', '0.01.5')]:
            self.assertFalse(prompt_matches(prompt, changed))
        self.assertFalse(prompt_matches('温度 -5 度', '温度 5 度'))
        self.assertFalse(prompt_matches('- ', '任何消息'))

    def setUp(self):
        self.job = {"model": "Seedance 2.0 Mini", "durationSeconds": 5,
                    "aspectRatio": "9:16", "prompt": "海浪轻拍岸边。",
                    "negativePrompt": "文字，水印"}
        self.confirmation = ("视频生成参数确认\n模型： Seedance 2.0 Mini\n"
                             "时长： 5 秒\n比例： 9:16 竖屏\n确认后开始生成。")

    def test_visual_prompt_is_preserved_without_app_generated_chat_instructions(self):
        prompt = video_prompt(self.job)
        self.assertEqual(prompt, '海浪轻拍岸边。\n\n请避免出现：文字，水印')
        for field in ('Seedance', '5 秒', '视频生成参数确认'):
            self.assertNotIn(field, prompt)
        self.assertEqual(self.job['durationSeconds'], 5)

    def test_exact_confirmation_and_display_whitespace(self):
        self.assertTrue(confirmation_matches(self.confirmation, self.job))
        self.assertTrue(confirmation_matches(self.confirmation.replace("5 秒", "５秒")
                                            .replace("9:16", "9 ： 16"), self.job))

    def test_observed_platform_defaults_are_rejected(self):
        observed = ("视频生成参数确认\n模型： Seedance 2.0 Fast\n"
                    "时长： 15 秒\n比例： 16:9 横屏\n确认后我再开始生成视频。")
        self.assertFalse(confirmation_matches(observed, self.job))

    def test_fifteen_seconds_does_not_match_five(self):
        self.assertFalse(confirmation_matches(self.confirmation.replace("5 秒", "15 秒"), self.job))

    def test_wrong_ratio_or_model_is_rejected(self):
        self.assertFalse(confirmation_matches(self.confirmation.replace("9:16", "16:9"), self.job))
        self.assertFalse(confirmation_matches(self.confirmation.replace("Mini", "Fast"), self.job))

    def test_square_job_is_sent_and_mismatched_portrait_confirmation_is_rejected(self):
        job = {**self.job, 'aspectRatio': '1:1', 'prompt': '生成1:1方形视频'}
        self.assertTrue(video_prompt(job).startswith('生成1:1方形视频'))
        self.assertTrue(confirmation_matches(self.confirmation.replace('9:16', '1:1'), job))
        self.assertFalse(confirmation_matches(self.confirmation, job))

    def test_partial_or_ambiguous_confirmation_is_rejected(self):
        for partial in ("视频生成参数确认", "视频生成参数确认\n模型： Seedance 2.0 Mini\n时长："):
            self.assertFalse(confirmation_matches(partial, self.job))
        self.assertFalse(confirmation_matches(self.confirmation + "\n时长：15 秒", self.job))

    def test_all_fixed_ratios_are_sent_and_confirmed(self):
        for ratio in ['1:1','3:4','4:3','9:16','16:9','21:9']:
            job = {**self.job, 'aspectRatio': ratio}
            self.assertTrue(video_prompt(job).startswith(job['prompt']))
            self.assertEqual(job['aspectRatio'], ratio)
            self.assertTrue(confirmation_matches(self.confirmation.replace('9:16',ratio),job))

    def test_latest_assistant_response_distinguishes_rejection_from_generation(self):
        rejected = '这是豆包订阅标准套餐专属能力，开通标准套餐，我就能继续为你服务。'
        self.assertEqual(response_state([self.confirmation, rejected]), 'subscription')
        self.assertEqual(response_state([rejected, '你的视频生成好了。']), 'done')
        self.assertEqual(response_state(['视频生成好后会通知你']), 'auto')
        self.assertEqual(response_state(['免费生成次数已用完']), 'quota')
        self.assertIsNone(response_state(['正在思考']))
        self.assertIsNone(response_state([self.confirmation, '']))
        self.assertIsNone(response_state([rejected, '  ']))

    def test_auto_is_explicitly_selected_and_previous_fixed_ratio_is_rejected(self):
        page = MagicMock()
        page.locator.return_value.inner_text.return_value = '自动 · 15 秒'
        select_ratio(page,'auto')
        self.assertIsNotNone(page.get_by_role.call_args.kwargs['name'].fullmatch('自动'))
        page.get_by_role.return_value.click.assert_called_once()
        page.locator.return_value.inner_text.return_value = '9:16 · 15 秒'
        with self.assertRaisesRegex(RuntimeError,'ASPECT_RATIO_SELECTION_FAILED'):
            select_ratio(page,'auto')

    def test_future_generation_after_confirmation_is_not_running(self):
        for text in [self.confirmation + '\n确认后我再开始生成视频。',
                     '请先确认这些参数，视频生成好后会通知你。',
                     '确认后我再开始生成视频。']:
            self.assertEqual(response_state([text]), 'confirm')


if __name__ == "__main__":
    unittest.main()
