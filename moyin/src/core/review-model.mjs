// 核对面板的数据模型：把识别结果按“工作表 → 列 → 不同的值”或“类型 → 不同的值”分组，并支持整列策略。
// 只依赖提取出来的文字：Excel/CSV 提取结果以制表符分列，“【工作表：名称】”分隔工作表。

export function columnLetter(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/**
 * 从文字中建出表格结构。连续 3 行以上、含制表符的行视为一张表；第一行作为表头。
 * @returns {{ tables: Array<{ id, sheet, header: string[], columns: Array<{ index, letter, header, cells: Array<{start,end,value,row}> }>, start, end }> }}
 */
export function buildTableModel(input) {
  const text = String(input || '');
  const tables = [];
  let sheet = '';
  let rows = [];
  const flush = () => {
    if (rows.length >= 3) {
      const width = Math.max(...rows.map((row) => row.cells.length));
      const header = rows[0].cells.map((cell) => cell.value);
      const columns = [];
      for (let index = 0; index < width; index += 1) {
        const cells = [];
        for (const [rowIndex, row] of rows.entries()) {
          if (rowIndex === 0) continue;
          const cell = row.cells[index];
          if (cell && cell.value) cells.push({ ...cell, row: rowIndex });
        }
        const headerText = (header[index] || '').trim();
        columns.push({ index, letter: columnLetter(index), header: headerText && headerText.length <= 24 ? headerText : '', cells });
      }
      tables.push({ id: `t${tables.length}`, sheet, header, columns, start: rows[0].start, end: rows.at(-1).end, rowCount: rows.length - 1 });
    }
    rows = [];
  };
  const parseCells = (line, lineStart) => {
    const cells = [];
    let cellStart = 0;
    for (let index = 0; index <= line.length; index += 1) {
      if (index === line.length || line[index] === '\t') {
        let start = cellStart;
        let end = index;
        while (start < end && /\s/u.test(line[start])) start += 1;
        while (end > start && /\s/u.test(line[end - 1])) end -= 1;
        cells.push({ start: lineStart + start, end: lineStart + end, value: line.slice(start, end) });
        cellStart = index + 1;
      }
    }
    return cells;
  };
  // 单元格内换行（如备注里的“工程地点:…”另起一行）会把一行拆成几行：表格内没有制表符、或格数不够的行，
  // 并回上一行的最后一格，最多续 5 行，避免把表格后面的正文也吞进来。
  let continuation = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const sheetMatch = line.match(/^【工作表[:：](.+)】$/u);
    const width = rows[0]?.cells.length || 0;
    const previous = rows.at(-1);
    if (sheetMatch) {
      flush();
      sheet = sheetMatch[1];
      continuation = 0;
    } else if (previous && width > 1 && line.trim() && continuation < 5 &&
        (!line.includes('\t') || previous.cells.length < width)) {
      // 续行：把第一段并入上一行的最后一格，其余段作为后续格子。
      const parts = parseCells(line, lineStart);
      const last = previous.cells.at(-1);
      const first = parts.shift();
      if (first.value) {
        if (!last.value) { last.start = first.start; }
        last.end = first.end;
        last.value = text.slice(last.start, last.end);
      }
      previous.cells.push(...parts);
      previous.end = lineStart + line.length;
      continuation += 1;
    } else if (line.includes('\t')) {
      rows.push({ start: lineStart, end: lineStart + line.length, cells: parseCells(line, lineStart) });
      continuation = 0;
    } else {
      flush();
      continuation = 0;
    }
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  flush();
  return { tables };
}

/** 找到某个位置所在的表与列。cellIndex：按起点排序的所有格子。 */
function buildCellIndex(model) {
  const cells = [];
  for (const table of model.tables) {
    for (const column of table.columns) {
      for (const cell of column.cells) cells.push({ start: cell.start, end: cell.end, table, column });
    }
  }
  cells.sort((left, right) => left.start - right.start);
  return cells;
}

function locateCell(cells, position) {
  let low = 0;
  let high = cells.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cell = cells[middle];
    if (position < cell.start) high = middle - 1;
    else if (position >= cell.end) low = middle + 1;
    else return cell;
  }
  return null;
}

export function columnKey(table, column) {
  return `${table.sheet}\u0000${table.id}\u0000${column.index}`;
}

function sourceLabel(finding) {
  const hint = String(finding.hint || '');
  if (finding.source === 'manual') return hint.startsWith('整列隐藏') ? '整列隐藏' : '手动补选';
  if (finding.source === 'onnx') return '本机模型';
  if (hint.startsWith('表格列')) return '按表头';
  if (hint.startsWith('按内容推断')) return '按内容推断';
  if (hint.startsWith('往来明细')) return '往来明细';
  return '格内识别';
}

function groupValues(findings) {
  const values = new Map();
  for (const finding of findings) {
    const key = `${finding.type}\u0000${finding.value}`;
    let group = values.get(key);
    if (!group) {
      group = { key, type: finding.type, label: finding.label, value: finding.value, findings: [], replacement: finding.replacement };
      values.set(key, group);
    }
    group.findings.push(finding);
  }
  return [...values.values()].map((group) => ({
    ...group,
    count: group.findings.length,
    enabledCount: group.findings.filter((item) => item.enabled).length,
    reviewRequired: group.findings.some((item) => item.reviewRequired),
    manual: group.findings.some((item) => item.source === 'manual'),
    hint: group.findings.find((item) => item.hint)?.hint || ''
  })).sort((left, right) => right.count - left.count || left.findings[0].start - right.findings[0].start);
}

/**
 * 按列分组。返回每张表的每一列（含没有识别结果的列，便于整列隐藏），以及表格之外的“正文”结果。
 */
export function groupByColumn(model, findings) {
  const cellIndex = buildCellIndex(model);
  const buckets = new Map();
  const outside = [];
  for (const finding of findings) {
    const cell = locateCell(cellIndex, finding.start);
    if (!cell) { outside.push(finding); continue; }
    const key = columnKey(cell.table, cell.column);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(finding);
  }
  const sheets = [];
  for (const table of model.tables) {
    let sheetGroup = sheets.find((item) => item.sheet === table.sheet && item.tableId === table.id);
    if (!sheetGroup) sheets.push((sheetGroup = { sheet: table.sheet, tableId: table.id, columns: [], total: 0 }));
    for (const column of table.columns) {
      const key = columnKey(table, column);
      const list = buckets.get(key) || [];
      const typeCounts = new Map();
      for (const finding of list) typeCounts.set(finding.type, (typeCounts.get(finding.type) || 0) + 1);
      const sources = new Set(list.map(sourceLabel));
      const mainType = [...typeCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
      sheetGroup.total += list.length;
      sheetGroup.columns.push({
        key,
        tableId: table.id,
        index: column.index,
        letter: column.letter,
        header: column.header,
        cellCount: column.cells.length,
        cells: column.cells,
        findings: list,
        count: list.length,
        enabledCount: list.filter((item) => item.enabled).length,
        mainType,
        types: [...typeCounts.keys()],
        sources: [...sources],
        reviewRequired: list.some((item) => item.reviewRequired),
        values: groupValues(list)
      });
    }
  }
  return { sheets, outside: groupValues(outside), outsideCount: outside.length };
}

/** 按类型分组（逐条视图）。 */
export function groupByType(findings, typeLabels = {}) {
  const types = new Map();
  for (const finding of findings) {
    if (!types.has(finding.type)) types.set(finding.type, []);
    types.get(finding.type).push(finding);
  }
  return [...types.entries()].map(([type, list]) => ({
    type,
    label: typeLabels[type] || list[0]?.label || type,
    count: list.length,
    enabledCount: list.filter((item) => item.enabled).length,
    reviewCount: list.filter((item) => item.reviewRequired).length,
    values: groupValues(list)
  })).sort((left, right) => right.count - left.count);
}

/**
 * 整列隐藏：为列中尚未被覆盖的非空格子生成手动候选。
 * @returns {Array<{type,start,end,confidence,source,hint}>}
 */
export function wholeColumnFindings(column, type) {
  // 整列隐藏覆盖整格：与格内的自动识别结果重叠时，以整列隐藏为准（手动优先）。
  return column.cells.filter((cell) => cell.value).map((cell) => ({
    type,
    start: cell.start,
    end: cell.end,
    confidence: 1,
    source: 'manual',
    hint: `整列隐藏：${column.letter} 列${column.header ? ` ${column.header}` : ''}`
  }));
}

/** 返回一个函数：给定文字位置，返回所在列的 key（不在表格里返回 null）。 */
export function createColumnLocator(model) {
  const cells = buildCellIndex(model);
  return (position) => {
    const cell = locateCell(cells, position);
    return cell ? columnKey(cell.table, cell.column) : null;
  };
}

export function findColumn(model, key) {
  for (const table of model.tables) {
    for (const column of table.columns) if (columnKey(table, column) === key) return column;
  }
  return null;
}

export { sourceLabel };
