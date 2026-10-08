"""Detect a visible platform challenge and leave it to the human operator."""


def human_verification_required(page):
    return page.locator('#captcha_container:visible, .captcha_verify_container:visible, '
                        '#captcha-verify-container-main-page:visible').count() > 0


def check_human_verification(page):
    if human_verification_required(page):
        raise RuntimeError('DOUBAO_HUMAN_VERIFICATION_REQUIRED')
