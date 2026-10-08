import tempfile
import unittest
from pathlib import Path
from runpy import run_path
from unittest.mock import patch,MagicMock
from playwright.sync_api import sync_playwright
from browser_runtime import SharedContext
from task_pages import job_page,remember_page,begin_submission,finish_page,read_state
from task_messages import bind_message,scoped_rows,scoped_locator,check_context_limit
import dola_video

def message(identifier,role,text,video=None):
    media='' if video is None else f'<div class="block-video-result" onclick="window.selectedVideo=\'{video}\'"><video preload="none" src="https://media.invalid/{video}.mp4"></video></div>'
    return f'<div data-message-role="{role}"><div data-testid="message_content" data-message-id="{identifier}">{text}</div>{media}</div>'

class TaskMessageTests(unittest.TestCase):
    def test_moved_original_upload_placeholder_does_not_hide_generation_or_quota_reply(self):
        from doubao_parameters import chat_confirmation_text
        job={'id':'chat-image','profilePath':'unused','remoteMessageId':'101','prompt':'family scene',
             'model':'Seedance 2.0 Fast','aspectRatio':'9:16','durationSeconds':15,'referenceAssets':['a']*5}
        rows=[{'id':'101','role':'user','text':'family scene'},
              {'id':'102','role':'assistant','text':'视频生成参数确认'},
              {'id':'','localId':'original-upload','role':'user','text':'','images':5},
              {'id':'103','role':'user','text':chat_confirmation_text(job)},
              {'id':'104','role':'assistant','text':'今日视频生成免费次数用完了'}]
        page=MagicMock();page.evaluate.return_value={'accepted':1,'originalMessages':2,'messages':1,
            'images':5,'textPresent':True,'attachmentMessageIds':['original-upload']}
        with patch('task_messages.read_state',return_value={}):
            self.assertEqual([r['id'] for r in scoped_rows(page,job,'doubao',rows)],['101','102','103','104'])
            for changed in [dict(rows[2],localId='new-upload'),dict(rows[2],id='105')]:
                actual=scoped_rows(page,job,'doubao',[*rows[:2],changed,*rows[3:]])
                self.assertEqual([r['id'] for r in actual],['101','102'])
            self.assertEqual([r['id'] for r in scoped_rows(page,job,'doubao',
                [rows[0],dict(rows[2],localId='new-upload'),*rows[3:]])],['101'])

    def test_joint_upload_placeholder_does_not_hide_the_reply_but_real_messages_still_bound_it(self):
        job={'id':'native-image','profilePath':'unused','remoteMessageId':'101','prompt':'a blue cube',
             'aspectRatio':'9:16','durationSeconds':15,'referenceAssets':['image.png']}
        rows=[{'id':'101','role':'user','text':'a blue cube'},
              {'id':'','role':'user','text':'','images':1},
              {'id':'102','role':'assistant','text':'video parameter confirmation'},
              {'id':'103','role':'user','text':'生成视频：确认生成，9:16，10s'},
              {'id':'104','role':'assistant','text':'video generating'}]
        page=MagicMock();page.evaluate.return_value={'accepted':1,'originalMessages':2,'messages':1,'images':1,'textPresent':True}
        with patch('task_messages.read_state',return_value={}):
            self.assertEqual([r['id'] for r in scoped_rows(page,job,'doubao',rows)],['101','102','103','104'])
            for changed in [dict(rows[1],id='105'),dict(rows[1],text='another prompt'),dict(rows[1],images=2)]:
                self.assertEqual([r['id'] for r in scoped_rows(page,job,'doubao',[rows[0],changed,*rows[2:]])],['101'])
            page.evaluate.return_value=None
            self.assertEqual([r['id'] for r in scoped_rows(page,job,'doubao',rows)],['101'])
            page.evaluate.return_value={'accepted':1,'originalMessages':2,'messages':1,'images':1,'textPresent':True}
            # A later image-only user turn is separate even without its ID yet.
            later=[rows[0],rows[2],rows[1],rows[4]]
            self.assertEqual([r['id'] for r in scoped_rows(page,job,'doubao',later)],['101','102'])

    def test_auto_reuse_is_scoped_to_the_new_message_even_with_identical_prompts(self):
        with tempfile.TemporaryDirectory() as profile,sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True,args=['--no-sandbox'])
            try:
                for service in ['doubao','dola']:
                    context=browser.new_context()
                    context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<div data-testid="chat_input"><button>Model 2.5</button></div><button data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"></button>'))
                    wrapper=SharedContext(type('B',(),{'contexts':[context]})())
                    first={'id':'first-'+service,'profilePath':profile,'prompt':'a blue cube','remoteUrl':'https://www.'+service+'.com/chat/123'}
                    page=job_page(wrapper,first,service)
                    page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',message('101','user','a blue cube')+message('102','assistant','你的视频生成好了。','old'))
                    remember_page(wrapper,page,first,service,first['remoteUrl'])
                    finish_page(wrapper,page,first,service)
                    self.assertEqual(read_state(first,service)['remoteMessageId'],'101')
                    second={'id':'second-'+service,'profilePath':profile,'prompt':'a blue cube','aspectRatio':'9:16'}
                    self.assertIs(job_page(wrapper,second,service),page)
                    self.assertEqual(second['reuseConversation'],first['remoteUrl'])
                    begin_submission(wrapper,page,second,service)
                    page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',message('201','user','a blue cube'))
                    self.assertTrue(bind_message(wrapper,page,second,service))
                    self.assertEqual(second['remoteMessageId'],'201')
                    self.assertEqual(scoped_locator(page,second,service,'video').count(),0)
                    self.assertEqual([r['id'] for r in scoped_rows(page,second,service)],['201'])
                    # Old failed replies and user-authored error words must not
                    # trigger another generation in a new conversation.
                    page.locator('[data-message-id="102"]').evaluate('e=>e.innerText="上下文过长"')
                    check_context_limit(page,second,service)
                    page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',message('203','assistant','此对话上下文过长，请新开对话'))
                    with self.assertRaisesRegex(RuntimeError,'CONVERSATION_CONTEXT_LIMIT'):
                        check_context_limit(page,second,service)
                    page.locator('[data-message-id="203"]').locator('..').evaluate('e=>e.remove()')
                    page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',message('202','assistant','你的视频生成好了。','new'))
                    self.assertEqual(scoped_locator(page,second,service,'video').count(),1)
                    self.assertEqual(scoped_locator(page,second,service,'video').get_attribute('src'),'https://media.invalid/new.mp4')
                    # Recollecting the first job must remain bounded by the next
                    # prompt, even after this account reused the same chat.
                    self.assertEqual(scoped_locator(page,first,service,'video').get_attribute('src'),'https://media.invalid/old.mp4')
                    if service=='doubao':
                        worker=run_path(str(Path(__file__).with_name('run-image-to-video.py')))
                        with patch.dict(worker['save_doubao_video'].__globals__,{'export_original':MagicMock(),'emit':MagicMock()}):
                            worker['save_doubao_video'](wrapper,page,Path(profile)/'video.mp4',job=second)
                            self.assertEqual(page.evaluate('window.selectedVideo'),'new')
                    else:
                        with patch.object(dola_video,'download_video') as download,patch.object(dola_video,'repair_video'):
                            dola_video.save_video(wrapper,page,Path(profile)/'video.mp4',MagicMock(),job=second,timeout=1)
                            self.assertEqual(download.call_args.args[1],'https://media.invalid/new.mp4')
                    context.close()
            finally:browser.close()

    def test_mixed_unknown_or_pending_conversations_fall_back_without_navigation_or_submission(self):
        with tempfile.TemporaryDirectory() as profile,sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True,args=['--no-sandbox'])
            try:
                for scenario in ['mixed','unknown','pending','missing_ids']:
                    context=browser.new_context()
                    context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<button data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"></button>'))
                    wrapper=SharedContext(type('B',(),{'contexts':[context]})())
                    first={'id':scenario+'-first','profilePath':profile,'prompt':'a blue cube','remoteUrl':'https://www.doubao.com/chat/'+str(len(scenario))}
                    page=job_page(wrapper,first,'doubao')
                    page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',message('101','user','a blue cube')+message('102','assistant','你的视频生成好了。','old'))
                    if scenario!='unknown':finish_page(wrapper,page,first,'doubao')
                    if scenario=='mixed':page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',message('103','user','What is the weather?'))
                    if scenario=='pending':remember_page(wrapper,page,{**first,'id':scenario+'-running'},'doubao',first['remoteUrl'],submitting=True)
                    if scenario=='missing_ids':page.locator('[data-message-id="102"]').evaluate('e=>e.removeAttribute("data-message-id")')
                    requests=[];page.on('request',lambda request:requests.append(request.url))
                    new={'id':scenario+'-next','profilePath':profile,'prompt':'new video'}
                    chosen=job_page(wrapper,new,'doubao')
                    self.assertIsNot(chosen,page);self.assertEqual(chosen.url,'about:blank')
                    self.assertEqual(page.url,first['remoteUrl']);self.assertFalse(page.is_closed())
                    self.assertNotIn('reuseConversation',new);self.assertEqual(requests,[])
                    context.close()
            finally:browser.close()

if __name__=='__main__':unittest.main()
