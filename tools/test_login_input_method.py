"""Offline regression; requires Chrome, Fcitx, Xpra server/client-gtk3, Xvfb and Openbox.

Run with WORKBENCH_TEST_INPUT_METHOD=1 python tools/test_login_input_method.py.
"""

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

from desktop_routes import existing_session, stop_file, write_session
from login_desktop import LoginDesktop


def fixture_browser(args):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            args.profile, channel="chrome", headless=False, no_viewport=True,
            args=["--window-size=1000,700"], timeout=20000)
        try:
            page = context.pages[0]
            page.set_content('<meta charset="utf-8"><title>IME regression</title>'
                             '<textarea id="entry" autofocus style="width:600px;height:300px"></textarea>')
            page.locator("#entry").focus()
            pid = int(os.readlink(Path(args.profile) / "SingletonLock").rsplit("-", 1)[1])
            write_session(args.status_file, {"ok": True, "browserPid": pid})
            while context.pages and not stop_file(args.desktop_root, args.profile).exists():
                write_session(Path(args.profile) / "input.json", {"text": page.locator("#entry").input_value()})
                page.wait_for_timeout(100)
        finally:
            context.close()


@unittest.skipUnless(sys.platform == "linux" and os.environ.get("WORKBENCH_TEST_INPUT_METHOD") == "1",
                     "Requires opt-in Linux Chrome/Xpra/Fcitx integration environment")
class InputMethodTests(unittest.TestCase):
    def test_pinyin_ascii_isolation_and_cleanup(self):
        managers = []
        clients = []
        client_logs = []
        with tempfile.TemporaryDirectory(prefix="ime-test-") as temporary:
            root = Path(temporary)
            registry = root / "desktops"

            def wait_for(check, timeout=30):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    result = check()
                    if result:
                        return result
                    time.sleep(0.1)
                self.fail("Input test timed out")

            def launch(account):
                profile = root / account
                status = root / f"{account}.json"
                child = subprocess.Popen([sys.executable, __file__, "--serve", "--profile", str(profile),
                    "--account-id", account, "--desktop-root", str(registry), "--status-file", str(status)])
                managers.append(child)
                wait_for(status.exists)
                self.assertTrue(json.loads(status.read_text())["ok"])
                session = existing_session(registry, profile, account)
                self.assertIsNotNone(session)
                raw = Path(f"/proc/{session['browser']['pid']}/environ").read_bytes()
                env = dict(item.decode().split("=", 1) for item in raw.split(b"\0") if b"=" in item)
                wait_for(lambda: (profile / "input.json").exists())
                client_env = {**os.environ, "DISPLAY": f":{90 + len(managers)}"}
                for command in (
                    ["Xvfb", client_env["DISPLAY"], "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                    ["openbox"],
                    ["xpra", "attach", f"ws://127.0.0.1:{session['port']}/", "--splash=no",
                     "--audio=no", "--opengl=no", "--notifications=no", "--clipboard=no",
                     "--keyboard-layout=cn", "--modal-windows=no"],
                ):
                    log = (root / f"{account}-{command[0]}.log").open("w")
                    client_logs.append(log)
                    client = subprocess.Popen(command, env=client_env,
                        stdout=log, stderr=log)
                    clients.append(client)
                    if command[0] == "Xvfb":
                        wait_for(lambda: Path(f"/tmp/.X11-unix/X{client_env['DISPLAY'][1:]}").exists())
                wait_for(lambda: subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "IME regression"],
                    env=client_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0)
                return profile, env, client_env, child

            def run(env, *command):
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()

            def key(env, *keys):
                run(env, "xdotool", "key", "--clearmodifiers", *keys)

            def content(profile):
                return json.loads((profile / "input.json").read_text())["text"]

            def focus(env):
                window = run(env, "xdotool", "search", "--onlyvisible", "--name", "IME regression").splitlines()[-1]
                run(env, "xdotool", "windowactivate", "--sync", window)
                run(env, "xdotool", "mousemove", "--window", window, "100", "230", "click", "1")
                time.sleep(0.3)

            try:
                a, env_a, client_a, manager_a = launch("account-a")
                b, env_b, client_b, manager_b = launch("account-b")
                for field in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
                    self.assertNotEqual(env_a[field], env_b[field])
                focus(client_a)
                run(client_a, "xdotool", "type", "--clearmodifiers", "abc123")
                wait_for(lambda: content(a) == "abc123")
                key(client_a, "ctrl+shift+space")
                run(client_a, "xdotool", "type", "--clearmodifiers", "nihao")
                key(client_a, "space")
                wait_for(lambda: content(a) == "abc123\u4f60\u597d")
                self.assertEqual(content(b), "")
                print("PASS: physical key events commit Pinyin in Chrome; second account stays empty.", flush=True)

                # Stop account A while B still has a live bus and input method.
                manager_a.send_signal(signal.SIGTERM)
                manager_a.wait(timeout=20)
                focus(client_b)
                key(client_b, "F8")
                run(client_b, "xdotool", "type", "--clearmodifiers", "zhongwen")
                key(client_b, "space")
                wait_for(lambda: content(b) == "\u4e2d\u6587")
                key(client_b, "F8", "Num_Lock", "KP_1", "KP_2", "KP_3")
                wait_for(lambda: content(b) == "\u4e2d\u6587123")
                manager_b.send_signal(signal.SIGTERM)
                manager_b.wait(timeout=20)
                for env in (env_a, env_b):
                    self.assertFalse(Path(env["XDG_CONFIG_HOME"]).exists())
                    self.assertFalse(Path(env["DBUS_SESSION_BUS_ADDRESS"].removeprefix("unix:path=")).exists())
                print("PASS: independent cleanup, Chinese/English switching and numeric keypad.", flush=True)
            except Exception:
                for state in root.glob("account-*/input.json"):
                    print(state.parent.name, state.read_text())
                for log in (*root.glob("*-xpra.log"), *registry.glob("*.input-method.log")):
                    print(log.name, log.read_text(errors="replace")[-1500:])
                raise
            finally:
                for manager in managers:
                    if manager.poll() is None:
                        manager.terminate()
                        manager.wait(timeout=20)
                for client in reversed(clients):
                    if client.poll() is None:
                        client.terminate()
                        client.wait(timeout=5)
                for log in client_logs:
                    log.close()


if __name__ == "__main__":
    if "--serve" in sys.argv or "--browser" in sys.argv:
        parser = argparse.ArgumentParser()
        parser.add_argument("--serve", action="store_true")
        parser.add_argument("--browser", action="store_true")
        parser.add_argument("--profile", required=True)
        parser.add_argument("--account-id", required=True)
        parser.add_argument("--desktop-root", required=True)
        parser.add_argument("--status-file", required=True)
        args = parser.parse_args()
        if args.browser:
            fixture_browser(args)
        else:
            LoginDesktop(args.desktop_root, args.profile, args.account_id).run([
                sys.executable, __file__, "--browser", "--profile", args.profile,
                "--account-id", args.account_id], args.status_file)
    else:
        unittest.main()
