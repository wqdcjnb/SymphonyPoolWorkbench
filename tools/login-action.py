"""Assist a user-authorized login in the existing private browser session."""
import json
import re
import sys
from playwright.sync_api import sync_playwright
from login_assist import assist_page
from slider_captcha import solve_dola_captcha


def unique_visible(locator):
    matches = [locator.nth(i) for i in range(locator.count()) if locator.nth(i).is_visible()]
    return matches[0] if len(matches) == 1 else None


def act(data):
    if not re.fullmatch(r'http://127\.0\.0\.1:\d{4,5}', data.get('endpoint') or ''):
        return {'ok': False, 'smsState': 'manual', 'reason': 'LOGIN_BROWSER_UNAVAILABLE'}
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(data['endpoint'], timeout=10000)
        except Exception:
            return {'ok': False, 'smsState': 'manual', 'reason': 'LOGIN_BROWSER_UNAVAILABLE'}
        if data.get('platform') == 'doubao':
            for _ in range(40):
                all_pages = [page for context in browser.contexts for page in context.pages]
                pages = [page for page in all_pages if re.match(r'^https://(?:www\.)?doubao\.com(?:/|$)', page.url)]
                if pages or not all_pages:
                    break
                all_pages[0].wait_for_timeout(200)
            if len(pages) != 1:
                return {'ok': False, 'smsState': 'manual', 'reason': 'LOGIN_PAGE_NOT_READY'}
            return assist_page(pages[0], data)
        page = browser.contexts[0].pages[0]
        # Best-effort: a platform slider can gate the Dola login/chat page while
        # the session is attached. Solving it never replaces the user's own
        # Google or SMS steps.
        if data.get('platform') == 'dola':
            try:
                solve_dola_captcha(page)
            except Exception:
                pass
        if data.get('code'):
            code = str(data['code'])
            if not re.fullmatch(r'[0-9A-Za-z-]{4,10}', code):
                raise RuntimeError('INVALID_VERIFICATION_CODE')
            field = unique_visible(page.locator('input[autocomplete="one-time-code"], input[name="code"], input[placeholder*="验证码"], input[placeholder*="code"]'))
            if not field:
                return {'ok': False, 'reason': '请在 Xpra 窗口填写验证码'}
            field.fill(code)
            # Submission remains an explicit user action in the visible login window.
            return {'ok': True, 'reason': '验证码已填写，请在登录窗口确认提交'}
        credential = data.get('credential') or {}
        if not credential.get('identifier'):
            return {'ok': True, 'reason': '请检查登录状态或在 Xpra 完成验证'}
        page.wait_for_timeout(2000)
        field = unique_visible(page.locator('input[type="email"], input[type="tel"], input[name="email"], input[name="mobile"]'))
        if field:
            field.fill(credential['identifier'])
            password = unique_visible(page.locator('input[type="password"]'))
            if password and credential.get('password'):
                password.fill(credential['password'])
            return {'ok': True, 'reason': '账号信息已填写，请在 Xpra 完成短信或二次验证'}
        return {'ok': False, 'reason': '需在 Xpra 选择登录方式；凭据已安全保存'}


if __name__ == '__main__':
    try:
        print(json.dumps(act(json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'reason': 'LOGIN_ASSIST_REQUIRES_MANUAL'}))
