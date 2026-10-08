"""Submit explicit Doubao video duration without relying on the paid UI slider."""
import json
import time
from pathlib import Path

from video_compat import video_info
from doubao_parameters import video_prompt


def select_base_duration(page):
    # The free UI allows 10 seconds. The outgoing video ability is set to the
    # requested 15 seconds by the guard; we never claim the slider itself says 15.
    slider = page.get_by_role('slider').first
    if slider.get_attribute('aria-valuemin') != '0' or int(slider.get_attribute('aria-valuemax') or '0') < 6:
        raise RuntimeError('DURATION_SELECTION_FAILED')
    slider.focus()
    slider.press('Home')
    for _ in range(6):
        slider.press('ArrowRight')
    if slider.get_attribute('aria-valuenow') != '6':
        raise RuntimeError('DURATION_SELECTION_FAILED')


def install_duration_submission(page, job, confirmation_only=False):
    config = {'model': job['model'], 'duration': job['durationSeconds'], 'ratio': job['aspectRatio'],
              'confirmationOnly': confirmation_only, 'prompt': video_prompt(job)}
    source = Path(__file__).with_suffix('.js').read_text(encoding='utf8')
    page.evaluate('(' + source + ')(' + json.dumps(config, ensure_ascii=False) + ')')


def confirm_duration_submission(page, previous_count=0, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = page.evaluate('() => window.__symphonyDoubaoDuration || null')
        if state and state.get('error'):
            raise RuntimeError(state['error'])
        count = (state.get('patched', 0) + state.get('confirmations', 0)) if state else 0
        if state and state.get('duration') == 15 and count > previous_count:
            return count
        page.wait_for_timeout(100)
    raise RuntimeError('DOUBAO_DURATION_SUBMISSION_UNCONFIRMED')


def verify_result_duration(path, seconds):
    if abs(video_info(path)['duration'] - seconds) > 0.65:
        raise RuntimeError('VIDEO_DURATION_MISMATCH')
