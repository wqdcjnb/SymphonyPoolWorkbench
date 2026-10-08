"""Opt-in, bounded authentication diagnostics; never persist request/response data."""

from collections import OrderedDict
from datetime import datetime, timezone
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import parse_qs, urlsplit

from desktop_routes import profile_key


AUTH_COOKIES = frozenset(("sessionid", "sessionid_ss", "sid_tt", "sid_guard", "sid_ucp_v1", "session_tlb_tag"))
COOKIE_REASONS = frozenset(("SecureOnly", "NotOnPath", "DomainMismatch", "SameSiteStrict", "SameSiteLax",
    "SameSiteUnspecifiedTreatedAsLax", "SameSiteNoneInsecure", "UserPreferences", "UnknownError",
    "SchemefulSameSiteStrict", "SchemefulSameSiteLax", "SchemefulSameSiteUnspecifiedTreatedAsLax",
    "SamePartyFromCrossPartyContext", "ThirdPartyPhaseout", "ThirdPartyBlockedInFirstPartySet"))
KNOWN_PATHS = frozenset(("/chat", "/chat/", "/auth/callback", "/flow-account/web-auth/callback",
    "/samantha/chat/completion", "/samantha/user/info", "/samantha/user/profile",
    "/passport/web/logout/", "/passport/web/user/info/", "/passport/web/account/info/"))
CODE_KEYS = ("code", "error_code", "status_code", "Code", "StatusCode")
CODE_CONTAINERS = ("data", "error", "base_resp", "BaseResp")
SYMBOLIC_CODES = frozenset(("unauthorized", "forbidden", "not_login", "login_required",
    "session_expired", "invalid_session", "token_expired", "invalid_token", "rate_limit_exceeded"))
BODY_LIMIT = 65536
LOG_LIMIT = 1024 * 1024


def endpoint(url):
    """Use fixed route names; dynamic paths and query values must not enter a log."""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("http", "https") or not (host == "doubao.com" or host.endswith(".doubao.com")):
            return None
        path = parsed.path
        if path in KNOWN_PATHS:
            route = path
        else:
            route = next((prefix + "<redacted>" for prefix in
                          ("/passport/", "/samantha/", "/flow-account/", "/auth/", "/chat/")
                          if path.startswith(prefix)), "/<other>")
        return {"route": route, "route_hash": hashlib.sha256(path.encode()).hexdigest()[:12],
                "from_logout": "from_logout" in parse_qs(parsed.query, keep_blank_values=True)}
    except (TypeError, ValueError):
        return None


def error_codes(payload):
    """Allow only bounded error codes, never arbitrary strings or nested user content."""
    if not isinstance(payload, dict):
        return {}
    found = {}
    for prefix, obj in [("", payload), *((name + ".", payload.get(name)) for name in CODE_CONTAINERS)]:
        if not isinstance(obj, dict):
            continue
        for key in CODE_KEYS:
            value = obj.get(key)
            if isinstance(value, str) and re.fullmatch(r"-?\d{1,9}", value):
                value = int(value)
            if type(value) is int and abs(value) <= 999999999:
                found[prefix + key] = value
            elif isinstance(value, str) and value.lower() in SYMBOLIC_CODES:
                found[prefix + key] = value.lower()
    return found


def cookie_summary(cookies):
    sent, blocked = set(), []
    for entry in cookies:
        name = entry.get("cookie", {}).get("name")
        if name not in AUTH_COOKIES:
            continue
        reasons = entry.get("blockedReasons", [])
        if reasons:
            blocked.append({"name": name, "reasons": sorted(set(
                reason if reason in COOKIE_REASONS else "Other" for reason in reasons))})
        else:
            sent.add(name)
    return {"sent_auth_cookies": sorted(sent), "blocked_auth_cookies": blocked}


class LoginDiagnostics:
    def __init__(self, root, profile):
        self.path = Path(root) / f"{profile_key(profile)}.auth.jsonl"
        self.session = secrets.token_hex(6)
        self.sequence = 0

    def record(self, event, **fields):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.path.exists() and self.path.stat().st_size >= LOG_LIMIT:
                self.path.replace(self.path.with_suffix(".jsonl.1"))
            line = json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                               "session": self.session, "event": event, **fields}, ensure_ascii=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as stream:
                stream.write(line + "\n")
        except OSError:
            pass  # Diagnostics cannot interrupt login when storage is unavailable.

    def guarded(self, stage, callback):
        def handler(*args):
            try:
                callback(*args)
            except Exception:
                # Exception messages can contain URLs, headers and page text.
                self.record("diagnostic_error", stage=stage)
        return handler

    def attach(self, context):
        self.record("browser_opened")
        context.on("close", lambda *_: self.record("browser_closed"))
        context.on("page", self.guarded("page", lambda page: self.attach_page(context, page)))
        for page in context.pages:
            self.attach_page(context, page)
        cookies = context.cookies("https://www.doubao.com/")
        selected = [cookie for cookie in cookies if cookie.get("name") in AUTH_COOKIES]
        expiry = [int(cookie["expires"] - time.time()) for cookie in selected if cookie.get("expires", -1) > 0]
        self.record("stored_auth_cookies", names=sorted({cookie["name"] for cookie in selected}),
                    nearest_expiry_seconds=min(expiry) if expiry else None)

    def attach_page(self, context, page):
        cdp = context.new_cdp_session(page)
        pending, early_cookies = OrderedDict(), OrderedDict()

        def trim(mapping):
            while len(mapping) > 256:
                mapping.popitem(last=False)

        def navigation(frame):
            route = endpoint(frame.url)
            if frame == page.main_frame and route:
                self.record("navigation", **route)

        def request(event):
            request_id = event["requestId"]
            route = endpoint(event["request"]["url"])
            pending.pop(request_id, None)
            if route is None or event.get("type") not in ("Document", "Fetch", "XHR", "EventSource"):
                early_cookies.pop(request_id, None)
                return
            self.sequence += 1
            method = event["request"].get("method")
            item = {"request": self.sequence, **route,
                    "method": method if method in ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD") else "other"}
            pending[request_id] = {"item": item}
            self.record("request", **item)
            if request_id in early_cookies:
                self.record("request_cookies", **item, **early_cookies.pop(request_id))
            trim(pending)

        def extra(event):
            request_id = event["requestId"]
            summary = cookie_summary(event.get("associatedCookies", []))
            if request_id in pending:
                self.record("request_cookies", **pending[request_id]["item"], **summary)
            else:
                early_cookies[request_id] = summary
                trim(early_cookies)

        def response(event):
            entry = pending.get(event["requestId"])
            if not entry:
                return
            res = event["response"]
            mime = res.get("mimeType", "").split(";", 1)[0].lower()
            entry["body_type"] = "json" if mime == "application/json" or mime.endswith("+json") else (
                "sse" if mime == "text/event-stream" else "other")
            # The platform checks these two boolean flags before redirecting to logout.
            # Never record other headers (especially Set-Cookie or authorization data).
            login_flags = {name.lower(): value if value in ("0", "1") else "other"
                           for name, value in res.get("headers", {}).items()
                           if name.lower() in ("x-tt-flow-login", "x-tt-agw-login")}
            self.record("response", **entry["item"], status=res["status"], body_type=entry["body_type"],
                        login_flags=login_flags)

        def finished(event):
            entry = pending.pop(event["requestId"], None)
            early_cookies.pop(event["requestId"], None)
            if not entry:
                return
            self.record("request_finished", **entry["item"])
            # Only read completed, small responses. Never wait for a live stream to finish.
            if entry.get("body_type") not in ("json", "sse") or event.get("encodedDataLength", 0) > BODY_LIMIT:
                return
            try:
                data = cdp.send("Network.getResponseBody", {"requestId": event["requestId"]})
            except Exception:
                # A navigation, cache hit or bounded CDP buffer can discard a finished body.
                self.record("response_body_unavailable", **entry["item"])
                return
            body = data.get("body", "")
            if len(body) > BODY_LIMIT:
                return
            if data.get("base64Encoded"):
                body = base64.b64decode(body).decode("utf-8")
            lines = [body] if entry["body_type"] == "json" else [
                line[5:].strip() for line in body.splitlines() if line.startswith("data:")][:128]
            distinct = set()
            for line in lines:
                try:
                    codes = error_codes(json.loads(line))
                except (ValueError, TypeError):
                    continue
                signature = json.dumps(codes, sort_keys=True)
                if codes and signature not in distinct:
                    distinct.add(signature)
                    self.record("business_codes", **entry["item"], codes=codes)

        def failed(event):
            entry = pending.pop(event["requestId"], None)
            early_cookies.pop(event["requestId"], None)
            if entry:
                text = event.get("errorText", "")
                error = text if re.fullmatch(r"net::ERR_[A-Z_]{1,64}", text) else "NETWORK_ERROR"
                self.record("request_failed", **entry["item"], error=error, cancelled=bool(event.get("canceled")))

        page.on("framenavigated", self.guarded("navigation", navigation))
        page.on("close", lambda *_: self.record("page_closed"))
        page.on("crash", lambda *_: self.record("page_crashed"))
        for name, handler in (("requestWillBeSent", request), ("requestWillBeSentExtraInfo", extra),
                              ("responseReceived", response), ("loadingFinished", finished), ("loadingFailed", failed)):
            cdp.on("Network." + name, self.guarded(name, handler))
        cdp.send("Network.enable", {"maxTotalBufferSize": 1048576, "maxResourceBufferSize": BODY_LIMIT,
                                    "maxPostDataSize": 0})


def attach_login_diagnostics(context, root, profile, login_type):
    if login_type != "doubao" or not (os.environ.get("WORKBENCH_LOGIN_DIAGNOSTICS") == "1" or
                                      (Path(root) / ".diagnostics-enabled").is_file()):
        return
    diagnostic = LoginDiagnostics(root, profile)
    diagnostic.guarded("attach", lambda: diagnostic.attach(context))()
