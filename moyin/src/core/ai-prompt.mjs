// 生成“给 AI 的要求”：只含文件编号、代号格式和各类代号的数量，不含任何原文、原文件名或代号对应的真实值。

const TYPE_NAMES = Object.freeze({
  company: '公司/单位', person: '姓名', mobile: '手机号', landline: '电话', idcard: '身份证号', uscc: '信用代码',
  email: '邮箱', bankcard: '银行账号', address: '地址', ipv4: 'IP 地址', secret: '密码/密钥', custom: '其他信息'
});

/**
 * @param {{ fileNumber: string, mapping: Array<{token:string,type?:string}>, formatLabel?: string }} input
 */
export function buildAiPrompt({ fileNumber, mapping = [], formatLabel = '' } = {}) {
  const counts = new Map();
  for (const entry of mapping) {
    const name = TYPE_NAMES[entry?.type] || TYPE_NAMES.custom;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const sample = mapping[0]?.token || '[MI_XXXXXXXX_001]';
  const summary = [...counts.entries()].map(([name, count]) => `${name} ${count} 个`).join('、');
  const fileLabel = `文件 ${fileNumber || '（编号）'}`;
  return [
    `我会发给你一份已脱敏的文件「${fileLabel}」${formatLabel ? `（${formatLabel}）` : ''}。`,
    `文件里形如 ${sample} 的方括号代号，代表被隐藏的真实信息${summary ? `（本文件共有：${summary}）` : ''}。`,
    '',
    '处理时请遵守：',
    '1. 原样保留所有方括号代号，包括方括号本身；不要改写、拆分、翻译、合并、补全或加空格。',
    '2. 不要猜测代号代表的真实内容，也不要用“某公司”“张某”之类的称呼替换代号。',
    '3. 提到同一个对象时，始终使用同一个代号；不要编造文件里没有的新代号。',
    '4. 如果需要返回文件，请保持原来的格式（表格保持表格），并在开头注明「' + fileLabel + '」。',
    '',
    '我的具体要求：',
    '（在这里写你的要求。提到公司和人时请用代号，不要写真实名称，也不要写原文件名。）'
  ].join('\n');
}
