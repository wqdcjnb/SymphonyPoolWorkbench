export function createQueueScheduler({ claim, execute, afterExecute = async () => {},
  canRun = () => true, onError = () => {}, intervalMs = 2_000, maxConcurrent = 2 }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 25) throw new Error("INVALID_SCHEDULER_INTERVAL");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new Error("INVALID_SCHEDULER_CONCURRENCY");
  }
  const running = new Map();
  let timer = null;
  let stopping = false;
  let dispatching = false;
  let pending = false;
  const reportError = (error, assignment) => {
    try { onError(error, assignment); }
    catch (reportingError) { console.error("QUEUE_ERROR_HANDLER_FAILED", reportingError); }
  };

  const wake = () => {
    if (stopping || !timer || !canRun()) return;
    if (dispatching) { pending = true; return; }
    dispatching = true;
    try {
      while (!stopping && running.size < maxConcurrent) {
        const assignment = claim();
        if (!assignment) break;
        const id = assignment.job.id;
        const task = Promise.resolve().then(() => execute(assignment))
          .then(() => afterExecute(assignment))
          .catch((error) => reportError(error, assignment))
          .finally(() => {
            running.delete(id);
            queueMicrotask(wake);
          });
        running.set(id, task);
      }
    } catch (error) {
      reportError(error, null);
    } finally {
      dispatching = false;
      if (pending) { pending = false; queueMicrotask(wake); }
    }
  };

  return {
    start() {
      if (timer || stopping) return;
      timer = setInterval(wake, intervalMs);
      timer.unref?.();
      queueMicrotask(wake);
    },
    wake,
    stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      return Promise.allSettled([...running.values()]);
    },
    get runningCount() { return running.size; },
  };
}
