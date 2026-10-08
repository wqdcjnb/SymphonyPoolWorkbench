import unittest
from unittest.mock import MagicMock, patch
from doubao_chat import uses_chat_entry, confirm_chat_video
from doubao_parameters import chat_confirmation_text


class DoubaoChatTests(unittest.TestCase):
    job = {'model':'Seedance 2.0 Fast','durationSeconds':15,'aspectRatio':'9:16',
           'mode':'image_to_video','referenceAssets':['a','b','c','d','e']}

    def test_chat_entry_applies_only_to_supported_image_jobs(self):
        for count in [1,5,9]:
            self.assertTrue(uses_chat_entry({**self.job,'referenceAssets':['a']*count}))
        for changed in [{'referenceAssets':[]},{'referenceAssets':['a']*10},
                        {'mode':'reference_to_video'},{'model':'Seedance 2.0 Mini'},
                        {'durationSeconds':30}]:
            self.assertFalse(uses_chat_entry({**self.job,**changed}))

    def test_confirmation_claim_precedes_click_and_survives_a_click_failure(self):
        state = {}
        context, page = MagicMock(), MagicMock()
        def save(*args, **kwargs): state.update(kwargs['details'])
        def click():
            self.assertTrue(state['chatConfirmationStarted'])
            raise RuntimeError('CLICK_INTERRUPTED')
        page.locator.return_value.click.side_effect = click
        with patch('doubao_chat.read_state', side_effect=lambda *a:dict(state)), \
                patch('doubao_chat.remember_page', side_effect=save), \
                patch('doubao_chat.assert_conversation'), patch('doubao_chat.check_human_verification'), \
                patch('doubao_chat.select_chat_model'):
            with self.assertRaisesRegex(RuntimeError,'CLICK_INTERRUPTED'):
                confirm_chat_video(context,page,self.job)
            with self.assertRaisesRegex(RuntimeError,'DOUBAO_CONFIRMATION_UNCONFIRMED'):
                confirm_chat_video(context,page,self.job)
        page.locator.return_value.click.assert_called_once()
        page.locator.return_value.first.fill.assert_called_once_with(chat_confirmation_text(self.job))
        page.goto.assert_not_called()
        page.close.assert_not_called()


if __name__ == '__main__': unittest.main()
