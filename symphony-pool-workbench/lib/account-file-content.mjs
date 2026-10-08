import {createHash} from 'node:crypto';
import {loginCredential,normalizePhone} from './login-identity.mjs';

export function phoneIdentity(phone) {
  const value=normalizePhone(phone);
  return value.replace(/^\+?86(?=1[3-9]\d{9}$)/,'');
}
export function credentialIdentity(platform,row) {
  if(platform==='doubao')return phoneIdentity(row.identifier);
  const credential=loginCredential('dola',row);
  const value=credential.cookies.find(c=>c.name==='sessionid'&&c.value)?.value
    ||credential.cookies.find(c=>c.name==='sessionid_ss'&&c.value)?.value;
  if(!value||/\s|sessionid(?:_ss)?=/.test(value))throw new Error('INVALID_COOKIE_INPUT');
  return createHash('sha256').update(value).digest('hex');
}

export function parseAccountFileText(text,platform) {
  if(typeof text!=='string'||text.length>2*1024*1024)throw new Error('ACCOUNT_FILE_TOO_LARGE');
  const rows=[],issues=[],seen=new Set();let duplicateCount=0;
  const add=(row,line)=>{
    try{
      const identity=credentialIdentity(platform,row);
      if(seen.has(identity)){duplicateCount++;return;}
      seen.add(identity);rows.push({...row,line});
      if(rows.length>100)throw new Error('ACCOUNT_FILE_TOO_MANY');
    }catch(error){if(error.message==='ACCOUNT_FILE_TOO_MANY')throw error;issues.push({line,code:platform==='dola'?'INVALID_COOKIE_INPUT':'PHONE_NUMBER_INVALID'});}
  };
  const lines=text.replace(/^\uFEFF/,'').split(/\r\n|[\r\n\u2028\u2029]/);
  if(platform==='doubao'){
    lines.forEach((line,index)=>{
      for(const raw of line.split(/[\t,;，；]/)){
        const cell=raw.trim().replace(/^['"]|['"]$/g,'');
        if(!/\d/.test(cell))continue;
        if(/^[+\d\s()-]+$/.test(cell)){
          let phone;try{phone=phoneIdentity(cell);}catch{}
          if(phone){add({identifier:phone},index+1);continue;}
        }
        // A cell can contain several numbers separated by spaces or an optional phone label.
        const clean=cell.replace(/^(?:手机号|手机|电话|phone|mobile)\s*[:：]?\s*/i,'');
        const candidates=clean.match(/(?<![\d.+-])(?:\+?86[ -]*)?1[3-9]\d{9}(?!\d)|(?<![\d.+-])\+\d{7,15}(?!\d)/g)||[];
        if(candidates.length)for(const value of candidates)add({identifier:phoneIdentity(value)},index+1);
        else issues.push({line:index+1,code:'PHONE_NUMBER_INVALID'});
      }
    });
  }else{
    let pending='',start=0;
    const flush=()=>{if(pending){add({cookies:pending},start);pending='';}};
    for(let i=0;i<lines.length;i++){
      const line=lines[i].trim().replace(/^(?:cookie|cookies)\s*[:：]\s*/i,'');
      if(!line){flush();continue;}
      if(!line.includes('=')){if(!pending&&!/^#/.test(line))issues.push({line:i+1,code:'COOKIE_LINE_IGNORED'});continue;}
      const marker=/(?:^|;)\s*sessionid(?:_ss)?\s*=/;
      const sessionContinuation=/^sessionid_ss\s*=[^;]+;?$/.test(line)&&!/(?:^|;)\s*sessionid_ss\s*=/.test(pending);
      if(marker.test(line)&&marker.test(pending)&&!sessionContinuation)flush();
      if(!pending)start=i+1;
      pending+=pending?(pending.endsWith(';')?' ':'; ')+line:line;
      if(pending.length>64000){issues.push({line:start,code:'INVALID_COOKIE_INPUT'});pending='';}
    }
    flush();
  }
  if(!rows.length)throw new Error(platform==='dola'?'ACCOUNT_FILE_NO_COOKIES':'ACCOUNT_FILE_NO_PHONES');
  return {rows,issues:issues.slice(0,100),duplicateCount};
}
