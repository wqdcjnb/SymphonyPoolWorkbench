"""Exercise the login helper against local fixtures; never contact a login service."""
import unittest
from playwright.sync_api import sync_playwright
from login_assist import assist_page

PHONE = '13800000000'
HTML = '''<!doctype html><html><head><meta charset="utf-8"></head><body><div id="screen"><button onclick="method()">登录</button></div>
<script>
let sends=0,submits=0,challengeClicks=0;
function method(){screen.innerHTML='<button onclick="phone()">手机号登录</button>';}
function phone(){screen.innerHTML='<form onsubmit="send();return false"><input placeholder="请输入手机号"><input type="checkbox"><button type="submit">下一步</button></form>';}
function send(){if(!document.querySelector('input[type=checkbox]').checked)return;sends++;
screen.innerHTML='<form onsubmit="login();return false"><p>验证码已发送</p><input placeholder="验证码" autocomplete="one-time-code"><button type="submit">登录</button><button type="button" onclick="sends++">重新发送</button><p id="error"></p></form>';}
function login(){submits++;if(document.querySelector('input').value==='654321')screen.innerHTML='<textarea data-testid="chat_input"></textarea>';else document.querySelector('#error').textContent='验证码错误';}
const screen=document.querySelector('#screen');
</script></body></html>'''


class LoginAssistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.context.route('**/*', lambda route: route.fulfill(content_type='text/html', body=HTML))
        self.page = self.context.new_page()
        self.page.goto('https://www.doubao.com/chat/')

    def tearDown(self):
        self.context.close()

    def test_send_then_wrong_and_correct_code(self):
        result = assist_page(self.page, {'action': 'send_sms', 'credential': {'identifier': PHONE}})
        self.assertEqual(result['smsState'], 'awaiting_code')
        self.assertEqual(self.page.evaluate('sends'), 1)
        self.assertEqual(assist_page(self.page, {'action': 'status'})['smsState'], 'awaiting_code')
        self.assertEqual(self.page.evaluate('sends'), 1)
        result = assist_page(self.page, {'action': 'submit_code', 'code': '000000'})
        self.assertEqual(result['reason'], 'LOGIN_CODE_NOT_ACCEPTED')
        result = assist_page(self.page, {'action': 'submit_code', 'code': '654321'})
        self.assertTrue(result['authenticated'])
        self.assertEqual(self.page.evaluate('submits'), 2)

    def test_challenge_is_observed_and_never_operated(self):
        self.page.evaluate("screen.innerHTML='<div id=\"captcha_container\" onclick=\"challengeClicks++\">请完成下方验证</div>'")
        for action in ('send_sms', 'status', 'submit_code'):
            result = assist_page(self.page, {'action': action, 'code': '654321', 'credential': {'identifier': PHONE}})
            self.assertEqual(result['reason'], 'LOGIN_CHALLENGE_REQUIRED')
        self.assertEqual(self.page.evaluate('sends+challengeClicks+submits'), 0)

    def test_current_unlabelled_dialog_input_submits_automatically(self):
        self.page.set_content('''<button onclick="window.unexpected=true">登录</button>
            <div role="dialog"><p>请输入验证码</p><p>验证码已发送至测试手机号</p>
            <input type="text" inputmode="decimal" oninput="if(this.value==='654321'){document.body.innerHTML='<textarea data-testid=chat_input></textarea>'}">
            <button>重新发送</button></div>''')
        result = assist_page(self.page, {'action': 'status'})
        self.assertEqual(result['smsState'], 'awaiting_code')
        result = assist_page(self.page, {'action': 'submit_code', 'code': '654321'})
        self.assertTrue(result['authenticated'])
        self.assertFalse(self.page.evaluate('!!window.unexpected'))

    def test_code_field_alone_is_not_evidence_of_a_sent_sms(self):
        self.page.set_content('<input autocomplete="one-time-code"><p>发送失败，请稍后重试</p>')
        result = assist_page(self.page, {'action': 'status'})
        self.assertEqual(result['reason'], 'SMS_SEND_UNCONFIRMED')
        self.assertNotEqual(result['smsState'], 'awaiting_code')

    def test_login_waits_for_delayed_page_render_before_sending(self):
        self.page.evaluate("screen.innerHTML='正在加载';setTimeout(()=>screen.innerHTML='<button onclick=\"method()\">登录</button>',1200)")
        result = assist_page(self.page, {'action': 'send_sms', 'credential': {'identifier': PHONE}})
        self.assertEqual(result['smsState'], 'awaiting_code')
        self.assertEqual(self.page.evaluate('sends'), 1)

    def test_unknown_origin_or_foreign_phone_requires_manual_action(self):
        result = assist_page(self.page, {'action': 'send_sms', 'credential': {'identifier': '+14155550100'}})
        self.assertEqual(result['reason'], 'PHONE_COUNTRY_SELECTION_REQUIRED')
        self.assertEqual(self.page.evaluate('sends'), 0)
        self.page.goto('https://unrelated.invalid/')
        self.assertEqual(assist_page(self.page, {'action': 'send_sms'})['reason'], 'LOGIN_ASSIST_REQUIRES_MANUAL')


if __name__ == '__main__':
    unittest.main()
