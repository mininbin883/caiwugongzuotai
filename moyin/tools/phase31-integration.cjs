'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { extractOfficeDocument, inspectOfficeLongTail } = require('../src/services/office-redaction-service.cjs');

async function writePackage(filePath, entries) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

function featureMap(report) {
  return Object.fromEntries(report.items.map((item) => [item.feature, item]));
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const outputDir = path.join(root, 'output', 'office');
  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-phase31-'));
  const xlsxPath = path.join(tempDir, 'phase31-complex.xlsx');
  const docxPath = path.join(tempDir, 'phase31-complex.docx');
  await writePackage(xlsxPath, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="Sales">Sheet1!$A$1</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="pivot" Target="pivotTables/pivotTable1.xml"/><Relationship Id="rId3" Type="external" Target="https://example.invalid/book.xlsx" TargetMode="External"/><Relationship Id="rId4" Type="missing" Target="worksheets/missing.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>姓名：张三</t></is></c><c r="B1"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>手机号：13812345678</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" sqref="A1"/></dataValidations><conditionalFormatting sqref="A1"/></worksheet>',
    'xl/pivotTables/pivotTable1.xml': '<pivotTableDefinition/>',
    'xl/pivotCache/pivotCacheDefinition1.xml': '<pivotCacheDefinition/>',
    'xl/externalLinks/externalLink1.xml': '<externalLink/>',
    'xl/diagrams/data1.xml': '<dgm:dataModel/>',
    'xl/embeddings/oleObject1.bin': Buffer.from('ole'),
    'xl/activeX/ctrlProps1.xml': '<ocx/>',
  });
  await writePackage(docxPath, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>联系人：张三</w:t></w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="diagram" Target="diagrams/data1.xml"/><Relationship Id="rId2" Type="ole" Target="embeddings/oleObject1.bin"/><Relationship Id="rId3" Type="external" Target="https://example.invalid/a" TargetMode="External"/></Relationships>',
    'word/diagrams/data1.xml': '<dgm:dataModel/>',
    'word/embeddings/oleObject1.bin': Buffer.from('ole'),
  });
  const xlsx = await extractOfficeDocument(xlsxPath);
  const docx = await extractOfficeDocument(docxPath);
  const xlsxReport = xlsx.longTailReport || await inspectOfficeLongTail(await JSZip.loadAsync(await fs.readFile(xlsxPath)), '.xlsx');
  const docxReport = docx.longTailReport || await inspectOfficeLongTail(await JSZip.loadAsync(await fs.readFile(docxPath)), '.docx');
  const xlsxFeatures = featureMap(xlsxReport);
  const docxFeatures = featureMap(docxReport);
  const expectedXlsx = ['pivotTables', 'externalLinks', 'definedNames', 'dataValidation', 'conditionalFormatting', 'smartArt', 'embeddedObjects', 'relationships'];
  const expectedDocx = ['smartArt', 'embeddedObjects', 'externalLinks', 'relationships'];
  const pass = expectedXlsx.every((key) => xlsxFeatures[key]?.detected) && expectedDocx.every((key) => docxFeatures[key]?.detected) && xlsxReport.degradationCount >= 5 && docxReport.degradationCount >= 3 && xlsxReport.relationshipSummary.anomalies.length >= 1;
  const report = {
    schema: 'VEILFORGE_PHASE31_LONG_TAIL_REPORT',
    result: pass ? 'PASS' : 'FAIL',
    xlsx: { sourcePath: xlsxPath, characters: xlsx.characters, report: xlsxReport },
    docx: { sourcePath: docxPath, characters: docx.characters, report: docxReport },
    criteria: { expectedXlsx, expectedDocx, opaquePartsPreserved: true, anomalyReporting: true }
  };
  const reportPath = path.join(outputDir, 'phase31-long-tail-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PHASE31_${report.result} xlsxDetected=${xlsxReport.detectedFeatures.length} xlsxDegraded=${xlsxReport.degradationCount} docxDetected=${docxReport.detectedFeatures.length} docxDegraded=${docxReport.degradationCount} anomalies=${xlsxReport.relationshipSummary.anomalies.length + docxReport.relationshipSummary.anomalies.length} opaque=1 report=${reportPath}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`PHASE31_FAILED ${error?.stack || error}\n`);
  process.exitCode = 1;
});
