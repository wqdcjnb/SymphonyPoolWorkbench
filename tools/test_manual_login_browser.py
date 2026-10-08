"""Isolated, offline checks for manually operated Chrome login windows."""

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

from desktop_routes import stop_file
from manual_login_browser import browser_command, manual_login_enabled


class ManualLoginConfigurationTests(unittest.TestCase):
    def test_manual_mode_is_explicit_and_doubao_only(self):
        with TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=True):
            self.assertFalse(manual_login_enabled(temporary, "doubao"))
            (Path(temporary) / ".manual-login-enabled").touch()
            self.assertTrue(manual_login_enabled(temporary, "doubao"))
            self.assertFalse(manual_login_enabled(temporary, "tiktok"))
            with patch.dict(os.environ, {"WORKBENCH_MANUAL_LOGIN": "0"}):
                self.assertFalse(manual_login_enabled(temporary, "doubao"))

    def test_configured_network_and_credentials_cannot_silently_be_ignored(self):
        for key in ("WORKBENCH_BROWSER_PROXY", "WORKBENCH_LOGIN_CREDENTIAL"):
            with self.assertRaisesRegex(RuntimeError, "CONFIGURATION_UNSUPPORTED"):
                browser_command("/profile", "about:blank", {key: "configured"})
        with patch("manual_login_browser.shutil.which", return_value="/usr/bin/google-chrome"):
            profile=str(Path('fixture-profile').resolve())
            command = browser_command(profile, "about:blank", {})
            self.assertIn(f"--user-data-dir={profile}", command)
            self.assertFalse(any("remote-debugging" in arg or "enable-automation" in arg for arg in command))

    def test_wrong_egress_prevents_manual_browser_launch(self):
        from types import SimpleNamespace
        from manual_login_browser import serve_manual_browser
        with TemporaryDirectory() as temporary:
            args=SimpleNamespace(profile=temporary, desktop_root=temporary, status_file=str(Path(temporary)/'ready.json'))
            with patch('manual_login_browser.browser_command',return_value=['chrome']), patch(
                    'manual_login_browser.verify_egress',side_effect=RuntimeError('EGRESS_IP_MISMATCH')), patch(
                    'manual_login_browser.subprocess.Popen') as launch:
                serve_manual_browser(args,'about:blank',lambda _:None)
                launch.assert_not_called()
                self.assertFalse(json.loads(Path(args.status_file).read_text())['ok'])


@unittest.skipUnless(os.environ.get("WORKBENCH_TEST_MANUAL_LOGIN") == "1", "offline Chrome fixture is opt-in")
class ManualLoginBrowserTests(unittest.TestCase):
    def test_xpra_reports_ready_before_a_client_has_connected(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile, status = root / 'profile', root / 'ready.json'
            profile.mkdir()
            # Use the production supervisor with an empty test profile. The test
            # container has --network none, so no platform account is contacted.
            child = subprocess.Popen([sys.executable, '/app/tools/open-browser-profile.py',
                '--serve', '--profile', str(profile), '--desktop-root', str(root),
                '--account-id', 'offline-manual-login', '--login-type', 'doubao', '--status-file', str(status)],
                env={**os.environ, 'WORKBENCH_MANUAL_LOGIN': '1'},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(350):
                    if status.exists():
                        break
                    if child.poll() is not None:
                        self.fail('Offline desktop exited before readiness')
                    time.sleep(0.1)
                self.assertTrue(status.exists(), 'Offline desktop readiness timed out')
                result = json.loads(status.read_text())
                self.assertTrue(result['ok'], result)
                self.assertIsNone(child.poll())
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()

    def test_isolated_windows_persist_cookies_close_and_reopen(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        visits = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path.startswith("/fixture"):
                    visits.append(self.headers.get("Cookie", ""))
                body = b'<html><title>Manual login fixture</title><input id="text"></html>'
                self.send_response(200)
                self.send_header("Set-Cookie", "fixture_session=offline; Path=/; Max-Age=3600")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        processes = []
        driver = '''
from runpy import run_path
from types import SimpleNamespace
import sys
from manual_login_browser import serve_manual_browser
launcher=run_path('/app/tools/open-browser-profile.py')
args=SimpleNamespace(profile=sys.argv[1],desktop_root=sys.argv[2],status_file=sys.argv[3])
serve_manual_browser(args,sys.argv[4],launcher['running_browser_pid'])
'''
        env = {**os.environ, "DISPLAY": ":83"}
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            try:
                xvfb = subprocess.Popen(["Xvfb", env["DISPLAY"], "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                processes.append(xvfb)
                for _ in range(40):
                    if subprocess.run(["xdpyinfo"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                        break
                    time.sleep(0.1)
                manager = subprocess.Popen(["openbox"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                processes.append(manager)

                def launch(name, attempt):
                    profile, state = root / name, root / (name + str(attempt) + '.json')
                    profile.mkdir(exist_ok=True)
                    child = subprocess.Popen([sys.executable, "-c", driver, str(profile), str(root), str(state),
                        f"http://127.0.0.1:{server.server_address[1]}/fixture"], env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    processes.append(child)
                    for _ in range(250):
                        if state.exists():
                            result=json.loads(state.read_text())
                            self.assertTrue(result['ok'])
                            return child, result['browserPid']
                        if child.poll() is not None:
                            self.fail('Fixture browser launcher exited before readiness')
                        time.sleep(0.1)
                    self.fail('Fixture browser did not become ready')

                a, pid_a = launch('profile-a', 1)
                b, pid_b = launch('profile-b', 1)
                self.assertNotEqual(pid_a, pid_b)
                for _ in range(40):
                    if len(visits) >= 2:
                        break
                    time.sleep(0.1)
                self.assertEqual(visits[:2], ['', ''])
                window = subprocess.check_output(['xdotool','search','--onlyvisible','--pid',str(pid_a)], env=env).decode().splitlines()[0]
                subprocess.run(['xdotool','windowactivate','--sync',window,'key','alt+F4'], env=env, check=True, timeout=5)
                a.wait(timeout=12)
                self.assertIsNone(b.poll())
                visits.clear()
                a2, _ = launch('profile-a', 2)
                for _ in range(40):
                    if visits:
                        break
                    time.sleep(0.1)
                self.assertIn('fixture_session=offline', visits[0])
                stop_file(root, root / 'profile-a').touch()
                stop_file(root, root / 'profile-b').touch()
                a2.wait(timeout=12)
                b.wait(timeout=12)
                self.assertFalse((root / 'profile-a' / 'SingletonLock').exists())
                self.assertFalse((root / 'profile-b' / 'SingletonLock').exists())
            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=12)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
