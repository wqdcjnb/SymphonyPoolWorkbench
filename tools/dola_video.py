"""Dola website adapter; never emit session or signed media tokens."""
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from copy import deepcopy
from urllib.parse import urlparse
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from stream_media import download_video
from watermark_repair import repair_video
from joint_submission import install_joint_submission, confirm_joint_submission
from slider_captcha import solve_dola_captcha
from dola_prompt import build_prompt, matches_prompt
from video_ratios import VIDEO_FIXED_RATIOS
from task_pages import job_page, remember_page, begin_submission, assert_conversation, finish_page, can_restart_context, restart_context, read_state
from task_messages import bind_message, assistant_texts, scoped_locator, scoped_rows, stable_id, supported, check_context_limit

DOLA_CHAT = 'https://www.dola.com/chat/'
DOLA_MODEL = 'Dreamina Seedance 2.0 Fast'
DOLA_LONG_MODEL = 'Dreamina Seedance 2.5'
DOLA_DURATIONS = (5, 10)
DOLA_LONG_DURATIONS = (30,)
DOLA_RATIOS = VIDEO_FIXED_RATIOS
DOLA_IMAGE_LIMIT = 9


def _patch_duration(value, seconds):
    if isinstance(value, list):
        changed = False
        for item in value:
            changed = _patch_duration(item, seconds) or changed
        return changed
    if not isinstance(value, dict):
        return False
    changed = False
    label = ' '.join(str(value.get(key, '')) for key in ('label', 'name', 'title', 'show_name', 'value')).lower()
    if 'duration' in label or '时长' in label:
        for key in ('option_list', 'options'):
            options = value.get(key)
            if not isinstance(options, list):
                continue
            if any(isinstance(item, dict) and str(item.get('option_key', item.get('value'))) == str(seconds)
                   for item in options):
                continue
            ten = next(((index, item) for index, item in enumerate(options) if isinstance(item, dict)
                        and str(item.get('option_key', item.get('value'))) == '10'), None)
            if ten:
                index, template = ten
                item = deepcopy(template)
                for field, replacement in (('option_key', str(seconds)), ('value', str(seconds)),
                                           ('display_text', f'{seconds}s'), ('show_name', f'{seconds}s')):
                    if field in item:
                        item[field] = replacement
                if 'is_default' in item:
                    item['is_default'] = False
                if isinstance(item.get('id'), int):
                    item['id'] = max((option.get('id', 0) for option in options
                                      if isinstance(option, dict) and isinstance(option.get('id'), int)), default=0) + 1
                options.insert(index + 1, item)
                changed = True
    durations = value.get('supported_durations')
    if isinstance(durations, list) and str(seconds) not in [str(item) for item in durations]:
        durations.append(str(seconds))
        changed = True
    for key, child in list(value.items()):
        if isinstance(child, str) and child.strip().startswith(('{', '[')):
            try:
                parsed = json.loads(child)
            except ValueError:
                continue
            if _patch_duration(parsed, seconds):
                value[key] = json.dumps(parsed, ensure_ascii=False)
                changed = True
        elif _patch_duration(child, seconds):
            changed = True
    return changed


def enable_extended_duration(page, seconds):
    def patch_response(route):
        if urlparse(route.request.url).hostname != 'www.dola.com':
            route.continue_()
            return
        response = route.fetch()
        try:
            data = response.json()
            if _patch_duration(data, seconds):
                route.fulfill(response=response, body=json.dumps(data, ensure_ascii=False))
            else:
                route.fulfill(response=response)
        except (ValueError, TypeError, KeyError):
            route.fulfill(response=response)
    page.route('**/samantha/skill/pack*', patch_response)
    page.route('**/alice/slot/action_bar_v3/get_item_conf*', patch_response)


def generation_timeout(job):
    if job and job.get('collectExistingUrl') and job.get('collectionCheckSeconds'):
        return max(10, min(600, int(job['collectionCheckSeconds'])))
    # Bound each observation, then let the scheduler revisit the same conversation.
    # This budget is never a generation deadline.
    return 90


def task_url(value):
    parsed = urlparse(value)
    if (parsed.scheme != 'https' or parsed.hostname != 'www.dola.com'
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or not re.fullmatch(r'/chat/[0-9]+', parsed.path)):
        raise RuntimeError('INVALID_REMOTE_URL')
    return 'https://www.dola.com' + parsed.path


def logged_out(page):
    return page.locator('[data-testid="to_login_button"]:visible').count() > 0


def upload_chat_references(page, attachments):
    """Use the same + file chooser and attachment area as a manual upload."""
    composer = page.locator('[data-testid="chat_input"]')
    # The account avatar appears before the input controls finish hydrating.
    page.wait_for_function('''() => [...document.querySelectorAll(
        '[data-testid="chat_input"] [data-testid="upload_file_button"], '
        + '[data-testid="chat_input"] [data-testid="skill_input_exit_button"]')]
        .some(node => node.getClientRects().length > 0)''', timeout=15000)
    plus = composer.locator('[data-testid="upload_file_button"]')
    if not plus.is_visible():
        composer.locator('[data-testid="skill_input_exit_button"]').last.click(timeout=10000)
        plus.wait_for(timeout=10000)
    if composer.locator('[data-testid="attachment-image-card"]').count():
        raise RuntimeError('DOLA_UNEXPECTED_COMPOSER_ATTACHMENTS')
    try:
        with page.expect_file_chooser(timeout=10000) as chooser:
            plus.click(timeout=10000)
        chooser.value.set_files(attachments)
        wait_for_reference_upload(page, len(attachments))
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOLA_UPLOAD_FAILED') from error


def wait_for_reference_upload(page, expected):
    try:
        page.wait_for_function('''expected => {
            const area = document.querySelector('[data-testid="chat_input"] [data-testid="attachment_area"]');
            return area && area.querySelectorAll('[data-testid="attachment-image-card"]').length === expected
                && !area.querySelector('[role="progressbar"], [aria-busy="true"]');
        }''', arg=expected, timeout=120000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOLA_UPLOAD_FAILED') from error


def open_composer(page, reuse=False, reference_assets=()):
    if not reuse:
        page.goto(DOLA_CHAT, wait_until='domcontentloaded', timeout=60000)
    try:
        page.locator('[data-testid="chat_header_avatar_button"]').wait_for(timeout=30000)
    except PlaywrightTimeoutError as error:
        if '/security/region-restricted' in page.url:
            raise RuntimeError('DOLA_REGION_RESTRICTED') from error
        raise RuntimeError('LOGIN_REQUIRED' if logged_out(page) else 'DOLA_PAGE_TIMEOUT') from error
    if reference_assets:
        upload_chat_references(page, reference_assets)
    if not reuse or reference_assets:
        page.get_by_text('Create Videos', exact=True).first.click(timeout=30000)
    composer = page.locator('[data-testid="chat_input"]')
    try:
        composer.get_by_role('button', name=re.compile(r'^Model')).wait_for(timeout=30000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOLA_VIDEO_PAGE_NOT_READY') from error
    return composer


def select_model(page, composer, model_name=DOLA_MODEL):
    selector = composer.get_by_role('button', name=re.compile(r'^Model'))
    selector.click(timeout=10000)
    model = page.locator('[role="menu"]:visible, [role="dialog"]:visible, .semi-portal:visible').get_by_text(model_name, exact=True).last
    try:
        model.wait_for(timeout=10000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOLA_MODEL_NOT_AVAILABLE') from error
    model.click(timeout=10000)
    if ('2.5' if model_name == DOLA_LONG_MODEL else '2.0 Fast') not in selector.inner_text():
        raise RuntimeError('DOLA_MODEL_SELECTION_FAILED')


def configure(page, composer, job):
    if (job['model'] != DOLA_LONG_MODEL or job['durationSeconds'] != 30
            or job.get('aspectRatio') not in DOLA_RATIOS
            or job['mode'] != 'image_to_video'
            or len(job.get('referenceAssets') or []) > DOLA_IMAGE_LIMIT):
        raise RuntimeError('INVALID_JOB_PARAMETERS')
    select_model(page, composer, job['model'])
    duration = composer.locator('[data-testid="chat_input_action_video-duration"]')
    expected = f"{job['durationSeconds']}s"
    ratio = job['aspectRatio']
    if not duration.count():
        # Dola is serving both separate controls and a combined ratio/duration panel.
        parameters = composer.get_by_role('button', name=re.compile(r'(?:Auto|\d+:\d+)\s*·\s*\d+s', re.I))
        parameters.click(timeout=10000)
        slider = page.get_by_role('slider')
        if slider.count() != 1:
            raise RuntimeError('DURATION_SELECTION_FAILED')
        slider.focus()
        slider.press('End')
        page.get_by_text('Auto' if ratio == 'auto' else ratio, exact=True).last.click(timeout=10000)
        page.keyboard.press('Escape')
        selected = parameters.inner_text()
        if expected not in selected or ratio not in selected.lower():
            raise RuntimeError('PLATFORM_PARAMETERS_MISMATCH')
        return
    if duration.inner_text().strip() != expected:
        duration.click()
        page.get_by_text(expected, exact=True).last.click(timeout=10000)
    if duration.inner_text().strip() != expected:
        raise RuntimeError('DURATION_SELECTION_FAILED')
    selector = composer.locator('[data-testid="chat_input_action_video-ratio"]')
    if not selector.count():
        raise RuntimeError('ASPECT_RATIO_SELECTION_FAILED')
    selector.click()
    page.get_by_text('Auto' if ratio == 'auto' else ratio, exact=True).last.click(timeout=10000)
    if ratio not in selector.inner_text().lower():
        raise RuntimeError('ASPECT_RATIO_SELECTION_FAILED')


def asks_for_confirmation(text):
    return bool(re.search(
        r'(?:请|需要|等待).{0,12}确认|确认后.{0,12}(?:生成|开始)|是否按.{0,16}(?:参数|生成)'
        r'|please\s+confirm|once you confirm|would you like me to proceed', text, re.I))


def generation_phase(replies, cards=0):
    """A saved user message or a parameter proposal is not a running video."""
    latest = next((text for text in reversed(replies) if text.strip()), '')
    if cards or re.search(r'your video is ready|视频.{0,10}(?:已生成|生成完成)', latest, re.I):
        return 'ready'
    if asks_for_confirmation(latest):
        return None
    if re.search(r'video will be generated|(?:generating|creating) (?:your |the )?video'
                 r'|video is (?:being generated|generating)|视频.{0,12}生成中'
                 r'|(?:正在|已开始)生成.{0,8}视频', latest, re.I):
        return 'generating'
    return None


def confirmation_parameters_mismatch(text, job):
    if not asks_for_confirmation(text):
        return False
    expected = (job or {}).get('durationSeconds')
    duration = re.search(r'(?:时长|duration)\s*[:：]\s*(\d+)\s*(?:秒|seconds?|s)', text, re.I)
    limit = re.search(r'(?:可生成|支持).{0,12}?(\d+)\s*[-–—~至到]\s*(\d+)\s*秒', text)
    ratio = re.search(r'(?:比例|aspect ratio)\s*[:：]\s*(\d+)\s*[:：]\s*(\d+)', text, re.I)
    return bool((expected and duration and int(duration[1]) != expected)
                or (expected and limit and not int(limit[1]) <= expected <= int(limit[2]))
                or (ratio and (job or {}).get('aspectRatio')
                    and f'{ratio[1]}:{ratio[2]}' != job['aspectRatio']))


def response_state(page, job=None):
    if page.locator('#captcha_container:visible').count():
        return 'human'
    # User prompts may contain words such as "insufficient credits". Only the
    # platform's replies and notices are authoritative for account status.
    replies = assistant_texts(page,job,'dola')
    notices = page.locator('[role="alert"], .semi-toast-content').all_text_contents()
    check_context_limit(page,job,'dola',texts=replies,notices=notices)
    text = '\n'.join(replies + notices)
    if re.search(r'(?:not enough|insufficient|no more|out of)\s+(?:free\s+)?credits|(?:daily|free).{0,40}(?:limit reached|used up|exhausted)|(?:积分|额度|次数).{0,12}(?:不足|用完|耗尽)', text, re.I):
        return 'quota'
    # A proposal to use a shorter duration is a rejection of this request, not
    # evidence of a running video. Never silently accept the shorter version.
    latest = '\n'.join(replies[-1:] + notices)
    if confirmation_parameters_mismatch(latest, job):
        return 'parameters'
    if re.search(r'\b\d+\s*(?:seconds?|s)\s+(?:is|are)\s+(?:outside|beyond)\b.{0,65}(?:supported|range|limit)|(?:requested|this)\s+duration.{0,40}(?:not supported|unsupported)|(?:不支持|无法生成).{0,12}\d+\s*秒', latest, re.I):
        return 'failed'
    expected = (job or {}).get('durationSeconds')
    limit = re.search(r'supports?\s+durations?\s+(?:from\s+)?(\d+)\s*(?:to|[-–])\s*(\d+)\s+seconds?', latest, re.I)
    alternative = re.search(r'nearest supported duration of\s+(\d+)\s+seconds?', latest, re.I)
    if expected and ((limit and not int(limit[1]) <= expected <= int(limit[2]))
                     or (alternative and int(alternative[1]) != expected)):
        return 'failed'
    if re.search(r'(?:video generation|generate (?:the |this |your )?video).{0,35}(?:failed|unable)|unable to generate|couldn.t generate|(?:can.t|cannot) generate (?:the |this |your )?video|违反.{0,12}(?:规定|政策)', text, re.I):
        return 'failed'
    if logged_out(page):
        return 'login'
    return None


def wait_for_submission(page, timeout=90, job=None, context=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = response_state(page, job)
        if state == 'human':
            if solve_dola_captcha(page):
                continue
            raise RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')
        if state == 'quota':
            raise RuntimeError('DOLA_QUOTA_EXHAUSTED')
        if state == 'login':
            raise RuntimeError('LOGIN_EXPIRED_DURING_SUBMISSION')
        try:
            remote=task_url(page.url)
        except RuntimeError:
            page.wait_for_timeout(500)
            continue
        if not job or bind_message(context,page,job,'dola'):
            return remote
        page.wait_for_timeout(500)
    raise RuntimeError('DOLA_SUBMISSION_UNCONFIRMED')


def save_video(context, page, output, emit, timeout=600, job=None):
    started = time.monotonic()
    deadline = started + timeout
    response_deadline = min(deadline, started + 90)
    last_refresh = started
    opened_card = False
    generation_announced = False
    while time.monotonic() < deadline:
        state = response_state(page, job)
        if state == 'human':
            if solve_dola_captcha(page):
                continue
            raise RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')
        if state == 'quota':
            raise RuntimeError('DOLA_QUOTA_EXHAUSTED')
        if state == 'login':
            raise RuntimeError('LOGIN_EXPIRED_DURING_SUBMISSION')
        if state == 'failed':
            raise RuntimeError('PLATFORM_GENERATION_FAILED')
        if state == 'parameters':
            raise RuntimeError('PLATFORM_PARAMETERS_MISMATCH')
        if job:
            assert_conversation(page, job, 'dola')
        videos = scoped_locator(page,job,'dola','video')
        if opened_card and supported(job or {}) and not videos.count():
            videos=page.locator('video:visible')
            if videos.count()>1:
                raise RuntimeError('TASK_MESSAGE_AMBIGUOUS')
        if videos.count():
            media = videos.last.evaluate('video => video.currentSrc || video.src')
            if media.startswith('https://'):
                acknowledge_generation(context, page, job)
                emit('collecting')
                original = output.with_suffix('.original.mp4')
                download_video(context, media, original, ['dola.com'])
                repair_video(original, output, (job or {}).get('aspectRatio'), (job or {}).get('durationSeconds'))
                emit('success', resultPath=str(output))
                return
        if not opened_card:
            card = scoped_locator(page,job,'dola','[class*="block-video-"]:visible').last
            if card.count():
                acknowledge_generation(context, page, job)
                card.click(timeout=10000)
                opened_card = True
        if not generation_announced and generation_phase(assistant_texts(page, job, 'dola')) == 'generating':
            acknowledge_generation(context, page, job)
            emit('generating')
            generation_announced = True
        if not generation_announced and not opened_card and time.monotonic() >= response_deadline:
            raise RuntimeError('DOLA_SUBMISSION_UNCONFIRMED')
        if not opened_card and time.monotonic() - last_refresh >= 30:
            # Completion may arrive in the saved conversation before the live
            # chat updates. Reloading its durable URL never resubmits the job.
            page.reload(wait_until='domcontentloaded', timeout=60000)
            last_refresh = time.monotonic()
        page.wait_for_timeout(2000)
    raise RuntimeError('DOLA_RESULT_MEDIA_PENDING' if opened_card else
                       'PLATFORM_RESULT_PENDING' if generation_announced
                       else 'DOLA_SUBMISSION_UNCONFIRMED')


def acknowledge_generation(context, page, job):
    if job is not None and not job.get('generationAcknowledged'):
        job['generationAcknowledged'] = True
        remember_page(context, page, job, 'dola', details={'generationAcknowledged': True})


def can_retry_parameter_proposal(page, job):
    if (not can_restart_context(job, 'dola') or not job.get('leaseToken')
            or job.get('model') != DOLA_LONG_MODEL or job.get('durationSeconds') != 30
            or not job.get('remoteUrl') or not stable_id(job.get('remoteMessageId'))):
        return False
    state = read_state(job, 'dola')
    if not state.get('submissionStarted') or state.get('remoteMessageId') != job['remoteMessageId']:
        return False
    assert_conversation(page, job, 'dola')
    rows = scoped_rows(page, job, 'dola')
    replies = [row['text'] for row in rows if row['role'] == 'assistant']
    # A later proposal must never override any evidence that this video started.
    return (sum(row['role'] == 'user' for row in rows) == 1
            and not any(row.get('cards') or row.get('hasVideo') for row in rows if row['role'] == 'assistant')
            and not any(generation_phase([reply]) for reply in replies)
            and response_state(page, job) == 'parameters')


def reserve_parameter_retry(job):
    script = Path(__file__).resolve().parent.parent / 'symphony-pool-workbench/scripts/dola-new-conversation.mjs'
    node = os.environ.get('WORKBENCH_NODE_EXECUTABLE') or shutil.which('node')
    if not node or not script.is_file():
        return False
    data = {key:job.get(key) for key in ['id', 'accountId', 'leaseToken', 'remoteUrl', 'remoteMessageId']}
    data['reason'] = 'DOLA_PARAMETER_CONFIRMATION'
    try:
        result = subprocess.run([node, str(script)], input=json.dumps(data).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        return result.returncode == 0 and json.loads(result.stdout).get('ok') is True
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def run_dola(context, job, output, emit):
    page = job_page(context, job, 'dola')
    while True:
        try:
            execute_dola(context, page, job, output, emit)
            finish_page(context, page, job, 'dola')
            return
        except RuntimeError as error:
            if (str(error) == 'PLATFORM_PARAMETERS_MISMATCH' and can_retry_parameter_proposal(page, job)
                    and reserve_parameter_retry(job)):
                page = restart_context(context, job, 'dola', reason='DOLA_PARAMETER_CONFIRMATION')
                continue
            if str(error)=='CONVERSATION_CONTEXT_LIMIT' and can_restart_context(job,'dola'):
                emit('conversation_restart',code='CONVERSATION_CONTEXT_LIMIT')
                page=restart_context(context,job,'dola')
                continue
            if str(error) == 'DOLA_HUMAN_VERIFICATION_REQUIRED' and hasattr(context, 'preserve_page'):
                page.bring_to_front()
            raise


def wait_for_collection_message(page, job, timeout=30):
    """Use the submission matcher and message binding for existing results.

    Rendered Markdown list markers are not prompt changes. Keep the same
    semantic comparison as recovery, including the negative prompt, and never
    accept another user message in place of an already bound message ID.
    """
    deadline = time.monotonic() + timeout
    while True:
        if page.locator('#captcha_container:visible').count():
            if solve_dola_captcha(page):
                continue
            raise RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')
        if logged_out(page):
            raise RuntimeError('LOGIN_EXPIRED_DURING_SUBMISSION')
        try:
            rows = scoped_rows(page, job, 'dola')
        except RuntimeError as error:
            if str(error) != 'TASK_MESSAGE_MISMATCH':
                raise
            # A message can appear before its full text finishes rendering.
            rows = []
        candidates = [row for row in rows if row['role'] == 'user'
                      and stable_id(row['id']) and matches_prompt(job, row['text'])]
        if len(candidates) > 1:
            raise RuntimeError('TASK_MESSAGE_AMBIGUOUS')
        if candidates:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('DOLA_TASK_MISMATCH')
        page.wait_for_timeout(500)


def execute_dola(context, page, job, output, emit):
    if job.get('collectExistingUrl'):
        wait_for_collection_message(page, job)
        assert_conversation(page, job, 'dola')
        # The saved chat proves submission only. The collector must see an
        # explicit platform acknowledgement before reporting generation.
        emit('submitted', remoteUrl=task_url(job['collectExistingUrl']), remoteMessageId=job.get('remoteMessageId'))
        save_video(context, page, output, emit, timeout=generation_timeout(job), job=job)
        return
    prompt = build_prompt(job)
    if job.get('model') == DOLA_LONG_MODEL:
        enable_extended_duration(page, job['durationSeconds'])
    attachments = job.get('referenceAssets') or []
    if job.get('reuseConversation'):
        assert_conversation(page,job,'dola')
        composer = open_composer(page,reuse=True,reference_assets=attachments)
    else:
        composer = open_composer(page,reference_assets=attachments)
    configure(page, composer, job)
    install_joint_submission(page, {**job, 'service': 'dola'}, prompt)
    if attachments:
        # Switching to video mode must retain the same native attachments.
        wait_for_reference_upload(page, len(attachments))
    composer.locator('[contenteditable=true]').fill(prompt)
    if logged_out(page):
        raise RuntimeError('LOGIN_REQUIRED')
    submit = composer.locator('[data-testid="chat_input_send_button"]')
    try:
        page.wait_for_function('''() => {
            const button = document.querySelector('[data-testid="chat_input_send_button"]');
            return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
        }''', timeout=45000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError('SUBMIT_NOT_READY') from error
    begin_submission(context, page, job, 'dola')
    emit('submitting')
    submit.click()
    confirm_joint_submission(page, {**job, 'service': 'dola'})
    remote = wait_for_submission(page, job=job,context=context)
    emit('submitted', remoteUrl=remote,remoteMessageId=job.get('remoteMessageId'))
    job['remoteUrl'] = remote
    remember_page(context, page, job, 'dola', remote)
    save_video(context, page, output, emit, timeout=generation_timeout(job), job=job)
