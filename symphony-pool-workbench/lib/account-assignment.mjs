const nodeOrder = new Intl.Collator('en', { numeric: true });

export async function listAccountWorkers(database, now = Date.now()) {
  const workers = await database.prepare(`SELECT w.id,w.capacity,w.heartbeat_at AS heartbeatAt,w.enabled,
    (SELECT COUNT(*) FROM accounts a WHERE a.worker_id=w.id) AS accountCount
    FROM pool_workers w ORDER BY w.id`).all();
  return workers.map(worker => ({ ...worker, accountCount: Number(worker.accountCount),
    online: Boolean(worker.enabled && worker.heartbeatAt > now - 60_000) }));
}

// Read counts and insert the planned accounts in the same database transaction.
// Counts include every persisted account, irrespective of platform or login status.
export function planAccountAssignments(workers, count) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('INVALID_ACCOUNT_LIST');
  const candidates = workers.filter(worker => worker.online).map(worker => ({ ...worker }));
  if (!candidates.length) throw new Error('NO_AVAILABLE_WORKER');
  return Array.from({ length: count }, () => {
    candidates.sort((a, b) => a.accountCount - b.accountCount
      || nodeOrder.compare(a.id, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const chosen = candidates[0];
    chosen.accountCount += 1;
    return chosen.id;
  });
}
