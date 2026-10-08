export const loginErrors = new Set(['LOGIN_REQUIRED', 'LOGIN_EXPIRED_DURING_SUBMISSION', 'PROFILE_NOT_FOUND']);
export const challengeErrors = new Set(['DOLA_HUMAN_VERIFICATION_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED',
  'DOUBAO_HUMAN_VERIFICATION_REQUIRED', 'CAPTCHA_REQUIRED']);
export const requiresHuman = code => loginErrors.has(code) || challengeErrors.has(code);

// Content rejection, credit exhaustion, occupied profiles and server restarts are
// not evidence of an unreliable account. Only known execution faults count.
export const executionFaults = new Set(['DOLA_PAGE_TIMEOUT', 'DOUBAO_PAGE_TIMEOUT',
  'DOUBAO_RESPONSE_TIMEOUT', 'BROWSER_DISCONNECTED', 'BROWSER_CLOSED']);
