#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fontkit = require('@pdf-lib/fontkit');
const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFString,
  PDFHexString,
  degrees,
  rgb
} = require('pdf-lib');
const {
  recognizePdf,
  renderRedactedPdf,
  inspectPdfFeatures,
  inspectPdfCompatibility,
  extractNativePdfText
} = require('../src/services/pdf-redaction-service.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'pdf', 'phase20');
const SOURCE = path.join(OUTPUT, 'rotated-crop-source.pdf');
const REDACTED = path.join(OUTPUT, 'rotated-crop-structure-preserved.pdf');
const ENCRYPTED = path.join(OUTPUT, 'encrypted-diagnostic.pdf');
const REPORT = path.join(OUTPUT, 'phase20-pdf-geometry-report.json');
const FONT = 'C:/Windows/Fonts/arial.ttf';
const CROP = { x: 60, y: 40, width: 600, height: 440 };

function rotatedRect(displayX, displayY, displayWidth, displayHeight) {
  return {
    x: CROP.x + displayY,
    y: CROP.y + displayX,
    width: displayHeight,
    height: displayWidth
  };
}

function drawDisplayText(page, text, options) {
  page.drawText(text, {
    x: CROP.x + options.y,
    y: CROP.y + options.x,
    size: options.size,
    font: options.font,
    color: options.color,
    rotate: degrees(90)
  });
}

async function createFixture() {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(await fs.readFile(FONT), { subset: true });
  const page = document.addPage([720, 540]);
  page.setCropBox(CROP.x, CROP.y, CROP.width, CROP.height);
  page.setRotation(degrees(90));

  const header = rotatedRect(0, 0, 440, 82);
  page.drawRectangle({ ...header, color: rgb(0.08, 0.18, 0.15) });
  drawDisplayText(page, 'ROTATED PDF - CROPBOX REVIEW', { x: 28, y: 30, size: 20, font, color: rgb(1, 1, 1) });
  drawDisplayText(page, 'Client: Alice Example', { x: 38, y: 135, size: 15, font, color: rgb(0.05, 0.08, 0.07) });
  drawDisplayText(page, 'Phone: 13812345678', { x: 38, y: 170, size: 15, font, color: rgb(0.05, 0.08, 0.07) });
  drawDisplayText(page, 'Email: alice@example.com', { x: 38, y: 205, size: 15, font, color: rgb(0.05, 0.08, 0.07) });

  for (let row = 0; row < 3; row += 1) {
    const box = rotatedRect(38, 275 + row * 45, 360, 34);
    page.drawRectangle({ ...box, borderWidth: 0.8, borderColor: rgb(0.62, 0.66, 0.64) });
    drawDisplayText(page, `Geometry row ${row + 1}: rotation and crop preserved`, {
      x: 50,
      y: 286 + row * 45,
      size: 10,
      font,
      color: rgb(0.12, 0.15, 0.14)
    });
  }

  const context = document.context;
  const linkRect = rotatedRect(38, 500, 240, 26);
  const linkAction = context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/geometry') });
  const link = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [linkRect.x, linkRect.y, linkRect.x + linkRect.width, linkRect.y + linkRect.height],
    Border: [0, 0, 1],
    A: linkAction,
    P: page.ref
  });
  page.node.addAnnot(context.register(link));
  drawDisplayText(page, 'Geometry review annotation', { x: 38, y: 508, size: 11, font, color: rgb(0.05, 0.22, 0.5) });

  const formPage = document.addPage([600, 400]);
  formPage.drawRectangle({ x: 36, y: 314, width: 528, height: 52, color: rgb(0.08, 0.18, 0.15) });
  formPage.drawText('INTERACTIVE FORM AND SIGNATURE STATE', { x: 54, y: 334, size: 17, font, color: rgb(1, 1, 1) });
  formPage.drawText('Canonical form values remain interactive after the page-content rewrite.', {
    x: 54,
    y: 280,
    size: 11,
    font,
    color: rgb(0.12, 0.15, 0.14)
  });
  const form = document.getForm();
  const caseNumber = form.createTextField('RotatedCaseNumber');
  caseNumber.setText('ROTATED-APPROVED');
  caseNumber.addToPage(formPage, { x: 54, y: 210, width: 260, height: 30, font, borderWidth: 1 });
  const reviewed = form.createCheckBox('RotatedReviewed');
  reviewed.check();
  reviewed.addToPage(formPage, { x: 350, y: 214, width: 22, height: 22, borderWidth: 1 });
  formPage.drawText('Reviewed', { x: 382, y: 218, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
  form.updateFieldAppearances(font);

  const signatureValue = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0],
    Contents: PDFHexString.of('00'.repeat(256)),
    M: PDFString.of("D:20261030193000+08'00'")
  });
  const signatureRef = context.register(signatureValue);
  const signatureField = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of('RotatedApprovalSignature'),
    Rect: [54, 130, 314, 165],
    F: 4,
    P: formPage.ref,
    V: signatureRef
  });
  const signatureFieldRef = context.register(signatureField);
  formPage.node.addAnnot(signatureFieldRef);
  const acroForm = document.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acroForm.lookup(PDFName.of('Fields'), PDFArray).push(signatureFieldRef);

  const xfaStream = context.stream(Buffer.from('<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="Phase20"/></template>'));
  const xfaRef = context.register(xfaStream);
  acroForm.set(PDFName.of('XFA'), context.obj([PDFString.of('template'), xfaRef]));

  const xmp = `<?xpacket begin=""?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF>\n</x:xmpmeta><?xpacket end="w"?>`;
  const metadataRef = context.register(context.stream(Buffer.from(xmp), { Type: 'Metadata', Subtype: 'XML' }));
  document.catalog.set(PDFName.of('Metadata'), metadataRef);

  const bytes = await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  await fs.writeFile(SOURCE, bytes);
}

function createEncryptedFixture() {
  const code = [
    'from pypdf import PdfReader, PdfWriter',
    'import sys',
    'reader=PdfReader(sys.argv[1])',
    'writer=PdfWriter()',
    'writer.clone_document_from_reader(reader)',
    'writer.encrypt("phase20-password")',
    'writer.write(sys.argv[2])'
  ].join(';');
  const result = spawnSync('python', ['-c', code, SOURCE, ENCRYPTED], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ENCRYPTED_FIXTURE_FAILED:${result.stderr || result.stdout}`);
}

async function main() {
  const { analyzeText } = await import('../src/core/redaction-engine.mjs');
  await fs.mkdir(OUTPUT, { recursive: true });
  await createFixture();
  createEncryptedFixture();

  const before = await inspectPdfFeatures(SOURCE);
  const encryptedCompatibility = await inspectPdfCompatibility(ENCRYPTED);
  let encryptedError = '';
  try {
    await recognizePdf(ENCRYPTED);
  } catch (error) {
    encryptedError = String(error?.code || error?.message || error);
  }

  const session = await recognizePdf(SOURCE);
  const analysis = analyzeText(session.text, { customTerms: ['Alice Example'] });
  const rendered = await renderRedactedPdf(session, analysis.findings, REDACTED);
  const after = await inspectPdfFeatures(REDACTED);
  const extracted = await extractNativePdfText(REDACTED);
  const raw = await fs.readFile(REDACTED);
  const outputDocument = await PDFDocument.load(raw, { updateMetadata: false });
  const outputForm = outputDocument.getForm();
  const formValues = {
    RotatedCaseNumber: outputForm.getTextField('RotatedCaseNumber').getText(),
    RotatedReviewed: outputForm.getCheckBox('RotatedReviewed').isChecked()
  };
  const sensitiveValues = ['Alice Example', '13812345678', 'alice@example.com'];
  const sensitiveAbsent = sensitiveValues.every((value) => !extracted.text.includes(value) && !raw.includes(Buffer.from(value)));

  const pass = before.pages === 2 && before.rotations[0] === 90 && before.rotations[1] === 0 && before.rotatedPages === 1 && before.croppedPages === 1 && before.hasXfa &&
    before.pdfaDeclared && before.pdfaPart === '2' && before.pdfaConformance === 'B' && before.signedSignatures === 1 &&
    after.rotations[0] === before.rotations[0] && after.croppedPages === before.croppedPages && after.hasXfa === before.hasXfa &&
    after.pdfaDeclared && after.pdfaPart === before.pdfaPart && after.pdfaConformance === before.pdfaConformance &&
    rendered.preservationMode === 'structure-preserving-raster' && rendered.rotationsPreserved && rendered.cropBoxesPreserved &&
    rendered.xfaPreserved && rendered.pdfaDeclarationPreserved && rendered.signatureState === 'invalidated-by-modification' &&
    rendered.resigning?.required && rendered.resigning?.documentSha256 && rendered.resigning?.nextAction === 'apply-new-signature-after-export' &&
    encryptedCompatibility.encrypted && encryptedCompatibility.encryptionState === 'encrypted-password-required' &&
    encryptedError === 'LOCAL_PDF_PASSWORD_REQUIRED' && formValues.RotatedCaseNumber === 'ROTATED-APPROVED' &&
    formValues.RotatedReviewed && sensitiveAbsent;

  const report = {
    format: 'VEILFORGE_PDF_GEOMETRY_REPORT',
    result: pass ? 'PASS' : 'FAIL',
    source: SOURCE,
    output: REDACTED,
    before,
    after,
    render: rendered,
    encryptedCompatibility,
    encryptedError,
    formValues,
    sensitiveAbsent,
    extractedText: extracted.text
  };
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PDF_GEOMETRY_${report.result} rotation=${before.rotations[0]}/${after.rotations[0]} crop=${before.croppedPages}/${after.croppedPages} xfa=${before.hasXfa ? 1 : 0}/${after.hasXfa ? 1 : 0} pdfa=${before.pdfaPart}${before.pdfaConformance}/${after.pdfaPart}${after.pdfaConformance} encrypted=${encryptedCompatibility.encrypted ? 1 : 0} resign=${rendered.resigning?.required ? 1 : 0} safe=${sensitiveAbsent ? 1 : 0}\n`);
  process.stdout.write(`REPORT=${REPORT}\nOUTPUT=${REDACTED}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
