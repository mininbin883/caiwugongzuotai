import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { FileBlob, SpreadsheetFile } = require('@oai/artifact-tool');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.join(root, 'output', 'office', 'phase5-redacted.xlsx');
const previewPath = path.join(root, 'output', 'office', 'phase5-redacted-xlsx.png');
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
workbook.recalculate();

const table = await workbook.inspect({
  kind: 'table',
  sheetId: '客户清单',
  range: 'A1:G6',
  include: 'values,formulas',
  tableMaxRows: 8,
  tableMaxCols: 8,
  maxChars: 5000,
});
console.log(table.ndjson);

const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
});
console.log(errors.ndjson);

const preview = await workbook.render({ sheetName: '客户清单', range: 'A1:G6', scale: 2, format: 'png' });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
console.log(`XLSX_VERIFY_OK preview=${previewPath}`);
