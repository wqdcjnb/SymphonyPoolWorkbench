"""Regression tests for account isolation, stale sessions and PID/port reuse."""

from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import desktop_routes as routes


class DesktopRoutesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.proc = self.root / "proc"
        (self.root / "routes").mkdir()

    def process(self, pid, args):
        folder = self.proc / str(pid)
        folder.mkdir(parents=True)
        # State through starttime: Linux /proc/<pid>/stat fields 3..22.
        (folder / "stat").write_text(f"{pid} (test process) S " + "0 " * 18 + f"{pid * 100} 0")
        (folder / "cmdline").write_bytes(b"\0".join(os.fsencode(arg) for arg in args) + b"\0")
        return routes.process_identity(pid, self.proc)

    def session(self, account, number):
        profile, display, port = f"/profiles/{account}", f":{100 + number}", 20000 + number
        base = number * 10
        session = {"version": 2, "token": str(number) * 64, "accountId": account,
            "profile": profile, "display": display, "port": port,
            "manager": self.process(base + 1, ["python", "open-browser-profile.py", "--serve", "--profile", profile, "--account-id", account]),
            "browser": self.process(base + 2, ["/opt/google/chrome/chrome", f"--user-data-dir={profile}"]),
            "xpra": self.process(base + 3, ["/usr/bin/python3", "/usr/bin/xpra", "start", display, f"--bind-ws=127.0.0.1:{port}"]),
            "xvfb": self.process(base + 4, ["Xvfb", display])}
        routes.write_session(self.root / "routes" / f"{session['token']}.json", session)
        routes.write_session(self.root / f"{routes.profile_key(profile)}.json", session)
        return session

    def test_accounts_resolve_only_to_their_own_desktop_and_reopen_the_same_session(self):
        a, b = self.session("account-a", 1), self.session("account-b", 2)
        validate = routes.valid_session
        with patch.object(routes, "valid_session", side_effect=lambda value: validate(value, self.proc)):
            plugin = routes.DesktopRoutes(self.root)
            self.assertEqual(plugin.lookup(a["token"]), ("127.0.0.1", a["port"]))
            self.assertEqual(plugin.lookup(b["token"]), ("127.0.0.1", b["port"]))
            self.assertEqual(routes.existing_session(self.root, a["profile"], "account-a"), a)
            self.assertIsNone(routes.existing_session(self.root, a["profile"], "account-b"))
            for token in (None, "", "../account-a", "f" * 64):
                self.assertIsNone(plugin.lookup(token))

    def test_switching_viewer_revokes_old_account_connection_without_stopping_its_browser(self):
        a, b = self.session("account-a", 1), self.session("account-b", 2)
        viewer = "c" * 64
        a["viewerId"] = b["viewerId"] = viewer
        (self.root / "viewers").mkdir()
        for value in (a, b):
            routes.write_session(self.root / "routes" / f"{value['token']}.json", value)
        validate = routes.valid_session
        with patch.object(routes, "valid_session", side_effect=lambda value: validate(value, self.proc)):
            plugin = routes.DesktopRoutes(self.root)
            selected = self.root / "viewers" / f"{viewer}.json"
            routes.write_session(selected, {"accountId": "account-a", "token": a["token"]})
            self.assertIsNotNone(plugin.lookup(a["token"]))
            self.assertIsNone(plugin.lookup(b["token"]))
            routes.write_session(selected, {"accountId": "account-b", "token": b["token"]})
            self.assertIsNone(plugin.lookup(a["token"]))
            self.assertIsNotNone(plugin.lookup(b["token"]))
            self.assertTrue(routes.valid_session(a))
            selected.unlink()
            self.assertIsNone(plugin.lookup(b["token"]))
            self.assertTrue(routes.valid_session(b))

    def test_reused_pid_or_port_cannot_resolve_to_another_account(self):
        a = self.session("account-a", 1)
        self.assertTrue(routes.valid_session(a, self.proc))
        for kind in ("manager", "browser", "xpra", "xvfb"):
            changed = deepcopy(a)
            changed[kind]["start"] = "another-process"
            self.assertFalse(routes.valid_session(changed, self.proc), kind)
        changed = deepcopy(a)
        changed["profile"] = "/profiles/account-b"
        self.assertFalse(routes.valid_session(changed, self.proc))
        (self.proc / str(a["xpra"]["pid"]) / "cmdline").write_bytes(b"\0".join([b"/usr/bin/xpra", b"start", b":999", b"--bind-ws=127.0.0.1:20001"]))
        self.assertFalse(routes.valid_session(a, self.proc))

    def test_exited_browser_and_corrupt_registry_are_rejected(self):
        a = self.session("account-a", 1)
        (self.proc / str(a["browser"]["pid"]) / "stat").unlink()
        validate = routes.valid_session
        with patch.object(routes, "valid_session", side_effect=lambda value: validate(value, self.proc)):
            self.assertIsNone(routes.DesktopRoutes(self.root).lookup(a["token"]))
        for content in ("not json", "[]", "null", json.dumps({"version": 1})):
            (self.root / "routes" / f"{a['token']}.json").write_text(content)
            self.assertIsNone(routes.DesktopRoutes(self.root).lookup(a["token"]))


if __name__ == "__main__":
    unittest.main()
