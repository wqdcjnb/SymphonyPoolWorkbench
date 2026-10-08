"""Recover an existing Doubao conversation; never resend its original prompt.

Inspection is read-only. An explicitly authorized confirmation mode can send
only the control text '确认生成' after matching the original prompt and fields.
"""
import json
import re
import sys
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
from doubao_challenge import check_human_verification
from doubao_parameters import confirmation_matches, response_state, prompt_matches, prepare_video_confirmation, is_confirmation_message
from doubao_duration import install_duration_submission, confirm_duration_submission
from task_pages import find_page, remember_page, assert_conversation, read_state
from task_messages import bind_message, scoped_rows, supported


def task_url(value):
    parsed = urlparse(value or '')
    if parsed.scheme != 'https' or parsed.hostname != 'www.doubao.com' or not re.fullmatch(r'/chat/[0-9]+', parsed.path):
        raise RuntimeError('INVALID_REMOTE_URL')
    return 'https://www.doubao.com' + parsed.path


def confirmation_message(text, job):
    return is_confirmation_message(text,job)


def classify(job, users, assistants, has_video):
    matches = sum(prompt_matches(job['prompt'], text) for text in users)
    if not matches:
        return None
    if matches != 1:
        raise RuntimeError('DOUBAO_TASK_AMBIGUOUS')
    text = next((value.strip() for value in reversed(assistants) if value.strip()), '')
    state = response_state(assistants)
    if state == 'subscription':
        return 'failed'
    if re.search(r'(?:免费次数|免费额度|生成次数|剩余额度).{0,12}(?:用完|不足|用尽)', text):
        raise RuntimeError('DOUBAO_FREE_QUOTA_EXHAUSTED')
    if re.search(r'视频.{0,12}(?:生成失败|无法生成)', text):
        return 'failed'
    if has_video or state == 'done':
        return 'ready'
    if state == 'confirm':
        if confirmation_message(users[-1], job):
            raise RuntimeError('DOUBAO_CONFIRMATION_UNCONFIRMED')
        if not confirmation_matches(text, job):
            raise RuntimeError('PLATFORM_PARAMETERS_MISMATCH')
        return 'confirmation'
    if state == 'auto':
        return 'generating'
    # A matching prompt with a blank/streaming/unknown response is evidence of
    # submission, never evidence that it is safe to send the prompt again.
    return 'pending'


def recent_urls(identifiers):
    # The sidebar mixes pinned and recent chats. Its first eight are not
    # necessarily the latest; inspect all observed IDs within a bounded window.
    identifiers = {value for value in identifiers if isinstance(value, str) and value.isdigit()}
    return ['https://www.doubao.com/chat/' + value
            for value in sorted(identifiers, key=int, reverse=True)[:25]]


def conversation_state(page, job):
    check_human_verification(page)
    if page.get_by_role('button', name='登录', exact=True).is_visible():
        raise RuntimeError('LOGIN_REQUIRED')
    if supported(job):
        return classify_rows(job,scoped_rows(page,job,'doubao'))
    rows = page.locator('[data-testid="message_content"]').evaluate_all('''els => els.map(e => {
        const parent = e.closest('[data-message-role]');
        return {role:parent?.getAttribute('data-message-role'),text:e.innerText,
            hasVideo:Boolean(parent?.querySelector('video[src]'))};
    })''')
    return classify_rows(job, rows)


def classify_rows(job, rows):
    matches = [index for index, row in enumerate(rows)
               if row['role'] == 'user' and prompt_matches(job['prompt'], row['text'])]
    if not matches:
        return None
    if len(matches) != 1:
        raise RuntimeError('DOUBAO_TASK_AMBIGUOUS')
    relevant = rows[matches[0]:]
    if any(row['role'] == 'user' and not confirmation_message(row['text'], job) for row in relevant[1:]):
        raise RuntimeError('DOUBAO_TASK_AMBIGUOUS')
    return classify(job,
        [row['text'] for row in relevant if row['role'] == 'user'],
        [row['text'] for row in relevant if row['role'] == 'assistant'],
        any(row.get('hasVideo') for row in relevant if row['role'] == 'assistant'))


def inspect(context, job, excluded_urls=()):
    expected = task_url(job['remoteUrl']) if job.get('remoteUrl') else None
    bound = find_page(context, job, 'doubao')
    found = {}
    for page in [bound] if bound is not None else context.pages:
        if urlparse(page.url).hostname != 'www.doubao.com':
            continue
        check_human_verification(page)
        if page.get_by_role('button', name='登录', exact=True).is_visible():
            raise RuntimeError('LOGIN_REQUIRED')
        try:
            remote = task_url(page.url)
        except RuntimeError:
            if urlparse(page.url).path.startswith('/chat/local_') and conversation_state(page, job):
                raise RuntimeError('DOUBAO_SUBMISSION_UNCONFIRMED')
            continue
        own_reuse=read_state(job,'doubao').get('reused') and read_state(job,'doubao').get('remoteUrl')==remote
        if (remote in excluded_urls and not own_reuse) or (expected and remote != expected):
            continue
        page.locator('[data-testid="message_content"]').first.wait_for(timeout=8000)
        phase = conversation_state(page, job)
        if phase:
            found[remote] = (page, phase)
    if not found:
        return {'ok': False, 'error': 'DOUBAO_EXISTING_TASK_NOT_FOUND', 'historyChecked': False}
    if len(found) != 1:
        raise RuntimeError('DOUBAO_TASK_AMBIGUOUS')
    remote, (page, phase) = next(iter(found.items()))
    if not bind_message(context,page,job,'doubao'):
        raise RuntimeError('DOUBAO_SUBMISSION_UNCONFIRMED')
    remember_page(context, page, job, 'doubao', remote)
    return {'ok': True, 'remoteUrl': remote, 'remoteMessageId':job.get('remoteMessageId'), 'platformState': phase, 'sameConversation': True}


def confirm_existing(context, job):
    remote = task_url(job.get('remoteUrl'))
    page = find_page(context, job, 'doubao')
    page.locator('[data-testid="message_content"]').first.wait_for(timeout=10000)
    state = conversation_state(page, job)
    assert_conversation(page, job, 'doubao')
    if state in ('ready', 'generating', 'failed'):
        return {'ok': True, 'remoteUrl': remote, 'platformState': state}
    if state != 'confirmation':
        raise RuntimeError('DOUBAO_CONFIRMATION_UNCONFIRMED')
    # The database claims this continuation before this process runs. A timeout
    # cannot trigger another confirmation, and a new prompt is never sent here.
    prepare_video_confirmation(page, job)
    install_duration_submission(page, job, confirmation_only=True)
    page.locator('[data-testid="chat_input"] [contenteditable="true"]').first.fill('确认生成')
    send = page.locator('[data-testid="chat_input_send_button"]')
    if not send.is_enabled():
        raise RuntimeError('SUBMIT_NOT_READY')
    assert_conversation(page, job, 'doubao')
    send.click()
    confirm_duration_submission(page)
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        assert_conversation(page, job, 'doubao')
        try:
            state = conversation_state(page, job)
        except RuntimeError as error:
            if str(error) != 'DOUBAO_CONFIRMATION_UNCONFIRMED':
                raise
            state = None
        if state in ('ready', 'generating', 'failed'):
            return {'ok': True, 'remoteUrl': remote, 'platformState': state}
        page.wait_for_timeout(500)
    raise RuntimeError('DOUBAO_CONFIRMATION_UNCONFIRMED')


def main():
    try:
        data = json.load(sys.stdin)
        endpoint = urlparse(data['endpoint'])
        if (endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1'
                or endpoint.username or endpoint.password or endpoint.path not in ('', '/')
                or endpoint.query or endpoint.fragment or not 1024 <= (endpoint.port or 0) <= 65535):
            raise RuntimeError('BROWSER_ENDPOINT_NOT_READY')
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(data['endpoint'], timeout=10000)
            result = (confirm_existing(browser.contexts[0], data['job']) if data.get('confirmPending')
                      else inspect(browser.contexts[0], data['job'], data.get('excludedUrls', [])))
    except Exception as error:
        code = str(error)
        result = {'ok': False, 'error': code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}', code) else 'DOUBAO_TASK_CHECK_FAILED'}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
