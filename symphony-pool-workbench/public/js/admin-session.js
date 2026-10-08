export function redirectToAdminLogin() {
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?reason=expired&next=${encodeURIComponent(next)}`);
}

async function showAdminSession() {
  if (window.location.protocol !== 'https:') return;
  try {
    const response = await fetch('/auth/session', { cache: 'no-store' });
    if (response.status === 401) return redirectToAdminLogin();
    if (!response.ok) return;
    const session = await response.json();
    if (!session.authenticated || typeof session.username !== 'string') return;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet'; stylesheet.href = '/admin-session.css'; document.head.append(stylesheet);
    const element = document.createElement('div'); element.className = 'admin-session';
    const user = document.createElement('span'); user.className = 'admin-session-user'; user.textContent = session.username;
    const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出登录';
    logout.addEventListener('click', async () => {
      logout.disabled = true; logout.textContent = '正在退出…';
      try {
        const result = await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!result.ok) throw new Error();
        window.location.replace('/login');
      } catch { logout.disabled = false; logout.textContent = '退出失败，点击重试'; }
    });
    element.append(user, logout);
    const actions = document.querySelector('.top-actions');
    const poolHeader = document.querySelector('.pool-page > header');
    if (actions) actions.prepend(element);
    else if (poolHeader) poolHeader.prepend(element);
    else document.querySelector('main')?.prepend(element);
    const localLabel = document.querySelector('.local-card strong');
    const localDetail = document.querySelector('.local-card small');
    if (localLabel && localDetail) { localLabel.textContent = '云端工作台'; localDetail.textContent = '已登录 · ' + session.username; }
  } catch { /* A temporary session lookup failure must not interrupt active work. */ }
}
showAdminSession();
