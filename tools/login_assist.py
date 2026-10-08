"""Complete an explicitly requested phone login through the visible platform UI."""
import re
from urllib.parse import urlparse


def visible(locator):
    return [locator.nth(i) for i in range(min(locator.count(), 50)) if locator.nth(i).is_visible()]


def unique(locator):
    found = visible(locator)
    return found[0] if len(found) == 1 else None


def code_field(page):
    field = unique(page.locator('input[autocomplete="one-time-code"], input[name="code"], '
                                'input[placeholder*="验证码"], input[placeholder*="code"]'))
    if field:
        return field
    # Doubao's current SMS dialog uses an unlabelled decimal input and submits on input.
    dialog = unique(page.get_by_role('dialog').filter(has_text='请输入验证码'))
    if dialog:
        return unique(dialog.locator('input[inputmode="decimal"], input[inputmode="numeric"]'))
    return None


def wait_for_ui(page, ready, timeout_ms=8000):
    for _ in range(timeout_ms // 200):
        if ready():
            return True
        page.wait_for_timeout(200)
    return bool(ready())


def sms_confirmed(page):
    return bool(visible(page.get_by_text(re.compile(
        r'验证码已发送(?:至|到)?|重新发送\s*\d+\s*[sS秒]|\d+\s*秒后.*(?:重发|重新|获取)'))))


def challenge(page):
    return bool(visible(page.locator('#captcha_container, .captcha_verify_container, '
        'iframe[src*="captcha"], [data-testid="captcha"]')) or visible(page.get_by_text(
        re.compile('拖动滑块|完成安全验证|请完成下方验证|请完成拼图|Verify you are human', re.I))))


def authenticated(page):
    return bool(visible(page.locator('[data-testid="chat_input"]')) and
        not visible(page.locator('[data-testid="to_login_button"]')) and
        not visible(page.get_by_role('button', name='登录', exact=True)) and not code_field(page))


def state(page):
    if challenge(page):
        return {'ok': False, 'smsState': 'challenge', 'reason': 'LOGIN_CHALLENGE_REQUIRED'}
    if authenticated(page):
        return {'ok': True, 'authenticated': True}
    if visible(page.get_by_text(re.compile('验证码.{0,6}(错误|无效|过期)|验证码不正确'))):
        return {'ok': False, 'smsState': 'awaiting_code', 'reason': 'LOGIN_CODE_NOT_ACCEPTED'}
    if code_field(page) and sms_confirmed(page):
        return {'ok': True, 'smsState': 'awaiting_code', 'reason': 'SMS_CODE_REQUIRED'}
    return {'ok': False, 'smsState': 'manual', 'reason': 'SMS_SEND_UNCONFIRMED'}


def assist_page(page, data):
    if urlparse(page.url).hostname not in ('www.doubao.com', 'doubao.com'):
        return {'ok': False, 'reason': 'LOGIN_ASSIST_REQUIRES_MANUAL'}
    if challenge(page):
        return state(page)
    if authenticated(page):
        return {'ok': True, 'authenticated': True}
    action = data.get('action') or ('submit_code' if data.get('code') else 'send_sms')
    if action == 'status':
        return state(page)
    if action == 'submit_code':
        code = str(data.get('code', '')).strip()
        if not re.fullmatch(r'[0-9A-Za-z-]{4,10}', code):
            return {'ok': False, 'reason': 'INVALID_VERIFICATION_CODE'}
        field = code_field(page)
        if not field:
            return {'ok': False, 'reason': 'LOGIN_CODE_FIELD_MISSING'}
        form = field.locator('xpath=ancestor::form[1]')
        dialog = field.locator('xpath=ancestor::*[@role="dialog"][1]')
        scope = form if form.count() else dialog if dialog.count() else page
        submit = unique(scope.get_by_role('button', name=re.compile(
            r'^(登录|登录\/注册|登录或注册|确认登录|验证并登录|下一步|确认)$')))
        field.fill(code)
        page.wait_for_timeout(300)
        result = state(page)
        if result.get('authenticated'):
            return {**result, 'submitted': True}
        if result.get('smsState') == 'challenge':
            return result
        if submit and not submit.is_enabled():
            return {'ok': False, 'reason': 'LOGIN_CONFIRM_REQUIRED'}
        if submit:
            submit.click()
        for _ in range(12):
            page.wait_for_timeout(500)
            result = state(page)
            if result.get('authenticated'):
                return {**result, 'submitted': True}
            if result.get('smsState') == 'challenge' or result.get('reason') == 'LOGIN_CODE_NOT_ACCEPTED':
                return result
        return {'ok': True, 'submitted': True, 'reason': 'LOGIN_CODE_SUBMITTED'}
    if action != 'send_sms':
        return {'ok': False, 'reason': 'LOGIN_ASSIST_REQUIRES_MANUAL'}
    # Browser startup is reported before its first navigation completes.
    # Wait for an actionable login view without clicking or sending again.
    if not wait_for_ui(page, lambda: challenge(page) or authenticated(page) or code_field(page) or
                       unique(page.get_by_placeholder(re.compile('手机号|手机号码'))) or
                       unique(page.get_by_role('button', name='手机号登录', exact=True)) or
                       unique(page.get_by_role('button', name='登录', exact=True))):
        return {'ok': False, 'smsState': 'manual', 'reason': 'LOGIN_PAGE_NOT_READY'}
    # Open only the phone login flow; challenge widgets are never operated here.
    phone = unique(page.get_by_placeholder(re.compile('手机号|手机号码')))
    if not phone:
        method = unique(page.get_by_role('button', name='手机号登录', exact=True))
        if not method:
            login = unique(page.locator('[data-testid="to_login_button"]')) or unique(
                page.get_by_role('button', name='登录', exact=True))
            if login:
                login.click()
                wait_for_ui(page, lambda: unique(page.get_by_role('button', name='手机号登录', exact=True)) or
                            unique(page.get_by_placeholder(re.compile('手机号|手机号码'))), 5000)
            method = unique(page.get_by_role('button', name='手机号登录', exact=True))
        if method:
            method.click()
            wait_for_ui(page, lambda: unique(page.get_by_placeholder(re.compile('手机号|手机号码'))) or challenge(page), 5000)
        phone = unique(page.get_by_placeholder(re.compile('手机号|手机号码')))
    if challenge(page):
        return state(page)
    if phone:
        identifier = re.sub(r'[\s()-]', '', (data.get('credential') or {}).get('identifier', ''))
        identifier = re.sub(r'^\+?86(?=1[3-9]\d{9}$)', '', identifier)
        if not re.fullmatch(r'1[3-9]\d{9}', identifier):
            return {'ok': False, 'reason': 'PHONE_COUNTRY_SELECTION_REQUIRED'}
        phone.fill(identifier)
    elif not code_field(page):
        return {'ok': False, 'reason': 'LOGIN_ASSIST_REQUIRES_MANUAL'}
    checks = visible(page.get_by_role('checkbox'))
    if len(checks) == 1:
        check = checks[0]
        if check.get_attribute('aria-checked') == 'false':
            check.click()
        elif check.evaluate('(e)=>e.tagName === "INPUT" && !e.checked'):
            check.check()
    button = unique(page.get_by_role('button', name=re.compile(
        r'^(获取验证码|发送验证码|重新发送|重新获取|重新发送验证码|下一步)$')))
    if not button or not wait_for_ui(page, button.is_enabled, 2000):
        return state(page)
    # Exactly one send/next click per server-side cooldown reservation.
    button.click()
    for _ in range(12):
        page.wait_for_timeout(500)
        result = state(page)
        if result.get('smsState') in ('challenge', 'awaiting_code') or result.get('authenticated'):
            return result
    return state(page)
