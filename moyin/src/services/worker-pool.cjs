'use strict';

class BoundedWorkerPool {
  constructor(options = {}) {
    const concurrency = Number(options.concurrency ?? 1);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error('LOCAL_WORKER_POOL_CONCURRENCY_INVALID');
    }
    this.concurrency = concurrency;
    this.queue = [];
    this.active = 0;
    this.closed = false;
    this.waiters = [];
  }

  run(task, options = {}) {
    if (this.closed) return Promise.reject(new Error('LOCAL_WORKER_POOL_CLOSED'));
    if (typeof task !== 'function') return Promise.reject(new Error('LOCAL_WORKER_TASK_INVALID'));
    if (options.signal?.aborted) return Promise.reject(new Error('LOCAL_JOB_ABORTED', { cause: options.signal.reason }));
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, signal: options.signal, label: String(options.label || '') };
      const abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(new Error('LOCAL_JOB_ABORTED', { cause: item.signal?.reason }));
          this.#notifyIfIdle();
        }
      };
      item.abort = abort;
      options.signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(item);
      this.#pump();
    });
  }

  #pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      item.signal?.removeEventListener('abort', item.abort);
      if (item.signal?.aborted) {
        item.reject(new Error('LOCAL_JOB_ABORTED', { cause: item.signal.reason }));
        continue;
      }
      this.active += 1;
      Promise.resolve()
        .then(() => item.task({ signal: item.signal, label: item.label }))
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.#pump();
          this.#notifyIfIdle();
        });
    }
    this.#notifyIfIdle();
  }

  #notifyIfIdle() {
    if (this.active || this.queue.length) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  drain() {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(reason = 'LOCAL_WORKER_POOL_CLOSED') {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      item.signal?.removeEventListener('abort', item.abort);
      item.reject(new Error(reason));
    }
    this.#notifyIfIdle();
  }

  stats() {
    return Object.freeze({ concurrency: this.concurrency, active: this.active, queued: this.queue.length, closed: this.closed });
  }
}

module.exports = { BoundedWorkerPool };
