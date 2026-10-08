"""Enforce one user message containing the reference files and complete prompt."""
import json
import time
from pathlib import Path

from slider_captcha import solve_dola_captcha


def install_joint_submission(page, job, prompt):
    images = len(job.get('referenceAssets') or [])
    videos = 1 if job.get('mode') == 'reference_to_video' else 0
    if not images and not videos:
        return
    config = {'service': job['service'], 'prompt': prompt, 'images': images, 'videos': videos}
    if job.get('doubaoEntry') == 'chat':
        from doubao_parameters import chat_confirmation_text
        config['confirmationText'] = chat_confirmation_text(job)
    source = Path(__file__).with_suffix('.js').read_text(encoding='utf-8')
    # Install after the platform app/security SDK has initialized. The original
    # fetch/XHR implementation must sign the already combined body; changing a
    # body below that layer would invalidate the platform's normal signature.
    page.evaluate('(' + source + ')(' + json.dumps(config, ensure_ascii=False) + ')')


def confirm_joint_submission(page, job, timeout=45):
    if not job.get('referenceAssets') and job.get('mode') != 'reference_to_video':
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = page.evaluate('() => window.__symphonyJointSubmission || null')
        if state and state.get('error'):
            raise RuntimeError(state['error'])
        if state and state.get('accepted') and state.get('messages') == 1 and state.get('textPresent'):
            return state
        if job['service'] == 'dola' and page.locator('#captcha_container:visible').count():
            if solve_dola_captcha(page):
                continue
            raise RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')
        page.wait_for_timeout(250)
    raise RuntimeError('MULTIMODAL_SUBMISSION_UNCONFIRMED')
