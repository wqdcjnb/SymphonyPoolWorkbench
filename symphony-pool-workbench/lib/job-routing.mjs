import { compareAccountPriority } from '../public/js/account-quality.js';
import { VIDEO_CATALOG, VIDEO_RATIOS, videoModel } from "../public/js/video-policy.js";
export const AUTO_SELECTION = "auto";
export const DOLA_LONG_MODEL = "Dreamina Seedance 2.5";

export const VIDEO_MODELS = Object.freeze({
  doubao: ["Seedance 2.0 Fast", "Seedance 2.0 Mini"],
  dola: [DOLA_LONG_MODEL],
});

export const VIDEO_DURATIONS = Object.freeze({
  doubao: [15],
  dola: [30],
});

export const VIDEO_IMAGE_LIMITS = Object.freeze({ doubao: 9, dola: 9 });
export const VIDEO_ASPECT_RATIOS = Object.freeze(VIDEO_RATIOS);
export const REFERENCE_VIDEO_MODEL = "Seedance 2.0 Fast";

export const ALL_VIDEO_MODELS = [AUTO_SELECTION, ...Object.values(VIDEO_MODELS).flat()];
export const ALL_VIDEO_DURATIONS = [...new Set(VIDEO_CATALOG.map(item => item.duration))];

function modelSupportsParameters(service, model, durationSeconds, imageCount, aspectRatio) {
  const spec = videoModel(model);
  return spec?.service === service && durationSeconds === spec.duration
    && imageCount <= spec.maxImages && spec.ratios.includes(aspectRatio);
}

export function serviceSupports(service, model, durationSeconds, imageCount = 0, aspectRatio = "9:16",
  mode = "image_to_video") {
  const referenceMode = mode === "reference_to_video";
  return Boolean(VIDEO_DURATIONS[service]?.includes(durationSeconds)
    && VIDEO_ASPECT_RATIOS.includes(aspectRatio)
    && (mode === "image_to_video" || referenceMode)
    && imageCount >= 0 && imageCount <= VIDEO_IMAGE_LIMITS[service]
    && (!referenceMode || service === "doubao")
    && (aspectRatio === "auto" || aspectRatio === "9:16" || service === "doubao" || service === "dola")
    && (referenceMode ? model === AUTO_SELECTION || model === REFERENCE_VIDEO_MODEL
      : model === AUTO_SELECTION
        ? VIDEO_MODELS[service]?.some((candidate) => modelSupportsParameters(
          service, candidate, durationSeconds, imageCount, aspectRatio))
        : modelSupportsParameters(service, model, durationSeconds, imageCount, aspectRatio)));
}

export function hasCompatibleService(accountService, model, durationSeconds, imageCount = 0,
  aspectRatio = "9:16", mode = "image_to_video") {
  const services = accountService ? [accountService] : Object.keys(VIDEO_MODELS);
  return services.some((service) => serviceSupports(service, model, durationSeconds, imageCount, aspectRatio, mode));
}

function verifiedModel(job, account) {
  return job.model === AUTO_SELECTION
    ? (job.mode === 'reference_to_video' ? [REFERENCE_VIDEO_MODEL] : VIDEO_MODELS[account.service] || [])
      .find(name => account.models.includes(name) && modelSupportsParameters(account.service, name,
        job.durationSeconds, job.referenceAssets?.length ?? 0, job.aspectRatio || '9:16'))
    : account.models.includes(job.model) ? job.model : null;
}

const hasGenerationQuota = (account, model) => Number.isInteger(account.freeVideosRemaining)
  ? account.freeVideosRemaining > 0
  : Number.isInteger(account.creditsRemaining) && account.creditsRemaining >= (videoModel(model)?.credits || 0);

// Explain a blocked queue using the same requirements as selection. This never
// changes eligibility or reserves a slot, and leaves routing error contracts intact.
export function videoTargetBlocker(job, accounts) {
  const candidates = accounts.filter(account => (!job.accountId || job.accountId === AUTO_SELECTION || account.id === job.accountId)
    && serviceSupports(account.service, job.model, job.durationSeconds, job.referenceAssets?.length ?? 0,
      job.aspectRatio || '9:16', job.mode || 'image_to_video'));
  if (!candidates.length) return 'NO_COMPATIBLE_ACCOUNT';
  const ready = candidates.filter(a => a.status === 'ready' && !a.needsAttention);
  const verified = ready.map(account => ({account, model:verifiedModel(job, account)})).filter(a => a.model);
  const funded = verified.filter(({account, model}) => hasGenerationQuota(account, model));
  if (funded.length) return funded.every(a => a.account.busy) ? 'ACCOUNT_ALREADY_RUNNING' : null;
  if (candidates.some(a => /HUMAN_VERIFICATION|CAPTCHA/.test(a.attentionReason || a.lastErrorCode || ''))) return 'ACCOUNTS_VERIFICATION_REQUIRED';
  if (candidates.some(a => a.status === 'auth_required' || /LOGIN_REQUIRED|LOGIN_EXPIRED/.test(a.attentionReason || a.lastErrorCode || ''))) return 'ACCOUNTS_LOGIN_REQUIRED';
  if (candidates.every(a => a.freeVideosRemaining === 0)) return 'ACCOUNT_DAILY_VIDEO_LIMIT';
  if (verified.length) return 'ACCOUNT_CREDITS_INSUFFICIENT';
  if (!ready.length) return 'ACCOUNTS_NOT_READY';
  return 'MODEL_NOT_VERIFIED_FOR_ACCOUNT';
}

export function resolveVideoTarget(job, accounts) {
  const mode = job.mode || "image_to_video";
  const imageCount = job.referenceAssets?.length ?? 0;
  const explicit = job.accountId && job.accountId !== AUTO_SELECTION;
  const requested = explicit ? accounts.filter((account) => account.id === job.accountId) : accounts;
  if (explicit && !requested.length) throw new Error("ACCOUNT_NOT_FOUND");
  // Collecting a previously submitted task does not create a new generation or charge.
  if (job.collectOnly) {
    const account = explicit ? requested[0] : null;
    if (!account || (account.status !== "ready" || account.needsAttention)) throw new Error("ACCOUNT_NOT_READY");
    if (account.busy) throw new Error("ACCOUNT_ALREADY_RUNNING");
    return { account, model: job.model };
  }
  if (!hasCompatibleService(explicit ? requested[0].service : null, job.model, job.durationSeconds,
    imageCount, job.aspectRatio || "9:16", mode)) {
    throw new Error("JOB_PARAMETERS_INVALID");
  }

  const eligible = requested.flatMap((account) => {
    if (!serviceSupports(account.service, job.model, job.durationSeconds, imageCount, job.aspectRatio || "9:16", mode)) return [];
    if ((account.status !== "ready" || account.needsAttention) || account.busy) return [];
    const model = verifiedModel(job, account);
    if (!hasGenerationQuota(account, model)) return [];
    return model && account.models.includes(model) ? [{ account, model }] : [];
  });

  if (!eligible.length) {
    if (explicit && (requested[0].status !== "ready" || requested[0].needsAttention)) throw new Error("ACCOUNT_NOT_READY");
    if (explicit && requested[0].busy) throw new Error("ACCOUNT_ALREADY_RUNNING");
    if (explicit && !requested[0].models.some((model) => VIDEO_MODELS[requested[0].service]?.includes(model))) {
      throw new Error("MODEL_NOT_VERIFIED_FOR_ACCOUNT");
    }
    throw new Error("NO_ELIGIBLE_ACCOUNT");
  }

  // Proven stability first, then available daily credits within the same tier.
  eligible.sort((left, right) => compareAccountPriority(left.account, right.account));
  return eligible[0];
}
