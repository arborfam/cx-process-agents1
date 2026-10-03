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

-- Незмінний результат смислової перевірки агента 2 (3b-2). Один запис на запуск; після вставки не змінюється й не видаляється.
-- outcome: clear / awaiting_analyst — завершена перевірка; unsupported — підтверджена непідтримувана нотація (без виклику моделі);
-- stale — результат застарів, поки працювала модель (генерацію не дозволяє). Стан запуску (run.technical_state) не розширюємо
-- (його CHECK у наявних базах змінити без перебудови таблиці неможливо): 'done' = запуск завершено, а «очікує рішення» — це outcome.
CREATE TABLE IF NOT EXISTS bpmn_review (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id),
  case_id TEXT NOT NULL REFERENCES "case"(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('clear','awaiting_analyst','unsupported','stale')),
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  approval_id TEXT NOT NULL REFERENCES approval(id),
  content_hash TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  instruction_version TEXT NOT NULL,
  instruction_hash TEXT NOT NULL,
  client_mode TEXT NOT NULL,
  client_model TEXT NOT NULL,
  response_json TEXT,
  findings_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  attempts_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

-- Незмінне рішення аналітикині щодо знахідки агента 2 (3b-3, D31). Лише «відхилено» з обов'язковим поясненням:
-- «уточнити AS-IS» рішенням не є (це нова версія AS-IS, і вона проходить звичайний шлях погодження).
-- Прив'язка: конкретна знахідка (finding_key = хеш її змісту) у конкретному записі перевірки, запуску, погодженні, версії й хеші пакета.
CREATE TABLE IF NOT EXISTS finding_resolution (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  review_id TEXT NOT NULL REFERENCES bpmn_review(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  approval_id TEXT NOT NULL REFERENCES approval(id),
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  content_hash TEXT NOT NULL,
  finding_key TEXT NOT NULL,
  finding_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('rejected')),
  explanation TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  UNIQUE (review_id, finding_key)
);

-- Незмінний артефакт схеми (3b-4). Файли зберігаються лише коли їхня власна перевірка пройшла:
-- status='ok' → є перевірений .bpmn; drawio_status='ok' → є ще й перевірений .drawio (інакше .bpmn лишається чинним).
-- status='blocked'/'unsupported'/'verification_failed' → файлів немає, лишається пояснення; погодження AS-IS не змінюється (D21).
CREATE TABLE IF NOT EXISTS bpmn_artifact (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  review_id TEXT NOT NULL REFERENCES bpmn_review(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  approval_id TEXT NOT NULL REFERENCES approval(id),
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  content_hash TEXT NOT NULL,
  process_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','blocked','unsupported','verification_failed')),
  bpmn_xml TEXT,
  bpmn_sha256 TEXT,
  drawio_status TEXT NOT NULL CHECK (drawio_status IN ('ok','failed','none')),
  drawio_xml TEXT,
  drawio_sha256 TEXT,
  map_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  generator TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

-- Погоджений короткий підпис початкової події (D88). Повний тригер при цьому НЕ змінюється: він лишається
-- у змісті версії, потрапляє в деталі події обох файлів і показується людині поруч зі схемою.
-- Запис незмінний і прив'язаний до конкретної версії та її хеша: для іншої версії він не діє.
CREATE TABLE IF NOT EXISTS start_label (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  content_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  full_trigger_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

-- Виправлення помилково позначеного походження джерела (D77). Сам рядок таблиці source НЕ переписується:
-- виправлення — окремий незмінний запис, а чинне походження обчислюється як останнє виправлення (інакше — збережене).
-- Дозволений напрям лише real -> synthetic і лише для уточнень: послабити захист D18 цим шляхом неможливо.
CREATE TABLE IF NOT EXISTS source_origin_correction (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  question_id TEXT,
  from_origin TEXT NOT NULL CHECK (from_origin IN ('real')),
  to_origin TEXT NOT NULL CHECK (to_origin IN ('synthetic')),
  reason TEXT NOT NULL,
  corrected_by TEXT NOT NULL,
  corrected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES "case"(id),
  subject TEXT NOT NULL,
  explanation TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  content_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_application (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decision(id),
  case_id TEXT NOT NULL REFERENCES "case"(id),
  version_id TEXT NOT NULL REFERENCES as_is_version(id),
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created','confirmed','edited','superseded')),
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_case ON decision(case_id);
CREATE INDEX IF NOT EXISTS idx_decision_app ON decision_application(decision_id);
CREATE INDEX IF NOT EXISTS idx_origin_correction_case ON source_origin_correction(case_id);
CREATE INDEX IF NOT EXISTS idx_source_case ON source(case_id, seq);
CREATE INDEX IF NOT EXISTS idx_version_case ON as_is_version(case_id, number);
`;

const IMMUTABLE_TABLES = ['source', 'as_is_version', 'version_acceptance', 'approval', 'approval_revocation', 'audit_log', 'bpmn_review', 'finding_resolution', 'bpmn_artifact', 'source_origin_correction', 'start_label', 'decision_application'];

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
  // Резерв бюджету: під час запуску — найгірша оцінка; для запуску з невідомою вартістю резерв лишається назавжди.
  ['run', 'reserved_usd', 'REAL NOT NULL DEFAULT 0'],
  ['run', 'cost_known', 'INTEGER NOT NULL DEFAULT 1'],
  // Контракт відповіді агента 1 (D80): 'full' — повна версія щоразу, 'delta' — лише нові й змінені елементи.
  // Старі записи читаються як 'full' — саме за цим контрактом вони й виконувались.
  ['run', 'output_contract', "TEXT NOT NULL DEFAULT 'full'"],
  // Підстава відповіді на питання (D93). Три РІЗНІ ознаки, які не можна зводити одна до одної:
  //  • `derived_from_source_id` + `derived_quote` — походження інформації: з якого джерела й який саме фрагмент;
  //  • `edited_by` — авторство редакції: хто змінив текст джерела (null = взято дослівно);
  //  • `content_type` — тип змісту: що це за твердження за своєю природою.
  // Редагування цитати НЕ перетворює відповідь на власний висновок: зв'язок із джерелом зберігається.
  ['source', 'derived_from_source_id', 'TEXT'],
  ['source', 'derived_quote', 'TEXT'],
  ['source', 'edited_by', 'TEXT'],
  ['source', 'content_type', 'TEXT'],
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
