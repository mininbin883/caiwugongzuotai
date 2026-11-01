'use strict';

const path = require('node:path');

// 批次可逆模式第一步：整批统一识别并分配代号（同一对象全批同一个代号），文件名中的敏感词也换成代号。
function prepareReversibleBatch(jobs, analysisOptions, engine, reversible) {
  const tokenizer = reversible.createSharedTokenizer();
  const prepared = new Map();
  const safeJobs = [];
  const sections = [];
  let findingCount = 0;
  const findingTypes = new Set();
  // 第一轮：逐个文件识别，汇总整批认出的对象，作为第二轮的“本批词表”。
  // 这样一个文件里认出的公司、人名，在其他文件里即使写法让规则认不出（如“支付××有限公司货款”），也会被隐藏。
  const batchTerms = collectBatchTerms(jobs, analysisOptions, engine);
  const mergedOptions = mergeTypedTerms(analysisOptions, batchTerms);
  for (const [index, job] of jobs.entries()) {
    const analysis = engine.analyzeText(job.result.text, { ...mergedOptions, style: 'mask' });
    const enabled = analysis.findings.filter((item) => item.enabled !== false);
    const tokenized = tokenizer.tokenize(job.result.text, enabled);
    const tokenByRange = new Map(tokenized.assignments.map((item) => [`${item.start}:${item.end}`, item.token]));
    const findings = enabled
      .filter((item) => tokenByRange.has(`${item.start}:${item.end}`))
      .map((item) => ({ ...item, replacement: tokenByRange.get(`${item.start}:${item.end}`) }));
    prepared.set(job.id, { findings, redactedText: tokenized.tokenizedText });
    findingCount += findings.length;
    for (const item of findings) findingTypes.add(item.type);
    // 文件名（常含公司名、人名）同样识别并换成本批代号。
    const parsed = path.parse(job.result.name || `文件${index + 1}`);
    const nameAnalysis = engine.analyzeText(parsed.name, { ...analysisOptions, style: 'mask', tableColumns: false });
    const nameTokens = tokenizer.tokenize(parsed.name, nameAnalysis.findings.filter((item) => item.enabled !== false));
    const safeName = `${nameTokens.tokenizedText}${parsed.ext}`;
    safeJobs.push({ ...job, result: { ...job.result, name: safeName } });
    sections.push(`【文件 ${index + 1}/${jobs.length}：${safeName}】\n${tokenized.tokenizedText}`);
  }
  return { prepared, safeJobs, mapping: tokenizer.mapping(), text: sections.join('\n\n'), findingCount, findingTypes: [...findingTypes] };
}

function batchAiPrompt(fileNumber, fileCount, mapping) {
  const counts = new Map();
  const names = { company: '公司/单位', person: '姓名', mobile: '手机号', landline: '电话', idcard: '身份证号', uscc: '信用代码', email: '邮箱', bankcard: '银行账号', address: '地址', ipv4: 'IP 地址', secret: '密码/密钥', custom: '其他信息' };
  for (const entry of mapping) counts.set(names[entry.type] || names.custom, (counts.get(names[entry.type] || names.custom) || 0) + 1);
  const summary = [...counts.entries()].map(([name, count]) => `${name} ${count} 个`).join('、');
  return [
    `我会发给你一批已脱敏的文件，共 ${fileCount} 个，批次编号「${fileNumber}」，文件名都以 ${fileNumber} 开头。`,
    `文件里形如 ${mapping[0]?.token || '[MI_XXXXXXXX_001]'} 的方括号代号，代表被隐藏的真实信息${summary ? `（本批共有：${summary}）` : ''}。`,
    '同一个代号在这批所有文件里都指同一个对象（同一家公司、同一个人），可以跨文件、跨年度对比分析。',
    '',
    '处理时请遵守：',
    '1. 原样保留所有方括号代号，包括方括号本身；不要改写、拆分、翻译、合并、补全或加空格。',
    '2. 不要猜测代号代表的真实内容，也不要用“某公司”“张某”之类的称呼替换代号。',
    '3. 提到同一个对象时，始终使用同一个代号；不要编造文件里没有的新代号。',
    `4. 输出报告或返回文件时，请在开头注明「批次 ${fileNumber}」；引用某个文件时写它的序号（如 ${fileNumber}-03）。`,
    '',
    '我的具体要求：',
    '（在这里写你的要求。提到公司和人时请用代号，不要写真实名称，也不要写原文件名。）'
  ].join('\n');
}

const MIN_TERM_LENGTH = { person: 3, company: 4, address: 6, custom: 4 };

function collectBatchTerms(jobs, analysisOptions, engine) {
  const terms = new Map();
  for (const job of jobs) {
    const analysis = engine.analyzeText(job.result.text, { ...analysisOptions, style: 'mask' });
    for (const finding of analysis.findings) {
      if (finding.enabled === false || finding.reviewRequired) continue;
      const value = String(finding.value || '').trim();
      // 两个字的人名容易撞进其他词里（如“王宏”撞进“王宏伟”），不进本批词表；号码类由规则自身保证。
      const min = MIN_TERM_LENGTH[finding.type];
      if (!min || value.length < min || value.includes('\n')) continue;
      if (!terms.has(finding.type)) terms.set(finding.type, new Set());
      terms.get(finding.type).add(value);
    }
  }
  return terms;
}

function mergeTypedTerms(analysisOptions, batchTerms) {
  const typedTerms = { ...(analysisOptions.typedTerms || {}) };
  for (const [type, values] of batchTerms) typedTerms[type] = [...new Set([...(typedTerms[type] || []), ...values])];
  return { ...analysisOptions, typedTerms };
}

module.exports = { prepareReversibleBatch, batchAiPrompt };
