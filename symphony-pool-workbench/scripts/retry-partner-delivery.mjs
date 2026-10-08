import fs from 'node:fs';
import { createPartnerStore } from '../lib/partner-store.mjs';

const [id,action]=process.argv.slice(2);
if(!/^task-[a-f0-9-]{36}$/.test(id||'') || action!=='--apply')throw new Error('USAGE_TASK_ID_AND_APPLY_REQUIRED');
const database=process.env.DATABASE_URL_FILE
  ? fs.readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim():process.env.DATABASE_URL;
if(!database)throw new Error('DATABASE_NOT_CONFIGURED');
const store=await createPartnerStore(database);
try {
  const task=await store.retryDelivery(id,Date.now());
  console.log(JSON.stringify({taskId:task.id,status:task.state,reprocessExistingVideoOnly:true}));
} finally {await store.close();}
