// Keep verified account browsers running without holding execution slots or sending platform requests.
export function createBrowserResidency({store,pool,sessions,locks,verificationLocks,now=Date.now}){
  let stopped=false,running=null;
  const failures=new Map();
  return {
    failures,
    wake(){
      if(stopped||!sessions.enabled||!sessions.keepAlive)return null;
      if(running)return running;
      running=(async()=>{
        for(const id of await pool.residentAccountIds()){
          if(stopped)break;
          if(locks.has(id)||verificationLocks.has(id)||(failures.get(id)?.retryAt||0)>now())continue;
          const account=await store.getAccount(id);if(!account||sessions.isAlive(account))continue;
          if(await pool.accountLease(id))continue;
          locks.add(id);let token;
          try{
            // Reserving briefly serializes startup with login, generation and account deletion.
            token=await pool.reserve(account,'browser');if(!token)continue;
            await sessions.open(account,{token});
            await sessions.idle(account,token);token=null;failures.delete(id);
          }catch(error){
            const attempts=(failures.get(id)?.attempts||0)+1;
            failures.set(id,{attempts,retryAt:now()+Math.min(300_000,30_000*2**Math.min(attempts-1,4)),
              error:/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)?error.message:'PROFILE_LAUNCH_FAILED'});
          }finally{
            if(token)await pool.release(token);
            locks.delete(id);
          }
        }
      })().finally(()=>{running=null;});
      return running;
    },
    async stop(){stopped=true;await running;},
  };
}
