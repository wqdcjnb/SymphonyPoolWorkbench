"""Upload image references through Doubao's native + attachment picker."""
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from doubao_parameters import VIDEO_PARAMS_PANEL

DOUBAO_CHAT = 'https://www.doubao.com/chat/'
DOUBAO_CREATE = 'https://www.doubao.com/chat/create-image'


def wait_for_image_attachments(page, expected):
    try:
        page.wait_for_function('''expected => {
            const area = document.querySelector('[data-testid="chat_input"] [data-testid="attachment_area"]');
            return area && area.querySelectorAll('[data-testid="attachment-image-card"]').length === expected
                && !area.matches('[aria-busy="true"]')
                && !area.querySelector('[data-testid="attachment-video-card"], [role="progressbar"], [aria-busy="true"]');
        }''', arg=expected, timeout=120000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOUBAO_UPLOAD_FAILED') from error


def upload_chat_images(page, images):
    composer = page.locator('[data-testid="chat_input"]')
    try:
        page.wait_for_function('''() => [...document.querySelectorAll(
            '[data-testid="chat_input"] [data-testid="upload_file_button"], '
            + '[data-testid="chat_input"] [data-testid="skill_input_exit_button"]')]
            .some(node => node.getClientRects().length > 0)''', timeout=15000)
        # A completed conversation can still have its video tool selected.
        plus = composer.locator('[data-testid="upload_file_button"]')
        if not plus.is_visible():
            composer.locator('[data-testid="skill_input_exit_button"]').last.click(timeout=10000)
            plus.wait_for(timeout=10000)
        if composer.locator('[data-testid="attachment-image-card"], [data-testid="attachment-video-card"]').count():
            raise RuntimeError('MULTIMODAL_ATTACHMENTS_MISMATCH')
        upload = page.get_by_text('上传文件或图片', exact=True)
        # The visible home-page composer can precede React event binding. Retry
        # opening its menu once, before choosing files or sending any message.
        if not upload.is_visible():
            plus.click(timeout=10000)
            try:
                upload.wait_for(state='visible', timeout=3000)
            except PlaywrightTimeoutError:
                plus.click(timeout=10000)
                upload.wait_for(state='visible', timeout=10000)
        # Doubao's + opens a menu; Dola's + opens a chooser directly.
        with page.expect_file_chooser(timeout=15000) as chooser:
            upload.click(timeout=10000)
        chooser.value.set_files(images)
        wait_for_image_attachments(page, len(images))
    except PlaywrightTimeoutError as error:
        raise RuntimeError('DOUBAO_UPLOAD_FAILED') from error


def open_video_composer(page, job):
    images = job.get('referenceAssets') or []
    if images and job['mode'] == 'image_to_video':
        if not job.get('reuseConversation'):
            page.goto(DOUBAO_CHAT, wait_until='domcontentloaded', timeout=60000)
        upload_chat_images(page, images)
        page.locator('[data-testid="chat_input"]').get_by_text('视频生成', exact=True).click(timeout=15000)
        page.locator(VIDEO_PARAMS_PANEL).wait_for(timeout=15000)
        wait_for_image_attachments(page, len(images))
    elif not job.get('reuseConversation'):
        page.goto(DOUBAO_CREATE, wait_until='domcontentloaded', timeout=60000)
        page.get_by_text('视频', exact=True).first.click(timeout=30000)
