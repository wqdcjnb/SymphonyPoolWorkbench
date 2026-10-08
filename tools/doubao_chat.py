"""Doubao image generation through its ordinary chat composer."""
from doubao_challenge import check_human_verification
from doubao_parameters import VIDEO_PARAMS_PANEL, chat_confirmation_text
from doubao_upload import DOUBAO_CHAT, upload_chat_images
from task_pages import assert_conversation, read_state, remember_page


def uses_chat_entry(job):
    return (job.get('mode') == 'image_to_video'
            and job.get('model') == 'Seedance 2.0 Fast'
            and job.get('durationSeconds') == 15
            and 1 <= len(job.get('referenceAssets') or []) <= 9)


def select_chat_model(page):
    composer = page.locator('[data-testid="chat_input"]')
    if page.locator(VIDEO_PARAMS_PANEL).count():
        composer.locator('[data-testid="skill_input_exit_button"]').last.click(timeout=10000)
    model = composer.locator('[data-testid="chat_input_action_model"]')
    model.wait_for(timeout=15000)
    if 'Turbo' not in model.inner_text():
        model.click(timeout=10000)
        page.get_by_text('专家', exact=True).click(timeout=10000)
    if 'Turbo' not in model.inner_text() or page.locator(VIDEO_PARAMS_PANEL).count():
        raise RuntimeError('MODEL_SELECTION_FAILED')


def open_chat_composer(page, job):
    if not job.get('reuseConversation'):
        page.goto(DOUBAO_CHAT, wait_until='domcontentloaded', timeout=60000)
    check_human_verification(page)
    select_chat_model(page)
    upload_chat_images(page, job['referenceAssets'])


def confirm_chat_video(context, page, job):
    """Keep a once-only confirmation on the creation intent, with original specs."""
    state = read_state(job, 'doubao')
    if state.get('chatConfirmationStarted'):
        raise RuntimeError('DOUBAO_CONFIRMATION_UNCONFIRMED')
    assert_conversation(page, job, 'doubao')
    check_human_verification(page)
    select_chat_model(page)
    text = chat_confirmation_text(job)
    page.locator('[data-testid="chat_input"] [contenteditable="true"]').first.fill(text)
    send = page.locator('[data-testid="chat_input_send_button"]')
    if not send.is_enabled():
        raise RuntimeError('SUBMIT_NOT_READY')
    remember_page(context, page, job, 'doubao', details={
        'chatConfirmationStarted': True, 'chatConfirmationText': text})
    send.click()
