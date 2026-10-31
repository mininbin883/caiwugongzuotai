import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SerialTaskQueue } = require('../src/services/task-queue.cjs');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('background queue processes jobs serially and preserves input order', async () => {
  let active = 0;
  let maxActive = 0;
  const completed = [];
  const queue = new SerialTaskQueue(async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(value === 'first' ? 20 : 2);
    completed.push(value);
    active -= 1;
    return value.toUpperCase();
  });
  const first = queue.enqueue('first');
  const second = queue.enqueue('second');
  const third = queue.enqueue('third');
  await queue.waitForIdle();
  assert.equal(maxActive, 1);
  assert.deepEqual(completed, ['first', 'second', 'third']);
  assert.equal(queue.get(first.id).result, 'FIRST');
  assert.equal(queue.get(second.id).status, 'done');
  assert.equal(queue.get(third.id).progress, 100);
});

test('queued jobs can be canceled without interrupting the active job', async () => {
  const queue = new SerialTaskQueue(async (value) => {
    await delay(15);
    return value;
  });
  const active = queue.enqueue('active');
  const canceled = queue.enqueue('canceled');
  assert.equal(queue.cancel(canceled.id), true);
  await queue.waitForIdle();
  assert.equal(queue.get(active.id).status, 'done');
  assert.equal(queue.get(canceled.id).status, 'canceled');
});

test('active jobs receive an abort signal and settle as canceled', async () => {
  const queue = new SerialTaskQueue(async (_value, job) => {
    while (!job.abortController.signal.aborted) await delay(5);
    throw new Error('LOCAL_JOB_ABORTED');
  });
  const active = queue.enqueue('active');
  while (queue.get(active.id).status !== 'processing') await delay(1);
  assert.equal(queue.cancel(active.id), true);
  assert.equal(queue.get(active.id).status, 'canceling');
  await queue.waitForIdle();
  assert.equal(queue.get(active.id).status, 'canceled');
  assert.equal(queue.get(active.id).error, null);
});
