"""Unit checks for the Dola slider captcha solver (no browser required)."""
import unittest
from unittest.mock import MagicMock

import cv2
import numpy as np

import slider_captcha as captcha


def synthetic_captcha(gap_x=230, bg_size=(344, 552), piece_size=110):
    """Background with a darkened notch plus an RGBA piece of the same shape."""
    rng = np.random.default_rng(7)
    bg = rng.integers(60, 200, (*bg_size, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:piece_size, 0:piece_size]
    shape = ((xx - piece_size // 2) ** 2 + (yy - piece_size // 2) ** 2) <= (piece_size // 2 - 8) ** 2
    top = (bg_size[0] - piece_size) // 2
    notch = bg[top:top + piece_size, gap_x:gap_x + piece_size]
    darkened = (notch * 0.35).astype(np.uint8)
    notch[shape] = darkened[shape]
    piece = np.zeros((piece_size, piece_size, 4), dtype=np.uint8)
    piece[shape] = (255, 255, 255, 255)
    bg_bytes = cv2.imencode('.jpg', bg)[1].tobytes()
    piece_bytes = cv2.imencode('.png', piece)[1].tobytes()
    return bg_bytes, piece_bytes


class GapDetectionTests(unittest.TestCase):
    def test_find_gap_x_locates_synthetic_notch(self):
        bg_bytes, piece_bytes = synthetic_captcha(gap_x=230)
        gap_x, conf = captcha.find_gap_x(bg_bytes, piece_bytes)
        self.assertGreater(conf, 0)
        self.assertLessEqual(abs(gap_x - 230), 12)

    def test_find_gap_x_rejects_undecodable_input(self):
        with self.assertRaises(ValueError):
            captcha.find_gap_x(b'not an image', b'still not an image')

    def test_drag_distance_subtracts_piece_offset(self):
        # gap at 250 natural px, displayed scale 340/552, piece starts 12px in.
        scale = 340 / 552
        distance = captcha.drag_distance(250, scale, piece_left=112, bg_left=100)
        self.assertAlmostEqual(distance, 250 * scale - 12, places=6)


class TrackTests(unittest.TestCase):
    def test_human_track_reaches_target_with_bounded_jitter(self):
        for distance in (40, 137, 300):
            points = captcha.human_track(distance)
            self.assertGreaterEqual(len(points), 40)
            for _, dy, dt in points:
                self.assertGreater(dt, 0)
                self.assertLessEqual(abs(dy), 1.6)
            final_x = points[-1][0]
            self.assertLessEqual(abs(final_x - distance), 10)
            total_ms = sum(dt for _, _, dt in points)
            self.assertLess(total_ms, 4000)

    def test_human_track_is_monotone_during_main_travel(self):
        points = captcha.human_track(150)
        main = [x for x, _, _ in points[:45]]
        self.assertTrue(all(b >= a - 0.01 for a, b in zip(main, main[1:])))


class ConfigTests(unittest.TestCase):
    def test_autosolve_toggle(self):
        self.assertTrue(captcha.autosolve_enabled({}))
        self.assertFalse(captcha.autosolve_enabled({'WORKBENCH_DOLA_CAPTCHA_AUTOSOLVE': '0'}))
        self.assertTrue(captcha.autosolve_enabled({'WORKBENCH_DOLA_CAPTCHA_AUTOSOLVE': '1'}))

    def test_max_attempts_bounds(self):
        self.assertEqual(captcha.max_attempts({}), 3)
        self.assertEqual(captcha.max_attempts({'WORKBENCH_DOLA_CAPTCHA_MAX_ATTEMPTS': '9'}), 5)
        self.assertEqual(captcha.max_attempts({'WORKBENCH_DOLA_CAPTCHA_MAX_ATTEMPTS': 'x'}), 3)


class SolveLoopTests(unittest.TestCase):
    def test_no_captcha_returns_true_without_touching_frames(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.frames = []
        self.assertTrue(captcha.solve_dola_captcha(page))

    def test_disabled_autosolve_returns_false_when_captcha_visible(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 1
        page.frames = []
        with unittest.mock.patch.dict('os.environ', {'WORKBENCH_DOLA_CAPTCHA_AUTOSOLVE': '0'}):
            self.assertFalse(captcha.solve_dola_captcha(page))


class InspectRecoveryTests(unittest.TestCase):
    """inspect() must try the auto solver before pausing for a human."""

    JOB = {'prompt': 'a blue cube', 'negativePrompt': 'letters', 'durationSeconds': 30,
           'aspectRatio': '9:16', 'collectExistingUrl': 'https://www.dola.com/chat/123'}
    USER = 'Generated video: a blue cube\n\nAvoid: letters, 1:1'

    def _captcha_page(self, p):
        browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
        context = browser.new_context()
        context.route('**/*', lambda route: route.fulfill(
            status=200, content_type='text/html', body='<body></body>'))
        page = context.new_page()
        page.goto('https://www.dola.com/chat/123')
        page.set_content('<div id="captcha_container">captcha</div>'
                         '<div data-message-role="user"><div data-testid="message_content" '
                         'data-message-id="101">' + self.USER + '</div></div>')
        return browser, context, page

    def test_unsolved_challenge_still_pauses_for_operator(self):
        import inspect_dola_task as inspect_mod
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser, context, page = self._captcha_page(p)
            try:
                with unittest.mock.patch.object(inspect_mod, 'solve_dola_captcha', return_value=False):
                    with self.assertRaisesRegex(RuntimeError, 'DOLA_HUMAN_VERIFICATION_REQUIRED'):
                        inspect_mod.inspect(context, dict(self.JOB))
            finally:
                browser.close()

    def test_solved_challenge_lets_inspection_continue(self):
        import inspect_dola_task as inspect_mod
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser, context, page = self._captcha_page(p)
            try:
                def solve(target):
                    target.evaluate("document.getElementById('captcha_container').remove()")
                    return True
                with unittest.mock.patch.object(inspect_mod, 'solve_dola_captcha', side_effect=solve):
                    # Past the human gate; no matching assistant video exists,
                    # so the ordinary "not found" outcome proves the solve path.
                    with self.assertRaisesRegex(RuntimeError, 'DOLA_EXISTING_TASK_NOT_FOUND'):
                        inspect_mod.inspect(context, dict(self.JOB))
            finally:
                browser.close()


if __name__ == '__main__':
    unittest.main()
