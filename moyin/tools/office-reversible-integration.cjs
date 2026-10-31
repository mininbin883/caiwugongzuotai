'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const {
  extractOfficeDocument,
  renderRedactedOffice,
  restoreReversibleOffice
} = require('../src/services/office-redaction-service.cjs');

function tokenFindings(sourceFindings, assignments) {
  const byRange = new Map(sourceFindings.map((finding) => [`${finding.start}:${finding.end}`, finding]));
  return assignments.map((assignment) => {
    const source = byRange.get(`${assignment.start}:${assignment.end}`);
    if (!source) throw new Error('TOKEN_ASSIGNMENT_SOURCE_MISSING');
    return {
      type: source.type,
      label: source.label,
      start: assignment.start,
      end: assignment.end,
      replacement: assignment.token,
      enabled: true
    };
  });
}

async function selectedPartHashes(filePath, names) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath), { checkCRC32: true });
  const crypto = require('node:crypto');
  const hashes = {};
  for (const name of names) {
    const buffer = await zip.file(name)?.async('nodebuffer');
    hashes[name] = buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null;
  }
  return hashes;
}

async function processOne(kind, input, tokenizedPath, restoredPath, nonce) {
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  const { tokenizeFindings } = await import('../src/core/reversible-token-engine.mjs');
  const source = await extractOfficeDocument(input);
  const analysis = analyzeText(source.text, { customTerms: ['张三', '李四'] });
  const reversible = tokenizeFindings(source.text, analysis.findings, { nonce });
  const rendered = await renderRedactedOffice(source.session, tokenFindings(analysis.findings, reversible.assignments), tokenizedPath);
  const tokenized = await extractOfficeDocument(tokenizedPath);
  const residual = analyzeText(tokenized.text, { customTerms: ['张三', '李四'] }).findings;
  const restored = await restoreReversibleOffice(tokenizedPath, reversible.mapping, restoredPath);
  const reopened = await extractOfficeDocument(restoredPath);
  const structuralParts = kind === 'docx'
    ? ['word/styles.xml', 'word/settings.xml', 'word/numbering.xml']
    : ['xl/styles.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'];
  const sourceParts = await selectedPartHashes(input, structuralParts);
  const restoredParts = await selectedPartHashes(restoredPath, structuralParts);
  const structurePreserved = structuralParts.every((name) => sourceParts[name] === restoredParts[name]);
  let formulasPreserved = true;
  if (kind === 'xlsx') {
    const sourceBook = XLSX.read(await fs.readFile(input), { type: 'buffer', cellFormula: true });
    const restoredBook = XLSX.read(await fs.readFile(restoredPath), { type: 'buffer', cellFormula: true });
    formulasPreserved = ['G4', 'G5', 'G6'].every((address) =>
      sourceBook.Sheets['客户清单'][address]?.f === restoredBook.Sheets['客户清单'][address]?.f);
  }
  return {
    kind,
    findings: analysis.findings.length,
    tokens: reversible.mapping.length,
    occurrences: reversible.occurrenceCount,
    tokenizedBytes: rendered.bytes,
    residual: residual.length,
    restoredOccurrences: restored.restoredOccurrences,
    complete: restored.complete,
    missing: restored.missingTokens.length,
    unknown: restored.unknownTokens.length,
    repeated: restored.repeatedTokens.length,
    exactText: reopened.text === source.text,
    structurePreserved,
    formulasPreserved
  };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'output', 'office', 'phase10');
  await fs.mkdir(directory, { recursive: true });
  const docx = await processOne(
    'docx',
    path.join(root, 'output', 'office', 'phase5-sensitive.docx'),
    path.join(directory, 'phase10-tokenized.docx'),
    path.join(directory, 'phase10-restored.docx'),
    'D0C0A010'
  );
  const xlsx = await processOne(
    'xlsx',
    path.join(root, 'output', 'office', 'phase5-sensitive.xlsx'),
    path.join(directory, 'phase10-tokenized.xlsx'),
    path.join(directory, 'phase10-restored.xlsx'),
    'A1B2C310'
  );
  const pass = [docx, xlsx].every((item) =>
    item.findings > 0 && item.tokens > 0 && item.occurrences === item.restoredOccurrences &&
    item.residual === 0 && item.complete && item.missing === 0 && item.unknown === 0 &&
    item.repeated === 0 && item.exactText && item.structurePreserved && item.formulasPreserved);
  const report = { format: 'VEILFORGE_OFFICE_REVERSIBLE_ROUNDTRIP', result: pass ? 'PASS' : 'FAIL', docx, xlsx };
  await fs.writeFile(path.join(directory, 'phase10-office-reversible-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`OFFICE_REVERSIBLE_${report.result} docx=${docx.restoredOccurrences}/${docx.occurrences} xlsx=${xlsx.restoredOccurrences}/${xlsx.occurrences} exact=${docx.exactText && xlsx.exactText ? 1 : 0} structure=${docx.structurePreserved && xlsx.structurePreserved ? 1 : 0} formulas=${xlsx.formulasPreserved ? 1 : 0}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`OFFICE_REVERSIBLE_ERROR ${error?.stack || error}\n`);
  process.exitCode = 2;
});

