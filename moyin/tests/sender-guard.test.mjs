import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAllowedLocalSender, allowedSenderEvent } = require('../src/services/sender-guard.cjs');

const entry = path.resolve('src/renderer/index.html');
const entryUrl = pathToFileURL(entry).href;

test('sender guard accepts the entry file with hash routing and query state', () => {
  assert.equal(isAllowedLocalSender(entryUrl, entry), true);
  assert.equal(isAllowedLocalSender(`${entryUrl}#redact`, entry), true);
  assert.equal(isAllowedLocalSender(`${entryUrl}?source=batch#batch`, entry), true);
});

test('sender guard rejects another local file and non-file origins', () => {
  assert.equal(isAllowedLocalSender(pathToFileURL(path.resolve('src/renderer/other.html')).href, entry), false);
  assert.equal(isAllowedLocalSender('https://example.invalid/index.html#batch', entry), false);
  assert.equal(isAllowedLocalSender('not-a-url', entry), false);
});

test('sender guard uses senderFrame first and falls back to top-level WebContents URL', () => {
  assert.equal(allowedSenderEvent({ senderFrame: { url: `${entryUrl}#batch` } }, entry), true);
  assert.equal(allowedSenderEvent({ sender: { getURL: () => `${entryUrl}#batch` } }, entry), true);
  assert.equal(allowedSenderEvent({ senderFrame: { url: 'https://example.invalid/' }, sender: { getURL: () => entryUrl } }, entry), false);
});
