"""Run one Mimic profile inside its account's private Xpra display.

Only one local Multilogin agent is used at a time. This keeps its windows out of
other accounts' desktops and avoids reusing a launcher from an unknown display.
"""

import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import time

from browser_runtime import verify_egress
from desktop_routes import profile_key, stop_file, write_session


LAUNCHER_HOST = "launcher.mlx.yt"
LAUNCHER_PORT = 45001


class LocalHTTPSConnection(http.client.HTTPSConnection):
    """Use the vendor TLS name while connecting only to loopback."""

    def __init__(self, timeout):
        super().__init__(LAUNCHER_HOST, LAUNCHER_PORT, timeout=timeout,
                         context=ssl.create_default_context())

    def connect(self):
        raw = socket.create_connection(("127.0.0.1", LAUNCHER_PORT), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=LAUNCHER_HOST)


def request_json(route, token=None, timeout=15):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    connection = LocalHTTPSConnection(timeout)
    try:
        connection.request("GET", route, headers=headers)
        response = connection.getresponse()
        payload = response.read(65537)
        if response.status != 200 or len(payload) > 65536:
            raise RuntimeError("MULTILOGIN_API_FAILED")
        body = json.loads(payload)
        if not isinstance(body, dict):
            raise RuntimeError("MULTILOGIN_API_FAILED")
        return body
    except (http.client.HTTPException, OSError, ValueError, ssl.SSLError) as error:
        raise RuntimeError("MULTILOGIN_API_FAILED") from error
    finally:
        connection.close()


def token_from_file():
    name = os.environ.get("WORKBENCH_MULTILOGIN_TOKEN_FILE", "")
    if not name or not Path(name).is_absolute():
        raise RuntimeError("MULTILOGIN_NOT_CONFIGURED")
    try:
        file = Path(name)
        details = file.lstat()
        if (not stat.S_ISREG(details.st_mode)
                or (os.name == "posix" and (details.st_mode & 0o077 or details.st_uid != os.getuid()))):
            raise RuntimeError("MULTILOGIN_NOT_CONFIGURED")
        token = file.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError("MULTILOGIN_NOT_CONFIGURED") from error
    if not token or len(token) > 8192 or any(c.isspace() for c in token):
        raise RuntimeError("MULTILOGIN_NOT_CONFIGURED")
    return token


def agent_path():
    configured = os.environ.get("WORKBENCH_MULTILOGIN_AGENT", "mlx")
    executable = shutil.which(configured)
    if not executable:
        raise RuntimeError("MULTILOGIN_NOT_CONFIGURED")
    return executable


def launch_profile(folder_id, profile_id, token):
    from urllib.parse import quote
    route = (f"/api/v2/profile/f/{quote(folder_id, safe='')}/p/{quote(profile_id, safe='')}/start"
             "?automation_type=playwright&headless_mode=false")
    response = request_json(route, token, timeout=120)
    port = response.get("data", {}).get("port")
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise RuntimeError("MULTILOGIN_ENDPOINT_NOT_READY")
    return port


def stop_profile(profile_id, token):
    from urllib.parse import quote
    request_json(f"/api/v1/profile/stop/p/{quote(profile_id, safe='')}", token, timeout=20)


def serve(args, url):
    import fcntl
    folder_id = os.environ.get("WORKBENCH_MULTILOGIN_FOLDER_ID", "")
    profile_id = os.environ.get("WORKBENCH_MULTILOGIN_PROFILE_ID", "")
    if (not folder_id or not profile_id or not os.environ.get("WORKBENCH_EXPECTED_IP")
            or not os.environ.get("WORKBENCH_BROWSER_PROXY")):
        write_session(args.status_file, {"ok": False, "error": "MULTILOGIN_NOT_CONFIGURED"})
        return
    root = Path(args.desktop_root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "multilogin-agent.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            write_session(args.status_file, {"ok": False, "error": "MULTILOGIN_BUSY"})
            return
        agent = None
        token = None
        started = False
        ready = False
        try:
            token = token_from_file()
            executable = agent_path()
            # A launcher already running may be attached to a different X11 display.
            try:
                request_json("/api/v1/version", timeout=3)
            except RuntimeError:
                pass
            else:
                raise RuntimeError("MULTILOGIN_AGENT_IN_USE")
            allowed = {"HOME", "PATH", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
                       "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
                       "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_CTYPE", "GTK_IM_MODULE",
                       "QT_IM_MODULE", "XMODIFIERS"}
            agent_env = {key: value for key, value in os.environ.items() if key in allowed}
            agent = subprocess.Popen([executable], env=agent_env,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                if agent.poll() is not None:
                    raise RuntimeError("MULTILOGIN_AGENT_FAILED")
                try:
                    request_json("/api/v1/version", timeout=3)
                    break
                except RuntimeError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("MULTILOGIN_AGENT_FAILED")
            port = launch_profile(folder_id, profile_id, token)
            started = True
            from playwright.sync_api import sync_playwright
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=20000)
                if not browser.contexts:
                    raise RuntimeError("MULTILOGIN_ENDPOINT_NOT_READY")
                context = browser.contexts[0]
                verify_egress(context)
                credential = json.loads(os.environ.get("WORKBENCH_LOGIN_CREDENTIAL", "{}"))
                if credential.get("cookies"):
                    context.add_cookies(credential["cookies"])
                page = context.pages[0] if context.pages else context.new_page()
                write_session(args.status_file, {"ok": True, "browserPid": os.getpid(),
                    "browserProvider": "multilogin", "endpointPort": port})
                ready = True
                try:
                    page.goto(url, wait_until="commit", timeout=8000)
                except Exception:
                    pass
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
                next_check = time.monotonic() + 10
                while context.pages and not stop_file(args.desktop_root, args.profile).exists():
                    if agent.poll() is not None:
                        raise RuntimeError("MULTILOGIN_AGENT_FAILED")
                    context.pages[0].wait_for_timeout(500)
                    if time.monotonic() >= next_check:
                        verify_egress(context)
                        next_check = time.monotonic() + 10
        except Exception as error:
            if ready and str(error) in {"EGRESS_CHECK_FAILED", "EGRESS_IP_MISMATCH"}:
                write_session(root / f"{profile_key(args.profile)}.egress-failure",
                              {"code": str(error)})
            if not ready:
                code = str(error)
                if code not in {"MULTILOGIN_NOT_CONFIGURED", "MULTILOGIN_BUSY",
                                "MULTILOGIN_AGENT_IN_USE",
                                "MULTILOGIN_AGENT_FAILED", "MULTILOGIN_API_FAILED",
                                "MULTILOGIN_ENDPOINT_NOT_READY", "EGRESS_CHECK_FAILED",
                                "EGRESS_IP_MISMATCH"}:
                    code = "MULTILOGIN_PROFILE_FAILED"
                write_session(args.status_file, {"ok": False, "error": code})
        finally:
            if started:
                try:
                    stop_profile(profile_id, token)
                except Exception:
                    pass
            if agent and agent.poll() is None:
                try:
                    os.killpg(agent.pid, signal.SIGTERM)
                    agent.wait(timeout=10)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(agent.pid, signal.SIGKILL)
                    except OSError:
                        pass
