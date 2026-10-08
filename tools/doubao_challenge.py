"""Detect a visible platform challenge; auto-solve grids, else leave it to the human operator."""


def human_verification_required(page):
    return page.locator('#captcha_container:visible, .captcha_verify_container:visible, '
                        '#captcha-verify-container-main-page:visible').count() > 0


def check_human_verification(page):
    if human_verification_required(page):
        from doubao_grid_captcha import solve_doubao_grid_captcha
        if solve_doubao_grid_captcha(page):
            return
        raise RuntimeError('DOUBAO_HUMAN_VERIFICATION_REQUIRED')
