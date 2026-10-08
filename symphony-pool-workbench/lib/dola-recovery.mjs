// Match an existing task first. A verified, unacknowledged Doubao request may
// be resubmitted once, only after a complete inspection found no matching message.
export function createDolaRecovery({store, pool, sessions, inspect, confirm, verify, locks, verificationLocks, wake}) {
  return async function resume(id) {
    const job = await store.getJob(id);
    if (!job) throw new Error('JOB_NOT_FOUND');
    const account = await store.getAccount(job.accountId);
    if (!['dola','doubao'].includes(account?.service)) throw new Error('SERVICE_NOT_CONNECTED');
    if (job.collectOnly && ['queued','leased','submitted','generating','collecting','success'].includes(job.status)) {
      return {job, alreadyResumed:true};
    }
    if (['queued','leased','submitting','submitted','generating','collecting','success'].includes(job.status)
      && await store.hasVerificationResubmission(job.id)) return {job,alreadyResumed:true,resubmitted:true};
    if (job.status !== 'reconciling') throw new Error('JOB_NOT_RECONCILABLE');
    if (!sessions.enabled) throw new Error('MANAGED_RECOVERY_REQUIRED');
    if (locks.has(account.id) || verificationLocks.has(account.id)) throw new Error('ACCOUNT_PROFILE_IN_USE');
    locks.add(account.id);
    let token;
    async function verifyAccount() {
      verificationLocks.add(account.id);
      await store.setAccountChecking(account.id);
      try {
        const result = await verify(account);
        await store.saveVerification(account.id,result,account);
        if (!result.ok || !result.loggedIn) throw new Error(result.error || 'VERIFICATION_FAILED');
      } catch(error) {
        await store.saveVerificationFailure(account.id,error.message);
        throw error;
      }
    }
    async function releaseBrowser() {
      if(sessions.idle)await sessions.idle(account,token);
      else {await sessions.close(account);await pool.release(token);}
      token=null;
    }
    try {
      if (await store.hasRunningJobForAccount(account.id)) throw new Error('ACCOUNT_ALREADY_RUNNING');
      token = sessions.sessions.get(account.id)?.token || await pool.reserve(account,'manual');
      if (!token) throw new Error('ACCOUNT_OR_WORKER_BUSY');
      // Reuse an automated challenge window. A completed ordinary login must
      // save its profile before a browser with an inspection endpoint opens.
      await sessions.open(account,{manual:!sessions.sessions.get(account.id)?.manualBrowser,interactiveOnly:false,token});
      const input = {endpoint:sessions.sessions.get(account.id)?.endpoint, job:{...job,profilePath:account.profilePath}, service:account.service,
        excludedUrls:await store.boundRemoteUrls(account.id,job.id)};
      let observed = await inspect(input);
      if (!observed.ok && observed.error === 'DOUBAO_EXISTING_TASK_NOT_FOUND' && observed.historyChecked === true
        && account.service === 'doubao' && !job.remoteUrl && !job.submittedAt && !job.resultPath && !job.collectOnly
        && ['DOUBAO_HUMAN_VERIFICATION_REQUIRED','DOUBAO_VERIFIED_TASK_NOT_FOUND'].includes(job.errorCode)) {
        await verifyAccount();
        // Clearing the old CAPTCHA error is separate from proving acceptance.
        await store.updateJob(job.id,{status:'reconciling',errorCode:'DOUBAO_VERIFIED_TASK_NOT_FOUND'});
        if (await store.hasVerificationResubmission(job.id)) throw new Error('DOUBAO_VERIFICATION_RETRY_USED');
        await releaseBrowser();
        const started = await store.resubmitAfterVerification(job.id);
        wake();
        return {job:started.job,platformState:'resubmitting',resubmitted:true,alreadyResumed:false};
      }
      if (!observed.ok) {
        const reason=observed.error || 'DOLA_TASK_CHECK_FAILED';
        if (['TASK_ORIGINAL_PAGE_LOST','LOGIN_REQUIRED','DOLA_HUMAN_VERIFICATION_REQUIRED',
          'DOUBAO_HUMAN_VERIFICATION_REQUIRED','DOLA_EXISTING_TASK_NOT_FOUND','DOUBAO_EXISTING_TASK_NOT_FOUND'].includes(reason)) {
          await store.updateJob(job.id,{status:'reconciling',errorCode:reason});
        }
        throw new Error(reason);
      }
      const remotePattern = account.service === 'doubao' ? /^https:\/\/www\.doubao\.com\/chat\/[0-9]+$/ : /^https:\/\/www\.dola\.com\/chat\/[0-9]+$/;
      if (!remotePattern.test(observed.remoteUrl)
        || !(account.service === 'doubao' ? ['ready','generating','failed','confirmation','pending'] : ['ready','generating','failed']).includes(observed.platformState)
        || (job.remoteUrl && job.remoteUrl !== observed.remoteUrl)) throw new Error('DOLA_TASK_MISMATCH');
      if (!job.remoteUrl) await store.attachRemoteTask(job.id,observed.remoteUrl,observed.remoteMessageId||null,token);
      if (observed.platformState === 'confirmation') {
        if (!confirm) throw new Error('DOUBAO_CONFIRMATION_REQUIRED');
        if (!await store.beginTaskConfirmation(job.id)) throw new Error('DOUBAO_CONFIRMATION_UNCONFIRMED');
        try {
          const continued = await confirm({...input,job:{...input.job,remoteUrl:observed.remoteUrl}});
          if (!continued.ok) throw new Error(continued.error || 'DOUBAO_CONFIRMATION_UNCONFIRMED');
          if (continued.remoteUrl !== observed.remoteUrl || !['ready','generating','failed'].includes(continued.platformState)) {
            throw new Error('DOUBAO_CONFIRMATION_UNCONFIRMED');
          }
          observed = {...continued,sameConversation:observed.sameConversation,remoteMessageId:observed.remoteMessageId};
        } catch(error) {
          await store.updateJob(job.id,{status:'reconciling',errorCode:error.message === 'DOUBAO_HUMAN_VERIFICATION_REQUIRED'
            ? error.message : 'DOUBAO_CONFIRMATION_UNCONFIRMED'});
          throw error;
        }
      }
      if(observed.sameConversation)await store.confirmSessionFromTask(account.id);
      else await verifyAccount();
      if (observed.platformState === 'pending') {
        const pending = await store.updateJob(job.id,{status:'reconciling',errorCode:'DOUBAO_RESPONSE_PENDING'});
        return {job:pending,platformState:'pending',alreadyResumed:false};
      }
      await releaseBrowser();
      if (observed.platformState === 'failed') {
        const failed = await store.updateJob(job.id,{status:'failed',errorCode:'PLATFORM_GENERATION_FAILED'});
        return {job:failed,platformState:'failed',alreadyResumed:false};
      }
      const started = await store.recollectJob(job.id);
      wake();
      return {job:started.job,platformState:observed.platformState,alreadyResumed:false};
    } finally {
      // Leave the account available to the human when inspection/verification fails.
      try {
        if (token && sessions.sessions.has(account.id)) sessions.handoff(account,token);
        else if (token) await pool.release(token);
      } finally {
        verificationLocks.delete(account.id);
        locks.delete(account.id);
      }
    }
  };
}
