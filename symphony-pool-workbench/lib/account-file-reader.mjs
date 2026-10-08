import {Worker} from 'node:worker_threads';
import path from 'node:path';
export const MAX_ACCOUNT_FILE_BYTES=5*1024*1024;
const extensions=new Set(['.txt','.csv','.doc','.docx','.xls','.xlsx','.xsl']);
let parsing=0;

export async function readAccountFile({filename,content,platform}) {
  if(!['dola','doubao'].includes(platform))throw new Error('INVALID_LOGIN_TYPE');
  if(typeof filename!=='string'||!extensions.has(path.extname(filename).toLowerCase()))throw new Error('ACCOUNT_FILE_TYPE_UNSUPPORTED');
  if(typeof content!=='string'||content.length>Math.ceil(MAX_ACCOUNT_FILE_BYTES/3)*4)throw new Error('ACCOUNT_FILE_TOO_LARGE');
  const buffer=Buffer.from(content,'base64');
  if(buffer.toString('base64')!==content)throw new Error('ACCOUNT_FILE_INVALID');
  if(!buffer.length||buffer.length>MAX_ACCOUNT_FILE_BYTES)throw new Error('ACCOUNT_FILE_TOO_LARGE');
  if(parsing>=2)throw new Error('ACCOUNT_FILE_BUSY');
  parsing++;
  try{return await new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./account-file-worker.mjs',import.meta.url),{
      workerData:{buffer,extension:path.extname(filename).toLowerCase(),platform},
      execArgv:[],
      resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32},stdout:true,stderr:true});
    let settled=false;
    const done=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>done(new Error('ACCOUNT_FILE_PARSE_TIMEOUT')),15000);
    worker.stdout.resume();worker.stderr.resume();
    worker.once('message',message=>done(message.error?new Error(message.error):null,message.result));
    worker.once('error',()=>done(new Error('ACCOUNT_FILE_INVALID')));
    worker.once('exit',()=>{if(!settled)done(new Error('ACCOUNT_FILE_INVALID'));});
  });}finally{parsing--;}
}
