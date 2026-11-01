// 按表头识别表格列：Excel/CSV 导出的台账里，姓名、单位名称等只出现在格子里，没有“联系人：”这样的前缀。
// 先找表头行，再把对应列下面每一格的值按列的类型识别。支持制表符分隔（Excel 提取结果）和简单逗号分隔。

export const COMMON_SURNAMES = new Set([...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫阎段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明佘池查麻苑迟邝嵇郜逄冀相佐鞠芮宦蔺']);
export const COMPOUND_SURNAMES = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '令狐', '长孙', '宇文', '司徒', '夏侯', '端木', '轩辕', '澹台', '呼延', '万俟', '闻人', '西门', '南宫'];

export function looksLikeSurname(name) {
  return COMMON_SURNAMES.has(name[0]) || COMPOUND_SURNAMES.some((surname) => name.startsWith(surname));
}

// 表头 -> 类型。按顺序匹配，先匹配到的优先；人名、单位类要求以关键词结尾，避免“会计科目”“货物名称”之类误判。
const PERSON_HEADER = '姓名|名字|开票人|收款人|复核人|审核人|审批人|经办人|报销人|领款人|交款人|付款人|签收人|收货人|发货人|验收人|制单人|制表人|记账人|出纳|会计|联系人|负责人|法人|法定代表人|代表人|业务员|销售员|采购员|司机|驾驶员|乘车人|乘机人|旅客|员工|职工|雇员|申请人|填报人|操作员|操作人|录入人|创建人|提交人|签字人|责任人|对接人|担保人|借款人|委托人|代理人|持卡人|开户人|户主|学生|患者|病人|会员|收件人|寄件人|销售人员|项目经理';
const COMPANY_HEADER = '销方|购方|购买方|销售方|买方|卖方|收款方|付款方|收款单位|付款单位|开票单位|工作单位|所属单位|供应商|客户|往来单位|公司|企业|商户|开户行|开户银行|承包方|发包方|甲方|乙方|对方单位|交易对手|对手方|开票方|受票方|委托方|受托方';
const HEADER_RULES = [
  // 不是人名、但带“人”字的表头，先排除
  { type: null, pattern: /人数|人次|人民币|人员类别|人员类型|纳税人|识别号|人工费|账号|帐号|编号|编码|代码|电话|日期|时间|金额|类型|状态|性质|级别/u },
  { type: 'idcard', pattern: /身份证|证件号/u },
  { type: 'bankcard', pattern: /银行账号|银行卡号|卡号/u },
  { type: 'address', pattern: /地址$|住址$|所在地$|发生地$|户籍地?$|居住地$|注册地$/u },
  { type: 'company', pattern: new RegExp(`^(?:${COMPANY_HEADER})(?:名称|全称)?$|^(?:${COMPANY_HEADER})名称|^单位(?:名称|全称)$|户名$|开户名`, 'u') },
  { type: 'person', pattern: new RegExp(`(?:${PERSON_HEADER})(?:姓名|名字|名称)?$`, 'u') }
];

export const NAME_STOPWORDS = new Set(['微信', '支付宝', '财付通', '现金', '银行', '转账', '对公', '对私', '公户', '网银', '个人', '公司', '单位', '财务', '出纳员', '会计员', '收银', '收银员', '收银台', '前台', '客服', '税务', '税局', '电子税局', '平台', '待定', '不详细', '无', '暂无', '空', '本人', '其他', '其它', '系统', '管理员', '合计', '小计', '总计', '备注', '未知', '不详', '自动', '同上', '见附件', '是', '否', '正常', '作废']);
const COMPANY_STOPWORDS = /^(?:合计|小计|总计|无|空|其他|其它|同上|个人|是|否|正常)$/u;

function headerType(cell) {
  const text = cell.replace(/[\s:：*（）()]/gu, '');
  if (!text || text.length > 10) return undefined;
  for (const rule of HEADER_RULES) if (rule.pattern.test(text)) return rule.type;
  return undefined;
}

function splitLine(line, delimiter) {
  const cells = [];
  let start = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (index === line.length || line[index] === delimiter) {
      cells.push({ start, end: index });
      start = index + 1;
    }
  }
  return cells;
}

function detectHeader(line) {
  for (const delimiter of ['\t', ',']) {
    if (delimiter === ',' && line.includes('"')) continue; // 带引号的复杂 CSV 交给 CSV 专用链
    const cells = splitLine(line, delimiter);
    if (cells.length < 2) continue;
    const columns = new Map();
    let nonEmpty = 0;
    let headerLike = true;
    cells.forEach((cell, index) => {
      const value = line.slice(cell.start, cell.end).trim();
      if (!value) return;
      nonEmpty += 1;
      // 表头格：不长、不含 3 位以上数字、不是日期金额。
      if (value.length > 16 || /\d{3,}/u.test(value) || /^[-\d.,%\s:]+$/u.test(value)) headerLike = false;
      const type = headerType(value);
      if (type) columns.set(index, { type, header: value });
    });
    if (headerLike && nonEmpty >= 2 && [...columns.values()].some((column) => column.type)) return { delimiter, columns, width: cells.length };
  }
  return null;
}

function trimRange(text, start, end) {
  while (start < end && /[\s"'　]/u.test(text[start])) start += 1;
  while (end > start && /[\s"'　]/u.test(text[end - 1])) end -= 1;
  return [start, end];
}

function personCandidates(text, start, end) {
  // 一格里可能有多个名字：“张三、李四”“张三/李四”
  const results = [];
  // 括号也作为分隔：“fB000007(易学敏)”“易学敏（财务）”
  const piece = /[^、，,;；/\s|()（）\[\]【】<>《》]+/gu;
  const cell = text.slice(start, end);
  for (const match of cell.matchAll(piece)) {
    const value = match[0].replace(/^·+|·+$/gu, '');
    const offset = match.index + match[0].indexOf(value);
    const compact = value.replace(/·/gu, '');
    if (NAME_STOPWORDS.has(value)) continue;
    const isHanName = /^\p{Script=Han}{2,4}$/u.test(value) || /^\p{Script=Han}{1,6}·\p{Script=Han}{1,8}$/u.test(value);
    if (!isHanName) continue;
    // 首字不是常见姓氏、或四个字的名字，标为需核对（可能是部门、岗位等）。
    const reviewRequired = !value.includes('·') && (!looksLikeSurname(compact) || (compact.length === 4 && !COMPOUND_SURNAMES.some((s) => compact.startsWith(s))));
    results.push({ value, start: start + offset, reviewRequired });
  }
  return results;
}

/**
 * @returns {Array<{type,value,start,end,hint,reviewRequired}>}
 */
export function collectTableColumns(input, enabledTypes) {
  const text = String(input || '');
  const results = [];
  let header = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const rawLine = text.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (/^【工作表[:：]/u.test(line) || !line.trim()) {
      header = null;
    } else {
      const candidate = detectHeader(line);
      if (candidate) {
        header = candidate;
        lineStart = lineEnd + 1;
        continue;
      }
      if (header) {
        const cells = splitLine(line, header.delimiter);
        for (const [index, column] of header.columns) {
          if (!column.type || !enabledTypes.has(column.type) || !cells[index]) continue;
          const [start, end] = trimRange(line, cells[index].start, cells[index].end);
          if (end <= start) continue;
          const absolute = lineStart + start;
          const value = line.slice(start, end);
          const hint = `表格列：${column.header}`;
          if (column.type === 'person') {
            for (const item of personCandidates(text, absolute, absolute + value.length)) {
              results.push({ type: 'person', value: item.value, start: item.start, end: item.start + item.value.length, hint, reviewRequired: item.reviewRequired });
            }
          } else if (column.type === 'company') {
            if (COMPANY_STOPWORDS.test(value) || value.length < 4 || !/\p{Script=Han}/u.test(value) || /^[-\d.,%\s]+$/u.test(value)) continue;
            results.push({ type: 'company', value, start: absolute, end: absolute + value.length, hint });
          } else if (column.type === 'address') {
            if (value.length < 4 || !/\p{Script=Han}/u.test(value)) continue;
            results.push({ type: 'address', value, start: absolute, end: absolute + value.length, hint });
          } else if (column.type === 'bankcard') {
            if (!/^\d[\d\s-]{7,30}\d$/u.test(value)) continue;
            results.push({ type: 'bankcard', value, start: absolute, end: absolute + value.length, hint });
          } else if (column.type === 'mobile' || column.type === 'idcard') {
            // 号码列交给常规规则（有校验位），这里不重复。
          }
        }
      }
    }
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  return results;
}
