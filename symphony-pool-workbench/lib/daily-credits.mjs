import { DAILY_CREDITS, VIDEO_CATALOG, videoCreditCost } from "../public/js/video-policy.js";

export { videoCreditCost };
export const creditDay = (timestamp = Date.now()) => new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10);
export const nextCreditReset = (timestamp = Date.now()) =>
  new Date(Date.parse(`${creditDay(timestamp)}T00:00:00+08:00`) + 86_400_000).toISOString();

export function withDailyCredits(account, usage = {}, timestamp = Date.now()) {
  if (!account || !VIDEO_CATALOG.some(item => item.service === account.service)) return account;
  const today = creditDay(timestamp);
  const exhausted = account.quotaExhaustedDate === today;
  const expired = account.quotaExhaustedDate && account.quotaExhaustedDate < today;
  return { ...account,
    ...(expired && account.status === "cooling" ? { status: "degraded", lastErrorCode: null } : {}),
    creditsRemaining: exhausted ? 0 : Math.max(0, DAILY_CREDITS - Number(usage.used || 0)),
    creditsTotal: DAILY_CREDITS, creditsEstimated: false, creditsSource: "daily_budget",
    creditsReserved: Number(usage.reserved || 0), creditBudgetDate: today,
    creditsResetAt: nextCreditReset(timestamp),
  };
}
