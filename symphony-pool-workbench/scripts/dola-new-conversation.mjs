// Private worker operation: one fresh chat for an unaccepted Dola parameter proposal.
// Lease credentials travel on stdin only. Existing generation workers keep running.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../lib/database.mjs';

export const RETRY_EVENT = 'job.dola_parameter_conversation_restarted';

export async function reserveDolaConversationRetry(db, input) {
  return db.transaction(async () => {
    const job = await db.prepare('SELECT * FROM jobs WHERE id=?').get(input.id);
    if (!job || input.reason !== 'DOLA_PARAMETER_CONFIRMATION'
        || job.account_id !== input.accountId || !input.leaseToken || job.lease_token !== input.leaseToken) {
      throw new Error('DOLA_CONVERSATION_RETRY_UNSAFE');
    }
    const lease = await db.prepare("SELECT 1 FROM account_leases WHERE account_id=? AND token=? AND job_id=? AND purpose='job' AND expires_at>?")
      .get(job.account_id, input.leaseToken, job.id, Date.now());
    if (!lease) throw new Error('STALE_JOB_LEASE');
    const account = await db.prepare('SELECT service FROM accounts WHERE id=?').get(job.account_id);
    if (account?.service !== 'dola' || job.model !== 'Dreamina Seedance 2.5' || Number(job.duration_seconds) !== 30
        || Number(job.collect_only) || Number(job.cancel_requested) || job.result_path
        || ['generating','collecting','success'].includes(job.last_observed_stage)) {
      throw new Error('DOLA_CONVERSATION_RETRY_UNSAFE');
    }
    // The stdout status update can be a few milliseconds behind the worker.
    if (job.status === 'submitting' && !job.remote_url) return {pending:true};
    if (job.status !== 'submitted' || job.remote_url !== input.remoteUrl
        || job.remote_message_id !== input.remoteMessageId || !job.remote_url || !job.remote_message_id) {
      throw new Error('DOLA_CONVERSATION_RETRY_UNSAFE');
    }
    const prior = await db.prepare(`SELECT 1 FROM events WHERE job_id=? AND
      (event_type IN ('job.conversation_restarted',?,'job.generating','job.collecting','job.success')
       OR event_type LIKE 'job.user_new_conversation_%') LIMIT 1`).get(job.id, RETRY_EVENT);
    if (prior) throw new Error('DOLA_CONVERSATION_RETRY_USED');
    const now = Date.now();
    await db.prepare(`UPDATE jobs SET status='submitting',remote_url=NULL,remote_message_id=NULL,
      submitted_at=NULL,error_code=NULL,last_observed_stage='submitting',last_observed_at=?,updated_at=?
      WHERE id=?`).run(now, now, job.id);
    await db.prepare(`INSERT INTO events(id,account_id,job_id,event_type,message,details_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), job.account_id, job.id, RETRY_EVENT,
      'Dola 尚未开始生成且要求确认不同参数，已按用户设置新开对话重发一次，保留原规格和任务编号',
      JSON.stringify({reason:input.reason,previousRemoteUrl:job.remote_url,
        previousRemoteMessageId:job.remote_message_id,previousSubmittedAt:job.submitted_at,
        maximumRetries:1,creditsPreserved:true}), now);
    return {ok:true};
  });
}

async function main() {
  let db;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = process.env.WORKBENCH_DATABASE_SOURCE || process.env.DATABASE_URL
      || (process.env.DATABASE_URL_FILE ? fs.readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim() : null)
      || path.join(project, 'data', 'workbench.sqlite');
    if (!/^postgres(?:ql)?:\/\//.test(source) && !fs.existsSync(source)) throw new Error('DATABASE_LOCATION_REQUIRED');
    db = await openDatabase(source);
    const deadline = Date.now() + 5000;
    while (true) {
      const result = await reserveDolaConversationRetry(db, input);
      if (!result.pending) { console.log(JSON.stringify(result)); return; }
      if (Date.now() >= deadline) throw new Error('DOLA_SUBMISSION_STATE_NOT_READY');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch {
    console.log(JSON.stringify({ok:false,error:'DOLA_CONVERSATION_RETRY_NOT_CONFIRMED'}));
    process.exitCode = 1;
  } finally { await db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
