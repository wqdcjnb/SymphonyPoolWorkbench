"""Regression checks for shared browser selection and unattended Linux startup."""

import os
from pathlib import Path
from runpy import run_path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import tempfile
import threading
import time
import urllib.request

from browser_runtime import browser_channels, generation_browser_options


class BrowserRuntimeTests(unittest.TestCase):
    def test_closing_first_tab_keeps_the_remaining_task_window_alive(self):
        from playwright.sync_api import sync_playwright
        launcher = run_path(str(Path(__file__).with_name('open-browser-profile.py')))
        with tempfile.TemporaryDirectory(prefix='browser-lifetime-test-') as directory, sync_playwright() as p:
            context = p.chromium.launch_persistent_context(directory, channel='chrome', headless=True,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0'])
            requested_stop = Path(directory) / 'stop-test'
            errors = []
            thread = None
            try:
                first = context.pages[0]
                task = context.new_page()
                task.set_content('<p>Original task</p>')
                task.evaluate('window.taskIdentity="unchanged"')
                session = context.new_cdp_session(first)
                target = session.send('Target.getTargetInfo')['targetInfo']['targetId']
                session.detach()
                port = (Path(directory) / 'DevToolsActivePort').read_text().splitlines()[0]
                def close_first_only():
                    try:
                        time.sleep(.15)
                        with urllib.request.urlopen('http://127.0.0.1:' + port + '/json/close/' + target, timeout=3) as response:
                            response.read()
                        time.sleep(.35)
                    except Exception as error:
                        errors.append(type(error).__name__)
                    finally:
                        requested_stop.touch()
                thread = threading.Thread(target=close_first_only)
                thread.start()
                self.assertEqual(launcher['wait_for_browser'](context, requested_stop), 'stop_requested')
                self.assertEqual(errors, [])
                self.assertTrue(first.is_closed())
                self.assertFalse(task.is_closed())
                self.assertEqual(task.evaluate('window.taskIdentity'), 'unchanged')
                self.assertEqual(len(context.pages), 1)
            finally:
                if thread:
                    thread.join(timeout=5)
                context.close()

    def test_browser_loop_does_not_hide_a_live_page_transport_error(self):
        launcher = run_path(str(Path(__file__).with_name('open-browser-profile.py')))
        context, page, requested_stop = MagicMock(), MagicMock(), MagicMock()
        context.pages = [page]
        requested_stop.exists.return_value = False
        page.is_closed.return_value = False
        page.wait_for_timeout.side_effect = RuntimeError('TEST_TRANSPORT_ERROR')
        with self.assertRaisesRegex(RuntimeError, 'TEST_TRANSPORT_ERROR'):
            launcher['wait_for_browser'](context, requested_stop)
        page.close.assert_not_called()

    def test_browser_loop_handles_last_window_and_requested_shutdown(self):
        launcher = run_path(str(Path(__file__).with_name('open-browser-profile.py')))
        context, requested_stop = MagicMock(), MagicMock()
        context.pages = []
        requested_stop.exists.return_value = False
        self.assertEqual(launcher['wait_for_browser'](context, requested_stop), 'all_windows_closed')
        requested_stop.exists.return_value = True
        self.assertEqual(launcher['wait_for_browser'](context, requested_stop), 'stop_requested')

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
