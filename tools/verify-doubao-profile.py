"""Read-only login check for an isolated Doubao browser profile."""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


DOUBAO_URL = "https://www.doubao.com/chat/"
CREATE_URL = "https://www.doubao.com/chat/create-image"
HISTORY_URL = f"{CREATE_URL}?tab=myCreation"
DOUBAO_HOSTS = {"doubao.com", "www.doubao.com"}
VIDEO_MODELS = (
    "Seedance 2.5",
    "Seedance 2.0",
    "Seedance 2.0 Fast",
    "Seedance 2.0 Mini",
)
BEIJING_TIME = timezone(timedelta(hours=8))


def beijing_day() -> tuple[str, str]:
    now = datetime.now(BEIJING_TIME)
    tomorrow = (now + timedelta(days=1)).date()
    return now.date().isoformat(), datetime.combine(
        tomorrow, datetime.min.time(), BEIJING_TIME
    ).isoformat()


def is_visible(page, selector: str) -> bool:
    item = page.locator(selector).first
    return item.count() > 0 and item.is_visible()


def read_free_models(page) -> list[str]:
    """Return only models without an upgrade badge in the video selector."""
    model_label = page.get_by_text("模型", exact=True).first
    if model_label.count() == 0:
        return []
    model_label.locator("..").click(timeout=10_000)
    page.wait_for_timeout(300)
    available = []
    for model in VIDEO_MODELS:
        matches = page.get_by_text(model, exact=True)
        if matches.count() == 0:
            continue
        # The last match is in the menu; the selected value may also appear in
        # the composer. A locked menu row contains an "升级" badge.
        row_text = matches.last.locator("..").inner_text(timeout=3_000)
        if "升级" not in row_text:
            available.append(model)
    page.keyboard.press("Escape")
    return available


def read_reference_image_limit(page) -> int | None:
    """Read the displayed limit instead of borrowing another model's limit."""
    editor = page.locator('[contenteditable="true"]').first
    if editor.count() == 0:
        return None
    composer = editor.locator(
        "xpath=ancestor::*[contains(@class, 'guidance-input-content')][1]"
    )
    if composer.count() == 0:
        return None
    text = composer.inner_text(timeout=5_000)
    match = re.search(r"(?:最多|上限|至多)(?:可上传|上传|添加)?\s*(\d+)\s*张(?:参考)?图片", text)
    if not match:
        match = re.search(r"(?:up to|maximum of)\s*(\d+)\s*(?:reference\s*)?images", text, re.I)
    return int(match.group(1)) if match else None


def count_today_videos(page, today: str) -> int | None:
    """Count video cards in today's group of the user's creations."""
    date_label = today.replace("-", "/")
    groups = page.locator('[class*="combine-file-wrapper-"]')
    if groups.count() == 0:
        empty_text = page.locator("body").inner_text(timeout=5_000)
        return 0 if any(marker in empty_text for marker in ("暂无创作", "还没有创作")) else None

    first_date = groups.first.locator('[class*="combine-file-time-"]').inner_text(timeout=3_000).strip()
    if first_date != date_label:
        return 0 if re.fullmatch(r"\d{4}/\d{2}/\d{2}", first_date) and first_date < date_label else None

    # The list may load more cards while scrolling. Stop only when another day
    # appears or the list remains stable at its bottom.
    previous_count = -1
    stable_rounds = 0
    for _ in range(12):
        cards = groups.first.locator('[class*="combine-file-list-wrapper-"] > *')
        current_count = cards.count()
        if groups.count() > 1:
            break
        scroll = page.locator('[class*="list-container-"]').first
        if scroll.count() == 0:
            return None
        scroll.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(350)
        stable_rounds = stable_rounds + 1 if current_count == previous_count else 0
        previous_count = current_count
        if stable_rounds >= 2 and scroll.evaluate(
            "el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2"
        ):
            break
    else:
        return None

    cards = groups.first.locator('[class*="combine-file-list-wrapper-"] > *')
    return sum(
        1 for index in range(cards.count())
        if cards.nth(index).locator('[class*="playBadge-"]').count() > 0
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Doubao profile login check")
    parser.add_argument("--profile", required=True, help="Isolated browser user-data directory")
    parser.add_argument("--headed", action="store_true", help="Use a visible browser")
    args = parser.parse_args()

    profile_path = Path(args.profile).resolve()
    if not profile_path.is_dir():
        print(json.dumps({"ok": False, "error": "PROFILE_NOT_FOUND"}, ensure_ascii=False))
        return 2

    today, next_reset = beijing_day()
    summary = {
        "ok": False,
        "loggedIn": False,
        "creditPageReady": False,
        "createPageReady": False,
        "remainingCredits": None,
        "totalCredits": None,
        "nextRefresh": next_reset,
        "videosCreatedToday": None,
        "videoCountDate": today,
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
            summary["loggedIn"] = page_ready and not login_prompt
            if not page_ready:
                summary["error"] = "DOUBAO_PAGE_NOT_READY"
            elif login_prompt:
                summary["error"] = "LOGIN_REQUIRED"

            if summary["loggedIn"]:
                summary["stage"] = "opening_create_page"
                page.goto(CREATE_URL, wait_until="domcontentloaded", timeout=60_000)
                page.get_by_text("视频", exact=True).first.click(timeout=15_000)
                page.get_by_text("模型", exact=True).first.wait_for(
                    state="visible", timeout=15_000
                )
                summary["createPageReady"] = (
                    urlparse(page.url).hostname in DOUBAO_HOSTS
                    and is_visible(page, '[contenteditable="true"]')
                )
                if summary["createPageReady"]:
                    summary["modelsObserved"] = read_free_models(page)
                    summary["referenceImageLimit"] = read_reference_image_limit(page)

                summary["stage"] = "opening_creation_history"
                page.goto(HISTORY_URL, wait_until="domcontentloaded", timeout=60_000)
                page.get_by_text("我的创作", exact=True).first.wait_for(
                    state="visible", timeout=15_000
                )
                page.get_by_text("全部创作", exact=True).first.wait_for(
                    state="visible", timeout=15_000
                )
                summary["creditPageReady"] = "tab=myCreation" in page.url
                if summary["creditPageReady"]:
                    page.wait_for_timeout(700)
                    summary["videosCreatedToday"] = count_today_videos(page, today)

            summary["ok"] = bool(
                summary["loggedIn"]
                and summary["createPageReady"]
                and summary["creditPageReady"]
                and summary["modelsObserved"]
                and summary["videosCreatedToday"] is not None
            )
            summary["stage"] = "completed"
            if summary["loggedIn"] and not summary["ok"]:
                if not summary["createPageReady"]:
                    summary["error"] = "DOUBAO_VIDEO_PAGE_NOT_READY"
                elif not summary["modelsObserved"]:
                    summary["error"] = "DOUBAO_FREE_MODEL_NOT_FOUND"
                elif not summary["creditPageReady"]:
                    summary["error"] = "DOUBAO_HISTORY_PAGE_NOT_READY"
                else:
                    summary["error"] = "DOUBAO_HISTORY_INCOMPLETE"
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
