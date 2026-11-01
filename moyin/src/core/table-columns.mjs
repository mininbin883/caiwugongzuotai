// 按表头识别表格列：Excel/CSV 导出的台账里，姓名、单位名称等只出现在格子里，没有“联系人：”这样的前缀。
// 先找表头行，再把对应列下面每一格的值按列的类型识别。支持制表符分隔（Excel 提取结果）和简单逗号分隔。

export const COMMON_SURNAMES = new Set([...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫阎段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明佘池查麻苑迟邝嵇郜逄冀相佐鞠芮宦蔺胥伦历禹扈訾隗邴笪仉璩厉阚檀']);
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
  if (enabledTypes.has('person') || enabledTypes.has('company')) {
    results.push(...inferAccountLedger(text, enabledTypes));
    results.push(...inferColumnsByContent(text, enabledTypes));
  }
  return results;
}

// ---------- 按内容推断列 ----------
// 科目余额表、往来明细这类台账，人名常和科目、单位混在同一列（如“科目名称”“核算项目”），表头认不出。
// 这里按列统计“像人名”的格子：比例足够高时，把这些格子识别为人名；整列都像人名的直接采纳，混合列里的标为需核对。

// 以常见姓氏开头、但其实是财务/业务词的前两个字。
const BUSINESS_PREFIXES = new Set(('费用 成本 收入 利息 利润 应收 应付 应交 预付 预收 其他 管理 销售 财务 研发 生产 制造 工资 薪酬 福利 社保 保险 公积 税金 ' +
  '现金 银行 存款 资本 资产 负债 折旧 摊销 合计 小计 总计 余额 期初 期末 本期 借方 贷方 项目 工程 材料 设备 劳务 服务 办公 差旅 招待 通讯 ' +
  '交通 车辆 运输 燃料 汽油 维修 修理 房租 房屋 租金 租赁 押金 保证 备用 暂估 往来 投资 股本 实收 盈余 未分 分配 结转 调整 营业 主营 库存 存货 ' +
  '原材 周转 包装 低值 固定 无形 长期 短期 递延 坏账 减值 公允 汇兑 手续 佣金 罚款 捐赠 补贴 奖金 水电 水费 电费 物业 广告 宣传 咨询 审计 培训 ' +
  '会议 业务 安全 环保 绿化 道路 排水 管网 施工 安装 监理 设计 检测 试验 人民 美元 欧元 港币 外币 内部 关联 代扣 代缴 个人 职工 教育 工会 经费 ' +
  '印花 城建 增值 所得 进项 销项 转出 待抵 待认 未交 已交 简易 中国 国家 国内 国际 华东 华北 华南 华中 西北 西南 东北 山东 江苏 浙江 广东 ' +
  '北京 上海 天津 重庆 河北 河南 湖北 湖南 安徽 福建 江西 陕西 山西 甘肃 云南 贵州 四川 辽宁 吉林 黑龙 宁夏 青海 新疆 西藏 广西 海南 内蒙 ' +
  '潍坊 青岛 济南 烟台 临沂 淄博 东营 威海 日照 滨州 德州 聊城 菏泽 济宁 泰安 枣庄 莱芜 寿光 青州 诸城 高密 昌邑 安丘 昌乐 临朐 寒亭 坊子 奎文 潍城 ' +
  '高新 开发 经济 技术 科技 信息 网络 电子 软件 系统 平台 数据 电力 电气 能源 石油 化工 钢铁 建材 建筑 建设 市政 交运 物流 贸易 商贸 实业 置业 ' +
  '地产 房地 酒店 餐饮 文化 传媒 教学 学校 医院 医疗 药品 食品 农业 林业 牧业 渔业 水利 环境 节能 新能 汽车 机械 五金 电器 家具 服装 纺织 印刷 ' +
  '包材 化学 石材 木材 钢材 水泥 沥青 砂石 苗木 花卉 养护 保洁 安保 劳保 礼品 茶叶 烟酒 酒水 宾馆 饭店 超市 商店 商行 经营 门市 加工 厂房 ' +
  '车间 仓库 宿舍 食堂 伙食 餐费 交际 应酬 差费 路费 油费 过路 停车 快递 邮寄 打印 复印 耗材 配件 零件 备件 工具 仪器 仪表 计量 测量 勘察 ' +
  '规划 评估 鉴定 认证 专利 商标 版权 许可 资质 年检 年审 上牌 保养 轮胎 机油 柴油 天然 燃气 暖气 供暖 供热 供水 供电 排污 垃圾 清运').split(/\s+/u));

const ORG_SUFFIX = /(?:置业|实业|商贸|贸易|物流|传媒|餐饮|酒店|饭店|饭庄|宾馆|超市|商行|商店|经营部|门市部|经销处|加工厂|合作社|事务所|研究所|研究院|医院|学校|支行|分行|控股|地产|建材|机械|电器|五金|汽修|酒业|茶行|印务|门诊|药店|药房|工作室|中心|集团|公司|厂|店|馆|行|社|部|处)(?:（[^）]{1,12}）)?$/u;

function strictPersonName(value) {
  if (!/^\p{Script=Han}{2,3}$/u.test(value)) return false;
  if (!looksLikeSurname(value)) return false;
  if (NAME_STOPWORDS.has(value) || BUSINESS_PREFIXES.has(value.slice(0, 2))) return false;
  // 以这些字结尾的多为科目、部门或单位，而不是人名。
  if (/[费款税账部处科室组局厅站队司厂店馆院校委办]$/u.test(value)) return false;
  return true;
}

function orgLike(value) {
  return value.length >= 4 && /^\p{Script=Han}/u.test(value) && ORG_SUFFIX.test(value) && !BUSINESS_PREFIXES.has(value) && !/费用|成本|收入|款$/u.test(value);
}

function inferColumnsByContent(text, enabledTypes) {
  const results = [];
  let block = [];
  const flush = () => {
    if (block.length >= 4) results.push(...inferBlock(text, block, enabledTypes));
    block = [];
  };
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.includes('\t') || /^【工作表[:：]/u.test(line)) flush();
    else block.push({ lineStart, line });
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  flush();
  return results;
}

function inferBlock(text, block, enabledTypes) {
  const columns = new Map();
  let headerCells = null;
  for (const [rowIndex, { lineStart, line }] of block.entries()) {
    const cells = splitLine(line, '\t');
    if (rowIndex === 0) headerCells = cells.map((cell) => line.slice(cell.start, cell.end).trim());
    cells.forEach((cell, index) => {
      const [start, end] = trimRange(line, cell.start, cell.end);
      if (end <= start) return;
      const value = line.slice(start, end);
      if (!/\p{Script=Han}/u.test(value)) return;
      let column = columns.get(index);
      if (!column) columns.set(index, (column = { textual: 0, names: [], orgs: [] }));
      column.textual += 1;
      if (strictPersonName(value)) column.names.push({ value, start: lineStart + start });
      else if (orgLike(value)) column.orgs.push({ value, start: lineStart + start });
    });
  }
  const results = [];
  for (const [index, column] of columns) {
    const nameRatio = column.names.length / Math.max(1, column.textual);
    const counterparty = column.names.length + column.orgs.length;
    // 至少 3 个像人名的格子，且占这一列文字格的四分之一以上，才按人名列处理。
    if (column.names.length < 3 || nameRatio < 0.25) continue;
    const header = headerCells?.[index] && !/\d/u.test(headerCells[index]) && headerCells[index].length <= 10 ? headerCells[index] : `第 ${index + 1} 列`;
    const strong = nameRatio >= 0.6;
    const hint = `按内容推断：${header}${strong ? '多为人名' : '中混有人名'}`;
    if (enabledTypes.has('person')) {
      for (const item of column.names) {
        results.push({ type: 'person', value: item.value, start: item.start, end: item.start + item.value.length, hint, reviewRequired: !strong });
      }
    }
    // 同一列里不带“公司”后缀的单位名称（如“××置业”“××饭店”）也一并列出，标为需核对。
    if (enabledTypes.has('company') && counterparty >= 3) {
      for (const item of column.orgs) {
        results.push({ type: 'company', value: item.value, start: item.start, end: item.start + item.value.length, hint: `按内容推断：${header}中的单位名称`, reviewRequired: !/公司|集团/u.test(item.value) });
      }
    }
  }
  return results;
}

// ---------- 科目余额表 / 往来明细：按科目层级识别往来对象 ----------
// 第一列是科目代码（1221、1221.001、1123.004.001 ……）。往来类科目（应收、应付、预付、其他应收/应付、备用金、
// 借款、保证金、职工等）下面的各级明细就是往来对象：人名、单位，或“单位.项目”。

const ACCOUNT_CODE = /^\d{3,6}(?:\.[0-9A-Za-z]{1,6}){0,5}$/u;
const COUNTERPARTY_ACCOUNT = /应收|应付|预付|预收|往来|备用金|借款|暂借|押金|保证金|职工|员工|个人|内部|合同资产|合同负债|代垫|垫付|周转金|实收资本|股本|股东|投资者|出资|持股/u;
// 名字后面可能连着多个后缀：“夏伟个人借款”“吴洁华保证金”“郎波考核”。
const NAME_SUFFIX = /^(\p{Script=Han}{2,3}?)(?:个人|员工|职工)?(?:保证金|押金|借款|暂借款?|备用金|考核|工资|奖金|报销|垫付|往来|欠款|还款|罚款|奖励|个人)+$/u;
const ORG_TAIL = /(?:公司|集团|局|院|所|中心|站|厂|社|委员会|委|办|学校|学院|大学|医院|银行|支行|分行|协会|商会|合作社)$/u;
// 工程项目、地点类明细（“双昌路挖补”“五标段”“一号车间”）不是往来对象。
const PROJECT_HINT = /[路街桥巷]|标段|工程|项目|改造|挖补|大修|维修|管道|管网|污水|雨水|排水|道路|车间|基地|小区|花园|广场|名都|宿舍|厂房|\d/u;
// 以地名用字结尾的两三个字：姓氏开头时仍可能是人名（如“王均镇”），按需核对处理。
const PLACE_TAIL = /[路街桥道巷村庄镇区县市省河湖湾港沟渠]$/u;
// 往来明细里常见、但不是人名的短词。
const NOT_PERSON = new Set(['车队', '拌合站', '拌和站', '正式工', '临时工', '合同工', '农民工', '分包', '内部分包', '保函', '履约', '碧桂园', '中行', '工行', '农行', '建行', '中冶', '中环', '中铁', '实力', '平度', '信达', '弘联', '大海洋', '东珠', '项目部', '经理部', '指挥部', '财务部', '工程部', '办公室', '食堂', '车间', '班组', '工地', '施工队', '劳务队', '个人', '其他', '其它', '禁用', '停用']);
const NON_PERSON_TAIL = /[站队园部组班处厂司局院所校社委办]$/u;

function segmentsWithOffsets(value) {
  // “滨海投资公司.2号3号桥”“牛庆桂（禁用）”“2013年暂借款禁用” 按点号、括号拆开。
  const parts = [];
  const pattern = /[^.．。()（）\[\]【】、,，/\s]+/gu;
  for (const match of value.matchAll(pattern)) parts.push({ text: match[0], offset: match.index });
  return parts;
}

function counterpartyCandidates(cell, cellStart) {
  const out = [];
  for (const segment of segmentsWithOffsets(cell)) {
    const value = segment.text.replace(/(?:禁用|停用|作废|注销)$/u, '');
    const start = cellStart + segment.offset;
    if (!value || NAME_STOPWORDS.has(value)) continue;
    const suffixed = value.match(NAME_SUFFIX);
    if (suffixed && !NOT_PERSON.has(suffixed[1]) && !BUSINESS_PREFIXES.has(suffixed[1].slice(0, 2))) {
      out.push({ type: 'person', value: suffixed[1], start, reviewRequired: !looksLikeSurname(suffixed[1]) });
      continue;
    }
    if (/^\p{Script=Han}{2,3}$/u.test(value)) {
      if (NOT_PERSON.has(value) || BUSINESS_PREFIXES.has(value.slice(0, 2)) || PROJECT_HINT.test(value) || /[费款税账金额息]$/u.test(value)) continue;
      if (NON_PERSON_TAIL.test(value)) continue;
      const placeTail = PLACE_TAIL.test(value);
      if (placeTail && !looksLikeSurname(value)) continue;
      out.push({ type: 'person', value, start, reviewRequired: placeTail || !looksLikeSurname(value) });
      continue;
    }
    if (/^\p{Script=Han}[\p{Script=Han}（）()]{3,40}$/u.test(value)) {
      if (ORG_TAIL.test(value)) {
        out.push({ type: 'company', value, start, reviewRequired: !/公司|集团/u.test(value) });
      } else if (value.length <= 8 && !PROJECT_HINT.test(value) && !PLACE_TAIL.test(value) && !NOT_PERSON.has(value) && !BUSINESS_PREFIXES.has(value.slice(0, 2)) && !/[费款税账金]$/u.test(value)) {
        // “青欣绿化”“奎文市政”这类简称：可能是单位，也可能是项目，列出并标为需核对。
        out.push({ type: 'company', value, start, reviewRequired: true });
      }
    }
  }
  return out;
}

function inferAccountLedger(text, enabledTypes) {
  const results = [];
  const rows = [];
  const flush = () => {
    if (rows.length >= 5) results.push(...inferLedgerRows(rows, enabledTypes));
    rows.length = 0;
  };
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (/^【工作表[:：]/u.test(line)) flush();
    else if (line.includes('\t')) rows.push({ lineStart, line });
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  flush();
  return results;
}

function inferLedgerRows(rows, enabledTypes) {
  const parsed = rows.map(({ lineStart, line }) => {
    const cells = splitLine(line, '\t');
    const code = line.slice(cells[0].start, cells[0].end).trim();
    let nameCell = null;
    for (let index = 1; index < Math.min(cells.length, 4); index += 1) {
      const [start, end] = trimRange(line, cells[index].start, cells[index].end);
      if (end > start && /\p{Script=Han}/u.test(line.slice(start, end))) {
        nameCell = { value: line.slice(start, end), start: lineStart + start };
        break;
      }
    }
    return { code, nameCell };
  });
  const coded = parsed.filter((row) => ACCOUNT_CODE.test(row.code));
  // 至少八成行的第一列是科目代码，才按科目余额表处理。
  if (coded.length < 5 || coded.length < parsed.length * 0.8) return [];
  const nameByCode = new Map(coded.filter((row) => row.nameCell).map((row) => [row.code, row.nameCell.value]));
  const results = [];
  for (const row of coded) {
    if (!row.nameCell || !row.code.includes('.')) continue;
    // 任一上级科目是往来类，才把这一行当作往来对象。
    const segments = row.code.split('.');
    let counterparty = false;
    for (let depth = 1; depth < segments.length && !counterparty; depth += 1) {
      const ancestor = nameByCode.get(segments.slice(0, depth).join('.'));
      if (ancestor && COUNTERPARTY_ACCOUNT.test(ancestor)) counterparty = true;
    }
    if (!counterparty) continue;
    const topName = nameByCode.get(segments[0]) || '往来科目';
    for (const item of counterpartyCandidates(row.nameCell.value, row.nameCell.start)) {
      if (!enabledTypes.has(item.type)) continue;
      results.push({
        type: item.type,
        value: item.value,
        start: item.start,
        end: item.start + item.value.length,
        hint: `往来明细：${topName}`,
        reviewRequired: item.reviewRequired
      });
    }
  }
  return results;
}
