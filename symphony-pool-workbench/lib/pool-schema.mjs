export async function migratePool(db) {
  // Expand the original CHECK without dropping any account, task, or profile.
  if (db.kind === 'postgres') {
    const constraint=await db.prepare("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='accounts_login_type_check' AND conrelid='accounts'::regclass").get();
    if(!constraint?.definition.includes("'dola'"))await db.exec("ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_login_type_check; ALTER TABLE accounts ADD CONSTRAINT accounts_login_type_check CHECK(login_type IN ('tiktok','doubao','dola'))");
  } else {
    const schema = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'").get();
    if (!schema.sql.includes("'dola'")) {
      await db.exec('PRAGMA foreign_keys=OFF');
      try {
        await db.transaction(async () => {
          await db.exec(schema.sql.replace(/CREATE TABLE accounts/i, 'CREATE TABLE accounts_v2').replace("'tiktok','doubao'", "'tiktok','doubao','dola'"));
          await db.exec('INSERT INTO accounts_v2 SELECT * FROM accounts; DROP TABLE accounts; ALTER TABLE accounts_v2 RENAME TO accounts; CREATE INDEX accounts_dispatch_idx ON accounts(service,status,health_score,updated_at)');
        });
      } finally { await db.exec('PRAGMA foreign_keys=ON'); }
    }
  }
  const columns = new Set((await db.prepare('PRAGMA table_info(jobs)').all()).map(c => c.name));
  for (const [name, type] of [['lease_token','TEXT'],['execution_worker','TEXT'],['collect_only','INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) await db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pool_workers (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100),
      heartbeat_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS egress_groups (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 10),
      mode TEXT NOT NULL CHECK(mode IN ('proxy','direct')), secret TEXT,
      expected_ip TEXT, actual_ip TEXT, health TEXT NOT NULL DEFAULT 'unchecked', checked_at INTEGER);
    CREATE TABLE IF NOT EXISTS account_bindings (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      group_id TEXT REFERENCES egress_groups(id), identifier TEXT, credential TEXT);
    CREATE TABLE IF NOT EXISTS account_leases (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL, job_id TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS resident_browsers (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      enabled_at INTEGER NOT NULL);
    INSERT INTO resident_browsers(account_id,enabled_at)
      SELECT a.id,a.last_verified_at FROM accounts a WHERE a.last_verified_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM events e WHERE e.account_id=a.id AND e.event_type='account.verified')
      ON CONFLICT(account_id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS login_batches (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_items (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES login_batches(id),
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      state TEXT NOT NULL, reason TEXT, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS login_items_queue_idx ON login_items(state,updated_at);
    CREATE INDEX IF NOT EXISTS account_leases_expiry_idx ON account_leases(expires_at);
    CREATE TABLE IF NOT EXISTS pool_import_receipts (
      id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_sms_control (
      id INTEGER PRIMARY KEY CHECK(id=1), next_send_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO login_sms_control(id,next_send_at) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
  `);
  const loginColumns = new Set((await db.prepare('PRAGMA table_info(login_items)').all()).map(c => c.name));
  for (const [column,type] of [['sms_requested_at','INTEGER'],['sms_state','TEXT'],['position','INTEGER NOT NULL DEFAULT 0']]) {
    if (!loginColumns.has(column)) await db.exec(`ALTER TABLE login_items ADD COLUMN ${column} ${type}`);
  }
}
