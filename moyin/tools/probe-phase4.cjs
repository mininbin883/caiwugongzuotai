'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = path.resolve(process.argv[2] || 'src/main.cjs');
const source = fs.readFileSync(input, 'utf8');
const probes = {
  vault_import: /createVault[\s\S]*openVault[\s\S]*rotateVaultPassword/.test(source),
  vault_sessions: /const vaultSessions = new Map\(\)/.test(source),
  vault_create: /createVaultFromDialog/.test(source),
  vault_save: /saveVaultEntry/.test(source),
  vault_auto_lock: /armVaultTimeout/.test(source),
  vault_lock_event: /veilforge:vault-locked/.test(source),
  vault_smoke: /runVaultSmoke/.test(source),
  vault_quit_clear: /before-quit[\s\S]*lockVaultSession/.test(source)
};
const passed = Object.values(probes).filter(Boolean).length;
const detail = Object.entries(probes).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
process.stdout.write(`PHASE4_PROBE input=${path.basename(input)} checks=${passed}/${Object.keys(probes).length} ${detail}\n`);
process.exitCode = passed === Object.keys(probes).length ? 0 : 1;
