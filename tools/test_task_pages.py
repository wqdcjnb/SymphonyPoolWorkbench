import json
from pathlib import Path
import tempfile
import unittest

from task_pages import (job_page, find_page, remember_page, begin_submission, finish_page,
                        state_path, assert_conversation)
from browser_runtime import SharedContext


class Page:
    def __init__(self, context, identifier):
        self.context, self.identifier = context, identifier
        self.url, self.visits = 'about:blank', []
    def goto(self, url, **options):
        self.url = url; self.visits.append(url)
    def bring_to_front(self):
        pass
    def close(self):
        self.context.pages.remove(self)
    def is_closed(self):
        return self not in self.context.pages
    def evaluate(self, script):
        return []
    def locator(self, selector):
        return type('Notices',(),{'all_text_contents':lambda self:[]})()


class Context:
    def __init__(self):
        self.pages = []; self.counter = 0
    def new_page(self):
        self.counter += 1
        page = Page(self, str(self.counter)); self.pages.append(page); return page
    def new_cdp_session(self, page):
        class Session:
            def send(self, command):
                assert command == 'Target.getTargetInfo'
                return {'targetInfo': {'targetId': page.identifier}}
            def detach(self):
                pass
        return Session()


class TaskPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.job = {'id':'job-1','profilePath':self.temp.name}
        self.context = Context()
        self.browser = type('Browser', (), {'contexts':[self.context]})()

    def test_original_target_survives_worker_cleanup_and_reconnect_before_remote_id(self):
        for service in ['doubao','dola']:
            job = {**self.job, 'id':'job-'+service}
            first = SharedContext(self.browser)
            page = job_page(first, job, service); page.goto('https://www.'+service+'.com/chat/local_123')
            begin_submission(first, page, job, service)
            disposable = first.new_page(); first.close()
            self.assertIn(page, self.context.pages); self.assertNotIn(disposable, self.context.pages)
            second = SharedContext(self.browser)
            self.assertIs(find_page(second, job, service), page)
            self.assertEqual(page.visits, ['https://www.'+service+'.com/chat/local_123'])
            with self.assertRaisesRegex(RuntimeError, 'TASK_SUBMISSION_ALREADY_STARTED'):
                job_page(second, job, service)

    def test_recollection_reuses_original_tab_without_navigation(self):
        context = SharedContext(self.browser)
        page = job_page(context, self.job, 'dola'); page.goto('https://www.dola.com/chat/123')
        remember_page(context, page, self.job, 'dola', page.url)
        job = {**self.job, 'collectExistingUrl':page.url+'?tracking=1'}
        self.assertIs(job_page(SharedContext(self.browser), job, 'dola'), page)
        self.assertEqual(len(self.context.pages),1); self.assertEqual(len(page.visits),1)

    def test_lost_target_reopens_only_the_bound_conversation(self):
        page = job_page(SharedContext(self.browser), self.job, 'doubao')
        page.goto('https://www.doubao.com/chat/123')
        remember_page(self.context, page, self.job, 'doubao', page.url); page.close()
        unrelated = self.context.new_page(); unrelated.goto('https://www.doubao.com/chat/456')
        restored = find_page(SharedContext(self.browser), self.job, 'doubao')
        self.assertIsNot(restored, unrelated)
        self.assertEqual(restored.visits,['https://www.doubao.com/chat/123'])
        self.assertEqual(unrelated.visits,['https://www.doubao.com/chat/456'])

    def test_lost_unacknowledged_submission_never_opens_a_new_chat(self):
        page = job_page(SharedContext(self.browser), self.job, 'dola')
        begin_submission(self.context,page,self.job,'dola');page.close()
        with self.assertRaisesRegex(RuntimeError,'TASK_ORIGINAL_PAGE_LOST'):
            find_page(self.context,self.job,'dola')
        self.assertEqual(self.context.pages,[])

    def test_another_conversation_cannot_replace_the_bound_task(self):
        page=job_page(SharedContext(self.browser),self.job,'dola');page.goto('https://www.dola.com/chat/123')
        remember_page(self.context,page,self.job,'dola',page.url)
        page.goto('https://www.dola.com/chat/456')
        with self.assertRaisesRegex(RuntimeError,'TASK_CONVERSATION_CHANGED'):
            find_page(self.context,self.job,'dola')
        with self.assertRaisesRegex(RuntimeError,'TASK_CONVERSATION_CHANGED'):
            assert_conversation(page,{**self.job,'remoteUrl':'https://www.dola.com/chat/123'},'dola')
        self.assertEqual(page.url,'https://www.dola.com/chat/456')

    def test_uncertain_old_pages_are_preserved_when_a_new_conversation_starts(self):
        context=SharedContext(self.browser)
        manual=context.new_page();manual.goto('https://www.dola.com/chat/900')
        page=job_page(context,self.job,'dola');page.goto('https://www.dola.com/chat/123')
        finish_page(context,page,{**self.job,'remoteUrl':page.url},'dola')
        self.assertIn(page,self.context.pages)
        next_page=job_page(context,{**self.job,'id':'job-2'},'dola')
        self.assertIn(page,self.context.pages);self.assertIn(manual,self.context.pages)
        self.assertIn(next_page,self.context.pages)

    def test_job_ids_cannot_escape_metadata_directory_and_state_is_not_shared(self):
        job={**self.job,'id':'../../another'}
        page=job_page(SharedContext(self.browser),job,'dola')
        self.assertEqual(state_path(job).parent,Path(self.temp.name)/'.symphony-task-pages')
        data=json.loads(state_path(job).read_text());data['jobId']='different'
        state_path(job).write_text(json.dumps(data))
        with self.assertRaisesRegex(RuntimeError,'TASK_PAGE_STATE_INVALID'):
            find_page(self.context,job,'dola')


if __name__ == '__main__':
    unittest.main()
