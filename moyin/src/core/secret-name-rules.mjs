// 密码/密钥、空格撑开的姓名、已识别值的后文重复出现。
// 全部为待核对候选：不确定的结果带 reviewRequired 与 hint，交给人工确认。

const HAN = '\\p{Script=Han}';
const SPACE_CLASS = '[ \\u3000\\u00A0\\u2002\\u2003\\u2009]';

// ---------- 密码与密钥 ----------

// 中文关键词：允许冒号、等号，或表格导出的制表符（键和值分在相邻两格）。
const ZH_SECRET_KEYS = [
  '初始密码', '登录密码', '登陆密码', '默认密码', '临时密码', '新密码', '原密码', '支付密码', '交易密码', '取款密码',
  '查询密码', '管理员密码', '数据库密码', '邮箱密码', '开机密码', 'WiFi密码', 'wifi密码', '无线密码', '密码',
  '口令', '验证码', '动态码', '私钥口令', '私钥', '密钥', '秘钥', '授权码', '激活码', '令牌'
];
// 英文关键词（不区分大小写）。PIN 要求大写或 PIN码，避免与普通单词混淆。
const EN_SECRET_KEYS = [
  'password', 'passwd', 'passphrase', 'pwd', 'pass', 'db_pass(?:word)?', 'secret', 'client[_-]?secret', 'app[_-]?secret',
  'secret[_-]?(?:access[_-]?)?key', 'api[_-]?key', 'apikey', 'x-api-key', 'access[_-]?key(?:[_-]?(?:secret|id))?',
  'accesskey\\s*secret', 'access[_-]?token', 'refresh[_-]?token', 'auth[_-]?token', 'id[_-]?token', 'session[_-]?token',
  'private[_-]?key', 'signing[_-]?key', 'encryption[_-]?key', 'token'
];

const PLACEHOLDER_VALUE = new RegExp([
  '^[*•●xX#·.\\-_]+$',
  '^(?:null|none|nil|undefined|true|false|n/?a|tbd|todo|changeme|your[_-]?\\w*|example|xxx+|\\*+)$',
  '^\\$\\{.*\\}$', '^\\$[A-Z_][A-Z0-9_]*$', '^%[A-Z_]+%$', '^\\{\\{.*\\}\\}$', '^<.*>$',
  '^(?:os\\.environ|process\\.env|env\\.|request\\.|req\\.|config\\.|settings\\.|self\\.|this\\.|getenv|input\\()',
  '\\(\\s*\\)?$'
].join('|'), 'iu');
const HAN_ONLY = /^[\p{Script=Han}，、。！？（）《》“”‘’：；\s]+$/u;
const VERSION_LIKE = /^v?\d+(?:\.\d+){1,3}$/iu;
const FILE_LIKE = /\.(?:docx?|xlsx?|pdf|txt|csv|zip|rar|7z|png|jpe?g|pem|key|crt|cer|p12|pfx)$/iu;

function trimValue(raw) {
  let value = raw;
  // 去掉成对引号与尾部标点。
  value = value.replace(/^['"“‘`]+/u, '').replace(/['"”’`]+$/u, '');
  value = value.replace(/[，,。；;、)）\]】>》]+$/u, '');
  return value;
}

function secretValueAcceptable(value, keyword) {
  if (!value || value.length < 4 || value.length > 512) return false;
  if (PLACEHOLDER_VALUE.test(value)) return false;
  if (HAN_ONLY.test(value)) return false; // “见附件”“已重置”“请联系管理员”
  if (VERSION_LIKE.test(value) || FILE_LIKE.test(value)) return false;
  const lower = keyword.toLowerCase();
  // “Token：128000”“tokens=4096”多为模型用量，不是凭据。
  if (/^(?:token|令牌)$/u.test(lower) && /^\d+$/u.test(value)) return false;
  // 英文 password 后只有字母的词（如 password=required）通常是说明文字。
  if (/^(?:password|passwd|pass|pwd)$/u.test(lower) && /^[A-Za-z]+$/u.test(value) && value.length < 12) return false;
  // 验证码/口令/PIN 允许纯数字短码，但至少 4 位。
  if (/^\d+$/u.test(value) && value.length < 4) return false;
  return true;
}

function keyValueRegex() {
  const zh = ZH_SECRET_KEYS.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const en = EN_SECRET_KEYS.join('|');
  // 关键词前不能紧挨字母，避免 “bypass=”“compass:”；值取到空白或分隔符为止。
  return new RegExp(
    `(?:(?<kzh>${zh}|PIN码?|PIN)(?:[为是]|${SPACE_CLASS})*(?:[：:=＝]|\\t)|` +
    `(?<![A-Za-z0-9_])(?:--?)?(?<ken>${en})["']?${SPACE_CLASS}*(?:[：:=＝]|=>|\\t))` +
    `${SPACE_CLASS}*(?<val>"[^"\\n]{1,512}"|'[^'\\n]{1,512}'|[^\\s，,；;。）)】\\]]{1,512})`,
    'giu'
  );
}

const BEARER = /\b(?:Authorization\s*[:=]\s*)?(?:Bearer|Basic|Token)\s+(?<val>[A-Za-z0-9\-._~+/]{16,}=*)/gu;
const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]{1,20}:\/\/(?<user>[^\s:@/]{1,64}):(?<val>[^\s@/]{1,128})@[^\s/]+/giu;
const PEM_BLOCK = /-----BEGIN (?<kind>(?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----\r?\n(?<body>[\s\S]*?)\r?\n-----END \k<kind>-----/gu;
const SSH2_BLOCK = /---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\r?\n(?<body>[\s\S]*?)\r?\n---- END SSH2 ENCRYPTED PRIVATE KEY ----/gu;
const PUTTY_PRIVATE = /^Private-Lines:\s*\d+\r?\n(?<body>(?:[A-Za-z0-9+/=]+\r?\n?)+)/gmu;
// 没有关键词也能确认的知名凭据格式。
const BARE_KEYS = [
  ['AWS Access Key', /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/gu],
  ['GitHub Token', /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,255}(?![A-Za-z0-9_])/gu],
  ['GitHub Token', /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{60,255}/gu],
  ['API Key', /(?<![A-Za-z0-9_-])sk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gu],
  ['Slack Token', /(?<![A-Za-z0-9-])xox[abprs]-[A-Za-z0-9-]{10,}/gu],
  ['Google API Key', /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/gu],
  ['JWT', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gu],
  ['阿里云 AccessKey ID', /(?<![A-Za-z0-9])LTAI[A-Za-z0-9]{12,20}(?![A-Za-z0-9])/gu]
];

function pushSecret(results, text, start, value, hint, extra = {}) {
  if (!value) return;
  results.push({ type: 'secret', value, start, end: start + value.length, hint, ...extra });
}

export function collectSecrets(input) {
  const text = String(input || '');
  const results = [];

  for (const match of text.matchAll(keyValueRegex())) {
    const keyword = match.groups.kzh || match.groups.ken;
    const rawValue = match.groups.val;
    const value = trimValue(rawValue);
    if (!secretValueAcceptable(value, keyword)) continue;
    const valueOffset = match[0].length - rawValue.length + rawValue.indexOf(value);
    const isKey = /密钥|秘钥|私钥|key|secret|token|令牌|授权码|激活码/iu.test(keyword);
    pushSecret(results, text, match.index + valueOffset, value, isKey ? '疑似密钥' : '疑似密码');
  }
  for (const match of text.matchAll(BEARER)) {
    const value = match.groups.val;
    pushSecret(results, text, match.index + match[0].lastIndexOf(value), value, '疑似密钥');
  }
  for (const match of text.matchAll(CONNECTION_STRING)) {
    const value = match.groups.val;
    if (PLACEHOLDER_VALUE.test(value)) continue;
    const offset = match[0].indexOf(`:${value}@`) + 1;
    pushSecret(results, text, match.index + offset, value, '疑似密码');
  }
  for (const regex of [PEM_BLOCK, SSH2_BLOCK, PUTTY_PRIVATE]) {
    for (const match of text.matchAll(regex)) {
      const body = match.groups.body.replace(/\s+$/u, '');
      if (!body.trim()) continue;
      pushSecret(results, text, match.index + match[0].indexOf(body), body, '私钥内容');
    }
  }
  for (const [name, regex] of BARE_KEYS) {
    for (const match of text.matchAll(regex)) pushSecret(results, text, match.index, match[0], `疑似密钥（${name}）`);
  }
  return results;
}

// ---------- 空格撑开的姓名 ----------

const NAME_LABELS = [
  '法定代表人', '授权代表', '委托代理人', '项目负责人', '项目经理', '负责人', '联系人', '经办人', '签字人', '签署人', '签字',
  '代表人', '审核人', '审批人', '批准人', '复核人', '制表人', '制单人', '记账人', '出纳', '会计', '收款人', '付款人', '收件人',
  '申请人', '承办人', '见证人', '监护人', '姓名'
];
const SPACED_NAME = new RegExp(
  `(?:${NAME_LABELS.join('|')})${SPACE_CLASS}*[：:]${SPACE_CLASS}*` +
  `(?<name>[${HAN}](?:${SPACE_CLASS}{1,3}[${HAN}]){1,3})` +
  `(?=${SPACE_CLASS}*(?:\\r?\\n|$)|${SPACE_CLASS}*[，,；;。\\t]|${SPACE_CLASS}{2,}|[ \\u3000]{1}(?=[${HAN}]{2,}[：:]))`,
  'gu'
);

export function compactName(value) {
  return String(value || '').replace(new RegExp(SPACE_CLASS, 'gu'), '');
}

export function collectSpacedNames(input) {
  const text = String(input || '');
  const results = [];
  for (const match of text.matchAll(SPACED_NAME)) {
    const name = match.groups.name;
    if (!new RegExp(SPACE_CLASS, 'u').test(name)) continue; // 没有空格的由常规规则处理
    const compact = compactName(name);
    if (compact.length < 2 || compact.length > 4) continue;
    const start = match.index + match[0].lastIndexOf(name);
    results.push({ type: 'person', value: name, start, end: start + name.length, canonical: compact, hint: '空格撑开的姓名' });
  }
  return results;
}

// ---------- 后文重复出现 ----------

const SPACE_CHARS = new Set([' ', '\u3000', '\u00A0', '\u2002', '\u2003', '\u2009']);
const isHan = (char) => Boolean(char) && /\p{Script=Han}|·/u.test(char);
const isWordChar = (char) => Boolean(char) && /[A-Za-z0-9_]/u.test(char);

function adjacentHan(text, start, end) {
  return /\p{Script=Han}/u.test(text[start - 1] || '') || /\p{Script=Han}/u.test(text[end] || '');
}

/** 覆盖掩码：O(1) 判断某区间是否与已有候选重叠，避免候选很多时的平方复杂度。 */
export class CoverageMask {
  constructor(length) { this.bits = new Uint8Array(length + 1); }
  mark(start, end) { this.bits.fill(1, Math.max(0, start), end); }
  overlaps(start, end) { for (let index = start; index < end; index += 1) if (this.bits[index]) return true; return false; }
  covers(start, end) { for (let index = start; index < end; index += 1) if (!this.bits[index]) return false; return end > start; }
}

/** 从 index 开始读取最多 4 个汉字（字间可夹最多 3 个空格），返回各长度对应的结束位置。 */
function readSpacedHan(text, index) {
  const ends = [];
  let compact = '';
  let cursor = index;
  while (compact.length < 4 && cursor < text.length && isHan(text[cursor])) {
    compact += text[cursor];
    cursor += 1;
    ends.push({ compact, end: cursor });
    let gap = 0;
    while (gap < 3 && SPACE_CHARS.has(text[cursor + gap])) gap += 1;
    if (gap) {
      if (!isHan(text[cursor + gap])) break;
      cursor += gap;
    }
  }
  return ends;
}

// 对规则识别出的姓名、公司和密码，在全文补上其他出现位置。单次扫描，复杂度与正文长度线性相关。
export function collectRepeatedValues(input, findings) {
  const text = String(input || '');
  const mask = new CoverageMask(text.length);
  for (const finding of findings) mask.mark(finding.start, finding.end);

  const names = new Set();
  const literals = new Map(); // 前两个字符 -> [{ type, value }]
  for (const finding of findings) {
    if (finding.source && finding.source !== 'rule') continue;
    if (finding.type === 'person') {
      const canonical = finding.canonical || compactName(finding.value);
      if (/^[\p{Script=Han}·]{2,4}$/u.test(canonical)) names.add(canonical);
    } else if (finding.type === 'secret' || finding.type === 'company') {
      const value = finding.value;
      if (finding.type === 'secret') {
        // 只补足够“像密码”的值：6 位以上且字母数字混合，或 10 位以上。
        const strong = (value.length >= 6 && /[A-Za-z]/u.test(value) && /\d/u.test(value)) || value.length >= 10;
        if (!strong || value.includes('\n')) continue;
      } else if (value.length < 4) continue;
      const key = value.slice(0, 4);
      let bucket = literals.get(key);
      if (!bucket) literals.set(key, (bucket = []));
      if (!bucket.some((item) => item.value === value && item.type === finding.type)) bucket.push({ type: finding.type, value });
    }
  }
  for (const bucket of literals.values()) bucket.sort((left, right) => right.value.length - left.value.length);

  const results = [];
  for (let index = 0; index < text.length; index += 1) {
    const bucket = literals.get(text.slice(index, index + 4));
    if (bucket) {
      const hit = bucket.find(({ type, value }) => text.startsWith(value, index) &&
        (type !== 'secret' || (!isWordChar(text[index - 1]) && !isWordChar(text[index + value.length]))));
      if (hit && !mask.overlaps(index, index + hit.value.length)) {
        const end = index + hit.value.length;
        mask.mark(index, end);
        results.push({ type: hit.type, value: hit.value, start: index, end, hint: '前文已识别，后文再次出现', reviewRequired: false });
        index = end - 1;
        continue;
      }
    }
    if (names.size && isHan(text[index])) {
      const options = readSpacedHan(text, index);
      for (let option = options.length - 1; option >= 0; option -= 1) {
        const { compact, end } = options[option];
        if (compact.length < 2 || !names.has(compact)) continue;
        // 两个字的名字两侧不能紧挨汉字（避免把词的一部分当成姓名）；三四个字的名字紧挨汉字时标为需要核对。
        if (compact.length === 2 && (isHan(text[index - 1]) || isHan(text[end]))) continue;
        if (mask.overlaps(index, end)) continue;
        mask.mark(index, end);
        results.push({
          type: 'person', value: text.slice(index, end), start: index, end, canonical: compact,
          hint: '前文已识别，后文再次出现', reviewRequired: compact.length === 2 || adjacentHan(text, index, end)
        });
        index = end - 1;
        break;
      }
    }
  }
  return results;
}
