"""Supervise one isolated X11 desktop per account, preserving its browser profile."""

import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time

from desktop_routes import existing_session, process_identity, profile_key, stop_file, valid_session, write_session


def desktop_result(session, already_open=False):
    return {"ok": True, "alreadyOpen": already_open,
            "desktop": {"protocol": "xpra", "accountId": session["accountId"], "token": session["token"]}}


class LoginDesktop:
    def __init__(self, root, profile, account_id):
        self.root, self.profile, self.account_id = Path(root), str(profile), account_id
        self.children = []
        self.stopping = False
        self.route = None
        self.index = self.root / f"{profile_key(profile)}.json"
        self.browser = None
        self.logs = []

    def stop(self, *_):
        self.stopping = True

    def spawn(self, args, env, log=None):
        output = subprocess.DEVNULL
        if log:
            output = (self.root / f"{profile_key(self.profile)}.{log}.log").open("w", encoding="utf-8")
            self.logs.append(output)
        child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
            stdout=output, stderr=output, start_new_session=True)
        self.children.append(child)
        return child

    def healthy(self):
        return not self.stopping and all(child.poll() is None for child in self.children)

    def cleanup(self):
        # Withdraw the connection before releasing any port/display for another account.
        if self.route:
            self.route.unlink(missing_ok=True)
            self.index.unlink(missing_ok=True)
        if self.browser and self.browser.poll() is None:
            # Let Playwright close normally so the profile is flushed before releasing it.
            stop_file(self.root, self.profile).touch(mode=0o600)
            try:
                self.browser.wait(timeout=12)
            except subprocess.TimeoutExpired:
                pass
        for child in reversed(self.children):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                except ProcessLookupError:
                    pass
        stop_file(self.root, self.profile).unlink(missing_ok=True)
        for log in self.logs:
            log.close()

    def run(self, browser_command, status_file):
        # Imported lazily so Windows can import the launcher for regression tests.
        import fcntl

        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / "routes").mkdir(exist_ok=True, mode=0o700)
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        with (self.root / f"{profile_key(self.profile)}.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                session = existing_session(self.root, self.profile, self.account_id)
                write_session(status_file, desktop_result(session, True) if session else
                    {"ok": False, "error": "PROFILE_IN_USE"})
                return
            with tempfile.TemporaryDirectory(prefix="desktop-", dir=self.root) as temporary:
                try:
                    self._run(browser_command, Path(temporary), status_file, fcntl)
                except Exception:
                    if not Path(status_file).exists():
                        write_session(status_file, {"ok": False, "error": "PROFILE_DESKTOP_FAILED"})
                finally:
                    self.cleanup()

    def _run(self, browser_command, temporary, status_file, fcntl):
        env = os.environ.copy()
        env["XDG_RUNTIME_DIR"] = str(temporary)
        stop_file(self.root, self.profile).unlink(missing_ok=True)
        authority = temporary / "Xauthority"
        authority.touch(mode=0o600)
        env["XAUTHORITY"] = str(authority)
        with (self.root / "allocate.lock").open("a") as allocation:
            fcntl.flock(allocation, fcntl.LOCK_EX)
            number = next(n for n in range(100, 1000) if not Path(f"/tmp/.X{n}-lock").exists()
                          and not Path(f"/tmp/.X11-unix/X{n}").exists())
            env["DISPLAY"] = display = f":{number}"
            subprocess.run(["xauth", "-f", str(authority), "add", display, ".", secrets.token_hex(16)],
                check=True, timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            xvfb = self.spawn(["Xvfb", display, "-screen", "0", "4096x2160x24", "-nolisten", "tcp",
                               "-noreset", "-auth", str(authority)], env)
            for _ in range(80):
                if not self.healthy():
                    raise RuntimeError("Display exited")
                if subprocess.run(["xdpyinfo"], env=env, timeout=1,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Display startup timed out")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        xpra = self.spawn(["/usr/bin/xpra", "start", display, "--use-display=yes", "--daemon=no",
            f"--bind-ws=127.0.0.1:{port}", "--ws-auth=none", "--html=off",
            f"--socket-dir={temporary}", f"--socket-dirs={temporary}",
            f"--session-name={self.account_id}", "--clipboard=yes", "--sharing=no",
            "--exit-with-client=no", "--idle-timeout=0", "--server-idle-timeout=0",
            "--pulseaudio=no", "--speaker=off", "--microphone=off", "--webcam=no",
            "--printing=no", "--file-transfer=no", "--open-files=no", "--open-url=no",
            "--start-new-commands=no", "--mdns=no", "--dbus=no", "--dbus-launch=no"], env, "xpra")
        for _ in range(150):
            if not self.healthy():
                raise RuntimeError("Desktop exited")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("Xpra startup timed out")
        browser_status = temporary / "browser.json"
        self.browser = self.spawn([*browser_command, "--desktop-root", str(self.root),
                                   "--status-file", str(browser_status)], env, "browser")
        for _ in range(230):
            if not self.healthy():
                raise RuntimeError("Browser exited")
            if browser_status.exists():
                result = json.loads(browser_status.read_text(encoding="utf-8"))
                if not result.get("ok"):
                    write_session(status_file, result)
                    return
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Browser startup timed out")
        session = {"version": 2, "token": secrets.token_hex(32), "accountId": self.account_id,
            "profile": self.profile, "display": display, "port": port,
            "manager": process_identity(os.getpid()), "browser": process_identity(result["browserPid"]),
            "xpra": process_identity(xpra.pid), "xvfb": process_identity(xvfb.pid)}
        if not valid_session(session):
            raise RuntimeError("Desktop identity could not be verified")
        self.route = self.root / "routes" / f"{session['token']}.json"
        write_session(self.route, session)
        write_session(self.index, session)
        write_session(status_file, desktop_result(session))
        while self.healthy():
            time.sleep(0.3)
