import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createIntakeQueue } from '../lib/intake-queue.mjs';

test('intake FIFO stays bounded; abort, timeout and shutdown release waiting requests', async () => {
  const queue = createIntakeQueue({ concurrency: 1, maxWaiting: 2, waitMs: 50 });
  const first = await queue.acquire();
  const abort = new AbortController();
  const cancelled = assert.rejects(queue.acquire(abort.signal), /REQUEST_ABORTED/);
  const second = queue.acquire();
  await assert.rejects(queue.acquire(), /QUEUE_FULL/);
  abort.abort(); await cancelled;
  first(); first();
  const releaseSecond = await second;
  assert.equal(queue.active, 1); assert.equal(queue.pending, 0);
  const timedOut = assert.rejects(queue.acquire(), /QUEUE_FULL/);
  await delay(70); await timedOut;
  const stopped = assert.rejects(queue.acquire(), /QUEUE_FULL/);
  queue.stop(); await stopped;
  releaseSecond();
  assert.equal(queue.active, 0); assert.equal(queue.pending, 0);
  await assert.rejects(queue.acquire(), /QUEUE_FULL/);
});
