"""Regression checks for Dola recovery and pre-submission validation."""
import json
import tempfile
import unittest
from pathlib import Path
from runpy import run_path
from unittest.mock import MagicMock, patch
import dola_video as dola


class DolaTests(unittest.TestCase):
    def test_confirmation_proposal_is_not_generation_and_later_ack_supersedes_it(self):
        proposal = ('仅补充确认：当前可生成 4–15 秒视频；建议先做 15 秒竖版。'
                    '\n请确认是否按以下参数直接生成：\n比例：9:16\n时长：15 秒\n确认后我直接生成。')
        ack = ('我将为您生成一条 9:16 的竖版视频，时长为 15 秒。'
               'The video will be generated using the Dreamina Seedance 2.5 model. '
               'It will use 2 credits and be ready in 2 hours.')
        self.assertIsNone(dola.generation_phase([proposal]))
        self.assertEqual(dola.generation_phase([proposal, ack]), 'generating')
        self.assertEqual(dola.generation_phase([proposal, 'Your video is ready.']), 'ready')
        self.assertIsNone(dola.generation_phase([ack, proposal]))
        for seconds, expected in [(30, 'parameters'), (15, None)]:
            page = MagicMock()
            page.locator.return_value.count.return_value = 0
            page.locator.return_value.all_text_contents.side_effect = [[proposal], []]
            self.assertEqual(dola.response_state(page, {'durationSeconds': seconds, 'aspectRatio':'9:16'}), expected)
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.all_text_contents.side_effect = [[proposal, ack], []]
        self.assertIsNone(dola.response_state(page, {'durationSeconds':30}))

    def test_unconfirmed_message_never_emits_generation_or_confirms_a_proposal(self):
        page, emit = MagicMock(), MagicMock()
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.last.count.return_value = 0
        with patch.object(dola, 'response_state', return_value=None), \
             patch.object(dola, 'assistant_texts', return_value=['Here is your prompt.']), \
             patch.object(dola.time, 'monotonic', side_effect=[0, 1, 91]), \
             self.assertRaisesRegex(RuntimeError, 'DOLA_SUBMISSION_UNCONFIRMED'):
            dola.save_video(MagicMock(), page, Path('output.mp4'), emit)
        emit.assert_not_called()
        page.locator.return_value.last.click.assert_not_called()
        page.get_by_role.assert_not_called()
        with patch.object(dola, 'response_state', return_value='parameters'), \
             self.assertRaisesRegex(RuntimeError, 'PLATFORM_PARAMETERS_MISMATCH'):
            dola.save_video(MagicMock(), page, Path('output.mp4'), emit)
        emit.assert_not_called()
        page.wait_for_timeout.assert_not_called()

    def test_generation_stage_waits_for_actual_ack_and_is_emitted_once(self):
        page, emit = MagicMock(), MagicMock()
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.last.count.return_value = 0
        # Three polls: no reply, explicit acknowledgement, same reply again.
        with patch.object(dola, 'response_state', return_value=None), \
             patch.object(dola, 'assistant_texts', side_effect=[[], ['The video will be generated.'], ['The video will be generated.']]), \
             patch.object(dola.time, 'monotonic', side_effect=[0, 1, 2, 3, 4, 5, 6, 7, 601]), \
             self.assertRaisesRegex(RuntimeError, 'DOLA_GENERATION_TIMEOUT'):
            dola.save_video(MagicMock(), page, Path('output.mp4'), emit)
        self.assertEqual([call.args[0] for call in emit.call_args_list], ['generating'])
        self.assertEqual(page.wait_for_timeout.call_count, 3)

    def test_duration_rejection_is_not_misreported_as_a_running_video(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.all_text_contents.return_value = [
            '30 seconds is outside the currently supported range. I can generate this video at the nearest supported duration of 15 seconds. Would you like me to proceed?']
        self.assertEqual(dola.response_state(page), 'failed')
        with self.assertRaisesRegex(RuntimeError, 'PLATFORM_GENERATION_FAILED'):
            dola.save_video(MagicMock(), page, Path('output.mp4'), MagicMock(), job={'durationSeconds':30})
        page.locator.return_value.click.assert_not_called()

    def test_old_duration_rejection_does_not_override_a_later_video_response(self):
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.all_text_contents.side_effect = [
            ['30 seconds is outside the currently supported range.', 'Your video is being generated.'], []]
        self.assertIsNone(dola.response_state(page))

    def test_range_and_alternative_are_compared_with_requested_duration(self):
        text = 'Video generation currently supports durations from 4 to 15 seconds. I can generate it at the nearest supported duration of 15 seconds. Would you like me to proceed?'
        for seconds, expected in [(30, 'failed'), (15, None)]:
            page = MagicMock()
            page.locator.return_value.count.return_value = 0
            page.locator.return_value.all_text_contents.side_effect = [[text], []]
            self.assertEqual(dola.response_state(page, {'durationSeconds':seconds}), expected)

    def test_collect_only_requires_original_task_before_validation_or_browser_launch(self):
        validate = run_path(str(Path(__file__).with_name('run-image-to-video.py')))['verify_job']
        for service in ['doubao', 'dola']:
            with self.subTest(service=service), self.assertRaisesRegex(RuntimeError, 'COLLECTION_REMOTE_URL_REQUIRED'):
                validate({'service': service, 'collectOnly': True})

    def test_automatic_collection_uses_a_short_wait_without_changing_generation_timeout(self):
        job = {'model': dola.DOLA_LONG_MODEL, 'collectExistingUrl': 'https://www.dola.com/chat/123', 'collectionCheckSeconds': 90}
        self.assertEqual(dola.generation_timeout(job), 90)
        self.assertEqual(dola.generation_timeout({'model': dola.DOLA_LONG_MODEL}), 4200)
        worker = run_path(str(Path(__file__).with_name('run-image-to-video.py')))
        page = MagicMock()
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.all_text_contents.return_value = ['视频生成好后会通知你']
        page.url = 'https://www.doubao.com/chat/123'
        for logged_out in [False, True]:
            page.get_by_role.return_value.is_visible.return_value = logged_out
            with patch.object(worker['time'], 'monotonic', side_effect=[0, 89, 91]), \
                    self.assertRaisesRegex(RuntimeError, 'LOGIN_EXPIRED_DURING_SUBMISSION' if logged_out else 'DOUBAO_GENERATION_TIMEOUT'):
                worker['save_doubao_video'](MagicMock(), page, Path('output.mp4'), timeout_seconds=90)

    def test_collection_repairs_before_success_and_never_serves_raw_on_failure(self):
        context, page, emit = MagicMock(), MagicMock(), MagicMock()
        page.locator.return_value.count.return_value = 1
        page.locator.return_value.last.evaluate.return_value = 'https://www.dola.com/video.mp4'
        job = {'aspectRatio':'16:9', 'durationSeconds':30}
        output = Path('output.mp4')
        for failure in [False, True]:
            emit.reset_mock()
            with patch.object(dola, 'response_state', return_value=None), \
                 patch.object(dola, 'download_video') as download, \
                 patch.object(dola, 'repair_video', side_effect=RuntimeError('WATERMARK_REPAIR_UNCONFIRMED') if failure else None) as repair:
                if failure:
                    with self.assertRaisesRegex(RuntimeError, 'WATERMARK_REPAIR_UNCONFIRMED'):
                        dola.save_video(context, page, output, emit, job=job)
                    self.assertEqual([c.args[0] for c in emit.call_args_list], ['collecting'])
                else:
                    dola.save_video(context, page, output, emit, job=job)
                    self.assertEqual(emit.call_args_list[-1].args, ('success',))
                repair.assert_called_once_with(output.with_suffix('.original.mp4'), output, '16:9', 30)
                download.assert_called_once()

    def test_doubao_collection_does_not_wait_on_an_unconfirmed_request(self):
        worker = run_path(str(Path(__file__).with_name('run-image-to-video.py')))
        page = MagicMock()
        page.url = 'https://www.doubao.com/chat/123'
        page.get_by_role.return_value.is_visible.return_value = False
        page.locator.return_value.count.return_value = 0
        page.locator.return_value.all_text_contents.return_value = [
            '视频生成参数确认\n模型：Seedance 2.0 Fast\n时长：10 秒\n比例：9:16\n确认后我再开始生成视频。']
        with self.assertRaisesRegex(RuntimeError, 'DOUBAO_CONFIRMATION_REQUIRED'):
            worker['save_doubao_video'](MagicMock(), page, Path('output.mp4'))
        page.wait_for_timeout.assert_not_called()
        page.locator.return_value.last.click.assert_not_called()

    def test_confirmation_wait_ignores_old_replies_until_the_new_reply_arrives(self):
        worker = run_path(str(Path(__file__).with_name('run-image-to-video.py')))
        page = MagicMock()
        page.url = 'https://www.doubao.com/chat/123'
        page.get_by_role.return_value.is_visible.return_value = False
        page.locator.return_value.count.return_value = 0
        prior = '视频生成参数确认\n模型：Seedance 2.0 Fast\n时长：15 秒\n比例：9:16'
        page.locator.return_value.all_text_contents.side_effect = [[prior], [prior, ''], [prior, '视频生成好后会通知你']]
        self.assertEqual(worker['wait_for_doubao_response'](page, after_assistant_count=1), 'auto')
        self.assertEqual(page.wait_for_timeout.call_count, 2)

    def test_task_url_rejects_foreign_and_ambiguous_destinations(self):
        self.assertEqual(dola.task_url('https://www.dola.com/chat/1234?tracking=test'), 'https://www.dola.com/chat/1234')
        for url in ['http://www.dola.com/chat/123', 'https://evil.test/chat/123', 'https://www.dola.com.evil.test/chat/123',
                    'https://www.dola.com:8443/chat/123', 'https://user@www.dola.com/chat/123', 'https://www.dola.com/chat/local_123', 'https://www.dola.com/chat/']:
            with self.subTest(url=url), self.assertRaisesRegex(RuntimeError, 'INVALID_REMOTE_URL'):
                dola.task_url(url)

    def test_recollection_does_not_upload_or_submit_again(self):
        context = MagicMock()
        context.new_page.return_value.url='https://www.dola.com/chat/123'
        context.new_page.return_value.locator.return_value.count.return_value = 0
        context.new_page.return_value.evaluate.return_value = [{'id':'101','role':'user','text':'test clip'}]
        with patch.object(dola, 'open_composer') as composer, patch.object(dola, 'save_video') as collect:
            dola.run_dola(context, {'collectExistingUrl': 'https://www.dola.com/chat/123', 'prompt': 'test clip'}, Path('output.mp4'), MagicMock())
            composer.assert_not_called()
            collect.assert_called_once()
            context.new_page.return_value.goto.assert_called_once_with('https://www.dola.com/chat/123', wait_until='domcontentloaded', timeout=60000)

    def test_wrong_model_duration_and_reference_video_are_rejected_before_selection(self):
        base = {'model': dola.DOLA_LONG_MODEL, 'durationSeconds': 30, 'aspectRatio': '9:16', 'mode': 'image_to_video', 'referenceAssets': []}
        for invalid in [{'model': dola.DOLA_MODEL}, {'durationSeconds': 12}, {'durationSeconds': 15},
                        {'mode': 'reference_to_video'}, {'referenceAssets': ['x'] * 10}]:
            with patch.object(dola, 'select_model') as select, self.assertRaisesRegex(RuntimeError, 'INVALID_JOB_PARAMETERS'):
                dola.configure(MagicMock(), MagicMock(), {**base, **invalid})
            select.assert_not_called()

    def test_extended_duration_patch_changes_only_duration_configs(self):
        payload = {'selector': json.dumps({'label': 'Duration', 'option_list': [
            {'option_key': '5', 'display_text': '5s'},
            {'option_key': '10', 'display_text': '10s', 'is_default': True}]})}
        unrelated = {'label': 'Resolution', 'options': [{'value': '5'}, {'value': '10'}]}
        capabilities = {'supported_durations': ['5', '10']}
        config = {'payload': payload, 'unrelated': unrelated, 'capabilities': capabilities}
        self.assertTrue(dola._patch_duration(config, 30))
        duration = json.loads(payload['selector'])
        self.assertEqual([item['option_key'] for item in duration['option_list']], ['5', '10', '30'])
        self.assertFalse(duration['option_list'][-1]['is_default'])
        self.assertEqual(capabilities['supported_durations'], ['5', '10', '30'])
        self.assertEqual(len(unrelated['options']), 2)
        self.assertFalse(dola._patch_duration(config, 30))

    def test_long_model_rejects_unsupported_durations_ratios_and_images(self):
        base = {'model': dola.DOLA_LONG_MODEL, 'durationSeconds': 30, 'aspectRatio': '16:9',
                'mode': 'image_to_video', 'referenceAssets': []}
        for invalid in [{'durationSeconds': 10}, {'aspectRatio': '2:1'}, {'aspectRatio': 'auto'},
                        {'referenceAssets': ['image.png'] * 10}, {'mode': 'reference_to_video'}]:
            with patch.object(dola, 'select_model') as select, self.assertRaisesRegex(RuntimeError, 'INVALID_JOB_PARAMETERS'):
                dola.configure(MagicMock(), MagicMock(), {**base, **invalid})
            select.assert_not_called()
        self.assertEqual(dola.generation_timeout(base), 4200)

    def test_long_model_accepts_reference_images_with_all_delivery_ratios(self):
        for ratio in dola.DOLA_RATIOS:
            for count in [0, 1, 9]:
                page, composer = MagicMock(), MagicMock()
                duration, ratio_control = MagicMock(), MagicMock()
                duration.count.return_value = 1
                duration.inner_text.return_value = '30s'
                ratio_control.count.return_value = 1
                ratio_control.inner_text.return_value = ratio
                composer.locator.side_effect = lambda selector: duration if 'duration' in selector else ratio_control
                job = {'model': dola.DOLA_LONG_MODEL, 'durationSeconds': 30, 'aspectRatio': ratio,
                       'mode': 'image_to_video', 'referenceAssets': ['image.png'] * count}
                with patch.object(dola, 'select_model') as select:
                    dola.configure(page, composer, job)
                    select.assert_called_once_with(page, composer, dola.DOLA_LONG_MODEL)

    def test_worker_validation_accepts_dola_images_and_requires_existing_files(self):
        validate = run_path(str(Path(__file__).with_name('run-image-to-video.py')))['verify_job']
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'image.png'
            image.write_bytes(b'test image')
            job = {'service': 'dola', 'model': dola.DOLA_LONG_MODEL, 'mode': 'image_to_video',
                   'durationSeconds': 30, 'aspectRatio': '9:16', 'referenceAssets': [str(image)] * 9}
            validate(job)
            for service, model, duration in [('dola', dola.DOLA_LONG_MODEL, 30),
                                            ('doubao', 'Seedance 2.0 Mini', 15)]:
                for ratio in dola.DOLA_RATIOS:
                    validate({**job, 'service': service, 'model': model, 'durationSeconds': duration, 'aspectRatio': ratio})
                with self.assertRaisesRegex(RuntimeError, 'INVALID_JOB_PARAMETERS'):
                    validate({**job, 'service': service, 'model': model, 'durationSeconds': duration, 'aspectRatio': 'auto'})
            with self.assertRaisesRegex(RuntimeError, 'INVALID_JOB_PARAMETERS'):
                validate({**job, 'referenceAssets': [str(image)] * 10})
            with self.assertRaisesRegex(RuntimeError, 'REFERENCE_IMAGE_NOT_FOUND'):
                validate({**job, 'referenceAssets': [str(image.with_name('missing.png'))]})

    def test_missing_ratio_control_fails_before_submission(self):
        page, composer = MagicMock(), MagicMock()
        duration, ratio = MagicMock(), MagicMock()
        duration.count.return_value = 1
        duration.inner_text.return_value = '30s'
        ratio.count.return_value = 0
        composer.locator.side_effect = lambda selector: duration if 'duration' in selector else ratio
        with patch.object(dola, 'select_model'), self.assertRaisesRegex(RuntimeError, 'ASPECT_RATIO_SELECTION_FAILED'):
            dola.configure(page, composer, {'model': dola.DOLA_LONG_MODEL, 'durationSeconds': 30,
                           'aspectRatio': '1:1', 'mode': 'image_to_video', 'referenceAssets': []})

    def test_combined_panel_selects_every_fixed_ratio(self):
        for ratio in dola.DOLA_RATIOS:
            page, composer, parameters = MagicMock(), MagicMock(), MagicMock()
            composer.locator.return_value.count.return_value = 0
            composer.get_by_role.return_value = parameters
            page.get_by_role.return_value.count.return_value = 1
            label = 'Auto' if ratio == 'auto' else ratio
            parameters.inner_text.return_value = label+' · 30s'
            with patch.object(dola,'select_model'):
                dola.configure(page,composer,{'model':dola.DOLA_LONG_MODEL,'durationSeconds':30,
                    'aspectRatio':ratio,'mode':'image_to_video','referenceAssets':[]})
            page.get_by_text.assert_called_once_with(label,exact=True)
            page.get_by_text.return_value.last.click.assert_called_once()

    def test_image_upload_must_finish_before_a_single_submission(self):
        job = {'model': dola.DOLA_LONG_MODEL, 'durationSeconds': 30, 'aspectRatio': '9:16',
               'mode': 'image_to_video', 'referenceAssets': ['first.png', 'second.png'],
               'prompt': '30s animate the reference, Seedance 2.0 Fast', 'negativePrompt': 'logos'}
        for failed in [False, True]:
            page, composer, context, emit = MagicMock(), MagicMock(), MagicMock(), MagicMock()
            editor, submit = MagicMock(), MagicMock()
            composer.locator.side_effect = lambda selector: {'[contenteditable=true]': editor,
                '[data-testid="chat_input_send_button"]': submit}[selector]
            calls = []
            def native_composer(opened_page, **kwargs):
                self.assertEqual(kwargs['reference_assets'], job['referenceAssets'])
                calls.append(('upload', kwargs['reference_assets']))
                return composer
            def wait_ready(script, **kw):
                if 'expected' in script:
                    self.assertEqual(kw['arg'], 2)
                    if failed:
                        raise dola.PlaywrightTimeoutError('upload timed out')
                    calls.append(('ready', 2))
            page.wait_for_function.side_effect = wait_ready
            submit.click.side_effect = lambda: calls.append(('submit', 1))
            with patch.object(dola, 'enable_extended_duration'), patch.object(dola, 'open_composer', side_effect=native_composer), \
                 patch.object(dola, 'configure') as configure, patch.object(dola, 'logged_out', return_value=False), \
                 patch.object(dola, 'install_joint_submission') as joint, \
                 patch.object(dola, 'confirm_joint_submission'), \
                 patch.object(dola, 'wait_for_submission', return_value='https://www.dola.com/chat/123'), \
                 patch.object(dola, 'save_video'):
                if failed:
                    with self.assertRaisesRegex(RuntimeError, 'DOLA_UPLOAD_FAILED'):
                        dola.execute_dola(context, page, job, Path('output.mp4'), emit)
                    submit.click.assert_not_called()
                    emit.assert_not_called()
                else:
                    dola.execute_dola(context, page, job, Path('output.mp4'), emit)
                    self.assertEqual(calls, [('upload', job['referenceAssets']), ('ready', 2), ('submit', 1)])
                    sent = editor.fill.call_args.args[0]
                    self.assertNotIn('30s', sent)
                    self.assertNotIn('2.0 Fast', sent)
                    self.assertIn('animate the reference', sent)
                    self.assertIn('Avoid: logos', sent)
                    self.assertIn(sent, joint.call_args.args)
                    configure.assert_called_once_with(page, composer, job)

    def test_native_plus_upload_uses_the_file_chooser_and_refuses_old_attachments(self):
        for old_images in [0, 1]:
            page, composer, plus, cards = MagicMock(), MagicMock(), MagicMock(), MagicMock()
            page.locator.return_value = composer
            composer.locator.side_effect = lambda selector: plus if selector == '[data-testid="upload_file_button"]' else cards
            plus.is_visible.return_value = True
            cards.count.return_value = old_images
            with patch.object(dola, 'wait_for_reference_upload') as ready:
                if old_images:
                    with self.assertRaisesRegex(RuntimeError, 'DOLA_UNEXPECTED_COMPOSER_ATTACHMENTS'):
                        dola.upload_chat_references(page, ['reference.png'])
                    page.expect_file_chooser.assert_not_called()
                    plus.click.assert_not_called()
                else:
                    dola.upload_chat_references(page, ['reference.png'])
                    plus.click.assert_called_once()
                    page.expect_file_chooser.return_value.__enter__.return_value.value.set_files.assert_called_once_with(['reference.png'])
                    ready.assert_called_once_with(page, 1)

    def test_human_challenge_preserves_the_same_page_and_does_not_retry(self):
        context=MagicMock()
        page=context.new_page.return_value
        with patch.object(dola,'execute_dola',side_effect=RuntimeError('DOLA_HUMAN_VERIFICATION_REQUIRED')) as execute:
            with self.assertRaisesRegex(RuntimeError,'DOLA_HUMAN_VERIFICATION_REQUIRED'):
                dola.run_dola(context, {}, Path('output.mp4'), MagicMock())
            execute.assert_called_once()
            context.preserve_page.assert_called_once_with(page)

    def test_recovery_refuses_a_task_with_another_prompt(self):
        context=MagicMock()
        context.new_page.return_value.url='https://www.dola.com/chat/123'
        context.new_page.return_value.locator.return_value.count.return_value=0
        context.new_page.return_value.evaluate.return_value=[{'id':'101','role':'user','text':'another prompt'}]
        with patch.object(dola.time,'monotonic',side_effect=[0,31]), patch.object(dola,'save_video') as save:
            with self.assertRaisesRegex(RuntimeError,'DOLA_TASK_MISMATCH'):
                dola.run_dola(context, {'collectExistingUrl':'https://www.dola.com/chat/123','prompt':'expected'},Path('output.mp4'),MagicMock())
            save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
