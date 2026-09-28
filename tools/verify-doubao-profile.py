"""Read-only login check for an isolated Doubao browser profile."""

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


DOUBAO_URL = "https://www.doubao.com/chat/"
DOUBAO_HOSTS = {"doubao.com", "www.doubao.com"}


def is_visible(page, selector: str) -> bool:
    item = page.locator(selector).first
    return item.count() > 0 and item.is_visible()


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Doubao profile login check")
    parser.add_argument("--profile", required=True, help="Isolated browser user-data directory")
    parser.add_argument("--headed", action="store_true", help="Use a visible browser")
    args = parser.parse_args()

    profile_path = Path(args.profile).resolve()
    if not profile_path.is_dir():
        print(json.dumps({"ok": False, "error": "PROFILE_NOT_FOUND"}, ensure_ascii=False))
        return 2

    summary = {
        "ok": False,
        "loggedIn": False,
        "creditPageReady": False,
        "createPageReady": False,
        "remainingCredits": None,
        "totalCredits": None,
        "nextRefresh": None,
        "referenceImageLimit": None,
        "modelsObserved": [],
        "stage": "initializing",
    }

    with sync_playwright() as playwright:
        context = None
        for channel in ("chrome", "msedge", None):
            try:
                options = {
                    "user_data_dir": str(profile_path),
                    "headless": not args.headed,
                    "accept_downloads": False,
                    "args": ["--profile-directory=Default"],
                }
                if channel:
                    options["channel"] = channel
                context = playwright.chromium.launch_persistent_context(**options)
                break
            except Exception as error:
                detail = str(error).lower()
                if (
                    "processsingleton" in detail
                    or "user data directory is already in use" in detail
                    or ("exitcode=0" in detail and (profile_path / "lockfile").exists())
                ):
                    summary["error"] = "PROFILE_IN_USE"
                    break
        if context is None:
            summary.setdefault("error", "BROWSER_LAUNCH_FAILED")
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
            return 3

        try:
            page = context.pages[0] if context.pages else context.new_page()
            summary["stage"] = "opening_doubao_page"
            page.goto(DOUBAO_URL, wait_until="domcontentloaded", timeout=60_000)
            summary["stage"] = "checking_login"
            page.locator('[data-testid="chat_input"]').wait_for(state="visible", timeout=25_000)
            page.wait_for_timeout(2_000)

            page_ready = (
                urlparse(page.url).hostname in DOUBAO_HOSTS
                and "豆包" in page.title()
                and is_visible(page, '[data-testid="chat_input"]')
            )
            login_prompt = (
                is_visible(page, '[data-testid="to_login_button"]')
                or is_visible(page, '[data-testid="not_login_about_us"]')
                or page.get_by_role("button", name="登录", exact=True).count() > 0
            )
            summary["pageReady"] = page_ready
            summary["loggedIn"] = page_ready and not login_prompt
            summary["ok"] = summary["loggedIn"]
            summary["stage"] = "completed"
            if not page_ready:
                summary["error"] = "DOUBAO_PAGE_NOT_READY"
            elif login_prompt:
                summary["error"] = "LOGIN_REQUIRED"
        except PlaywrightTimeoutError:
            summary["error"] = "DOUBAO_PAGE_TIMEOUT"
        except Exception as error:
            summary["error"] = f"DOUBAO_CHECK_FAILED:{type(error).__name__}"
        finally:
            context.close()

    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
