"""Regression checks for the localized Symphony credit-page text."""

import unittest
from pathlib import Path
from runpy import run_path


verifier = run_path(str(Path(__file__).with_name("verify-symphony-profile.py")))
parse_credit_summary = verifier["parse_credit_summary"]
CREDIT_MARKERS = verifier["CREDIT_MARKERS"]


class SymphonyCreditParsingTests(unittest.TestCase):
    def test_chinese_credit_page(self):
        body = "本周剩余 Symphony 积分 了解更多 16,720 / 24,000 下次刷新日期：09月 21。"
        self.assertEqual(parse_credit_summary(body), {
            "remainingCredits": 16720,
            "totalCredits": 24000,
            "nextRefresh": "09-21",
        })

    def test_current_english_credit_page(self):
        body = (
            "This week’s remaining Symphony credits Learn more 400 / 400 "
            "Next refresh date: Oct 05. Unused Symphony credits won't roll over."
        )
        self.assertTrue(any(marker.lower() in body.lower() for marker in CREDIT_MARKERS))
        self.assertEqual(parse_credit_summary(body), {
            "remainingCredits": 400,
            "totalCredits": 400,
            "nextRefresh": "10-05",
        })

    def test_previous_english_credit_page(self):
        body = "Symphony credits remaining this week 1,234 / 4,000 Next refresh date: October 07."
        self.assertEqual(parse_credit_summary(body), {
            "remainingCredits": 1234,
            "totalCredits": 4000,
            "nextRefresh": "10-07",
        })


if __name__ == "__main__":
    unittest.main()
