"""Account Xpra registry and routing, including protection against PID reuse."""

import hashlib
import json
import os
from pathlib import Path
import re


TOKEN = re.compile(r"[a-f0-9]{64}\Z")


def profile_key(profile):
    return hashlib.sha256(os.fsencode(str(profile))).hexdigest()


def process_identity(pid, proc_root=Path("/proc")):
    """A PID alone is unsafe after process exit or container restart."""
    try:
        fields = (proc_root / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] in ("Z", "X"):
            return None
        return {"pid": int(pid), "start": fields[19]}
    except (OSError, ValueError, IndexError):
        return None


def process_args(identity, proc_root):
    if not isinstance(identity, dict) or process_identity(identity.get("pid"), proc_root) != identity:
        return []
    try:
        return [os.fsdecode(arg) for arg in (proc_root / str(identity["pid"]) / "cmdline").read_bytes().split(b"\0") if arg]
    except OSError:
        return []


def has_option(args, name, value):
    return any(args[i:i + 2] == [name, str(value)] for i in range(len(args) - 1))


def valid_session(session, proc_root=Path("/proc")):
    try:
        if session["version"] != 2 or not TOKEN.fullmatch(session["token"]):
            return False
        if not isinstance(session["port"], int) or not 1024 <= session["port"] <= 65535:
            return False
        if not re.fullmatch(r":[1-9][0-9]{2,3}", session["display"]):
            return False
        manager = process_args(session["manager"], proc_root)
        browser = process_args(session["browser"], proc_root)
        xpra = process_args(session["xpra"], proc_root)
        display = process_args(session["xvfb"], proc_root)
        return bool(manager and browser and xpra and display
            and "--serve" in manager
            and has_option(manager, "--profile", session["profile"])
            and has_option(manager, "--account-id", session["accountId"])
            and Path(browser[0]).name in ("chrome", "chromium")
            and f"--user-data-dir={session['profile']}" in browser
            and any(Path(arg).name == "xpra" for arg in xpra[:2])
            and session["display"] in xpra
            and f"--bind-ws=127.0.0.1:{session['port']}" in xpra
            and Path(display[0]).name == "Xvfb" and session["display"] in display)
    except (KeyError, TypeError, ValueError):
        return False


def read_session(path):
    try:
        result = json.loads(Path(path).read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def write_session(path, session):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(session), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def existing_session(root, profile, account_id):
    session = read_session(Path(root) / f"{profile_key(profile)}.json")
    if (session.get("profile") == str(profile) and session.get("accountId") == account_id
            and valid_session(session)):
        return session
    return None


class DesktopRoutes:
    """Never route an invalid or expired token to a shared/default desktop."""

    def __init__(self, source):
        self.root = Path(source)

    def lookup(self, token):
        if not isinstance(token, str) or not TOKEN.fullmatch(token):
            return None
        session = read_session(self.root / "routes" / f"{token}.json")
        viewer = session.get("viewerId")
        if viewer is not None:
            if not isinstance(viewer, str) or not TOKEN.fullmatch(viewer):
                return None
            selected = read_session(self.root / "viewers" / f"{viewer}.json")
            if selected.get("token") != token or selected.get("accountId") != session.get("accountId"):
                return None
        if (self.root / f"{profile_key(session.get('profile', ''))}.automation").exists():
            return None
        if session.get("token") == token and valid_session(session):
            return ("127.0.0.1", session["port"])
        return None


def stop_file(root, profile):
    return Path(root) / f"{profile_key(profile)}.stop"
