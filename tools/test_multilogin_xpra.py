"""Opt-in Linux Xpra integration without a vendor account or real browser profile."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from desktop_routes import DesktopRoutes, existing_session, process_identity, stop_file, write_session
from login_desktop import LoginDesktop


def helper(args):
    if args.browser:
        write_session(args.status_file, {"ok": True, "browserPid": os.getpid(),
            "browserProvider": "multilogin", "endpointPort": 45678})
        while not stop_file(args.desktop_root, args.profile).exists():
            time.sleep(0.1)
    elif args.serve:
        LoginDesktop(args.desktop_root, args.profile, args.account_id).run(
            [sys.executable, str(Path(__file__).resolve()), "--browser", "--profile", args.profile,
             "--account-id", args.account_id], args.status_file)


@unittest.skipUnless(sys.platform == "linux" and os.environ.get("WORKBENCH_TEST_DESKTOP") == "1",
                     "Requires opt-in Linux Xpra environment")
class MimicXpraTests(unittest.TestCase):
    def test_vendor_supervisor_routes_a_private_desktop(self):
        with tempfile.TemporaryDirectory(prefix="mimic-xpra-test-") as temporary:
            root = Path(temporary)
            profile = root / "profile"
            desktop_root = root / "desktops"
            status = root / "status.json"
            manager = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                "--serve", "--profile", str(profile), "--account-id", "mimic-test",
                "--desktop-root", str(desktop_root), "--status-file", str(status)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(250):
                    if status.exists() or manager.poll() is not None:
                        break
                    time.sleep(0.1)
                self.assertTrue(status.exists(), "Xpra supervisor did not start")
                result = json.loads(status.read_text(encoding="utf-8"))
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["browserProvider"], "multilogin")
                self.assertEqual(result["endpointPort"], 45678)
                session = existing_session(desktop_root, profile, "mimic-test")
                self.assertIsNotNone(session)
                self.assertEqual(DesktopRoutes(desktop_root).lookup(session["token"]),
                                 ("127.0.0.1", session["port"]))
                self.assertIsNone(DesktopRoutes(desktop_root).lookup("f" * 64))
            finally:
                if manager.poll() is None:
                    os.kill(manager.pid, signal.SIGTERM)
                    manager.wait(timeout=20)
                if status.exists():
                    session = existing_session(desktop_root, profile, "mimic-test")
                    self.assertIsNone(session)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--profile")
    parser.add_argument("--account-id")
    parser.add_argument("--desktop-root")
    parser.add_argument("--status-file")
    args, _ = parser.parse_known_args()
    if args.serve or args.browser:
        helper(args)
    else:
        unittest.main()
