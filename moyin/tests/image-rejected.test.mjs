import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { friendlyError } from '../src/core/error-messages.mjs';

test('图片文件给出“不支持图片”的明确说明', () => {
  const message = friendlyError(new Error('LOCAL_IMAGE_FILE_NOT_ACCEPTED:截图.png'));
  assert.match(message, /不支持图片文件/u);
  assert.match(friendlyError(new Error('LOCAL_DOCUMENT_TYPE_UNSUPPORTED:a.exe')), /不支持图片/u);
});

test('主进程不再接受图片扩展名，批处理跳过而不是原样导出', () => {
  const main = readFileSync(new URL('../src/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /const ACCEPTED_EXTENSIONS = new Set\(SUPPORTED_EXTENSIONS\);/u);
  assert.match(main, /skipped: skipped\.map/u);
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="imageToTextButton"[^>]*hidden/u);
});
