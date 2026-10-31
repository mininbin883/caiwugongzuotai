'use strict';

const { randomUUID } = require('node:crypto');

class SerialTaskQueue {
  constructor(worker, onUpdate = () => {}) {
    if (typeof worker !== 'function') throw new TypeError('QUEUE_WORKER_REQUIRED');
    this.worker = worker;
    this.onUpdate = onUpdate;
    this.jobs = new Map();
    this.pending = [];
    this.running = false;
    this.idleWaiters = [];
  }

  enqueue(input, metadata = {}) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      input,
      metadata,
      status: 'queued',
      progress: 0,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      abortController: new AbortController()
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.#emit(job);
    queueMicrotask(() => this.#drain());
    return job;
  }

  get(id) {
    return this.jobs.get(String(id || '')) || null;
  }

  list(predicate = () => true) {
    return [...this.jobs.values()].filter(predicate);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job || !['queued', 'processing'].includes(job.status)) return false;
    job.abortController.abort(new Error('LOCAL_BATCH_CANCELED'));
    if (job.status === 'processing') {
      job.status = 'canceling';
      job.updatedAt = new Date().toISOString();
      this.#emit(job);
      return true;
    }
    job.status = 'canceled';
    job.updatedAt = new Date().toISOString();
    this.pending = this.pending.filter((pendingId) => pendingId !== job.id);
    this.#emit(job);
    this.#resolveIdleIfNeeded();
    return true;
  }

  clear(predicate) {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === 'processing' || job.status === 'queued' || job.status === 'canceling') continue;
      if (!predicate(job)) continue;
      this.jobs.delete(id);
      removed += 1;
    }
    return removed;
  }

  waitForIdle() {
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #emit(job) {
    this.onUpdate(job);
  }

  #resolveIdleIfNeeded() {
    if (this.running || this.pending.length) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const id = this.pending.shift();
        const job = this.jobs.get(id);
        if (!job || job.status !== 'queued') continue;
        job.status = 'processing';
        job.progress = 15;
        job.updatedAt = new Date().toISOString();
        this.#emit(job);
        try {
          job.result = await this.worker(job.input, job);
          job.status = job.abortController.signal.aborted ? 'canceled' : 'done';
          job.progress = 100;
        } catch (error) {
          job.status = job.abortController.signal.aborted || error?.message === 'LOCAL_JOB_ABORTED' ? 'canceled' : 'failed';
          job.progress = 100;
          job.error = job.status === 'canceled' ? null : String(error?.message || error || 'UNKNOWN_ERROR');
        }
        job.updatedAt = new Date().toISOString();
        this.#emit(job);
      }
    } finally {
      this.running = false;
      this.#resolveIdleIfNeeded();
    }
  }
}

module.exports = { SerialTaskQueue };
