import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText } from '../src/core/redaction-engine.mjs';

const values = (text, type) => analyzeText(text).findings.filter((item) => !type || item.type === type).map((item) => item.value);

test('识别关键词后的密码与密钥取值', () => {
  assert.deepEqual(values('初始密码为：Abc12345，请登录后修改。', 'secret'), ['Abc12345']);
  assert.deepEqual(values('password = "S3cr3t!pw"\napi_key=key_live_9f8e7d6c5b4a', 'secret'), ['S3cr3t!pw', 'key_live_9f8e7d6c5b4a']);
  assert.deepEqual(values('--password=Hunter2026 --user admin', 'secret'), ['Hunter2026']);
  assert.deepEqual(values('AccessKey Secret：Zx9Qw8Er7Ty6Ui5Op4', 'secret'), ['Zx9Qw8Er7Ty6Ui5Op4']);
  assert.deepEqual(values('Authorization: Bearer abcdefghijklmnop1234567890', 'secret'), ['abcdefghijklmnop1234567890']);
  assert.deepEqual(values('PIN：1234', 'secret'), ['1234']);
});

test('表格中键和值分在相邻两格（制表符）也能识别', () => {
  assert.deepEqual(values('账号\tadmin\n密码\tQwer2026', 'secret'), ['Qwer2026']);
});

test('连接串里的密码、无关键词的知名凭据、私钥块正文', () => {
  assert.deepEqual(values('mysql://root:Pa55word@10.0.0.1:3306/db', 'secret'), ['Pa55word']);
  assert.deepEqual(values('日志：AKIAIOSFODNN7EXAMPLE 已泄露', 'secret'), ['AKIAIOSFODNN7EXAMPLE']);
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----';
  const result = analyzeText(pem).findings.filter((item) => item.type === 'secret');
  assert.equal(result.length, 1);
  assert.equal(result[0].value, 'b3BlbnNzaC1rZXk\nAAAABG5vbmU');
  assert.equal(result[0].hint, '私钥内容');
  assert.ok(analyzeText(pem).redactedText.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n'));
  assert.deepEqual(values('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----', 'secret'), []);
});

test('说明文字、占位符、代码变量、模型用量不当作密码', () => {
  const text = '请联系管理员重置密码。密码：见附件。密码：******。Token：128000。pwd = request.form.get("x")。password: ${DB_PASSWORD}。password=required';
  assert.deepEqual(values(text, 'secret'), []);
});

test('强密码在后文单独再出现时补上', () => {
  const result = analyzeText('初始密码：Abc12345。忘记时请用 Abc12345 登录，不要用 XAbc12345。').findings.filter((item) => item.type === 'secret');
  assert.deepEqual(result.map((item) => item.start), [5, 20]);
  assert.equal(result[1].hint, '前文已识别，后文再次出现');
});

test('签字栏里用全角空格撑开的姓名', () => {
  assert.deepEqual(values('负责人：李　岚\n联系人：张 伟，电话略。', 'person'), ['李　岚', '张 伟']);
  assert.deepEqual(values('负责人：李　岚　　日期：2026年1月1日', 'person'), ['李　岚']);
  assert.deepEqual(values('经办人：王 五；', 'person'), ['王 五']);
});

test('已识别姓名的后文出现：两字名要求两侧不紧挨汉字，三字名紧挨时标为需核对', () => {
  const two = analyzeText('负责人：李　岚。会后由 李岚 确认；李　岚签字后归档。').findings.filter((item) => item.type === 'person');
  assert.deepEqual(two.map((item) => item.value), ['李　岚', '李岚']);
  assert.equal(two[1].reviewRequired, true);
  const three = analyzeText('联系人：王小明。王小明负责付款。').findings.filter((item) => item.type === 'person');
  assert.deepEqual(three.map((item) => [item.value, item.reviewRequired]), [['王小明', false], ['王小明', true]]);
});

test('密码类型可单独关闭', () => {
  const result = analyzeText('密码：Abc12345', { enabledTypes: ['person'] });
  assert.equal(result.findings.length, 0);
});
