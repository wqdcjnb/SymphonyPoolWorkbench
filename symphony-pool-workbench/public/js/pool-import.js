import {readableError} from './shared.js';
const $=s=>document.querySelector(s);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function content(file){return new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);
  reader.onerror=()=>reject(new Error('ACCOUNT_FILE_INVALID'));reader.readAsDataURL(file);
});}

export function bindFileImports({api,refresh,message}){
  for(const platform of ['dola','doubao']){
    const input=$(`#${platform}ImportFile`),preview=$(`#${platform}ImportPreview`),
      parse=$(`#${platform}ParseFile`),commit=$(`#${platform}CommitImport`);
    let current=null,generation=0;
    const parseFile=async()=>{
      const turn=++generation;current=null;commit.disabled=true;
      const file=input.files[0];if(!file){preview.textContent='请先选择文件。';return;}
      if(file.size>5*1024*1024){preview.textContent=readableError('ACCOUNT_FILE_TOO_LARGE');return;}
      parse.disabled=true;preview.textContent='正在解析文件…';
      try{
        const result=await api('/api/pool/import-file/preview',{platform,filename:file.name,content:await content(file)});
        if(turn!==generation)return;
        current=result;
        preview.innerHTML=`<p class="import-count">识别 ${result.rows.length} 个账号 · 新增 ${result.newCount} · 已存在 ${result.existingCount}${result.duplicateCount?` · 文件内重复 ${result.duplicateCount}`:''}</p>
          ${result.issues.length?`<p class="import-warning">有 ${result.issues.length} 条未识别内容，将跳过。请核对下面的有效账号列表。</p>`:''}
          <ol class="import-list">${result.rows.map(row=>`<li><strong>${platform==='dola'?`Cookie · ${esc(row.cookieFingerprint)}`:esc(row.phone)}</strong><span>${row.existingAccountId?'已存在，将跳过':'待导入'} · 第 ${row.line} 行</span></li>`).join('')}</ol>`;
        commit.disabled=!result.newCount;
      }catch(error){if(turn===generation)preview.textContent=readableError(error.message);}
      finally{if(turn===generation)parse.disabled=false;}
    };
    input.onchange=parseFile;parse.onclick=parseFile;
    commit.onclick=async()=>{
      if(!current)return;
      commit.disabled=true;parse.disabled=true;input.disabled=true;
      try{
        const result=await api('/api/pool/import-file/commit',{token:current.token,startLogin:true});
        current=null;input.value='';generation++;
        preview.textContent=`已导入 ${result.created} 个账号${result.existing?`，跳过 ${result.existing} 个已有账号`:''}。`;
        message(result.needsSetup.length?`已导入 ${result.created} 个账号；其中 ${result.needsSetup.length} 个需先配置出口或浏览器档案。`:
          `已导入 ${result.created} 个账号并加入登录队列。${platform==='doubao'?'请在下方按手机号填写验证码。':'Dola 正在自动验收登录。'}`);
        await refresh();
        if(result.loginBatchId)$('#loginProgress').scrollIntoView({behavior:'smooth',block:'start'});
      }catch(error){preview.textContent=readableError(error.message);commit.disabled=!current;}
      finally{parse.disabled=false;input.disabled=false;}
    };
  }
}
