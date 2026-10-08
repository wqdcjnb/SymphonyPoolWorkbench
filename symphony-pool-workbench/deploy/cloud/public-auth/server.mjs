import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const derive = promisify(scrypt);
const cookieName = '__Host-symphony_session';
const hash = value => createHash('sha256').update(value).digest('hex');
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const assetsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const assets = new Map([
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/auth-assets/login.css', ['login.css', 'text/css; charset=utf-8']],
  ['/auth-assets/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/auth-assets/mark.svg', ['mark.svg', 'image/svg+xml']],
]);

export async function makeCredential(username, password) {
  const salt = randomBytes(24).toString('hex');
  return { version: 1, username, salt, verifier: (await derive(password, salt, 64, scryptOptions)).toString('hex') };
}

export function safeReturnTo(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')
      || value.startsWith('//') || /[\\\x00-\x20]/.test(value)) return '/pool';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || /^\/(?:login|auth|auth-assets)(?:\/|$)/.test(url.pathname)) return '/pool';
    return url.pathname + url.search;
  } catch { return '/pool'; }
}

export function createAuthServer({ credential, origin, databasePath, port = 8791, now = Date.now,
  sessionHours = 8, rememberDays = 7, attemptLimit = 10, attemptWindowMs = 15 * 60_000 }) {
  if (credential?.version !== 1 || !/^[a-f0-9]{48}$/.test(credential.salt)
      || !/^[a-f0-9]{128}$/.test(credential.verifier) || !/^[\w.-]{1,80}$/.test(credential.username)) {
    throw new Error('Invalid administrator credential file');
  }
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('HTTPS origin required');
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL, credential TEXT NOT NULL)');
  const fingerprint = hash(JSON.stringify(credential));
  db.prepare('DELETE FROM sessions WHERE credential != ? OR expires <= ?').run(fingerprint, now());
  const expected = Buffer.from(credential.verifier, 'hex');
  const attempts = new Map();
  let verifying = 0;

  function session(request) {
    const cookies = String(request.headers.cookie || '').split(';').map(part => part.trim())
      .filter(part => part.startsWith(cookieName + '='));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(cookieName.length + 1);
    if (!/^[\w-]{43}$/.test(token)) return null;
    const digest = hash(token);
    const row = db.prepare('SELECT * FROM sessions WHERE digest = ? AND credential = ? AND expires > ?').get(digest, fingerprint, now());
    return row || null;
  }
  function headers(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  function redirect(response, location) { response.writeHead(303, { Location: location }); response.end(); }
  function setCookie(response, token, maxAge) {
    response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`);
  }
  async function body(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new Error('INVALID_BODY');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) throw new Error('INVALID_BODY');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new Error('INVALID_BODY'); }
  }
  function permittedAttempt(ip) {
    const time = now();
    // Also bounds the map if a large number of clients arrive.
    for (const [key, entry] of attempts) if (entry.until <= time) attempts.delete(key);
    if (!attempts.has(ip)) {
      if (attempts.size >= 5000) return 60;
      attempts.set(ip, { count: 0, until: time + attemptWindowMs });
    }
    const entry = attempts.get(ip);
    if (entry.count >= attemptLimit) return Math.max(1, Math.ceil((entry.until - time) / 1000));
    entry.count++;
    return 0;
  }
  const server = http.createServer({ maxHeaderSize: 16_384 }, async (request, response) => {
    headers(response);
    try {
      const url = new URL(request.url, origin);
      const current = session(request);
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
      if (request.method === 'GET' && assets.has(url.pathname)) {
        if (url.pathname === '/login' && current) return redirect(response, safeReturnTo(url.searchParams.get('next'), origin));
        const [name, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        return response.end(fs.readFileSync(path.join(assetsRoot, name)));
      }
      if (request.method === 'GET' && url.pathname === '/auth/session') {
        return json(response, current ? 200 : 401, current
          ? { authenticated: true, username: current.username, expiresAt: current.expires }
          : { authenticated: false, error: 'ADMIN_LOGIN_REQUIRED' });
      }
      if (request.method === 'GET' && url.pathname === '/auth/verify') {
        if (current) { response.writeHead(204); return response.end(); }
        const original = String(request.headers['x-forwarded-uri'] || '/pool');
        const method = request.headers['x-forwarded-method'] || 'GET';
        const html = String(request.headers.accept || '').includes('text/html');
        if ((method === 'GET' || method === 'HEAD') && html && !/^\/(?:api|v1)(?:\/|$)/.test(original)) {
          return redirect(response, '/login?next=' + encodeURIComponent(safeReturnTo(original, origin)));
        }
        return json(response, 401, { error: 'ADMIN_LOGIN_REQUIRED' });
      }
      if (request.method === 'POST' && ['/auth/login', '/auth/logout'].includes(url.pathname)) {
        if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
          return json(response, 403, { error: 'INVALID_ORIGIN' });
        }
        const input = await body(request);
        if (url.pathname === '/auth/logout') {
          if (current) db.prepare('DELETE FROM sessions WHERE digest = ?').run(current.digest);
          setCookie(response, '', 0);
          return json(response, 200, { ok: true });
        }
        if (typeof input.username !== 'string' || input.username.length > 80 || typeof input.password !== 'string'
            || !input.password.length || Buffer.byteLength(input.password) > 512) {
          return json(response, 400, { error: 'INVALID_CREDENTIAL_INPUT' });
        }
        const suppliedIp = request.headers['x-real-ip'];
        const ip = typeof suppliedIp === 'string' && isIP(suppliedIp) ? suppliedIp : 'unknown';
        const retry = permittedAttempt(ip);
        if (retry || verifying >= 4) {
          response.setHeader('Retry-After', String(retry || 5));
          return json(response, 429, { error: 'TOO_MANY_ATTEMPTS', retryAfter: retry || 5 });
        }
        verifying++;
        let matches;
        try {
          const actual = await derive(input.password, credential.salt, 64, scryptOptions);
          matches = timingSafeEqual(expected, actual) && input.username.trim() === credential.username;
        } finally { verifying--; }
        if (!matches) return json(response, 401, { error: 'INVALID_CREDENTIALS' });
        attempts.delete(ip);
        if (current) db.prepare('DELETE FROM sessions WHERE digest = ?').run(current.digest);
        const time = now();
        const lifetime = input.remember === true ? rememberDays * 86400 : sessionHours * 3600;
        const token = randomBytes(32).toString('base64url');
        db.prepare('DELETE FROM sessions WHERE expires <= ?').run(time);
        db.exec('DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions ORDER BY created DESC LIMIT -1 OFFSET 199)');
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(hash(token), credential.username, time + lifetime * 1000, time, fingerprint);
        setCookie(response, token, input.remember === true ? lifetime : undefined);
        return json(response, 200, { ok: true, redirect: safeReturnTo(input.next, origin) });
      }
      return json(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (!response.headersSent) json(response, error.message === 'INVALID_BODY' ? 400 : 500,
        { error: error.message === 'INVALID_BODY' ? 'INVALID_BODY' : 'AUTH_UNAVAILABLE' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const app = createAuthServer({
    credential: JSON.parse(fs.readFileSync(process.env.AUTH_CREDENTIAL_FILE, 'utf8')),
    databasePath: process.env.AUTH_DATABASE_FILE || '/auth-data/sessions.sqlite',
    origin: process.env.AUTH_PUBLIC_ORIGIN,
    port: Number(process.env.AUTH_PORT || 8791),
  });
  await app.listen();
  console.log('Administrator sign-in service ready.');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
