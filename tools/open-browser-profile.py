"""Open a persistent login window on Linux; return only after the browser starts."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

from browser_runtime import generation_browser_options


URLS = {
    "tiktok": "https://ads.tiktok.com/creative/creativestudio/settings/credit",
    "doubao": "https://www.doubao.com/chat/",
}


def status_code(error):
    text = str(error).lower()
    if "processsingleton" in text or "user data directory is already in use" in text:
        return "PROFILE_IN_USE"
    if str(error) == "INVALID_BROWSER_CHANNEL":
        return "INVALID_BROWSER_CHANNEL"
    return "PROFILE_LAUNCH_FAILED"


def serve(args):
    status = Path(args.status_file)
    ready = False

    # Keep the default SIGTERM action. Closing the Playwright pipe tears down its browser;
    # raising inside a synchronous Playwright call can deadlock its event dispatcher.
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                args.profile, **generation_browser_options(), headless=False,
                args=["--profile-directory=Default"], timeout=20_000,
                viewport={"width": 1440, "height": 900}, accept_downloads=False,
            )
            try:
                # Startup is independent of platform network latency. Login errors remain visible.
                status.write_text(json.dumps({"ok": True}), encoding="utf-8")
                ready = True
                page = context.pages[0] if context.pages else context.new_page()
                try:
                    page.goto(URLS[args.login_type], wait_until="domcontentloaded", timeout=60_000)
                except Exception:
                    pass
                while context.pages:
                    context.pages[0].wait_for_timeout(500)
            finally:
                context.close()
    except (Exception, KeyboardInterrupt) as error:
        if not ready:
            status.write_text(json.dumps({"ok": False, "error": status_code(error)}), encoding="utf-8")


def launch(args):
    if not os.environ.get("DISPLAY"):
        return {"ok": False, "error": "DISPLAY_NOT_CONFIGURED"}
    profile = Path(args.profile)
    if not profile.is_absolute():
        return {"ok": False, "error": "PROFILE_LAUNCH_FAILED"}
    generation_browser_options()  # Reject invalid channel before starting a child.
    profile.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="symphony-login-") as temporary:
        status = Path(temporary) / "status.json"
        child = subprocess.Popen([
            sys.executable, str(Path(__file__).resolve()), "--serve", "--status-file", str(status),
            "--profile", str(profile), "--login-type", args.login_type,
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True)
        for _ in range(240):
            if status.is_file():
                try:
                    return json.loads(status.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    pass
            if child.poll() is not None:
                break
            time.sleep(0.1)
        # A timed out launch must not later open an untracked browser on this profile.
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        return {"ok": False, "error": "PROFILE_LAUNCH_FAILED"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--login-type", choices=tuple(URLS), required=True)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--status-file")
    args = parser.parse_args()
    if args.serve:
        if not args.status_file:
            parser.error("--serve requires --status-file")
        serve(args)
        return 0
    try:
        result = launch(args)
    except Exception as error:
        result = {"ok": False, "error": status_code(error)}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
