import {parentPort,workerData} from 'node:worker_threads';
import WordExtractor from 'word-extractor';
import XLSX from 'xlsx';
import {parseAccountFileText} from './account-file-content.mjs';

function decode(buffer){
  if(buffer[0]===0xff&&buffer[1]===0xfe)return new TextDecoder('utf-16le').decode(buffer);
  if(buffer[0]===0xfe&&buffer[1]===0xff)return new TextDecoder('utf-16be').decode(buffer);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{return new TextDecoder('gb18030').decode(buffer);}
}
try{
  const buffer=Buffer.from(workerData.buffer),extension=workerData.extension;
  let text;
  if(['.doc','.docx'].includes(extension)){
    const doc=await new WordExtractor().extract(buffer);text=doc.getBody();
  }else if(['.xls','.xlsx','.xsl','.csv'].includes(extension)){
    const workbook=XLSX.read(extension==='.csv'?decode(buffer):buffer,{type:extension==='.csv'?'string':'buffer',
      raw:true,cellFormula:true,cellHTML:false,bookVBA:false,sheetRows:1002});
    if(workbook.SheetNames.length>20)throw new Error('ACCOUNT_FILE_TOO_LARGE');
    const cells=[];
    for(const name of workbook.SheetNames){
      const sheet=workbook.Sheets[name];
      for(const [address,cell] of Object.entries(sheet)){
        if(address.startsWith('!')||cell.v===undefined)continue;
        if(cell.f)throw new Error('ACCOUNT_FILE_FORMULAS_UNSUPPORTED');
        if(typeof cell.v==='number'&&!Number.isSafeInteger(cell.v))throw new Error('ACCOUNT_FILE_INVALID_NUMBER');
        if(typeof cell.v==='string'||typeof cell.v==='number')cells.push(String(cell.v));
        if(cells.length>1000)throw new Error('ACCOUNT_FILE_TOO_LARGE');
      }
    }
    text=cells.join('\n');
  }else text=decode(buffer);
  if(text.includes('\x00'))throw new Error('ACCOUNT_FILE_INVALID');
  parentPort.postMessage({result:parseAccountFileText(text,workerData.platform)});
}catch(error){
  parentPort.postMessage({error:/^ACCOUNT_FILE_[A-Z_]+$/.test(error.message)?error.message:'ACCOUNT_FILE_INVALID'});
}
