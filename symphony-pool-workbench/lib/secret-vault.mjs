import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function secretVault(keyFile) {
  let key;
  const getKey = () => {
    if (!key) {
      if (!keyFile) throw new Error('POOL_KEY_FILE_REQUIRED');
      key = fs.readFileSync(keyFile);
      if (key.length !== 32) throw new Error('POOL_KEY_FILE_INVALID');
    }
    return key;
  };
  return {
    seal(value, scope) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', getKey(), iv);
      cipher.setAAD(Buffer.from(scope));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64')).join('.');
    },
    open(value, scope) {
      if (!value) return null;
      try {
        const [iv, tag, ciphertext] = value.split('.').map(v => Buffer.from(v, 'base64'));
        const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
        decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      } catch { throw new Error('CREDENTIAL_DECRYPT_FAILED'); }
    },
  };
}

export function parseCookies(input, platform) {
  const domains = { dola: 'www.dola.com', doubao: 'www.doubao.com', tiktok: 'ads.tiktok.com' };
  const domain = domains[platform];
  if (!domain || typeof input !== 'string' || input.length > 64_000) throw new Error('INVALID_COOKIE_INPUT');
  const cookies = input.trim().split(';').filter(s => s.trim()).map(pair => {
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (index < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\x00]/.test(value)) throw new Error('INVALID_COOKIE_INPUT');
    return { name, value, url: `https://${domain}/`, secure: true, httpOnly: /^(sessionid|sessionid_ss|sid_tt|oauth_token|oauth_token_v2)$/.test(name), sameSite: 'Lax' };
  });
  if (!cookies.length || new Set(cookies.map(c => c.name)).size !== cookies.length) throw new Error('INVALID_COOKIE_INPUT');
  return cookies;
}
