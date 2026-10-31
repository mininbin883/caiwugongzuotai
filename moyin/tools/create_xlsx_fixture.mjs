import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Workbook, SpreadsheetFile } = require('@oai/artifact-tool');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'output', 'office');
await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('客户清单');
sheet.showGridLines = false;
sheet.getRange('A1:F1').values = [['客户资料原格式脱敏测试', null, null, null, null, null]];
sheet.getRange('A1:F1').format.font = { name: 'Microsoft YaHei', size: 15, bold: true, color: '#000000' };
sheet.getRange('A3:F6').values = [
  ['编号', '姓名', '手机号', '电子邮箱', '身份证号', '备注'],
  [1, '张三', '13812345678', 'alice@example.com', '11010519491231002X', '服务器 192.168.10.8'],
  [2, '李四', '13987654321', 'lisi@example.cn', '有效记录'],
  [3, '普通客户', '无', '无', '无', '非敏感内容'],
];
sheet.getRange('G3').values = [['手机号长度']];
sheet.getRange('G4').formulas = [['=LEN(C4)']];
sheet.getRange('G4:G6').fillDown();
sheet.getRange('A3:G3').format = {
  fill: '#174C3A',
  font: { name: 'Microsoft YaHei', size: 10, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  borders: { preset: 'all', style: 'thin', color: '#D9D9D9' },
};
sheet.getRange('A4:G6').format.font = { name: 'Microsoft YaHei', size: 10, color: '#18211E' };
sheet.getRange('A3:G6').format.borders = { preset: 'all', style: 'thin', color: '#D9D9D9' };
sheet.getRange('A4:A6').format.horizontalAlignment = 'center';
sheet.getRange('G4:G6').format.horizontalAlignment = 'center';
sheet.getRange('A1:G6').format.verticalAlignment = 'center';
sheet.getRange('A:A').format.columnWidth = 8;
sheet.getRange('B:B').format.columnWidth = 14;
sheet.getRange('C:C').format.columnWidth = 18;
sheet.getRange('D:D').format.columnWidth = 26;
sheet.getRange('E:E').format.columnWidth = 25;
sheet.getRange('F:F').format.columnWidth = 25;
sheet.getRange('G:G').format.columnWidth = 14;
sheet.freezePanes.freezeRows(3);

const notes = workbook.worksheets.add('说明');
notes.showGridLines = false;
notes.getRange('A1').values = [['说明']];
notes.getRange('A1').format.font = { name: 'Microsoft YaHei', size: 14, bold: true, color: '#000000' };
notes.getRange('A3:A5').values = [['本工作簿用于验证原格式脱敏。'], ['公式和非敏感单元格必须保持不变。'], ['仅敏感值所在单元格转换为脱敏文本。']];
notes.getRange('A:A').format.columnWidth = 52;
notes.getRange('A1:A5').format.font = { name: 'Microsoft YaHei', size: 10, color: '#18211E' };
notes.getRange('A1').format.font = { name: 'Microsoft YaHei', size: 14, bold: true, color: '#000000' };

workbook.recalculate();
const overview = await workbook.inspect({ kind: 'sheet,table', maxChars: 3000, tableMaxRows: 8, tableMaxCols: 8 });
console.log(overview.ndjson);
const preview = await workbook.render({ sheetName: '客户清单', range: 'A1:G6', scale: 2, format: 'png' });
await fs.writeFile(path.join(outputDir, 'phase5-sensitive-xlsx.png'), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(outputDir, 'phase5-sensitive.xlsx'));
console.log(path.join(outputDir, 'phase5-sensitive.xlsx'));
