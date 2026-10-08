// Node.js 22+. Keep API keys in your backend environment, never in task journals.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const terminalStates = new Set(['succeeded','partially_succeeded','failed','cancelled']);
const transientStatuses = new Set([408,429,500,502,503,504]);
export const terminal = task => terminalStates.has(task?.status);
export const retryable = error => transientStatuses.has(error.status)
  || ['TimeoutError','AbortError','TypeError'].includes(error.name)
  || ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ECONNREFUSED','EPIPE'].includes(error.code);
const taskPath = id => {
  if (!/^task-[a-f0-9-]{36}$/.test(id || '')) throw new Error('INVALID_TASK_ID');
  return '/videos/'+id;
};
const safeTask = task => Object.fromEntries(['task_id','client_task_id','status','terminal','poll_after_seconds',
  'completed_count','succeeded_count','failed_count','cancelled_count','wait_expired','retrying','delivery_pending']
  .filter(key => task[key] !== undefined).map(key => [key,task[key]]));

export class Client {
  constructor({base=process.env.PARTNER_API_BASE_URL||'https://47.84.3.74/v1',key=process.env.PARTNER_API_KEY,
    fetcher=fetch,clock=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random}={}) {
    this.base=base.replace(/\/$/,''); const url=new URL(this.base);
    if(!key) throw new Error('Set PARTNER_API_KEY locally.');
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/v1'
      || !(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))) throw new Error('INVALID_API_BASE_URL');
    Object.assign(this,{key,fetcher,clock,sleep,random});
  }
  async request(route,method='GET',payload) {
    const response=await this.fetcher(this.base+route,{method,redirect:'error',signal:AbortSignal.timeout(120000),
      headers:{Authorization:'Bearer '+this.key,...(payload?{'Content-Type':'application/json'}:{})},
      body:payload?JSON.stringify(payload):undefined});
    if(!response.ok){
      const body=await response.json().catch(()=>({}));
      const error=new Error(`HTTP ${response.status}: ${body.error?.code||'UNEXPECTED_RESPONSE'}`);
      error.status=response.status;
      const retry=response.headers.get('retry-after');
      error.retryAfter=Math.max(0,Number(retry)||((Date.parse(retry)-this.clock())/1000)||0);
      throw error;
    }
    return response;
  }
  async submit(payload) {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(payload?.client_task_id||'')) throw new Error('CLIENT_TASK_ID_REQUIRED');
    // Every retry uses the SAME business ID, normalized parameters and images.
    for(let attempt=0;;attempt++){
      try{return await (await this.request('/videos','POST',payload)).json();}
      catch(error){if(attempt>=3||!retryable(error))throw error;await this.sleep(Math.max(error.retryAfter||0,2**attempt*5)*1000);}
    }
  }
  async download(id,result,output,deliveryMode='official_original') {
    const repaired=deliveryMode==='watermark_repair'&&result.delivery_mode==='watermark_repair'
      &&result.postprocessed===true&&result.watermark_free===null;
    if((!repaired&&result.watermark_free!==true)||!result.video_url)throw new Error('WATERMARK_FREE_RESULT_REQUIRED');
    if(!Number.isInteger(result.index)||result.index<1||result.index>100)throw new Error('INVALID_RESULT_INDEX');
    await fs.mkdir(output,{recursive:true});
    const target=path.join(output,`${id}-${result.index}.mp4`);
    try{
      const existing=await fs.readFile(target);
      if(existing.length===result.size_bytes&&createHash('sha256').update(existing).digest('hex')===result.sha256)return target;
      throw new Error('LOCAL_FILE_CONFLICT');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(output,`.download-${randomUUID()}.part`),hash=createHash('sha256');let bytes=0;
    try{
      const response=await this.request(taskPath(id)+`/results/${result.index}`);
      if(!response.headers.get('content-type')?.startsWith('video/mp4'))throw new Error('UNEXPECTED_MEDIA_TYPE');
      await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,callback){
        hash.update(chunk);bytes+=chunk.length;callback(null,chunk);
      }}),createWriteStream(temporary,{flags:'wx'}));
      if(bytes!==result.size_bytes||hash.digest('hex')!==result.sha256)throw new Error('VIDEO_CHECKSUM_MISMATCH');
      await fs.rename(temporary,target);return target;
    }finally{await fs.rm(temporary,{force:true});}
  }
  async wait(id,{output='videos',timeout=0,interval=60,onProgress=()=>{}}={}) {
    taskPath(id);
    if(!Number.isFinite(timeout)||timeout<0||!Number.isFinite(interval)||interval<=0)throw new Error('INVALID_WAIT_OPTIONS');
    const deadline=timeout?this.clock()+timeout*1000:Infinity;
    let task={task_id:id,status:'unknown',terminal:false},failures=0;
    while(this.clock()<deadline){
      let pause=interval;
      try{
        task=await (await this.request(taskPath(id))).json();
        task.terminal=terminal(task);failures=0;
        if(!task.terminal)await onProgress(safeTask(task));
        if(task.terminal){
          const files=[];
          for(const result of task.results||[])if(result.status==='succeeded')files.push(await this.download(id,result,output,task.delivery_mode));
          return {...safeTask(task),files,errors:(task.results||[]).filter(r=>r.error).map(r=>r.error.code)};
        }
        pause=Math.max(interval,task.poll_after_seconds||60);
      }catch(error){
        if(!retryable(error))throw error;
        pause=Math.max(interval,error.retryAfter||0,Math.min(300,15*2**Math.min(failures++,5)));
        await onProgress({...safeTask(task),retrying:true,delivery_pending:terminal(task)});
      }
      await this.sleep(Math.max(0,Math.min(pause*1000*(1+this.random()*0.15),deadline-this.clock())));
    }
    // Ending a local wait does not change the remote task and is not a failed video.
    return {...safeTask(task),terminal:terminal(task),wait_expired:true,...(terminal(task)?{delivery_pending:true}:{})};
  }
}

async function main(){
  const args=process.argv.slice(2),options={timeout:0,interval:60,stateDir:'.symphony-tasks'},positional=[];
  for(let i=0;i<args.length;i++){
    if(args[i]==='--timeout')options.timeout=Number(args[++i]);
    else if(args[i]==='--interval')options.interval=Number(args[++i]);
    else if(args[i]==='--state-dir')options.stateDir=args[++i];
    else positional.push(args[i]);
  }
  const [action,value,output='videos']=positional,client=new Client();
  const record=async task=>{
    const safe={...safeTask(task),updated_at:new Date().toISOString()};
    if(safe.task_id){
      taskPath(safe.task_id);await fs.mkdir(options.stateDir,{recursive:true});
      const file=path.join(options.stateDir,safe.task_id+'.json'),temporary=file+'.'+randomUUID()+'.tmp';
      await fs.writeFile(temporary,JSON.stringify(safe,null,2)+'\n',{mode:0o600});await fs.rename(temporary,file);
    }
    console.log(JSON.stringify({...safe,...(task.files?{files:task.files,errors:task.errors}:{})}));
  };
  let task;
  if(action==='models'){console.log(JSON.stringify(await(await client.request('/models')).json(),null,2));return;}
  if(action==='submit')task=await client.submit(JSON.parse((await fs.readFile(value,'utf8')).replace(/^\uFEFF/,'')));
  else if(action==='get'||action==='cancel')task=await(await client.request(taskPath(value)+(action==='cancel'?'/cancel':''),action==='cancel'?'POST':'GET')).json();
  else if(action==='wait')task=await client.wait(value,{...options,output,onProgress:record});
  else throw new Error('Usage: node client.mjs models | submit task.json | get TASK_ID | wait TASK_ID [videos] [--timeout SECONDS] [--state-dir DIR] | cancel TASK_ID');
  task.terminal=terminal(task);await record(task);
  process.exitCode=task.terminal&&task.status!=='succeeded'?2:0;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
