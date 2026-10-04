"""Execute one authorized video generation job in an isolated browser profile.

Receives a JSON job on stdin and emits small JSON status lines on stdout. Never
prints cookies, prompts, page text, or signed media URLs.
"""

import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from browser_runtime import generation_browser_options, profile_in_use_error


DOUBAO_CREATE = "https://www.doubao.com/chat/create-image"
TIKTOK_CREATE = "https://ads.tiktok.com/creative/creativestudio/image-to-video"
TIKTOK_HISTORY_PATH = "/creative_bff_i18n/api/cue/history/tasks"


def emit(stage: str, **fields: object) -> None:
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=False), flush=True)


def verify_job(job: dict) -> None:
    images = job.get("referenceAssets") or []
    reference_mode = job.get("mode") == "reference_to_video"
    if not 0 <= len(images) <= (4 if job["service"] == "symphony" else 9):
        raise RuntimeError("INVALID_REFERENCE_IMAGE_COUNT")
    ratio = job.get("aspectRatio") or "auto"
    if ratio not in ("auto", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"):
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
    if job["service"] not in ("doubao", "symphony"):
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
    positive = job["prompt"].strip()
    negative = (job.get("negativePrompt") or "").strip()
    return f"{positive}\n\n请避免出现：{negative}" if negative else positive


def doubao_logged_out(page) -> bool:
    parsed = urlparse(page.url)
    return bool(parse_qs(parsed.query).get("from_logout") or
                page.get_by_role("button", name="登录", exact=True).is_visible())


def wait_for_doubao_task(page, timeout_seconds=90) -> str:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        parsed = urlparse(page.url)
        if parsed.hostname == "www.doubao.com" and re.fullmatch(r"/chat/\d+", parsed.path):
            return page.url.split("?", 1)[0]
        if doubao_logged_out(page):
            # The click happened, but no durable platform task ID was acknowledged.
            # Keep this distinct from a safe, pre-submission LOGIN_REQUIRED failure.
            raise RuntimeError("LOGIN_EXPIRED_DURING_SUBMISSION")
        page.wait_for_timeout(500)
    raise RuntimeError("DOUBAO_SUBMISSION_UNCONFIRMED")


def save_doubao_video(context, page, output_path: Path) -> None:
    try:
        page.get_by_text("你的视频生成好了。", exact=False).wait_for(timeout=600_000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError("DOUBAO_GENERATION_TIMEOUT") from error
    card = page.locator('[class*="block-video-"]').last
    card.wait_for(timeout=20_000)
    emit("collecting")
    card.click()
    video = page.locator("video").first
    video.wait_for(state="attached", timeout=30_000)
    page.wait_for_function("() => [...document.querySelectorAll('video')].some(v => v.currentSrc)", timeout=30_000)
    media_url = video.evaluate("v => v.currentSrc || v.src")
    host = urlparse(media_url).hostname or ""
    if urlparse(media_url).scheme != "https" or not (host == "doubao.com" or host.endswith(".doubao.com")):
        raise RuntimeError("UNEXPECTED_MEDIA_HOST")
    response = context.request.get(media_url, timeout=180_000)
    media = response.body()
    if response.status != 200 or "video/mp4" not in response.headers.get("content-type", "") or media[4:8] != b"ftyp":
        raise RuntimeError("VIDEO_DOWNLOAD_FAILED")
    if len(media) > 500_000_000:
        raise RuntimeError("VIDEO_TOO_LARGE")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(".part")
    temporary.write_bytes(media)
    temporary.replace(output_path)
    emit("success", resultPath=str(output_path))


def run_doubao(context, job: dict, output_path: Path) -> None:
    page = context.new_page()
    remote_url = job.get("collectExistingUrl")
    if remote_url:
        parsed = urlparse(remote_url)
        if parsed.scheme != "https" or parsed.hostname != "www.doubao.com" or not re.fullmatch(r"/chat/\d+", parsed.path):
            raise RuntimeError("INVALID_REMOTE_URL")
        page.goto(remote_url, wait_until="domcontentloaded", timeout=60_000)
        save_doubao_video(context, page, output_path)
        return

    page.goto(DOUBAO_CREATE, wait_until="domcontentloaded", timeout=60_000)
    page.get_by_text("视频", exact=True).first.click(timeout=30_000)
    page.get_by_text("模型", exact=True).first.locator("..").click(timeout=15_000)
    selected = page.get_by_text(job["model"], exact=True).last
    if "升级" in selected.locator("..").inner_text(timeout=5_000):
        raise RuntimeError("MODEL_REQUIRES_UPGRADE")
    selected.click(timeout=15_000)

    page.locator('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"]').click(timeout=15_000)
    slider = page.get_by_role("slider").first
    slider.focus()
    slider.press("Home")
    for _ in range(1 if job["durationSeconds"] == 5 else 6):
        slider.press("ArrowRight")
    expected = "1" if job["durationSeconds"] == 5 else "6"
    if slider.get_attribute("aria-valuenow") != expected:
        raise RuntimeError("DURATION_SELECTION_FAILED")
    aspect_ratio = job.get("aspectRatio") or "auto"
    if aspect_ratio != "auto":
        page.get_by_role("button", name=aspect_ratio, exact=True).click(timeout=15_000)
        selected_parameters = page.locator('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"]')
        if aspect_ratio not in selected_parameters.inner_text(timeout=5_000):
            raise RuntimeError("ASPECT_RATIO_SELECTION_FAILED")

    attachments = [*job["referenceAssets"]]
    if job["mode"] == "reference_to_video":
        attachments.append(job["referenceVideo"])
    if attachments:
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
    page.locator('[contenteditable="true"]').first.fill(platform_prompt(job))
    if doubao_logged_out(page):
        raise RuntimeError("LOGIN_REQUIRED")
    send = page.locator('[data-testid="chat_input_send_button"]')
    if not send.is_enabled():
        raise RuntimeError("SUBMIT_NOT_READY")
    emit("submitting")
    send.click()
    try:
        page.get_by_text("安全确认", exact=True).wait_for(state="visible", timeout=15_000)
        page.get_by_role("button", name="确认", exact=True).click()
    except PlaywrightTimeoutError:
        pass

    remote_url = wait_for_doubao_task(page)
    emit("submitted", remoteUrl=remote_url)
    try:
        platform_state = page.wait_for_function(
            """() => {
                const messages = [...document.querySelectorAll('[data-testid="message_content"]')]
                    .map(message => message.innerText);
                if (messages.some(message => /(?:免费次数|生成次数|免费额度|剩余额度|次数).{0,12}(?:用完|用尽|耗尽|不足)/.test(message))) return 'quota';
                if (messages.some(message => message.includes('你的视频生成好了。'))) return 'done';
                if (messages.some(message => message.includes('视频生成参数确认'))) return 'confirm';
                if (messages.some(message => message.includes('视频生成好后'))) return 'auto';
                return false;
            }""",
            timeout=180_000,
        ).json_value()
    except PlaywrightTimeoutError as error:
        raise RuntimeError("DOUBAO_RESPONSE_TIMEOUT") from error
    if platform_state == "quota":
        raise RuntimeError("DOUBAO_FREE_QUOTA_EXHAUSTED")
    if platform_state == "confirm":
        confirmation = page.get_by_text("视频生成参数确认", exact=False)
        confirmation_text = confirmation.locator('xpath=ancestor::*[@data-testid="message_content"][1]').inner_text(timeout=10_000)
        if job["model"] not in confirmation_text or f'{job["durationSeconds"]} 秒' not in confirmation_text:
            raise RuntimeError("PLATFORM_PARAMETERS_MISMATCH")
        page.locator('[data-testid="chat_input"] [contenteditable="true"]').first.fill("确认生成")
        page.locator('[data-testid="chat_input_send_button"]').click()
    emit("generating")
    save_doubao_video(context, page, output_path)


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
    media: dict[str, bytes] = {}

    def capture(response) -> None:
        host = urlparse(response.url).hostname or ""
        if not (host == "tiktokcdn-row.com" or host.endswith(".tiktokcdn-row.com")):
            return
        if "video/mp4" not in response.headers.get("content-type", ""):
            return
        try:
            body = response.body()
            byte_range = response.headers.get("content-range", "")
            match = re.fullmatch(r"bytes 0-(\d+)/(\d+)", byte_range)
            complete = response.status == 200 or (
                response.status == 206 and match and int(match.group(1)) + 1 == int(match.group(2)) == len(body)
            )
            if complete and body[4:8] == b"ftyp" and len(body) <= 500_000_000:
                media[response.url] = body
                while len(media) > 10:
                    media.pop(next(iter(media)))
        except Exception:
            pass

    page.on("response", capture)
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
            for _ in range(6):
                if media_url in media:
                    break
                page.wait_for_timeout(2_000)
            if media_url in media:
                emit("collecting")
                output_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = output_path.with_suffix(".part")
                temporary.write_bytes(media[media_url])
                temporary.replace(output_path)
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
            context = playwright.chromium.launch_persistent_context(
                job["profilePath"], **generation_browser_options(), headless=False,
                accept_downloads=True, viewport={"width": 1440, "height": 900},
            )
            launching_browser = False
            try:
                if job["service"] == "doubao":
                    run_doubao(context, job, output)
                else:
                    run_tiktok(context, job, output)
            finally:
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
