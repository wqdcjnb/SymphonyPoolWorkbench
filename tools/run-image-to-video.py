from stream_media import download_video
from browser_runtime import persistent_context
from dola_video import run_dola
"""Execute one authorized video generation job in an isolated browser profile.

Receives a JSON job on stdin and emits small JSON status lines on stdout. Never
prints cookies, prompts, page text, or signed media URLs.
"""

import json
from contextlib import suppress
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from browser_runtime import generation_browser_options, profile_in_use_error
from doubao_parameters import confirmation_matches, video_prompt, select_ratio, response_state, prepare_video_confirmation
from video_ratios import VIDEO_RATIOS, VIDEO_FIXED_RATIOS
from joint_submission import install_joint_submission, confirm_joint_submission
from doubao_export import export_original
from doubao_duration import (select_base_duration, install_duration_submission,
                             confirm_duration_submission, verify_result_duration)
from doubao_challenge import check_human_verification
from doubao_upload import open_video_composer, wait_for_image_attachments
from doubao_parameters import VIDEO_PARAMS_PANEL
from task_pages import job_page, remember_page, begin_submission, assert_conversation, finish_page, can_restart_context, restart_context
from task_messages import bind_message, assistant_texts, scoped_locator, check_context_limit


DOUBAO_CREATE = "https://www.doubao.com/chat/create-image"
TIKTOK_CREATE = "https://ads.tiktok.com/creative/creativestudio/image-to-video"
TIKTOK_HISTORY_PATH = "/creative_bff_i18n/api/cue/history/tasks"


def emit(stage: str, **fields: object) -> None:
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=False), flush=True)


def verify_job(job: dict) -> None:
    if job.get("collectOnly") and not job.get("collectExistingUrl"):
        raise RuntimeError("COLLECTION_REMOTE_URL_REQUIRED")
    images = job.get("referenceAssets") or []
    if not job.get("collectExistingUrl"):
        supported = {"doubao": (("Seedance 2.0 Fast", "Seedance 2.0 Mini"), 15, 9),
                     "dola": (("Dreamina Seedance 2.5",), 30, 9)}
        spec = supported.get(job.get("service"))
        ratios = VIDEO_FIXED_RATIOS
        if (not spec or job.get("model") not in spec[0] or job.get("durationSeconds") != spec[1]
                or job.get("aspectRatio") not in ratios or len(images) > spec[2]):
            raise RuntimeError("INVALID_JOB_PARAMETERS")
    reference_mode = job.get("mode") == "reference_to_video"
    if not 0 <= len(images) <= (4 if job["service"] == "symphony" else 9):
        raise RuntimeError("INVALID_REFERENCE_IMAGE_COUNT")
    ratio = job.get("aspectRatio") or "auto"
    if ratio not in VIDEO_RATIOS:
        raise RuntimeError("INVALID_ASPECT_RATIO")
    if job["service"] == "symphony" and ratio not in ("auto", "9:16"):
        raise RuntimeError("INVALID_ASPECT_RATIO")
    if not job.get("collectExistingUrl"):
        for image_path in images:
            image = Path(image_path)
            if not image.is_absolute() or not image.is_file():
                raise RuntimeError("REFERENCE_IMAGE_NOT_FOUND")
    if job["mode"] not in ("image_to_video", "reference_to_video"):
        raise RuntimeError("INVALID_JOB")
    if job["service"] not in ("doubao", "symphony", "dola"):
        raise RuntimeError("INVALID_SERVICE")
    if reference_mode:
        if job["service"] != "doubao" or job["model"] != "Seedance 2.0 Fast":
            raise RuntimeError("INVALID_JOB_PARAMETERS")
        video_path = job.get("referenceVideo")
        if not video_path:
            raise RuntimeError("REFERENCE_VIDEO_REQUIRED")
        if not job.get("collectExistingUrl") and not Path(video_path).is_file():
            raise RuntimeError("REFERENCE_VIDEO_NOT_FOUND")
    elif job.get("referenceVideo"):
        raise RuntimeError("INVALID_JOB_PARAMETERS")


def platform_prompt(job: dict) -> str:
    if job["service"] == "doubao":
        return video_prompt(job)
    positive = job["prompt"].strip()
    negative = (job.get("negativePrompt") or "").strip()
    return f"{positive}\n\n请避免出现：{negative}" if negative else positive


def doubao_logged_out(page) -> bool:
    parsed = urlparse(page.url)
    return bool(parse_qs(parsed.query).get("from_logout") or
                page.get_by_role("button", name="登录", exact=True).is_visible())


def wait_for_doubao_task(page, timeout_seconds=90, context=None, job=None) -> str:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        check_context_limit(page,job,'doubao')
        parsed = urlparse(page.url)
        if (parsed.hostname == "www.doubao.com" and re.fullmatch(r"/chat/\d+", parsed.path)
                and (not job or bind_message(context,page,job,'doubao'))):
            return page.url.split("?", 1)[0]
        if doubao_logged_out(page):
            # The click happened, but no durable platform task ID was acknowledged.
            # Keep this distinct from a safe, pre-submission LOGIN_REQUIRED failure.
            raise RuntimeError("LOGIN_EXPIRED_DURING_SUBMISSION")
        check_human_verification(page)
        page.wait_for_timeout(500)
    raise RuntimeError("DOUBAO_SUBMISSION_UNCONFIRMED")


def wait_for_doubao_response(page, timeout_seconds=180, done_only=False, after_assistant_count=0, job=None):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        check_human_verification(page)
        if doubao_logged_out(page):
            raise RuntimeError('LOGIN_EXPIRED_DURING_SUBMISSION')
        if job:
            assert_conversation(page, job, 'doubao')
        replies = assistant_texts(page,job,'doubao')
        check_context_limit(page,job,'doubao',texts=replies)
        state = response_state(replies[after_assistant_count:])
        if state == 'subscription':
            raise RuntimeError('DOUBAO_SUBSCRIPTION_REQUIRED')
        if state == 'quota':
            raise RuntimeError('DOUBAO_FREE_QUOTA_EXHAUSTED')
        if done_only and state == 'confirm':
            raise RuntimeError('DOUBAO_CONFIRMATION_REQUIRED')
        if state == 'done' or (state and not done_only):
            return state
        page.wait_for_timeout(500)
    raise RuntimeError('DOUBAO_GENERATION_TIMEOUT' if done_only else 'DOUBAO_RESPONSE_TIMEOUT')


def save_doubao_video(context, page, output_path: Path, timeout_seconds=600, duration_seconds=None, job=None) -> None:
    wait_for_doubao_response(page, timeout_seconds=timeout_seconds, done_only=True, job=job)
    card = scoped_locator(page,job,'doubao','[class*="block-video-"]').last
    card.wait_for(timeout=20_000)
    if job:
        assert_conversation(page, job, 'doubao')
    emit("collecting")
    card.click()
    export_original(context, page, output_path, downloader=download_video)
    if duration_seconds is not None:
        verify_result_duration(output_path, duration_seconds)
    emit("success", resultPath=str(output_path))


def run_doubao(context, job: dict, output_path: Path) -> None:
    page = job_page(context, job, 'doubao')
    while True:
        try:
            _run_doubao_page(context, page, job, output_path)
            finish_page(context, page, job, 'doubao')
            return
        except Exception as error:
            if str(error)=='CONVERSATION_CONTEXT_LIMIT' and can_restart_context(job,'doubao'):
                emit('conversation_restart',code='CONVERSATION_CONTEXT_LIMIT')
                page=restart_context(context,job,'doubao')
                continue
            if str(error) == 'DOUBAO_HUMAN_VERIFICATION_REQUIRED' and hasattr(context, 'preserve_page'):
                page.bring_to_front()
            raise


def _run_doubao_page(context, page, job: dict, output_path: Path) -> None:
    remote_url = job.get("collectExistingUrl")
    if remote_url:
        parsed = urlparse(remote_url)
        if parsed.scheme != "https" or parsed.hostname != "www.doubao.com" or not re.fullmatch(r"/chat/\d+", parsed.path):
            raise RuntimeError("INVALID_REMOTE_URL")
        check_human_verification(page)
        if doubao_logged_out(page):
            raise RuntimeError("LOGIN_REQUIRED")
        assert_conversation(page, job, 'doubao')
        save_doubao_video(context, page, output_path, timeout_seconds=job.get('collectionCheckSeconds', 600),
                          duration_seconds=job['durationSeconds'], job=job)
        return

    if job.get('reuseConversation'):
        assert_conversation(page,job,'doubao')
    open_video_composer(page, job)
    page.get_by_text("模型", exact=True).first.locator("..").click(timeout=15_000)
    selected = page.get_by_text(job["model"], exact=True).last
    if "升级" in selected.locator("..").inner_text(timeout=5_000):
        raise RuntimeError("MODEL_REQUIRES_UPGRADE")
    selected.click(timeout=15_000)

    page.locator(VIDEO_PARAMS_PANEL).click(timeout=15_000)
    select_base_duration(page)
    aspect_ratio = job.get("aspectRatio") or "auto"
    select_ratio(page, aspect_ratio)

    install_duration_submission(page, job)
    install_joint_submission(page, {**job, 'service': 'doubao'}, platform_prompt(job))
    attachments = [*job["referenceAssets"]]
    if job["mode"] == "reference_to_video":
        attachments.append(job["referenceVideo"])
    if job['mode'] == 'image_to_video' and attachments:
        # The + picker already uploaded these files. Model/ratio changes must
        # retain every attachment before the full prompt can be submitted.
        wait_for_image_attachments(page, len(attachments))
    elif attachments:
        upload = page.locator('[data-testid="upload-file-input"]')
        if job["mode"] == "reference_to_video" and ".mp4" not in (upload.get_attribute("accept") or ""):
            raise RuntimeError("REFERENCE_VIDEO_MODEL_UNAVAILABLE")
        upload.set_input_files(attachments)
        page.wait_for_function(
            """expected => {
                const area = document.querySelector('[data-testid="video-attachment-scroll-container"]');
                return area && area.querySelectorAll('[data-testid="attachment-image-card"]').length === expected.images
                    && area.querySelectorAll('[data-testid="attachment-video-card"]').length === expected.videos
                    && !area.querySelector('[role="progressbar"]');
            }""",
            arg={"images": len(job["referenceAssets"]), "videos": 1 if job["mode"] == "reference_to_video" else 0},
            timeout=120_000,
        )
    page.locator('[data-testid="chat_input"] [contenteditable="true"]').first.fill(platform_prompt(job))
    if doubao_logged_out(page):
        raise RuntimeError("LOGIN_REQUIRED")
    send = page.locator('[data-testid="chat_input_send_button"]')
    if not send.is_enabled():
        raise RuntimeError("SUBMIT_NOT_READY")
    begin_submission(context, page, job, 'doubao')
    emit("submitting")
    send.click()
    try:
        page.get_by_text("安全确认", exact=True).wait_for(state="visible", timeout=15_000)
        page.get_by_role("button", name="确认", exact=True).click()
    except PlaywrightTimeoutError:
        pass

    confirm_joint_submission(page, {**job, 'service': 'doubao'})
    duration_submissions = confirm_duration_submission(page)
    check_human_verification(page)
    remote_url = wait_for_doubao_task(page,context=context,job=job)
    emit("submitted", remoteUrl=remote_url,remoteMessageId=job.get('remoteMessageId'))
    job['remoteUrl'] = remote_url
    remember_page(context, page, job, 'doubao', remote_url)
    platform_state = wait_for_doubao_response(page, job=job)
    if platform_state == "confirm":
        confirmation = scoped_locator(page,job,'doubao','[data-testid="message_content"]').filter(
            has_text="视频生成参数确认").last
        deadline = time.monotonic() + 60
        while not confirmation_matches(confirmation.inner_text(timeout=10_000), job):
            assert_conversation(page, job, 'doubao')
            check_context_limit(page,job,'doubao')
            if response_state(assistant_texts(page,job,'doubao')) == 'subscription':
                raise RuntimeError('DOUBAO_SUBSCRIPTION_REQUIRED')
            check_human_verification(page)
            if doubao_logged_out(page):
                raise RuntimeError("LOGIN_EXPIRED_DURING_SUBMISSION")
            if time.monotonic() >= deadline:
                raise RuntimeError("PLATFORM_PARAMETERS_MISMATCH")
            page.wait_for_timeout(500)
        prepare_video_confirmation(page, job)
        page.locator('[data-testid="chat_input"] [contenteditable="true"]').first.fill("确认生成")
        previous_replies = len(assistant_texts(page,job,'doubao'))
        page.locator('[data-testid="chat_input_send_button"]').click()
        confirm_joint_submission(page, {**job, 'service': 'doubao'})
        confirm_duration_submission(page, previous_count=duration_submissions)
        platform_state = wait_for_doubao_response(page, after_assistant_count=previous_replies, job=job)
        if platform_state == 'confirm':
            raise RuntimeError('DOUBAO_CONFIRMATION_UNCONFIRMED')
    emit("generating")
    save_doubao_video(context, page, output_path, duration_seconds=job['durationSeconds'], job=job)


def tiktok_task_ids(page) -> set[str]:
    with page.expect_response(
        lambda response: urlparse(response.url).path == TIKTOK_HISTORY_PATH,
        timeout=60_000,
    ) as pending:
        page.goto(TIKTOK_CREATE, wait_until="domcontentloaded", timeout=60_000)
    payload = pending.value.json()
    items = (payload.get("data") or {}).get("draft_infos") or []
    return {str(item["id"]) for item in items if str(item.get("id", "")).isdigit()}


def tiktok_task_url(task_id: str) -> str:
    return f"{TIKTOK_CREATE}?activeId={task_id}"


def save_tiktok_video(page, output_path: Path) -> None:
    for _ in range(60):
        page.reload(wait_until="domcontentloaded", timeout=60_000)
        try:
            page.wait_for_function(
                """() => document.body?.innerText.includes('Video preview')
                    && /\\b(Completed|Exported)\\b/.test(document.body.innerText)
                    && document.querySelector('video')""",
                timeout=20_000,
            )
            preview = page.locator("video").last
            preview.evaluate("video => video.play().catch(() => {})")
            media_url = preview.evaluate("video => video.currentSrc || video.src")
            emit("collecting")
            download_video(page.context, media_url, output_path, ["tiktokcdn-row.com"])
            emit("success", resultPath=str(output_path))
            return

        except PlaywrightTimeoutError:
            if page.get_by_text("Failed", exact=True).count():
                raise RuntimeError("PLATFORM_GENERATION_FAILED")
        page.wait_for_timeout(10_000)
    raise RuntimeError("PLATFORM_GENERATION_TIMEOUT")


def run_tiktok(context, job: dict, output_path: Path) -> None:
    page = context.new_page()
    remote_url = job.get("collectExistingUrl")
    if remote_url:
        parsed = urlparse(remote_url)
        task_id = parse_qs(parsed.query).get("activeId", [""])[0]
        if parsed.scheme != "https" or parsed.hostname != "ads.tiktok.com" or parsed.path != urlparse(TIKTOK_CREATE).path or not task_id.isdigit():
            raise RuntimeError("INVALID_REMOTE_URL")
        page.goto(remote_url, wait_until="domcontentloaded", timeout=60_000)
        save_tiktok_video(page, output_path)
        return

    if job["model"] != "Video 1.5 Pro" or job["durationSeconds"] not in (5, 10, 12):
        raise RuntimeError("INVALID_JOB_PARAMETERS")
    previous_ids = tiktok_task_ids(page)
    image_count = len(job["referenceAssets"])
    page.get_by_text("Reference to video", exact=True).first.wait_for(timeout=60_000)
    if image_count <= 1:
        page.get_by_text("Reference to video", exact=True).first.click()
        page.get_by_text("Text to video" if image_count == 0 else "Image to video", exact=True).last.click()
    page.get_by_text("Video 1.5 Pro", exact=True).first.wait_for(timeout=15_000)
    if job["durationSeconds"] != 5:
        page.get_by_text("5s", exact=True).last.click()
        page.get_by_text(f'{job["durationSeconds"]}s', exact=True).last.click()
    if page.get_by_text(f'{job["durationSeconds"]}s', exact=True).count() == 0:
        raise RuntimeError("DURATION_SELECTION_FAILED")
    if image_count == 1:
        page.locator('button[aria-label="Upload first frame"]').click()
        with page.expect_file_chooser() as pending:
            page.get_by_text("Upload image", exact=True).click()
        pending.value.set_files(job["referenceAssets"][0])
    elif image_count > 1:
        page.get_by_role("button", name="Upload", exact=True).first.click()
        with page.expect_file_chooser() as pending:
            page.get_by_text("Upload image", exact=True).last.click()
        if not pending.value.is_multiple():
            raise RuntimeError("MULTI_IMAGE_UPLOAD_UNAVAILABLE")
        pending.value.set_files(job["referenceAssets"])
    page.locator('[contenteditable="true"]').first.fill(platform_prompt(job))
    submit = page.locator('ks-icon-button-1-1-1m:has(ks-icon-arrow-up-small)').last
    submit.wait_for(timeout=15_000)
    page.wait_for_function(
        """() => [...document.querySelectorAll('ks-icon-button-1-1-1m')]
            .some(host => host.querySelector('ks-icon-arrow-up-small')
                && host.shadowRoot?.querySelector('button:not([disabled])'))""",
        timeout=45_000,
    )
    emit("submitting")
    submit.locator("button").click()
    page.get_by_text("Check back in", exact=False).first.wait_for(timeout=60_000)

    task_id = None
    for _ in range(5):
        current_ids = tiktok_task_ids(page)
        created = current_ids - previous_ids
        if len(created) == 1:
            task_id = created.pop()
            break
        page.wait_for_timeout(3_000)
    if not task_id:
        raise RuntimeError("TIKTOK_TASK_ID_NOT_FOUND")
    remote_url = tiktok_task_url(task_id)
    emit("submitted", remoteUrl=remote_url)
    emit("generating")
    page.goto(remote_url, wait_until="domcontentloaded", timeout=60_000)
    save_tiktok_video(page, output_path)


def main() -> int:
    job = {}
    launching_browser = False
    try:
        job = json.load(sys.stdin)
        verify_job(job)
        output = Path(job["outputPath"])
        with sync_playwright() as playwright:
            launching_browser = True
            context = persistent_context(playwright,
                job["profilePath"], **generation_browser_options(), headless=False,
                accept_downloads=True, viewport={"width": 1440, "height": 900},
            )
            launching_browser = False
            try:
                if job["service"] == "doubao":
                    run_doubao(context, job, output)
                elif job["service"] == "dola":
                    run_dola(context, job, output, emit)
                else:
                    run_tiktok(context, job, output)
            finally:
                # A crashed browser may also fail to close. Keep the original
                # collection error instead of replacing it with a generic one.
                with suppress(Exception):
                    context.close()
        return 0
    except Exception as error:
        code = "PROFILE_IN_USE" if profile_in_use_error(error, job.get("profilePath")) else str(error)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,80}", code):
            code = "BROWSER_LAUNCH_FAILED" if launching_browser else "BROWSER_AUTOMATION_FAILED"
        emit("error", code=code)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
