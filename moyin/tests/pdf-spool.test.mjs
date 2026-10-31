import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { recognizePdf } = require('../src/services/pdf-redaction-service.cjs');
const { createResourceBudget } = require('../src/services/resource-budget-service.cjs');

test('PDF recognition spools processed pages instead of retaining image buffers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veilforge-pdf-spool-'));
  const input = path.join(root, 'source.pdf');
  const pages = path.join(root, 'pages');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = document.addPage([180, 180]);
    page.drawText(`Page ${index + 1} contact 13812345678`, { x: 10, y: 140, size: 9, font });
  }
  await fs.writeFile(input, await document.save());
  const result = await recognizePdf(input, {
    pageDirectory: pages,
    budget: createResourceBudget({ profile: 'parity' })
  });
  assert.equal(result.pageCount, 2);
  assert.equal(result.nativePages, 2);
  for (const page of result.pages) {
    assert.equal(page.image, undefined);
    assert.ok(path.isAbsolute(page.imagePath));
    assert.ok((await fs.stat(page.imagePath)).size > 0);
  }
  assert.ok(result.resourceBudget.peakRssBytes > 0);
  await fs.rm(root, { recursive: true, force: true });
});
