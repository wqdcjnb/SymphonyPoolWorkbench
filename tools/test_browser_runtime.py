"""Regression checks for shared browser selection and unattended Linux startup."""

import os
from pathlib import Path
from runpy import run_path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from browser_runtime import browser_channels, generation_browser_options


class BrowserRuntimeTests(unittest.TestCase):
    def test_explicit_browser_is_used_without_falling_back_to_another_installation(self):
        self.assertEqual(browser_channels({"WORKBENCH_BROWSER_CHANNEL": "chromium"}), (None,))
        self.assertEqual(generation_browser_options({"WORKBENCH_BROWSER_CHANNEL": "chromium"}), {})
        self.assertEqual(generation_browser_options({"WORKBENCH_BROWSER_CHANNEL": "chrome"}), {"channel": "chrome"})

    def test_unconfigured_generation_keeps_chrome_and_invalid_channels_are_rejected(self):
        self.assertEqual(generation_browser_options({}), {"channel": "chrome"})
        with self.assertRaisesRegex(RuntimeError, "INVALID_BROWSER_CHANNEL"):
            browser_channels({"WORKBENCH_BROWSER_CHANNEL": "a-browser-path"})

    def test_linux_login_without_a_display_fails_before_creating_a_profile(self):
        launcher = run_path(str(Path(__file__).with_name("open-browser-profile.py")))
        with patch.dict(os.environ, {}, clear=True):
            result = launcher["launch"](SimpleNamespace(profile="must-not-be-created", login_type="doubao"))
        self.assertEqual(result, {"ok": False, "error": "DISPLAY_NOT_CONFIGURED"})


if __name__ == "__main__":
    unittest.main()
