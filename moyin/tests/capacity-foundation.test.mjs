import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createResourceBudget, CAPACITY_PROFILES, MiB } = require('../src/services/resource-budget-service.cjs');
const { createJobWorkspace, recoverOrphanedWorkspaces, WORKSPACE_PREFIX } = require('../src/services/job-workspace-service.cjs');
const { BoundedWorkerPool } = require('../src/services/worker-pool.cjs');

test('parity resource profile enforces 100 MiB and 300 PDF pages', () => {
  const budget = createResourceBudget({ profile: 'parity', memoryUsage: () => ({ rss: 256 * MiB, heapUsed: 64 * MiB }) });
  assert.equal(CAPACITY_PROFILES.parity.maxInputBytes, 100 * MiB);
  assert.equal(CAPACITY_PROFILES.parity.maxPdfPages, 300);
  assert.equal(budget.assertInputBytes(100 * MiB), 100 * MiB);
  assert.equal(budget.assertPdfPages(300), 300);
  assert.throws(() => budget.assertInputBytes(100 * MiB + 1), /LOCAL_FILE_TOO_LARGE/);
  assert.throws(() => budget.assertPdfPages(301), /LOCAL_PDF_PAGE_COUNT_INVALID/);
  assert.equal(budget.sample('unit').rssBytes, 256 * MiB);
});

test('memory and disk budgets fail before processing starts', async () => {
  const memory = createResourceBudget({ profile: 'parity', memoryUsage: () => ({ rss: 2 * 1024 * MiB, heapUsed: 1 }) });
  assert.throws(() => memory.sample('too-large'), /LOCAL_MEMORY_BUDGET_EXCEEDED/);
  const disk = createResourceBudget({
    profile: 'parity',
    minimumFreeBytes: 16 * MiB,
    statfs: async () => ({ bsize: 4096, bavail: 1 })
  });
  await assert.rejects(() => disk.assertDiskSpace(path.resolve('.'), MiB), /LOCAL_DISK_BUDGET_EXCEEDED/);
});

test('job workspace streams, hashes, manifests and removes staged plaintext', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-workspace-test-'));
  const source = path.join(root, 'sample.txt');
  const value = '联系人：张三\n手机：13812345678\n';
  await fs.writeFile(source, value, 'utf8');
  const workspaceRoot = path.join(root, 'jobs');
  const workspace = await createJobWorkspace(source, { root: workspaceRoot, jobId: 'unit-job-0001' });
  assert.equal(await fs.readFile(workspace.inputPath, 'utf8'), value);
  assert.equal(workspace.sourceSha256, createHash('sha256').update(value).digest('hex'));
  const manifest = JSON.parse(await fs.readFile(workspace.manifestPath, 'utf8'));
  assert.equal(manifest.state, 'active');
  assert.equal(manifest.sourceSha256, workspace.sourceSha256);
  assert.ok((await workspace.measure()) >= Buffer.byteLength(value));
  const directory = workspace.directory;
  assert.equal(await workspace.cleanup(), true);
  await assert.rejects(() => fs.stat(directory), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test('pre-aborted workspace leaves no job directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-abort-test-'));
  const source = path.join(root, 'sample.bin');
  await fs.writeFile(source, Buffer.alloc(1024));
  const workspaceRoot = path.join(root, 'jobs');
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(() => createJobWorkspace(source, {
    root: workspaceRoot,
    jobId: 'abort-job-0001',
    signal: controller.signal
  }), /LOCAL_JOB_ABORTED/);
  const entries = await fs.readdir(workspaceRoot).catch(() => []);
  assert.equal(entries.filter((name) => name.startsWith(WORKSPACE_PREFIX)).length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('orphan recovery removes dead workspaces and preserves the current process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-recovery-test-'));
  const dead = path.join(root, `${WORKSPACE_PREFIX}dead-job-0001`);
  const active = path.join(root, `${WORKSPACE_PREFIX}live-job-0001`);
  await fs.mkdir(dead);
  await fs.mkdir(active);
  await fs.writeFile(path.join(dead, 'job-manifest.json'), JSON.stringify({ pid: 2147483647 }));
  await fs.writeFile(path.join(active, 'job-manifest.json'), JSON.stringify({ pid: process.pid }));
  const report = await recoverOrphanedWorkspaces(root);
  assert.equal(report.scanned, 2);
  assert.equal(report.removed, 1);
  assert.equal(report.active, 1);
  await assert.rejects(() => fs.stat(dead), /ENOENT/);
  assert.ok((await fs.stat(active)).isDirectory());
  await fs.rm(root, { recursive: true, force: true });
});

test('bounded worker pool limits concurrency and cancels queued work', async () => {
  const pool = new BoundedWorkerPool({ concurrency: 1 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const first = pool.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return 'first';
  });
  const controller = new AbortController();
  const second = pool.run(async () => 'second', { signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(() => second, /LOCAL_JOB_ABORTED/);
  release();
  assert.equal(await first, 'first');
  await pool.drain();
  assert.equal(peak, 1);
  assert.deepEqual(pool.stats(), { concurrency: 1, active: 0, queued: 0, closed: false });
  pool.close();
});
