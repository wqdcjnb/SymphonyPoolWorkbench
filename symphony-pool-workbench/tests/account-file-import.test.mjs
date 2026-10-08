import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import XLSX from 'xlsx';
import {readAccountFile} from '../lib/account-file-reader.mjs';
import {createAccountFileImport} from '../lib/account-file-import.mjs';
import {createStore} from '../lib/db.mjs';
import {createAccountPool} from '../lib/account-pool.mjs';

const read=(filename,buffer,platform='doubao')=>readAccountFile({filename,platform,content:Buffer.from(buffer).toString('base64')});
test('plain phone files preserve numbers and deduplicate domestic country code variants',async()=>{
  const result=await read('phones.txt','13800000000\r\n+86 13800000000\r\n13900000000\n手机号：13700000000');
  assert.deepEqual(result.rows.map(r=>r.identifier),['13800000000','13900000000','13700000000']);
  assert.equal(result.duplicateCount,1);
  const utf16=await read('phones.txt',Buffer.concat([Buffer.from([255,254]),Buffer.from('手机号\r\n13800000000','utf16le')]));
  assert.equal(utf16.rows.length,1);
});
test('Word DOC/DOCX and Excel XLS/XLSX contain phone data without an account template',async()=>{
  for(const ext of ['doc','docx']){
    const result=await read('phones.'+ext,fs.readFileSync(new URL('./fixtures/phones.'+ext,import.meta.url)));
    assert.equal(result.rows[0].identifier,'13800000000',ext);
  }
  for(const bookType of ['xls','xlsx']){
    const workbook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([[13800000000],['13900000000']]));
    const result=await read('phones.'+bookType,XLSX.write(workbook,{type:'buffer',bookType}));
    assert.deepEqual(result.rows.map(r=>r.identifier),['13800000000','13900000000']);
  }
  const csv=await read('phones.csv','13800000000,13900000000\n');assert.equal(csv.rows.length,2);
});
test('Cookie files accept one, many and wrapped credentials, while duplicates are skipped',async()=>{
  const single=await read('cookies.txt','sessionid=private-one; csrf=alpha','dola');assert.equal(single.rows.length,1);
  const many=await read('cookies.txt','sessionid=private-one; csrf=alpha\nsessionid=private-two; csrf=beta\nsessionid=private-one','dola');
  assert.equal(many.rows.length,2);assert.equal(many.duplicateCount,1);
  const wrapped=await read('cookies.txt','sessionid=private-one;\nsessionid_ss=private-one;\ncsrf=alpha\n\nsessionid=private-two','dola');
  assert.equal(wrapped.rows.length,2);assert.match(wrapped.rows[0].cookies,/csrf=alpha/);
});
test('invalid files, malformed Cookie data, formulas and excessive records fail explicitly',async()=>{
  await assert.rejects(read('phones.exe','13800000000'),/ACCOUNT_FILE_TYPE_UNSUPPORTED/);
  await assert.rejects(read('phones.doc',Buffer.from('not Word')),/ACCOUNT_FILE_INVALID/);
  await assert.rejects(read('cookies.txt','csrf=alpha','dola'),/ACCOUNT_FILE_NO_COOKIES/);
  await assert.rejects(read('phones.txt',Array.from({length:101},(_,i)=>String(13800000000+i)).join('\n')),/ACCOUNT_FILE_TOO_MANY/);
  const workbook=XLSX.utils.book_new();const sheet=XLSX.utils.aoa_to_sheet([['13800000000']]);sheet.A1.f='1+2';
  XLSX.utils.book_append_sheet(workbook,sheet);
  await assert.rejects(read('phones.xlsx',XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})),/ACCOUNT_FILE_FORMULAS_UNSUPPORTED/);
});

test('preview is private and import retries are atomic, deduplicated and evenly assigned',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-import-')),keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  const store=await createStore(path.join(root,'db.sqlite'));
  const pool=createAccountPool({store,workerId:'001',keyFile}),peer=createAccountPool({store,workerId:'002',keyFile});
  await pool.start();await peer.start();let now=Date.now();
  const importer=createAccountFileImport({store,pool,keyFile,profileRoot:root,now:()=>now});
  try{
    const input={filename:'cookies.txt',platform:'dola',content:Buffer.from('sessionid=secret-one\nsessionid=secret-two').toString('base64')};
    const preview=await importer.preview(input);
    assert.equal((await store.listAccounts()).length,0);assert.equal(preview.newCount,2);
    assert.equal(JSON.stringify(preview).includes('secret-one'),false);
    const [first,retry]=await Promise.all([importer.commit({token:preview.token,startLogin:false}),importer.commit({token:preview.token,startLogin:false})]);
    assert.equal(first.created,2);assert.equal(retry.replayed,true);
    assert.deepEqual(first.assignments.map(a=>a.workerId),['001','002']);
    assert.equal((await store.listAccounts()).length,2);
    const duplicate=await importer.preview(input);assert.equal(duplicate.newCount,0);assert.equal(duplicate.existingCount,2);
    const phone=await importer.preview({filename:'phones.csv',platform:'doubao',content:Buffer.from('13800000000\n13900000000').toString('base64')});
    const committed=await importer.commit({token:phone.token});assert.ok(committed.loginBatchId);
    const items=(await pool.loginItems()).reverse();assert.deepEqual(items.map(i=>i.accountId),committed.accountIds);
    assert.ok((await pool.snapshot()).workers.every(w=>w.accountCount===2));
    const stored=JSON.stringify(await store.database.prepare('SELECT * FROM pool_import_receipts').all());
    assert.equal(stored.includes('secret-one'),false);assert.equal(stored.includes('13800000000'),false);
    await assert.rejects(importer.commit({token:phone.token+'x'}),/IMPORT_PREVIEW_INVALID/);
    const expired=await importer.preview({filename:'phones.txt',platform:'doubao',content:Buffer.from('13700000000').toString('base64')});
    now+=16*60_000;await assert.rejects(importer.commit({token:expired.token}),/IMPORT_PREVIEW_EXPIRED/);
  }finally{await pool.stop();await peer.stop();await store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('file import can retain login details while required proxy and browser setup is pending',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-setup-')),keyFile=path.join(root,'key');fs.writeFileSync(keyFile,randomBytes(32));
  const store=await createStore(path.join(root,'db.sqlite'));
  const pool=createAccountPool({store,workerId:'001',keyFile,enforceGroups:true,requireProxyForNewAccounts:true,requireMimicForNewAccounts:true});
  await pool.start();
  try{
    const importer=createAccountFileImport({store,pool,keyFile,profileRoot:root});
    const preview=await importer.preview({platform:'doubao',filename:'phones.txt',content:Buffer.from('13800000000').toString('base64')});
    const result=await importer.commit({token:preview.token});assert.equal(result.created,1);assert.equal(result.loginBatchId,null);
    assert.equal(result.needsSetup.length,1);
    assert.equal((await pool.loginIdentity(result.accountIds[0])).identifier,'13800000000');
    assert.equal((await pool.snapshot()).leases.length,0);
  }finally{await pool.stop();await store.close();fs.rmSync(root,{recursive:true,force:true});}
});
