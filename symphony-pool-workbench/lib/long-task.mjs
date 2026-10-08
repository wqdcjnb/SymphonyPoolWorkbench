export const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;
export const POLL_AFTER_SECONDS = 60;
export const recoverableErrors = new Set(['DOLA_GENERATION_TIMEOUT', 'DOUBAO_GENERATION_TIMEOUT',
  'PLATFORM_GENERATION_TIMEOUT', 'WORKER_TIMEOUT', 'WORKER_EXITED', 'WORKER_INTERRUPTED',
  'WORKER_LEASE_EXPIRED', 'WORKER_LAUNCH_FAILED', 'QUEUE_DISPATCH_ERROR', 'BROWSER_DISCONNECTED',
  'BROWSER_CLOSED', 'DOLA_PAGE_TIMEOUT', 'DOUBAO_PAGE_TIMEOUT', 'BROWSER_AUTOMATION_FAILED',
  'DOUBAO_ORIGINAL_EXPORT_TIMEOUT','DOUBAO_ORIGINAL_EXPORT_FAILED']);

export function collectionUrl(value, service) {
  if (typeof value !== 'string') return false;
  const match = /^https:\/\/www\.(dola|doubao)\.com\/chat\/[0-9]+$/.exec(value);
  return Boolean(match && (!service || match[1] === service));
}

export function reconciliationPlan(job, now = Date.now()) {
  if (!collectionUrl(job.remoteUrl) || !recoverableErrors.has(job.errorCode)) return null;
  const deadline = job.reconcileDeadlineAt || now + RECONCILE_WINDOW_MS;
  if (['DOUBAO_ORIGINAL_EXPORT_TIMEOUT','DOUBAO_ORIGINAL_EXPORT_FAILED'].includes(job.errorCode)
    && (job.reconcileAttempts || 0) >= 3) return {deadline,next:null};
  const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(job.reconcileAttempts || 0, 4));
  return { deadline, next: now >= deadline ? null : Math.min(deadline, now + delay) };
}
