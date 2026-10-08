import unittest
from unittest.mock import MagicMock
from joint_submission import install_joint_submission, confirm_joint_submission


class JointSubmissionTests(unittest.TestCase):
    def test_guard_wraps_the_initialized_platform_transport_and_skips_text_only(self):
        page = MagicMock()
        install_joint_submission(page, {'service': 'dola', 'referenceAssets': ['a.png']}, 'complete prompt')
        source = page.evaluate.call_args.args[0]
        self.assertIn('complete prompt', source)
        self.assertIn('"images": 1', source)
        self.assertIn('XMLHttpRequest', source)
        page.add_init_script.assert_not_called()
        page.reset_mock()
        install_joint_submission(page, {'service': 'dola', 'referenceAssets': []}, 'text only')
        page.evaluate.assert_not_called()

    def test_failure_is_specific_and_never_reported_as_success(self):
        page = MagicMock()
        page.evaluate.return_value = {'accepted': 0, 'error': 'MULTIMODAL_PROMPT_MISSING'}
        with self.assertRaisesRegex(RuntimeError, 'MULTIMODAL_PROMPT_MISSING'):
            confirm_joint_submission(page, {'service': 'dola', 'referenceAssets': ['a.png']})
        page.evaluate.return_value = {'accepted': 1, 'messages': 1, 'textPresent': True}
        result = confirm_joint_submission(page, {'service': 'dola', 'referenceAssets': ['a.png']})
        self.assertEqual(result['messages'], 1)

    def test_challenge_remains_for_the_human_and_no_resubmission_is_attempted(self):
        page = MagicMock()
        page.evaluate.return_value = {'accepted': 0, 'error': None}
        page.locator.return_value.count.return_value = 1
        with self.assertRaisesRegex(RuntimeError, 'DOLA_HUMAN_VERIFICATION_REQUIRED'):
            confirm_joint_submission(page, {'service': 'dola', 'referenceAssets': ['a.png']})
        page.locator.return_value.click.assert_not_called()


if __name__ == '__main__':
    unittest.main()
