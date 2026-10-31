import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { inspectOfficeLongTail } = require('../src/services/office-long-tail-service.cjs');

async function reportFor(entries, extension) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  return inspectOfficeLongTail(await JSZip.loadAsync(bytes), extension);
}

test('complex XLSX long-tail features produce per-item preservation/degradation report', async () => {
  const report = await reportFor({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook><definedNames><definedName name="Sales">Sheet1!$A$1</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="pivot" Target="pivotTables/pivotTable1.xml"/><Relationship Id="rId2" Type="external" Target="https://example.invalid/book.xlsx" TargetMode="External"/><Relationship Id="rId3" Type="missing" Target="worksheets/missing.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><dataValidations count="1"/><conditionalFormatting sqref="A1"/></worksheet>',
    'xl/pivotTables/pivotTable1.xml': '<pivotTableDefinition/>',
    'xl/pivotCache/pivotCacheDefinition1.xml': '<pivotCacheDefinition/>',
    'xl/externalLinks/externalLink1.xml': '<externalLink/>',
    'xl/diagrams/data1.xml': '<dgm:relIds/>',
    'xl/embeddings/oleObject1.bin': Buffer.from('ole'),
    'xl/activeX/ctrlProps1.xml': '<ocx/>',
  }, '.xlsx');
  assert.equal(report.schema, 'VEILFORGE_OFFICE_LONG_TAIL_V1');
  assert.equal(report.degradationCount >= 5, true);
  for (const key of ['pivotTables', 'externalLinks', 'definedNames', 'dataValidation', 'conditionalFormatting', 'smartArt', 'embeddedObjects', 'relationships']) {
    assert.equal(report.items.some((item) => item.feature === key && item.detected), true, key);
  }
  assert.equal(report.relationshipSummary.external, 1);
  assert.equal(report.relationshipSummary.anomalies.length >= 1, true);
});

test('DOCX diagram and embedded parts remain opaque and are reported', async () => {
  const report = await reportFor({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>姓名：张三</w:t></w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships><Relationship Id="rId1" Type="diagram" Target="diagrams/data1.xml"/><Relationship Id="rId2" Type="ole" Target="embeddings/oleObject1.bin"/><Relationship Id="rId3" Type="external" Target="https://example.invalid/a" TargetMode="External"/></Relationships>',
    'word/diagrams/data1.xml': '<dgm:dataModel/>',
    'word/embeddings/oleObject1.bin': Buffer.from('ole'),
  }, '.docx');
  const byFeature = new Map(report.items.map((item) => [item.feature, item]));
  assert.equal(byFeature.get('smartArt').status, 'degraded');
  assert.equal(byFeature.get('embeddedObjects').status, 'degraded');
  assert.equal(byFeature.get('externalLinks').status, 'degraded');
  assert.equal(byFeature.get('relationships').detected, true);
});
