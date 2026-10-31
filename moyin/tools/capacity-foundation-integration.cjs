'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createResourceBudget, MiB } = require('../src/services/resource-budget-service.cjs');
const { createJobWorkspace, recoverOrphanedWorkspaces, WORKSPACE_PREFIX } = require('../src/services/job-workspace-service.cjs');
const { BoundedWorkerPool } = require('../src/services/worker-pool.cjs');
const { recognizePdf } = require('../src/services/pdf-redaction-service.cjs');

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createPdf(filePath, pageCount) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([180, 180]);
    page.drawText(`Page ${String(index + 1).padStart(3, '0')} contact 13812345678`, {
      x: 8,
      y: 142,
      size: 8,
      font
    });
  }
  await fs.writeFile(filePath, await document.save({ useObjectStreams: true }));
}

async function main() {
  const outputRoot = path.resolve(process.argv[2] || path.join('output', 'capacity', 'phase16'));
  const reportPath = path.resolve(process.argv[3] || path.join(outputRoot, 'phase16-capacity-report.json'));
  await fs.mkdir(outputRoot, { recursive: true });
  const runDirectory = path.join(outputRoot, `run-${randomUUID()}`);
  const jobsRoot = path.join(runDirectory, 'jobs');
  await fs.mkdir(runDirectory, { recursive: false });

  const largeInput = path.join(runDirectory, 'exact-100MiB.bin');
  const handle = await fs.open(largeInput, 'wx', 0o600);
  await handle.truncate(100 * MiB);
  await handle.close();

  const stageStarted = Date.now();
  const stageBudget = createResourceBudget({ profile: 'parity' });
  const staged = await createJobWorkspace(largeInput, {
    root: jobsRoot,
    jobId: 'capacity-100mib',
    budget: stageBudget
  });
  const stagedBytes = (await fs.stat(staged.inputPath)).size;
  const stagedSha256 = staged.sourceSha256;
  const stageMilliseconds = Date.now() - stageStarted;
  if (stagedBytes !== 100 * MiB) throw new Error(`CAPACITY_STAGE_SIZE_MISMATCH:${stagedBytes}`);
  const stageDirectory = staged.directory;
  await staged.cleanup();
  await fs.rm(largeInput, { force: true });
  if (await exists(stageDirectory)) throw new Error('CAPACITY_STAGE_PLAINTEXT_REMAINS');

  const pdfInput = path.join(outputRoot, 'phase16-300-pages.pdf');
  await createPdf(pdfInput, 300);
  const pdfWorkspace = await createJobWorkspace(pdfInput, {
    root: jobsRoot,
    jobId: 'capacity-300-page-pdf',
    budget: createResourceBudget({ profile: 'parity' })
  });
  const pdfStarted = Date.now();
  const pdf = await recognizePdf(pdfWorkspace.inputPath, {
    pageDirectory: pdfWorkspace.pageDirectory,
    budget: pdfWorkspace.budget
  });
  const pdfMilliseconds = Date.now() - pdfStarted;
  let spooledPages = 0;
  for (const page of pdf.pages) {
    if (!page.image && path.isAbsolute(page.imagePath) && await exists(page.imagePath)) spooledPages += 1;
  }
  if (pdf.pageCount !== 300 || pdf.nativePages !== 300 || spooledPages !== 300) {
    throw new Error(`CAPACITY_PDF_MISMATCH:${pdf.pageCount}/${pdf.nativePages}/${spooledPages}`);
  }
  const peakRssBytes = pdf.resourceBudget.peakRssBytes;
  if (peakRssBytes > pdfWorkspace.budget.profile.maxRssBytes) throw new Error('CAPACITY_RSS_EXCEEDED');
  const pdfWorkspaceDirectory = pdfWorkspace.directory;
  await pdfWorkspace.cleanup();
  if (await exists(pdfWorkspaceDirectory)) throw new Error('CAPACITY_PDF_PLAINTEXT_REMAINS');

  const pool = new BoundedWorkerPool({ concurrency: 1 });
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const canceled = pool.run(async ({ signal }) => {
    while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('LOCAL_JOB_ABORTED');
  }, { signal: controller.signal }).then(() => false, (error) => error.message === 'LOCAL_JOB_ABORTED');
  setTimeout(() => controller.abort(new Error('capacity-cancel')), 40);
  const cancelObserved = await canceled;
  const cancelMilliseconds = Date.now() - cancelStarted;
  await pool.drain();
  pool.close();
  if (!cancelObserved || cancelMilliseconds >= 5000) throw new Error(`CAPACITY_CANCEL_FAILED:${cancelMilliseconds}`);

  const orphan = path.join(jobsRoot, `${WORKSPACE_PREFIX}dead-capacity-job`);
  await fs.mkdir(orphan, { recursive: false });
  await fs.writeFile(path.join(orphan, 'job-manifest.json'), `${JSON.stringify({ pid: 2147483647 })}\n`, 'utf8');
  const recovery = await recoverOrphanedWorkspaces(jobsRoot);
  if (recovery.removed !== 1 || await exists(orphan)) throw new Error('CAPACITY_RECOVERY_FAILED');

  const record = {
    format: 'VEILFORGE_CAPACITY_FOUNDATION',
    version: 1,
    result: 'PASS',
    input: {
      bytes: stagedBytes,
      mebibytes: stagedBytes / MiB,
      sha256: stagedSha256,
      milliseconds: stageMilliseconds,
      plaintextCleaned: true
    },
    pdf: {
      path: pdfInput,
      bytes: (await fs.stat(pdfInput)).size,
      pages: pdf.pageCount,
      nativePages: pdf.nativePages,
      spooledPages,
      milliseconds: pdfMilliseconds,
      peakRssBytes,
      peakRssMiB: Number((peakRssBytes / MiB).toFixed(2)),
      plaintextCleaned: true
    },
    cancellation: { observed: cancelObserved, milliseconds: cancelMilliseconds, underFiveSeconds: cancelMilliseconds < 5000 },
    recovery,
    limits: pdfWorkspace.budget.profile
  };
  await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`CAPACITY_FOUNDATION_PASS input=100MiB pdf=300 spooled=300 peakRss=${record.pdf.peakRssMiB}MiB cancel=${cancelMilliseconds}ms recovered=${recovery.removed}\n`);
  process.stdout.write(`REPORT=${reportPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`CAPACITY_FOUNDATION_FAIL ${error?.stack || error}\n`);
  process.exitCode = 1;
});
