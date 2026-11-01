'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCanvas, DOMMatrix, ImageData, Path2D } = require('@napi-rs/canvas');
const sharp = require('sharp');
const {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  PDFRef,
  PDFArray,
  PDFDict
} = require('pdf-lib');
const { recognizeImageBuffer } = require('./ocr-service.cjs');
const { officeTokenFindings, normalizeReversibleMapping } = require('./office-redaction-service.cjs');
const { createResourceBudget } = require('./resource-budget-service.cjs');

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const MAX_PAGE_PIXELS = 12 * 1024 * 1024;
const TARGET_SCALE = 2;
const NATIVE_TEXT_MIN_CHARACTERS = 8;
const REVERSIBLE_TOKEN_PATTERN = /^\[MI_[A-F0-9]{8}_[0-9A-Z]{3,6}\]$/u;

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;

let pdfjsPromise;

function pdfName(value) {
  return value instanceof PDFName ? value.toString() : '';
}

function normalizeRightAngle(angle) {
  const normalized = ((Number(angle || 0) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : null;
}

function boxSnapshot(box) {
  return {
    x: Number(box?.x || 0),
    y: Number(box?.y || 0),
    width: Number(box?.width || 0),
    height: Number(box?.height || 0)
  };
}

function sameBox(left, right) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(Number(left?.[key] || 0) - Number(right?.[key] || 0)) < 0.001);
}

function inspectPdfBytes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('LOCAL_PDF_BYTES_INVALID');
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = source.subarray(0, Math.min(source.length, 1024)).toString('latin1');
  const version = header.match(/%PDF-(\d\.\d)/u)?.[1] || 'unknown';
  const encrypted = source.includes(Buffer.from('/Encrypt'));
  const xfaMarker = source.includes(Buffer.from('/XFA'));
  const pdfaNeedle = Buffer.from('pdfaid:part');
  const pdfaIndex = source.indexOf(pdfaNeedle);
  let pdfaPart = '';
  let pdfaConformance = '';
  if (pdfaIndex >= 0) {
    const start = Math.max(0, pdfaIndex - 512);
    const end = Math.min(source.length, pdfaIndex + 2048);
    const metadata = source.subarray(start, end).toString('utf8');
    pdfaPart = metadata.match(/pdfaid:part[^>]*>\s*([^<\s]+)/iu)?.[1] || metadata.match(/pdfaid:part=["']([^"']+)/iu)?.[1] || '';
    pdfaConformance = metadata.match(/pdfaid:conformance[^>]*>\s*([^<\s]+)/iu)?.[1] || metadata.match(/pdfaid:conformance=["']([^"']+)/iu)?.[1] || '';
  }
  return {
    pdfVersion: version,
    encrypted,
    encryptionState: encrypted ? 'encrypted-password-required' : 'not-encrypted',
    xfaMarker,
    pdfaDeclared: pdfaIndex >= 0,
    pdfaPart,
    pdfaConformance,
    pdfaState: pdfaIndex >= 0 ? 'declared-source-unvalidated' : 'not-declared'
  };
}

function arrayItems(value, context) {
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  if (!(resolved instanceof PDFArray)) return [];
  return Array.from({ length: resolved.size() }, (_, index) => resolved.get(index));
}

function embeddedFont(fontValue, context, visited = new Set()) {
  const key = fontValue instanceof PDFRef ? fontValue.toString() : fontValue;
  if (visited.has(key)) return false;
  visited.add(key);
  const font = fontValue instanceof PDFRef ? context.lookupMaybe(fontValue, PDFDict) : fontValue;
  if (!(font instanceof PDFDict)) return false;
  const descriptor = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  if (descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((name) => descriptor.has(PDFName.of(name)))) return true;
  const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  if (!descendants) return false;
  for (let index = 0; index < descendants.size(); index += 1) {
    if (embeddedFont(descendants.get(index), context, visited)) return true;
  }
  return false;
}

function inspectPdfDocument(document) {
  const context = document.context;
  const annotationSubtypes = {};
  const fontRefs = new Map();
  let annotations = 0;
  let widgets = 0;
  let links = 0;
  let contentStreams = 0;
  const rotations = [];
  const mediaBoxes = [];
  const cropBoxes = [];
  const pageGeometry = [];
  let rotatedPages = 0;
  let croppedPages = 0;
  for (const page of document.getPages()) {
    const rotation = normalizeRightAngle(page.getRotation().angle);
    const mediaBox = boxSnapshot(page.getMediaBox());
    const cropBox = boxSnapshot(page.getCropBox());
    const cropped = !sameBox(mediaBox, cropBox);
    rotations.push(rotation ?? page.getRotation().angle);
    mediaBoxes.push(mediaBox);
    cropBoxes.push(cropBox);
    pageGeometry.push({ rotation: rotation ?? page.getRotation().angle, mediaBox, cropBox, cropped });
    if (rotation) rotatedPages += 1;
    if (cropped) croppedPages += 1;
    const contents = page.node.Contents();
    contentStreams += contents instanceof PDFArray ? contents.size() : contents ? 1 : 0;
    const resources = page.node.Resources();
    const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
    for (const [name, value] of fonts?.entries() || []) {
      const key = value instanceof PDFRef ? value.toString() : `${page.ref}:${name}`;
      if (!fontRefs.has(key)) fontRefs.set(key, embeddedFont(value, context));
    }
    const pageAnnotations = page.node.Annots();
    if (pageAnnotations instanceof PDFArray) {
      annotations += pageAnnotations.size();
      for (let index = 0; index < pageAnnotations.size(); index += 1) {
        const annotation = context.lookupMaybe(pageAnnotations.get(index), PDFDict);
        const subtype = pdfName(annotation?.lookupMaybe(PDFName.of('Subtype'), PDFName)) || '/Unknown';
        annotationSubtypes[subtype] = (annotationSubtypes[subtype] || 0) + 1;
        if (subtype === '/Widget') widgets += 1;
        if (subtype === '/Link') links += 1;
      }
    }
  }

  let formFields = 0;
  let signatureFields = 0;
  let signedSignatures = 0;
  let hasXfa = false;
  const acroForm = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm) {
    hasXfa = acroForm.has(PDFName.of('XFA'));
    const visited = new Set();
    const visit = (value, inheritedType = '') => {
      const key = value instanceof PDFRef ? value.toString() : value;
      if (visited.has(key)) return;
      visited.add(key);
      const field = context.lookupMaybe(value, PDFDict);
      if (!field) return;
      const type = pdfName(field.lookupMaybe(PDFName.of('FT'), PDFName)) || inheritedType;
      const subtype = pdfName(field.lookupMaybe(PDFName.of('Subtype'), PDFName));
      const hasName = Boolean(field.get(PDFName.of('T')));
      if (hasName || (type && subtype !== '/Widget')) {
        formFields += 1;
        if (type === '/Sig') {
          signatureFields += 1;
          if (field.get(PDFName.of('V'))) signedSignatures += 1;
        }
      }
      const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
      if (kids) for (let index = 0; index < kids.size(); index += 1) visit(kids.get(index), type);
    };
    const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (fields) for (let index = 0; index < fields.size(); index += 1) visit(fields.get(index));
  }
  return {
    pages: document.getPageCount(),
    contentStreams,
    annotations,
    widgets,
    links,
    annotationSubtypes,
    formFields,
    hasXfa,
    fontResources: fontRefs.size,
    embeddedFontResources: [...fontRefs.values()].filter(Boolean).length,
    rotations,
    mediaBoxes,
    cropBoxes,
    pageGeometry,
    rotatedPages,
    croppedPages,
    signatureFields,
    signedSignatures,
    signatureState: signedSignatures ? 'signed-present' : signatureFields ? 'unsigned-signature-fields' : 'not-present',
    xfaState: hasXfa ? 'present-unvalidated' : 'not-present'
  };
}

function emptyPdfFeatures(compatibility = {}) {
  return {
    pages: 0,
    contentStreams: 0,
    annotations: 0,
    widgets: 0,
    links: 0,
    annotationSubtypes: {},
    formFields: 0,
    hasXfa: Boolean(compatibility.xfaMarker),
    fontResources: 0,
    embeddedFontResources: 0,
    rotations: [],
    mediaBoxes: [],
    cropBoxes: [],
    pageGeometry: [],
    rotatedPages: 0,
    croppedPages: 0,
    signatureFields: 0,
    signedSignatures: 0,
    signatureState: 'unknown-encrypted',
    xfaState: compatibility.xfaMarker ? 'present-unvalidated' : 'not-present',
    ...compatibility
  };
}

async function inspectPdfCompatibility(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('LOCAL_PATH_INVALID');
  }
  const bytes = await fs.readFile(filePath);
  if (bytes.length > MAX_PDF_BYTES) throw new Error('LOCAL_PDF_TOO_LARGE');
  return inspectPdfBytes(bytes);
}

async function inspectPdfFeatures(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('LOCAL_PATH_INVALID');
  }
  const bytes = await fs.readFile(filePath);
  if (bytes.length > MAX_PDF_BYTES) throw new Error('LOCAL_PDF_TOO_LARGE');
  const compatibility = inspectPdfBytes(bytes);
  if (compatibility.encrypted) {
    const error = new Error('LOCAL_PDF_ENCRYPTED');
    error.code = 'LOCAL_PDF_ENCRYPTED';
    error.pdfCompatibility = compatibility;
    throw error;
  }
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return { ...inspectPdfDocument(document), ...compatibility };
}

function directoryUrl(directory) {
  return `${directory.replace(/\\/g, '/')}/`;
}

async function getPdfJs() {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function pdfAssetDirectory(name) {
  return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name);
}

function renderScale(page) {
  const base = page.getViewport({ scale: 1 });
  const pixelScale = Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, base.width * base.height));
  return Math.max(1, Math.min(TARGET_SCALE, pixelScale));
}

async function renderPage(page) {
  const viewport = page.getViewport({ scale: renderScale(page) });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  if (width * height > MAX_PAGE_PIXELS + Math.max(width, height)) throw new Error('LOCAL_PDF_PAGE_TOO_LARGE');
  const canvas = createCanvas(width, height);
  const canvasContext = canvas.getContext('2d');
  await page.render({ canvas, canvasContext, viewport, intent: 'display' }).promise;
  return {
    image: canvas.toBuffer('image/png'),
    width,
    height,
    pdfWidth: page.getViewport({ scale: 1 }).width,
    pdfHeight: page.getViewport({ scale: 1 }).height
  };
}

function textItemViewportBounds(item, viewport) {
  const transform = Array.isArray(item?.transform) || ArrayBuffer.isView(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
  const [a, b, c, d, e, f] = Array.from(transform, Number);
  const advance = Math.max(0.1, Number(item?.width || 0));
  const glyphHeight = Math.max(1, Math.abs(Number(item?.height || Math.hypot(c, d) || Math.hypot(a, b) || 1)));
  const baselineScale = Math.max(0.0001, Math.hypot(a, b));
  const verticalScale = Math.max(0.0001, Math.hypot(c, d));
  const advanceX = a / baselineScale * advance;
  const advanceY = b / baselineScale * advance;
  const heightX = c / verticalScale * glyphHeight;
  const heightY = d / verticalScale * glyphHeight;
  const convertPoint = (x, y) => {
    if (typeof viewport.convertToViewportPoint === 'function') return viewport.convertToViewportPoint(x, y);
    const converted = viewport.convertToViewportRectangle([x, y, x, y]);
    return [converted[0], converted[1]];
  };
  const corners = [
    [e, f],
    [e + advanceX, f + advanceY],
    [e + heightX, f + heightY],
    [e + advanceX + heightX, f + advanceY + heightY]
  ].map(([x, y]) => convertPoint(x, y));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    left: Math.max(0, Math.min(...xs)),
    top: Math.max(0, Math.min(...ys)),
    right: Math.min(viewport.width, Math.max(...xs)),
    bottom: Math.min(viewport.height, Math.max(...ys))
  };
}

function nativePageText(items, viewport, globalOffset = 0) {
  let text = '';
  const words = [];
  let previous = null;
  for (const item of items || []) {
    const value = String(item?.str || '');
    if (!value.trim()) {
      if (item?.hasEOL && text && !text.endsWith('\n')) text += '\n';
      continue;
    }
    const bounds = textItemViewportBounds(item, viewport);
    const x = bounds.left;
    const y = bounds.top;
    const width = Math.max(0.1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    if (previous) {
      const lineChanged = Math.abs(y - previous.y) > Math.max(height, previous.height) * 0.55;
      if ((previous.hasEOL || lineChanged) && !text.endsWith('\n')) text += '\n';
      else if (!/\s$/u.test(text) && x - (previous.x + previous.width) > Math.max(1, height * 0.12)) text += ' ';
    }
    const start = globalOffset + text.length;
    text += value;
    words.push({
      text: value,
      start,
      end: start + value.length,
      confidence: 100,
      bbox: { x0: Math.round(bounds.left), y0: Math.round(bounds.top), x1: Math.round(bounds.right), y1: Math.round(bounds.bottom) }
    });
    previous = { x, y, width, height, hasEOL: Boolean(item.hasEOL) };
  }
  return { text: text.replace(/\s+$/u, ''), words };
}

async function recognizePdf(filePath, options = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_PATH_INVALID');
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('LOCAL_PDF_TYPE_UNSUPPORTED');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('LOCAL_NOT_A_FILE');
  if (stat.size > MAX_PDF_BYTES) throw new Error('LOCAL_PDF_TOO_LARGE');
  const budget = options.budget || createResourceBudget({
    profile: 'parity',
    maxInputBytes: MAX_PDF_BYTES,
    maxPdfPages: MAX_PDF_PAGES
  });
  budget.assertInputBytes(stat.size);
  budget.assertNotAborted(options.signal);
  const pageDirectory = options.pageDirectory ? path.resolve(options.pageDirectory) : '';
  if (pageDirectory) {
    if (!path.isAbsolute(pageDirectory)) throw new Error('LOCAL_WORKSPACE_PATH_INVALID');
    await fs.mkdir(pageDirectory, { recursive: true, mode: 0o700 });
  }

  const source = await fs.readFile(filePath);
  const compatibility = inspectPdfBytes(source);
  const password = typeof options.password === 'string' ? options.password : '';
  if (compatibility.encrypted && !password) {
    const error = new Error('LOCAL_PDF_PASSWORD_REQUIRED');
    error.code = 'LOCAL_PDF_PASSWORD_REQUIRED';
    error.pdfCompatibility = compatibility;
    throw error;
  }
  const structuralDocument = compatibility.encrypted ? null : await PDFDocument.load(source, { updateMetadata: false });
  const pdfFeatures = structuralDocument
    ? { ...inspectPdfDocument(structuralDocument), ...compatibility }
    : { ...emptyPdfFeatures(compatibility), encryptionState: 'decrypted-in-memory', passwordDecryptedInMemory: true };
  const pdfjs = await getPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(source),
    password: compatibility.encrypted ? password : undefined,
    cMapUrl: directoryUrl(pdfAssetDirectory('cmaps')),
    cMapPacked: true,
    standardFontDataUrl: directoryUrl(pdfAssetDirectory('standard_fonts')),
    wasmUrl: directoryUrl(pdfAssetDirectory('wasm')),
    useSystemFonts: true,
    isEvalSupported: false,
    enableXfa: false
  });
  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => {});
    if (compatibility.encrypted && (error?.name === 'PasswordException' || /password/iu.test(String(error?.message || '')))) {
      const passwordError = new Error('LOCAL_PDF_PASSWORD_INVALID');
      passwordError.code = 'LOCAL_PDF_PASSWORD_INVALID';
      passwordError.pdfCompatibility = compatibility;
      throw passwordError;
    }
    throw error;
  }
  try {
    budget.assertPdfPages(document.numPages);
  } catch (error) {
    await loadingTask.destroy();
    throw error;
  }

  const pages = [];
  let text = '';
  let confidenceTotal = 0;
  let nativePages = 0;
  let ocrPages = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      budget.assertNotAborted(options.signal);
      budget.sample(`pdf-page-${pageNumber}-start`);
      options.onProgress?.({ stage: 'pdf-page', pageNumber, pageCount: document.numPages });
      const page = await document.getPage(pageNumber);
      if (compatibility.encrypted) {
        const view = Array.from(page.view || [0, 0, page.getViewport({ scale: 1 }).width, page.getViewport({ scale: 1 }).height], Number);
        const cropBox = { x: view[0], y: view[1], width: view[2] - view[0], height: view[3] - view[1] };
        const rotation = normalizeRightAngle(page.rotate) ?? Number(page.rotate || 0);
        pdfFeatures.rotations.push(rotation);
        pdfFeatures.mediaBoxes.push({ ...cropBox });
        pdfFeatures.cropBoxes.push({ ...cropBox });
        pdfFeatures.pageGeometry.push({ rotation, mediaBox: { ...cropBox }, cropBox: { ...cropBox }, cropped: false });
        if (rotation) pdfFeatures.rotatedPages += 1;
      }
      const rendered = await renderPage(page);
      if (text) text += '\n\f\n';
      const offset = text.length;
      const viewport = page.getViewport({ scale: rendered.width / Math.max(1, rendered.pdfWidth) });
      const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const native = nativePageText(textContent.items, viewport, offset);
      const nativeCharacters = native.text.replace(/\s/gu, '').length;
      let pageText;
      let words;
      let previewDataUrl;
      let confidence;
      let textMode;
      let processedImage = rendered.image;
      let processedWidth = rendered.width;
      let processedHeight = rendered.height;
      let tableRegions = [];
      let gridTables = [];
      let columns = [];
      let readingOrder = 'rows-top-to-bottom';
      let corrections = [];
      let orientationDegrees = 0;
      let orientationDetected = false;
      let enhancement = null;
      let segmentationMode = 'native';
      let recognitionPasses = 0;
      if (nativeCharacters >= NATIVE_TEXT_MIN_CHARACTERS) {
        pageText = native.text;
        words = native.words;
        confidence = 100;
        textMode = 'native';
        nativePages += 1;
        const preview = await sharp(rendered.image).resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer();
        previewDataUrl = `data:image/png;base64,${preview.toString('base64')}`;
      } else {
        const ocr = await recognizeImageBuffer(rendered.image, {
          name: `${path.basename(filePath)}#${pageNumber}.png`,
          extension: '.png',
          sourceBytes: rendered.image.length
        });
        pageText = ocr.text;
        words = ocr.words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset }));
        previewDataUrl = ocr.previewDataUrl;
        confidence = ocr.confidence;
        processedImage = ocr.image;
        processedWidth = ocr.width;
        processedHeight = ocr.height;
        tableRegions = ocr.tableRegions;
        gridTables = ocr.gridTables;
        columns = ocr.columns;
        readingOrder = ocr.readingOrder;
        corrections = ocr.corrections;
        orientationDegrees = ocr.orientationDegrees;
        orientationDetected = ocr.orientationDetected;
        enhancement = ocr.enhancement;
        segmentationMode = ocr.segmentationMode;
        recognitionPasses = ocr.recognitionPasses;
        textMode = 'ocr';
        ocrPages += 1;
      }
      text += pageText;
      confidenceTotal += confidence;
      let imagePath = '';
      if (pageDirectory) {
        imagePath = path.join(pageDirectory, `page-${String(pageNumber).padStart(4, '0')}.png`);
        await fs.writeFile(imagePath, processedImage, { flag: 'wx', mode: 0o600 });
      }
      pages.push({
        pageNumber,
        image: pageDirectory ? undefined : processedImage,
        imagePath: imagePath || undefined,
        width: processedWidth,
        height: processedHeight,
        pdfWidth: rendered.pdfWidth,
        pdfHeight: rendered.pdfHeight,
        words,
        previewDataUrl,
        confidence,
        textMode,
        tableRegions,
        gridTables,
        columns,
        readingOrder,
        corrections,
        orientationDegrees,
        orientationDetected,
        enhancement,
        segmentationMode,
        recognitionPasses,
        textStart: offset,
        textEnd: offset + pageText.length,
        text: pageText
      });
      page.cleanup?.();
      budget.sample(`pdf-page-${pageNumber}-done`);
    }
  } finally {
    await loadingTask.destroy();
  }
  if (compatibility.encrypted) pdfFeatures.pages = pages.length;

  return {
    name: path.basename(filePath),
    extension: '.pdf',
    sourceBytes: stat.size,
    characters: text.length,
    text,
    pages,
    pageCount: pages.length,
    confidence: Math.round(confidenceTotal / Math.max(1, pages.length)),
    nativePages,
    ocrPages,
    sourceMode: nativePages && ocrPages ? 'hybrid' : nativePages ? 'native' : 'ocr',
    sourcePath: filePath,
    encryptionState: pdfFeatures.encryptionState,
    passwordDecryptedInMemory: Boolean(pdfFeatures.passwordDecryptedInMemory),
    pdfFeatures,
    resourceBudget: budget.snapshot()
  };
}

async function extractNativePdfText(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('LOCAL_PATH_INVALID');
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_PDF_BYTES) throw new Error('LOCAL_PDF_TOO_LARGE');
  const source = await fs.readFile(filePath);
  const pdfjs = await getPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(source),
    cMapUrl: directoryUrl(pdfAssetDirectory('cmaps')),
    cMapPacked: true,
    standardFontDataUrl: directoryUrl(pdfAssetDirectory('standard_fonts')),
    wasmUrl: directoryUrl(pdfAssetDirectory('wasm')),
    useSystemFonts: true,
    isEvalSupported: false,
    enableXfa: false
  });
  const document = await loadingTask.promise;
  if (!document.numPages || document.numPages > MAX_PDF_PAGES) {
    await loadingTask.destroy();
    throw new Error('LOCAL_PDF_PAGE_COUNT_INVALID');
  }
  let text = '';
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      if (text) text += '\n\f\n';
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      text += nativePageText(content.items, page.getViewport({ scale: 1 }), text.length).text;
    }
  } finally {
    await loadingTask.destroy();
  }
  return { text, pageCount: document.numPages };
}

function collectIndirectRefs(value, context, refs) {
  if (value instanceof PDFRef) {
    refs.add(value);
    const resolved = context.lookup(value);
    if (resolved instanceof PDFArray) {
      for (let index = 0; index < resolved.size(); index += 1) collectIndirectRefs(resolved.get(index), context, refs);
    }
    return;
  }
  if (value instanceof PDFArray) {
    for (let index = 0; index < value.size(); index += 1) collectIndirectRefs(value.get(index), context, refs);
  }
}

async function pageRasterForGeometry(buffer, rotation) {
  const normalized = normalizeRightAngle(rotation);
  if (normalized === null) throw new Error('LOCAL_PDF_ROTATION_UNSUPPORTED');
  if (!normalized) return buffer;
  return sharp(buffer).rotate((360 - normalized) % 360).png({ compressionLevel: 9 }).toBuffer();
}

async function createPdfResigningRequest(filePath, details = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('LOCAL_PATH_INVALID');
  const bytes = await fs.readFile(filePath);
  const sourceSignatures = Math.max(0, Number(details.sourceSignatures || 0));
  const signatureState = String(details.signatureState || (sourceSignatures ? 'invalidated-by-modification' : 'not-present'));
  return {
    format: 'VEILFORGE_PDF_RESIGNING_REQUEST',
    version: 1,
    required: sourceSignatures > 0,
    integrationMode: 'external-post-export',
    hashAlgorithm: 'SHA-256',
    documentSha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    documentBytes: bytes.length,
    sourceSignatures,
    signatureState,
    byteRangePrepared: false,
    nextAction: sourceSignatures > 0 ? 'apply-new-signature-after-export' : 'optional-external-signature'
  };
}

// 文档属性（标题、作者等）、XMP 元数据、书签和批注文字常含公司名、人名：导出副本前清空。
function scrubPdfMetadata(document) {
  for (const setter of ['setTitle', 'setAuthor', 'setSubject', 'setCreator', 'setProducer']) document[setter]('');
  document.setKeywords([]);
  const catalog = document.catalog;
  for (const key of ['Metadata', 'Outlines', 'PieceInfo']) catalog.delete(PDFName.of(key));
  if (catalog.get(PDFName.of('PageMode'))?.toString() === '/UseOutlines') catalog.delete(PDFName.of('PageMode'));
  for (const page of document.getPages()) {
    page.node.delete(PDFName.of('Metadata'));
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let index = 0; index < (annots?.size() || 0); index += 1) {
      const annot = annots.lookupMaybe(index, PDFDict);
      if (!annot || annot.get(PDFName.of('Subtype'))?.toString() === '/Widget') continue;
      for (const key of ['Contents', 'T', 'RC', 'Subj']) annot.delete(PDFName.of(key));
    }
  }
}

async function renderStructurePreservingPdf(session, pageBuffers, outputPath, decoratePage = null) {
  const sourcePath = session?.sourcePath || session?.workspace?.inputPath;
  if (!sourcePath || !path.isAbsolute(sourcePath)) return null;
  const sourceBytes = await fs.readFile(sourcePath);
  if (inspectPdfBytes(sourceBytes).encrypted) return null;
  const document = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  scrubPdfMetadata(document);
  const before = inspectPdfDocument(document);
  const beforeCompatibility = inspectPdfBytes(sourceBytes);
  if (document.getPageCount() !== session.pages.length || before.rotations.some((angle) => normalizeRightAngle(angle) === null)) return null;
  const context = document.context;
  const staleRefs = new Set();
  const retainedRefs = new Set();
  let removedContentStreams = 0;
  let removedXObjects = 0;
  for (let index = 0; index < session.pages.length; index += 1) {
    const sourcePage = session.pages[index];
    const page = document.getPage(index);
    const originalContents = page.node.get(PDFName.of('Contents'));
    const contentRefs = new Set();
    collectIndirectRefs(originalContents, context, contentRefs);
    for (const ref of contentRefs) staleRefs.add(ref);
    removedContentStreams += contentRefs.size;

    const originalResourcesValue = page.node.get(PDFName.of('Resources'));
    const originalResources = page.node.Resources();
    const originalFontValue = originalResources?.get(PDFName.of('Font'));
    const originalXObjectValue = originalResources?.get(PDFName.of('XObject'));
    const originalXObjects = originalResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const oldXObjectKeys = new Set((originalXObjects?.keys() || []).map((key) => key.toString()));
    const oldXObjectRefs = new Set();
    for (const value of originalXObjects?.values() || []) if (value instanceof PDFRef) oldXObjectRefs.add(value);
    collectIndirectRefs(originalResourcesValue, context, staleRefs);
    collectIndirectRefs(originalXObjectValue, context, staleRefs);

    const geometry = before.pageGeometry[index];
    const pageRaster = await pageRasterForGeometry(pageBuffers[index], geometry.rotation);
    const image = await document.embedPng(pageRaster);
    page.drawImage(image, {
      x: geometry.cropBox.x,
      y: geometry.cropBox.y,
      width: geometry.cropBox.width,
      height: geometry.cropBox.height
    });
    if (decoratePage) await decoratePage({ document, page, sourcePage, index, geometry });
    if (!(page.contentStreamRef instanceof PDFRef)) throw new Error('LOCAL_PDF_STRUCTURE_PRESERVATION_FAILED');
    retainedRefs.add(page.contentStreamRef);
    page.node.set(PDFName.of('Contents'), context.obj([page.contentStreamRef]));

    const updatedResources = page.node.Resources();
    const updatedXObjects = updatedResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const cleanXObjects = context.obj({});
    for (const [name, value] of updatedXObjects?.entries() || []) {
      if (!oldXObjectKeys.has(name.toString())) {
        cleanXObjects.set(name, value);
        if (value instanceof PDFRef) retainedRefs.add(value);
      }
    }
    removedXObjects += oldXObjectRefs.size;
    for (const ref of oldXObjectRefs) staleRefs.add(ref);
    const cleanResources = context.obj({});
    const updatedFontValue = updatedResources?.get(PDFName.of('Font')) || originalFontValue;
    if (updatedFontValue) {
      cleanResources.set(PDFName.of('Font'), updatedFontValue);
      if (updatedFontValue instanceof PDFRef) retainedRefs.add(updatedFontValue);
    }
    cleanResources.set(PDFName.of('XObject'), cleanXObjects);
    page.node.set(PDFName.of('Resources'), cleanResources);
  }
  for (const ref of staleRefs) if (!retainedRefs.has(ref)) context.delete(ref);
  const bytes = await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  await fs.writeFile(outputPath, bytes);
  const afterDocument = await PDFDocument.load(bytes, { updateMetadata: false });
  const after = inspectPdfDocument(afterDocument);
  const afterCompatibility = inspectPdfBytes(bytes);
  const formsPreserved = after.formFields === before.formFields && after.widgets === before.widgets;
  const annotationsPreserved = after.annotations === before.annotations && after.links === before.links;
  const embeddedFontsPreserved = after.embeddedFontResources >= before.embeddedFontResources;
  const signaturesPreservedAsFields = after.signatureFields === before.signatureFields && after.signedSignatures === before.signedSignatures;
  const rotationsPreserved = after.rotations.length === before.rotations.length && after.rotations.every((value, index) => value === before.rotations[index]);
  const cropBoxesPreserved = after.cropBoxes.length === before.cropBoxes.length && after.cropBoxes.every((value, index) => sameBox(value, before.cropBoxes[index]));
  const xfaPreserved = after.hasXfa === before.hasXfa;
  const pdfaDeclarationPreserved = afterCompatibility.pdfaDeclared === beforeCompatibility.pdfaDeclared &&
    afterCompatibility.pdfaPart === beforeCompatibility.pdfaPart && afterCompatibility.pdfaConformance === beforeCompatibility.pdfaConformance;
  if (!formsPreserved || !annotationsPreserved || !embeddedFontsPreserved || !signaturesPreservedAsFields ||
    !rotationsPreserved || !cropBoxesPreserved || !xfaPreserved || !pdfaDeclarationPreserved) {
    throw new Error('LOCAL_PDF_STRUCTURE_PRESERVATION_FAILED');
  }
  const signatureState = before.signedSignatures ? 'invalidated-by-modification' : before.signatureState;
  const resigning = await createPdfResigningRequest(outputPath, { sourceSignatures: before.signedSignatures, signatureState });
  return {
    bytes: bytes.length,
    preservationMode: 'structure-preserving-raster',
    secureContentReplacement: true,
    removedContentStreams,
    removedXObjects,
    formsPreserved,
    annotationsPreserved,
    embeddedFontsPreserved,
    signaturesPreservedAsFields,
    rotationsPreserved,
    cropBoxesPreserved,
    xfaPreserved,
    xfaState: before.hasXfa ? 'preserved-unvalidated' : 'not-present',
    pdfaDeclarationPreserved,
    pdfaState: beforeCompatibility.pdfaDeclared ? 'declared-source-modified-unvalidated' : 'not-declared',
    signatureState,
    resigning,
    before,
    after
  };
}

async function renderRedactedPdf(session, findings, outputPath) {
  if (!Array.isArray(session?.pages) || !session.pages.length) throw new Error('LOCAL_PDF_SESSION_INVALID');
  const pageBuffers = [];
  let boxes = 0;
  for (const sourcePage of session.pages) {
    const placements = pdfFindingPlacements(sourcePage, findings);
    const imageInput = sourcePage?.image || (typeof sourcePage?.imagePath === 'string' && path.isAbsolute(sourcePage.imagePath) ? sourcePage.imagePath : null);
    if (!imageInput) throw new Error('LOCAL_IMAGE_SESSION_INVALID');
    const overlays = placements.map((placement) => ({
      input: { create: { width: placement.width, height: placement.height, channels: 4, background: '#111614' } },
      left: placement.left,
      top: placement.top
    }));
    const buffer = await sharp(imageInput).composite(overlays).png({ compressionLevel: 9 }).toBuffer();
    boxes += placements.length;
    pageBuffers.push(buffer);
  }
  if (!boxes) throw new Error('LOCAL_IMAGE_NO_REDACTIONS');
  const preserved = await renderStructurePreservingPdf(session, pageBuffers, outputPath);
  if (preserved) return { pages: session.pages.length, boxes, ...preserved };

  const output = await PDFDocument.create();
  for (let index = 0; index < session.pages.length; index += 1) {
    const sourcePage = session.pages[index];
    const buffer = pageBuffers[index];
    const embedded = await output.embedPng(buffer);
    const page = output.addPage([sourcePage.pdfWidth, sourcePage.pdfHeight]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: sourcePage.pdfWidth,
      height: sourcePage.pdfHeight
    });
  }
  const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false });
  await fs.writeFile(outputPath, bytes);
  const signatureState = session.pdfFeatures?.signedSignatures ? 'removed-by-flattening' : 'not-present';
  const resigning = await createPdfResigningRequest(outputPath, {
    sourceSignatures: session.pdfFeatures?.signedSignatures || 0,
    signatureState
  });
  return {
    pages: session.pages.length,
    boxes,
    bytes: bytes.length,
    preservationMode: session.pdfFeatures?.passwordDecryptedInMemory ? 'password-decrypted-raster' : 'flattened-raster-fallback',
    passwordDecryptedInMemory: Boolean(session.pdfFeatures?.passwordDecryptedInMemory),
    secureContentReplacement: true,
    rotationsPreserved: false,
    cropBoxesPreserved: false,
    xfaPreserved: false,
    pdfaDeclarationPreserved: false,
    signatureState,
    resigning
  };
}

function activePdfFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((finding) => finding?.enabled !== false && Number.isInteger(finding?.start) && Number.isInteger(finding?.end) &&
      finding.end > finding.start && typeof finding.replacement === 'string')
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function pdfFindingPlacements(page, findings) {
  const placements = [];
  for (const finding of activePdfFindings(findings)) {
    const matched = page.words.filter((word) => finding.start < word.end && word.start < finding.end);
    if (!matched.length) continue;
    // pdf.js bboxes describe the nominal font box; glyph overshoot and anti-aliasing can
    // extend beyond it. A quarter-line guard band covers those pixels while keeping
    // neighboring rows visually distinct.
    const padding = Math.max(4, Math.round(Math.max(...matched.map((word) => word.bbox.y1 - word.bbox.y0)) * 0.25));
    const left = Math.max(0, Math.min(...matched.map((word) => word.bbox.x0)) - padding);
    const top = Math.max(0, Math.min(...matched.map((word) => word.bbox.y0)) - padding);
    const right = Math.min(page.width, Math.max(...matched.map((word) => word.bbox.x1)) + padding);
    const bottom = Math.min(page.height, Math.max(...matched.map((word) => word.bbox.y1)) + padding);
    if (right > left && bottom > top) placements.push({
      token: finding.replacement,
      type: String(finding.type || 'custom'),
      left,
      top,
      width: right - left,
      height: bottom - top
    });
  }
  return placements;
}

function xmlEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function pageWithBlankedPlacements(page, placements, drawValues = false) {
  const imageInput = page?.image || (typeof page?.imagePath === 'string' && path.isAbsolute(page.imagePath) ? page.imagePath : null);
  if (!imageInput) throw new Error('LOCAL_IMAGE_SESSION_INVALID');
  if (!placements.length) return Buffer.isBuffer(imageInput) ? imageInput : fs.readFile(imageInput);
  const shapes = [];
  for (const placement of placements) {
    shapes.push(`<rect x="${placement.left}" y="${placement.top}" width="${placement.width}" height="${placement.height}" fill="#ffffff"/>`);
    if (drawValues) {
      const displayValue = String(placement.value || placement.token || '');
      const characters = Math.max(1, [...displayValue].length);
      const fontSize = Math.max(7, Math.min(placement.height * 0.78, placement.width / characters * 1.55));
      const baseline = placement.top + Math.min(placement.height * 0.82, fontSize * 1.05);
      shapes.push(`<text x="${placement.left}" y="${baseline}" fill="#111614" font-family="Microsoft YaHei,Segoe UI,sans-serif" font-size="${fontSize}">${xmlEscape(displayValue)}</text>`);
    }
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}">${shapes.join('')}</svg>`);
  return sharp(imageInput).composite([{ input: svg, left: 0, top: 0 }]).png({ compressionLevel: 9 }).toBuffer();
}

function pageTokenizedText(page, findings) {
  let output = page.text;
  const local = activePdfFindings(findings)
    .filter((finding) => finding.start < page.textEnd && page.textStart < finding.end)
    .map((finding) => ({ start: finding.start - page.textStart, end: finding.end - page.textStart, replacement: finding.replacement }))
    .filter((finding) => finding.start >= 0 && finding.end <= page.text.length);
  for (const finding of local.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, finding.start)}${finding.replacement}${output.slice(finding.end)}`;
  }
  return output;
}

async function renderTokenizedPdf(session, findings, outputPath) {
  if (!Array.isArray(session?.pages) || !session.pages.length) throw new Error('LOCAL_PDF_SESSION_INVALID');
  const enabled = activePdfFindings(findings);
  if (!enabled.length || enabled.some((finding) => !REVERSIBLE_TOKEN_PATTERN.test(finding.replacement))) {
    throw new Error('LOCAL_PDF_REVERSIBLE_FINDINGS_INVALID');
  }
  const sidecarPages = [];
  const backgroundPaths = [];
  const backgrounds = [];
  const placementsByPage = [];
  let coordinateCount = 0;
  for (const sourcePage of session.pages) {
    const placements = pdfFindingPlacements(sourcePage, enabled);
    placementsByPage.push(placements);
    coordinateCount += placements.length;
    const background = await pageWithBlankedPlacements(sourcePage, placements, true);
    backgrounds.push(background);
    const backgroundPath = `${outputPath}.page-${String(sourcePage.pageNumber).padStart(3, '0')}.png`;
    await fs.writeFile(backgroundPath, background);
    backgroundPaths.push(backgroundPath);
    sidecarPages.push({
      pageNumber: sourcePage.pageNumber,
      width: sourcePage.width,
      height: sourcePage.height,
      pdfWidth: sourcePage.pdfWidth,
      pdfHeight: sourcePage.pdfHeight,
      textMode: sourcePage.textMode || 'ocr',
      tokenizedText: pageTokenizedText(sourcePage, enabled),
      backgroundFile: path.basename(backgroundPath),
      placements
    });
  }
  if (!coordinateCount) throw new Error('LOCAL_PDF_REVERSIBLE_COORDINATES_NOT_FOUND');
  const drawExtractionTokens = (page, font, placements, geometry = null) => {
    const x = Number(geometry?.cropBox?.x || 0) + 0.25;
    const y = Number(geometry?.cropBox?.y || 0) + 0.25;
    for (const placement of placements) {
      page.drawText(placement.token, { x, y, size: 0.1, font, color: rgb(1, 1, 1) });
    }
  };
  let preservationFont;
  const preserved = await renderStructurePreservingPdf(session, backgrounds, outputPath, async ({ document, page, index, geometry }) => {
    preservationFont ||= await document.embedFont(StandardFonts.Courier);
    drawExtractionTokens(page, preservationFont, placementsByPage[index], geometry);
  });
  let outputBytes;
  let preservation;
  if (preserved) {
    outputBytes = preserved.bytes;
    preservation = preserved;
  } else {
    const output = await PDFDocument.create();
    const font = await output.embedFont(StandardFonts.Courier);
    for (let index = 0; index < session.pages.length; index += 1) {
      const sourcePage = session.pages[index];
      const embedded = await output.embedPng(backgrounds[index]);
      const page = output.addPage([sourcePage.pdfWidth, sourcePage.pdfHeight]);
      page.drawImage(embedded, { x: 0, y: 0, width: sourcePage.pdfWidth, height: sourcePage.pdfHeight });
      drawExtractionTokens(page, font, placementsByPage[index]);
    }
    const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false });
    await fs.writeFile(outputPath, bytes);
    outputBytes = bytes.length;
    const signatureState = session.pdfFeatures?.signedSignatures ? 'removed-by-flattening' : 'not-present';
    preservation = {
      preservationMode: session.pdfFeatures?.passwordDecryptedInMemory ? 'password-decrypted-raster' : 'flattened-raster-fallback',
      passwordDecryptedInMemory: Boolean(session.pdfFeatures?.passwordDecryptedInMemory),
      secureContentReplacement: true,
      signatureState,
      resigning: await createPdfResigningRequest(outputPath, {
        sourceSignatures: session.pdfFeatures?.signedSignatures || 0,
        signatureState
      })
    };
  }
  const sidecar = {
    format: 'VEILFORGE_PDF_TOKEN_COORDINATES',
    version: 1,
    sourceMode: session.sourceMode || 'ocr',
    pageCount: session.pages.length,
    scanPages: session.pages.filter((page) => page.textMode === 'ocr').length,
    coordinateCount,
    pages: sidecarPages
  };
  const coordinatePath = `${outputPath}.tokens.json`;
  const textPath = `${outputPath}.tokens.txt`;
  await fs.writeFile(coordinatePath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  await fs.writeFile(textPath, `${sidecarPages.map((page) => `【第 ${page.pageNumber} 页 · ${page.textMode.toUpperCase()}】\n${page.tokenizedText}`).join('\n\f\n')}\n`, 'utf8');
  return {
    pages: session.pages.length,
    coordinates: coordinateCount,
    scanPages: sidecar.scanPages,
    bytes: outputBytes,
    coordinatePath,
    textPath,
    backgroundPaths,
    ...preservation
  };
}

async function readCoordinateSidecar(sidecarPath) {
  if (!sidecarPath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    if (parsed?.format !== 'VEILFORGE_PDF_TOKEN_COORDINATES' || parsed.version !== 1 || !Array.isArray(parsed.pages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function restoreReversiblePdf(inputPath, mapping, outputPath, sidecarPath = '') {
  const normalized = normalizeReversibleMapping(mapping);
  const byToken = new Map(normalized.map((entry) => [entry.token, entry]));
  const native = await extractNativePdfText(inputPath);
  const report = officeTokenFindings(native.text, normalized);
  if (!report.findings.length) throw new Error('LOCAL_PDF_REVERSIBLE_TOKENS_NOT_FOUND');
  const present = new Set(report.findings.map((finding) => finding.value));
  const sidecar = await readCoordinateSidecar(sidecarPath);
  if (!sidecar || sidecar.pageCount !== native.pageCount) throw new Error('LOCAL_PDF_REVERSIBLE_SIDECAR_REQUIRED');
  const output = await PDFDocument.create();
  let restoredCoordinates = 0;
  for (const sidecarPage of sidecar.pages) {
    const backgroundFile = String(sidecarPage.backgroundFile || '');
    if (!backgroundFile || path.basename(backgroundFile) !== backgroundFile || !backgroundFile.toLowerCase().endsWith('.png')) {
      throw new Error('LOCAL_PDF_REVERSIBLE_SIDECAR_INVALID');
    }
    const pageWidth = Number(sidecarPage.width);
    const pageHeight = Number(sidecarPage.height);
    const pdfWidth = Number(sidecarPage.pdfWidth);
    const pdfHeight = Number(sidecarPage.pdfHeight);
    if (![pageWidth, pageHeight, pdfWidth, pdfHeight].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error('LOCAL_PDF_REVERSIBLE_SIDECAR_INVALID');
    }
    const backgroundPath = path.join(path.dirname(path.resolve(sidecarPath)), backgroundFile);
    const placements = (sidecarPage.placements || [])
      .filter((placement) => present.has(placement.token) && byToken.has(placement.token))
      .map((placement) => ({
        token: placement.token,
        value: byToken.get(placement.token).value,
        left: Number(placement.left),
        top: Number(placement.top),
        width: Number(placement.width),
        height: Number(placement.height)
      }));
    restoredCoordinates += placements.length;
    const background = await pageWithBlankedPlacements({
      image: await fs.readFile(backgroundPath),
      width: pageWidth,
      height: pageHeight
    }, placements, true);
    const embedded = await output.embedPng(background);
    const page = output.addPage([pdfWidth, pdfHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: pdfWidth, height: pdfHeight });
  }
  if (!restoredCoordinates) throw new Error('LOCAL_PDF_REVERSIBLE_COORDINATES_NOT_FOUND');
  const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false });
  await fs.writeFile(outputPath, bytes);
  return {
    kind: 'pdf',
    pages: sidecar.pages.length,
    bytes: bytes.length,
    knownTokens: report.knownTokens,
    restoredOccurrences: report.restoredOccurrences,
    restoredCoordinates,
    missingTokens: report.missingTokens,
    repeatedTokens: report.repeatedTokens,
    unknownTokens: report.unknownTokens,
    complete: report.complete,
    coordinateSidecarUsed: true,
    visualRestoration: true
  };
}

module.exports = {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  recognizePdf,
  renderRedactedPdf,
  renderTokenizedPdf,
  restoreReversiblePdf,
  extractNativePdfText,
  inspectPdfFeatures,
  inspectPdfCompatibility,
  inspectPdfBytes,
  inspectPdfDocument,
  createPdfResigningRequest,
  nativePageText,
  pdfFindingPlacements,
  renderPage,
  renderScale
};
