"""Contract tests for the optional Multilogin Mimic launcher adapter."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from multilogin_browser import launch_profile, token_from_file


class MultiloginBrowserTests(unittest.TestCase):
    def test_start_uses_headful_playwright_and_dynamic_port(self):
        folder = "11111111-1111-1111-1111-111111111111"
        profile = "22222222-2222-2222-2222-222222222222"
        with patch("multilogin_browser.request_json", return_value={"data": {"port": 45678}}) as request:
            self.assertEqual(launch_profile(folder, profile, "local-token"), 45678)
        route, token = request.call_args.args
        self.assertEqual(token, "local-token")
        self.assertEqual(route, f"/api/v2/profile/f/{folder}/p/{profile}/start"
                         "?automation_type=playwright&headless_mode=false")

    def test_missing_automation_port_fails_closed(self):
        with patch("multilogin_browser.request_json", return_value={"data": {}}):
            with self.assertRaisesRegex(RuntimeError, "MULTILOGIN_ENDPOINT_NOT_READY"):
                launch_profile("folder", "profile", "local-token")

    def test_token_is_read_from_local_file_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "token"
            file.write_text("local-token\n", encoding="utf-8")
            if os.name == "posix":
                file.chmod(0o600)
            with patch.dict(os.environ, {"WORKBENCH_MULTILOGIN_TOKEN_FILE": str(file)}):
                self.assertEqual(token_from_file(), "local-token")
            file.write_text("", encoding="utf-8")
            with patch.dict(os.environ, {"WORKBENCH_MULTILOGIN_TOKEN_FILE": str(file)}):
                with self.assertRaisesRegex(RuntimeError, "MULTILOGIN_NOT_CONFIGURED"):
                    token_from_file()


if __name__ == "__main__":
    unittest.main()
