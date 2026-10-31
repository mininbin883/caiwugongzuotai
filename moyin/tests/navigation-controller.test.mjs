import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULE_DEFINITIONS,
  MODULE_IDS,
  NAVIGATION_SCHEMA,
  moduleIdFromHash,
  moduleVisibility,
  nextModuleId,
  normalizeModuleId
} from '../src/core/navigation-controller.mjs';

test('phase26 navigation schema is versioned and stable', () => {
  assert.equal(NAVIGATION_SCHEMA, 'VEILFORGE_MODULE_NAV_V1');
  assert.deepEqual(MODULE_IDS, ['redact', 'batch', 'vault', 'restore', 'protect']);
});

test('every primary destination has novice copy and three steps', () => {
  for (const id of MODULE_IDS) {
    const definition = MODULE_DEFINITIONS[id];
    assert.ok(definition.label.length >= 3);
    assert.ok(definition.title.length >= 6);
    assert.ok(definition.description.length >= 16);
    assert.equal(definition.checklist.length, 3);
    assert.ok(Object.isFrozen(definition.checklist));
  }
});

test('unknown module values return the redaction workflow', () => {
  assert.equal(normalizeModuleId('UNKNOWN'), 'redact');
  assert.equal(normalizeModuleId('', 'vault'), 'vault');
});

test('hash parsing accepts canonical module routes', () => {
  assert.equal(moduleIdFromHash('#batch'), 'batch');
  assert.equal(moduleIdFromHash('#restore?from=vault'), 'restore');
  assert.equal(moduleIdFromHash('#protect&section=ocr'), 'protect');
});

test('arrow navigation wraps in both directions', () => {
  assert.equal(nextModuleId('protect', 'next'), 'redact');
  assert.equal(nextModuleId('redact', 'previous'), 'protect');
  assert.equal(nextModuleId('vault', 'next'), 'restore');
});

test('home and end navigation are deterministic', () => {
  assert.equal(nextModuleId('vault', 'first'), 'redact');
  assert.equal(nextModuleId('vault', 'last'), 'protect');
});

test('visibility keeps the three-step workflow exclusive to file redaction', () => {
  assert.equal(moduleVisibility('redact').showRedactionWorkflow, true);
  for (const id of MODULE_IDS.filter((value) => value !== 'redact')) {
    assert.equal(moduleVisibility(id).showRedactionWorkflow, false);
  }
});

test('each specialist destination exposes one matching workspace', () => {
  assert.equal(moduleVisibility('batch').showBatchQueue, true);
  assert.equal(moduleVisibility('vault').showVaultControls, true);
  assert.equal(moduleVisibility('restore').showRestoreWorkspace, true);
  assert.equal(moduleVisibility('protect').showProtectionControls, true);
});
