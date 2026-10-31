const sharp=require('sharp');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createWorker,OEM,PSM}=require('tesseract.js');
(async()=>{
 const svg=`<svg width="1400" height="520" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><style>.t{font:52px 'Microsoft YaHei';fill:#111}</style><text x="60" y="110" class="t">客户：张三</text><text x="60" y="200" class="t">手机：13812345678</text><text x="60" y="290" class="t">邮箱：alice@example.com</text><text x="60" y="380" class="t">身份证：11010519491231002X</text></svg>`;
 await sharp(Buffer.from(svg)).png().toFile('ocr-fixture.png');
 const worker=await createWorker(['chi_sim','eng'],OEM.LSTM_ONLY,{langPath:path.resolve('ocr-data'),gzip:true,logger:m=>{if(m.status==='recognizing text')console.log('PROGRESS='+m.progress)}});
 await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,user_defined_dpi:'300',preserve_interword_spaces:'1'});
 const ret=await worker.recognize(path.resolve('ocr-fixture.png'),{rotateAuto:true},{text:true,blocks:true,tsv:true});
 console.log('TEXT='+JSON.stringify(ret.data.text));
 console.log('BLOCKS='+JSON.stringify(ret.data.blocks).slice(0,1200));
 console.log('TSV_HEAD='+ret.data.tsv.split('\n').slice(0,12).join('\\n'));
 await worker.terminate();
})().catch(e=>{console.error(e);process.exit(1)})
