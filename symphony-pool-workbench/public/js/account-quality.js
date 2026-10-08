// Shared by dispatch and account screens. Verification never resets this history.
export function qualityTier(account) {
  const score = account.reliabilityScore ?? 80;
  if (score >= 90 && account.videoSuccessCount >= 3) return 3;
  if (score >= 80) return 2;
  return score >= 60 ? 1 : 0;
}

export function qualityLabel(account) {
  return ['低优先级', '观察中', account.videoSuccessCount ? '稳定' : '待积累', '优质'][qualityTier(account)];
}

export function compareAccountPriority(left, right) {
  return qualityTier(right) - qualityTier(left)
    || (right.freeVideosRemaining ?? -1) - (left.freeVideosRemaining ?? -1)
    || (right.creditsRemaining ?? -1) - (left.creditsRemaining ?? -1)
    || (right.reliabilityScore ?? 80) - (left.reliabilityScore ?? 80)
    || (left.lastUsedAt || 0) - (right.lastUsedAt || 0)
    || left.id.localeCompare(right.id);
}
