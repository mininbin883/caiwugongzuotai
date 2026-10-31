'use strict';

const fs = require('node:fs/promises');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const CAPACITY_PROFILES = Object.freeze({
  parity: Object.freeze({
    name: 'parity',
    maxInputBytes: 100 * MiB,
    maxPdfPages: 300,
    maxScanPages: 100,
    maxScanCharacters: 60_000,
    maxWorkspaceBytes: 2 * GiB,
    maxRssBytes: Math.floor(1.5 * GiB),
    minimumFreeBytes: 128 * MiB
  }),
  exceed: Object.freeze({
    name: 'exceed',
    maxInputBytes: 200 * MiB,
    maxPdfPages: 500,
    maxScanPages: 200,
    maxScanCharacters: 150_000,
    maxWorkspaceBytes: 4 * GiB,
    maxRssBytes: 2 * GiB,
    minimumFreeBytes: 256 * MiB
  })
});

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function profileWithOverrides(profile, overrides = {}) {
  const source = typeof profile === 'string' ? CAPACITY_PROFILES[profile] : profile;
  if (!source) throw new Error('LOCAL_RESOURCE_PROFILE_INVALID');
  return Object.freeze({
    name: String(overrides.name || source.name),
    maxInputBytes: positiveInteger(overrides.maxInputBytes, source.maxInputBytes),
    maxPdfPages: positiveInteger(overrides.maxPdfPages, source.maxPdfPages),
    maxScanPages: positiveInteger(overrides.maxScanPages, source.maxScanPages),
    maxScanCharacters: positiveInteger(overrides.maxScanCharacters, source.maxScanCharacters),
    maxWorkspaceBytes: positiveInteger(overrides.maxWorkspaceBytes, source.maxWorkspaceBytes),
    maxRssBytes: positiveInteger(overrides.maxRssBytes, source.maxRssBytes),
    minimumFreeBytes: positiveInteger(overrides.minimumFreeBytes, source.minimumFreeBytes)
  });
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('LOCAL_JOB_ABORTED');
    error.cause = signal.reason;
    throw error;
  }
}

function statfsFreeBytes(value) {
  const blockSize = BigInt(value?.bsize ?? value?.frsize ?? 0);
  const available = BigInt(value?.bavail ?? value?.bfree ?? 0);
  const bytes = blockSize * available;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

function createResourceBudget(options = {}) {
  const profile = profileWithOverrides(options.profile || 'parity', options);
  const memoryUsage = options.memoryUsage || process.memoryUsage;
  const statfs = options.statfs || fs.statfs;
  const samples = [];
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;

  function assertInputBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('LOCAL_RESOURCE_SIZE_INVALID');
    if (bytes > profile.maxInputBytes) throw new Error('LOCAL_FILE_TOO_LARGE');
    return bytes;
  }

  function assertPdfPages(pages) {
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > profile.maxPdfPages) {
      throw new Error('LOCAL_PDF_PAGE_COUNT_INVALID');
    }
    return pages;
  }

  function assertScan(pages, characters) {
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > profile.maxScanPages) {
      throw new Error('LOCAL_SCAN_PAGE_COUNT_INVALID');
    }
    if (!Number.isSafeInteger(characters) || characters < 0 || characters > profile.maxScanCharacters) {
      throw new Error('LOCAL_SCAN_TEXT_TOO_LARGE');
    }
  }

  function assertWorkspaceBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > profile.maxWorkspaceBytes) {
      throw new Error('LOCAL_WORKSPACE_BUDGET_EXCEEDED');
    }
    return bytes;
  }

  async function assertDiskSpace(directory, anticipatedBytes = 0) {
    assertWorkspaceBytes(anticipatedBytes);
    let freeBytes = null;
    try {
      freeBytes = statfsFreeBytes(await statfs(directory));
    } catch (error) {
      if (!['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(error?.code)) throw error;
    }
    if (freeBytes !== null && freeBytes < anticipatedBytes + profile.minimumFreeBytes) {
      throw new Error('LOCAL_DISK_BUDGET_EXCEEDED');
    }
    return { checked: freeBytes !== null, freeBytes, anticipatedBytes, minimumFreeBytes: profile.minimumFreeBytes };
  }

  function sample(label = 'sample') {
    const usage = memoryUsage();
    const rss = Number(usage.rss || 0);
    const heapUsed = Number(usage.heapUsed || 0);
    peakRssBytes = Math.max(peakRssBytes, rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, heapUsed);
    const record = { label: String(label), rssBytes: rss, heapUsedBytes: heapUsed };
    samples.push(record);
    if (samples.length > 512) samples.shift();
    if (rss > profile.maxRssBytes) throw new Error('LOCAL_MEMORY_BUDGET_EXCEEDED');
    return record;
  }

  function snapshot() {
    return {
      profile,
      peakRssBytes,
      peakHeapUsedBytes,
      samples: samples.slice()
    };
  }

  return Object.freeze({
    profile,
    assertInputBytes,
    assertPdfPages,
    assertScan,
    assertWorkspaceBytes,
    assertDiskSpace,
    assertNotAborted,
    sample,
    snapshot
  });
}

module.exports = {
  MiB,
  GiB,
  CAPACITY_PROFILES,
  createResourceBudget,
  assertNotAborted,
  statfsFreeBytes
};
