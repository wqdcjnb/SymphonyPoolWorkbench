"""Occupied login windows must not look like missing browser installations."""

import contextlib
import io
import json
import os
from pathlib import Path
from runpy import run_path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from browser_runtime import profile_in_use_error


class VerificationLaunchTests(unittest.TestCase):
    def test_both_chromium_occupancy_messages_are_recognized(self):
        for detail in (
            "BrowserType.launch_persistent_context: Opening in existing browser session.",
            "Failed to create a ProcessSingleton for your profile directory.",
            "The profile is already in use by another instance of Chromium.",
        ):
            with self.subTest(detail=detail):
                self.assertTrue(profile_in_use_error(RuntimeError(detail)))
        self.assertFalse(profile_in_use_error(RuntimeError("Executable doesn't exist at /browser/chrome")))
        self.assertFalse(profile_in_use_error(RuntimeError("Missing X server or $DISPLAY")))

    def test_occupied_profile_stops_fallback_and_both_verifiers_report_profile_in_use(self):
        for filename in ("verify-doubao-profile.py", "verify-symphony-profile.py"):
            with self.subTest(verifier=filename), tempfile.TemporaryDirectory() as profile:
                verifier = run_path(str(Path(__file__).with_name(filename)))
                playwright = MagicMock()
                launch = playwright.__enter__.return_value.chromium.launch_persistent_context
                launch.side_effect = RuntimeError(
                    "BrowserType.launch_persistent_context: Opening in existing browser session. "
                    "<process did exit: exitCode=0, signal=null>"
                )
                output = io.StringIO()
                with patch.dict(os.environ, {"WORKBENCH_BROWSER_CHANNEL": ""}), \
                     patch("sys.argv", [filename, "--headed", "--profile", profile]), \
                     patch.dict(verifier["main"].__globals__, {"sync_playwright": lambda: playwright}), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(verifier["main"](), 3)
                summary = json.loads(output.getvalue())
                self.assertEqual(summary["error"], "PROFILE_IN_USE")
                self.assertFalse(summary["ok"])
                self.assertEqual(launch.call_count, 1)

    def test_missing_executable_is_not_mislabeled_as_profile_in_use(self):
        for filename in ("verify-doubao-profile.py", "verify-symphony-profile.py"):
            with self.subTest(verifier=filename), tempfile.TemporaryDirectory() as profile:
                verifier = run_path(str(Path(__file__).with_name(filename)))
                playwright = MagicMock()
                playwright.__enter__.return_value.chromium.launch_persistent_context.side_effect = RuntimeError(
                    "Executable doesn't exist at /browser/chrome"
                )
                output = io.StringIO()
                with patch.dict(os.environ, {"WORKBENCH_BROWSER_CHANNEL": "chrome"}), \
                     patch("sys.argv", [filename, "--profile", profile]), \
                     patch.dict(verifier["main"].__globals__, {"sync_playwright": lambda: playwright}), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(verifier["main"](), 3)
                self.assertTrue(json.loads(output.getvalue())["error"].startswith("BROWSER_LAUNCH_FAILED"))


if __name__ == "__main__":
    unittest.main()
