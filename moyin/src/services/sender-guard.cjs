'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAllowedLocalSender(senderUrl, entryPath) {
  try {
    const parsed = new URL(String(senderUrl || ''));
    if (parsed.protocol !== 'file:') return false;
    return canonicalPath(fileURLToPath(parsed)) === canonicalPath(entryPath);
  } catch {
    return false;
  }
}

function allowedSenderEvent(event, entryPath) {
  const frameUrl = typeof event?.senderFrame?.url === 'string' ? event.senderFrame.url : '';
  const webContentsUrl = !frameUrl && typeof event?.sender?.getURL === 'function' ? event.sender.getURL() : '';
  return isAllowedLocalSender(frameUrl || webContentsUrl, entryPath);
}

module.exports = { canonicalPath, isAllowedLocalSender, allowedSenderEvent };
