"""Opt-in Linux integration test: WORKBENCH_TEST_DESKTOP=1 python tools/test_login_desktop.py."""

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from desktop_routes import DesktopRoutes, existing_session, process_identity


def desktop_connects(port):
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
            b"Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n"
            b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        return connection.recv(4096).startswith(b"HTTP/1.1 101")


@unittest.skipUnless(sys.platform == "linux" and os.environ.get("WORKBENCH_TEST_DESKTOP") == "1",
                     "Requires opt-in Linux virtual desktop/browser integration environment")
class LiveDesktopTests(unittest.TestCase):
    def test_two_accounts_reopen_and_cleanup_without_crossing_sessions(self):
        sessions = []
        with tempfile.TemporaryDirectory(prefix="desktop-isolation-test-") as temporary:
            root = Path(temporary)
            registry = root / "sessions"

            def launch(account):
                profile = root / account
                env = {**os.environ, "DISPLAY": ":99"}
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("open-browser-profile.py")),
                    "--profile", str(profile), "--login-type", "doubao", "--account-id", account,
                    "--desktop-root", str(registry)], env=env, capture_output=True, text=True, timeout=45)
                payload = json.loads(result.stdout)
                self.assertEqual(result.returncode, 0, payload)
                session = existing_session(registry, profile, account)
                self.assertIsNotNone(session)
                if not any(item["token"] == session["token"] for item in sessions):
                    sessions.append(session)
                return payload, session

            try:
                _, a = launch("test-account-a")
                _, b = launch("test-account-b")
                for field in ("profile", "display", "port", "token"):
                    self.assertNotEqual(a[field], b[field], field)
                plugin = DesktopRoutes(registry)
                for session in (a, b):
                    self.assertEqual(plugin.lookup(session["token"]), ("127.0.0.1", session["port"]))
                    self.assertTrue(desktop_connects(session["port"]))
                print("PASS: live accounts have separate Xpra servers, displays, ports and profiles.", flush=True)
                # Reproduce generation colliding with an open login window. No platform
                # submission is reached: Chromium must refuse this already-owned profile.
                occupied = subprocess.run([sys.executable, str(Path(__file__).with_name("run-image-to-video.py"))],
                    input=json.dumps({"profilePath": a["profile"], "outputPath": str(root / "unused.mp4"),
                        "mode": "image_to_video", "service": "doubao", "model": "Seedance 2.0 Mini",
                        "durationSeconds": 5, "prompt": "test", "referenceAssets": []}),
                    env={**os.environ, "DISPLAY": a["display"]}, capture_output=True, text=True, timeout=15)
                self.assertEqual(json.loads(occupied.stdout), {"stage": "error", "code": "PROFILE_IN_USE"})
                self.assertFalse((root / "unused.mp4").exists())
                print("PASS: generation detects login occupancy before submitting anything.", flush=True)
                repeated, same = launch("test-account-a")
                self.assertTrue(repeated["alreadyOpen"])
                self.assertEqual(same["token"], a["token"])
                self.assertIsNone(plugin.lookup(""))
                self.assertIsNone(plugin.lookup("f" * 64))
                marker = root / "test-account-a" / "persistence-marker"
                marker.write_text("preserve")
                os.kill(a["manager"]["pid"], signal.SIGTERM)
                for _ in range(200):
                    if process_identity(a["manager"]["pid"]) != a["manager"]:
                        break
                    time.sleep(0.1)
                self.assertIsNone(plugin.lookup(a["token"]))
                self.assertEqual(plugin.lookup(b["token"]), ("127.0.0.1", b["port"]))
                _, new_a = launch("test-account-a")
                self.assertNotEqual(new_a["token"], a["token"])
                self.assertIsNone(plugin.lookup(a["token"]))
                self.assertEqual(marker.read_text(), "preserve")
                print("PASS: reuse, expired links, independent cleanup and retained profiles.", flush=True)
            finally:
                for session in sessions:
                    if process_identity(session["manager"]["pid"]) == session["manager"]:
                        os.kill(session["manager"]["pid"], signal.SIGTERM)
                for _ in range(200):
                    if all(process_identity(item["manager"]["pid"]) != item["manager"] for item in sessions):
                        break
                    time.sleep(0.1)


if __name__ == "__main__":
    unittest.main()
