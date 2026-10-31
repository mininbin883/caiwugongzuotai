#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(process.argv[2]||'.');
const checks=[];const add=(name,ok)=>checks.push([name,Boolean(ok)]);const text=p=>fs.existsSync(path.join(root,p))?fs.readFileSync(path.join(root,p),'utf8'):'';
let pkg=null,yinye=null,upload=null;
try{pkg=JSON.parse(text('moyin/package.json'));}catch{}
try{yinye=JSON.parse(text('yinye/PACKAGE-MANIFEST.json'));}catch{}
try{upload=JSON.parse(text('releases/UPLOAD-MANIFEST.json'));}catch{}
add('root-readme',text('README.md').includes('软件发布仓库')&&text('README.md').includes('software-bundle-2026.10.31'));
add('moyin-version',pkg?.version==='2.14.1');
add('moyin-main',fs.existsSync(path.join(root,'moyin/src/main.cjs'))&&fs.existsSync(path.join(root,'moyin/src/renderer/renderer.mjs')));
add('moyin-tests',fs.existsSync(path.join(root,'moyin/tests/redaction-engine.test.mjs')));
add('yinye-version',yinye?.productVersion==='1.0.0.9'&&yinye?.engineVersion==='0.5.2'&&yinye?.files?.length===2653);
add('yinye-clean-metadata',!yinye?.files?.some(x=>String(x.path).startsWith('data/'))&&text('yinye/README.md').includes('没有打包'));
add('asset-manifest',upload?.assets?.length===3&&upload?.assets?.some(x=>x.name==='VeilForge-2.14.1-win-unpacked.zip')&&upload?.assets?.some(x=>x.name==='Yinye-1.0.0.9-win-x64-clean.zip'));
add('checksums',text('releases/SHA256SUMS.txt').includes('847B8B127617DAE73174D64C8A8756418011B5D58CC56817D8F75EDF11F72C3D')&&text('releases/SHA256SUMS.txt').includes('9DA3B8863FA1B2F5C0054BE83B03C73ED7B6232DACD66860B740A53B26A1892F'));
add('transaction-modified',text('transaction-github-upload/MODIFIED_FILE.md').includes('Original HEAD'));
add('rollback-script',fs.existsSync(path.join(root,'transaction-github-upload/ROLLBACK.sh')));
const failed=checks.filter(x=>!x[1]).map(x=>x[0]);console.log(`GITHUB_UPLOAD_PROBE ${checks.length-failed.length}/${checks.length} root=${root} failed=${failed.length?failed.join(','):'none'}`);process.exit(failed.length?1:0);
