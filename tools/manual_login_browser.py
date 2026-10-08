"""Run the interactive login browser directly, with no automation connection."""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

from desktop_routes import stop_file, write_session
from browser_runtime import verify_egress


def manual_login_enabled(root, login_type):
    if os.environ.get("WORKBENCH_MANUAL_LOGIN") == "0":
        return False
    return login_type == "doubao" and (os.environ.get("WORKBENCH_MANUAL_LOGIN") == "1" or
        (Path(root) / ".manual-login-enabled").is_file())


def browser_command(profile, url, environ=None):
    env = os.environ if environ is None else environ
    # This manual mode is deliberately explicit. Configured proxy/credential workflows
    # must use their existing launcher; never silently fall back to a direct connection.
    if env.get("WORKBENCH_BROWSER_CHANNEL", "chrome") not in ("", "chrome") or any(env.get(key) for key in (
            "WORKBENCH_BROWSER_PROXY", "WORKBENCH_LOGIN_CREDENTIAL")):
        raise RuntimeError("MANUAL_LOGIN_CONFIGURATION_UNSUPPORTED")
    executable = shutil.which("google-chrome") or shutil.which("google-chrome-stable")
    if not executable:
        raise RuntimeError("CHROME_NOT_INSTALLED")
    # The shell wrapper changes argv[0] to google-chrome; use the installed binary
    # so the existing profile-lock identity check still recognizes this process.
    binary = Path(executable).resolve().with_name("chrome")
    if binary.is_file():
        executable = str(binary)
    if not Path(profile).is_absolute():
        raise RuntimeError("PROFILE_PATH_REQUIRED")
    return [executable, f"--user-data-dir={profile}", "--profile-directory=Default",
            "--no-first-run", "--no-default-browser-check", "--password-store=basic",
            "--disable-dev-shm-usage", "--no-sandbox", "--window-size=1280,800", "--new-window", url]


def serve_manual_browser(args, url, browser_pid):
    """Keep the existing desktop supervisor's readiness and graceful-stop protocol."""
    ready, stopping, child = False, False, None
    previous = {}

    def stop(*_):
        nonlocal stopping
        stopping = True

    try:
        command = browser_command(args.profile, url)
        verify_egress(None)
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, stop)
        child = subprocess.Popen(command, start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while child.poll() is None and not stopping:
            pid = browser_pid(Path(args.profile))
            if pid:
                # Xpra keeps windows unmapped until a client attaches. Waiting for
                # visibility would prevent publishing the very connection it needs.
                windows = subprocess.run(["xdotool", "search", "--pid", str(pid)],
                    capture_output=True, timeout=2)
                if windows.returncode == 0:
                    write_session(args.status_file, {"ok": True, "browserPid": pid, "manualBrowser": True})
                    ready = True
                    break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        if not ready:
            write_session(args.status_file, {"ok": False, "error": "PROFILE_LAUNCH_FAILED"})
            return
        while child.poll() is None and not stopping and not stop_file(args.desktop_root, args.profile).exists():
            time.sleep(0.2)
    except Exception:
        if not ready:
            write_session(args.status_file, {"ok": False, "error": "PROFILE_LAUNCH_FAILED"})
    finally:
        if child:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=2)
                except ProcessLookupError:
                    pass
        for sig, handler in previous.items():
            signal.signal(sig, handler)
