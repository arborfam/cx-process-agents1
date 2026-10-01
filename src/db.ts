import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

/**
 * Усе спілкування з базою починається тут (D5): якщо node:sqlite зміниться,
 * достатньо замінити цей модуль.
 *
 * Незмінні таблиці захищені тригерами: UPDATE/DELETE відхиляються самою базою.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "case" (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('research','pending_approval','approved','bpmn_review','done')),
  head_version_id TEXT,
  mode TEXT NOT NULL,
  is_demo_script INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request','transcript','document','analyst_note','clarification')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('real','synthetic','demo_script')),
  required INTEGER NOT NULL DEFAULT 0,
  read_status TEXT NOT NULL CHECK (read_status IN ('ok','error','partial')),
  read_error TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS as_is_version (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  number INTEGER NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('head_line','proposal')),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  covered_json TEXT NOT NULL,
  owned_json TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('analyst','agent','demo_script')),
  actor_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  run_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (case_id, number)
);

CREATE TABLE IF NOT EXISTS version_acceptance (
  version_id TEXT PRIMARY KEY REFERENCES as_is_version(id),
  accepted_by TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  content_hash TEXT NOT NULL,
  approver TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_revocation (
  approval_id TEXT PRIMARY KEY REFERENCES approval(id),
  reason TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  agent TEXT NOT NULL CHECK (agent IN ('analyst','bpmn')),
  instruction_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  base_version_id TEXT,
  input_approval_id TEXT,
  input_source_ids_json TEXT NOT NULL DEFAULT '[]',
  technical_state TEXT NOT NULL CHECK (technical_state IN ('queued','running','done','error','not_implemented')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  output_version_id TEXT,
  checks_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_source_case ON source(case_id, seq);
CREATE INDEX IF NOT EXISTS idx_version_case ON as_is_version(case_id, number);
`;

const IMMUTABLE_TABLES = ['source', 'as_is_version', 'version_acceptance', 'approval', 'approval_revocation', 'audit_log'];

function immutabilityTriggers(): string {
  return IMMUTABLE_TABLES.map(
    (t) => `
CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT, 'Таблиця ${t} незмінна: оновлення заборонені'); END;
CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
BEGIN SELECT RAISE(ABORT, 'Таблиця ${t} незмінна: видалення заборонені'); END;`,
  ).join('\n');
}

export const IMMUTABLE_TABLE_NAMES = IMMUTABLE_TABLES;

/**
 * Додаткові колонки зрізу 2. Додаються до наявних баз без втрати даних (ALTER TABLE … ADD COLUMN
 * не змінює й не видаляє записів і не спрацьовує на тригери незмінності).
 */
const ADDED_COLUMNS: [string, string, string][] = [
  ['case', 'scenario_id', 'TEXT'],
  ['case', 'scenario_stage', 'INTEGER NOT NULL DEFAULT 0'],
  ['source', 'ref', 'TEXT'],
  ['run', 'usage_json', "TEXT NOT NULL DEFAULT '{}'"],
  ['run', 'duration_ms', 'INTEGER'],
  ['run', 'cost_usd', 'REAL'],
  ['run', 'attempts', 'INTEGER NOT NULL DEFAULT 1'],
  ['run', 'instruction_hash', 'TEXT'],
  ['run', 'scenario_stage', 'INTEGER'],
  ['run', 'violations_json', "TEXT NOT NULL DEFAULT '[]'"],
];

export function migrate(db: DB): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(immutabilityTriggers());
  return db;
}

const depth = new WeakMap<DB, number>();

/** Транзакція: або все збережено, або нічого. Вкладені виклики приєднуються до зовнішньої. */
export function tx<T>(db: DB, fn: () => T): T {
  if ((depth.get(db) ?? 0) > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

type SqlValue = string | number | bigint | null | Uint8Array;

export function one<T>(db: DB, sql: string, ...params: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function all<T>(db: DB, sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function run(db: DB, sql: string, ...params: SqlValue[]): void {
  db.prepare(sql).run(...params);
}
