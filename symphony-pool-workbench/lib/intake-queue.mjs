// Keep upload parsing bounded while waiting requests remain backpressured by HTTP.
export function createIntakeQueue({ concurrency = 2, maxWaiting = 200, waitMs = 30_000 } = {}) {
  let active = 0, closed = false;
  const waiting = [];
  const error = code => new Error(code);
  const grant = () => {
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      while (!closed && active < concurrency && waiting.length) {
        const entry = waiting.shift();
        entry.cleanup();
        entry.resolve(grant());
      }
    };
  };
  return {
    get active() { return active; },
    get pending() { return waiting.length; },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(error('REQUEST_ABORTED'));
      if (closed || waiting.length >= maxWaiting) return Promise.reject(error('QUEUE_FULL'));
      if (active < concurrency) return Promise.resolve(grant());
      return new Promise((resolve, reject) => {
        const fail = code => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1);
          entry.cleanup();
          reject(error(code));
        };
        const abort = () => fail('REQUEST_ABORTED');
        const timer = setTimeout(() => fail('QUEUE_FULL'), waitMs);
        timer.unref();
        const entry = { resolve, reject, cleanup() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        } };
        waiting.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    stop() {
      closed = true;
      for (const entry of waiting.splice(0)) {
        entry.cleanup();
        entry.reject(error('QUEUE_FULL'));
      }
    },
  };
}
