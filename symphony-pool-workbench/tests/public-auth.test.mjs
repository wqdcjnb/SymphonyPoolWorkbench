import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthServer, makeCredential, safeReturnTo } from '../deploy/cloud/public-auth/server.mjs';

const origin = 'https://192.0.2.10';
const password = 'only-a-disposable-test-password';
const credential = await makeCredential('admin', password);
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-auth-test-'));
  let app = createAuthServer({ credential, origin, port: 0, databasePath: path.join(directory, 'sessions.sqlite'), ...options });
  let port = await app.listen();
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    request: (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual', ...options }),
    async restart(extra = {}) {
      await app.close();
      app = createAuthServer({ credential, origin, port: 0, databasePath: path.join(directory, 'sessions.sqlite'), ...options, ...extra });
      port = await app.listen();
    },
  };
}
const post = (body, cookie, source = origin) => ({ method: 'POST', headers: {
  'Content-Type': 'application/json', ...(source ? { Origin: source } : {}), ...(cookie ? { Cookie: cookie } : {}),
}, body: JSON.stringify(body) });

test('normal sign-in protects APIs, persists a secure session and revokes it on logout', async t => {
  const app = await fixture(t);
  const login = await app.request('/login');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /欢迎回来/);
  assert.equal(login.headers.has('www-authenticate'), false);
  const unauth = await app.request('/auth/verify', { headers: { Accept: 'text/html', 'X-Forwarded-Uri': '/pool' } });
  assert.equal(unauth.status, 303);
  assert.equal(unauth.headers.get('location'), '/login?next=%2Fpool');
  assert.equal((await app.request('/auth/verify', { headers: { Accept:'text/html', 'X-Forwarded-Uri':'/api/pool' } })).status, 401);
  assert.equal((await app.request('/auth/login', post({username:'admin',password:'wrong'}))).status, 401);
  const success = await app.request('/auth/login', post({username:'admin',password,remember:true,next:'/jobs?page=2'}));
  assert.equal(success.status, 200);
  assert.equal((await success.json()).redirect, '/jobs?page=2');
  const setCookie = success.headers.get('set-cookie');
  for (const attribute of ['__Host-symphony_session=', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=604800']) assert.ok(setCookie.includes(attribute), attribute);
  const cookie = cookieOf(success);
  const authenticated = { headers: { Cookie: cookie } };
  assert.equal((await app.request('/auth/verify', authenticated)).status, 204);
  await app.restart();
  assert.equal((await app.request('/auth/verify', authenticated)).status, 204);
  const session = await app.request('/auth/session', authenticated);
  assert.equal((await session.json()).username, 'admin');
  assert.equal((await app.request('/auth/logout', post({},cookie,'https://attacker.invalid'))).status, 403);
  assert.equal((await app.request('/auth/verify', authenticated)).status, 204);
  const logout = await app.request('/auth/logout', post({},cookie));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.request('/auth/verify', authenticated)).status, 401);
});

test('expired, fabricated and pre-rotation sessions cannot authorize requests', async t => {
  let time = Date.now();
  const app = await fixture(t, { now: () => time });
  const success = await app.request('/auth/login', post({username:'admin',password}));
  assert.doesNotMatch(success.headers.get('set-cookie'), /Max-Age=/);
  const cookie = cookieOf(success);
  assert.equal((await app.request('/auth/verify', { headers: { Cookie: '__Host-symphony_session=' + 'a'.repeat(43) } })).status, 401);
  time += 8 * 3600_000 + 1;
  assert.equal((await app.request('/auth/verify', { headers: { Cookie: cookie } })).status, 401);
  const fresh = cookieOf(await app.request('/auth/login', post({username:'admin',password})));
  await app.restart({ credential: await makeCredential('admin', 'new-disposable-password') });
  assert.equal((await app.request('/auth/verify', { headers: { Cookie: fresh } })).status, 401);
});

test('login requires same-origin JSON and throttles password guessing', async t => {
  const app = await fixture(t, { attemptLimit: 2 });
  for (const source of [null,'https://attacker.invalid']) {
    assert.equal((await app.request('/auth/login', post({username:'admin',password},null,source))).status, 403);
  }
  const form = { method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=admin' };
  assert.equal((await app.request('/auth/login', form)).status, 400);
  for (let i=0;i<2;i++) assert.equal((await app.request('/auth/login', post({username:'admin',password:'wrong'}))).status, 401);
  const limited = await app.request('/auth/login', post({username:'admin',password:'wrong'}));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await app.request('/auth/verify', {headers:{Authorization:'Basic YWRtaW46YW55'}})).status, 401);
});

test('return destinations cannot redirect users outside the workbench or into login loops', () => {
  for (const value of ['https://attacker.invalid', '//attacker.invalid', '/\\attacker.invalid', '/login', '/auth/logout', '/pool\r\nLocation: evil', null]) {
    assert.equal(safeReturnTo(value, origin), '/pool');
  }
  assert.equal(safeReturnTo('/accounts/a/login?ready=1', origin), '/accounts/a/login?ready=1');
});
