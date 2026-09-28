import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


CREDIT_URL = "https://ads.tiktok.com/creative/creativestudio/settings/credit"
CREATE_URL = "https://ads.tiktok.com/creative/creativestudio/image-to-video"
KNOWN_MODELS = (
    "Dreamina Seedance 2.0",
    "Dreamina Seedance 2.0 Mini",
    "Dreamina Seedance 2.0 Fast",
    "Video 1.5 Pro",
)


def compact_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def read_body(page) -> str:
    page.wait_for_load_state("domcontentloaded", timeout=60_000)
    page.wait_for_timeout(3_000)
    return compact_text(page.locator("body").inner_text(timeout=30_000))


def parse_credit_summary(body_text: str) -> dict:
    remaining = None
    total = None
    credit_match = re.search(
        r"本周剩余\s*Symphony\s*积分.*?([\d,]+)\s*/\s*([\d,]+)",
        body_text,
        re.IGNORECASE,
    )
    if not credit_match:
        credit_match = re.search(
            r"Symphony\s+credits?\s+remaining\s+this\s+week.*?([\d,]+)\s*/\s*([\d,]+)",
            body_text,
            re.IGNORECASE,
        )
    if credit_match:
        remaining = int(credit_match.group(1).replace(",", ""))
        total = int(credit_match.group(2).replace(",", ""))

    reset_at = None
    reset_match = re.search(r"下次刷新日期[：:]\s*([^。]+)", body_text)
    if reset_match:
        raw_reset_at = reset_match.group(1).strip()
        date_parts = re.findall(r"\d{1,2}", raw_reset_at)
        reset_at = (
            f"{int(date_parts[0]):02d}-{int(date_parts[1]):02d}"
            if len(date_parts) >= 2
            else raw_reset_at
        )

    return {
        "remainingCredits": remaining,
        "totalCredits": total,
        "nextRefresh": reset_at,
    }


def safe_error_detail(error: Exception, profile_path: Path) -> str:
    detail = compact_text(str(error)).replace(str(profile_path), "<PROFILE>")
    detail = re.sub(r"https?://[^\s]+", "<URL>", detail)
    return detail[:500]


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Symphony persistent-profile verifier")
    parser.add_argument("--profile", required=True, help="Persistent Chrome user-data directory")
    parser.add_argument("--headed", action="store_true", help="Run a visible browser for sites that reject headless navigation")
    args = parser.parse_args()

    profile_path = Path(args.profile).resolve()
    if not profile_path.is_dir():
        print(json.dumps({"ok": False, "error": "PROFILE_NOT_FOUND"}, ensure_ascii=False))
        return 2

    summary = {
        "ok": False,
        "profile": profile_path.name,
        "loggedIn": False,
        "creditPageReady": False,
        "createPageReady": False,
        "remainingCredits": None,
        "totalCredits": None,
        "nextRefresh": None,
        "modelsObserved": [],
        "referenceImageLimit": None,
        "stage": "initializing",
    }

    with sync_playwright() as playwright:
        context = None
        last_launch_error = None
        for channel in ("chrome", "msedge", None):
            try:
                launch_options = {
                    "user_data_dir": str(profile_path),
                    "headless": not args.headed,
                    "accept_downloads": False,
                    "args": ["--profile-directory=Default"],
                }
                if channel:
                    launch_options["channel"] = channel
                context = playwright.chromium.launch_persistent_context(**launch_options)
                summary["browserChannel"] = channel or "chromium"
                summary["browserMode"] = "headed" if args.headed else "headless"
                break
            except Exception as error:  # Keep output sanitized; never print profile contents.
                last_launch_error = type(error).__name__
        if context is None:
            summary["error"] = f"BROWSER_LAUNCH_FAILED:{last_launch_error or 'UNKNOWN'}"
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
            return 3

        try:
            page = context.pages[0] if context.pages else context.new_page()
            summary["stage"] = "opening_credit_page"
            page.goto(CREDIT_URL, wait_until="domcontentloaded", timeout=60_000)
            summary["stage"] = "reading_credit_page"
            credit_text = read_body(page)
            credit_ready = (
                "本周剩余 Symphony 积分" in credit_text
                or "symphony credits remaining this week" in credit_text.lower()
            )
            login_redirect = any(marker in page.url.lower() for marker in ("/login", "signin", "sign-in"))
            summary["creditPageReady"] = credit_ready
            summary["loggedIn"] = credit_ready and not login_redirect
            summary.update(parse_credit_summary(credit_text))

            if summary["loggedIn"]:
                summary["stage"] = "opening_create_page"
                page.goto(CREATE_URL, wait_until="domcontentloaded", timeout=60_000)
                summary["stage"] = "reading_create_page"
                create_text = read_body(page)
                summary["createPageReady"] = any(
                    marker in create_text
                    for marker in ("上传最多 4 张图片", "Upload up to 4 images")
                )
                summary["referenceImageLimit"] = 4 if summary["createPageReady"] else None
                summary["modelsObserved"] = [model for model in KNOWN_MODELS if model in create_text]

            summary["ok"] = bool(
                summary["loggedIn"]
                and summary["creditPageReady"]
                and summary["createPageReady"]
            )
            summary["stage"] = "completed"
        except PlaywrightTimeoutError:
            summary["error"] = "PAGE_TIMEOUT"
        except Exception as error:
            summary["error"] = f"READ_ONLY_CHECK_FAILED:{type(error).__name__}"
            summary["errorDetail"] = safe_error_detail(error, profile_path)
        finally:
            context.close()

    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
