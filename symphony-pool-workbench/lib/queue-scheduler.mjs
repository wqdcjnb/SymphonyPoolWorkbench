export function createQueueScheduler({ claim, execute, afterExecute = async () => {},
  releaseClaim = async () => {}, canRun = () => true, onError = () => {}, intervalMs = 2_000, maxConcurrent = 2 }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 25) throw new Error("INVALID_SCHEDULER_INTERVAL");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 100) {
    throw new Error("INVALID_SCHEDULER_CONCURRENCY");
  }
  const running = new Map();
  let timer = null;
  let stopping = false;
  let dispatching = null;
  let pending = false;
  const reportError = async (error, assignment) => {
    try { await onError(error, assignment); }
    catch (reportingError) { console.error("QUEUE_ERROR_HANDLER_FAILED", reportingError); }
  };

  const drain = async () => {
    try {
      if (!(await canRun())) return;
      while (!stopping && running.size < maxConcurrent) {
        const assignment = await claim();
        if (!assignment) break;
        if (stopping) { await releaseClaim(assignment); break; }
        const id = assignment.job.id;
        const task = Promise.resolve().then(() => execute(assignment))
          .catch((error) => reportError(error, assignment))
          .then(() => afterExecute(assignment))
          .catch((error) => reportError(error, assignment))
          .finally(() => {
            running.delete(id);
            queueMicrotask(wake);
          });
        running.set(id, task);
      }
    } catch (error) {
      await reportError(error, null);
    }
  };
  const wake = () => {
    if (stopping || !timer) return;
    if (dispatching) { pending = true; return dispatching; }
    dispatching = drain().finally(() => {
      dispatching = null;
      if (pending) { pending = false; queueMicrotask(wake); }
    });
    return dispatching;
  };

  return {
    start() {
      if (timer || stopping) return;
      timer = setInterval(wake, intervalMs);
      timer.unref?.();
      queueMicrotask(wake);
    },
    wake,
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (dispatching) await dispatching;
      return Promise.allSettled([...running.values()]);
    },
    get runningCount() { return running.size; },
  };
}
