import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { secretVault, parseCookies } from './secret-vault.mjs';
import {identitySummary,loginCredential} from './login-identity.mjs';
import {listAccountWorkers,planAccountAssignments} from './account-assignment.mjs';

const active = "('leased','submitting','submitted','generating','collecting','reconciling')";
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export function createAccountPool({ store, workerId, capacity = 2, globalLimit = 100, keyFile, enforceGroups = false, enforceWorker = true, now = Date.now }) {
  if (![capacity,globalLimit].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) throw new Error('INVALID_POOL_CAPACITY');
  const db = store.database, owner = randomUUID(), vault = secretVault(keyFile);
  const tx = action => db.transaction(action);
  const audit = async (type, details) => db.prepare(`INSERT INTO events(id,event_type,message,details_json,created_at) VALUES(?,?,?,?,?)`)
    .run(randomUUID(),type,type,JSON.stringify(details),now());
  const localWorker = async () => {
    const worker = await db.prepare('SELECT * FROM pool_workers WHERE id=?').get(workerId);
    if (!worker || worker.owner !== owner || !worker.enabled || worker.heartbeat_at < now() - 60_000) throw new Error('WORKER_NOT_ACTIVE');
    return worker;
  };
  const pool = {
    workerId, owner, enforceGroups,
    async start() {
      await tx(async () => {
        const previous = await db.prepare('SELECT * FROM pool_workers WHERE id=?').get(workerId);
        if (previous && previous.heartbeat_at > now() - 90_000 && previous.enabled) throw new Error('WORKER_ID_IN_USE');
        await db.prepare(`INSERT INTO pool_workers (id,owner,capacity,heartbeat_at,enabled) VALUES (?,?,?,?,1)
          ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,capacity=excluded.capacity,heartbeat_at=excluded.heartbeat_at,enabled=1`)
          .run(workerId,owner,capacity,now());
        // A closed or crashed login window cannot be resumed by a new process.
        // Keep its saved credential and allow a fresh login request instead.
        await db.prepare(`UPDATE login_items SET state='failed',reason='LOGIN_SESSION_INTERRUPTED',updated_at=?
          WHERE state IN ('starting','manual','verifying')
          AND account_id IN (SELECT id FROM accounts WHERE worker_id=?)
          AND NOT EXISTS (SELECT 1 FROM account_leases l WHERE l.account_id=login_items.account_id AND l.expires_at>?)`)
          .run(now(),workerId,now());
      });
    },
    async heartbeat() {
      await tx(async () => {
        const updated = await db.prepare('UPDATE pool_workers SET heartbeat_at=? WHERE id=? AND owner=? AND enabled=1').run(now(),workerId,owner);
        if (!updated.changes) throw new Error('WORKER_FENCED');
        await db.prepare('UPDATE account_leases SET expires_at=? WHERE worker_id=? AND owner=? AND expires_at>?').run(now()+90_000,workerId,owner,now());
        const expired = await db.prepare('SELECT * FROM account_leases WHERE expires_at<=?').all(now());
        for (const lease of expired) {
          // A timed out process could have clicked Submit. Never automatically replay it.
          if (lease.job_id) {
            await db.prepare(`UPDATE jobs SET status='reconciling',error_code='WORKER_LEASE_EXPIRED',updated_at=?
              WHERE id=? AND lease_token=? AND status IN ${active}`).run(now(),lease.job_id,lease.token);
            await store.scheduleReconciliation(lease.job_id);
          }
          await db.prepare("UPDATE login_items SET state='failed',reason='WORKER_LEASE_EXPIRED',updated_at=? WHERE account_id=? AND state IN ('starting','manual','verifying')").run(now(),lease.account_id);
          await db.prepare('DELETE FROM account_leases WHERE token=?').run(lease.token);
        }
      });
    },
    async stop() { await db.prepare('UPDATE pool_workers SET enabled=0,heartbeat_at=0 WHERE id=? AND owner=?').run(workerId,owner); },
    async residentAccountIds() {
      return (await db.prepare(`SELECT r.account_id FROM resident_browsers r JOIN accounts a ON a.id=r.account_id
        WHERE a.worker_id=? ORDER BY r.enabled_at,r.account_id`).all(workerId)).map(row=>row.account_id);
    },
    async isResident(id) { return Boolean(await db.prepare('SELECT 1 FROM resident_browsers WHERE account_id=?').get(id)); },
    async accountLease(id) { return await db.prepare('SELECT purpose,token,owner FROM account_leases WHERE account_id=?').get(id); },
    // Call inside the transaction that creates the accounts, including for bulk imports.
    async planNewAccountWorkers(count) {
      return planAccountAssignments(await listAccountWorkers(db,now()),count);
    },
    async snapshot() {
      const workers = await listAccountWorkers(db,now());
      const sms = await db.prepare('SELECT next_send_at AS nextSendAt FROM login_sms_control WHERE id=1').get();
      const groups = await db.prepare(`SELECT g.id,g.label,g.capacity,g.mode,g.expected_ip AS expectedIp,g.actual_ip AS actualIp,
        g.health,g.checked_at AS checkedAt,(SELECT COUNT(*) FROM account_bindings b WHERE b.group_id=g.id) AS accounts
        FROM egress_groups g ORDER BY g.id`).all();
      const leases = await db.prepare('SELECT account_id AS accountId,worker_id AS workerId,purpose,job_id AS jobId,expires_at AS expiresAt FROM account_leases').all();
      const rows = await db.prepare(`SELECT a.id AS accountId,a.login_type AS platform,b.group_id AS groupId,b.credential
        FROM accounts a LEFT JOIN account_bindings b ON b.account_id=a.id ORDER BY a.id`).all();
      const bindings=rows.map(row=>{
        try{return {accountId:row.accountId,groupId:row.groupId,hasCredential:Boolean(row.credential),
          ...identitySummary(row.platform,vault.open(row.credential,`account:${row.accountId}`))};}
        catch{return {accountId:row.accountId,groupId:row.groupId,hasCredential:Boolean(row.credential),
          ...identitySummary(row.platform,null),credentialError:'CREDENTIAL_DECRYPT_FAILED'};}
      });
      return { globalLimit, requireGroups: enforceGroups, workerId, workers, groups, leases, bindings, smsSendIntervalSeconds:60, smsNextSendAt:sms.nextSendAt };
    },
    async assertIdle(id) {
      if (await db.prepare('SELECT 1 FROM account_leases WHERE account_id=?').get(id)
        || await db.prepare(`SELECT 1 FROM jobs WHERE account_id=? AND status IN ${active}`).get(id)) throw new Error('ACCOUNT_ALREADY_RUNNING');
    },
    async renameBinding(oldId,newId) {
      const binding=await db.prepare('SELECT credential FROM account_bindings WHERE account_id=?').get(oldId);
      const credential=binding?.credential?vault.seal(vault.open(binding.credential,`account:${oldId}`),`account:${newId}`):null;
      await db.prepare('UPDATE account_bindings SET account_id=?,credential=? WHERE account_id=?').run(newId,credential,oldId);
      await db.prepare('UPDATE login_items SET account_id=? WHERE account_id=?').run(newId,oldId);
    },
    async putGroup(input) {
      if (!validId(input.id) || typeof input.label !== 'string' || !input.label.trim() || input.label.length>80) throw new Error('INVALID_GROUP');
      const size = Number(input.capacity ?? 10), mode = input.mode || 'proxy';
      if (!Number.isInteger(size)||size<1||size>10||!['proxy','direct'].includes(mode)) throw new Error('INVALID_GROUP');
      if (mode==='proxy' && !isIP(input.expectedIp || '')) throw new Error('EXPECTED_IP_REQUIRED');
      let secret=null;
      if (mode==='proxy') {
        let proxy; try { proxy=new URL(input.server); } catch { throw new Error('INVALID_PROXY'); }
        if (!['http:','https:','socks5:'].includes(proxy.protocol)||proxy.username||proxy.password||proxy.search||proxy.hash||!['','/'].includes(proxy.pathname)) throw new Error('INVALID_PROXY');
        if (proxy.protocol==='socks5:' && (input.username||input.password)) throw new Error('SOCKS5_AUTH_UNSUPPORTED');
        secret=vault.seal({server:proxy.origin==='null'?`${proxy.protocol}//${proxy.host}`:proxy.origin,username:input.username||undefined,password:input.password||undefined},`group:${input.id}`);
      }
      await tx(async()=>{
        const assigned=await db.prepare('SELECT account_id FROM account_bindings WHERE group_id=?').all(input.id);
        if(assigned.length>size)throw new Error('GROUP_CAPACITY_EXCEEDED');
        for(const a of assigned)await this.assertIdle(a.account_id);
        await db.prepare(`INSERT INTO egress_groups(id,label,capacity,mode,secret,expected_ip,health) VALUES(?,?,?,?,?,?,'unchecked')
          ON CONFLICT(id) DO UPDATE SET label=excluded.label,capacity=excluded.capacity,mode=excluded.mode,secret=excluded.secret,
          expected_ip=excluded.expected_ip,actual_ip=NULL,checked_at=NULL,health='unchecked'`).run(input.id,input.label.trim(),size,mode,secret,input.expectedIp||null);
        await db.prepare("UPDATE accounts SET status='auth_required',last_verified_at=NULL WHERE id IN (SELECT account_id FROM account_bindings WHERE group_id=?)").run(input.id);
        await audit('pool.group_saved',{groupId:input.id,mode,capacity:size});
      });
    },
    async groupRuntime(id) {
      const group=await db.prepare('SELECT * FROM egress_groups WHERE id=?').get(id);
      if(!group)throw new Error('GROUP_NOT_FOUND');
      return {groupId:id,mode:group.mode,proxy:group.mode==='proxy'?vault.open(group.secret,`group:${id}`):null,expectedIp:group.expected_ip,health:group.health};
    },
    async enableGroup(id,enabled) {
      if(typeof enabled!=='boolean')throw new Error('INVALID_GROUP');
      await tx(async()=>{
        await this.groupRuntime(id);
        for(const member of await db.prepare('SELECT account_id FROM account_bindings WHERE group_id=?').all(id))await this.assertIdle(member.account_id);
        await db.prepare('UPDATE egress_groups SET health=? WHERE id=?').run(enabled?'unchecked':'disabled',id);
        await audit('pool.group_enabled',{groupId:id,enabled});
      });
    },
    async recordGroupCheck(id, ip, error=null) {
      if(ip&&!isIP(ip))throw new Error('INVALID_EGRESS_IP');
      await tx(async()=>{
        const group=await this.groupRuntime(id);
        if(group.health==='disabled')throw new Error('GROUP_DISABLED');
        let health=error?'failed':group.mode==='direct'?'direct':ip!==group.expectedIp?'mismatch':'ready';
        const duplicates=ip?await db.prepare('SELECT id FROM egress_groups WHERE id<>? AND actual_ip=? AND mode=\'proxy\'').all(id,ip):[];
        if(duplicates.length && group.mode==='proxy')health='conflict';
        await db.prepare('UPDATE egress_groups SET health=?,actual_ip=?,checked_at=? WHERE id=?').run(health,ip,now(),id);
        for(const d of duplicates)await db.prepare("UPDATE egress_groups SET health='conflict' WHERE id=?").run(d.id);
        await audit('pool.egress_checked',{groupId:id,health});
      });
    },
    async bind(ids, groupId) {
      if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Error('INVALID_ACCOUNT_LIST');
      await tx(async()=>{
        const group=await db.prepare('SELECT * FROM egress_groups WHERE id=?').get(groupId);
        if(!group)throw new Error('GROUP_NOT_FOUND');
        const members=await db.prepare('SELECT account_id FROM account_bindings WHERE group_id=?').all(groupId);
        if(new Set([...members.map(a=>a.account_id),...ids]).size>group.capacity)throw new Error('GROUP_CAPACITY_EXCEEDED');
        for(const id of ids){
          if(!await store.getAccount(id))throw new Error('ACCOUNT_NOT_FOUND');
          await this.assertIdle(id);
          await db.prepare('INSERT INTO account_bindings(account_id,group_id) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET group_id=excluded.group_id').run(id,groupId);
          await db.prepare("UPDATE accounts SET status='auth_required',last_verified_at=NULL WHERE id=?").run(id);
        }
        await audit('pool.accounts_bound',{accountIds:ids,groupId});
      });
    },
    async credential(id,input) {
      const account=await store.getAccount(id);if(!account)throw new Error('ACCOUNT_NOT_FOUND');
      const credentials={};
      if(input.cookies)credentials.cookies=parseCookies(input.cookies,account.loginType);
      if(input.identifier){if(typeof input.identifier!=='string'||input.identifier.length>200)throw new Error('INVALID_IDENTIFIER');credentials.identifier=input.identifier;}
      if(input.password){if(typeof input.password!=='string'||input.password.length>500)throw new Error('INVALID_PASSWORD');credentials.password=input.password;}
      if(!Object.keys(credentials).length)throw new Error('CREDENTIAL_REQUIRED');
      await tx(async()=>{
        await this.assertIdle(id);
        const previous=await db.prepare('SELECT credential FROM account_bindings WHERE account_id=?').get(id);
        if(input.source!==undefined&&(typeof input.source!=='string'||input.source.length>160||/[\r\n\x00]/.test(input.source)))throw new Error('LOGIN_SOURCE_INVALID');
        const merged={...vault.open(previous?.credential,`account:${id}`),...credentials,savedAt:now(),
          ...(input.source?.trim()?{source:input.source.trim()}: {})};
        await db.prepare(`INSERT INTO account_bindings(account_id,credential) VALUES(?,?)
          ON CONFLICT(account_id) DO UPDATE SET credential=excluded.credential`).run(id,vault.seal(merged,`account:${id}`));
        await db.prepare("UPDATE accounts SET status='auth_required',last_verified_at=NULL WHERE id=?").run(id);
        await audit('pool.credential_saved',{accountId:id});
      });
    },
    async credentials(rows) {
      if(!Array.isArray(rows)||!rows.length||rows.length>100||new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('INVALID_ACCOUNT_LIST');
      return tx(async()=>{for(const row of rows)await this.credential(row.id,row);return {ok:true,count:rows.length};});
    },
    async loginIdentity(id) {
      const account=await store.getAccount(id);if(!account)throw new Error('ACCOUNT_NOT_FOUND');
      const binding=await db.prepare('SELECT credential FROM account_bindings WHERE account_id=?').get(id);
      return {accountId:id,...identitySummary(account.loginType,vault.open(binding?.credential,`account:${id}`))};
    },
    async saveLoginIdentity(id,input) {
      return tx(async()=>{
        const account=await store.getAccount(id);if(!account)throw new Error('ACCOUNT_NOT_FOUND');
        await this.assertIdle(id);
        if(await db.prepare("SELECT 1 FROM login_items WHERE account_id=? AND state IN ('queued','starting','manual','verifying')").get(id))throw new Error('LOGIN_ALREADY_QUEUED');
        const previous=await db.prepare('SELECT credential FROM account_bindings WHERE account_id=?').get(id);
        const credential={...loginCredential(account.loginType,input,vault.open(previous?.credential,`account:${id}`)),savedAt:now()};
        await db.prepare(`INSERT INTO account_bindings(account_id,credential) VALUES(?,?)
          ON CONFLICT(account_id) DO UPDATE SET credential=excluded.credential`).run(id,vault.seal(credential,`account:${id}`));
        await db.prepare("UPDATE accounts SET status='auth_required',last_verified_at=NULL WHERE id=?").run(id);
        await audit('pool.login_identity_saved',{accountId:id,method:identitySummary(account.loginType,credential).loginMethod});
        return {ok:true,...identitySummary(account.loginType,credential)};
      });
    },
    async saveLoginIdentities(rows) {
      if(!Array.isArray(rows)||!rows.length||rows.length>100||new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('INVALID_ACCOUNT_LIST');
      return tx(async()=>{for(const row of rows)await this.saveLoginIdentity(row.id,row);return {ok:true,count:rows.length};});
    },
    async revealLoginIdentity(id) {
      const account=await store.getAccount(id);if(!account)throw new Error('ACCOUNT_NOT_FOUND');
      const binding=await db.prepare('SELECT credential FROM account_bindings WHERE account_id=?').get(id);
      const credential=vault.open(binding?.credential,`account:${id}`),summary=identitySummary(account.loginType,credential);
      if(!summary.recoverable)throw new Error('LOGIN_IDENTITY_REQUIRED');
      await audit('pool.login_identity_viewed',{accountId:id,method:summary.loginMethod});
      return {accountId:id,...summary,cookies:summary.loginMethod==='cookie'?credential.cookies.map(c=>`${c.name}=${c.value}`).join('; '):undefined};
    },
    async runtime(id, { secrets=false, requireHealthy=true }={}) {
      const binding=await db.prepare('SELECT * FROM account_bindings WHERE account_id=?').get(id);
      if(!binding?.group_id && enforceGroups)throw new Error('ACCOUNT_GROUP_REQUIRED');
      const group=binding?.group_id?await this.groupRuntime(binding.group_id):{mode:'direct',proxy:null};
      if(group.health==='disabled')throw new Error('GROUP_DISABLED');
      if(requireHealthy && group.mode==='proxy' && group.health!=='ready')throw new Error('EGRESS_NOT_READY');
      return {...group,credential:secrets?vault.open(binding?.credential,`account:${id}`):undefined};
    },
    async eligible(account) {
      if(enforceWorker && account.workerId!==workerId)return false;
      if(await db.prepare('SELECT 1 FROM account_leases WHERE account_id=?').get(account.id))return false;
      try{await this.runtime(account.id);return true;}catch{return false;}
    },
    async unavailableReasons() {
      const rows=await db.prepare(`SELECT a.id,a.worker_id,b.group_id,g.mode,g.health,l.token
        FROM accounts a LEFT JOIN account_bindings b ON b.account_id=a.id
        LEFT JOIN egress_groups g ON g.id=b.group_id LEFT JOIN account_leases l ON l.account_id=a.id`).all();
      return new Map(rows.map(r=>[r.id,(enforceWorker&&r.worker_id!==workerId)?'ACCOUNT_OTHER_WORKER':r.token?'ACCOUNT_ALREADY_RUNNING':
        (!r.group_id&&enforceGroups)?'ACCOUNT_GROUP_REQUIRED':r.health==='disabled'?'GROUP_DISABLED':(r.mode==='proxy'&&r.health!=='ready')?'EGRESS_NOT_READY':null]).filter(([,reason])=>reason));
    },
    async unavailableIds() { return [...(await this.unavailableReasons()).keys()]; },
    async reserve(account, purpose, jobId=null) {
      return tx(async()=>{
        const worker=await localWorker();
        if(!await this.eligible(account))return null;
        const occupied=await db.prepare('SELECT COUNT(*) AS count FROM account_leases WHERE worker_id=?').get(workerId);
        const all=await db.prepare("SELECT COUNT(*) AS count FROM account_leases WHERE purpose='job'").get();
        if(occupied.count>=worker.capacity || purpose==='job' && all.count>=globalLimit)return null;
        const token=randomUUID();
        await db.prepare('INSERT INTO account_leases(account_id,worker_id,owner,token,purpose,job_id,expires_at) VALUES(?,?,?,?,?,?,?)').run(account.id,workerId,owner,token,purpose,jobId,now()+90_000);
        if(['login','manual'].includes(purpose))await db.prepare("UPDATE accounts SET status='auth_required',last_verified_at=NULL WHERE id=?").run(account.id);
        if(jobId)await db.prepare('UPDATE jobs SET lease_token=?,execution_worker=? WHERE id=?').run(token,workerId,jobId);
        return token;
      });
    },
    async handoffToManual(token) {
      return tx(async()=>{
        const lease=await db.prepare("SELECT account_id,job_id FROM account_leases WHERE token=? AND owner=? AND purpose='job' AND expires_at>?").get(token,owner,now());
        if(!lease)throw new Error('STALE_JOB_LEASE');
        const job=await store.getJob(lease.job_id);
        if(job?.status!=='reconciling'||!['DOLA_HUMAN_VERIFICATION_REQUIRED','DOUBAO_HUMAN_VERIFICATION_REQUIRED'].includes(job.errorCode))throw new Error('JOB_NOT_PAUSED_FOR_VERIFICATION');
        await db.prepare("UPDATE account_leases SET purpose='manual',job_id=NULL,expires_at=? WHERE token=? AND owner=?").run(now()+90_000,token,owner);
        await db.prepare('UPDATE jobs SET lease_token=NULL WHERE id=? AND lease_token=?').run(job.id,token);
        await audit('pool.human_verification_required',{accountId:lease.account_id,jobId:job.id});
      });
    },
    async release(token) { if(token)await db.prepare('DELETE FROM account_leases WHERE token=? AND owner=?').run(token,owner); },
    async hasLease(token){return Boolean(await db.prepare('SELECT 1 FROM account_leases WHERE token=? AND owner=? AND expires_at>?').get(token,owner,now()));},
    async loginBatch(ids,{useSavedCredentials=false}={}) {
      if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Error('INVALID_ACCOUNT_LIST');
      return tx(async()=>{
        const batchId=`login-${randomUUID()}`;
        await db.prepare('INSERT INTO login_batches(id,created_at) VALUES(?,?)').run(batchId,now());
        for(const [position,id] of ids.entries()){
          if(!await store.getAccount(id))throw new Error('ACCOUNT_NOT_FOUND');
          if(useSavedCredentials&&!(await this.loginIdentity(id)).recoverable)throw new Error('LOGIN_IDENTITY_REQUIRED');
          if(await db.prepare("SELECT 1 FROM login_items WHERE account_id=? AND state IN ('queued','starting','manual','verifying')").get(id))throw new Error('LOGIN_ALREADY_QUEUED');
          await db.prepare("INSERT INTO login_items(id,batch_id,account_id,state,updated_at,position) VALUES(?,?,?,'queued',?,?)").run(randomUUID(),batchId,id,now(),position);
        }await audit('pool.login_batch_created',{batchId,count:ids.length});return batchId;
      });
    },
    async loginItems({localOnly=false}={}){return db.prepare(`SELECT i.id,i.batch_id AS batchId,i.account_id AS accountId,i.state,i.reason,
      i.updated_at AS updatedAt,i.sms_requested_at AS smsRequestedAt,i.sms_state AS smsState,i.position,
      b.created_at AS batchCreatedAt,b.rowid AS batchOrder FROM login_items i JOIN login_batches b ON b.id=i.batch_id
      JOIN accounts a ON a.id=i.account_id WHERE (?=0 OR a.worker_id=?) AND (i.state IN ('queued','starting','manual','verifying') OR i.id IN
        (SELECT id FROM login_items WHERE state NOT IN ('queued','starting','manual','verifying') ORDER BY updated_at DESC LIMIT 200))
      ORDER BY b.created_at DESC,b.rowid DESC,i.position DESC,i.id DESC`).all(localOnly?1:0,workerId);},
    async beginLogin(id,token){return tx(async()=>{
      const item=await db.prepare(`SELECT i.*,a.login_type FROM login_items i JOIN accounts a ON a.id=i.account_id WHERE i.id=?`).get(id);
      if(!item||item.state!=='queued'||!await this.hasLease(token))throw new Error('LOGIN_SESSION_NOT_FOUND');
      if(item.login_type==='doubao'){
        const other=await db.prepare(`SELECT 1 FROM login_items i JOIN accounts a ON a.id=i.account_id
          JOIN account_leases l ON l.account_id=a.id WHERE a.login_type='doubao' AND i.id<>?
          AND i.state IN ('starting','manual','verifying') AND l.expires_at>?`).get(id,now());
        if(other)return {ok:false,reason:'SMS_QUEUE_WAIT'};
        const waiting=await db.prepare(`SELECT i.id,i.account_id,l.purpose FROM login_items i
          JOIN login_batches b ON b.id=i.batch_id JOIN accounts a ON a.id=i.account_id
          JOIN pool_workers w ON w.id=a.worker_id LEFT JOIN account_leases l ON l.account_id=a.id AND l.expires_at>?
          WHERE i.state='queued' AND a.login_type='doubao' AND w.enabled=1 AND w.heartbeat_at>?
          ORDER BY b.created_at,b.rowid,i.position,i.id`).all(now(),now()-60_000);
        for(const candidate of waiting){
          if(candidate.purpose&&candidate.purpose!=='login')continue;
          try{await this.runtime(candidate.account_id);}catch{continue;}
          if(candidate.id!==id)return {ok:false,reason:'SMS_QUEUE_WAIT'};
          break;
        }
        const clock=await db.prepare('SELECT next_send_at FROM login_sms_control WHERE id=1').get();
        if(clock.next_send_at>now())return {ok:false,reason:'SMS_SEND_COOLDOWN',nextSendAt:clock.next_send_at};
      }
      await this.setLogin(id,'starting');return {ok:true};
    });},
    async claimSmsSend(id,token){return tx(async()=>{
      const item=await db.prepare(`SELECT i.*,a.login_type FROM login_items i JOIN accounts a ON a.id=i.account_id WHERE i.id=?`).get(id);
      if(!item||item.login_type!=='doubao'||!['starting','manual'].includes(item.state)||!await this.hasLease(token))
        throw new Error('LOGIN_SESSION_NOT_FOUND');
      const clock=await db.prepare('SELECT next_send_at FROM login_sms_control WHERE id=1').get();
      if(clock.next_send_at>now())return {ok:false,reason:'SMS_SEND_COOLDOWN',nextSendAt:clock.next_send_at};
      const sent=now(),nextSendAt=sent+60_000;
      await db.prepare('UPDATE login_sms_control SET next_send_at=? WHERE id=1').run(nextSendAt);
      await db.prepare("UPDATE login_items SET sms_requested_at=?,sms_state='sending',updated_at=? WHERE id=?").run(sent,sent,id);
      return {ok:true,nextSendAt};
    });},
    async setSms(id,state,reason=null){await db.prepare('UPDATE login_items SET sms_state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,now(),id);},
    async setLogin(id,state,reason=null){await db.prepare('UPDATE login_items SET state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,now(),id);},
  };
  return pool;
}
