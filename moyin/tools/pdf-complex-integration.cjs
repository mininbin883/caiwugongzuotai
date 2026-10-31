#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const fontkit = require('@pdf-lib/fontkit');
const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFString,
  PDFHexString,
  rgb
} = require('pdf-lib');
const {
  recognizePdf,
  renderRedactedPdf,
  inspectPdfFeatures,
  extractNativePdfText
} = require('../src/services/pdf-redaction-service.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'pdf', 'phase19');
const SOURCE = path.join(OUTPUT, 'complex-source.pdf');
const REDACTED = path.join(OUTPUT, 'complex-structure-preserved.pdf');
const REPORT = path.join(OUTPUT, 'phase19-complex-pdf-report.json');
const FONT = 'C:/Windows/Fonts/arial.ttf';

async function createFixture() {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(await fs.readFile(FONT), { subset: true });
  const page = document.addPage([612, 792]);
  page.drawRectangle({ x: 36, y: 686, width: 540, height: 70, color: rgb(0.08, 0.18, 0.15) });
  page.drawText('COMPLEX PDF - CONTRACT REVIEW', { x: 54, y: 716, size: 20, font, color: rgb(1, 1, 1) });
  page.drawText('Client: Alice Example', { x: 54, y: 640, size: 15, font, color: rgb(0.05, 0.08, 0.07) });
  page.drawText('Phone: 13812345678', { x: 54, y: 610, size: 15, font, color: rgb(0.05, 0.08, 0.07) });
  page.drawText('Email: alice@example.com', { x: 54, y: 580, size: 15, font, color: rgb(0.05, 0.08, 0.07) });
  page.drawRectangle({ x: 48, y: 540, width: 510, height: 1, color: rgb(0.7, 0.72, 0.7) });
  for (let row = 0; row < 5; row += 1) {
    page.drawRectangle({ x: 54, y: 430 - row * 28, width: 480, height: 24, borderWidth: 0.7, borderColor: rgb(0.65, 0.67, 0.66) });
    page.drawText(`Clause ${row + 1}: vector content and embedded-font sample`, {
      x: 62,
      y: 438 - row * 28,
      size: 10,
      font,
      color: rgb(0.15, 0.17, 0.16)
    });
  }

  const form = document.getForm();
  const caseNumber = form.createTextField('CaseNumber');
  caseNumber.setText('APPROVED-001');
  caseNumber.addToPage(page, { x: 54, y: 190, width: 200, height: 26, font, borderWidth: 1 });
  const reviewed = form.createCheckBox('Reviewed');
  reviewed.check();
  reviewed.addToPage(page, { x: 280, y: 192, width: 20, height: 20, borderWidth: 1 });
  page.drawText('Reviewed', { x: 306, y: 197, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
  form.updateFieldAppearances(font);

  const context = document.context;
  const linkAction = context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/review') });
  const link = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [54, 130, 260, 155],
    Border: [0, 0, 1],
    A: linkAction,
    P: page.ref
  });
  page.node.addAnnot(context.register(link));
  page.drawText('Review portal annotation', { x: 54, y: 138, size: 11, font, color: rgb(0.05, 0.22, 0.5) });

  const signatureValue = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0],
    Contents: PDFHexString.of('00'.repeat(256)),
    M: PDFString.of("D:20261030120000+08'00'")
  });
  const signatureRef = context.register(signatureValue);
  const signatureField = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of('ApprovalSignature'),
    Rect: [330, 185, 540, 215],
    F: 4,
    P: page.ref,
    V: signatureRef
  });
  const signatureFieldRef = context.register(signatureField);
  page.node.addAnnot(signatureFieldRef);
  const acroForm = document.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acroForm.lookup(PDFName.of('Fields'), PDFArray).push(signatureFieldRef);

  const bytes = await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  await fs.writeFile(SOURCE, bytes);
}

async function main() {
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  await fs.mkdir(OUTPUT, { recursive: true });
  await createFixture();
  const before = await inspectPdfFeatures(SOURCE);
  const session = await recognizePdf(SOURCE);
  const analysis = analyzeText(session.text, { customTerms: ['Alice Example'] });
  const rendered = await renderRedactedPdf(session, analysis.findings, REDACTED);
  const after = await inspectPdfFeatures(REDACTED);
  const extracted = await extractNativePdfText(REDACTED);
  const raw = await fs.readFile(REDACTED);
  const outputDocument = await PDFDocument.load(raw, { updateMetadata: false });
  const form = outputDocument.getForm();
  const caseNumber = form.getTextField('CaseNumber').getText();
  const reviewed = form.getCheckBox('Reviewed').isChecked();
  const sensitiveAbsent = !extracted.text.includes('Alice Example') && !extracted.text.includes('13812345678') &&
    !extracted.text.includes('alice@example.com') && !raw.includes(Buffer.from('Alice Example')) &&
    !raw.includes(Buffer.from('13812345678')) && !raw.includes(Buffer.from('alice@example.com'));
  const pass = before.formFields >= 3 && before.annotations >= 4 && before.embeddedFontResources >= 1 &&
    before.signedSignatures === 1 && after.formFields === before.formFields && after.annotations === before.annotations &&
    after.embeddedFontResources >= before.embeddedFontResources && rendered.formsPreserved && rendered.annotationsPreserved &&
    rendered.embeddedFontsPreserved && rendered.signaturesPreservedAsFields &&
    rendered.signatureState === 'invalidated-by-modification' && rendered.secureContentReplacement &&
    caseNumber === 'APPROVED-001' && reviewed && sensitiveAbsent;
  const report = {
    format: 'VEILFORGE_COMPLEX_PDF_REPORT',
    result: pass ? 'PASS' : 'FAIL',
    source: SOURCE,
    output: REDACTED,
    before,
    after,
    render: rendered,
    formValues: { CaseNumber: caseNumber, Reviewed: reviewed },
    sensitiveAbsent,
    extractedText: extracted.text
  };
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_COMPLEX_${report.result} forms=${before.formFields}/${after.formFields} annotations=${before.annotations}/${after.annotations} fonts=${before.embeddedFontResources}/${after.embeddedFontResources} signatures=${before.signedSignatures}/${after.signedSignatures} state=${rendered.signatureState} safe=${sensitiveAbsent ? 1 : 0}\n`);
  process.stdout.write(`REPORT=${REPORT}\nOUTPUT=${REDACTED}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
