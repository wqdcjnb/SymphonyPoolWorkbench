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

    def test_existing_login_is_recognized_only_for_its_own_live_browser(self):
        launcher = run_path(str(Path(__file__).with_name("open-browser-profile.py")))
        profile = Path.cwd() / "account-profile"
        cmdline = os.fsencode("/opt/google/chrome/chrome") + b"\0" + os.fsencode(
            f"--user-data-dir={profile}") + b"\0"
        with patch("os.readlink", return_value="test-host-123"), \
             patch("socket.gethostname", return_value="test-host"), \
             patch.object(Path, "read_bytes", return_value=cmdline):
            self.assertEqual(launcher["running_browser_pid"](profile), 123)
        with patch("os.readlink", return_value="test-host-123"), \
             patch("socket.gethostname", return_value="test-host"), \
             patch.object(Path, "read_bytes", return_value=b"chrome\0--user-data-dir=/other\0"):
            self.assertIsNone(launcher["running_browser_pid"](profile))


if __name__ == "__main__":
    unittest.main()
