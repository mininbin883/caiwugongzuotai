// 税务筛查模式的假名：换掉身份，保留规则需要的类别特征。
// - 个人 → 三字假名（常见姓氏开头），筛查脚本仍当作个人；
// - 单位 → 保留地名前缀、行业词、组织形式和“（个体工商户）”等字样，只把字号换成 Q 编号；
// - 统一社会信用代码 → 保留前 8 位（登记机关、类别、区划码），其余换成假号并重算校验位；
// - 身份证号 → 保留前 6 位区划码，出生日期与顺序码换成假的，校验位正确；
// - 地址 → 保留到区县，其余换成“地址Q编号”；号码类换成同长度假号。
// 同一类型、同一取值始终得到同一个假名；假名不与资料原文重复，可以准确换回。

const SURNAMES = [...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何林高罗'];
const STEMS = [...'甲乙丙丁戊己庚辛壬癸'];
const BRANCHES = [...'子丑寅卯辰巳午未申酉戌亥'];
const USCC_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECKS = '10X98765432';

// 组织形式（从长到短匹配）与行业词。行业词保留，供“加油站”“运输”“劳务”“建材”等规则判断。
const ORG_FORMS = ['集团股份有限公司', '集团有限公司', '股份有限公司', '有限责任公司', '有限公司', '分公司', '子公司', '公司', '集团',
  '专业合作社', '合作社', '事务所', '研究院', '研究所', '设计院', '服务中心', '中心', '经营部', '服务部', '经销部', '经销处', '批发部',
  '加工部', '修理部', '维修部', '租赁部', '劳务部', '运输部', '门市部', '商行', '商店', '超市', '工作室', '加油站', '加工厂', '养殖场',
  '种植场', '家庭农场', '支行', '分行', '银行', '委员会', '局', '院', '所', '站', '厂', '店', '馆', '坊', '部', '处', '行', '社', '队', '场'];
const INDUSTRY_WORDS = ['建筑安装工程', '建筑工程配套', '建设工程', '工程建设', '建筑工程', '市政工程', '路桥工程', '公路工程', '交通工程',
  '安装工程', '水利工程', '园林工程', '装饰工程', '钢结构工程', '电力工程', '通讯工程', '工程材料', '工程设备', '工程机械', '工程管理',
  '工程质量检测', '质量检测', '建筑劳务', '劳务派遣', '人力资源', '建筑材料', '建材', '混凝土', '水泥制品', '钢结构', '管业', '机械租赁',
  '设备租赁', '机械设备', '吊装机械', '模板', '预应力', '石材', '沥青', '砂石', '苗木', '园艺', '园林', '绿化', '环保', '节能', '热力', '燃气',
  '电力', '电气', '照明电器', '电器', '五金', '化工', '塑料制品', '塑料', '玻璃钢', '橡胶', '包装机械', '包装', '装饰', '装修', '物流', '运输',
  '货运', '客运', '商贸', '经贸', '工贸', '贸易', '实业', '置业', '房地产', '地产', '投资', '科技', '信息', '咨询', '管理咨询', '企业管理',
  '餐饮', '饭店', '酒店', '宾馆', '全羊', '烧烤', '茶行', '茶业', '酒业', '超市', '加油站', '石化', '石油', '汽修', '汽车', '机械', '交通',
  '建设', '工程', '劳务', '服务', '市政', '铁路', '公路', '水务', '供水', '供电'];
const REGION_UNIT = /^(?:[\p{Script=Han}]{2,9}?(?:省|自治区|特别行政区|市|自治州|地区|盟|区|县|旗|镇|乡|街道))/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usccCheck(body17) {
  const sum = USCC_WEIGHTS.reduce((total, weight, index) => total + USCC_ALPHABET.indexOf(body17[index]) * weight, 0);
  return USCC_ALPHABET[(31 - (sum % 31)) % 31];
}

function idCheck(body17) {
  const sum = ID_WEIGHTS.reduce((total, weight, index) => total + Number(body17[index]) * weight, 0);
  return ID_CHECKS[sum % 11];
}

function luhnCheckDigit(body) {
  let sum = 0;
  let double = true;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    let digit = Number(body[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

function toBase(value, alphabet, width) {
  let text = '';
  let rest = value;
  do {
    text = alphabet[rest % alphabet.length] + text;
    rest = Math.floor(rest / alphabet.length);
  } while (rest > 0);
  return text.padStart(width, alphabet[0]).slice(-width);
}

/** 把单位名称拆成：地名前缀、字号、行业词、组织形式、括号说明。 */
export function splitOrganizationName(name) {
  let rest = String(name || '').trim();
  let note = '';
  const noteMatch = rest.match(/([（(][^（）()]{1,20}[）)])$/u);
  if (noteMatch) { note = noteMatch[1]; rest = rest.slice(0, -note.length); }
  let region = '';
  for (let guard = 0; guard < 4; guard += 1) {
    const match = rest.match(REGION_UNIT);
    if (!match || match[0].length >= rest.length - 1) break;
    region += match[0];
    rest = rest.slice(match[0].length);
  }
  let form = '';
  for (const candidate of ORG_FORMS) {
    if (rest.endsWith(candidate) && rest.length > candidate.length) { form = candidate; rest = rest.slice(0, -candidate.length); break; }
  }
  // 从末尾逐个剥离行业词（“路通|工程建设”“庆大筑路|工程材料”），剩下的是字号。
  const words = [...INDUSTRY_WORDS].sort((left, right) => right.length - left.length);
  const industryParts = [];
  for (let guard = 0; guard < 6 && rest; guard += 1) {
    const word = words.find((candidate) => rest.endsWith(candidate) && rest.length >= candidate.length);
    if (!word) break;
    industryParts.unshift(word);
    rest = rest.slice(0, -word.length);
  }
  let industry = industryParts.join('');
  // 没有字号（如“潍坊市市政工程股份有限公司”）时，只保留最后一个行业词，免得假名与原名只差一个编号。
  if (!rest && industryParts.length) {
    const last = industryParts.at(-1);
    industry = ['工程', '建设', '劳务', '运输', '物流', '服务', '贸易', '科技', '实业'].find((word) => last.endsWith(word)) || '';
  }
  return { region, brand: rest, industry, form, note };
}

/**
 * 创建假名分配器。reservedText：整批原文，用来保证假名不与原文中已有的文字重复。
 */
export function createPseudonymizer({ reservedText = '' } = {}) {
  const reserved = String(reservedText || '');
  const byKey = new Map();
  const used = new Set();
  const counters = new Map();
  const next = (kind) => {
    const value = (counters.get(kind) || 0) + 1;
    counters.set(kind, value);
    return value;
  };
  const free = (candidate) => candidate && !used.has(candidate) && !reserved.includes(candidate);

  const generators = {
    person: () => {
      for (;;) {
        const index = next('person') - 1;
        const surname = SURNAMES[index % SURNAMES.length];
        const cycle = Math.floor(index / SURNAMES.length);
        let candidate = `${surname}${STEMS[cycle % STEMS.length]}${BRANCHES[Math.floor(cycle / STEMS.length) % BRANCHES.length]}`;
        // 超过 2,400 个人名时加一个天干，仍是“姓 + 名”的样子。
        if (cycle >= STEMS.length * BRANCHES.length) candidate += STEMS[Math.floor(cycle / (STEMS.length * BRANCHES.length)) % STEMS.length];
        if (free(candidate)) return candidate;
      }
    },
    company: (value) => {
      const parts = splitOrganizationName(value);
      for (;;) {
        const code = `Q${String(next('company')).padStart(3, '0')}`;
        const candidate = `${parts.region}${code}${parts.industry}${parts.form}${parts.note}`;
        if (free(candidate)) return candidate;
      }
    },
    uscc: (value) => {
      const prefix = String(value).toUpperCase().slice(0, 8);
      for (;;) {
        const body = `${prefix}Q${toBase(next('uscc'), USCC_ALPHABET, 8)}`;
        const candidate = `${body}${usccCheck(body)}`;
        if (free(candidate)) return candidate;
      }
    },
    idcard: (value) => {
      const region = String(value).slice(0, 6);
      for (;;) {
        const index = next('idcard');
        const year = 1960 + (index % 40);
        const month = String(1 + (Math.floor(index / 40) % 12)).padStart(2, '0');
        const day = String(1 + (Math.floor(index / 480) % 28)).padStart(2, '0');
        const body = `${region}${year}${month}${day}${String(900 + (index % 100)).padStart(3, '0')}`;
        const candidate = `${body}${idCheck(body)}`;
        if (free(candidate)) return candidate;
      }
    },
    mobile: (value) => {
      const prefix = String(value).match(/^(?:\+?86[- ]?)/u)?.[0] || '';
      for (;;) {
        const candidate = `${prefix}199${String(next('mobile')).padStart(8, '0')}`;
        if (free(candidate)) return candidate;
      }
    },
    landline: (value) => {
      const area = String(value).match(/^0\d{2,3}[- ]?/u)?.[0] || '';
      const localLength = String(value).slice(area.length).replace(/\D/g, '').length || 8;
      for (;;) {
        const candidate = `${area}5${String(next('landline')).padStart(localLength - 1, '0')}`;
        if (free(candidate)) return candidate;
      }
    },
    bankcard: (value) => {
      const digits = String(value).replace(/\D/g, '');
      const head = digits.slice(0, 6);
      for (;;) {
        const middle = `9${String(next('bankcard')).padStart(Math.max(1, digits.length - 8), '0')}`.slice(-(digits.length - 7));
        const body = `${head}${middle}`.slice(0, digits.length - 1);
        const candidate = `${body}${luhnCheckDigit(body)}`;
        if (free(candidate)) return candidate;
      }
    },
    address: (value) => {
      const text = String(value);
      let keep = '';
      let rest = text;
      for (let guard = 0; guard < 4; guard += 1) {
        const match = rest.match(REGION_UNIT);
        if (!match) break;
        keep += match[0];
        rest = rest.slice(match[0].length);
      }
      for (;;) {
        const candidate = `${keep}地址Q${String(next('address')).padStart(3, '0')}`;
        if (free(candidate)) return candidate;
      }
    },
    email: () => {
      for (;;) {
        const candidate = `q${String(next('email')).padStart(4, '0')}@example.com`;
        if (free(candidate)) return candidate;
      }
    },
    ipv4: () => {
      for (;;) {
        const index = next('ipv4');
        const candidate = `10.${Math.floor(index / 65536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`;
        if (free(candidate)) return candidate;
      }
    }
  };

  return {
    supports: (type) => Object.hasOwn(generators, type),
    assign(type, value) {
      const key = `${type}\u0000${value}`;
      let pseudonym = byKey.get(key);
      if (!pseudonym) {
        pseudonym = generators[type](value);
        used.add(pseudonym);
        byKey.set(key, pseudonym);
      }
      return pseudonym;
    }
  };
}

/**
 * 与 createSharedTokenizer 接口一致的批次分配器：支持的类型用假名，其余（密码、自定义词等）仍用方括号代号。
 */
export function createPseudonymTokenizer({ reservedText = '', tokenizer }) {
  const pseudonymizer = createPseudonymizer({ reservedText });
  const byKey = new Map();
  const mapping = [];
  return {
    nonce: tokenizer.nonce,
    tokenize(text, findings) {
      const source = String(text || '');
      const active = (Array.isArray(findings) ? findings : [])
        .filter((item) => item?.enabled !== false && Number.isInteger(item?.start) && Number.isInteger(item?.end) && item.end > item.start && item.end <= source.length)
        .slice()
        .sort((left, right) => left.start - right.start || left.end - right.end);
      const assignments = [];
      const others = [];
      for (const finding of active) {
        const type = String(finding.type || 'custom');
        if (!pseudonymizer.supports(type)) { others.push(finding); continue; }
        const value = source.slice(finding.start, finding.end);
        const key = `${type}\u0000${value}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { token: pseudonymizer.assign(type, value), value, type, label: String(finding.label || type), occurrences: 0, form: 'pseudonym' };
          byKey.set(key, entry);
          mapping.push(entry);
        }
        entry.occurrences += 1;
        assignments.push({ start: finding.start, end: finding.end, token: entry.token });
      }
      if (others.length) {
        const tokenized = tokenizer.tokenize(source, others);
        assignments.push(...tokenized.assignments);
      }
      assignments.sort((left, right) => left.start - right.start || left.end - right.end);
      const parts = [];
      let cursor = 0;
      for (const item of assignments) {
        if (item.start < cursor) continue;
        parts.push(source.slice(cursor, item.start), item.token);
        cursor = item.end;
      }
      parts.push(source.slice(cursor));
      return { tokenizedText: parts.join(''), assignments };
    },
    mapping: () => [...mapping.map((entry) => ({ ...entry })), ...tokenizer.mapping()],
    size: () => mapping.length + tokenizer.size()
  };
}

/** 假名换回：按长度从长到短一次替换；数字、字母开头结尾的假名要求两侧不紧挨字母数字。 */
export function restorePseudonyms(input, mapping) {
  const text = String(input || '');
  const entries = (Array.isArray(mapping) ? mapping : []).filter((entry) => entry?.form === 'pseudonym' && entry.token && entry.value);
  if (!entries.length || !text) return { text, count: 0, counts: new Map() };
  const byToken = new Map(entries.map((entry) => [entry.token, entry.value]));
  // 报告里可能把“潍坊市Q007工程建设有限公司”简写成“Q007”：单独出现的单位编号也换回全称。
  for (const entry of entries) {
    const code = entry.type === 'company' ? entry.token.match(/Q\d{3,}/u)?.[0] : null;
    if (code && !byToken.has(code)) byToken.set(code, entry.value);
  }
  const pattern = new RegExp([...byToken.keys()]
    .sort((left, right) => right.length - left.length)
    .map((token) => {
      const body = escapeRegExp(token);
      const before = /^[0-9A-Za-z]/u.test(token) ? '(?<![0-9A-Za-z])' : '';
      const after = /[0-9A-Za-z]$/u.test(token) ? '(?![0-9A-Za-z])' : '';
      return `${before}${body}${after}`;
    }).join('|'), 'gu');
  const counts = new Map();
  let count = 0;
  const restored = text.replace(pattern, (match) => {
    count += 1;
    counts.set(match, (counts.get(match) || 0) + 1);
    return byToken.get(match);
  });
  return { text: restored, count, counts };
}
