// One progress vocabulary for the task list, recovery page, and partner API.
// Engine status is retained for scheduling and backwards-compatible polling.
export function jobProgress(job) {
  const status = job.status;
  const error = job.errorCode || '';
  const last = job.lastObservedStage || (status !== 'reconciling' ? status : null);
  const completed = ['collecting','success'].includes(last);
  const platform = completed ? 'completed' : last === 'generating' ? 'generating'
    : ['submitting','submitted'].includes(last) || job.remoteUrl ? 'unknown' : 'not_submitted';
  const result = (phase,label,description,action='none',delivery='pending',platformStatus=platform) => ({
    phase,label,description,action,platform_status:platformStatus,delivery_status:delivery,
    updated_at:job.updatedAt || null,last_observed_at:job.lastObservedAt || null,
  });
  if (status === 'success') return result('completed','已完成','视频已保存，可查看或下载。','none','available','completed');
  if (status === 'failed') return result('failed','失败','本次任务已结束，请查看错误原因。','none',completed?'blocked':'pending',completed?'completed':'failed');
  if (status === 'cancelled') return result('cancelled','已取消','本次任务已取消。');
  if (status === 'draft') return result('draft','待提交','任务尚未加入队列。');
  if (status === 'queued') {
    const waiting = {
      ACCOUNTS_LOGIN_REQUIRED:['等待账号登录','可执行此规格的账号需要重新登录；登录校验通过后，原任务会自动派发。'],
      ACCOUNTS_VERIFICATION_REQUIRED:['等待账号验证','可执行此规格的账号需要完成人机验证；验证通过后，原任务会自动派发。'],
      ACCOUNT_ALREADY_RUNNING:['等待账号空闲','符合要求的账号正在处理其他任务，释放后自动派发。'],
      ACCOUNT_BROWSER_BUSY:['等待登录窗口释放','符合要求的账号正在登录或校验，完成后自动派发。'],
      ACCOUNT_CREDITS_INSUFFICIENT:['等待可用额度','符合要求的账号剩余额度不足，等待额度恢复或其他可用账号。'],
      ACCOUNTS_NOT_READY:['等待账号校验','可执行此规格的账号尚未通过登录与能力校验。'],
      MODEL_NOT_VERIFIED_FOR_ACCOUNT:['等待模型校验','尚未有可用账号通过此模型的能力校验。'],
      NO_COMPATIBLE_ACCOUNT:['等待匹配账号','账号池内没有支持此次模型、时长和素材规格的账号。'],
      WORKER_CAPACITY_FULL:['等待节点空闲','执行节点槽位已满，空闲后自动派发。'],
      WORKER_OFFLINE:['等待节点上线','账号所属执行节点离线，上线后自动派发。'],
    }[error];
    return result('queued',waiting?.[0] || (job.collectOnly?'等待收集':'排队中'),
      waiting?.[1] || (job.collectOnly?'原任务已排队，等待连接平台收集结果。':'等待可用账号和执行节点。'));
  }
  if (status === 'leased') return result('starting',job.collectOnly?'连接原任务':'准备中',
    job.collectOnly?'正在连接原会话，不会重新发送生成请求。':'已分配账号，正在准备浏览器和素材。');
  if (status === 'submitting') return result('submitting','提交中','正在发送请求，尚未确认平台受理。');
  if (status === 'submitted') return result('awaiting_platform','等待平台响应','已进入原会话，等待平台确认生成。');
  if (status === 'generating') return result('generating','生成中','平台已确认开始生成，等待成品。','none','pending','generating');
  if (status === 'collecting') return result('downloading','下载与校验中','平台视频已生成，正在下载并校验交付文件。','none','downloading','completed');
  if (status !== 'reconciling') return result('needs_review','待处理','请查看任务详情。','inspect');
  if (['DOLA_HUMAN_VERIFICATION_REQUIRED','DOUBAO_HUMAN_VERIFICATION_REQUIRED','HUMAN_VERIFICATION_REQUIRED','CAPTCHA_REQUIRED'].includes(error)) {
    return result('awaiting_verification','待人工验证','任务已暂停，请在对应账号窗口完成人机验证后继续。','verify');
  }
  if (['LOGIN_REQUIRED','LOGIN_EXPIRED_DURING_SUBMISSION'].includes(error)) {
    return result('awaiting_login','待重新登录','登录已失效，重新登录后核对原任务。','verify');
  }
  if (['TASK_ORIGINAL_PAGE_LOST','DOLA_EXISTING_TASK_NOT_FOUND','DOUBAO_EXISTING_TASK_NOT_FOUND'].includes(error)) {
    return result('original_conversation_missing','原会话待定位','尚未定位到原任务对应的平台会话，需要核对并绑定原会话后继续。','resume');
  }
  if (['WATERMARK_FREE_RESULT_REQUIRED','DOUBAO_ORIGINAL_EXPORT_TIMEOUT','DOUBAO_ORIGINAL_EXPORT_FAILED',
    'WATERMARK_REPAIR_FAILED','WATERMARK_REPAIR_UNSUPPORTED_LAYOUT','VIDEO_DURATION_MISMATCH','RESULT_FILE_MISSING'].includes(error) || completed) {
    return result('download_blocked',job.nextReconcileAt?'等待重试下载':'交付受阻',
      error === 'WATERMARK_FREE_RESULT_REQUIRED' ? '平台视频已生成，无水印原片尚未通过下载或校验。'
        : error === 'VIDEO_DURATION_MISMATCH' ? '已取得视频，但实际时长与请求不符，暂不能交付。'
          : '平台视频已生成，下载或交付校验未完成。',job.nextReconcileAt?'none':'recollect','blocked','completed');
  }
  if (error === 'PLATFORM_PARAMETERS_MISMATCH') return result('parameter_mismatch','参数待核对','平台显示的参数与请求不一致，已暂停。','resume');
  if (['DOUBAO_CONFIRMATION_REQUIRED','DOUBAO_CONFIRMATION_UNCONFIRMED'].includes(error)) {
    return result('awaiting_confirmation','待平台确认','正在核对原会话的生成确认结果。','resume');
  }
  if (['DOUBAO_SUBMISSION_UNCONFIRMED','DOUBAO_VERIFIED_TASK_NOT_FOUND','DOUBAO_RESPONSE_PENDING'].includes(error)) {
    return result('submission_unconfirmed','受理待确认','尚未确认原请求已开始生成，请核对原会话。','resume');
  }
  return result('reconciling',job.nextReconcileAt?'等待自动核对':'状态待核对',
    '当前无法确认平台最新进度，已保留原任务；核对时不会重新生成。',job.nextReconcileAt?'none':'resume');
}

export function partnerProgress(item) {
  const status = item.state === 'succeeded' ? 'success'
    : ['failed','cancelled'].includes(item.state) ? item.state : item.jobStatus || 'queued';
  const progress = jobProgress({status,errorCode:item.jobError || item.error_code,
    lastObservedStage:item.lastObservedStage,lastObservedAt:item.lastObservedAt,
    updatedAt:item.jobUpdatedAt,collectOnly:item.collectOnly,remoteUrl:item.remoteUrl,
    nextReconcileAt:item.nextReconcileAt});
  // A generated local file is not yet an API-deliverable, verified result.
  if (status === 'success' && item.state !== 'succeeded') Object.assign(progress,{
    phase:'processing',label:'交付校验中',description:'视频已保存，正在处理和校验 API 交付文件。',delivery_status:'processing'});
  return {...progress,updated_at:progress.updated_at ? new Date(progress.updated_at).toISOString() : null,
    last_observed_at:progress.last_observed_at ? new Date(progress.last_observed_at).toISOString() : null};
}
