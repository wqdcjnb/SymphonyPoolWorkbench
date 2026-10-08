"""Open a persistent login window on Linux; return only after the browser starts."""

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

from browser_runtime import generation_browser_options, verify_egress
from desktop_routes import existing_session, process_identity, profile_key, stop_file, write_session
from login_desktop import LoginDesktop, desktop_result
from login_diagnostics import attach_login_diagnostics
from manual_login_browser import manual_login_enabled, serve_manual_browser


URLS = {
    "tiktok": "https://ads.tiktok.com/creative/creativestudio/settings/credit",
    "doubao": "https://www.doubao.com/chat/",
    "dola": "https://www.dola.com/chat/",
}


def status_code(error):
    text = str(error).lower()
    if str(error) in ("EGRESS_CHECK_FAILED", "EGRESS_IP_MISMATCH",
                      "MULTILOGIN_NOT_CONFIGURED", "MULTILOGIN_BUSY",
                      "MULTILOGIN_AGENT_IN_USE",
                      "MULTILOGIN_AGENT_FAILED", "MULTILOGIN_API_FAILED",
                      "MULTILOGIN_ENDPOINT_NOT_READY", "MULTILOGIN_PROFILE_FAILED"):
        return str(error)
    if "processsingleton" in text or "user data directory is already in use" in text:
        return "PROFILE_IN_USE"
    if str(error) == "INVALID_BROWSER_CHANNEL":
        return "INVALID_BROWSER_CHANNEL"
    return "PROFILE_LAUNCH_FAILED"


def running_browser_pid(profile, proc_root=Path("/proc"), hostname=None):
    """Recognize only a live Chrome process holding this exact profile."""
    lock = profile / "SingletonLock"
    try:
        target = os.readlink(lock)
        prefix = f"{hostname or socket.gethostname()}-"
        if not target.startswith(prefix):
            return None
        pid = int(target[len(prefix):])
        args = (proc_root / str(pid) / "cmdline").read_bytes().split(b"\0")
        browser = Path(os.fsdecode(args[0])).name.lower()
        profile_arg = os.fsencode(f"--user-data-dir={profile}")
        if browser not in ("chrome", "chromium") or profile_arg not in args:
            return None
        return pid
    except (OSError, ValueError, IndexError):
        return None


def wait_for_browser(context, requested_stop):
    """A closed tab must not close the other task or verification windows."""
    while not requested_stop.exists():
        pages = list(context.pages)
        if not pages:
            return 'all_windows_closed'
        observed = pages[0]
        try:
            observed.wait_for_timeout(500)
        except Exception:
            remaining = [page for page in context.pages if not page.is_closed()]
            if observed.is_closed() and remaining:
                continue
            if not remaining:
                return 'all_windows_closed'
            raise
    return 'stop_requested'


def serve_browser(args):
    if os.environ.get("WORKBENCH_BROWSER_PROVIDER") == "multilogin":
        from multilogin_browser import serve
        serve(args, URLS[args.login_type])
        return
    if manual_login_enabled(args.desktop_root, args.login_type):
        return serve_manual_browser(args, URLS[args.login_type], running_browser_pid)
    status = Path(args.status_file)
    ready = False
    exit_reason = 'startup_failed'

    # Keep the default SIGTERM action. Closing the Playwright pipe tears down its browser;
    # raising inside a synchronous Playwright call can deadlock its event dispatcher.
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                args.profile, **generation_browser_options(), headless=False,
                args=["--profile-directory=Default", "--window-size=1280,800",
                      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], timeout=20_000,
                no_viewport=True, accept_downloads=False,
            )
            try:
                attach_login_diagnostics(context, args.desktop_root, args.profile, args.login_type)
                verify_egress(context)
                credential = json.loads(os.environ.get("WORKBENCH_LOGIN_CREDENTIAL", "{}"))
                if credential.get("cookies"):
                    context.add_cookies(credential["cookies"])
                # Startup is independent of platform network latency. Login errors remain visible.
                write_session(status, {"ok": True, "browserPid": running_browser_pid(Path(args.profile))})
                ready = True
                page = context.pages[0] if context.pages else context.new_page()
                try:
                    page.goto(URLS[args.login_type], wait_until="commit", timeout=8_000)
                except Exception:
                    pass
                # Fill only visible, unambiguous fields. Verification remains with the user.
                if credential.get("identifier"):
                    try:
                        fields = page.locator('input[type="email"], input[type="tel"], input[name="email"], input[name="mobile"]')
                        visible = [fields.nth(i) for i in range(fields.count()) if fields.nth(i).is_visible()]
                        if len(visible) == 1:
                            visible[0].fill(credential["identifier"])
                        password = page.locator('input[type="password"]')
                        if credential.get("password") and password.count() == 1 and password.is_visible():
                            password.fill(credential["password"])
                    except Exception:
                        pass
                exit_reason = wait_for_browser(context, stop_file(args.desktop_root, args.profile))
            finally:
                context.close()
    except (Exception, KeyboardInterrupt) as error:
        exit_reason = type(error).__name__
        if not ready:
            write_session(status, {"ok": False, "error": status_code(error)})
    finally:
        if ready:
            try:
                # Keep the previous exit cause after the next launch overwrites its log.
                write_session(Path(args.desktop_root) / (profile_key(args.profile) + '.browser-exit.json'),
                              {'at': int(time.time() * 1000), 'reason': exit_reason})
            except OSError:
                pass


def launch(args):
    if not os.environ.get("DISPLAY"):
        return {"ok": False, "error": "DISPLAY_NOT_CONFIGURED"}
    profile = Path(args.profile)
    if not profile.is_absolute():
        return {"ok": False, "error": "PROFILE_LAUNCH_FAILED"}


    if os.environ.get("WORKBENCH_BROWSER_PROVIDER") != "multilogin":
        generation_browser_options()  # Reject invalid channel before starting a child.
    session = existing_session(args.desktop_root, profile, args.account_id)
    if session:
        return desktop_result(session, True)
    existing_pid = running_browser_pid(profile)
    if existing_pid:
        # An old shared desktop or a generation worker cannot be used as this login desktop.
        return {"ok": False, "error": "PROFILE_IN_USE"}
    profile.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="symphony-login-") as temporary:
        status = Path(temporary) / "status.json"
        child = subprocess.Popen([
            sys.executable, str(Path(__file__).resolve()), "--serve", "--status-file", str(status),
            "--profile", str(profile), "--login-type", args.login_type,
            "--account-id", args.account_id, "--desktop-root", args.desktop_root,
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True)
        limit = 4100 if os.environ.get("WORKBENCH_BROWSER_PROVIDER") == "multilogin" else 350
        for _ in range(limit):
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
                child.wait(timeout=6)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        return {"ok": False, "error": "PROFILE_LAUNCH_FAILED"}


def close_login(args):
    session = existing_session(args.desktop_root, args.profile, args.account_id)
    if not session:
        return {"ok": True, "alreadyClosed": True}
    # Only the validated login supervisor may be stopped, never a generation worker.
    os.kill(session["manager"]["pid"], signal.SIGTERM)
    for _ in range(200):
        if process_identity(session["manager"]["pid"]) != session["manager"]:
            return {"ok": True}
        time.sleep(0.1)
    return {"ok": False, "error": "PROFILE_CLOSE_TIMEOUT"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--login-type", choices=tuple(URLS), required=True)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--close", action="store_true")
    parser.add_argument("--status-file")
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--desktop-root", default=os.environ.get("WORKBENCH_DESKTOP_ROOT",
        str(Path(__file__).resolve().parents[1] / "symphony-pool-workbench/data/login-desktops")))
    args = parser.parse_args()
    if args.serve or args.browser:
        if not args.status_file:
            parser.error("--serve requires --status-file")
        if args.browser:
            serve_browser(args)
        else:
            LoginDesktop(args.desktop_root, args.profile, args.account_id).run([
                sys.executable, str(Path(__file__).resolve()), "--browser",
                "--profile", args.profile, "--login-type", args.login_type,
                "--account-id", args.account_id,
            ], args.status_file)
        return 0
    try:
        result = close_login(args) if args.close else launch(args)
    except Exception as error:
        result = {"ok": False, "error": status_code(error)}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
