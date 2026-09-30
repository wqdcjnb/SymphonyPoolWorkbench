export const AUTO_SELECTION = "auto";

export const VIDEO_MODELS = Object.freeze({
  doubao: ["Seedance 2.0 Fast", "Seedance 2.0 Mini"],
  symphony: ["Video 1.5 Pro"],
});

export const VIDEO_DURATIONS = Object.freeze({
  doubao: [5, 10],
  symphony: [5, 10, 12],
});

export const VIDEO_IMAGE_LIMITS = Object.freeze({ doubao: 9, symphony: 4 });
export const VIDEO_ASPECT_RATIOS = Object.freeze(["auto", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"]);
export const REFERENCE_VIDEO_MODEL = "Seedance 2.0 Fast";

export const ALL_VIDEO_MODELS = [AUTO_SELECTION, ...VIDEO_MODELS.doubao, ...VIDEO_MODELS.symphony];
export const ALL_VIDEO_DURATIONS = [5, 10, 12];

export function serviceSupports(service, model, durationSeconds, imageCount = 1, aspectRatio = "auto",
  mode = "image_to_video") {
  const referenceMode = mode === "reference_to_video";
  return Boolean(VIDEO_DURATIONS[service]?.includes(durationSeconds)
    && VIDEO_ASPECT_RATIOS.includes(aspectRatio)
    && (mode === "image_to_video" || referenceMode)
    && imageCount >= 0 && imageCount <= VIDEO_IMAGE_LIMITS[service]
    && (!referenceMode || service === "doubao")
    && (aspectRatio === "auto" || aspectRatio === "9:16" || service === "doubao")
    && (model === AUTO_SELECTION || (referenceMode
      ? model === REFERENCE_VIDEO_MODEL : VIDEO_MODELS[service]?.includes(model))));
}

export function hasCompatibleService(accountService, model, durationSeconds, imageCount = 1,
  aspectRatio = "auto", mode = "image_to_video") {
  const services = accountService ? [accountService] : Object.keys(VIDEO_MODELS);
  return services.some((service) => serviceSupports(service, model, durationSeconds, imageCount, aspectRatio, mode));
}

export function resolveVideoTarget(job, accounts) {
  const mode = job.mode || "image_to_video";
  const imageCount = job.referenceAssets?.length ?? 0;
  const explicit = job.accountId && job.accountId !== AUTO_SELECTION;
  const requested = explicit ? accounts.filter((account) => account.id === job.accountId) : accounts;
  if (explicit && !requested.length) throw new Error("ACCOUNT_NOT_FOUND");
  if (!hasCompatibleService(explicit ? requested[0].service : null, job.model, job.durationSeconds,
    imageCount, job.aspectRatio || "auto", mode)) {
    throw new Error("JOB_PARAMETERS_INVALID");
  }

  const eligible = requested.flatMap((account) => {
    if (!serviceSupports(account.service, job.model, job.durationSeconds, imageCount, job.aspectRatio || "auto", mode)) return [];
    if (account.status !== "ready" || account.busy) return [];
    // Doubao's displayed estimate is not a reliable per-task cost. Only a
    // platform-confirmed exhaustion changes the account status to cooling.
    if (account.service === "symphony" && Number.isInteger(account.creditsRemaining)
      && account.creditsRemaining < job.durationSeconds) return [];
    const model = job.model === AUTO_SELECTION
      ? (mode === "reference_to_video" ? [REFERENCE_VIDEO_MODEL] : VIDEO_MODELS[account.service])
        .find((name) => account.models.includes(name))
      : job.model;
    return model && account.models.includes(model) ? [{ account, model }] : [];
  });

  if (!eligible.length) {
    if (explicit && requested[0].status !== "ready") throw new Error("ACCOUNT_NOT_READY");
    if (explicit && requested[0].busy) throw new Error("ACCOUNT_ALREADY_RUNNING");
    if (explicit && !requested[0].models.some((model) => VIDEO_MODELS[requested[0].service]?.includes(model))) {
      throw new Error("MODEL_NOT_VERIFIED_FOR_ACCOUNT");
    }
    throw new Error("NO_ELIGIBLE_ACCOUNT");
  }

  // Credits have different meanings across platforms, so preserve platform
  // preference and rank compatible accounts by their own remaining balance.
  // Doubao's balance is an estimate, not a per-task cost guarantee.
  eligible.sort((left, right) =>
    (left.account.service === "doubao" ? 0 : 1) - (right.account.service === "doubao" ? 0 : 1)
    || (Number.isInteger(right.account.creditsRemaining) ? right.account.creditsRemaining : -1)
      - (Number.isInteger(left.account.creditsRemaining) ? left.account.creditsRemaining : -1)
    || (left.account.lastUsedAt || 0) - (right.account.lastUsedAt || 0)
    || left.account.id.localeCompare(right.account.id));
  return eligible[0];
}
