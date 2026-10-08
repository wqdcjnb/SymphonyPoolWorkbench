"""Exercise the native picker and prevent image loss during mode changes."""
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from playwright.sync_api import sync_playwright
from doubao_upload import open_video_composer, wait_for_image_attachments
from doubao_chat import open_chat_composer

FIXTURE = '''<meta charset="utf-8"><div data-testid="chat_input">
<div data-testid="attachment_area"></div>
<button data-testid="upload_file_button" onclick="events.push('plus');menu.hidden=false">+</button>
<div id="menu" hidden><button onclick="events.push('picker');picker.click()">上传文件或图片</button></div>
<input id="picker" type="file" multiple hidden>
<div id="mode"></div><div contenteditable="true"></div>
<button data-testid="chat_input_send_button" onclick="events.push('send')">发送</button></div>
<script>
window.events=[];
function chat(){mode.innerHTML='<button id="video">视频生成</button>';document.querySelector('[data-testid=upload_file_button]').hidden=false;video.onclick=()=>{
  events.push('video');if(window.loseImages)document.querySelector('[data-testid=attachment_area]').innerHTML='';
  mode.innerHTML='<div data-testid="skill_input_exit_button">视频生成</div><div data-input-engine-actionbar-render-entry-key="video-generation-params-panel">9:16 · 10s</div>';
  document.querySelector('[data-testid=upload_file_button]').hidden=true;
  document.querySelector('[data-testid=skill_input_exit_button]').onclick=()=>{events.push('exit');chat()};
}}
picker.onchange=()=>{events.push('files:'+picker.files.length);menu.hidden=true;
  const area=document.querySelector('[data-testid=attachment_area]');area.setAttribute('aria-busy','true');
  area.innerHTML=[...picker.files].map(f=>'<div data-testid="attachment-image-card">'+f.name+'</div>').join('');
  setTimeout(()=>{events.push('uploaded');area.removeAttribute('aria-busy')},120);
};chat();
</script>'''


class DoubaoUploadBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='chrome',headless=True,args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context=self.browser.new_context()
        self.context.route('**/*',lambda route:route.fulfill(content_type='text/html',body=FIXTURE))
        self.page=self.context.new_page()
        self.temp=tempfile.TemporaryDirectory()
        self.images=[str(Path(self.temp.name)/name) for name in ('reference-a.png','reference-b.png')]
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=')
        for name in self.images:Path(name).write_bytes(png)
        self.job={'mode':'image_to_video','referenceAssets':self.images}

    def tearDown(self):
        self.context.close()
        self.temp.cleanup()

    def test_picker_finishes_both_images_before_switching_without_sending(self):
        open_video_composer(self.page,self.job)
        self.assertEqual(self.page.evaluate('events'),['plus','picker','files:2','uploaded','video'])
        self.assertEqual(self.page.locator('[data-testid=attachment-image-card]').all_text_contents(),['reference-a.png','reference-b.png'])
        self.assertEqual(self.page.url,'https://www.doubao.com/chat/')

    def test_chat_entry_keeps_multiple_attachments_without_selecting_video_panel(self):
        self.page.goto('https://www.doubao.com/chat/123')
        self.page.evaluate('''() => {
          document.querySelector('[data-testid=chat_input]').insertAdjacentHTML('beforeend',
            '<button data-testid="chat_input_action_model" id="chatModel">豆包 快速</button><button id="expert" hidden>专家</button>');
          chatModel.onclick=()=>{events.push('model');expert.hidden=false};
          expert.onclick=()=>{events.push('expert');chatModel.innerText='豆包 2.1 Turbo';expert.hidden=true};
        }''')
        open_chat_composer(self.page,{**self.job,'reuseConversation':True})
        self.assertEqual(self.page.evaluate('events'),['model','expert','plus','picker','files:2','uploaded'])
        self.assertEqual(self.page.locator('[data-testid=attachment-image-card]').count(),2)
        self.assertEqual(self.page.locator('[data-input-engine-actionbar-render-entry-key]').count(),0)

    def test_reused_video_composer_exits_to_plus_without_reloading_history(self):
        self.page.goto('https://www.doubao.com/chat/123')
        self.page.evaluate('window.historyMarker="original"; video.click();events=[]')
        open_video_composer(self.page,{**self.job,'reuseConversation':True})
        self.assertEqual(self.page.evaluate('historyMarker'),'original')
        self.assertEqual(self.page.evaluate('events'),['exit','plus','picker','files:2','uploaded','video'])

    def test_visible_plus_before_hydration_retries_menu_without_duplicate_files(self):
        self.page.goto('https://www.doubao.com/chat/123')
        self.page.evaluate('''() => {
          const plus=document.querySelector('[data-testid=upload_file_button]');
          plus.onclick=()=>{events.push('unbound');plus.onclick=()=>{events.push('plus');menu.hidden=false}};
        }''')
        open_video_composer(self.page,{**self.job,'reuseConversation':True})
        self.assertEqual(self.page.evaluate('events'),['unbound','plus','picker','files:2','uploaded','video'])

    def test_stale_attachments_stop_before_the_file_picker(self):
        self.page.goto('https://www.doubao.com/chat/123')
        self.page.evaluate('document.querySelector("[data-testid=attachment_area]").innerHTML="<div data-testid=attachment-image-card>old</div>"')
        with self.assertRaisesRegex(RuntimeError,'MULTIMODAL_ATTACHMENTS_MISMATCH'):
            open_video_composer(self.page,{**self.job,'reuseConversation':True})
        self.assertEqual(self.page.evaluate('events'),[])

    def test_lost_image_on_mode_switch_fails_before_any_message_is_sent(self):
        self.page.goto('https://www.doubao.com/chat/123')
        self.page.evaluate('window.loseImages=true')
        wait=self.page.wait_for_function
        with patch.object(self.page,'wait_for_function',side_effect=lambda script,**kw:wait(script,**{**kw,'timeout':1500})):
            with self.assertRaisesRegex(RuntimeError,'DOUBAO_UPLOAD_FAILED'):
                open_video_composer(self.page,{**self.job,'reuseConversation':True})
        self.assertNotIn('send',self.page.evaluate('events'))


if __name__=='__main__':unittest.main()
