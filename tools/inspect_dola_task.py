"""Read existing Dola conversations after a human challenge; never submit."""
import json
import re
import sys
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from dola_video import generation_phase, response_state, task_url
from dola_prompt import matches_prompt
from slider_captcha import solve_dola_captcha
from task_pages import find_page, remember_page, read_state
from task_messages import bind_message, read_rows, scoped_rows, supported


def classify(job, users, assistants, cards, state):
    if state == 'human':
        raise RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')
    if state == 'login':
        raise RuntimeError('LOGIN_REQUIRED')
    matches = sum(matches_prompt(job, text) for text in users)
    if not matches:
        return None
    if matches != 1:
        raise RuntimeError('DOLA_TASK_AMBIGUOUS')
    if state == 'quota':
        raise RuntimeError('DOLA_QUOTA_EXHAUSTED')
    if state == 'failed':
        return 'failed'
    if state == 'parameters':
        raise RuntimeError('PLATFORM_PARAMETERS_MISMATCH')
    return generation_phase(assistants, cards)


def inspect(context, job, excluded_urls=()):
    expected = task_url(job['remoteUrl']) if job.get('remoteUrl') else None
    bound = find_page(context, job, 'dola')
    found = {}
    for page in [bound] if bound is not None else context.pages:
        if urlparse(page.url).hostname != 'www.dola.com':
            continue
        state = response_state(page, job)
        if state == 'human':
            # Auto-solve the slider first; the human operator remains the fallback.
            if solve_dola_captcha(page):
                state = response_state(page, job)
            if state == 'human':
                page.bring_to_front()
                raise RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')
        if state == 'login':
            raise RuntimeError('LOGIN_REQUIRED')
        try:
            remote = task_url(page.url)
        except RuntimeError:
            if urlparse(page.url).path.startswith('/chat/local_'):
                # The CAPTCHA can be gone while a native continuation was
                # stopped by our transport guard. Report that actual failure,
                # not a missing history entry or another human challenge.
                guard = page.evaluate('() => window.__symphonyJointSubmission || null')
                if guard and guard.get('error') in ('MULTIMODAL_PROMPT_MISSING',
                        'MULTIMODAL_ATTACHMENTS_MISMATCH', 'MULTIMODAL_UNSUPPORTED_PAYLOAD'):
                    raise RuntimeError(guard['error'])
                if any(row['role'] == 'user' and matches_prompt(job, row['text']) for row in read_rows(page)):
                    raise RuntimeError('DOLA_SUBMISSION_UNCONFIRMED')
            continue
        own_reuse=read_state(job,'dola').get('reused') and read_state(job,'dola').get('remoteUrl')==remote
        if (remote in excluded_urls and not own_reuse) or (expected and remote != expected):
            continue
        page.locator('[data-message-role="user"] [data-testid="message_content"]').first.wait_for(timeout=8000)
        if supported(job):
            rows=scoped_rows(page,job,'dola')
            phase=classify(job,[r['text'] for r in rows if r['role']=='user'],
                [r['text'] for r in rows if r['role']=='assistant'],sum(r.get('cards',0) for r in rows if r['role']=='assistant'),state)
        else:
            users = page.locator('[data-message-role="user"] [data-testid="message_content"]').all_text_contents()
            phase = classify(job, users,
                page.locator('[data-message-role="assistant"] [data-testid="message_content"]').all_text_contents(),
                page.locator('[data-message-role="assistant"] [class*="block-video-"]').count(), state)
        if phase:
            found[remote] = (page, phase)
    if len(found) != 1:
        raise RuntimeError('DOLA_TASK_AMBIGUOUS' if found else 'DOLA_EXISTING_TASK_NOT_FOUND')
    remote, (page, phase) = next(iter(found.items()))
    if not bind_message(context,page,job,'dola'):
        raise RuntimeError('DOLA_SUBMISSION_UNCONFIRMED')
    remember_page(context, page, job, 'dola', remote)
    return {'ok': True, 'remoteUrl': remote, 'remoteMessageId':job.get('remoteMessageId'), 'platformState': phase, 'sameConversation': True}


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
            result = inspect(browser.contexts[0], data['job'], data.get('excludedUrls', []))
    except Exception as error:
        code = str(error)
        result = {'ok': False, 'error': code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}', code) else 'DOLA_TASK_CHECK_FAILED'}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
