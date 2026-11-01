import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../src/core/error-messages.mjs';
import { buildAiPrompt } from '../src/core/ai-prompt.mjs';

test('常见错误代码翻译成中文说明', () => {
  assert.match(friendlyError(new Error('LOCAL_OFFICE_NO_REDACTIONS')), /至少勾选一项/);
  assert.match(friendlyError(new Error("Error invoking remote method 'veilforge:export': Error: LOCAL_OFFICE_SESSION_EXPIRED")), /重新导入/);
  assert.match(friendlyError('LOCAL_VAULT_PASSWORD_OR_INTEGRITY_INVALID'), /密码不正确/);
  assert.match(friendlyError('LOCAL_DOCUMENT_TYPE_UNSUPPORTED'), /不支持这种文件格式/);
  assert.match(friendlyError('LOCAL_TYPE_UNSUPPORTED'), /不支持这种文件格式/);
  assert.match(friendlyError('LOCAL_RAPIDOCR_TIMEOUT'), /OCR 组件/);
});

test('未收录的代码给出通用说明并保留代码；普通错误去掉 Electron 包装', () => {
  assert.match(friendlyError('LOCAL_SOMETHING_NEW'), /代码 LOCAL_SOMETHING_NEW/);
  assert.equal(friendlyError(new Error("Error invoking remote method 'x': Error: 磁盘只读")), '磁盘只读');
  assert.equal(friendlyError(null), '发生未知错误，请重试。');
});

test('给 AI 的要求只含编号、代号格式与数量，不含真实值', () => {
  const mapping = [
    { token: '[MI_ABCDEF12_001]', value: '星河科技有限公司', type: 'company' },
    { token: '[MI_ABCDEF12_002]', value: '张三', type: 'person' },
    { token: '[MI_ABCDEF12_003]', value: '李四', type: 'person' }
  ];
  const prompt = buildAiPrompt({ fileNumber: 'MI-000007', mapping, formatLabel: 'Excel（XLSX）' });
  assert.match(prompt, /文件 MI-000007/);
  assert.match(prompt, /\[MI_ABCDEF12_001\]/);
  assert.match(prompt, /公司\/单位 1 个、姓名 2 个/);
  assert.match(prompt, /原样保留所有方括号代号/);
  for (const { value } of mapping) assert.equal(prompt.includes(value), false);
});
