import tempfile
import unittest
from pathlib import Path
from runpy import run_path
from unittest.mock import MagicMock,patch
from test_task_pages import Context
from task_pages import read_state
import dola_video

class ContextRestartTests(unittest.TestCase):
    def test_context_limit_restarts_once_but_unknown_errors_and_accepted_jobs_never_resubmit(self):
        worker=run_path(str(Path(__file__).with_name('run-image-to-video.py')))
        for service in ['doubao','dola']:
            for scenario in ['context','network','accepted','collect']:
                with self.subTest(service=service,scenario=scenario),tempfile.TemporaryDirectory() as profile:
                    context=Context();job={'id':'test','profilePath':profile,'prompt':'new video'}
                    code='BROWSER_AUTOMATION_FAILED' if scenario=='network' else 'CONVERSATION_CONTEXT_LIMIT'
                    if scenario=='accepted':job['generationAcknowledged']=True
                    if scenario=='collect':job['collectExistingUrl']='https://www.'+service+'.com/chat/123'
                    execute=MagicMock(side_effect=RuntimeError(code));emit=MagicMock()
                    if service=='doubao':
                        with patch.dict(worker['run_doubao'].__globals__,{'_run_doubao_page':execute,'emit':emit}):
                            with self.assertRaisesRegex(RuntimeError,code):worker['run_doubao'](context,job,Path(profile)/'result.mp4')
                    else:
                        with patch.object(dola_video,'execute_dola',execute):
                            with self.assertRaisesRegex(RuntimeError,code):dola_video.run_dola(context,job,Path(profile)/'result.mp4',emit)
                    self.assertEqual(execute.call_count,2 if scenario=='context' else 1)
                    self.assertEqual(len(context.pages),2 if scenario=='context' else 1)
                    self.assertEqual(read_state(job,service).get('contextRestarts',0),1 if scenario=='context' else 0)
                    self.assertEqual(emit.call_count,1 if scenario=='context' else 0)

if __name__=='__main__':unittest.main()
