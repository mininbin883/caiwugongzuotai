import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import * as engine from '../src/core/redaction-engine.mjs';
import * as reversible from '../src/core/reversible-token-engine.mjs';
import * as pseudonym from '../src/core/pseudonym-engine.mjs';

const require = createRequire(import.meta.url);
const { prepareReversibleBatch, screeningAiPrompt } = require('../src/services/batch-reversible-service.cjs');
const { listRestorableFiles, restoreFolderFiles } = require('../src/services/restore-folder-service.cjs');
const vault = require('../src/services/vault-service.cjs');
const { validators } = engine;

test('单位名称拆分：保留地名、行业词、组织形式和个体户字样，只换字号', () => {
  const p = pseudonym.createPseudonymizer();
  assert.equal(p.assign('company', '潍坊市示例工程建设有限公司'), '潍坊市Q001工程建设有限公司');
  assert.equal(p.assign('company', '奎文区示例全羊店（个体工商户）'), '奎文区Q002全羊店（个体工商户）');
  assert.equal(p.assign('company', '示例区示例加油站'), '示例区Q003加油站');
  assert.equal(p.assign('company', '示例银行示例支行'), 'Q004支行');
  // 没有字号的名称只保留通用行业词，避免假名与原名只差一个编号
  assert.equal(p.assign('company', '潍坊市市政工程股份有限公司'), '潍坊市Q005工程股份有限公司');
  assert.equal(p.assign('company', '潍坊市示例工程建设有限公司'), '潍坊市Q001工程建设有限公司');
});

test('个人假名：常见姓氏开头的三字名；同一人同一假名；不与原文重复', () => {
  const p = pseudonym.createPseudonymizer({ reservedText: '王甲子已在原文出现' });
  const first = p.assign('person', '赵一鸣');
  assert.match(first, /^[王李张刘陈杨黄赵吴周徐孙马朱胡郭何林高罗][甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/u);
  assert.notEqual(first, '王甲子');
  assert.equal(p.assign('person', '赵一鸣'), first);
  assert.notEqual(p.assign('person', '钱二多'), first);
});

test('税号、身份证号、银行卡号：保留前缀与格式，校验位正确', () => {
  const p = pseudonym.createPseudonymizer();
  const uscc = p.assign('uscc', '91370700729268538R');
  assert.equal(uscc.slice(0, 8), '91370700');
  assert.ok(validators.usccValid(uscc));
  const getihu = p.assign('uscc', '92370705MA3FP3YM7P');
  assert.ok(getihu.startsWith('92370705'));
  const id = p.assign('idcard', '11010519491231002X');
  assert.equal(id.slice(0, 6), '110105');
  assert.ok(validators.idCardValid(id));
  const card = p.assign('bankcard', '6222021234567890128');
  assert.equal(card.length, 19);
  assert.ok(card.startsWith('622202'));
  assert.ok(validators.luhnValid(card));
  assert.equal(p.assign('address', '山东省潍坊市寒亭区永康西街88号'), '山东省潍坊市寒亭区地址Q001');
});

test('税务筛查批次：同一对象跨文件同一假名；换回后与原文一致；单独出现的 Q 编号也能换回', () => {
  const jobs = [
    { id: 'a', result: { name: '示例工程建设有限公司2024年科目余额表.xlsx', text: '科目代码\t科目名称\t余额\n1001\t库存现金\t1\n1221\t其他应收款\t0\n1221.001\t赵一鸣\t5\n2202\t应付账款\t0\n2202.001\t潍坊市星河建材有限公司\t9' } },
    { id: 'b', result: { name: '2025年发票.xlsx', text: '销方名称\t销方识别号\t开票人\n潍坊市星河建材有限公司\t91370700729268538R\t赵一鸣\n潍坊市星河建材有限公司\t91370700729268538R\t钱二多' } }
  ];
  const batch = prepareReversibleBatch(jobs, {}, engine, reversible, { screening: true, pseudonym });
  const of = (value) => batch.mapping.find((entry) => entry.value === value);
  assert.equal(of('潍坊市星河建材有限公司').token, '潍坊市Q001建材有限公司');
  assert.equal(of('潍坊市星河建材有限公司').form, 'pseudonym');
  for (const job of jobs) {
    const text = batch.prepared.get(job.id).redactedText;
    assert.ok(!text.includes('星河') && !text.includes('赵一鸣'));
    assert.equal(reversible.restoreTokens(text, batch.mapping, { mode: 'analysis' }).restoredText, job.result.text);
  }
  const report = `批次 MI-000123：供应商 Q001 与 ${of('赵一鸣').token} 关系密切；文件 MI-000123-02-2025年发票-脱敏副本.xlsx 已读取。`;
  assert.equal(reversible.restoreTokens(report, batch.mapping, { mode: 'analysis' }).restoredText, '批次 MI-000123：供应商 潍坊市星河建材有限公司 与 赵一鸣 关系密切；文件 2025年发票.xlsx 已读取。');
  const prompt = screeningAiPrompt('MI-000123', 2, batch.mapping);
  assert.match(prompt, /construction-tax-risk/u);
  for (const entry of batch.mapping) assert.equal(prompt.includes(entry.value), false);
});

test('仓库接受假名形式的对照表', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moyin-pseudo-vault-'));
  const file = path.join(directory, 'v.miyin-vault');
  const context = await vault.createVault(file, 'Pseudonym-Test-2026!');
  const saved = await vault.addVaultEntry(context, {
    kind: 'reversible-map', name: '批次（税务筛查）', text: '潍坊市Q001建材有限公司',
    mapping: [{ token: '潍坊市Q001建材有限公司', value: '潍坊市星河建材有限公司', type: 'company', label: '公司名称', occurrences: 1, form: 'pseudonym' }],
    findingCount: 1, findingTypes: ['company']
  });
  const entry = await vault.readVaultEntry(context, saved.id);
  assert.equal(entry.mapping[0].form, 'pseudonym');
  await fs.rm(directory, { recursive: true, force: true });
});

test('整个文件夹还原：Markdown、TXT 换回，.json 跳过，编号从路径识别', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moyin-folder-'));
  const folder = path.join(root, 'MI-000123-税务筛查资料', '筛查结果');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '筛查报告.md'), '﻿# 报告\n张甲子 向 潍坊市Q001建材有限公司 付款。', 'utf8');
  await fs.writeFile(path.join(folder, 'result.json'), '{}', 'utf8');
  const mapping = [
    { token: '张甲子', value: '赵一鸣', type: 'person', occurrences: 1, form: 'pseudonym' },
    { token: '潍坊市Q001建材有限公司', value: '潍坊市星河建材有限公司', type: 'company', occurrences: 1, form: 'pseudonym' }
  ];
  const listed = await listRestorableFiles(folder);
  assert.equal(listed.fileNumber, 'MI-000123');
  assert.deepEqual(listed.skipped, ['result.json']);
  const result = await restoreFolderFiles(folder, listed.files, mapping, { restoreTokens: reversible.restoreTokens });
  const restored = await fs.readFile(path.join(result.outputDirectory, '筛查报告.md'), 'utf8');
  assert.equal(restored, '﻿# 报告\n赵一鸣 向 潍坊市星河建材有限公司 付款。');
  assert.ok(result.outputDirectory.endsWith('筛查结果-已还原'));
  await fs.rm(root, { recursive: true, force: true });
});
