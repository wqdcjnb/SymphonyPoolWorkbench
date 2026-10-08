"""Check only the configured egress. Never retry without its proxy."""
import json
import sys
import ipaddress
from playwright.sync_api import sync_playwright


def check(request):
    with sync_playwright() as playwright:
        context = playwright.request.new_context(proxy=request.get("proxy"), timeout=20000)
        try:
            response = context.get("https://api.ipify.org?format=json")
            if response.status != 200:
                raise RuntimeError("EGRESS_CHECK_FAILED")
            address = str(ipaddress.ip_address(response.json()["ip"]))
            return {"ok": True, "ip": address}
        finally:
            context.dispose()


if __name__ == "__main__":
    try:
        print(json.dumps(check(json.load(sys.stdin))))
    except Exception:
        print(json.dumps({"ok": False, "error": "EGRESS_CHECK_FAILED"}))
        sys.exit(1)
