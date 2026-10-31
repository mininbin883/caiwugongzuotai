import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';
import { DEMO_DOCUMENT, demoDocumentResult, workflowSteps } from '../src/core/workflow-demo.mjs';

test('built-in demo stays local, deterministic and covers the review categories', () => {
  const result = demoDocumentResult();
  const analysis = analyzeText(result.text, { customTerms: ['流光计划'] });
  const types = new Set(analysis.findings.map((finding) => finding.type));
  assert.equal(result.name, DEMO_DOCUMENT.name);
  assert.equal(result.characters, DEMO_DOCUMENT.text.length);
  assert.ok(result.sourceBytes >= result.characters);
  for (const type of ['company', 'person', 'mobile', 'email', 'bankcard', 'address', 'ipv4', 'custom']) {
    assert.ok(types.has(type), `missing demo finding type: ${type}`);
  }
});

test('three-step workflow exposes import, review, export and complete states', () => {
  assert.deepEqual(workflowSteps('import').map((step) => step.state), ['current', 'pending', 'pending']);
  assert.deepEqual(workflowSteps('review').map((step) => step.state), ['done', 'current', 'pending']);
  assert.deepEqual(workflowSteps('export').map((step) => step.state), ['done', 'done', 'current']);
  assert.deepEqual(workflowSteps('complete').map((step) => step.state), ['done', 'done', 'done']);
});
