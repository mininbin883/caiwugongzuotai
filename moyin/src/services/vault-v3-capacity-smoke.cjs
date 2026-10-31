'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const {
  createVault,
  openVault,
  addVaultEntry,
  listVaultEntries,
  readVaultEntry,
  closeVault,
  PARITY_VAULT_BYTES,
  MAX_VAULT_BYTES,
  assertVaultGrowth
} = require('./vault-service.cjs');

const ENTRY_TEXT_BYTES = 15_800_000;
const PASSWORD = 'Phase18-Vault-V3-Capacity-Password!';

async function streamContains(filePath, needle) {
  const pattern = Buffer.from(needle);
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    if (combined.includes(pattern)) return true;
    carry = combined.subarray(Math.max(0, combined.length - pattern.length + 1));
  }
  return false;
}

function normalizeTargetMiB(value) {
  const targetMiB = value === undefined ? 256 : Number(value);
  if (!Number.isInteger(targetMiB) || targetMiB < 256 || targetMiB > 2000) {
    throw new Error('LOCAL_VAULT_LONGRUN_TARGET_INVALID');
  }
  return targetMiB;
}

async function runVaultV3CapacityScenario(outputDirectory, options = {}) {
  const startedAt = Date.now();
  const targetMiB = normalizeTargetMiB(options.targetMiB);
  const targetBytes = targetMiB * 1024 * 1024;
  const entryCount = Math.ceil(targetBytes / ENTRY_TEXT_BYTES);
  const output = path.resolve(outputDirectory);
  await fs.mkdir(output, { recursive: true });
  const vaultPath = path.join(output, `phase18-${targetMiB}MiB-capacity.miyin-vault`);
  await fs.rm(vaultPath, { force: true });
  let peakRssBytes = process.memoryUsage().rss;
  const filler = 'V'.repeat(ENTRY_TEXT_BYTES - 64);
  try {
    const created = await createVault(vaultPath, PASSWORD);
    try {
      for (let index = 0; index < entryCount; index += 1) {
        const marker = `PHASE18_SECRET_${String(index).padStart(3, '0')}_`;
        await addVaultEntry(created, {
          name: `容量记录-${String(index + 1).padStart(3, '0')}.txt`,
          text: `${marker}${filler}`,
          findingCount: 1,
          findingTypes: ['capacity']
        });
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
    } finally {
      closeVault(created);
    }

    const stat = await fs.stat(vaultPath);
    const plaintextAbsent = !(await streamContains(vaultPath, 'PHASE18_SECRET_'));
    const reopened = await openVault(vaultPath, PASSWORD);
    let first;
    let last;
    let entries;
    try {
      entries = listVaultEntries(reopened);
      first = await readVaultEntry(reopened, entries[0].id);
      last = await readVaultEntry(reopened, entries.at(-1).id);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    } finally {
      closeVault(reopened);
    }
    let exceedGate = false;
    try {
      assertVaultGrowth(MAX_VAULT_BYTES - 1, 2);
    } catch (error) {
      exceedGate = error?.message === 'LOCAL_VAULT_TOO_LARGE';
    }
    const firstExpected = 'PHASE18_SECRET_000_';
    const lastExpected = `PHASE18_SECRET_${String(entryCount - 1).padStart(3, '0')}_`;
    const pass = stat.size >= targetBytes && entries.length === entryCount &&
      first.text.startsWith(firstExpected) && last.text.startsWith(lastExpected) && plaintextAbsent && exceedGate;
    return {
      format: 'VEILFORGE_VAULT_V3_CAPACITY_REPORT',
      result: pass ? 'PASS' : 'FAIL',
      version: 3,
      targetMiB,
      targetBytes,
      entryCount: entries.length,
      entryTextBytes: ENTRY_TEXT_BYTES,
      vaultBytes: stat.size,
      parityBytes: PARITY_VAULT_BYTES,
      maxVaultBytes: MAX_VAULT_BYTES,
      peakRssBytes,
      firstMarkerRestored: first.text.startsWith(firstExpected),
      lastMarkerRestored: last.text.startsWith(lastExpected),
      plaintextAbsent,
      exceedGate,
      milliseconds: Date.now() - startedAt
    };
  } finally {
    await fs.rm(vaultPath, { force: true }).catch(() => {});
  }
}

module.exports = { runVaultV3CapacityScenario, normalizeTargetMiB, ENTRY_TEXT_BYTES };
