import {createHash} from 'node:crypto';
import {parseCookies} from './secret-vault.mjs';

export const loginMethod = platform => platform === 'dola' ? 'cookie' : platform === 'doubao' ? 'phone_sms' : 'manual';
export function normalizePhone(value) {
  if(typeof value !== 'string') throw new Error('PHONE_NUMBER_REQUIRED');
  const phone=value.trim().replace(/[\s()-]/g,'');
  if(!/^\+?[0-9]{7,15}$/.test(phone)) throw new Error('PHONE_NUMBER_INVALID');
  return phone;
}
export function cookieFingerprint(cookies) {
  const session=cookies?.find(c=>c.name==='sessionid'&&c.value)?.value
    ||cookies?.find(c=>c.name==='sessionid_ss'&&c.value)?.value;
  return session ? createHash('sha256').update(session).digest('hex').slice(0,12) : null;
}
export function identitySummary(platform,credential) {
  const method=loginMethod(platform),fingerprint=cookieFingerprint(credential?.cookies);
  let identifier=null;
  if(method==='phone_sms'&&credential?.identifier){try{identifier=normalizePhone(credential.identifier);}catch{}}
  return {loginMethod:method,identifier,cookieFingerprint:method==='cookie'?fingerprint:null,
    cookieCount:method==='cookie'?(credential?.cookies?.length||0):0,
    recoverable:method==='cookie'?Boolean(fingerprint):Boolean(identifier),
    source:credential?.source||null,savedAt:credential?.savedAt||null};
}
export function loginCredential(platform,input,previous={}) {
  const method=loginMethod(platform);
  if(input.source!==undefined&&(typeof input.source!=='string'||input.source.length>160||/[\r\n\x00]/.test(input.source)))throw new Error('LOGIN_SOURCE_INVALID');
  const source=input.source?.trim()||previous?.source||'手动保存';
  if(method==='cookie') {
    if(input.identifier||input.password)throw new Error('LOGIN_METHOD_MISMATCH');
    const cookies=input.cookies?parseCookies(input.cookies,platform):previous?.cookies;
    if(!cookieFingerprint(cookies))throw new Error('DOLA_SESSION_COOKIE_REQUIRED');
    return {cookies,source};
  }
  if(method==='phone_sms') {
    if(input.cookies||input.password)throw new Error('LOGIN_METHOD_MISMATCH');
    return {identifier:normalizePhone(input.identifier||previous?.identifier),source};
  }
  throw new Error('INVALID_LOGIN_TYPE');
}
