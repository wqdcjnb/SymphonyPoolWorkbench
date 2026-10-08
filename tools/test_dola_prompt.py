"""Prompt normalization preserves scene content and existing task recovery."""
import copy
import json
import unittest
from pathlib import Path
from dola_prompt import MODEL, build_prompt, clean_text, matches_prompt, mentions_thirty_seconds


class PromptTests(unittest.TestCase):
    def test_shared_detection_cases(self):
        fixtures = Path(__file__).resolve().parent.parent / 'symphony-pool-workbench/tests/fixtures/thirty-seconds.json'
        data = json.loads(fixtures.read_text(encoding='utf-8'))
        for expected, values in data.items():
            for value in values:
                with self.subTest(value=value):
                    self.assertEqual(mentions_thirty_seconds(value), expected == 'yes')
        self.assertTrue(mentions_thirty_seconds('时长:30s'))
        self.assertTrue(mentions_thirty_seconds('时长：30秒'))

    def test_cleaning_keeps_original_scene_and_structured_settings(self):
        job = {'model': MODEL, 'durationSeconds': 30,
               'prompt': '生成30s广告，适配Seedance 2.0 Fast。\n0.0-3.5秒：展示30袋商品。\n22.0-30.0秒：人物说“Hello”。',
               'negativePrompt': '不要30秒字样，不要水印', 'referenceAssets': ['reference.png']}
        before = copy.deepcopy(job)
        actual = build_prompt(job)
        self.assertFalse(mentions_thirty_seconds(actual))
        self.assertNotIn('Seedance 2.0 Fast', actual)
        self.assertIn('全片进度 0%–11.67%：展示30袋商品', actual)
        self.assertIn('全片进度 73.33%–100%：人物说“Hello”', actual)
        self.assertIn('Avoid: 不要字样，不要水印', actual)
        self.assertEqual(job, before)

    def test_units_and_boundaries_do_not_change_non_duration_values(self):
        self.assertEqual(clean_text('130s / 300 seconds / SKU-A30S / 30袋 / 30fps / 30.5秒'),
                         '130s / 300 seconds / SKU-A30S / 30袋 / 30fps / 30.5秒')
        self.assertEqual(clean_text('０–３０．０Ｓ：拉近'), '全片进度 0%–100%：拉近')
        self.assertEqual(clean_text('0s-30s：拉近'), '全片进度 0%–100%：拉近')

    def test_invalid_timeline_and_empty_scene_are_not_submitted(self):
        for value in ['40–30秒', '30-35秒']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'DOLA_PROMPT_TIMELINE_INVALID'):
                clean_text(value)
        with self.assertRaisesRegex(RuntimeError, 'DOLA_PROMPT_EMPTY_AFTER_TIMING_CLEANUP'):
            build_prompt({'model': MODEL, 'durationSeconds': 30, 'prompt': '30s'})

    def test_non_dola_or_legacy_duration_keeps_text(self):
        for model, duration in [('Seedance 2.0 Mini', 15), (MODEL, 15)]:
            self.assertEqual(build_prompt({'model': model, 'durationSeconds': duration, 'prompt': '30s广告'}), '30s广告')

    def test_recovery_matches_cleaned_and_legacy_text_in_one_message(self):
        job = {'model': MODEL, 'durationSeconds': 30, 'prompt': '30s蓝色立方体', 'negativePrompt': '水印'}
        self.assertTrue(matches_prompt(job, 'Generated video: ' + build_prompt(job)))
        self.assertTrue(matches_prompt(job, '30s蓝色立方体\nVideo settings: 30 seconds\nAvoid: 水印'))
        self.assertFalse(matches_prompt(job, '蓝色立方体\nAvoid: 红色'))
        self.assertFalse(matches_prompt(job, '蓝色立方体'))
        self.assertFalse(matches_prompt(job, '另一件商品\nAvoid: 水印'))

    def test_rendered_lists_match_without_ignoring_semantic_hyphens_or_missing_text(self):
        raw='产品锁定\n- 6 组人物；\n* old-money 风格；\n+ 24-28mm 镜头；\n- -5°C 雪景。'
        rendered='产品锁定\n6 组人物；\nold-money 风格；\n24-28mm 镜头；\n-5°C 雪景。'
        job={'prompt':raw,'negativePrompt':'字幕'}
        self.assertTrue(matches_prompt(job,'Generated video: '+rendered+'\nAvoid: 字幕, 9:16'))
        for wrong in [rendered.replace('6 组','5 组'),rendered.replace('old-money','oldmoney'),
                      rendered.replace('24-28mm','2428mm'),rendered.replace('-5°C','5°C'),rendered[:20]]:
            self.assertFalse(matches_prompt(job,wrong+'\nAvoid: 字幕'))


if __name__ == '__main__':
    unittest.main()
