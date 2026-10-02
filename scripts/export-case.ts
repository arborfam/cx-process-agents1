/**
 * Експорт ОДНОГО синтетичного кейсу з журналом спроб — для розбору якості (лише читання).
 *
 *   node --import tsx scripts/export-case.ts --list            [--db шлях]
 *   node --import tsx scripts/export-case.ts --case <ID>       [--db шлях] [--out файл.json]
 *
 * Що робить скрипт — і чого НЕ робить:
 *  • відкриває базу лише для читання (PRAGMA query_only), нічого не міняє, міграцій не виконує;
 *  • експортує один кейс: джерела (текст), усі версії AS-IS із зазначенням, хто їх створив, запуски агента (модель, інструкція,
 *    токени, вартість, спроби, порушення, перевірки), журнал дій, погодження, а також смислові перевірки агента 2
 *    (знахідки, попередження, збережену відповідь моделі, спроби) і рішення аналітикині щодо знахідок;
 *  • НЕ читає ключ API, код доступу, змінні середовища й інші кейси; усі тексти проходять через редагування ключів;
 *  • відмовляє, якщо в кейсі є джерела з позначкою «реальні» (рішення D18: реальні дані ніде не копіюються);
 *  • відмовляє, якщо у виведенні знайдено щось схоже на ключ.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { redact } from '../src/ai/redact.ts';

type Row = Record<string, unknown>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface ExportResult { ok: true; data: Record<string, unknown>; counts: Record<string, number> }
export interface ExportRefusal { ok: false; reason: string }

const KEY_LIKE = /sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/;

/** Рекурсивно редагує всі рядки. */
function clean<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as T;
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) as T;
  return v;
}

const parse = (s: unknown): unknown => { try { return JSON.parse(String(s)); } catch { return s; } };

export function listCases(db: DatabaseSync): Row[] {
  return db.prepare(`SELECT c.id, c.title, c.state, c.scenario_id, c.scenario_stage, c.created_at,
      (SELECT COUNT(*) FROM as_is_version v WHERE v.case_id = c.id) AS versions,
      (SELECT COUNT(*) FROM run r WHERE r.case_id = c.id) AS runs,
      (SELECT COUNT(*) FROM source s WHERE s.case_id = c.id AND COALESCE(
         (SELECT k.to_origin FROM source_origin_correction k WHERE k.source_id = s.id ORDER BY k.rowid DESC LIMIT 1),
         s.origin) = 'real') AS real_sources
    FROM "case" c ORDER BY c.created_at DESC`).all() as Row[];
}

export function exportCase(db: DatabaseSync, caseId: string): ExportResult | ExportRefusal {
  const c = db.prepare('SELECT * FROM "case" WHERE id = ?').get(caseId) as Row | undefined;
  if (!c) return { ok: false, reason: `Кейсу ${caseId} немає в базі.` };
  // Чинне походження враховує виправлення (D77): рядок джерела не переписується, тож читаємо так само, як продукт.
  const sources = db.prepare(`SELECT s.*, COALESCE(
      (SELECT k.to_origin FROM source_origin_correction k WHERE k.source_id = s.id ORDER BY k.rowid DESC LIMIT 1),
      s.origin) AS origin
    FROM source s WHERE s.case_id = ? ORDER BY s.seq`).all(caseId) as Row[];
  if (sources.some((s) => s.origin === 'real')) {
    return { ok: false, reason: 'У кейсі є джерела з позначкою «реальні». Реальні дані не експортуються (рішення D18). Експорт не виконано.' };
  }
  const versions = (db.prepare('SELECT * FROM as_is_version WHERE case_id = ? ORDER BY number').all(caseId) as Row[]).map((v) => ({
    number: v.number, id: v.id, parent_id: v.parent_id, kind: v.kind, created_by: v.created_by, actor_name: v.actor_name, mode: v.mode,
    run_id: v.run_id, note: v.note, created_at: v.created_at, content_hash: v.content_hash,
    covered_source_ids: parse(v.covered_json), analyst_owned_keys: parse(v.owned_json), content: parse(v.content_json),
  }));
  const runs = (db.prepare('SELECT * FROM run WHERE case_id = ? ORDER BY started_at, rowid').all(caseId) as Row[]).map((r) => ({
    id: r.id, agent: r.agent, mode: r.mode, model: r.model, instruction_version: r.instruction_version, instruction_hash: r.instruction_hash,
    output_contract: r.output_contract ?? 'full',   // старі записи виконувались за повним контрактом (D80)
    base_version_id: r.base_version_id, output_version_id: r.output_version_id, input_source_ids: parse(r.input_source_ids_json),
    scenario_stage: r.scenario_stage, technical_state: r.technical_state, started_at: r.started_at, finished_at: r.finished_at,
    duration_ms: r.duration_ms, attempts: r.attempts, usage: parse(r.usage_json), cost_usd: r.cost_usd, reserved_usd: r.reserved_usd, cost_known: r.cost_known,
    error: r.error, violations: parse(r.violations_json), checks: parse(r.checks_json), note: r.note,
  }));
  const audit = (db.prepare('SELECT id, at, actor, action, details_json FROM audit_log WHERE case_id = ? ORDER BY id').all(caseId) as Row[])
    .map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, details: parse(a.details_json) }));
  const approvals = db.prepare('SELECT id, version_id, content_hash, approver, note, created_at FROM approval WHERE case_id = ? ORDER BY rowid').all(caseId) as Row[];
  const revocations = db.prepare('SELECT r.* FROM approval_revocation r JOIN approval a ON a.id = r.approval_id WHERE a.case_id = ?').all(caseId) as Row[];
  const acceptance = db.prepare('SELECT a.* FROM version_acceptance a JOIN as_is_version v ON v.id = a.version_id WHERE v.case_id = ?').all(caseId) as Row[];
  // Смислова перевірка (агент 2): крім метаданих — ЗНАХІДКИ, попередження й збережена відповідь моделі.
  // Без них розібрати блокер побудови неможливо (D83). Усе проходить те саме редагування ключів, що й решта.
  const hasReviews = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bpmn_review'").get();
  const reviews = hasReviews ? (db.prepare('SELECT * FROM bpmn_review WHERE case_id = ? ORDER BY rowid').all(caseId) as Row[]).map((r) => ({
    id: r.id, run_id: r.run_id, outcome: r.outcome, version_id: r.version_id, approval_id: r.approval_id,
    content_hash: r.content_hash, content_fingerprint: r.content_fingerprint,
    instruction_version: r.instruction_version, instruction_hash: r.instruction_hash,
    client_mode: r.client_mode, client_model: r.client_model, created_at: r.created_at, record_hash: r.record_hash,
    findings: parse(r.findings_json), warnings: parse(r.warnings_json), attempts: parse(r.attempts_json),
    detail: parse(r.detail_json),
    /** Дослівна прийнята відповідь моделі: саме з неї відновлюються знахідки під час повторної перевірки. */
    response: parse(r.response_json),
  })) : [];
  // Рішення аналітикині щодо знахідок (незмінні записи): без них видно знахідку, але не те, що з нею зробила людина.
  const hasResolutions = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finding_resolution'").get();
  const resolutions = hasResolutions ? (db.prepare('SELECT * FROM finding_resolution WHERE case_id = ? ORDER BY rowid').all(caseId) as Row[]).map((r) => ({
    id: r.id, review_id: r.review_id, run_id: r.run_id, approval_id: r.approval_id, version_id: r.version_id,
    content_hash: r.content_hash, finding_key: r.finding_key, finding: parse(r.finding_json), decision: r.decision,
    explanation: r.explanation, decided_by: r.decided_by, decided_at: r.decided_at, record_hash: r.record_hash,
  })) : [];

  const data = clean({
    export_format: 1,
    exported_at: new Date().toISOString(),
    note: 'Експорт одного синтетичного кейсу для розбору якості. Ключів, коду доступу й інших кейсів тут немає.',
    case: { id: c.id, title: c.title, state: c.state, mode: c.mode, scenario_id: c.scenario_id, scenario_stage: c.scenario_stage, created_at: c.created_at, head_version_id: c.head_version_id },
    sources: sources.map((s) => ({ id: s.id, ref: s.ref, seq: s.seq, kind: s.kind, title: s.title, origin: s.origin, author: s.author, read_status: s.read_status, added_at: s.added_at, content_hash: s.content_hash, content: s.content })),
    versions, runs, audit, approvals, approval_revocations: revocations, version_acceptance: acceptance,
    bpmn_reviews: reviews, finding_resolutions: resolutions,
  });
  if (KEY_LIKE.test(JSON.stringify(data))) return { ok: false, reason: 'У виведенні знайдено щось схоже на ключ доступу. Експорт скасовано, файл не створено.' };
  return { ok: true, data, counts: { sources: sources.length, versions: versions.length, runs: runs.length, audit: audit.length,
    reviews: reviews.length, findings: reviews.reduce((n, r) => n + (Array.isArray(r.findings) ? r.findings.length : 0), 0), resolutions: resolutions.length } };
}

function main(): void {
  const dbPath = arg('--db') ?? process.env.CX_DB_PATH ?? 'data/cx.sqlite';
  if (!existsSync(dbPath)) { console.error(`Базу не знайдено: ${dbPath}. Вкажіть --db <шлях>.`); process.exit(2); }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
  try {
    if (process.argv.includes('--list')) {
      const rows = listCases(db);
      if (rows.length === 0) console.log('Кейсів немає.');
      for (const r of rows) console.log(`${r.id}  | ${r.title} | стан: ${r.state} | сценарій: ${r.scenario_id ?? '—'} (етап ${r.scenario_stage ?? '—'}) | версій: ${r.versions}, запусків: ${r.runs}${Number(r.real_sources) > 0 ? ' | УВАГА: є «реальні» джерела — експорт заблоковано' : ''}`);
      return;
    }
    const id = arg('--case');
    if (!id) { console.error('Вкажіть --list або --case <ID>.'); process.exit(2); }
    const r = exportCase(db, id);
    if (!r.ok) { console.error(r.reason); process.exit(3); }
    const out = arg('--out') ?? `export-${id}.json`;
    writeFileSync(out, JSON.stringify(r.data, null, 1) + '\n', 'utf8');
    console.log(`Готово: ${out}`);
    console.log(`Джерел: ${r.counts.sources}, версій: ${r.counts.versions}, запусків: ${r.counts.runs}, записів журналу: ${r.counts.audit}.`);
    console.log(`Смислових перевірок: ${r.counts.reviews} (знахідок: ${r.counts.findings}), рішень щодо знахідок: ${r.counts.resolutions}.`);
    console.log('У файлі немає ключа API й коду доступу. Базу не змінено.');
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop()!)) main();
