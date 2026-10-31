'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const signpdf = require('@signpdf/signpdf').default;
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { P12Signer } = require('@signpdf/signer-p12');
const { Signer, SUBFILTER_ETSI_CADES_DETACHED } = require('@signpdf/utils');

class CallbackSigner extends Signer {
  constructor(callback, metadata = {}) {
    super();
    if (typeof callback !== 'function') throw new Error('LOCAL_PDF_SIGNER_CALLBACK_INVALID');
    this.callback = callback;
    this.metadata = { adapter: 'pkcs11-hsm-callback', ...metadata };
  }

  async sign(pdfBuffer, signingTime) {
    const signature = await this.callback(Buffer.from(pdfBuffer), { signingTime, ...this.metadata });
    if (!Buffer.isBuffer(signature) && !(signature instanceof Uint8Array)) throw new Error('LOCAL_PDF_SIGNER_RESULT_INVALID');
    return Buffer.from(signature);
  }
}

function signingOptions(options = {}) {
  return {
    reason: String(options.reason || 'Post-redaction approval'),
    contactInfo: String(options.contactInfo || ''),
    name: String(options.name || 'VeilForge signer'),
    location: String(options.location || ''),
    signingTime: options.signingTime instanceof Date ? options.signingTime : new Date(),
    signatureLength: Number.isInteger(options.signatureLength) ? options.signatureLength : 16384,
    subFilter: options.subFilter || SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect: Array.isArray(options.widgetRect) ? options.widgetRect : [0, 0, 0, 0],
    appName: 'VeilForge Local Redactor'
  };
}

async function preparePdfForSigning(pdfBytes, options = {}) {
  const document = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  pdflibAddPlaceholder({ pdfDoc: document, ...signingOptions(options) });
  return Buffer.from(await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
}

async function signPdfBuffer(pdfBytes, signer, options = {}) {
  if (!Buffer.isBuffer(pdfBytes) && !(pdfBytes instanceof Uint8Array)) throw new Error('LOCAL_PDF_SIGN_INPUT_INVALID');
  if (!signer || typeof signer.sign !== 'function') throw new Error('LOCAL_PDF_SIGNER_INVALID');
  const prepared = await preparePdfForSigning(Buffer.from(pdfBytes), options);
  return Buffer.from(await signpdf.sign(prepared, signer, options.signingTime));
}

async function signPdfWithP12(inputPath, outputPath, certificatePath, password = '', options = {}) {
  for (const value of [inputPath, outputPath, certificatePath]) if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('LOCAL_PATH_INVALID');
  const [pdfBytes, certificateBytes] = await Promise.all([fs.readFile(inputPath), fs.readFile(certificatePath)]);
  const signer = new P12Signer(certificateBytes, { passphrase: String(password || '') });
  const signed = await signPdfBuffer(pdfBytes, signer, options);
  await fs.writeFile(outputPath, signed, { flag: options.overwrite ? 'w' : 'wx', mode: 0o600 });
  return { adapter: 'p12', bytes: signed.length, outputPath };
}

async function signPdfWithExternalSigner(inputPath, outputPath, callback, options = {}) {
  for (const value of [inputPath, outputPath]) if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('LOCAL_PATH_INVALID');
  const pdfBytes = await fs.readFile(inputPath);
  const signer = new CallbackSigner(callback, options.metadata);
  const signed = await signPdfBuffer(pdfBytes, signer, options);
  await fs.writeFile(outputPath, signed, { flag: options.overwrite ? 'w' : 'wx', mode: 0o600 });
  return { adapter: signer.metadata.adapter, bytes: signed.length, outputPath };
}

module.exports = {
  CallbackSigner,
  preparePdfForSigning,
  signPdfBuffer,
  signPdfWithP12,
  signPdfWithExternalSigner
};
