"""Generation must distinguish temporary profile occupancy from browser failure."""

import contextlib
import io
import json
from pathlib import Path
from runpy import run_path
import unittest
from unittest.mock import MagicMock, patch


class GenerationLaunchTests(unittest.TestCase):
    def test_logout_redirect_is_not_mislabeled_as_generic_browser_failure(self):
        worker = run_path(str(Path(__file__).with_name("run-image-to-video.py")))
        page = MagicMock()
        page.url = "https://www.doubao.com/chat/?from_logout=1"
        with self.assertRaisesRegex(RuntimeError, "LOGIN_EXPIRED_DURING_SUBMISSION"):
            worker["wait_for_doubao_task"](page)
        page.wait_for_timeout.assert_not_called()
        page.url = "https://www.doubao.com/chat/123456?tracking=example"
        self.assertEqual(worker["wait_for_doubao_task"](page), "https://www.doubao.com/chat/123456")
        page.url = "https://www.doubao.com/chat/local_123456"
        page.get_by_role.return_value.is_visible.return_value = False
        with self.assertRaisesRegex(RuntimeError, "DOUBAO_SUBMISSION_UNCONFIRMED"):
            worker["wait_for_doubao_task"](page, timeout_seconds=0)

    def test_occupied_profile_is_reported_without_submitting_or_exposing_raw_browser_errors(self):
        worker = run_path(str(Path(__file__).with_name("run-image-to-video.py")))
        job = {"mode": "image_to_video", "service": "doubao", "model": "Seedance 2.0 Mini",
               "durationSeconds": 5, "prompt": "test", "referenceAssets": [],
               "profilePath": str(Path.cwd() / "fixture-profile"), "outputPath": "test.mp4"}
        for detail, code in (
            ("Opening in existing browser session.", "PROFILE_IN_USE"),
            ("Failed to create a ProcessSingleton for your profile directory.", "PROFILE_IN_USE"),
            ("Executable doesn't exist at /browser/chrome", "BROWSER_LAUNCH_FAILED"),
        ):
            with self.subTest(code=code):
                playwright = MagicMock()
                playwright.__enter__.return_value.chromium.launch_persistent_context.side_effect = RuntimeError(detail)
                generate = MagicMock()
                output = io.StringIO()
                with patch("sys.stdin", io.StringIO(json.dumps(job))), contextlib.redirect_stdout(output), \
                     patch.dict(worker["main"].__globals__, {"sync_playwright": lambda: playwright,
                                                            "run_doubao": generate}):
                    self.assertEqual(worker["main"](), 1)
                self.assertEqual(json.loads(output.getvalue()), {"stage": "error", "code": code})
                generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
