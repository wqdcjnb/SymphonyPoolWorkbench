import unittest
from unittest.mock import MagicMock, patch

from doubao_duration import select_base_duration, confirm_duration_submission, verify_result_duration


class DoubaoDurationTests(unittest.TestCase):
    def test_ui_selection_stays_within_the_free_slider_range(self):
        page = MagicMock()
        slider = page.get_by_role.return_value.first
        slider.get_attribute.side_effect = lambda key: {'aria-valuemin': '0', 'aria-valuemax': '11', 'aria-valuenow': '6'}[key]
        select_base_duration(page)
        self.assertEqual([c.args[0] for c in slider.press.call_args_list], ['Home'] + ['ArrowRight'] * 6)

    def test_changed_slider_or_wrong_selection_is_rejected(self):
        for minimum, maximum, current in [('4', '15', '10'), ('0', '5', '5'), ('0', '11', '4')]:
            page = MagicMock()
            page.get_by_role.return_value.first.get_attribute.side_effect = lambda key: {
                'aria-valuemin': minimum, 'aria-valuemax': maximum, 'aria-valuenow': current}[key]
            with self.assertRaisesRegex(RuntimeError, 'DURATION_SELECTION_FAILED'):
                select_base_duration(page)

    def test_initial_and_followup_requests_are_observed(self):
        page = MagicMock()
        page.evaluate.return_value = {'patched': 1, 'confirmations': 0, 'duration': 15, 'error': None}
        self.assertEqual(confirm_duration_submission(page), 1)
        page.evaluate.return_value = {'patched': 1, 'confirmations': 1, 'duration': 15, 'error': None}
        self.assertEqual(confirm_duration_submission(page, previous_count=1), 2)

    def test_guard_errors_and_missing_guard_are_not_success(self):
        page = MagicMock()
        page.evaluate.return_value = {'error': 'DOUBAO_DURATION_PARAMETERS_MISSING'}
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_DURATION_PARAMETERS_MISSING'):
            confirm_duration_submission(page)
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_DURATION_SUBMISSION_UNCONFIRMED'):
            confirm_duration_submission(page, timeout=0)

    @patch('doubao_duration.video_info')
    def test_ten_second_result_cannot_be_delivered_as_fifteen(self, info):
        info.return_value = {'duration': 10.0}
        with self.assertRaisesRegex(RuntimeError, 'VIDEO_DURATION_MISMATCH'):
            verify_result_duration('original.mp4', 15)
        for duration in [15, 15.04, 14.96]:
            info.return_value = {'duration': duration}
            verify_result_duration('original.mp4', 15)


if __name__ == '__main__':
    unittest.main()
