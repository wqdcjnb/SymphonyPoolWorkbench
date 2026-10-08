"""Privacy checks and an opt-in offline Chrome network diagnostic fixture."""

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

from login_diagnostics import LoginDiagnostics, attach_login_diagnostics, cookie_summary, endpoint, error_codes


class DiagnosticPrivacyTests(unittest.TestCase):
    def test_dynamic_urls_and_unrelated_sites_are_not_logged(self):
        item = endpoint("https://www.doubao.com/chat/private-conversation?token=private-token&from_logout=1")
        self.assertEqual(item["route"], "/chat/<redacted>")
        self.assertTrue(item["from_logout"])
        self.assertNotIn("private", json.dumps(item))
        for url in ("https://www.doubao.com.evil.test/chat/", "file:///private", "https://other.test/"):
            self.assertIsNone(endpoint(url))

    def test_codes_do_not_include_message_user_ids_or_arbitrary_strings(self):
        self.assertEqual(error_codes({"code": 401, "message": "private text", "sessionid": "secret",
            "data": {"error_code": "10001", "user_id": "private"},
            "error": {"code": "private-token"}, "status_code": 13800138000}),
            {"code": 401, "data.error_code": 10001})
        self.assertEqual(error_codes({"code": "SESSION_EXPIRED"}), {"code": "session_expired"})
        self.assertEqual(error_codes({"code": True, "data": [{"code": "private"}]}), {})

    def test_cookie_values_and_unknown_reasons_are_not_logged(self):
        result = cookie_summary([
            {"cookie": {"name": "sessionid", "value": "private-cookie"}, "blockedReasons": []},
            {"cookie": {"name": "sid_tt", "value": "private-cookie"}, "blockedReasons": ["SameSiteLax", "private"]},
            {"cookie": {"name": "private-name", "value": "private-cookie"}, "blockedReasons": []}])
        self.assertEqual(result["sent_auth_cookies"], ["sessionid"])
        self.assertEqual(result["blocked_auth_cookies"], [{"name": "sid_tt", "reasons": ["Other", "SameSiteLax"]}])
        self.assertNotIn("private", json.dumps(result))

    def test_disabled_observer_does_not_touch_browser_and_errors_are_sanitized(self):
        with TemporaryDirectory() as temporary, patch.dict(os.environ, {"WORKBENCH_LOGIN_DIAGNOSTICS": "0"}):
            attach_login_diagnostics(object(), temporary, "/test-profile", "doubao")
            diagnostic = LoginDiagnostics(temporary, "/test-profile")
            def fail():
                raise ValueError("private-token in exception")
            diagnostic.guarded("test", fail)()
            self.assertNotIn("private", diagnostic.path.read_text())
            with patch("login_diagnostics.LOG_LIMIT", 1):
                diagnostic.record("next")
            self.assertTrue(diagnostic.path.with_suffix(".jsonl.1").exists())
            with patch("login_diagnostics.os.open", side_effect=OSError("private")):
                diagnostic.record("storage_unavailable")


@unittest.skipUnless(os.environ.get("WORKBENCH_TEST_LOGIN_DIAGNOSTICS") == "1", "offline Chrome fixture is opt-in")
class DiagnosticBrowserTests(unittest.TestCase):
    def test_http_errors_cookies_streams_and_navigation_without_private_data(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from playwright.sync_api import sync_playwright

        release = threading.Event()
        streaming = threading.Event()
        private = "PRIVATE_DIAGNOSTIC_FIXTURE_CONTENT"

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path.startswith("/samantha/chat/completion"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(('data: {"code":0,"message":"' + private + '"}\n\n').encode())
                    self.wfile.flush()
                    streaming.set()
                    release.wait(8)
                    self.wfile.write(b'data: {"error_code":10001}\n\n')
                    return
                if self.path.startswith("/samantha/user/info"):
                    body = json.dumps({"code": 401, "message": private}).encode()
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("X-Tt-Flow-Login", "0")
                    self.send_header("X-Tt-Agw-Login", private)
                    self.send_header("Set-Cookie", "fixture=" + private + "; Path=/")
                else:
                    body = b'<html><body><input id="message"></body></html>'
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://www.doubao.com:{server.server_address[1]}"
        try:
            with TemporaryDirectory() as temporary, sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True,
                    args=["--no-proxy-server", "--host-resolver-rules=MAP www.doubao.com 127.0.0.1"])
                context = browser.new_context()
                context.add_cookies([{"name": "sessionid", "value": private, "domain": "www.doubao.com",
                                     "path": "/", "secure": False, "httpOnly": True, "sameSite": "Lax"}])
                (Path(temporary) / ".diagnostics-enabled").touch()
                attach_login_diagnostics(context, temporary, "/offline-fixture", "doubao")
                page = context.new_page()
                page.goto(base + "/chat/?token=" + private)
                page.evaluate("fetch('/samantha/user/info').then(r => r.json()).then(() => true)")
                page.evaluate("() => { window.diagnosticStream = fetch('/samantha/chat/completion').then(r => r.text()); }")
                page.wait_for_timeout(150)
                self.assertTrue(streaming.is_set())
                # An unfinished stream must not freeze the observer or the browser input.
                page.locator("#message").fill("still responsive")
                self.assertEqual(page.locator("#message").input_value(), "still responsive")
                release.set()
                page.evaluate("window.diagnosticStream.then(() => true)")
                page.wait_for_timeout(200)
                page.goto(base + "/chat/" + private + "?from_logout=1&token=" + private)
                context.close()
                browser.close()
                text = next(Path(temporary).glob("*.auth.jsonl")).read_text()
                records = [json.loads(line) for line in text.splitlines()]
                self.assertNotIn(private, text)
                self.assertNotIn("still responsive", text)
                self.assertTrue(any(r["event"] == "response" and r["status"] == 401 for r in records))
                self.assertTrue(any(r["event"] == "response" and r.get("login_flags") ==
                    {"x-tt-flow-login": "0", "x-tt-agw-login": "other"} for r in records))
                self.assertTrue(any(r["event"] == "business_codes" and r["codes"].get("code") == 401 for r in records))
                self.assertTrue(any(r["event"] == "business_codes" and r["codes"].get("error_code") == 10001 for r in records))
                self.assertTrue(any(r["event"] == "request_cookies" and "sessionid" in r["sent_auth_cookies"] for r in records))
                self.assertTrue(any(r["event"] == "navigation" and r["from_logout"] for r in records))
                self.assertFalse(any(r["event"] == "diagnostic_error" for r in records))
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
