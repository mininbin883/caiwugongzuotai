import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { analyzeText } from '../src/core/redaction-engine.mjs';

const require = createRequire(import.meta.url);
const { extractDocument } = require('../src/services/document-extractor.cjs');

const source = path.resolve(process.argv[2] || 'sample-sensitive.txt');
const output = path.resolve(process.argv[3] || 'sample-redacted.txt');
const document = await extractDocument(source);
const result = analyzeText(document.text, { customTerms: ['张三'] });
await fs.writeFile(output, `${result.redactedText}\n`, 'utf8');
console.log(`SOURCE=${source}`);
console.log(`SOURCE_CHARACTERS=${document.characters}`);
console.log(`FINDINGS=${result.findings.length}`);
console.log(`TYPES=${result.findings.map((item) => item.type).join(',')}`);
console.log(`OUTPUT=${output}`);
console.log(`OUTPUT_TEXT=${result.redactedText.replace(/\n/g, '\\n')}`);
console.log('RESULT=PASS');
