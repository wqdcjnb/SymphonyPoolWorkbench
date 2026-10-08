"""Read-only verification of Dola login and the supported video controls."""
import argparse
import json
import re
from playwright.sync_api import sync_playwright
from browser_runtime import persistent_context
from dola_video import DOLA_LONG_MODEL, DOLA_IMAGE_LIMIT, open_composer, select_model
from slider_captcha import captcha_visible, solve_dola_captcha


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True)
    parser.add_argument('--headed', action='store_true')
    args = parser.parse_args()
    result = {"ok": False, "loggedIn": False, "modelsObserved": [], "stage": "dola_login",
              "error": "DOLA_LOGIN_UNCONFIRMED"}
    try:
        with sync_playwright() as playwright:
            context = persistent_context(playwright, args.profile, headless=not args.headed)
            try:
                page = context.new_page()
                try:
                    try:
                        composer = open_composer(page)
                    except Exception:
                        # A slider challenge can gate the chat page during
                        # verification. Solve it and retry once before giving up.
                        if captcha_visible(page) and solve_dola_captcha(page):
                            composer = open_composer(page)
                        else:
                            raise
                    result.update(loggedIn=True, stage='dola_capability')
                    select_model(page, composer, DOLA_LONG_MODEL)
                    upload = composer.locator('[data-testid="upload-file-input"]')
                    if not upload.count() or not any(extension in (upload.get_attribute('accept') or '') for extension in ('.png', 'image/')):
                        raise RuntimeError('DOLA_UPLOAD_UNAVAILABLE')
                    result.update(ok=True, createPageReady=True, modelsObserved=[DOLA_LONG_MODEL],
                                  referenceImageLimit=DOLA_IMAGE_LIMIT, stage='completed', error=None,
                                  remainingCredits=None, totalCredits=10)
                except Exception:
                    result['loggedIn'] = page.locator('[data-testid="chat_header_avatar_button"]:visible').count() > 0
                    raise
            finally:
                context.close()
    except Exception as error:
        code = str(error)
        result['error'] = code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}', code) else 'DOLA_PAGE_TIMEOUT'
    print(json.dumps(result))


if __name__ == '__main__':
    main()
