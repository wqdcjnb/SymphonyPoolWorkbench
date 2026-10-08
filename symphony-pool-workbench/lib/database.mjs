import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const transactions = new AsyncLocalStorage();
const sqliteQueues = new Map();
const postgresPools = new Map();
const TRANSACTION_LOCK = 73180421;

function numericInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("DATABASE_INTEGER_OUT_OF_RANGE");
  return number;
}

// Only the application's SQL goes through this adapter; values remain bound parameters.
export function postgresSql(input) {
  let sql = input.replace(/PRAGMA\s+(?:journal_mode|busy_timeout|foreign_keys)\s*=\s*[^;]+;?/gi, "")
    .replace(/PRAGMA\s+defer_foreign_keys\s*=\s*ON;?/gi, "SET CONSTRAINTS ALL DEFERRED;")
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "BIGSERIAL PRIMARY KEY")
    .replace(/\bINTEGER\b/gi, "BIGINT")
    .replace(/\browid\b/gi, "_row_order")
    .replace(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(/gi,
      "CREATE TABLE IF NOT EXISTS $1 (_row_order BIGSERIAL UNIQUE, ")
    .replace(/REFERENCES\s+(\w+\s*\(\w+\))(\s+ON DELETE (?:CASCADE|SET NULL|RESTRICT))?(?!\s+DEFERRABLE)/gi,
      "REFERENCES $1$2 DEFERRABLE INITIALLY IMMEDIATE")
    .replace(/\bAS\s+([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*)\b/g, 'AS "$1"')
    .replace(/\bWHEN\s+\?\s+THEN/gi, "WHEN ? <> 0 THEN");
  const ignoredInsert = /\bINSERT OR IGNORE\b/i.test(sql);
  sql = sql.replace(/\bINSERT OR IGNORE\b/gi, "INSERT");
  if (ignoredInsert) sql = sql.replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
  let output = "", quote = null, comment = false, index = 0;
  for (let cursor = 0; cursor < sql.length; cursor++) {
    const character = sql[cursor];
    if (comment) {
      output += character;
      if (character === "\n") comment = false;
    } else if (quote) {
      output += character;
      if (character === quote) {
        if (sql[cursor + 1] === quote) output += sql[++cursor];
        else quote = null;
      }
    } else if (character === "'" || character === '"') {
      quote = character; output += character;
    } else if (character === "-" && sql[cursor + 1] === "-") {
      comment = true; output += character;
    } else output += character === "?" ? `$${++index}` : character;
  }
  return output;
}

async function sqliteExclusive(key, action) {
  if (transactions.getStore()?.key === key) return action();
  const previous = sqliteQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  sqliteQueues.set(key, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (sqliteQueues.get(key) === current) sqliteQueues.delete(key);
  }
}

export async function openDatabase(source) {
  if (typeof source !== "string" || !source) throw new Error("DATABASE_LOCATION_REQUIRED");
  const postgres = /^postgres(?:ql)?:\/\//.test(source);
  const key = postgres ? source : path.resolve(source);
  let sqlite, shared;
  if (postgres) {
    shared = postgresPools.get(key);
    if (!shared) {
      const pool = new pg.Pool({ connectionString: source, max: 20, idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
        types: { getTypeParser: (oid, format) => oid === 20 ? numericInteger : pg.types.getTypeParser(oid, format) } });
      // Do not emit connection strings, credentials, SQL values, or server error details.
      pool.on("error", () => console.error("DATABASE_IDLE_CONNECTION_FAILED"));
      shared = { pool, users: 0 };
      postgresPools.set(key, shared);
    }
    shared.users++;
  } else {
    fs.mkdirSync(path.dirname(key), { recursive: true });
    sqlite = new DatabaseSync(key);
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }
  let closed = false;
  const query = async (sql, parameters, kind) => {
    if (closed) throw new Error("DATABASE_CLOSED");
    const values = parameters.map(value => value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
    const context = transactions.getStore();
    if (!postgres) return sqliteExclusive(key, () => {
      const connection = context?.key === key ? context.sqlite : sqlite;
      if (kind === "exec") { connection.exec(sql); return; }
      return connection.prepare(sql)[kind](...values);
    });
    const connection = context?.key === key ? context.client : shared.pool;
    const info = sql.trim().match(/^PRAGMA\s+table_info\((\w+)\)\s*;?$/i);
    let translated = info ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position"
      : postgresSql(sql);
    if (!translated.trim()) return kind === "all" ? [] : undefined;
    const generatedId = kind === "run" && /^\s*INSERT INTO video_api_(?:batches|turns)\b/i.test(translated);
    if (generatedId) translated = translated.replace(/;?\s*$/, " RETURNING id");
    const run = () => connection.query(translated, info ? [info[1]] : values);
    const result = context?.key === key
      ? await (context.queries = (context.queries || Promise.resolve()).then(run)) : await run();
    if (kind === "get") return result.rows[0];
    if (kind === "all") return result.rows;
    if (kind === "run") return { changes: result.rowCount, lastInsertRowid: generatedId ? result.rows[0]?.id : undefined };
  };
  return {
    kind: postgres ? "postgres" : "sqlite",
    exec: sql => query(sql, [], "exec"),
    prepare: sql => ({
      get: (...values) => query(sql, values, "get"),
      all: (...values) => query(sql, values, "all"),
      run: (...values) => query(sql, values, "run"),
    }),
    async transaction(action) {
      const current = transactions.getStore();
      if (current?.key === key) return action();
      if (!postgres) return sqliteExclusive(key, async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const result = await transactions.run({ key, sqlite }, action);
          sqlite.exec("COMMIT");
          return result;
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      });
      const client = await shared.pool.connect();
      try {
        await client.query("BEGIN");
        // Short write transactions serialize decisions about account/group capacity.
        // Browser operations and network requests must never run inside this transaction.
        await client.query("SELECT pg_advisory_xact_lock($1)", [TRANSACTION_LOCK]);
        const result = await transactions.run({ key, client }, action);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (postgres) {
        if (--shared.users === 0) {
          postgresPools.delete(key);
          await shared.pool.end();
        }
      } else await sqliteExclusive(key, () => sqlite.close());
    },
  };
}
