"""Unit checks for the Doubao grid captcha solver (recognition API mocked)."""
import unittest
from unittest.mock import MagicMock, patch

import doubao_grid_captcha as grid


class ParseIndicesTests(unittest.TestCase):
    def test_valid_reply(self):
        self.assertEqual(grid.parse_indices('{"indices": [1, 5, 9]}', 9), [1, 5, 9])
        self.assertEqual(grid.parse_indices('分析如下... {"indices":[2,4]} 以上', 9), [2, 4])

    def test_rejects_bad_payloads(self):
        self.assertIsNone(grid.parse_indices('{"indices": []}', 9))
        self.assertIsNone(grid.parse_indices('{"indices": [0, 1]}', 9))
        self.assertIsNone(grid.parse_indices('{"indices": [10]}', 9))
        self.assertIsNone(grid.parse_indices('{"indices": [3, 3]}', 9))
        self.assertIsNone(grid.parse_indices('{"indices": ["3"]}', 9))
        self.assertIsNone(grid.parse_indices('没有JSON', 9))
        self.assertIsNone(grid.parse_indices('{"indices": [5]}', 4))  # 超过 2x2 上限


class CellCenterTests(unittest.TestCase):
    def test_grid_centers(self):
        box = {'x': 100.0, 'y': 50.0, 'width': 300.0, 'height': 300.0}
        self.assertEqual(grid.cell_center(box, 1, 3), (150.0, 100.0))
        self.assertEqual(grid.cell_center(box, 5, 3), (250.0, 200.0))
        self.assertEqual(grid.cell_center(box, 9, 3), (350.0, 300.0))


class ConfigTests(unittest.TestCase):
    def test_toggle_and_attempts(self):
        self.assertTrue(grid.autosolve_enabled({}))
        self.assertFalse(grid.autosolve_enabled({'WORKBENCH_DOUBAO_GRID_AUTOSOLVE': '0'}))
        self.assertEqual(grid.max_attempts({}), 2)
        self.assertEqual(grid.max_attempts({'WORKBENCH_DOUBAO_GRID_ATTEMPTS': '9'}), 4)
        self.assertEqual(grid.grid_size({}), 3)


class SolveEntryTests(unittest.TestCase):
    def test_no_captcha_returns_true(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.frames = []
        self.assertTrue(grid.solve_doubao_grid_captcha(page))

    def test_missing_api_key_falls_back(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 1
        page.frames = []
        with patch.dict('os.environ', {'WORKBENCH_ARK_API_KEY': ''}, clear=False):
            self.assertFalse(grid.solve_doubao_grid_captcha(page))

    def test_throttle_blocks_repeat_calls(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 1
        page.frames = []
        grid._solve_throttle[id(page)] = grid.time.monotonic()
        with patch.dict('os.environ', {'WORKBENCH_ARK_API_KEY': 'ark-test-key'}, clear=False):
            self.assertFalse(grid.solve_doubao_grid_captcha(page))
        grid._solve_throttle.pop(id(page), None)


class WidgetExtractionTests(unittest.TestCase):
    """Real Chromium: extract instruction + grid image, click through, pass."""

    def _page(self, p, clicks_to_pass=3):
        import cv2
        import numpy as np
        browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])
        context = browser.new_context()
        jpeg = cv2.imencode('.jpg', np.full((300, 300, 3), 200, np.uint8))[1].tobytes()
        context.route('**/*', lambda route: route.fulfill(
            status=200, content_type='text/html', body='<body></body>'))
        # Registered last so it wins over the catch-all above.
        context.route('**/grid.jpg', lambda route: route.fulfill(
            status=200, content_type='image/jpeg', body=jpeg))
        page = context.new_page()
        page.goto('https://www.doubao.com/chat/')
        page.set_content(f'''
            <div id="captcha_container" style="display:block">
              <div class="captcha-tip">请点击所有包含猫的格子</div>
              <img id="grid" src="https://cdn.example.com/grid.jpg"
                   style="width:300px;height:300px;display:block">
            </div>
            <script>
              window.__clicks = 0;
              document.getElementById('grid').addEventListener('click', () => {{
                window.__clicks += 1;
                if (window.__clicks >= {clicks_to_pass}) {{
                  document.getElementById('captcha_container').remove();
                }}
              }});
            </script>''')
        return browser, page

    def test_extract_and_solve(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser, page = self._page(p)
            try:
                widget = grid._extract_widget(page)
                self.assertIsNotNone(widget)
                instruction, image, src = widget
                self.assertEqual(instruction, '请点击所有包含猫的格子')
                self.assertIn('grid.jpg', src)
                with patch.object(grid, 'recognize', return_value=[1, 5, 9]), \
                     patch.object(grid, '_fetch_image', return_value=(b'jpeg', 'image/jpeg')):
                    # context.request bypasses route interception, so the
                    # original-image fetch is patched rather than routed.
                    self.assertTrue(grid.solve_once(page, 1))
                self.assertEqual(page.evaluate('window.__clicks'), 3)
            finally:
                browser.close()

    def test_ordered_challenge_is_refused(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser, page = self._page(p)
            try:
                page.evaluate("document.querySelector('.captcha-tip').textContent = '请依次点击数字1到9'")
                with patch.object(grid, 'recognize', return_value=[1, 2, 3]):
                    self.assertFalse(grid.solve_once(page, 1))
                self.assertEqual(page.evaluate('window.__clicks'), 0)
            finally:
                browser.close()


if __name__ == '__main__':
    unittest.main()
