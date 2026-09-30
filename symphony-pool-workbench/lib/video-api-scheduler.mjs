import { apiKeyFingerprint, VideoApiError } from "./nocsnow-api.mjs";

export function createVideoApiScheduler({ store, client, saveResult, intervalMs = 10_000,
  maxActiveTasks = 8, maxDispatches = 4 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 25
    || !Number.isInteger(maxActiveTasks) || maxActiveTasks < 2 || maxActiveTasks > 64) {
    throw new Error("INVALID_VIDEO_API_SCHEDULER_CONFIG");
  }
  const keys = new Map();
  const dispatching = new Set();
  let timer = null;
  let running = null;
  let stopping = false;
  let pending = false;

  async function pollTask(task) {
    try {
      const response = await client.task(keys.get(task.fingerprint), task.id);
      store.updateTask(task.fingerprint, task.id, response);
    } catch (error) {
      if (error instanceof VideoApiError && [401, 403].includes(error.status)) {
        store.blockBatch(task.batchId, error.code);
      }
    }
  }

  async function submitTurn(turn) {
    try {
      const response = await client.create(keys.get(turn.fingerprint), turn.payload, turn.idempotencyKey);
      store.acceptTurn(turn.id, response);
    } catch (error) {
      const failure = error instanceof VideoApiError ? error
        : new VideoApiError(504, "VIDEO_API_UNAVAILABLE");
      store.deferTurn(turn.id, failure, failure.retryAfterMs || 15_000);
    } finally {
      dispatching.delete(turn.id);
    }
  }

  async function tick() {
    const active = store.activeTasks([...keys.keys()], maxActiveTasks);
    await Promise.allSettled(active.map(pollTask));
    const fingerprints = [...keys.keys()];
    const work = [];
    for (let index = 0; index < maxDispatches; index += 1) {
      const turn = store.reserveNextTurn(fingerprints, maxActiveTasks, [...dispatching]);
      if (!turn) break;
      dispatching.add(turn.id);
      work.push(submitTurn(turn));
    }
    await Promise.allSettled(work);
    if (saveResult) {
      const ready = store.pendingResults([...keys.keys()], maxActiveTasks);
      await Promise.allSettled(ready.map(async (task) => {
        try {
          const resultPath = await saveResult(keys.get(task.fingerprint), task.id);
          if (typeof resultPath !== "string" || !resultPath) {
            throw new VideoApiError(502, "VIDEO_API_RESULT_SAVE_FAILED");
          }
          store.markResultSaved(task.fingerprint, task.id, resultPath);
        } catch (error) {
          const retryAfterMs = error instanceof VideoApiError
            ? error.retryAfterMs || ([401, 403, 413].includes(error.status) ? 300_000 : 15_000)
            : 15_000;
          store.markResultError(task.fingerprint, task.id,
            error instanceof VideoApiError ? error.code : "VIDEO_API_RESULT_SAVE_FAILED",
            retryAfterMs);
        }
      }));
    }
    for (const fingerprint of fingerprints) {
      if (!store.hasOpenWork(fingerprint) && !(saveResult && store.hasPendingResults(fingerprint))) {
        keys.delete(fingerprint);
      }
    }
  }

  function wake() {
    if (stopping) return;
    if (running) { pending = true; return; }
    running = tick().catch(() => {}).finally(() => {
      running = null;
      if (pending) { pending = false; queueMicrotask(wake); }
    });
  }

  return {
    attach(key) {
      const fingerprint = apiKeyFingerprint(key);
      if (!store.hasOpenWork(fingerprint) && !(saveResult && store.hasPendingResults(fingerprint))) {
        keys.delete(fingerprint);
        return;
      }
      const alreadyAttached = keys.get(fingerprint) === key;
      keys.set(fingerprint, key);
      if (!alreadyAttached) wake();
    },
    wake,
    start() {
      if (timer || stopping) return;
      timer = setInterval(wake, intervalMs);
      timer.unref?.();
      wake();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
      keys.clear();
    },
  };
}
