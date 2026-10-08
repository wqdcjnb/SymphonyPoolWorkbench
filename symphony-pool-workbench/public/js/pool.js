import { qualityLabel, qualityTier, compareAccountPriority } from './account-quality.js';
import {readableError,statusLabel,api as request} from './shared.js';
import {suggestAccount} from './account-suggestion.js';
import {bindFileImports} from './pool-import.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const health={ready:'出口正常',unchecked:'待检测',failed:'检测失败',mismatch:'出口不符',conflict:'与其他组重复',direct:'直连 · 未隔离',disabled:'已停用'};
const states={queued:'排队中',starting:'准备登录',manual:'等待验证',verifying:'正在验收',done:'已完成登录',failed:'登录失败',cancelled:'已取消'};
const activeStates=new Set(['queued','starting','manual','verifying']);
let accounts=[],snapshot={bindings:[],groups:[],workers:[],leases:[],loginItems:[]},selection=new Set(),accountPage=1,loginHistoryPage=1,editorId=null,refreshing=null;
const loginBusy=new Set();
const api=(route,body)=>request(route,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
const binding=id=>snapshot.bindings.find(b=>b.accountId===id)||{};
const account=id=>accounts.find(a=>a.id===id);
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'历史保存';
const method=a=>a.service==='dola'?'Cookie 登录':'手机号 + 验证码';
const identity=a=>a.service==='dola'?(binding(a.id).cookieFingerprint?`Cookie · ${binding(a.id).cookieFingerprint}`:'尚未保存 Cookie'):(binding(a.id).identifier||'尚未保存手机号');
function message(text,error=false){$('#poolMessage').textContent=text;$('#poolMessage').classList.toggle('is-error',error);}
async function action(fn,button){if(button)button.disabled=true;try{await fn();await refresh();}catch(e){message(readableError(e.message),true);}finally{if(button)button.disabled=false;}}
async function copy(text){try{await navigator.clipboard.writeText(text);message('已复制');}catch{throw new Error('复制失败，请点“查看 Cookie”或选中手机号后手动复制。');}}
function table(headers,rows){return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
function filteredAccounts(){const term=$('#accountSearch').value.trim().toLowerCase(),platform=$('#platformFilter').value,state=$('#accountStateFilter').value;return accounts.filter(a=>(!platform||a.service===platform)&&(!state||(state==='missing'?!binding(a.id).recoverable:state==='attention'?a.needsAttention:state==='unstable'?qualityTier(a)<2:state==='ready'?a.status==='ready'&&!a.needsAttention:a.status===state))&&(!term||`${a.id} ${a.label} ${binding(a.id).identifier||''} ${binding(a.id).cookieFingerprint||''} ${binding(a.id).source||''}`.toLowerCase().includes(term))).sort((a,b)=>Number(b.needsAttention)-Number(a.needsAttention)||compareAccountPriority(a,b));}
function renderAccounts(){
 const filtered=filteredAccounts(),pages=Math.max(1,Math.ceil(filtered.length/20));accountPage=Math.min(accountPage,pages);
 $('#accounts').innerHTML=filtered.length?filtered.slice((accountPage-1)*20,accountPage*20).map(a=>{
  const b=binding(a.id),group=snapshot.groups.find(g=>g.id===b.groupId),running=snapshot.loginItems.find(i=>i.accountId===a.id&&activeStates.has(i.state)),occupied=snapshot.leases.some(l=>l.accountId===a.id),mimicMissing=b.browserProvider==='multilogin'&&!b.multiloginProfileId;
  return `<article class="pool-account ${editorId===a.id?'is-selected':''}" data-pool-account="${esc(a.id)}"><div class="pool-account-top"><label class="pool-account-name"><input type="checkbox" data-account="${esc(a.id)}" aria-label="选择 ${esc(a.label)}" ${selection.has(a.id)?'checked':''}><span><strong>${esc(a.label)}</strong><small>${esc(a.id)} · ${a.service==='dola'?'Dola':'豆包'}</small></span></label><span class="status status-${esc(a.status)}">${esc(a.needsAttention?'待人工处理':statusLabel[a.status]||a.status)}</span></div>
  <div class="pool-quality"><strong>${esc(qualityLabel(a))} · ${esc(a.reliabilityScore ?? 80)} 分</strong><span>可用积分 ${esc(a.creditsRemaining ?? '—')} / 10</span><span>完成 ${esc(a.videoSuccessCount || 0)} · 掉线 ${esc(a.authFailureCount || 0)} · 验证 ${esc(a.challengeCount || 0)} · 中断 ${esc(a.executionFailureCount || 0)}</span></div>
  ${a.needsAttention?`<p class="pool-attention">已暂停派发 · ${esc(readableError(a.attentionReason || a.lastErrorCode || 'LOGIN_REQUIRED'))}<br>处理后完整验收通过，才恢复使用。</p>`:''}
  <div class="pool-identity"><span>${method(a)}</span><strong class="identity-value ${b.recoverable?'':'is-missing'}">${esc(identity(a))}</strong>${b.credentialError?`<p class="is-error">${esc(readableError(b.credentialError))}</p>`:''}</div>
  <div class="pool-account-meta"><span>来源 · ${esc(b.source||(b.hasCredential?'历史导入':'未保存'))}</span><span>保存 · ${b.hasCredential?esc(time(b.savedAt)):'—'}</span><span>节点 · ${esc(a.workerId)}</span><span>出口 · ${esc(group?.label||b.groupId||'待配置')}</span><span>浏览器 · ${b.browserProvider==='multilogin'?(mimicMissing?'Mimic 待绑定':'Mimic 独立档案'):'原浏览器档案'}</span></div>
  <div class="pool-account-actions"><button class="button primary small" data-restore="${esc(a.id)}" ${!b.recoverable||running||occupied||mimicMissing?'disabled':''}>${running?esc(states[running.state]):mimicMissing?'先绑定 Mimic 档案':a.service==='dola'?'用 Cookie 恢复登录':'用手机号登录'}</button>${b.recoverable?`<button class="button ghost small" data-copy="${esc(a.id)}">${a.service==='dola'?'复制 Cookie':'复制手机号'}</button>${a.service==='dola'?`<button class="text-button" data-reveal="${esc(a.id)}">查看 Cookie</button>`:''}`:''}<button class="text-button" data-edit="${esc(a.id)}">管理登录资料</button><button class="icon-button pool-delete" type="button" data-delete="${esc(a.id)}" aria-label="删除 ${esc(a.label)}" title="${running||occupied?'请先结束此账号的登录或任务':'删除账号'}" ${running||occupied?'disabled':''}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7"/></svg></button></div></article>`;
 }).join(''):'<div class="pool-empty">没有符合条件的账号。可调整筛选，或新建账号。</div>';
 $('#selectedCount').textContent=`已选 ${selection.size} 个`;$('#login').disabled=!selection.size;
 $('#selectAll').textContent=filtered.length&&filtered.every(a=>selection.has(a.id))?'取消当前筛选选择':'全选当前筛选';
 $('#accountPage').textContent=`第 ${accountPage} / ${pages} 页 · 共 ${filtered.length} 个账号`;$('#previousPage').disabled=accountPage<=1;$('#nextPage').disabled=accountPage>=pages;
}
function renderSummary(){
 const items=[['账号总数',accounts.length,'Dola 与豆包'],['可用账号',accounts.filter(a=>a.status==='ready'&&!a.needsAttention).length,'可进入视频队列'],['待人工处理',accounts.filter(a=>a.needsAttention).length,'处理并验收后恢复派发'],['资料已保存',accounts.filter(a=>binding(a.id).recoverable).length,'Cookie / 手机号']];
 $('#poolSummary').innerHTML=items.map(([label,value,note])=>`<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
}
function loginCard(item){
 const a=account(item.accountId),b=binding(item.accountId),phone=a?.service==='doubao',manual=item.state==='manual',busy=loginBusy.has(item.id),id=esc(item.id);
 const label=item.state==='queued'&&item.reason==='SMS_QUEUE_WAIT'?'等待前一账号':item.state==='queued'&&item.reason==='SMS_SEND_COOLDOWN'?'发送间隔中':states[item.state]||item.state;
 return `<article class="login-progress-item" data-login-item="${id}"><div class="login-item-details"><strong>${esc(a?.label||item.accountId)}</strong><span class="pool-pill">${esc(label)}</span><p class="login-phone">${phone?`手机号 · ${esc(b.identifier||'尚未保存')}`:`Cookie · ${esc(b.cookieFingerprint||'尚未保存')}`}</p><p>${esc(readableError(item.reason||''))}</p>${phone&&['manual','queued'].includes(item.state)?'<p data-sms-wait class="field-note"></p>':''}</div>
 <div class="login-item-actions">${manual&&phone&&item.smsState==='awaiting_code'?`<form class="sms-code-form" data-code-form="${id}"><label>短信验证码<input data-sms-code="${id}" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9A-Za-z-]{4,10}" minlength="4" maxlength="10" required placeholder="填写此手机号收到的验证码" ${busy?'disabled':''}></label><button class="button primary small" type="submit" ${busy?'disabled':''}>${busy?'正在登录…':'验证并登录'}</button></form>`:''}
 <div class="pool-actions">${manual?`<a class="button ghost small" href="/accounts/${encodeURIComponent(item.accountId)}/login?loginItem=${encodeURIComponent(item.id)}" target="symphony-account-browser">${item.smsState==='challenge'?'前往完成人机验证':'打开登录窗口'}</a>${phone?`<button class="button ghost small" data-sms-send="${id}" ${busy?'disabled':''}>${item.smsState==='awaiting_code'?'重新发送验证码':'发送验证码'}</button><button class="text-button" data-sms-status="${id}" ${busy?'disabled':''}>${item.smsState==='challenge'?'我已完成平台验证':'检查短信状态'}</button>`:`<button class="button primary small" data-finish="${id}" ${busy?'disabled':''}>完成并验收</button>`}`:''}${['manual','queued'].includes(item.state)?`<button class="text-button" data-cancel="${id}" ${busy?'disabled':''}>取消登录</button>`:''}</div></div></article>`;
}
function smsCountdown(){
 const wait=Math.max(0,Math.ceil(((snapshot.smsNextSendAt||0)-Date.now())/1000));
 for(const note of document.querySelectorAll('[data-sms-wait]'))note.textContent=wait?`短信发送间隔：还需等待 ${wait} 秒`:'按队列逐个处理手机号';
 for(const button of document.querySelectorAll('[data-sms-send]'))button.disabled=wait>0||loginBusy.has(button.dataset.smsSend);
}
function renderLogins(){
 const values=new Map([...document.querySelectorAll('[data-sms-code]')].map(input=>[input.dataset.smsCode,input.value]));
 const focus=document.activeElement?.dataset.smsCode,position=document.activeElement?.selectionStart;
 const active=snapshot.loginItems.filter(i=>activeStates.has(i.state)).reverse();
 $('#logins').innerHTML=active.length?active.map(loginCard).join(''):'<p class="pool-empty compact">当前没有待登录账号。上传文件并导入，或选择账号开始登录。</p>';
 const history=snapshot.loginItems.filter(i=>!activeStates.has(i.state)).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 const historyPages=Math.max(1,Math.ceil(history.length/5));loginHistoryPage=Math.min(loginHistoryPage,historyPages);
 $('#loginHistoryItems').innerHTML=history.slice((loginHistoryPage-1)*5,loginHistoryPage*5).map(loginCard).join('')||'<p class="field-note">还没有登录记录</p>';
 $('#loginHistoryPageLabel').textContent=`第 ${loginHistoryPage} / ${historyPages} 页 · 共 ${history.length} 条`;
 $('#loginHistoryPrevious').disabled=loginHistoryPage<=1;$('#loginHistoryNext').disabled=loginHistoryPage>=historyPages;
 for(const input of document.querySelectorAll('[data-sms-code]')){
  input.value=values.get(input.dataset.smsCode)||'';
  if(focus===input.dataset.smsCode&&!input.disabled){input.focus({preventScroll:true});if(position!==null)input.setSelectionRange(position,position);}
 }
 smsCountdown();
}
function renderInfrastructure(){
 document.querySelectorAll('[data-mimic-only]').forEach(el=>{el.hidden=!snapshot.requireMimicForNewAccounts;});
 $('#capacity').textContent=`全局上限 ${snapshot.globalLimit} · 在线节点容量 ${snapshot.workers.filter(w=>w.online).reduce((n,w)=>n+w.capacity,0)} · 当前占用 ${snapshot.leases.length}`;
 $('#workers').innerHTML=table(['节点','账号数','并发容量','状态'],snapshot.workers.map(w=>[esc(w.id),esc(w.accountCount??accounts.filter(a=>a.workerId===w.id).length),esc(w.capacity),w.online?'在线':'离线']));
 $('#groups').innerHTML=table(['组','容量','出口 IP','状态','操作'],snapshot.groups.map(g=>[esc(g.label),`${g.accounts} / ${g.capacity}`,esc(g.actualIp||g.expectedIp||'—'),esc(g.mode==='direct'?'直连 · 未隔离'+(g.health==='disabled'?' · 已停用':''):(health[g.health]||g.health)),`<button class="button ghost small" data-check="${esc(g.id)}" ${g.health==='disabled'?'disabled':''}>检测</button> <button class="button ghost small" data-toggle-group="${esc(g.id)}">${g.health==='disabled'?'启用':'停用'}</button>`]));
 for(const [id,label] of [['#bindGroup','选择出口组'],['#newGroup',snapshot.requireProxyForNewAccounts?'选择固定代理组':'稍后配置']]){
  const value=$(id).value,groups=snapshot.requireProxyForNewAccounts?snapshot.groups.filter(g=>g.mode==='proxy'):snapshot.groups;
  $(id).innerHTML=`<option value="">${label}</option>`+groups.map(g=>`<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('');$(id).value=value;
 }
}
async function refresh(){if(refreshing)return refreshing;refreshing=(async()=>{[snapshot,{accounts}]=await Promise.all([api('/api/pool'),api('/api/accounts')]);selection=new Set([...selection].filter(id=>account(id)));renderSummary();renderAccounts();renderLogins();renderInfrastructure();if(editorId&&!account(editorId)){$('#credentialForm').hidden=true;$('#credentialEmpty').hidden=false;editorId=null;}})().finally(()=>{refreshing=null;});return refreshing;}
function editIdentity(id,{scroll=true}={}){
 const a=account(id);if(!a)return;editorId=id;const b=binding(id);$('#credentialForm').reset();$('#credentialForm').hidden=false;$('#credentialEmpty').hidden=true;
 $('#credentialAccount').value=id;$('#credentialTitle').textContent=a.label;$('#credentialAccountId').textContent=a.id;$('#credentialMethod').textContent=method(a);
 $('#credentialPhone').value=b.identifier||'';$('#credentialSource').value=b.source||'';$('#phoneField').hidden=a.service!=='doubao';$('#cookieField').hidden=a.service!=='dola';$('#credentialPhone').required=a.service==='doubao';$('#credentialCookie').required=a.service==='dola'&&!b.recoverable;
 $('#credentialCookie').placeholder=b.recoverable?'已保存 Cookie。留空沿用；需要更换时粘贴新 Cookie。':'粘贴包含 sessionid 的完整 Cookie';
 $('#credentialSaved').textContent=b.recoverable?`${identity(a)} · ${time(b.savedAt)}`:'此账号尚未保存可恢复的登录资料';
 $('#credentialHint').textContent=a.service==='dola'?'保存后与此账号绑定。恢复登录会载入这份 Cookie 并自动验收。':'保存用于此账号登录的手机号。短信验证码在登录时填写。';
 $('#mimicProfilePanel').hidden=b.browserProvider!=='multilogin';
 $('#mimicFolderId').value=b.multiloginFolderId||'';$('#mimicProfileId').value=b.multiloginProfileId||'';
 $('#mimicFolderId').readOnly=Boolean(b.browserLocked);$('#mimicProfileId').readOnly=Boolean(b.browserLocked);
 $('#saveMimicProfile').disabled=Boolean(b.browserLocked);
 $('#mimicProfileHint').textContent=b.browserLocked?'此账号已开始使用该 Mimic 档案，绑定已锁定。':
   b.multiloginProfileId?'档案已绑定；启动时仍会校验浏览器的实际出口 IP。':'尚未绑定，账号不会开始登录或任务。';
 renderAccounts();if(scroll&&matchMedia('(max-width: 1000px)').matches)$('#credentialForm').scrollIntoView({behavior:'smooth',block:'start'});
}
async function restore(ids){await api('/api/pool/login',{accountIds:ids,useSavedCredentials:true});message('已加入登录队列：Dola 自动载入 Cookie 并验收；豆包请完成短信验证。');await refresh();$('#loginProgress').scrollIntoView({behavior:'smooth',block:'start'});}
async function showCookie(id){const data=await api('/api/pool/identity/reveal',{accountId:id});$('#cookieDialogTitle').textContent=`${account(id).label} 的 Cookie`;$('#cookieDialogIdentity').textContent=`${id} · Cookie ${data.cookieFingerprint}`;$('#cookieValue').value=data.cookies;$('#cookieDialog').showModal();}
$('#accounts').onchange=e=>{const id=e.target.dataset.account;if(id)e.target.checked?selection.add(id):selection.delete(id);renderAccounts();};
$('#accounts').onclick=e=>{const button=e.target.closest('button');if(!button)return;const d=button.dataset;if(d.delete)action(async()=>{const a=account(d.delete);if(!a||!confirm(`确定删除「${a.label}」？账号和浏览器登录档案将删除，历史任务及已生成视频会保留。`))return;const result=await request(`/api/accounts/${encodeURIComponent(a.id)}`,{method:'DELETE'});selection.delete(a.id);message(result.profileCleanupPending?'账号已删除，浏览器档案清理待处理':'账号已删除');},button);if(d.edit)editIdentity(d.edit);if(d.restore)action(()=>restore([d.restore]),button);if(d.reveal)action(()=>showCookie(d.reveal),button);if(d.copy)action(async()=>{const a=account(d.copy);await copy(a.service==='dola'?(await api('/api/pool/identity/reveal',{accountId:a.id})).cookies:binding(a.id).identifier);},button);};
$('#selectAll').onclick=()=>{const filtered=filteredAccounts(),remove=filtered.every(a=>selection.has(a.id));for(const a of filtered)remove?selection.delete(a.id):selection.add(a.id);renderAccounts();};
$('#accountSearch').oninput=$('#platformFilter').onchange=$('#accountStateFilter').onchange=()=>{accountPage=1;renderAccounts();};
$('#previousPage').onclick=()=>{accountPage--;renderAccounts();};$('#nextPage').onclick=()=>{accountPage++;renderAccounts();};
$('#loginHistoryPrevious').onclick=()=>{loginHistoryPage--;renderLogins();};$('#loginHistoryNext').onclick=()=>{loginHistoryPage++;renderLogins();};
$('#refreshPool').onclick=e=>action(async()=>message('列表已刷新'),e.currentTarget);
$('#bind').onclick=e=>action(async()=>{await api('/api/pool/bind',{accountIds:[...selection],groupId:$('#bindGroup').value});message('已绑定出口组，请重新登录或验收');},e.currentTarget);
$('#login').onclick=e=>action(()=>restore([...selection]),e.currentTarget);
$('#credentialForm').onsubmit=e=>{e.preventDefault();const form=e.currentTarget,button=e.submitter,data=Object.fromEntries(new FormData(form)),id=data.accountId;action(async()=>{await api('/api/pool/identity',data);$('#credentialCookie').value='';message('此账号的登录资料已加密保存');await refresh();editIdentity(id,{scroll:false});if(button.value==='login')await restore([id]);},button);};
$('#saveMimicProfile').onclick=e=>action(async()=>{if(!editorId)throw new Error('ACCOUNT_NOT_FOUND');
  await api('/api/pool/multilogin-profile',{accountId:editorId,folderId:$('#mimicFolderId').value.trim(),profileId:$('#mimicProfileId').value.trim()});
  message('Mimic 档案已绑定，请确认档案代理与出口组一致并检测出口');await refresh();editIdentity(editorId,{scroll:false});},e.currentTarget);
$('#closeCookie').onclick=()=>$('#cookieDialog').close();$('#cookieDialog').onclose=()=>{$('#cookieValue').value='';$('#cookieDialogIdentity').textContent='';};$('#copyCookieValue').onclick=e=>action(()=>copy($('#cookieValue').value),e.currentTarget);
function newPlatform(){const dola=$('#newPlatform').value==='dola',suggestion=suggestAccount(accounts,$('#newPlatform').value);$('#newAccountId').value=suggestion.id;$('#newAccountLabel').value=suggestion.label;$('#newPhoneField').hidden=dola;$('#newCookieField').hidden=!dola;$('#newPhone').required=!dola;$('#newCookie').required=dola;$('#newPhone').disabled=dola;$('#newCookie').disabled=!dola;}
$('#openCreate').onclick=()=>{$('#newAccountForm').reset();$('#newAccountError').textContent='';newPlatform();$('#createDialog').showModal();};$('#closeCreate').onclick=()=>$('#createDialog').close();$('#createDialog').onclose=()=>$('#newAccountForm').reset();$('#newPlatform').onchange=newPlatform;
$('#newAccountForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('#newAccountError').textContent='';try{const row={...Object.fromEntries(new FormData(e.currentTarget)),source:'新建账号'};const result=await api('/api/pool/import',{rows:[row]});if(!result.ok)throw new Error(result.errors.map(e=>readableError(e.code)).join('；'));$('#createDialog').close();await refresh();editIdentity(row.id,{scroll:false});message(`账号已创建，已分配到节点 ${account(row.id).workerId}，登录资料已保存`);}catch(error){$('#newAccountError').textContent=readableError(error.message);}finally{button.disabled=false;}};
bindFileImports({api,refresh,message});
$('#groupForm').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;action(async()=>{await api('/api/pool/groups',Object.fromEntries(new FormData(form)));form.reset();message('出口组已保存，请检测实际出口');},e.submitter);};
document.addEventListener('click',e=>{const button=e.target.closest('button');if(!button)return;const d=button.dataset;if(d.check)action(async()=>{message('正在检测出口…');await api('/api/pool/groups/check',{id:d.check});message('出口检测完成');},button);if(d.toggleGroup)action(async()=>{await api('/api/pool/groups/enable',{id:d.toggleGroup,enabled:snapshot.groups.find(g=>g.id===d.toggleGroup).health==='disabled'});message('出口组状态已更新，启用后请重新检测');},button);if(d.smsSend)action(async()=>{const result=await api('/api/pool/login/sms',{id:d.smsSend});message(readableError(result.reason||(result.ok?'SMS_CODE_REQUIRED':'SMS_SEND_UNCONFIRMED')),!result.ok);},button);if(d.smsStatus)action(async()=>{const result=await api('/api/pool/login/sms-status',{id:d.smsStatus});message(result.ok&&!result.smsState?'登录已完成':readableError(result.reason||'SMS_CODE_REQUIRED'),!result.ok);},button);if(d.finish)action(async()=>{message('正在验收登录态…');const result=await api('/api/pool/login/finish',{id:d.finish});message(result.ok?'登录验收完成':'登录尚未通过，请检查');},button);if(d.cancel)action(()=>api('/api/pool/login/cancel',{id:d.cancel}),button);});
refresh().then(()=>{const id=new URLSearchParams(location.search).get('account');if(id)editIdentity(id,{scroll:false});}).catch(e=>message(readableError(e.message),true));setInterval(()=>refresh().catch(()=>{}),5000);

$('#logins').onsubmit=async event=>{
 const form=event.target.closest('[data-code-form]');if(!form)return;event.preventDefault();
 const id=form.dataset.codeForm,input=form.querySelector('[data-sms-code]'),code=input.value.trim();
 if(loginBusy.has(id)||!form.reportValidity())return;
 input.value='';loginBusy.add(id);renderLogins();
 try{const result=await api('/api/pool/login/code',{id,code});message(result.ok?'验证码已提交，登录检查完成':readableError(result.reason||'LOGIN_CODE_NOT_ACCEPTED'),!result.ok);}
 catch(error){message(readableError(error.message),true);}
 finally{loginBusy.delete(id);await refresh().catch(()=>{});}
};
setInterval(smsCountdown,1000);
