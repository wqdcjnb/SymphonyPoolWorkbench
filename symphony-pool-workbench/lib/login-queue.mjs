import { INFRA_ERRORS } from './infra-errors.mjs';

export function createLoginQueue({pool,store,sessions,verify,assist,maxConcurrent=5,now=Date.now,pollMs=2000}) {
  let running=null,stopped=false,timer=null;
  const held=new Map();
  const idle=async(account,token)=>{if(sessions.idle)await sessions.idle(account,token);else{await sessions.close(account);await pool.release(token);}};
  const wake=()=>{
    if(stopped||running)return running;
    clearTimeout(timer);let pending=false;
    running=(async()=>{
      for(const [id,item] of held){
        if(!item.finishing&&!item.assisting&&now()-item.openedAt>15*60_000){
          await idle(item.account,item.token);held.delete(id);
          await pool.setLogin(id,'failed','LOGIN_SESSION_TIMEOUT');
        }
      }
      for(const item of (await pool.loginItems({localOnly:true})).reverse()){
        if(item.state!=='queued')continue;
        pending=true;
        if(stopped||held.size>=maxConcurrent)break;
        const account=await store.getAccount(item.accountId);
        if(!account||account.workerId!==pool.workerId)continue;
        if(!sessions.enabled){await pool.setLogin(item.id,'failed','MANAGED_SESSIONS_REQUIRED');continue;}
        let token;
        try{
          token=await pool.reserve(account,'login');
          if(!token){await pool.setLogin(item.id,'queued',(await pool.unavailableReasons()).get(account.id)||'WORKER_CAPACITY_FULL');continue;}
          const allowed=await pool.beginLogin(item.id,token);
          if(!allowed.ok){await pool.release(token);await pool.setLogin(item.id,'queued',allowed.reason);continue;}
          held.set(item.id,{account,token,openedAt:now()});
          await sessions.open(account,{manual:true,token});
          if(account.loginType==='dola'&&(await pool.loginIdentity(account.id)).recoverable){
            await queue.finish(item.id,account.id);continue;
          }
          await pool.setLogin(item.id,'manual');
          if(account.loginType==='doubao'&&assist)await queue.sendSms(item.id);
          else await pool.setLogin(item.id,'manual','LOGIN_ASSIST_REQUIRES_MANUAL');
        }catch(error){
          try{await idle(account,token);held.delete(item.id);}catch{}
          const infrastructure=INFRA_ERRORS.has(error.message);
          await pool.setLogin(item.id,infrastructure?'queued':'failed',infrastructure?error.message:
            /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)?error.message:'LOGIN_SESSION_FAILED');
        }
      }
    })().finally(()=>{
      running=null;
      if(!stopped&&(pending||held.size)){timer=setTimeout(()=>void wake()?.catch(()=>{}),pollMs);timer.unref();}
    });
    return running;
  };
  const owned=async id=>{
    const item=held.get(id);
    if(!item)throw new Error('LOGIN_SESSION_NOT_FOUND');
    if(item.finishing||item.assisting)throw new Error('VERIFICATION_ALREADY_RUNNING');
    item.assisting=true;
    try{if(!await pool.hasLease(item.token))throw new Error('LOGIN_SESSION_NOT_FOUND');return item;}
    catch(error){item.assisting=false;throw error;}
  };
  const queue = {
    wake,
    async sendSms(id){
      const item=await owned(id);item.assisting=true;item.openedAt=now();
      try{
        const permission=await pool.claimSmsSend(id,item.token);if(!permission.ok)return permission;
        const result=await assist(item.account,null,'send_sms');
        await pool.setSms(id,result.smsState||'manual',result.reason||'LOGIN_ASSIST_REQUIRES_MANUAL');
        if(result.authenticated){item.assisting=false;return await this.finish(id,item.account.id);}
        return {...result,nextSendAt:permission.nextSendAt};
      }catch(error){
        await pool.setSms(id,'manual','SMS_SEND_UNCONFIRMED');throw error;
      }finally{item.assisting=false;}
    },
    async checkSms(id){
      const item=await owned(id);item.assisting=true;item.openedAt=now();
      try{
        const result=await assist(item.account,null,'status');
        await pool.setSms(id,result.smsState||'manual',result.reason||'LOGIN_ASSIST_REQUIRES_MANUAL');
        if(result.authenticated){item.assisting=false;return await this.finish(id,item.account.id);}
        return result;
      }finally{item.assisting=false;}
    },
    async code(id,code){
      if(typeof code!=='string'||! /^[0-9A-Za-z-]{4,10}$/.test(code.trim()))throw new Error('INVALID_VERIFICATION_CODE');
      const item=await owned(id);item.assisting=true;item.openedAt=now();
      try{
        const result=await assist(item.account,code.trim(),'submit_code');
        await pool.setLogin(id,'manual',result.reason||'LOGIN_CODE_NOT_ACCEPTED');
        if(result.submitted||result.authenticated){item.assisting=false;return await this.finish(id,item.account.id,{keepOnFailure:true});}
        return result;
      }finally{item.assisting=false;}
    },
    async finish(id,accountId,{keepOnFailure=false}={}){
      const item=await owned(id);
      if(accountId&&item.account.id!==accountId){item.assisting=false;throw new Error('LOGIN_ACCOUNT_MISMATCH');}
      item.finishing=true;item.assisting=false;
      try{
        await pool.setLogin(id,'verifying');
        const result=await verify(item.account);
        if(!result.loggedIn&&keepOnFailure){
          item.finishing=false;await pool.setLogin(id,'manual','LOGIN_CODE_NOT_ACCEPTED');
          return {ok:false,ready:false,reason:'LOGIN_CODE_NOT_ACCEPTED'};
        }
        await store.saveVerification(item.account.id,result,item.account);
        await idle(item.account,item.token);held.delete(id);
        await pool.setLogin(id,result.loggedIn?'done':'failed',result.error||null);
        void wake()?.catch(()=>{});return {ok:Boolean(result.loggedIn),ready:result.ok};
      }catch(error){
        if(INFRA_ERRORS.has(error.message)){
          await idle(item.account,item.token);held.delete(id);
          await pool.setLogin(id,'queued',error.message);throw error;
        }
        item.finishing=false;await pool.setLogin(id,'manual','LOGIN_VERIFICATION_FAILED');throw new Error('LOGIN_VERIFICATION_FAILED');
      }
    },
    async cancel(id){
      const current=(await pool.loginItems()).find(i=>i.id===id);if(!current)throw new Error('LOGIN_SESSION_NOT_FOUND');
      const item=held.get(id);
      if(item?.finishing||item?.assisting)throw new Error('VERIFICATION_ALREADY_RUNNING');
      if(item){await idle(item.account,item.token);held.delete(id);}
      else if(current.state!=='queued'&&current.state!=='failed')throw new Error('LOGIN_OTHER_WORKER');
      await pool.setLogin(id,'cancelled');void wake()?.catch(()=>{});return {ok:true};
    },
    async stop(){stopped=true;clearTimeout(timer);await running;for(const item of held.values()){try{await sessions.close(item.account);await pool.release(item.token);}catch{}}},
  };
  return queue;
}
