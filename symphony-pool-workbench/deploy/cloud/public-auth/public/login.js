const form = document.querySelector('#loginForm');
const message = document.querySelector('#formMessage');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const button = document.querySelector('#submitButton');
const label = document.querySelector('#submitLabel');
const toggle = document.querySelector('#togglePassword');
const parameters = new URLSearchParams(window.location.search);

function showMessage(text) { message.textContent = text; message.hidden = false; }
if (parameters.get('reason') === 'expired') showMessage('登录状态已过期，请重新登录。');
toggle.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
});
for (const field of [username, password]) field.addEventListener('input', () => {
  field.removeAttribute('aria-invalid');
  message.hidden = true;
});
for (const event of ['keydown', 'keyup']) password.addEventListener(event, event => {
  document.querySelector('#capsLock').hidden = !event.getModifierState('CapsLock');
});
password.addEventListener('blur', () => { document.querySelector('#capsLock').hidden = true; });
document.querySelector('#helpButton').addEventListener('click', event => {
  const help = document.querySelector('#passwordHelp');
  help.hidden = !help.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!help.hidden));
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  for (const field of [username, password]) {
    if (!field.value || (field === username && !field.value.trim())) {
      showMessage(field === username ? '请输入管理员账号。' : '请输入登录密码。');
      field.setAttribute('aria-invalid', 'true'); field.focus(); return;
    }
  }
  message.hidden = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  label.textContent = '正在登录…';
  try {
    const response = await fetch('/auth/login', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value,
        remember: document.querySelector('#remember').checked, next: parameters.get('next') || '/pool' }) });
    const payload = await response.json();
    if (!response.ok) {
      const errors = { INVALID_CREDENTIALS: '账号或密码不正确，请重新输入。',
        TOO_MANY_ATTEMPTS: `尝试次数较多，请 ${Math.max(1, Math.ceil((payload.retryAfter || 60) / 60))} 分钟后再试。`,
        INVALID_ORIGIN: '登录请求未通过验证，请刷新页面后重试。',
        INVALID_CREDENTIAL_INPUT: '请检查账号和密码是否填写完整。' };
      showMessage(errors[payload.error] || '暂时无法登录，请稍后再试。');
      if (payload.error === 'INVALID_CREDENTIALS') password.setAttribute('aria-invalid', 'true');
      return;
    }
    const destination = new URL(payload.redirect || '/pool', window.location.origin);
    window.location.replace(destination.origin === window.location.origin ? destination.href : '/pool');
  } catch { showMessage('连接暂时中断，请检查网络后重试。'); }
  finally {
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
    label.textContent = '登录工作台';
  }
});
