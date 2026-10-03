import { randomUUID } from 'node:crypto';
import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import { canonical, sha256 } from './hash.ts';
import { CAUSE_STATUS_LABEL, CLAIM_TYPE_LABEL, ContentSchema, LINK_KIND_LABEL, NOTATION_KIND_LABEL, NotationKind, UNKNOWN, emptyContent, parseContent, type Content, type LinkKindT, type NotationRequirementT, type Question, type Step, type StepProposalT } from './schema.ts';
import { findQuote } from './ai/quote.ts';
import { parseProblems, parseRoles, parseSteps, problemsToText, rolesToText, stepsToText } from './text-format.ts';

// ───────────────────────── типи ─────────────────────────

export type CaseState = 'research' | 'pending_approval' | 'approved' | 'bpmn_review' | 'done';

export const STATE_LABEL: Record<CaseState, string> = {
  research: 'Дослідження',
  pending_approval: 'На погодженні',
  approved: 'AS-IS погоджено',
  bpmn_review: 'BPMN на перевірці',
  done: 'Завершено',
};

export interface Actor {
  kind: 'human' | 'agent' | 'system';
  name: string;
}

export interface CaseRow {
  id: string;
  title: string;
  state: CaseState;
  head_version_id: string | null;
  mode: string;
  is_demo_script: number;
  scenario_id: string | null;
  scenario_stage: number;
  created_at: string;
}

export interface SourceRow {
  id: string;
  case_id: string;
  seq: number;
  kind: string;
  title: string;
  content: string;
  content_hash: string;
  author: string;
  origin: 'real' | 'synthetic' | 'demo_script';
  required: number;
  read_status: 'ok' | 'error' | 'partial';
  read_error: string | null;
  added_at: string;
  /** Стабільний ідентифікатор для людей і моделі (SRC-01…); для звичайних джерел немає. */
  ref: string | null;
  /** Походження інформації: джерело кейсу, на яке спирається це уточнення (null — власний висновок аналітикині). */
  derived_from_source_id: string | null;
  /** Точний фрагмент джерела, узятий за основу. Лишається й тоді, коли текст відредаговано. */
  derived_quote: string | null;
  /** Авторство редакції: хто змінив текст джерела. null — текст узято дослівно. */
  edited_by: string | null;
  /** Тип змісту. Редагування цитати НЕ робить її власним висновком. */
  content_type: AnswerContentType | null;
}

/**
 * Тип змісту уточнення. Зберігається окремо від походження інформації й від авторства редакції,
 * бо це три різні ознаки: «звідки факт», «хто правив текст» і «чим це твердження є».
 */
export type AnswerContentType = 'source_quote' | 'source_quote_edited' | 'analyst_confirmed';

/**
 * Підписи для показу. У базі зберігається лише код (`content_type`), тож зміна підпису не змінює
 * збережені дані, хеші й погодження. Формулювання нейтральні щодо статі: конкретний автор
 * зберігається окремо, у полі `edited_by`, і показується в метаданих (D100).
 */
export const ANSWER_CONTENT_TYPE_LABEL: Record<AnswerContentType, string> = {
  source_quote: 'З джерела, дослівно',
  source_quote_edited: 'З джерела, відредаговано користувачем',
  analyst_confirmed: 'Підтверджений висновок користувача',
};

export interface VersionRow {
  id: string;
  case_id: string;
  number: number;
  parent_id: string | null;
  kind: 'head_line' | 'proposal';
  content_json: string;
  content_hash: string;
  covered_json: string;
  owned_json: string;
  created_by: 'analyst' | 'agent' | 'demo_script';
  actor_name: string;
  mode: string;
  run_id: string | null;
  note: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  case_id: string;
  version_id: string;
  content_hash: string;
  approver: string;
  note: string;
  created_at: string;
}

export interface Blocker {
  code: string;
  severity: 'critical' | 'warning';
  message: string;
  ref?: string;
}

const now = (): string => new Date().toISOString();
const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

// ───────────────────────── службові ─────────────────────────

export function requireHuman(actor: Actor, what: string): void {
  if (actor.kind !== 'human') {
    throw new DomainError('FORBIDDEN', `Дію «${what}» може виконати лише людина. Агент або система не мають на це права.`, 403);
  }
}

export function audit(db: DB, caseId: string | null, actor: Actor, action: string, details: unknown = {}): void {
  run(db, 'INSERT INTO audit_log (case_id, at, actor, action, details_json) VALUES (?,?,?,?,?)',
    caseId, now(), `${actor.kind}:${actor.name}`, action, JSON.stringify(details));
}

export function getCase(db: DB, caseId: string): CaseRow {
  const c = one<CaseRow>(db, 'SELECT * FROM "case" WHERE id = ?', caseId);
  if (!c) throw new DomainError('NOT_FOUND', 'Кейс не знайдено', 404);
  return c;
}

export function getVersion(db: DB, versionId: string): VersionRow {
  const v = one<VersionRow>(db, 'SELECT * FROM as_is_version WHERE id = ?', versionId);
  if (!v) throw new DomainError('NOT_FOUND', 'Версію не знайдено', 404);
  return v;
}

export function headVersion(db: DB, caseId: string): VersionRow {
  const c = getCase(db, caseId);
  if (!c.head_version_id) throw new DomainError('NOT_FOUND', 'У кейсу немає версій', 404);
  return getVersion(db, c.head_version_id);
}

/**
 * Джерела кейсу з ЧИННИМ походженням: якщо для джерела є виправлення (D77), береться воно, інакше — збережене.
 * Рядок таблиці `source` при цьому не переписується: виправлення живе окремим незмінним записом.
 * Усі перевірки D18 («реальні дані моделі не надсилаються») читають джерела саме звідси, тож чинне
 * походження діє скрізь одночасно.
 */
export function listSources(db: DB, caseId: string): SourceRow[] {
  return all<SourceRow>(db,
    `SELECT s.*, COALESCE(
       (SELECT c.to_origin FROM source_origin_correction c WHERE c.source_id = s.id ORDER BY c.rowid DESC LIMIT 1),
       s.origin) AS origin
     FROM source s WHERE s.case_id = ? ORDER BY s.seq`, caseId);
}

/** Чи було виправлено походження цього джерела (для показу в інтерфейсі й журналі). */
export function originCorrections(db: DB, caseId: string): OriginCorrectionRow[] {
  return all<OriginCorrectionRow>(db, 'SELECT * FROM source_origin_correction WHERE case_id = ? ORDER BY rowid', caseId);
}

export interface OriginCorrectionRow {
  id: string; case_id: string; source_id: string; question_id: string | null;
  from_origin: 'real'; to_origin: 'synthetic'; reason: string; corrected_by: string; corrected_at: string;
}

export function versionContent(v: VersionRow): Content {
  return parseContent(JSON.parse(v.content_json));
}

export function isAccepted(db: DB, versionId: string): boolean {
  return !!one(db, 'SELECT 1 AS x FROM version_acceptance WHERE version_id = ?', versionId);
}

export function currentApproval(db: DB, caseId: string): ApprovalRow | undefined {
  return one<ApprovalRow>(
    db,
    `SELECT a.* FROM approval a
       LEFT JOIN approval_revocation r ON r.approval_id = a.id
      WHERE a.case_id = ? AND r.approval_id IS NULL
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    caseId,
  );
}

function setState(db: DB, caseId: string, state: CaseState): void {
  run(db, 'UPDATE "case" SET state = ? WHERE id = ?', state, caseId);
}

function revokeCurrentApproval(db: DB, caseId: string, actor: Actor, reason: string): void {
  const a = currentApproval(db, caseId);
  if (a) {
    run(db, 'INSERT INTO approval_revocation (approval_id, reason, revoked_by, revoked_at) VALUES (?,?,?,?)',
      a.id, reason, `${actor.kind}:${actor.name}`, now());
    audit(db, caseId, actor, 'approval_superseded', { approval_id: a.id, version_id: a.version_id, reason });
  }
}

/**
 * Нове джерело чи зміна змісту після передачі на погодження повертають кейс до «Дослідження».
 * Чинне погодження позначається скасованим (запис лишається в історії).
 */
function fallBackToResearch(db: DB, caseId: string, actor: Actor, reason: string): void {
  const c = getCase(db, caseId);
  if (c.state === 'research') return;
  revokeCurrentApproval(db, caseId, actor, reason);
  setState(db, caseId, 'research');
  audit(db, caseId, actor, 'state_changed', { from: c.state, to: 'research', reason });
}

// ───────────────────────── версії ─────────────────────────

export function computeVersionHash(db: DB, contentJson: string, coveredIds: string[]): string {
  const covered = coveredIds.map((id) => {
    const s = one<{ content_hash: string }>(db, 'SELECT content_hash FROM source WHERE id = ?', id);
    return { id, hash: s?.content_hash ?? 'MISSING' };
  });
  return sha256(canonical({ content: JSON.parse(contentJson), covered }));
}

/** Перераховує хеш із бази й порівнює із записаним: виявляє підміну змісту чи джерел. */
export function verifyVersionIntegrity(db: DB, versionId: string): boolean {
  const v = getVersion(db, versionId);
  return computeVersionHash(db, v.content_json, JSON.parse(v.covered_json) as string[]) === v.content_hash;
}

interface NewVersion {
  caseId: string;
  content: Content;
  createdBy: VersionRow['created_by'];
  actorName: string;
  parentId: string | null;
  covered: string[];
  owned: string[];
  runId?: string | null;
  kind?: 'head_line' | 'proposal';
  note?: string;
  /** Режим запуску, що створив версію (за замовчуванням — режим кейсу). */
  mode?: string;
}

/** Єдине місце створення версій. Зміст перевіряється схемою до запису. */
export function insertVersion(db: DB, n: NewVersion): VersionRow {
  const content = ContentSchema.parse(n.content);
  const c = getCase(db, n.caseId);
  const max = one<{ m: number | null }>(db, 'SELECT MAX(number) AS m FROM as_is_version WHERE case_id = ?', n.caseId);
  const number = (max?.m ?? 0) + 1;
  const contentJson = JSON.stringify(content);
  const covered = [...new Set(n.covered)];
  const id = newId('ver');
  run(db,
    `INSERT INTO as_is_version (id, case_id, number, parent_id, kind, content_json, content_hash, covered_json, owned_json,
       created_by, actor_name, mode, run_id, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, n.caseId, number, n.parentId, n.kind ?? 'head_line', contentJson,
    computeVersionHash(db, contentJson, covered), JSON.stringify(covered), JSON.stringify([...new Set(n.owned)]),
    n.createdBy, n.actorName, n.mode ?? c.mode, n.runId ?? null, n.note ?? '', now());
  return getVersion(db, id);
}

function setHead(db: DB, caseId: string, versionId: string): void {
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', versionId, caseId);
}

// Ключі «власності»: що саме аналітик змінював власноруч. Агент не перезаписує такі елементи.
function contentKeys(c: Content): Map<string, string> {
  const m = new Map<string, string>();
  m.set('summary', c.summary);
  m.set('business_context', c.business_context);
  for (const k of ['trigger', 'input', 'completion', 'result'] as const) m.set(`boundaries.${k}`, c.boundaries[k]);
  m.set('roles', canonical(c.roles));
  m.set('entry_step_id', c.entry_step_id ?? '');
  // «немає поля» і «порожньо» — одне й те саме («не зазначено»): старі версії без цих полів не дають хибних відмінностей
  m.set('process_name', c.process_name ?? '');
  m.set('notation_requirements', canonical(c.notation_requirements ?? []));
  for (const s of c.steps) m.set(`step:${s.id}`, canonical(s));
  for (const p of c.problems) m.set(`problem:${p.id}`, canonical(p));
  return m;
}

export function changedKeys(a: Content, b: Content): string[] {
  const ka = contentKeys(a);
  const kb = contentKeys(b);
  const keys = new Set([...ka.keys(), ...kb.keys()]);
  return [...keys].filter((k) => ka.get(k) !== kb.get(k));
}

function pretty(v: string | undefined): string {
  return v === undefined || v === '' ? '(немає)' : v;
}

/**
 * Захист правок аналітика від агента. Якщо агент змінив або видалив «власний» елемент аналітика,
 * зберігається значення аналітика, а обидва варіанти записуються як конфлікт (спец. §5, п. 9).
 * Також агент не може знизити критичність питання чи закрити його без наявного джерела.
 */
export function protectAnalystEdits(
  base: Content,
  out: Content,
  owned: Set<string>,
  validSourceIds: Set<string>,
): { content: Content; conflicts: Content['conflicts'] } {
  const result: Content = structuredClone(out);
  const conflicts: Content['conflicts'] = [...out.conflicts];
  const baseKeys = contentKeys(base);
  const outKeys = contentKeys(out);

  for (const key of changedKeys(base, out)) {
    if (!owned.has(key)) continue;
    conflicts.push({
      key,
      kept: pretty(baseKeys.get(key)),
      proposed: pretty(outKeys.get(key)),
      note: 'Агент змінив елемент, який редагувала аналітикиня. Збережено варіант аналітикині.',
    });
    if (key === 'summary') result.summary = base.summary;
    else if (key === 'business_context') result.business_context = base.business_context;
    else if (key.startsWith('boundaries.')) {
      // Ключі конфліктів беруться з переліку вище (рядок із `['trigger', 'input', 'completion', 'result']`).
      // `trigger_short` там навмисно немає: це пропозиція агента, а не зміст, який редагує аналітикиня,
      // і на схему вона потрапляє лише через окреме погодження підпису.
      const f = key.slice('boundaries.'.length) as 'trigger' | 'input' | 'completion' | 'result';
      result.boundaries[f] = base.boundaries[f];
    } else if (key === 'roles') result.roles = [...base.roles];
    else if (key === 'entry_step_id') {
      if (base.entry_step_id === undefined) delete result.entry_step_id;
      else result.entry_step_id = base.entry_step_id;
    }
    else if (key.startsWith('step:')) {
      const id = key.slice(5);
      const baseIdx = base.steps.findIndex((s) => s.id === id);
      result.steps = result.steps.filter((s) => s.id !== id);
      if (baseIdx >= 0) result.steps.splice(Math.min(baseIdx, result.steps.length), 0, structuredClone(base.steps[baseIdx]!));
    } else if (key.startsWith('problem:')) {
      const id = key.slice(8);
      const baseIdx = base.problems.findIndex((p) => p.id === id);
      result.problems = result.problems.filter((p) => p.id !== id);
      if (baseIdx >= 0) result.problems.splice(Math.min(baseIdx, result.problems.length), 0, structuredClone(base.problems[baseIdx]!));
    }
  }

  for (const bq of base.questions) {
    let oq = result.questions.find((q) => q.id === bq.id);
    if (!oq) {
      result.questions.push(structuredClone(bq));
      conflicts.push({ key: `question:${bq.id}`, kept: bq.text, proposed: '(видалено)', note: 'Агент не може видаляти питання.' });
      continue;
    }
    // Прив'язка питання до потоку — його блокувальний зміст. Доки питання відкрите, агент не може її зняти,
    // перекласифікувати чи перенести: наявні прив'язки (разом із історією виправлень) зберігаються, додавати нові можна.
    // Змінити їх може аналітикиня явним рішенням (relinkQuestion, з поясненням в link_history) або закриття питання відповіддю з джерела.
    const closesValidly = oq.status === 'closed' && !!oq.closed_by_source_id && validSourceIds.has(oq.closed_by_source_id);
    if (bq.status === 'open' && !closesValidly) {
      const kept = structuredClone(bq.affects_transitions ?? []);
      const key = (l: { step_id: string; condition: string; kind?: string }) => canonical({ s: l.step_id, c: l.condition, k: l.kind ?? 'direction' });
      const outLinks = oq.affects_transitions ?? [];
      const lost = kept.filter((l) => !outLinks.some((o) => key(o) === key(l)));
      const historyChanged = canonical(oq.link_history ?? null) !== canonical(bq.link_history ?? null);
      if (lost.length > 0 || historyChanged) {
        const extra = outLinks.filter((o) => !kept.some((l) => key(l) === key(o)) && !kept.some((l) => l.step_id === o.step_id && l.condition === o.condition));
        // щось зняли/перенесли — зміну відхиляємо цілком; лише додавання нових прив'язок (без втрат) лишається
        oq.affects_transitions = lost.length > 0 || historyChanged ? kept : [...kept, ...extra];
        if (oq.affects_transitions.length === 0) delete oq.affects_transitions;
        if (bq.link_history === undefined) delete oq.link_history; else oq.link_history = structuredClone(bq.link_history);
        conflicts.push({ key: `question:${bq.id}.link`, kept: 'прив’язка до потоку без змін', proposed: 'знято, перекласифіковано чи перенесено',
          note: 'Прив’язку відкритого питання до потоку агент не змінює: це блокувальний зміст. Змінити її може аналітикиня з поясненням або закриття питання відповіддю з джерела.' });
      }
    }
    // Прив'язку, яку аналітикиня ЯВНО зняла (запис в історії без `to`, D82), агент не відновлює — ні цією
    // відповіддю, ні пізнішою: інакше явне рішення людини тихо скасовувалось би наступним запуском.
    {
      const unlinked = new Set((bq.link_history ?? []).filter((h) => h.to === undefined).map((h) => `${h.step_id}\u0000${h.condition}`));
      if (unlinked.size > 0) {
        const back = (oq.affects_transitions ?? []).filter((a) => unlinked.has(`${a.step_id}\u0000${a.condition}`));
        if (back.length > 0) {
          oq.affects_transitions = (oq.affects_transitions ?? []).filter((a) => !unlinked.has(`${a.step_id}\u0000${a.condition}`));
          if (oq.affects_transitions.length === 0) delete oq.affects_transitions;
          conflicts.push({ key: `question:${bq.id}.link`, kept: 'прив’язку знято аналітикинею',
            proposed: back.map((a) => `крок ${a.step_id}${a.condition ? ` («${a.condition}»)` : ''}`).join('; '),
            note: 'Агент повернув прив’язку, яку аналітикиня явно зняла. Її рішення збережено; якщо прив’язка потрібна, це окреме рішення аналітикині.' });
        }
      }
    }
    if (bq.critical && !oq.critical) {
      oq.critical = true;
      conflicts.push({ key: `question:${bq.id}.critical`, kept: 'критичне', proposed: 'некритичне',
        note: 'Знизити критичність може лише аналітик із поясненням.' });
    }
    if (bq.status === 'open' && oq.status === 'closed' && !(oq.closed_by_source_id && validSourceIds.has(oq.closed_by_source_id))) {
      oq = Object.assign(oq, { status: 'open' as const, answer: bq.answer, closed_by_source_id: null });
      conflicts.push({ key: `question:${bq.id}.status`, kept: 'відкрите', proposed: 'закрите без джерела',
        note: 'Питання закривається лише за наявності джерела відповіді.' });
    }
  }
  // Пропозиції щодо кроків: наявні (особливо вирішені аналітикинею) агент не змінює й не видаляє; додає лише нові зі статусом «proposed».
  {
    const baseP = base.step_proposals ?? [];
    const outP = result.step_proposals ?? [];
    const merged = baseP.map((b) => structuredClone(b));
    for (const b of baseP) {
      const o = outP.find((x) => x.id === b.id);
      if (!o) conflicts.push({ key: `proposal:${b.id}`, kept: `${b.action} ${b.step_id} (${b.status})`, proposed: '(видалено)', note: 'Агент не може прибрати наявну пропозицію.' });
      else if (canonical(o) !== canonical(b)) conflicts.push({ key: `proposal:${b.id}`, kept: `${b.action} ${b.step_id} (${b.status})`, proposed: `${o.action} ${o.step_id} (${o.status})`, note: 'Агент змінив наявну пропозицію; збережено попередній стан. Рішення приймає аналітикиня.' });
    }
    for (const o of outP) if (!baseP.some((b) => b.id === o.id)) merged.push(o);
    if (merged.length) result.step_proposals = merged; else delete result.step_proposals;
  }
  // Початковий крок — межа процесу, а не висновок агента: будь-яку його зміну агентом відкидаємо, незалежно від «власності».
  if ((out.entry_step_id ?? null) !== (base.entry_step_id ?? null)) {
    conflicts.push({ key: 'entry_step_id', kept: pretty(base.entry_step_id ?? ''), proposed: pretty(out.entry_step_id ?? ''),
      note: 'Початковий крок (межу процесу) задає лише аналітикиня. Агент може поставити питання, але не обирає початок. Збережено попереднє значення.' });
    if (base.entry_step_id === undefined) delete result.entry_step_id; else result.entry_step_id = base.entry_step_id;
  }
  // Назву процесу задає лише людина (D62): будь-яку зміну агентом відкидаємо, незалежно від «власності».
  if ((out.process_name ?? '') !== (base.process_name ?? '')) {
    conflicts.push({ key: 'process_name', kept: pretty(base.process_name), proposed: pretty(out.process_name),
      note: 'Назву процесу задає лише аналітикиня (вона входить у погодження). Збережено її варіант.' });
    if (base.process_name === undefined) delete result.process_name; else result.process_name = base.process_name;
  }
  // Вимоги до нотації (D61): наявні (особливо підтверджені людиною) агент не змінює й не видаляє; нові — лише «proposed» від агента.
  {
    const baseN = base.notation_requirements ?? [];
    const outN = result.notation_requirements ?? [];
    const label = (r: NotationRequirementT): string => `${NOTATION_KIND_LABEL[r.kind]} · крок ${r.step_id} (${r.status})`;
    const merged = baseN.map((b) => structuredClone(b));
    for (const b of baseN) {
      const o = outN.find((x) => x.id === b.id);
      if (!o) conflicts.push({ key: `notation:${b.id}`, kept: label(b), proposed: '(видалено)', note: 'Агент не може прибрати вимогу до нотації.' });
      else if (canonical(o) !== canonical(b)) conflicts.push({ key: `notation:${b.id}`, kept: label(b), proposed: label(o), note: 'Агент змінив наявну вимогу до нотації; збережено попередній стан. Рішення приймає аналітикиня.' });
    }
    for (const o of outN) {
      if (baseN.some((b) => b.id === o.id)) continue;
      const fixed: NotationRequirementT = { ...o, origin: 'agent', status: 'proposed', decided_by: '', decision_note: '' };
      if (o.origin !== 'agent' || o.status !== 'proposed' || o.decided_by || o.decision_note) {
        conflicts.push({ key: `notation:${o.id}`, kept: `${label(fixed)}`, proposed: label(o), note: 'Агент не підтверджує вимог до нотації: пропозицію збережено як «proposed».' });
      }
      merged.push(fixed);
    }
    if (merged.length) result.notation_requirements = merged; else delete result.notation_requirements;
  }
  // Гіпотези аналітика: текст і спосіб перевірки агент не переписує (статус і докази може оновлювати).
  for (const bh of base.hypotheses) {
    if (bh.author !== 'analyst') continue;
    const oh = result.hypotheses.find((h) => h.id === bh.id);
    if (!oh) continue;
    if (oh.text !== bh.text || oh.check_method !== bh.check_method) {
      conflicts.push({ key: `hypothesis:${bh.id}`, kept: bh.text, proposed: oh.text,
        note: 'Агент змінив гіпотезу аналітикині. Збережено її формулювання; статус і докази агент може оновлювати.' });
      oh.text = bh.text;
      oh.check_method = bh.check_method;
    }
    if (oh.author !== 'analyst') oh.author = 'analyst';
  }
  // «Невідоме не стає фактом»: доки питання про перехід відкрите, агент не може підмінити «невідомо» встановленим переходом.
  for (const bq of base.questions) {
    if (bq.status !== 'open') continue;
    const rq = result.questions.find((q) => q.id === bq.id);
    if (!rq || rq.status !== 'open') continue;
    for (const a of bq.affects_transitions ?? []) {
      const bt = base.steps.find((s) => s.id === a.step_id)?.next.find((n) => n.condition === a.condition);
      const rt = result.steps.find((s) => s.id === a.step_id)?.next.find((n) => n.condition === a.condition);
      if (bt && bt.to === UNKNOWN && rt && rt.to !== UNKNOWN) {
        conflicts.push({ key: `transition:${a.step_id}:${a.condition}`, kept: 'невідомо', proposed: rt.to,
          note: `Питання ${bq.id} відкрите: невідомий перехід не може стати встановленим без відповіді.` });
        rt.to = UNKNOWN;
      }
    }
  }
  result.conflicts = conflicts;
  return { content: result, conflicts };
}

// ───────────────────────── кейси та джерела ─────────────────────────

export function createCase(db: DB, actor: Actor, title: string, mode: string, opts: { demoScript?: boolean; scenarioId?: string } = {}): CaseRow {
  requireHuman(actor, 'створення кейсу');
  const t = title.trim();
  if (!t) throw new DomainError('VALIDATION', 'Назва кейсу не може бути порожньою', 400);
  return tx(db, () => {
    const id = newId('case');
    run(db, 'INSERT INTO "case" (id, title, state, head_version_id, mode, is_demo_script, created_at, scenario_id, scenario_stage) VALUES (?,?,?,?,?,?,?,?,?)',
      id, t, 'research', null, mode, opts.demoScript ? 1 : 0, now(), opts.scenarioId ?? null, 0);
    const v = insertVersion(db, {
      caseId: id, content: emptyContent(), createdBy: 'analyst', actorName: actor.name,
      parentId: null, covered: [], owned: [], note: 'Порожня початкова версія',
    });
    setHead(db, id, v.id);
    audit(db, id, actor, 'case_created', { title: t, mode });
    return getCase(db, id);
  });
}

export interface NewSource {
  kind: SourceRow['kind'];
  title: string;
  content: string;
  origin?: SourceRow['origin'];
  required?: boolean;
  readStatus?: SourceRow['read_status'];
  readError?: string | null;
  ref?: string | null;
  derivedFromSourceId?: string | null;
  derivedQuote?: string | null;
  editedBy?: string | null;
  contentType?: AnswerContentType | null;
}

export function addSource(db: DB, actor: Actor, caseId: string, s: NewSource): SourceRow {
  requireHuman(actor, 'додавання джерела');
  const title = s.title.trim();
  if (!title) throw new DomainError('VALIDATION', 'Назва джерела не може бути порожньою', 400);
  const status = s.readStatus ?? 'ok';
  if (status === 'ok' && !s.content.trim()) throw new DomainError('VALIDATION', 'Текст джерела порожній', 400);
  return tx(db, () => {
    getCase(db, caseId);
    const seqRow = one<{ m: number | null }>(db, 'SELECT MAX(seq) AS m FROM source WHERE case_id = ?', caseId);
    const id = newId('src');
    run(db,
      `INSERT INTO source (id, case_id, seq, kind, title, content, content_hash, author, origin, required, read_status, read_error, added_at, ref,
                           derived_from_source_id, derived_quote, edited_by, content_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, caseId, (seqRow?.m ?? 0) + 1, s.kind, title, s.content, sha256(s.content), actor.name,
      s.origin ?? 'real', s.required ? 1 : 0, status, s.readError ?? null, now(), s.ref ?? null,
      s.derivedFromSourceId ?? null, s.derivedQuote ?? null, s.editedBy ?? null, s.contentType ?? null);
    audit(db, caseId, actor, 'source_added', { source_id: id, ref: s.ref ?? null, kind: s.kind, read_status: status, required: !!s.required });
    fallBackToResearch(db, caseId, actor, 'new_source');
    return one<SourceRow>(db, 'SELECT * FROM source WHERE id = ?', id)!;
  });
}

const READABLE_EXT = ['.txt', '.md'];

/** Читання файлу: невдале читання не приховується — джерело зберігається зі статусом error. */
export function addSourceFromFile(
  db: DB, actor: Actor, caseId: string,
  f: { name: string; bytes: Uint8Array; kind: SourceRow['kind']; required?: boolean; origin?: SourceRow['origin'] },
): SourceRow {
  const lower = f.name.toLowerCase();
  let text = '';
  let error: string | null = null;
  if (!READABLE_EXT.some((e) => lower.endsWith(e))) {
    error = `Формат файлу не підтримується у першій версії (потрібно ${READABLE_EXT.join(' або ')}).`;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes);
      if (!text.trim()) error = 'Файл порожній.';
    } catch {
      error = 'Файл не вдалося прочитати як текст UTF-8.';
    }
  }
  return addSource(db, actor, caseId, {
    kind: f.kind, title: f.name, content: error ? '' : text, origin: f.origin, required: f.required,
    readStatus: error ? 'error' : 'ok', readError: error,
  });
}

// ───────────────────────── редагування (людина) ─────────────────────────

export interface EditFields {
  summary?: string;
  business_context?: string;
  boundaries?: Partial<Content['boundaries']>;
  roles_text?: string;
  steps_text?: string;
  problems_text?: string;
  /** Явний початковий крок; null або порожній рядок — зняти. Ніколи не підставляється автоматично. */
  entry_step_id?: string | null;
  /** Назва процесу (D62): входить у зміст, хеш і погодження; зміна створює нову версію. Ніколи не підставляється з назви кейсу. */
  process_name?: string;
}

function assertBase(db: DB, caseId: string, baseVersionId: string): VersionRow {
  const head = headVersion(db, caseId);
  if (head.id !== baseVersionId) {
    throw new DomainError('VERSION_CONFLICT',
      'За цей час з’явилася новіша версія. Оновіть сторінку й повторіть правку; нічого не перезаписано.', 409,
      { head_version_id: head.id });
  }
  return head;
}

function commitAnalystVersion(
  db: DB, actor: Actor, caseId: string, head: VersionRow, content: Content, covered: string[], note: string,
): VersionRow {
  const headContent = versionContent(head);
  const owned = new Set<string>(JSON.parse(head.owned_json) as string[]);
  for (const k of changedKeys(headContent, content)) owned.add(k);
  const v = insertVersion(db, {
    caseId, content, createdBy: 'analyst', actorName: actor.name, parentId: head.id, covered, owned: [...owned], note,
  });
  setHead(db, caseId, v.id);
  audit(db, caseId, actor, 'version_created', { version_id: v.id, number: v.number, by: 'analyst', note });
  fallBackToResearch(db, caseId, actor, 'content_changed');
  return v;
}

/** Правка аналітика створює НОВУ версію; стара не змінюється. */
export function saveAnalystVersion(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; fields: EditFields; coverAllSources?: boolean; note?: string },
): VersionRow {
  requireHuman(actor, 'редагування версії');
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const prev = versionContent(head);
    const f = input.fields;
    const next: Content = structuredClone(prev);
    if (f.summary !== undefined) next.summary = f.summary.trim();
    if (f.business_context !== undefined) next.business_context = f.business_context.trim();
    if (f.boundaries) for (const k of ['trigger', 'input', 'completion', 'result'] as const) {
      const val = f.boundaries[k];
      if (val !== undefined) next.boundaries[k] = val.trim();
    }
    if (f.roles_text !== undefined) next.roles = parseRoles(f.roles_text);
    if (f.steps_text !== undefined) next.steps = parseSteps(f.steps_text, prev.steps);
    if (f.problems_text !== undefined) next.problems = parseProblems(f.problems_text, prev.problems);
    if (f.entry_step_id !== undefined) {
      const e = f.entry_step_id === null ? '' : f.entry_step_id.trim();
      if (e && !next.steps.some((st) => st.id === e)) {
        throw new DomainError('VALIDATION', `Початковий крок «${e}» не існує серед кроків процесу. Спершу додайте крок, потім призначте його початковим.`, 400);
      }
      if (e) next.entry_step_id = e;
      else if (prev.entry_step_id !== undefined) next.entry_step_id = null;   // явне зняття; для старих записів без поля нічого не дописуємо
    }

    if (f.process_name !== undefined) {
      const name = f.process_name.trim();
      if (name.length > 300) throw new DomainError('VALIDATION', 'Назва процесу задовга (понад 300 символів)', 400);
      if (name) next.process_name = name;
      else if (prev.process_name !== undefined) next.process_name = '';   // явне зняття; для старих записів без поля нічого не дописуємо
    }

    let covered: string[] = JSON.parse(head.covered_json) as string[];
    if (input.coverAllSources) {
      covered = listSources(db, caseId).filter((s) => s.read_status === 'ok').map((s) => s.id);
    }
    const contentChanged = changedKeys(prev, next).length > 0;
    const coverChanged = canonical([...covered].sort()) !== canonical((JSON.parse(head.covered_json) as string[]).sort());
    if (!contentChanged && !coverChanged) throw new DomainError('NO_CHANGES', 'Змін немає — нову версію не створено.', 400);
    return commitAnalystVersion(db, actor, caseId, head, next, covered,
      input.note ?? (coverChanged ? 'Правка аналітика; враховано нові матеріали' : 'Правка аналітика'));
  });
}

function nextId(prefix: string, existing: string[]): string {
  let n = 1;
  while (existing.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Питання ставить аналітик явно (у зрізі 1 виявлення питань агентом немає). */
export function addQuestion(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; text: string; critical: boolean; impact: string; addressee?: string; affects?: { step_id: string; condition: string; kind?: LinkKindT }[] },
): VersionRow {
  requireHuman(actor, 'постановка питання');
  if (!input.text.trim()) throw new DomainError('VALIDATION', 'Текст питання порожній', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const affects = input.affects ?? [];
    for (const a of affects) {
      const tr = c.steps.find((s) => s.id === a.step_id)?.next.find((n) => n.condition === a.condition);
      if (!tr) throw new DomainError('VALIDATION', `У кроці ${a.step_id} немає переходу ${condText(a.condition)}`, 400);
      // Питання про перехід одразу робить його «невідомим»: інакше опис би стверджував факт, який ще не з’ясовано.
      tr.to = UNKNOWN;
    }
    c.questions.push({
      id: nextId('Q', c.questions.map((q) => q.id)), text: input.text.trim(), critical: input.critical,
      impact: input.impact.trim(), addressee: (input.addressee ?? '').trim(), status: 'open', answer: '',
      closed_by_source_id: null, origin: 'analyst', criticality_note: '',
      ...(affects.length ? { affects_transitions: affects.map((a) => ({ step_id: a.step_id, condition: a.condition, ...(a.kind ? { kind: a.kind } : {}) })) } : {}),
    });
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Додано ${input.critical ? 'критичне ' : ''}питання`);
  });
}

/** Уточнення = нове джерело (автор і дата) + нова версія, де питання закрите з посиланням на це джерело. */
/**
 * Підстава відповіді на питання (D93). Питання про фактичний AS-IS закривається лише тим, що
 * спирається на джерело або на явно заявлений підтверджений висновок аналітикині.
 * Бажаного варіанта процесу тут немає навмисно: пропозиції живуть у `claims` типу
 * `improvement_proposal` і в `step_proposals` — вони опису фактів не закривають.
 */
export type AnswerBasis =
  | { kind: 'source'; sourceId: string; quote: string; edited: boolean }
  | { kind: 'analyst_confirmed'; note: string; acknowledgedFactual?: boolean };

export function answerQuestion(
  db: DB, actor: Actor, caseId: string,
  input: {
    baseVersionId: string; questionId: string; answer: string;
    origin?: 'real' | 'synthetic';
    basis: AnswerBasis;
    /**
     * Куди ведуть переходи, що були «невідомими» через це питання (D97).
     * Закриття питання й оновлення пов'язаних кроків — ОДИН пакет: інакше відповідь лишає
     * людині прихований обов'язок окремо лагодити переходи, а опис тимчасово суперечить сам собі.
     */
    transitions?: { step_id: string; condition: string; to: string }[];
  },
): VersionRow {
  requireHuman(actor, 'відповідь на питання');
  if (!input.answer.trim()) throw new DomainError('VALIDATION', 'Текст уточнення порожній', 400);
  const basis = input.basis;
  if (!basis || (basis.kind !== 'source' && basis.kind !== 'analyst_confirmed')) {
    throw new DomainError('VALIDATION',
      'Вкажіть підставу відповіді: фрагмент джерела або власний підтверджений висновок. Бажаний варіант процесу питання про фактичний AS-IS не закриває — запишіть його як пропозицію покращення.', 400);
  }
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const q = c.questions.find((x) => x.id === input.questionId);
    if (!q) throw new DomainError('NOT_FOUND', 'Питання не знайдено', 404);
    if (q.status === 'closed') throw new DomainError('VALIDATION', 'Питання вже закрите', 400);

    const answer = input.answer.trim();
    let origin: 'real' | 'synthetic';
    let derivedFromSourceId: string | null = null;
    let derivedQuote: string | null = null;
    let editedBy: string | null = null;
    let contentType: AnswerContentType;

    if (basis.kind === 'source') {
      const src = one<SourceRow>(db, 'SELECT * FROM source WHERE id = ? AND case_id = ?', basis.sourceId, caseId);
      if (!src) throw new DomainError('NOT_FOUND', 'Джерело, на яке ви посилаєтесь, у цьому кейсі не знайдено', 404);
      if (src.read_status !== 'ok') {
        throw new DomainError('VALIDATION', `Джерело «${src.title}» не прочитано повністю, тому спиратися на нього не можна.`, 400);
      }
      const quote = (basis.quote ?? '').trim();
      if (!quote) throw new DomainError('VALIDATION', 'Укажіть фрагмент джерела, на який спирається відповідь.', 400);
      const m = findQuote(src.content, quote);
      if (m.kind === 'not_found') {
        throw new DomainError('QUOTE_NOT_FOUND', `Цього фрагмента немає в джерелі «${src.title}». Підставою може бути лише те, що в джерелі справді написано.`, 400);
      }
      derivedFromSourceId = src.id;
      derivedQuote = quote;
      // Редагування НЕ перетворює відповідь на власний висновок: зв'язок із джерелом зберігається,
      // а редакція позначається окремо. Авторство редакції й походження інформації — різні ознаки.
      const edited = basis.edited || answer !== quote;
      contentType = edited ? 'source_quote_edited' : 'source_quote';
      if (edited) editedBy = actor.name;
      // Походження матеріалу успадковується від джерела: дослівна цитата нічого нового не вносить.
      // Але якщо текст відредаговано, а джерело синтетичне, у відповіді могли з'явитися справжні дані —
      // тоді походження підтверджує людина явно (хибне «синтетичне» відправило б реальні дані моделі).
      if (!edited || src.origin === 'real') {
        origin = src.origin === 'real' ? 'real' : 'synthetic';
      } else {
        if (input.origin !== 'real' && input.origin !== 'synthetic') {
          throw new DomainError('VALIDATION',
            'Текст цитати змінено, а джерело синтетичне. Підтвердьте походження відредагованого тексту: «синтетичне» чи «реальні дані». Реальні дані моделі не надсилаються (D18).', 400);
        }
        origin = input.origin;
      }
    } else {
      const note = (basis.note ?? '').trim();
      if (!note) {
        throw new DomainError('VALIDATION', 'Для власного висновку вкажіть, на чому він ґрунтується.', 400);
      }
      // Критичне питання про фактичний AS-IS не закривається мовчазним «я так вважаю»:
      // потрібне явне твердження, що це встановлений факт, а не бажаний варіант процесу.
      if (q.critical && basis.acknowledgedFactual !== true) {
        throw new DomainError('FACTUAL_BASIS_REQUIRED',
          'Це критичне питання про фактичний процес. Щоб закрити його власним висновком, підтвердьте, що описуєте встановлений факт, а не бажаний або запланований варіант. Інакше спирайтесь на фрагмент джерела.', 400);
      }
      if (input.origin !== 'real' && input.origin !== 'synthetic') {
        throw new DomainError('VALIDATION',
          'Вкажіть походження уточнення: «синтетичне» (вигадане для навчального прикладу) або «реальні дані» (з роботи з людьми). Реальні дані моделі не надсилаються (D18).', 400);
      }
      origin = input.origin;
      contentType = 'analyst_confirmed';
      derivedQuote = note;
    }

    const src = addSource(db, actor, caseId, {
      kind: 'clarification', title: `Уточнення до ${q.id} (${actor.name})`, content: answer,
      origin, derivedFromSourceId, derivedQuote, editedBy, contentType,
    });
    q.status = 'closed';
    q.answer = answer;
    q.closed_by_source_id = src.id;

    // Той самий пакет: переходи, які були «невідомими» саме через це питання.
    const applied: { step_id: string; condition: string; to: string }[] = [];
    for (const t of input.transitions ?? []) {
      const st = c.steps.find((x) => x.id === t.step_id);
      if (!st) throw new DomainError('NOT_FOUND', `Кроку ${t.step_id} у цій версії немає.`, 404);
      const link = (q.affects_transitions ?? []).some((l) => l.step_id === t.step_id && l.condition === t.condition);
      if (!link) {
        throw new DomainError('VALIDATION',
          `Перехід «${t.condition || 'без умови'}» кроку ${t.step_id} не прив'язаний до питання ${q.id}: у цьому пакеті його змінювати не можна.`, 400);
      }
      const n = st.next.find((x) => x.condition === t.condition && x.to === UNKNOWN);
      if (!n) {
        throw new DomainError('VALIDATION',
          `Перехід «${t.condition || 'без умови'}» кроку ${t.step_id} уже не «невідомий» — оновіть сторінку.`, 409);
      }
      const to = t.to.trim();
      if (to !== 'END' && !c.steps.some((x) => x.id === to)) {
        throw new DomainError('VALIDATION', `Кроку ${to} у цій версії немає: перехід нікуди не веде.`, 400);
      }
      n.to = to;
      applied.push({ step_id: t.step_id, condition: t.condition, to });
    }
    const covered = [...(JSON.parse(head.covered_json) as string[]), src.id];
    audit(db, caseId, actor, 'question_answered', {
      question_id: q.id, critical: q.critical, source_id: src.id,
      content_type: contentType, derived_from_source_id: derivedFromSourceId, edited_by: editedBy, origin,
      transitions: applied,
    });
    return commitAnalystVersion(db, actor, caseId, head, c, covered,
      applied.length
        ? `Закрито питання ${q.id} уточненням; визначено переходів: ${applied.length}`
        : `Закрито питання ${q.id} уточненням`);
  });
}

// ───────── виправлення помилково позначеного походження уточнень (D77) ─────────

export interface OriginCorrectionCandidate {
  source_id: string;
  question_id: string | null;
  title: string;
  added_at: string;
  from_origin: 'real';
  to_origin: 'synthetic';
  /** Початок тексту уточнення — щоб людина побачила, що саме перекласифіковує. */
  content_preview: string;
}

export interface OriginCorrectionPreview {
  case_id: string;
  sources: OriginCorrectionCandidate[];
  /** Підтвердження саме цього набору: для іншого набору чи іншого стану воно не підходить. */
  confirm_token: string;
}

/** Уточнення, прив'язане до питання: шукаємо у ВСІХ версіях кейсу (питання могло закритись у будь-якій). */
function clarificationQuestionIds(db: DB, caseId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of all<{ content_json: string }>(db, 'SELECT content_json FROM as_is_version WHERE case_id = ? ORDER BY number', caseId)) {
    for (const q of (JSON.parse(v.content_json) as Content).questions) {
      if (q.closed_by_source_id) out.set(q.closed_by_source_id, q.id);
    }
  }
  return out;
}

/**
 * Що саме буде перекласифіковано. Нічого не змінює.
 *
 * У перегляд потрапляють ЛИШЕ джерела, які одночасно: належать цьому кейсу, мають вид «уточнення»,
 * чинне походження «реальні дані» і (якщо названо питання) закривають саме ці питання. Звичайні джерела
 * — інтерв'ю, документи, запити — сюди не потрапляють ніколи: цей шлях веде лише в бік «синтетичні»
 * і лише для уточнень, тож послабити захист D18 ним неможливо.
 */
export function previewOriginCorrection(
  db: DB, caseId: string, filter: { questionIds?: string[]; sourceIds?: string[] } = {},
): OriginCorrectionPreview {
  getCase(db, caseId);
  const byQuestion = clarificationQuestionIds(db, caseId);
  const wantQ = filter.questionIds ? new Set(filter.questionIds) : null;
  const wantS = filter.sourceIds ? new Set(filter.sourceIds) : null;
  const sources: OriginCorrectionCandidate[] = [];
  for (const s of listSources(db, caseId)) {
    if (s.kind !== 'clarification' || s.origin !== 'real') continue;
    const qid = byQuestion.get(s.id) ?? null;
    if (wantQ && (!qid || !wantQ.has(qid))) continue;
    if (wantS && !wantS.has(s.id)) continue;
    sources.push({
      source_id: s.id, question_id: qid, title: s.title, added_at: s.added_at,
      from_origin: 'real', to_origin: 'synthetic',
      content_preview: s.content.length > 200 ? s.content.slice(0, 199) + '…' : s.content,
    });
  }
  // Підтвердження прив'язане до кейсу й ТОЧНОГО набору джерел: для іншого набору воно не підійде.
  const confirm_token = sha256(canonical({ case: caseId, sources: sources.map((x) => x.source_id).sort() }));
  return { case_id: caseId, sources, confirm_token };
}

export interface OriginCorrectionResult {
  corrected: { source_id: string; question_id: string | null; title: string }[];
}

/**
 * Застосовує виправлення після явного підтвердження показаного набору.
 *
 * Що зберігається без змін: текст уточнення, його хеш, назва, порядок, прив'язка до питання, усі версії
 * AS-IS та їхні хеші, погодження. Нової версії не створюється — змінюється лише позначка походження,
 * і то окремим незмінним записом: рядок у таблиці джерел не переписується.
 */
export function applyOriginCorrection(
  db: DB, actor: Actor, caseId: string,
  input: { questionIds?: string[]; sourceIds?: string[]; confirmToken: string; reason: string },
): OriginCorrectionResult {
  requireHuman(actor, 'виправлення походження джерела');
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new DomainError('VALIDATION', 'Вкажіть причину виправлення: вона зберігається в журналі.', 400);
  return tx(db, () => {
    const preview = previewOriginCorrection(db, caseId, { questionIds: input.questionIds, sourceIds: input.sourceIds });
    if (!input.confirmToken || input.confirmToken !== preview.confirm_token) {
      throw new DomainError('CONFIRM_REQUIRED',
        'Спершу перегляньте перелік уточнень, які буде перекласифіковано, і підтвердьте саме його. Якщо перелік змінився, підтвердження від попереднього перегляду не діє.', 409);
    }
    if (preview.sources.length === 0) {
      throw new DomainError('NOT_CORRECTABLE',
        'Серед названих немає жодного уточнення з позначкою «реальні дані». Виправляти нічого: звичайні джерела цим шляхом не перекласифіковуються.', 409);
    }
    const at = now();
    for (const c of preview.sources) {
      run(db,
        `INSERT INTO source_origin_correction (id, case_id, source_id, question_id, from_origin, to_origin, reason, corrected_by, corrected_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        newId('scorr'), caseId, c.source_id, c.question_id, 'real', 'synthetic', reason, actor.name, at);
    }
    audit(db, caseId, actor, 'source_origin_corrected', {
      source_ids: preview.sources.map((x) => x.source_id), question_ids: preview.sources.map((x) => x.question_id),
      from: 'real', to: 'synthetic', reason,
    });
    return { corrected: preview.sources.map((x) => ({ source_id: x.source_id, question_id: x.question_id, title: x.title })) };
  });
}

/** Зміна критичності — лише з поясненням аналітика. Це не замінює встановлення факту. */
export function setQuestionCritical(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; questionId: string; critical: boolean; note: string },
): VersionRow {
  requireHuman(actor, 'зміна критичності');
  if (!input.note.trim()) throw new DomainError('VALIDATION', 'Зміна критичності потребує пояснення аналітика', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const q = c.questions.find((x) => x.id === input.questionId);
    if (!q) throw new DomainError('NOT_FOUND', 'Питання не знайдено', 404);
    q.critical = input.critical;
    q.criticality_note = input.note.trim();
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Змінено критичність ${q.id}: ${input.note.trim()}`);
  });
}

/**
 * Явне виправлення помилкової прив'язки питання до потоку (аналітикиня). Створює НОВУ версію з записом в історії прив'язки (хто, коли,
 * з якого виду на який, чому). Питання лишається ВІДКРИТИМ, його критичність і текст не змінюються; змінюється лише вид ОДНІЄЇ прив'язки.
 * Масового чи автоматичного відкріплення немає. Справжній невідомий перехід так «виправити» не можна (це приховало б невідоме).
 */
export function relinkQuestion(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; questionId: string; stepId: string; condition: string; toKind: LinkKindT; note: string },
): VersionRow {
  requireHuman(actor, 'виправлення прив’язки питання');
  if (!LINK_KIND_LABEL[input.toKind]) throw new DomainError('VALIDATION', 'Невідомий вид прив’язки', 400);
  const note = (input.note ?? '').trim();
  if (note.length < 5) throw new DomainError('VALIDATION', 'Поясніть, чому прив’язку змінено (обов’язково)', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const q = c.questions.find((x) => x.id === input.questionId);
    if (!q) throw new DomainError('NOT_FOUND', 'Питання не знайдено', 404);
    if (q.status !== 'open') throw new DomainError('QUESTION_CLOSED', 'Прив’язку можна виправляти лише в відкритого питання', 409);
    const link = (q.affects_transitions ?? []).find((a) => a.step_id === input.stepId && a.condition === input.condition);
    if (!link) throw new DomainError('LINK_NOT_FOUND', 'Такої прив’язки в питання немає', 404);
    const from = linkKindOf(link);
    if (from === input.toKind) throw new DomainError('VALIDATION', 'Прив’язка вже має такий вид', 400);
    const tr = c.steps.find((s) => s.id === input.stepId)?.next.find((n) => n.condition === input.condition);
    if (input.toKind !== 'step_detail' && !tr) throw new DomainError('LINK_BROKEN', 'Перехід, до якого прив’язано питання, у кроці не знайдено', 409);
    if (tr?.to === UNKNOWN && (from === 'direction' || input.toKind !== 'direction')) {
      throw new DomainError('TRANSITION_UNKNOWN', 'Перехід справді невідомий: питання про його напрямок не можна перетворити на інше, це приховало б невідоме. Спершу з’ясуйте напрямок.', 409);
    }
    if (input.toKind === 'direction' && tr && tr.to !== UNKNOWN) {
      throw new DomainError('LINK_TARGET_KNOWN', 'Перехід записано як відомий: або позначте його «невідомо», або оберіть інший вид прив’язки.', 409);
    }
    link.kind = input.toKind;
    q.link_history = [...(q.link_history ?? []), { at: now(), by: actor.name, step_id: input.stepId, condition: input.condition, from, to: input.toKind, note }];
    audit(db, caseId, actor, 'question_link_changed', { question_id: q.id, step_id: input.stepId, from, to: input.toKind });
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Питання ${q.id}: прив’язку до переходу кроку ${input.stepId} змінено з «${LINK_KIND_LABEL[from]}» на «${LINK_KIND_LABEL[input.toKind]}»: ${note}`);
  });
}

/**
 * Прив'язки ВІДКРИТИХ питань до кроків, яких у описі немає. Типово з'являються після прийнятого вилучення
 * кроку: саме питання лишається потрібним, а його прив'язка вказує в пустоту й стає технічною прогалиною
 * (`QUESTION_LINK_BROKEN`). Нічого не змінює — лише показує; знімає прив'язку тільки людина (D82).
 */
export interface StaleQuestionLink {
  question_id: string;
  question_text: string;
  critical: boolean;
  step_id: string;
  condition: string;
  kind: LinkKindT;
  kind_label: string;
}

export function staleQuestionLinks(c: Content): StaleQuestionLink[] {
  const steps = new Set(c.steps.map((s) => s.id));
  const out: StaleQuestionLink[] = [];
  for (const q of c.questions) {
    if (q.status !== 'open') continue;
    for (const a of q.affects_transitions ?? []) {
      if (steps.has(a.step_id)) continue;
      const kind = linkKindOf(a);
      out.push({ question_id: q.id, question_text: q.text, critical: q.critical, step_id: a.step_id, condition: a.condition, kind, kind_label: LINK_KIND_LABEL[kind] });
    }
  }
  return out;
}

export interface UnlinkPreview {
  question: { id: string; text: string; critical: boolean; status: string; impact: string; addressee: string };
  link: { step_id: string; condition: string; kind: LinkKindT; kind_label: string };
  /** Інші прив'язки цього питання: вони не змінюються. */
  other_links: { step_id: string; condition: string; kind: LinkKindT; kind_label: string; step_exists: boolean }[];
  /** Чи справді кроку немає в описі (інакше дію виконати не можна). */
  step_missing: boolean;
  lines: string[];
  errors: { code: string; message: string }[];
}

const condLabel = (cond: string): string => (cond ? ` («${clipTxt(cond, 40)}»)` : ' (без умови)');

/**
 * Наслідки відкріплення ОДНОЇ прив'язки — показуються ДО підтвердження. Чиста функція: нічого не змінює.
 * Показує саме питання, стару прив'язку, інші прив'язки (вони лишаються) і те, що саме питання не зникає.
 */
export function previewUnlink(c: Content, questionId: string, stepId: string, condition: string): UnlinkPreview {
  const errors: { code: string; message: string }[] = [];
  const q = c.questions.find((x) => x.id === questionId);
  if (!q) {
    return { question: { id: questionId, text: '', critical: false, status: 'unknown', impact: '', addressee: '' },
      link: { step_id: stepId, condition, kind: 'direction', kind_label: LINK_KIND_LABEL.direction }, other_links: [], step_missing: false,
      lines: [], errors: [{ code: 'NOT_FOUND', message: `Питання ${questionId} не знайдено` }] };
  }
  const links = q.affects_transitions ?? [];
  const link = links.find((a) => a.step_id === stepId && a.condition === condition);
  const kind = link ? linkKindOf(link) : 'direction';
  const stepMissing = !c.steps.some((s) => s.id === stepId);
  if (!link) errors.push({ code: 'LINK_NOT_FOUND', message: `У питання ${q.id} немає прив'язки до кроку ${stepId}${condLabel(condition)}` });
  if (q.status !== 'open') errors.push({ code: 'QUESTION_CLOSED', message: `Питання ${q.id} закрите: його прив'язка нічого не блокує, відкріплення не потрібне` });
  if (link && !stepMissing) {
    errors.push({ code: 'STEP_EXISTS', message:
      `Крок ${stepId} у описі Є. Прив'язку чинного кроку так не знімають: якщо питання не про напрямок — змініть ВИД прив'язки; ` +
      'якщо перехід справді невідомий — з’ясуйте напрямок. Відкріпленням невизначений чи непідтверджений перехід приховати не можна.' });
  }
  const other = links.filter((a) => a !== link).map((a) => {
    const k = linkKindOf(a);
    return { step_id: a.step_id, condition: a.condition, kind: k, kind_label: LINK_KIND_LABEL[k], step_exists: c.steps.some((s) => s.id === a.step_id) };
  });
  const lines: string[] = [];
  if (errors.length === 0) {
    lines.push(`Буде знято ЛИШЕ цю прив'язку: крок ${stepId}${condLabel(condition)} — ${LINK_KIND_LABEL[kind]}. Кроку ${stepId} в описі немає.`);
    lines.push(`Питання ${q.id} лишається відкритим${q.critical ? ' і КРИТИЧНИМ' : ' і некритичним'}: текст, вплив, адресат, джерела й критичність не змінюються.`);
    lines.push(other.length
      ? `Інші прив'язки цього питання (${other.length}) не змінюються: ${other.map((o) => `крок ${o.step_id}${condLabel(o.condition)} — ${o.kind_label}`).join('; ')}.`
      : 'Інших прив’язок у цього питання немає.');
    lines.push(`Зникне технічна прогалина «питання ${q.id} стосується кроку ${stepId}, якого в описі немає».`);
    lines.push(q.critical
      ? `Критичне відкрите питання лишається блокером погодження — відкріплення цього не змінює.`
      : 'Питання некритичне: блокером погодження воно й не було.');
    lines.push('Буде створено НОВУ версію з записом в історії прив’язки (хто, коли, від якого кроку, чому). Попередні версії й погодження не переписуються; чинне погодження (якщо є) скасується, кейс повернеться до дослідження.');
  } else {
    for (const e of errors) lines.push(e.message);
  }
  return {
    question: { id: q.id, text: q.text, critical: q.critical, status: q.status, impact: q.impact, addressee: q.addressee },
    link: { step_id: stepId, condition, kind, kind_label: LINK_KIND_LABEL[kind] },
    other_links: other, step_missing: stepMissing, lines, errors,
  };
}

/**
 * Явне рішення аналітикині: ВІДКРІПИТИ питання від кроку, якого в описі немає (D82).
 *
 * Навіщо: після прийнятого вилучення кроку питання лишається потрібним, але його прив'язка вказує в пустоту —
 * і погодження блокує технічна прогалина, яку нічим було прибрати (зміна виду прив'язки відсутнього кроку не
 * лікує: крок однаково відсутній).
 *
 * Межі дії: знімається РІВНО одна названа прив'язка, і лише якщо кроку справді немає. Питання, його текст,
 * вплив, адресат, джерела, ВІДКРИТИЙ статус і КРИТИЧНІСТЬ лишаються; інші прив'язки не змінюються; питання не
 * закривається. Для чинного кроку дія недоступна — інакше нею можна було б приховати невизначений чи
 * непідтверджений перехід. Створюється нова версія; попередні й погодження не переписуються.
 */
export function unlinkQuestionFromMissingStep(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; questionId: string; stepId: string; condition: string; note: string },
): VersionRow {
  requireHuman(actor, 'відкріплення питання від вилученого кроку');
  const note = (input.note ?? '').trim();
  if (note.length < 5) throw new DomainError('VALIDATION', 'Поясніть, чому прив’язку знято (обов’язково)', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const pv = previewUnlink(c, input.questionId, input.stepId, input.condition);
    const err = pv.errors[0];
    if (err) throw new DomainError(err.code, err.message, err.code === 'NOT_FOUND' || err.code === 'LINK_NOT_FOUND' ? 404 : 409, { preview: pv });
    const q = c.questions.find((x) => x.id === input.questionId)!;
    const links = q.affects_transitions ?? [];
    q.affects_transitions = links.filter((a) => !(a.step_id === input.stepId && a.condition === input.condition));
    if (q.affects_transitions.length === 0) delete q.affects_transitions;
    q.link_history = [...(q.link_history ?? []),
      { at: now(), by: actor.name, step_id: input.stepId, condition: input.condition, from: pv.link.kind, note }];
    audit(db, caseId, actor, 'question_unlinked', { question_id: q.id, step_id: input.stepId, condition: input.condition, from: pv.link.kind });
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Питання ${q.id}: знято прив’язку до вилученого кроку ${input.stepId}${condLabel(input.condition)} (${LINK_KIND_LABEL[pv.link.kind]}): ${note}`);
  });
}

// ───────────────────────── пропозиції щодо кроків: наслідки до прийняття ─────────────────────────

export interface ProposalEffects {
  removed: { id: string; action: string }[];
  rewired: { from: string; condition: string; was: string; now: string }[];
  new_unknown: { from: string; condition: string; question_id: string }[];
  /** Цілі переходів вилученого кроку: вони можуть втратити єдиний вхід. */
  orphan_candidates: string[];
  entry: { before: string | null; after: string | null };
  errors: { code: string; message: string }[];
}

const stepLabel = (c: Content, id: string): string => `${id} («${clipTxt(c.steps.find((x) => x.id === id)?.action ?? '', 40)}»)`;

/** Застосовує прийняття однієї пропозиції до змісту (змінює `c`). Одна й та сама логіка для показу наслідків і для справжнього прийняття. */
function applyAccept(c: Content, p: StepProposalT, fx: ProposalEffects): boolean {
  if (!c.steps.some((s) => s.id === p.step_id)) { fx.errors.push({ code: 'STEP_MISSING', message: `Кроку ${p.step_id} у поточній версії вже немає` }); return false; }
  if (p.action === 'replace' && !c.steps.some((s) => s.id === p.replacement_step_id)) {
    fx.errors.push({ code: 'STEP_MISSING', message: `Кроку-заміни ${p.replacement_step_id} немає в поточній версії` }); return false;
  }
  const replacement = p.action === 'replace' ? p.replacement_step_id : null;
  const gone = c.steps.find((s) => s.id === p.step_id)!;
  fx.removed.push({ id: gone.id, action: gone.action });
  for (const n of gone.next) if (n.to !== 'END' && n.to !== UNKNOWN && n.to !== gone.id) fx.orphan_candidates.push(n.to);
  c.steps = c.steps.filter((s) => s.id !== p.step_id);
  for (const s of c.steps) {
    for (const n of s.next) {
      if (n.to !== p.step_id) continue;
      if (replacement && s.id !== replacement) { fx.rewired.push({ from: s.id, condition: n.condition, was: n.to, now: replacement }); n.to = replacement; continue; }
      n.to = UNKNOWN;
      const qid = nextId('Q', c.questions.map((q) => q.id));
      fx.new_unknown.push({ from: s.id, condition: n.condition, question_id: qid });
      c.questions.push({
        id: qid,
        text: `Куди веде перехід ${s.id}${n.condition ? ` (${n.condition})` : ''} після вилучення кроку ${p.step_id}?`,
        critical: true, impact: `Перехід вказував на вилучений крок ${p.step_id}; без відповіді потік процесу невизначений`,
        addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst',
        criticality_note: 'Створено автоматично під час прийняття пропозиції вилучення кроку',
        affects_transitions: [{ step_id: s.id, condition: n.condition, kind: 'direction' }],
      });
    }
  }
  if (c.entry_step_id === p.step_id) { fx.entry.after = replacement ?? null; c.entry_step_id = replacement ?? null; }
  p.status = 'accepted';
  return true;
}

const FLOW_STRUCT_CODES = new Set(['STEP_UNREACHABLE', 'STEP_NO_EXIT', 'ENTRY_BAD_REF', 'ENTRY_MISSING']);

/** Структурні проблеми потоку як окремі пари «код + крок» (для порівняння до/після). */
function flowKeys(c: Content): string[] {
  const out: string[] = [];
  for (const i of flowIssues(c)) {
    if (!FLOW_STRUCT_CODES.has(i.code)) continue;
    for (const ref of (i.ref ?? '').split(',').filter(Boolean)) out.push(`${i.code}:${ref}`);
    if (!i.ref) out.push(i.code);
  }
  return [...new Set(out)].sort();
}

export interface ProposalPreview {
  proposal_ids: string[];
  removed: { id: string; action: string }[];
  rewired: ProposalEffects['rewired'];
  new_unknown: ProposalEffects['new_unknown'];
  entry: { before: string | null; after: string | null; changed: boolean };
  flow_before: string[];
  flow_after: string[];
  resolved: string[];
  introduced: string[];
  /** Проблеми потоку після прийняття, що пов'язані з цією зміною (нові або на кроках, яких вона торкнулась). */
  residual: string[];
  /**
   * Прив'язки ВІДКРИТИХ питань, які після прийняття вказуватимуть на кроки, яких уже не буде (D82).
   * Автоматично нічого не відкріплюється й не закривається: це явне рішення людини після прийняття.
   */
  stale_links: StaleQuestionLink[];
  needs_ack: boolean;
  errors: ProposalEffects['errors'];
  lines: string[];
  hash: string;
}

const flowKeyText = (c: Content, k: string): string => {
  const [code, step] = k.split(':');
  const label = step ? stepLabel(c, step) : '';
  return code === 'STEP_UNREACHABLE' ? `недосяжний крок ${label}` : code === 'STEP_NO_EXIT' ? `крок ${label} без виходу до завершення`
    : code === 'ENTRY_BAD_REF' ? 'початковий крок не існує' : 'початковий крок не задано';
};

/**
 * Наслідки прийняття набору пропозицій (чиста функція): які кроки зникнуть, куди перейдуть зв'язки, чи зміниться початок,
 * що стане недосяжним, які нові невідомі переходи й питання з'являться. Показується ДО рішення; прийняття звіряє хеш цього показу.
 */
export function previewAccept(content: Content, ids: string[], scope: PreviewScope = null): ProposalPreview {
  const c = structuredClone(content);
  const fx: ProposalEffects = { removed: [], rewired: [], new_unknown: [], orphan_candidates: [], entry: { before: content.entry_step_id ?? null, after: content.entry_step_id ?? null }, errors: [] };
  const order = (content.step_proposals ?? []).map((p) => p.id);
  for (const id of [...ids].sort((x, y) => order.indexOf(x) - order.indexOf(y))) {
    const p = (c.step_proposals ?? []).find((x) => x.id === id);
    if (!p) { fx.errors.push({ code: 'NOT_FOUND', message: `Пропозицію ${id} не знайдено` }); continue; }
    if (p.status !== 'proposed') { fx.errors.push({ code: 'PROPOSAL_NOT_PENDING', message: `Рішення за пропозицією ${id} уже прийнято` }); continue; }
    applyAccept(c, p, fx);
  }
  const before = flowKeys(content);
  const after = flowKeys(c);
  const staleBefore = staleQuestionLinks(content);
  const touched = new Set<string>([...fx.removed.map((r) => r.id), ...fx.rewired.map((r) => r.from), ...fx.orphan_candidates, ...fx.new_unknown.map((u) => u.from)]);
  if (fx.entry.after !== null) touched.add(fx.entry.after);
  const introduced = after.filter((k) => !before.includes(k));
  const resolved = before.filter((k) => !after.includes(k));
  const residual = after.filter((k) => introduced.includes(k) || touched.has(k.split(':')[1] ?? ''));
  const entryChanged = fx.entry.before !== fx.entry.after;
  const needsAck = residual.length > 0 || (entryChanged && fx.entry.after === null);
  const lines: string[] = [];
  for (const r of fx.removed) lines.push(`Крок ${stepLabel(content, r.id)} зникне з опису.`);
  for (const w of fx.rewired) lines.push(`Перехід ${w.from}${w.condition ? ` («${clipTxt(w.condition, 40)}»)` : ''} → ${w.was} перейде на ${w.now}.`);
  for (const u of fx.new_unknown) lines.push(`Перехід кроку ${u.from} стане «невідомо»; буде створено критичне питання ${u.question_id} (невідоме не стає фактом).`);
  lines.push(entryChanged ? `Початковий крок зміниться: ${fx.entry.before ?? 'не задано'} → ${fx.entry.after ?? 'не задано'}.` : `Початковий крок не зміниться (${fx.entry.before ?? 'не задано'}).`);
  if (resolved.length) lines.push(`Буде усунуто: ${resolved.map((k) => flowKeyText(content, k)).join('; ')}.`);
  if (after.length === 0) lines.push('Після прийняття проблем потоку (недосяжних кроків, кроків без виходу) не лишиться.');
  else lines.push(`Після прийняття ЛИШАТЬСЯ проблеми потоку: ${after.map((k) => flowKeyText(c, k)).join('; ')}.`);
  // Наслідки для відкритих питань (D82): прив'язка до вилученого кроку сама не зникає — її знімає людина окремою дією.
  const staleAfter = staleQuestionLinks(c);
  const staleNew = staleAfter.filter((x) => !staleBefore.some((b) => b.question_id === x.question_id && b.step_id === x.step_id && b.condition === x.condition));
  for (const x of staleNew) {
    lines.push(`Питання ${x.question_id} (${x.critical ? 'КРИТИЧНЕ' : 'некритичне'}, відкрите) лишиться прив’язаним до вилученого кроку ${x.step_id}${x.condition ? ` («${clipTxt(x.condition, 40)}»)` : ''} — ${x.kind_label}. ` +
      'Автоматично воно не закривається й не відкріплюється: після прийняття приберіть цю прив’язку дією «Відкріпити від вилученого кроку» з поясненням.');
  }
  for (const e of fx.errors) lines.push(`Помилка: ${e.message}.`);
  const hash = sha256(canonical({ scope, ids: [...ids].sort(), base: sha256(canonical(content)), removed: fx.removed.map((r) => r.id), rewired: fx.rewired, new_unknown: fx.new_unknown.map((u) => [u.from, u.condition]), entry: fx.entry, after, stale: staleAfter.map((x) => [x.question_id, x.step_id, x.condition]), errors: fx.errors.map((e) => e.code) }));
  return {
    proposal_ids: [...ids], removed: fx.removed, rewired: fx.rewired, new_unknown: fx.new_unknown,
    entry: { before: fx.entry.before, after: fx.entry.after, changed: entryChanged },
    flow_before: before, flow_after: after, resolved, introduced, residual, stale_links: staleAfter, needs_ack: needsAck, errors: fx.errors, lines, hash,
  };
}

/** Область дії показу: кейс і точна версія, для яких наслідки показано. Хеш чужого кейсу чи іншої версії не збігається. */
export type PreviewScope = { caseId: string; versionId: string } | null;

export interface ProposalPreviews {
  /** Наслідки прийняття кожної відкритої пропозиції ОКРЕМО. */
  items: Record<string, ProposalPreview & { better_with: string[] }>;
  /** Групи пов'язаних пропозицій: разом дають менше проблем потоку, ніж кожна окремо. */
  bundles: { ids: string[]; preview: ProposalPreview }[];
  /** Пропозицій забагато для повного перебору комбінацій — групи не обчислювались. */
  bundles_skipped: boolean;
}

const MAX_BUNDLE_SEARCH = 8;

export function previewProposals(content: Content, scope: PreviewScope = null): ProposalPreviews {
  const pending = (content.step_proposals ?? []).filter((p) => p.status === 'proposed').map((p) => p.id);
  const items: ProposalPreviews['items'] = {};
  const bundles: ProposalPreviews['bundles'] = [];
  const skipped = pending.length > MAX_BUNDLE_SEARCH;
  const alone = new Map(pending.map((id) => [id, previewAccept(content, [id], scope)]));
  const cost = new Map<string, number>();
  const costOf = (ids: string[]): number => {
    const key = [...ids].sort().join(',');
    if (!cost.has(key)) { const pv = previewAccept(content, ids, scope); cost.set(key, pv.errors.length ? Infinity : pv.flow_after.length); }
    return cost.get(key)!;
  };
  const seen = new Set<string>();
  for (const id of pending) {
    let betterWith: string[] = [];
    if (!skipped) {
      const base = costOf([id]);
      let bestCost = base;
      for (let mask = 1; mask < 1 << pending.length; mask++) {
        const subset = pending.filter((_, i) => (mask & (1 << i)) !== 0);
        if (!subset.includes(id) || subset.length < 2) continue;
        const cst = costOf(subset);
        // найменша кількість проблем потоку; за однакової — найменша група
        if (cst < bestCost || (cst === bestCost && cst < base && subset.length - 1 < betterWith.length)) { bestCost = cst; betterWith = subset.filter((x) => x !== id); }
      }
    }
    items[id] = { ...alone.get(id)!, better_with: betterWith };
    if (betterWith.length) {
      const group = [id, ...betterWith].sort((x, y) => pending.indexOf(x) - pending.indexOf(y));
      const key = group.join(',');
      if (!seen.has(key)) { seen.add(key); bundles.push({ ids: group, preview: previewAccept(content, group, scope) }); }
    }
  }
  return { items, bundles, bundles_skipped: skipped };
}

/**
 * Рішення аналітикині щодо пропозицій агента вилучити/замінити крок. Створює НОВУ версію; попередні лишаються.
 * Прийняття: крок вилучається; переходи, що вели до нього, перенаправляються на крок-заміну (replace) або стають
 * «невідомо» з критичним питанням (remove) — «невідоме не стає фактом»; початковий крок переноситься або знімається.
 * Пов'язані пропозиції можна прийняти ОДНИМ явним рішенням (`proposalIds`): одна нова версія, інші пропозиції автоматично не чіпаються.
 * Якщо після прийняття лишається недосяжність чи крок без виходу, пов'язані зі зміною, потрібне явне підтвердження наслідків
 * (`acknowledge`). Хеш показу (`previewHash`) ОБОВ'ЯЗКОВИЙ: він охоплює кейс, поточну версію, точний набір пропозицій і наслідки; відсутній — PREVIEW_REQUIRED, чужий чи застарілий — PREVIEW_STALE.
 * Нова версія потребує прийняття, передачі на погодження й погодження заново (погодження втрачає чинність).
 * Правки аналітикині не знімаються: змінені кроки стають її «власністю», агент їх не перезапише.
 */
export function decideStepProposals(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; proposalIds: string[]; note?: string; previewHash?: string; acknowledge?: boolean },
): VersionRow {
  requireHuman(actor, 'рішення щодо пропозиції агента');
  const ids = [...new Set(input.proposalIds)];
  if (ids.length === 0) throw new DomainError('VALIDATION', 'Не вказано пропозицій', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    for (const id of ids) {
      const p = (c.step_proposals ?? []).find((x) => x.id === id);
      if (!p) throw new DomainError('NOT_FOUND', 'Пропозицію не знайдено', 404);
      if (p.status !== 'proposed') throw new DomainError('PROPOSAL_NOT_PENDING', 'Рішення за цією пропозицією вже прийнято', 409);
    }
    const preview = previewAccept(c, ids, { caseId, versionId: head.id });
    const missing = preview.errors.find((e) => e.code === 'STEP_MISSING');
    if (missing) throw new DomainError('STEP_MISSING', missing.message, 409);
    // Прийняття прив'язане до переглянутих наслідків: показ обов'язковий; `acknowledge` його не замінює.
    if (!input.previewHash) {
      throw new DomainError('PREVIEW_REQUIRED', 'Спершу перегляньте наслідки прийняття: без хеша показу рішення не приймається.', 428, { preview });
    }
    if (input.previewHash !== preview.hash) {
      throw new DomainError('PREVIEW_STALE', 'Наслідки, які ви бачили, більше не відповідають поточній версії. Перегляньте їх ще раз.', 409, { preview });
    }
    if (preview.needs_ack && !input.acknowledge) {
      throw new DomainError('CONSEQUENCES_NOT_CONFIRMED',
        'Після прийняття лишаться проблеми потоку, пов’язані з цією зміною. Перегляньте наслідки й підтвердіть їх явно (або прийміть пов’язані пропозиції разом).', 409, { preview });
    }
    const note = (input.note ?? '').trim();
    const fx: ProposalEffects = { removed: [], rewired: [], new_unknown: [], orphan_candidates: [], entry: { before: c.entry_step_id ?? null, after: c.entry_step_id ?? null }, errors: [] };
    const order = (c.step_proposals ?? []).map((p) => p.id);
    for (const id of [...ids].sort((x, y) => order.indexOf(x) - order.indexOf(y))) {
      const p = (c.step_proposals ?? []).find((x) => x.id === id)!;
      p.decided_by = actor.name;
      p.decision_note = note;
      applyAccept(c, p, fx);
    }
    const what = (id: string, p: StepProposalT) => (p.action === 'remove' ? `вилучено крок ${p.step_id}` : `крок ${p.step_id} замінено на ${p.replacement_step_id}`);
    const props = (c.step_proposals ?? []).filter((p) => ids.includes(p.id));
    const msg = ids.length === 1
      ? `Прийнято пропозицію ${props[0]!.id}: ${what(props[0]!.id, props[0]!)}`
      : `Прийнято разом пропозиції ${props.map((p) => p.id).join(', ')}: ${props.map((p) => what(p.id, p)).join('; ')}`;
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[], msg);
  });
}

export function decideStepProposal(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; proposalId: string; decision: 'accept' | 'reject'; note?: string; previewHash?: string; acknowledge?: boolean },
): VersionRow {
  requireHuman(actor, 'рішення щодо пропозиції агента');
  if (input.decision !== 'accept' && input.decision !== 'reject') throw new DomainError('VALIDATION', 'decision має бути accept або reject', 400);
  if (input.decision === 'accept') {
    return decideStepProposals(db, actor, caseId, { baseVersionId: input.baseVersionId, proposalIds: [input.proposalId], note: input.note, previewHash: input.previewHash, acknowledge: input.acknowledge });
  }
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const p = (c.step_proposals ?? []).find((x) => x.id === input.proposalId);
    if (!p) throw new DomainError('NOT_FOUND', 'Пропозицію не знайдено', 404);
    if (p.status !== 'proposed') throw new DomainError('PROPOSAL_NOT_PENDING', 'Рішення за цією пропозицією вже прийнято', 409);
    p.decided_by = actor.name;
    p.decision_note = (input.note ?? '').trim();
    p.status = 'rejected';
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Пропозицію ${p.id} (${p.action} ${p.step_id}) відхилено`);
  });
}

// ───────────────────────── вимоги до нотації (D61) ─────────────────────────

const REQ_ACTIVE = (r: NotationRequirementT): boolean => r.status === 'proposed' || r.status === 'confirmed';

/**
 * Людина ставить явну вимогу до нотації (крок + вид + пояснення; джерело й цитата — необов'язково). Вимога одразу «confirmed»:
 * її поставила людина. Створює НОВУ версію (зміст змінюється → хеш, прийняття й погодження — заново).
 */
export function addNotationRequirement(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; kind: string; stepId: string; detail: string; evidenceSourceId?: string; evidenceQuote?: string },
): VersionRow {
  requireHuman(actor, 'постановка вимоги до нотації');
  const kind = NotationKind.safeParse(input.kind);
  if (!kind.success) throw new DomainError('VALIDATION', `Невідомий вид нотації «${input.kind}»`, 400);
  const detail = (input.detail ?? '').trim();
  if (!detail) throw new DomainError('VALIDATION', 'Опишіть, що саме в описі процесу потребує цієї нотації', 400);
  const srcId = (input.evidenceSourceId ?? '').trim();
  const quote = (input.evidenceQuote ?? '').trim();
  if (quote && !srcId) throw new DomainError('VALIDATION', 'Цитата без джерела: оберіть джерело', 400);
  if (srcId && !listSources(db, caseId).some((x) => x.id === srcId)) throw new DomainError('VALIDATION', 'Джерело не належить цьому кейсу', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    if (!c.steps.some((x) => x.id === input.stepId)) throw new DomainError('VALIDATION', `Кроку «${input.stepId}» немає в описі процесу`, 400);
    const list = c.notation_requirements ?? [];
    const dup = list.find((r) => REQ_ACTIVE(r) && r.step_id === input.stepId && r.kind === kind.data);
    if (dup) {
      throw new DomainError('DUPLICATE_REQUIREMENT', dup.status === 'proposed'
        ? `Для кроку ${input.stepId} уже є пропозиція ${dup.id} цього виду: підтвердьте її замість нової вимоги.`
        : `Для кроку ${input.stepId} уже є підтверджена вимога ${dup.id} цього виду.`, 409);
    }
    const req: NotationRequirementT = {
      id: nextId('N', list.map((r) => r.id)), kind: kind.data, step_id: input.stepId, detail, origin: 'analyst', status: 'confirmed',
      evidence_source_id: srcId, evidence_quote: quote, decided_by: actor.name, decision_note: '',
    };
    c.notation_requirements = [...list, req];
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Додано вимогу до нотації ${req.id}: ${NOTATION_KIND_LABEL[req.kind]} (крок ${req.step_id})`);
  });
}

/**
 * Рішення людини щодо пропозиції агента: підтвердити (стає встановленим фактом опису) чи відхилити. Нова версія.
 * Агент рішень не приймає: ні цією функцією (лише людина), ні змінами змісту (перевірка відповіді й захист правок).
 */
export function decideNotationRequirement(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; requirementId: string; decision: 'confirm' | 'reject'; note?: string },
): VersionRow {
  requireHuman(actor, 'рішення щодо вимоги до нотації');
  if (input.decision !== 'confirm' && input.decision !== 'reject') throw new DomainError('VALIDATION', 'decision має бути confirm або reject', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const r = (c.notation_requirements ?? []).find((x) => x.id === input.requirementId);
    if (!r) throw new DomainError('NOT_FOUND', 'Вимогу не знайдено', 404);
    if (r.status !== 'proposed') throw new DomainError('REQUIREMENT_NOT_PENDING', 'Рішення за цією пропозицією вже прийнято', 409);
    if (input.decision === 'confirm' && !c.steps.some((x) => x.id === r.step_id)) throw new DomainError('STEP_MISSING', `Кроку ${r.step_id} у поточній версії вже немає`, 409);
    r.status = input.decision === 'confirm' ? 'confirmed' : 'rejected';
    r.decided_by = actor.name;
    r.decision_note = (input.note ?? '').trim();
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Вимогу до нотації ${r.id} (${NOTATION_KIND_LABEL[r.kind]}, крок ${r.step_id}) ${input.decision === 'confirm' ? 'підтверджено' : 'відхилено'}`);
  });
}

/** Людина прибирає вимогу (наприклад, після свідомого спрощення опису). Нова версія; попередня з вимогою лишається в історії. */
export function removeNotationRequirement(
  db: DB, actor: Actor, caseId: string, input: { baseVersionId: string; requirementId: string },
): VersionRow {
  requireHuman(actor, 'видалення вимоги до нотації');
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const list = c.notation_requirements ?? [];
    const r = list.find((x) => x.id === input.requirementId);
    if (!r) throw new DomainError('NOT_FOUND', 'Вимогу не знайдено', 404);
    c.notation_requirements = list.filter((x) => x.id !== r.id);
    if (c.notation_requirements.length === 0) delete c.notation_requirements;
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Прибрано вимогу до нотації ${r.id} (${NOTATION_KIND_LABEL[r.kind]}, крок ${r.step_id})`);
  });
}

/** Блокери за вимогами до нотації й назвою процесу: спільні для передачі на погодження і для серверного дозволу BPMN. */
export function notationIssues(c: Content): Blocker[] {
  const out: Blocker[] = [];
  for (const r of c.notation_requirements ?? []) {
    if (r.status === 'proposed') {
      out.push({ code: 'PENDING_NOTATION_PROPOSAL', severity: 'critical', ref: r.id,
        message: `Пропозиція агента ${r.id}: потрібна нотація «${NOTATION_KIND_LABEL[r.kind]}» (крок ${r.step_id}) — потрібне ваше рішення. Непідтверджена пропозиція не є встановленим фактом, але й не може лишатися без відповіді.` });
    }
    if (r.status !== 'rejected' && !c.steps.some((x) => x.id === r.step_id)) {
      out.push({ code: 'NOTATION_BAD_STEP', severity: 'critical', ref: r.id,
        message: `Вимога до нотації ${r.id} стосується кроку «${r.step_id}», якого немає в описі (його могли вилучити чи перейменувати). Приберіть вимогу або виправте опис.` });
    }
  }
  return out;
}

// ───────────────────────── перевірки перед погодженням ─────────────────────────

export function submissionBlockers(db: DB, caseId: string): Blocker[] {
  const head = headVersion(db, caseId);
  const c = versionContent(head);
  const out: Blocker[] = [];
  const covered = new Set(JSON.parse(head.covered_json) as string[]);

  if (!isAccepted(db, head.id)) {
    out.push({ code: 'NOT_ACCEPTED', severity: 'critical', message: `Робочу версію ${head.number} ще не прийнято.` });
  }
  for (const s of listSources(db, caseId)) {
    if (s.read_status !== 'ok') {
      out.push({
        code: 'UNREAD_SOURCE', ref: s.id,
        severity: s.required ? 'critical' : 'warning',
        message: `Джерело «${s.title}» не прочитано${s.read_error ? ` (${s.read_error})` : ''}${s.required ? ' — воно обов’язкове' : ''}. Його не враховано.`,
      });
    } else if (!covered.has(s.id)) {
      out.push({ code: 'UNCOVERED_SOURCE', severity: 'critical', ref: s.id,
        message: `Джерело «${s.title}» не враховано в цій версії.` });
    }
  }
  for (const p of c.step_proposals ?? []) {
    if (p.status !== 'proposed') continue;
    out.push({ code: 'PENDING_STEP_PROPOSAL', severity: 'critical', ref: p.id,
      message: `Пропозиція агента ${p.id}: ${p.action === 'remove' ? 'вилучити' : 'замінити'} крок ${p.step_id}${p.action === 'replace' ? ` кроком ${p.replacement_step_id}` : ''} — потрібне ваше рішення (причина: ${p.reason}).` });
  }
  out.push(...notationIssues(c));
  if (!(c.process_name ?? '').trim()) {
    out.push({ code: 'PROCESS_NAME_MISSING', severity: 'warning',
      message: 'Назву процесу не зазначено. Вона потрібна перед побудовою схеми (напис на пулі); назву кейсу в схему не підставляємо. Вкажіть її на вкладці «Редагувати».' });
  }
  for (const q of c.questions) {
    if (q.status === 'open' && q.critical) {
      out.push({ code: 'CRITICAL_QUESTION', severity: 'critical', ref: q.id, message: `${q.id}: ${q.text}` });
    }
    if (q.status === 'open' && !q.critical) {
      out.push({ code: 'OPEN_QUESTION', severity: 'warning', ref: q.id, message: `Питання ${q.id}: ${q.text}` });
    }
  }
  const b = c.boundaries;
  for (const [k, label] of [['trigger', 'тригер'], ['input', 'вхід'], ['completion', 'фактичне завершення'], ['result', 'результат']] as const) {
    if (!b[k].trim()) out.push({ code: 'BOUNDARY_MISSING', severity: 'critical', ref: k, message: `Не заповнено межу процесу: ${label}.` });
  }
  if (c.roles.length === 0) out.push({ code: 'NO_ROLES', severity: 'critical', message: 'Не вказано ролей.' });
  if (c.steps.length === 0) out.push({ code: 'NO_STEPS', severity: 'critical', message: 'Немає жодного кроку процесу.' });
  const stepIds = new Set(c.steps.map((s) => s.id));
  for (const s of c.steps) {
    if (!s.role.trim() || !s.action.trim() || !s.result.trim()) {
      out.push({ code: 'STEP_INCOMPLETE', severity: 'critical', ref: s.id, message: `Крок ${s.id}: потрібні роль, дія та результат.` });
    } else if (c.roles.length > 0 && !c.roles.includes(s.role)) {
      out.push({ code: 'STEP_UNKNOWN_ROLE', severity: 'critical', ref: s.id, message: `Крок ${s.id}: роль «${s.role}» не входить до списку ролей.` });
    }
    if (s.next.length === 0) {
      out.push({ code: 'STEP_NO_NEXT', severity: 'critical', ref: s.id, message: `Крок ${s.id}: не вказано наступного кроку (або END).` });
    }
    for (const n of s.next) {
      if (n.to !== 'END' && n.to !== UNKNOWN && !stepIds.has(n.to)) {
        out.push({ code: 'STEP_BAD_NEXT', severity: 'critical', ref: s.id, message: `Крок ${s.id}: перехід до неіснуючого кроку «${n.to}».` });
      }
    }
    if (s.next.length > 1 && s.next.some((n) => !n.condition.trim())) {
      out.push({ code: 'STEP_NO_CONDITION', severity: 'critical', ref: s.id, message: `Крок ${s.id}: розгалуження без умови переходу.` });
    }
  }
  for (const p of c.problems) {
    if (!p.impact.trim()) out.push({ code: 'PROBLEM_NO_IMPACT', severity: 'critical', ref: p.id,
      message: `Проблема ${p.id}: не описано вплив (якщо метрики немає — вкажіть це словами).` });
  }
  out.push(...transitionIssues(c));
  out.push(...flowIssues(c));
  out.push(...preparationIssues(c));
  if (c.conflicts.length > 0) {
    out.push({ code: 'CONFLICTS_PRESENT', severity: 'warning', message: `Є розбіжності між вашими правками й пропозиціями агента: ${c.conflicts.length}. Перегляньте обидва варіанти.` });
  }
  return out;
}

// ───────────────────── невизначені переходи ─────────────────────

const condText = (cond: string): string => (cond ? `«${cond}»` : '(без умови)');

export const linkKindOf = (a: { kind?: LinkKindT }): LinkKindT => a.kind ?? 'direction';

/** Питання, що стосуються переходу (крок, умова) для вказаних видів прив'язки (за замовчуванням — лише «напрямок», як було раніше). */
export function questionsAffecting(c: Content, stepId: string, condition: string, kinds: LinkKindT[] = ['direction']): Question[] {
  return c.questions.filter((q) => (q.affects_transitions ?? []).some((a) => a.step_id === stepId && a.condition === condition && kinds.includes(linkKindOf(a))));
}

/**
 * Правила «невідоме не стає фактом». Усі порушення критичні (це прогалини у ході процесу):
 *  • перехід «невідомо» без питання про НАПРЯМОК, з закритим питанням, або з відкритим питанням (залишається прогалиною);
 *  • відкрите питання про НАПРЯМОК переходу, який поданий як встановлений (наприклад, END) — суперечність;
 *  • відкрите питання про непідтверджену ПОСЛІДОВНІСТЬ відомого переходу — прогалина «послідовність не підтверджена»;
 *  • відкрите питання про ВИНЯТОК або уточнення кроку саме по собі переходів не блокує (блокує лише критичне питання окремим правилом);
 *  • відкрите питання посилається на перехід (чи крок), якого в описі немає.
 */
export function transitionIssues(c: Content): Blocker[] {
  const out: Blocker[] = [];
  for (const s of c.steps) {
    for (const n of s.next) {
      const linked = questionsAffecting(c, s.id, n.condition);
      const open = linked.filter((q) => q.status === 'open');
      if (n.to === UNKNOWN) {
        if (linked.length === 0) {
          out.push({ code: 'UNKNOWN_WITHOUT_QUESTION', severity: 'critical', ref: s.id,
            message: `Крок ${s.id}: перехід ${condText(n.condition)} позначено «невідомо», але немає питання про напрямок, яке б це з’ясовувало. Додайте питання.` });
        } else if (open.length === 0) {
          out.push({ code: 'UNKNOWN_QUESTION_CLOSED', severity: 'critical', ref: s.id,
            message: `Крок ${s.id}: перехід ${condText(n.condition)} досі «невідомо», хоча питання ${linked.map((q) => q.id).join(', ')} закрито. Оновіть крок відповідно до уточнення.` });
        } else {
          out.push({ code: 'UNRESOLVED_TRANSITION', severity: 'critical', ref: s.id,
            message: `Крок ${s.id}: перехід ${condText(n.condition)} невизначений — див. питання ${open.map((q) => q.id).join(', ')}.` });
        }
      } else {
        if (open.length > 0) {
          out.push({ code: 'CONTRADICTION', severity: 'critical', ref: open[0]!.id,
            message: `Суперечність: питання ${open.map((q) => q.id).join(', ')} про перехід ${condText(n.condition)} кроку ${s.id} відкрите як питання про напрямок, але перехід поданий як встановлений (→ ${n.to}). Невідоме не можна записувати як факт: або позначте перехід «невідомо», або, якщо питання не про напрямок (послідовність не підтверджена, невідомий виняток, уточнення кроку), змініть вид прив’язки питання.` });
        }
        const seq = questionsAffecting(c, s.id, n.condition, ['unconfirmed_sequence']).filter((q) => q.status === 'open');
        if (seq.length > 0) {
          out.push({ code: 'SEQUENCE_UNCONFIRMED', severity: 'critical', ref: seq[0]!.id,
            message: `Послідовність ${s.id} → ${n.to} не підтверджена: ${seq.map((q) => q.id).join(', ')}. Перехід записано за припущенням; доки питання відкрите, потік процесу не можна вважати встановленим.` });
        }
      }
    }
  }
  for (const q of c.questions) {
    if (q.status !== 'open') continue;
    for (const a of q.affects_transitions ?? []) {
      const kind = linkKindOf(a);
      const exists = kind === 'step_detail'
        ? c.steps.some((s) => s.id === a.step_id)
        : c.steps.some((s) => s.id === a.step_id && s.next.some((n) => n.condition === a.condition));
      if (!exists) {
        // Якщо кроку немає зовсім (типово після прийнятого вилучення), прогалину прибирає явне відкріплення
        // людиною; якщо крок є, а переходу немає — це інша ситуація (змінено умову) і лікується інакше (D82).
        const stepMissing = !c.steps.some((s) => s.id === a.step_id);
        out.push({ code: 'QUESTION_LINK_BROKEN', severity: 'critical', ref: q.id,
          message: stepMissing
            ? `Питання ${q.id} стосується кроку ${a.step_id}, якого в описі немає (крок вилучено). ` +
              'Приберіть неактуальну прив’язку в картці питання дією «Відкріпити від вилученого кроку» (з поясненням): питання лишиться відкритим, його критичність не зміниться.'
            : `Питання ${q.id} стосується переходу ${condText(a.condition)} кроку ${a.step_id}, якого в цьому кроці немає (змінено умову?). Перевірте прив’язку або умову переходу.` });
      }
    }
  }
  return out;
}

/**
 * Ранній варіант правила генератора SINGLE_CONDITIONAL_BRANCH: єдиний вихідний перехід кроку має умову (а що буде в іншому випадку — не сказано).
 * Перехід у «невідомо» не рахується (його пояснює питання). Це попередження до побудови: воно не змінює зміст і справжніх умов не чіпає.
 */
export function preparationIssues(c: Content): Blocker[] {
  const out: Blocker[] = [];
  for (const s of c.steps) {
    if (s.next.length === 1 && s.next[0]!.condition.trim() !== '' && s.next[0]!.to !== UNKNOWN) {
      out.push({ code: 'SINGLE_CONDITIONAL_BRANCH', severity: 'warning', ref: s.id,
        message: `Крок ${s.id}: єдиний вихідний перехід має умову «${clipTxt(s.next[0]!.condition, 60)}», а що буде в іншому випадку — не сказано. Якщо це лише результат кроку, умову варто прибрати (результат — у полі «Результат»); якщо це справжній вибір, опишіть другу гілку. Схему з такою умовою побудувати не вдасться.` });
    }
  }
  return out;
}

export interface UnknownTransition {
  step_id: string;
  step_action: string;
  condition: string;
  question_ids: string[];
  questions: { id: string; text: string; status: string }[];
}

export function unknownTransitions(c: Content): UnknownTransition[] {
  const res: UnknownTransition[] = [];
  for (const s of c.steps) for (const n of s.next) {
    if (n.to !== UNKNOWN) continue;
    const qs = questionsAffecting(c, s.id, n.condition);
    res.push({ step_id: s.id, step_action: s.action, condition: n.condition, question_ids: qs.map((q) => q.id),
      questions: qs.map((q) => ({ id: q.id, text: q.text, status: q.status })) });
  }
  return res;
}

// ───────────────────── початковий крок, досяжність і вихід до завершення (D27) ─────────────────────

const clipTxt = (t: string, n = 38): string => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

/**
 * Структурні правила потоку v1. Початковий крок ЗАВЖДИ береться з явного поля `entry_step_id`,
 * порядок кроків у списку не використовується ніде.
 *  • ENTRY_MISSING / ENTRY_BAD_REF — початковий крок не задано або він не існує;
 *  • STEP_UNREACHABLE — кроки, до яких не веде жоден шлях від початкового;
 *  • STEP_NO_EXIT — кроки, з яких неможливо дійти до завершення (END), зокрема замкнений цикл без виходу.
 * Цикли з виходом дозволені. Перехід «невідомо» тут вважається можливим виходом, щоб не дублювати
 * прогалину, яку вже показує правило невизначених переходів (D20).
 */
export function flowIssues(c: Content): Blocker[] {
  const out: Blocker[] = [];
  if (c.steps.length === 0) return out; // «немає кроків» повідомляє окреме правило
  const byId = new Map(c.steps.map((s) => [s.id, s]));
  const label = (id: string): string => `${id} («${clipTxt(byId.get(id)?.action ?? '')}»)`;
  const list = (ids: string[]): string => ids.map(label).join(', ');
  const entry = c.entry_step_id ?? null;
  if (!entry) {
    out.push({ code: 'ENTRY_MISSING', severity: 'critical',
      message: c.entry_step_id === undefined
        ? 'Початковий крок не визначено: запис створено до появи цього поля. Оберіть вручну, з якого кроку процес починається після тригера. Система не вибирає його за порядком рядків.'
        : 'Початковий крок не визначено: оберіть, з якого кроку процес починається після тригера.' });
    return out;
  }
  if (!byId.has(entry)) {
    out.push({ code: 'ENTRY_BAD_REF', severity: 'critical', ref: entry,
      message: `Початковий крок «${entry}» не існує серед кроків процесу (його могли видалити чи перейменувати). Оберіть інший початковий крок.` });
    return out;
  }
  const adj = new Map<string, string[]>();
  const exits = new Set<string>();
  for (const s of c.steps) {
    const to: string[] = [];
    for (const n of s.next) {
      if (n.to === 'END' || n.to === UNKNOWN) exits.add(s.id);
      else if (byId.has(n.to)) to.push(n.to);
    }
    adj.set(s.id, to);
  }
  // досяжність від початкового кроку
  const reach = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const x = queue.shift()!;
    for (const t of adj.get(x) ?? []) if (!reach.has(t)) { reach.add(t); queue.push(t); }
  }
  const unreachable = c.steps.map((s) => s.id).filter((id) => !reach.has(id));
  if (unreachable.length) {
    out.push({ code: 'STEP_UNREACHABLE', severity: 'critical', ref: unreachable.join(','),
      message: `Недосяжні кроки: ${list(unreachable)}. Від початкового кроку ${label(entry)} немає жодного шляху до ${unreachable.length > 1 ? 'них' : 'нього'}: у ${unreachable.length > 1 ? 'ці кроки' : 'цей крок'} не веде жоден перехід із досяжних кроків. Додайте перехід або видаліть крок.` });
  }
  // чи можна з кроку дійти до завершення: зворотний обхід від кроків із виходом
  const rev = new Map<string, string[]>();
  for (const [from, tos] of adj) for (const t of tos) rev.set(t, [...(rev.get(t) ?? []), from]);
  const canExit = new Set<string>(exits);
  const q2 = [...exits];
  while (q2.length) {
    const x = q2.shift()!;
    for (const p of rev.get(x) ?? []) if (!canExit.has(p)) { canExit.add(p); q2.push(p); }
  }
  // крок без жодного переходу повідомляє правило STEP_NO_NEXT — тут не дублюємо
  const stuck = c.steps.map((s) => s.id).filter((id) => reach.has(id) && !canExit.has(id) && (byId.get(id)!.next.length > 0));
  if (stuck.length) {
    const stuckSet = new Set(stuck);
    let cycle: string[] | null = null;
    const seen = new Map<string, number>();
    const path: string[] = [];
    let cur: string | undefined = stuck[0];
    while (cur !== undefined && !seen.has(cur)) {
      seen.set(cur, path.length);
      path.push(cur);
      cur = (adj.get(cur) ?? []).find((t) => stuckSet.has(t));
    }
    if (cur !== undefined) cycle = [...path.slice(seen.get(cur)!), cur];
    out.push({ code: 'STEP_NO_EXIT', severity: 'critical', ref: stuck.join(','),
      message: cycle
        ? `Замкнений цикл без виходу: ${cycle.join(' → ')}. З кроків ${list(stuck)} неможливо дійти до завершення процесу (END): жоден перехід не веде за межі циклу. Додайте вихід із циклу.`
        : `З кроків ${list(stuck)} неможливо дійти до завершення процесу (END): усі шляхи з них ведуть у кроки без виходу. Додайте перехід до завершення.` });
  }
  return out;
}

export const FLOW_CODES = new Set(['ENTRY_MISSING', 'ENTRY_BAD_REF', 'STEP_UNREACHABLE', 'STEP_NO_EXIT']);

export const criticalBlockers = (bs: Blocker[]): Blocker[] => bs.filter((b) => b.severity === 'critical');

// ───────────────────────── статуси та погодження ─────────────────────────

export function acceptDraft(db: DB, actor: Actor, caseId: string, versionId: string): void {
  requireHuman(actor, 'прийняття робочої версії');
  tx(db, () => {
    const head = headVersion(db, caseId);
    if (head.id !== versionId) throw new DomainError('VERSION_STALE', 'Це не поточна версія: прийняти можна лише найновішу.', 409);
    if (isAccepted(db, versionId)) throw new DomainError('VALIDATION', 'Версію вже прийнято.', 400);
    run(db, 'INSERT INTO version_acceptance (version_id, accepted_by, accepted_at) VALUES (?,?,?)', versionId, actor.name, now());
    audit(db, caseId, actor, 'draft_accepted', { version_id: versionId });
  });
}

export function submitForApproval(db: DB, actor: Actor, caseId: string): void {
  requireHuman(actor, 'передача на погодження');
  tx(db, () => {
    const c = getCase(db, caseId);
    if (c.state !== 'research') throw new DomainError('BAD_STATE', `Передати на погодження можна лише зі стану «${STATE_LABEL.research}».`, 409);
    const blockers = criticalBlockers(submissionBlockers(db, caseId));
    if (blockers.length) throw new DomainError('GUARD_FAILED', 'Передача на погодження заблокована.', 409, { blockers });
    setState(db, caseId, 'pending_approval');
    audit(db, caseId, actor, 'submitted_for_approval', { version_id: c.head_version_id });
  });
}

export function returnToResearch(db: DB, actor: Actor, caseId: string, reason: string): void {
  requireHuman(actor, 'повернення до дослідження');
  if (!reason.trim()) throw new DomainError('VALIDATION', 'Вкажіть причину повернення', 400);
  tx(db, () => {
    const c = getCase(db, caseId);
    if (c.state === 'research') throw new DomainError('BAD_STATE', 'Кейс уже на етапі дослідження.', 409);
    fallBackToResearch(db, caseId, actor, `returned: ${reason.trim()}`);
  });
}

/** Погодження прив’язане до конкретної незмінної версії (ID + хеш), автора-людини й часу. */
/**
 * Одна фінальна дія погодження для одного користувача (D97).
 *
 * Службові переходи «Прийняти робочу версію» й «Передати на погодження» для одного користувача
 * нічого не вирішують: вони лише просять ту саму людину натиснути ще двічі. Тому вони виконуються
 * всередині ОДНІЄЇ транзакції разом із погодженням.
 *
 * Жодної перевірки не прибрано: `acceptDraft` і `submitForApproval` викликаються як є, зі своїми
 * умовами, а `approve` далі перевіряє чинність версії, цілісність і відсутність блокерів.
 * Якщо щось із цього не проходить — транзакція відкочується повністю, станів навпіл не буває.
 */
export function approveDirect(
  db: DB, actor: Actor, caseId: string,
  input: { versionId: string; checklistConfirmed: boolean; note?: string },
): ApprovalRow {
  requireHuman(actor, 'погодження AS-IS');
  return tx(db, () => {
    const c = getCase(db, caseId);
    const head = headVersion(db, caseId);
    if (head.id !== input.versionId) {
      throw new DomainError('VERSION_STALE', 'Ви намагаєтеся погодити не поточну версію. Погодження не записано.', 409, { head_version_id: head.id });
    }
    if (c.state === 'research') {
      if (!isAccepted(db, head.id)) acceptDraft(db, actor, caseId, head.id);
      submitForApproval(db, actor, caseId);
    }
    return approve(db, actor, caseId, input);
  });
}

export function approve(
  db: DB, actor: Actor, caseId: string,
  input: { versionId: string; checklistConfirmed: boolean; note?: string },
): ApprovalRow {
  requireHuman(actor, 'погодження AS-IS');
  if (!input.checklistConfirmed) {
    throw new DomainError('CHECKLIST_REQUIRED', 'Підтвердіть, що ви особисто перевірили опис (список перевірки).', 400);
  }
  return tx(db, () => {
    const c = getCase(db, caseId);
    if (c.state !== 'pending_approval') {
      throw new DomainError('BAD_STATE', `Погодити можна лише кейс зі стану «${STATE_LABEL.pending_approval}».`, 409);
    }
    const head = headVersion(db, caseId);
    if (head.id !== input.versionId) {
      throw new DomainError('VERSION_STALE', 'Ви намагаєтеся погодити не поточну версію. Погодження не записано.', 409,
        { head_version_id: head.id });
    }
    if (!verifyVersionIntegrity(db, head.id)) {
      throw new DomainError('INTEGRITY', 'Хеш версії не збігається зі змістом у базі. Погодження не записано.', 409);
    }
    const blockers = criticalBlockers(submissionBlockers(db, caseId));
    if (blockers.length) throw new DomainError('GUARD_FAILED', 'Є блокери — погодження неможливе.', 409, { blockers });
    const id = newId('appr');
    run(db, 'INSERT INTO approval (id, case_id, version_id, content_hash, approver, note, created_at) VALUES (?,?,?,?,?,?,?)',
      id, caseId, head.id, head.content_hash, actor.name, input.note ?? '', now());
    setState(db, caseId, 'approved');
    audit(db, caseId, actor, 'approved', { approval_id: id, version_id: head.id, hash: head.content_hash });
    return one<ApprovalRow>(db, 'SELECT * FROM approval WHERE id = ?', id)!;
  });
}

// ───────────────────────── дозвіл наступного етапу (BPMN) ─────────────────────────

export interface GuardResult {
  ok: boolean;
  reasons: { code: string; message: string }[];
}

/** Сім умов із технічного плану §6. Викликається на сервері, а не з браузера. */
export function bpmnGuard(db: DB, caseId: string, opts: { ignoreActiveRun?: boolean } = {}): GuardResult {
  const reasons: GuardResult['reasons'] = [];
  const fail = (code: string, message: string) => reasons.push({ code, message });
  const c = getCase(db, caseId);
  const head = headVersion(db, caseId);

  if (c.state !== 'approved') fail('NOT_APPROVED_STATE', `Стан кейсу «${STATE_LABEL[c.state]}», а потрібен «${STATE_LABEL.approved}».`);
  const a = currentApproval(db, caseId);
  if (!a) {
    fail('NO_APPROVAL', 'Немає чинного погодження людини.');
  } else {
    if (a.version_id !== head.id) fail('APPROVAL_NOT_HEAD', 'Погоджена версія не є найновішою.');
    if (!verifyVersionIntegrity(db, a.version_id) || getVersion(db, a.version_id).content_hash !== a.content_hash) {
      fail('HASH_MISMATCH', 'Хеш погодженої версії не збігається зі змістом.');
    }
    const approved = getVersion(db, a.version_id);
    const covered = new Set(JSON.parse(approved.covered_json) as string[]);
    for (const s of listSources(db, caseId)) {
      if (s.read_status === 'ok' && !covered.has(s.id)) fail('NEW_SOURCE', `Джерело «${s.title}» додано після погодженої версії.`);
    }
    const open = versionContent(approved).questions.filter((q) => q.status === 'open' && q.critical);
    for (const q of open) fail('CRITICAL_QUESTION', `У погодженій версії є відкрите критичне питання ${q.id}.`);
    for (const issue of transitionIssues(versionContent(approved))) fail(issue.code, issue.message);
    for (const issue of flowIssues(versionContent(approved))) fail(issue.code, issue.message);
    // Правило генератора, що виявляється до спроби побудови: єдиний перехід з умовою (D28: K1 блокує BPMN, але не погодження).
    for (const issue of preparationIssues(versionContent(approved))) fail(issue.code, issue.message);
    for (const issue of notationIssues(versionContent(approved))) fail(issue.code, issue.message);
    if (!(versionContent(approved).process_name ?? '').trim()) {
      fail('PROCESS_NAME_MISSING', 'У погодженій версії немає назви процесу: вона потрібна для напису на пулі, а підставляти назву кейсу не можна. Вкажіть назву — буде створено нову версію, її треба прийняти й погодити.');
    }
  }
  const active = one<{ id: string }>(db, `SELECT id FROM run WHERE case_id = ? AND agent = 'bpmn' AND technical_state IN ('queued','running')`, caseId);
  if (active && !opts.ignoreActiveRun) fail('RUN_ACTIVE', 'Для цього кейсу вже є активний запуск BPMN.');
  return { ok: reasons.length === 0, reasons };
}

/**
 * Проба серверного дозволу: перевіряє `bpmnGuard` і записує відмітку в журнал, нічого не будуючи
 * (технічний стан `not_implemented` — «дозвіл перевірено, роботи не виконано»). Вхід береться з бази
 * за погодженням, а не із запиту.
 *
 * Від 3b-4 продуктовий шлях інший: смислова перевірка (`POST bpmn/review`) → рішення аналітикині
 * (`POST bpmn/findings/reject`) → побудова (`POST bpmn/build`). Ця функція лишається саме як проба
 * дозволу (нею користуються перевірки приймання) і до генерації доступу не має.
 */
export function requestBpmnStart(db: DB, actor: Actor, caseId: string, mode: string): { runId: string; versionId: string; approvalId: string } {
  requireHuman(actor, 'запуск створення BPMN');
  return tx(db, () => {
    const g = bpmnGuard(db, caseId);
    if (!g.ok) throw new DomainError('GUARD_FAILED', 'Запуск BPMN заблоковано сервером.', 409, { reasons: g.reasons });
    const a = currentApproval(db, caseId)!;
    const id = newId('run');
    run(db,
      `INSERT INTO run (id, case_id, agent, instruction_version, mode, model, base_version_id, input_approval_id,
         input_source_ids_json, technical_state, started_at, finished_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, caseId, 'bpmn', 'bpmn-v0.1', mode, 'немає (зріз 1)', a.version_id, a.id,
      getVersion(db, a.version_id).covered_json, 'not_implemented', now(), now(),
      'Дозвіл підтверджено сервером. Побудова виконується окремою дією після смислової перевірки.');
    audit(db, caseId, actor, 'bpmn_start_permitted', { run_id: id, approval_id: a.id, version_id: a.version_id });
    return { runId: id, versionId: a.version_id, approvalId: a.id };
  });
}

// ───────────────────────── картка для UI ─────────────────────────

export interface ChangeItem {
  label: 'Джерело' | 'Питання' | 'Початок' | 'Крок' | 'Межі' | 'Суть' | 'Контекст' | 'Ролі' | 'Проблема' | 'Гіпотеза' | 'Твердження' | 'Конфлікт' | 'Пропозиція' | 'Назва процесу' | 'Нотація';
  text: string;
}

const clip = (t: string, n = 80): string => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

/** Коротка змістовна різниця: «було … → стало …», лише змінений фрагмент із невеликим контекстом. */
export function delta(a: string, b: string): string {
  if (a === b) return '';
  if (!a.trim()) return `додано «${clip(b)}»`;
  if (!b.trim()) return `видалено «${clip(a)}»`;
  if (a.length <= 80 && b.length <= 80) return `було «${a}», стало «${b}»`;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const start = Math.max(0, i - 20);
  const pre = start > 0 ? '…' : '';
  const fa = a.slice(start, a.length - j);
  const fb = b.slice(start, b.length - j);
  return `було «${pre}${clip(fa, 90)}», стало «${pre}${clip(fb, 90)}»`;
}

const trTarget = (c: Content, stepId: string, n: { to: string; condition: string }): string => {
  if (n.to === 'END') return 'кінець процесу';
  if (n.to === UNKNOWN) {
    const ids = questionsAffecting(c, stepId, n.condition).map((q) => q.id);
    return `НЕВІДОМО${ids.length ? ` (питання ${ids.join(', ')})` : ''}`;
  }
  return `крок ${n.to}`;
};

function diffTransitions(pc: Content, cc: Content, ps: Step, cs: Step): string[] {
  const key = (n: { condition: string }) => (n.condition ? `«${n.condition}»` : '(без умови)');
  const pm = new Map(ps.next.map((n) => [key(n), n]));
  const cm = new Map(cs.next.map((n) => [key(n), n]));
  const out: string[] = [];
  for (const [k, n] of cm) {
    const o = pm.get(k);
    if (!o) out.push(`новий перехід ${k} → ${trTarget(cc, cs.id, n)}`);
    else if (o.to !== n.to) out.push(`перехід ${k}: ${trTarget(pc, ps.id, o)} → ${trTarget(cc, cs.id, n)}`);
  }
  for (const [k, o] of pm) if (!cm.has(k)) out.push(`видалено перехід ${k} (було → ${trTarget(pc, ps.id, o)})`);
  return out;
}

export function diffVersions(
  prev: Content | null, cur: Content, prevCovered: string[], curCovered: string[], sourceTitle: (id: string) => string,
): ChangeItem[] {
  const out: ChangeItem[] = [];
  if (!prev) return [{ label: 'Суть', text: 'Перша версія' }];
  for (const id of curCovered) if (!prevCovered.includes(id)) out.push({ label: 'Джерело', text: `Враховано нове джерело «${sourceTitle(id)}»` });

  // 1) питання — найважливіші для рішення
  const pq = new Map(prev.questions.map((q) => [q.id, q]));
  for (const q of cur.questions) {
    const o = pq.get(q.id);
    if (!o) {
      out.push({ label: 'Питання', text: `Нове ${q.critical ? 'критичне ' : ''}питання ${q.id}: «${clip(q.text)}»${q.impact ? ` (вплив: ${clip(q.impact, 60)})` : ''}` });
      continue;
    }
    if (o.status === 'open' && q.status === 'closed') out.push({ label: 'Питання', text: `Закрито ${q.id}: «${clip(q.text, 60)}» — відповідь: «${clip(q.answer)}»` });
    if (o.critical !== q.critical) out.push({ label: 'Питання', text: `${q.id} тепер ${q.critical ? 'критичне' : 'НЕкритичне'}${q.criticality_note ? ` — пояснення: «${clip(q.criticality_note)}»` : ''}` });
    if (o.text !== q.text) out.push({ label: 'Питання', text: `Змінено формулювання ${q.id}: ${delta(o.text, q.text)}` });
  }
  for (const o of prev.questions) if (!cur.questions.some((q) => q.id === o.id)) out.push({ label: 'Питання', text: `Видалено питання ${o.id}: «${clip(o.text)}»` });

  // 2) початковий крок і кроки
  if ((prev.entry_step_id ?? '') !== (cur.entry_step_id ?? '')) {
    const nm = (c: Content): string => (c.entry_step_id ? `${c.entry_step_id} («${clip(c.steps.find((x) => x.id === c.entry_step_id)?.action ?? '', 50)}»)` : 'не задано');
    out.push({ label: 'Початок', text: `Початковий крок: було ${nm(prev)}, стало ${nm(cur)}` });
  }
  const ps = new Map(prev.steps.map((x) => [x.id, x]));
  const cs = new Map(cur.steps.map((x) => [x.id, x]));
  for (const [id, x] of cs) {
    const o = ps.get(id);
    if (!o) {
      out.push({ label: 'Крок', text: `Додано ${id} (${x.role}): «${clip(x.action, 60)}» → результат «${clip(x.result, 40)}»; далі: ${x.next.map((n) => `${n.condition ? n.condition + ' → ' : ''}${trTarget(cur, id, n)}`).join('; ')}` });
      continue;
    }
    const parts: string[] = [];
    if (o.role !== x.role) parts.push(`роль: ${o.role} → ${x.role}`);
    if (o.action !== x.action) parts.push(`дія: ${delta(o.action, x.action)}`);
    if (o.result !== x.result) parts.push(`результат: ${delta(o.result, x.result)}`);
    if (o.entry_condition !== x.entry_condition) parts.push(`умова входу: ${delta(o.entry_condition, x.entry_condition)}`);
    parts.push(...diffTransitions(prev, cur, o, x));
    if (parts.length) out.push({ label: 'Крок', text: `${id}: ${parts.join('; ')}` });
  }
  for (const [id, o] of ps) if (!cs.has(id)) out.push({ label: 'Крок', text: `Видалено ${id}: «${clip(o.action, 60)}»` });

  const pprop = new Map((prev.step_proposals ?? []).map((x) => [x.id, x]));
  for (const p of cur.step_proposals ?? []) {
    const o = pprop.get(p.id);
    const what = `${p.action === 'remove' ? 'вилучити' : 'замінити'} крок ${p.step_id}${p.action === 'replace' ? ` на ${p.replacement_step_id}` : ''}`;
    if (!o) out.push({ label: 'Пропозиція', text: `Агент пропонує ${what}: «${clip(p.reason, 80)}» (потрібне ваше рішення)` });
    else if (o.status !== p.status) out.push({ label: 'Пропозиція', text: `Пропозицію ${p.id} (${what}) ${p.status === 'accepted' ? 'прийнято' : 'відхилено'}${p.decision_note ? `: «${clip(p.decision_note, 60)}»` : ''}` });
  }

  // назва процесу й вимоги до нотації (D61, D62)
  if ((prev.process_name ?? '') !== (cur.process_name ?? '')) {
    out.push({ label: 'Назва процесу', text: `було «${prev.process_name || 'не зазначено'}», стало «${cur.process_name || 'не зазначено'}»` });
  }
  const preq = new Map((prev.notation_requirements ?? []).map((x) => [x.id, x]));
  for (const r of cur.notation_requirements ?? []) {
    const o = preq.get(r.id);
    const what = `${NOTATION_KIND_LABEL[r.kind]} (крок ${r.step_id})`;
    if (!o) out.push({ label: 'Нотація', text: r.origin === 'agent' ? `Агент пропонує вимогу ${r.id}: ${what} — «${clip(r.detail, 80)}» (потрібне ваше рішення)` : `Додано вимогу ${r.id}: ${what} — «${clip(r.detail, 80)}»` });
    else if (o.status !== r.status) out.push({ label: 'Нотація', text: `Вимогу ${r.id} (${what}) ${r.status === 'confirmed' ? 'підтверджено' : 'відхилено'}${r.decision_note ? `: «${clip(r.decision_note, 60)}»` : ''}` });
  }
  for (const o of prev.notation_requirements ?? []) {
    if (!(cur.notation_requirements ?? []).some((r) => r.id === o.id)) out.push({ label: 'Нотація', text: `Прибрано вимогу ${o.id}: ${NOTATION_KIND_LABEL[o.kind]} (крок ${o.step_id})` });
  }

  // 3) межі, суть, контекст, ролі
  const BL = { trigger: 'тригер', input: 'вхід', completion: 'фактичне завершення', result: 'результат' } as const;
  for (const k of ['trigger', 'input', 'completion', 'result'] as const) {
    if (prev.boundaries[k] !== cur.boundaries[k]) out.push({ label: 'Межі', text: `${BL[k]}: ${delta(prev.boundaries[k], cur.boundaries[k])}` });
  }
  if (prev.summary !== cur.summary) out.push({ label: 'Суть', text: delta(prev.summary, cur.summary) });
  if (prev.business_context !== cur.business_context) out.push({ label: 'Контекст', text: delta(prev.business_context, cur.business_context) });
  const addedRoles = cur.roles.filter((r) => !prev.roles.includes(r));
  const removedRoles = prev.roles.filter((r) => !cur.roles.includes(r));
  if (addedRoles.length) out.push({ label: 'Ролі', text: `Додано: ${addedRoles.join(', ')}` });
  if (removedRoles.length) out.push({ label: 'Ролі', text: `Видалено: ${removedRoles.join(', ')}` });

  // 4) проблеми, гіпотези, твердження
  const pp = new Map(prev.problems.map((x) => [x.id, x]));
  for (const x of cur.problems) {
    const o = pp.get(x.id);
    if (!o) out.push({ label: 'Проблема', text: `Нова ${x.id}: «${clip(x.symptom, 60)}»; вплив: «${clip(x.impact, 60)}»` });
    else {
      const parts: string[] = [];
      if (o.symptom !== x.symptom) parts.push(`симптом: ${delta(o.symptom, x.symptom)}`);
      if (o.cause !== x.cause) parts.push(`причина: ${delta(o.cause, x.cause)}`);
      if (o.impact !== x.impact) parts.push(`вплив: ${delta(o.impact, x.impact)}`);
      if (parts.length) out.push({ label: 'Проблема', text: `${x.id}: ${parts.join('; ')}` });
    }
  }
  const ph = new Map(prev.hypotheses.map((x) => [x.id, x]));
  const HS = { open: 'відкрита', supported: 'підтримана', refuted: 'спростована', confirmed: 'підтверджена' } as const;
  for (const x of cur.hypotheses) {
    const o = ph.get(x.id);
    if (!o) out.push({ label: 'Гіпотеза', text: `Нова ${x.id}: «${clip(x.text)}»` });
    else if (o.status !== x.status) out.push({ label: 'Гіпотеза', text: `${x.id}: ${HS[o.status]} → ${HS[x.status]}` });
  }
  const pcl = new Map(prev.claims.map((x) => [x.id, x]));
  for (const x of cur.claims) {
    const o = pcl.get(x.id);
    if (!o) out.push({ label: 'Твердження', text: `Нове ${x.id} (${CLAIM_TYPE_LABEL[x.type]}): «${clip(x.text)}»` });
    else if (o.type !== x.type) out.push({ label: 'Твердження', text: `${x.id}: тип ${CLAIM_TYPE_LABEL[o.type]} → ${CLAIM_TYPE_LABEL[x.type]}` });
  }
  if (cur.conflicts.length > prev.conflicts.length) {
    for (const cf of cur.conflicts.slice(prev.conflicts.length)) out.push({ label: 'Конфлікт', text: `${cf.key}: збережено «${clip(cf.kept, 50)}», агент пропонував «${clip(cf.proposed, 50)}»` });
  }
  return out;
}

// ───────────────── огляд стану чернетки (окремо від змістових прогалин) ─────────────────

const GAP_CODES = new Set(['PENDING_STEP_PROPOSAL', 'PENDING_NOTATION_PROPOSAL', 'NOTATION_BAD_STEP', 'CRITICAL_QUESTION', 'UNRESOLVED_TRANSITION', 'UNKNOWN_WITHOUT_QUESTION', 'UNKNOWN_QUESTION_CLOSED', 'CONTRADICTION', 'QUESTION_LINK_BROKEN', 'ENTRY_MISSING', 'ENTRY_BAD_REF', 'STEP_UNREACHABLE', 'STEP_NO_EXIT', 'SEQUENCE_UNCONFIRMED']);
const STRUCTURE_CODES = new Set(['BOUNDARY_MISSING', 'NO_ROLES', 'NO_STEPS', 'STEP_INCOMPLETE', 'STEP_UNKNOWN_ROLE', 'STEP_NO_NEXT', 'STEP_BAD_NEXT', 'STEP_NO_CONDITION', 'PROBLEM_NO_IMPACT']);

/** Критичні змістові прогалини: чого про процес ще не з’ясовано або де опис суперечить сам собі. */
export function criticalGaps(blockers: Blocker[]): Blocker[] {
  return blockers.filter((b) => b.severity === 'critical' && GAP_CODES.has(b.code));
}

export interface GapItem {
  key: string;
  kind: 'question_with_transitions' | 'question' | 'transition' | 'other';
  /** Коди програмних перевірок, що лежать в основі цієї прогалини (самі перевірки лишаються окремо). */
  codes: string[];
  title: string;
  text: string;
  question_id: string | null;
  impact: string;
  /** Наслідки для кроків процесу. */
  consequences: { step_id: string; condition: string; step_action: string; text: string }[];
  ref: string | null;
}

/**
 * Змістовні прогалини для людини: критичне питання й невизначений перехід, які стосуються одного місця опису,
 * показуються як ОДНА прогалина з наслідками для кроків. Програмні перевірки (blockers, flow) лишаються окремо й не змінюються.
 */
export function gapItems(gaps: Blocker[], c: Content): GapItem[] {
  const unresolved: { step_id: string; condition: string; action: string; open: Question[] }[] = [];
  for (const st of c.steps) {
    for (const n of st.next) {
      if (n.to !== UNKNOWN) continue;
      const open = questionsAffecting(c, st.id, n.condition).filter((q) => q.status === 'open');
      if (open.length) unresolved.push({ step_id: st.id, condition: n.condition, action: st.action, open });
    }
  }
  const critIds = new Set(gaps.filter((g) => g.code === 'CRITICAL_QUESTION').map((g) => g.ref));
  const out: GapItem[] = [];
  for (const g of gaps) {
    if (g.code === 'CRITICAL_QUESTION') {
      const q = c.questions.find((x) => x.id === g.ref);
      const cons = unresolved.filter((u) => u.open.some((x) => x.id === g.ref));
      out.push({
        key: `q:${g.ref}`, kind: cons.length ? 'question_with_transitions' : 'question',
        codes: cons.length ? ['CRITICAL_QUESTION', 'UNRESOLVED_TRANSITION'] : ['CRITICAL_QUESTION'],
        title: cons.length ? 'Критичне питання з наслідками для кроків' : 'Критичне питання',
        text: q ? `${q.id}: ${q.text}` : g.message, question_id: g.ref ?? null, impact: q?.impact ?? '',
        consequences: cons.map((u) => ({
          step_id: u.step_id, condition: u.condition, step_action: u.action,
          text: `Крок ${u.step_id}${u.condition ? ` (${u.condition})` : ''}: далі — невідомо; процес після цього моменту не з’ясовано.`,
        })),
        ref: g.ref ?? null,
      });
    } else if (g.code === 'UNRESOLVED_TRANSITION') {
      const mine = unresolved.filter((u) => u.step_id === g.ref && g.message.includes(condText(u.condition)));
      if (mine.length && mine.every((u) => u.open.some((x) => critIds.has(x.id)))) continue; // уже показано разом із питанням
      out.push({
        key: `t:${g.ref}:${mine[0]?.condition ?? ''}`, kind: 'transition', codes: [g.code], title: 'Невизначений перехід', text: g.message,
        question_id: mine[0]?.open[0]?.id ?? null, impact: '',
        consequences: mine.map((u) => ({ step_id: u.step_id, condition: u.condition, step_action: u.action, text: `Крок ${u.step_id}${u.condition ? ` (${u.condition})` : ''}: далі — невідомо.` })),
        ref: g.ref ?? null,
      });
    } else {
      out.push({ key: `${g.code}:${g.ref ?? ''}`, kind: 'other', codes: [g.code], title: 'Прогалина', text: g.message, question_id: null, impact: '', consequences: [], ref: g.ref ?? null });
    }
  }
  return out;
}

export interface ReviewCheck {
  key: string;
  label: string;
  status: 'ok' | 'fail' | 'warn';
  status_text: 'Пройдено' | 'Не пройдено' | 'Увага';
  detail: string;
}

/** Статус перевірки чернетки: що вже пройдено, а що ні, перш ніж передавати на погодження. */
export function draftReview(
  blockers: Blocker[], opts: { accepted: boolean; integrityOk: boolean; readable: number; covered: number },
): { checks: ReviewCheck[]; ready: boolean; ready_text: string } {
  const mk = (key: string, label: string, status: ReviewCheck['status'], detail: string): ReviewCheck => ({
    key, label, status, detail, status_text: status === 'ok' ? 'Пройдено' : status === 'fail' ? 'Не пройдено' : 'Увага',
  });
  const by = (f: (b: Blocker) => boolean) => blockers.filter(f);
  const structure = by((b) => STRUCTURE_CODES.has(b.code));
  const gaps = criticalGaps(blockers);
  const unreadCrit = by((b) => b.code === 'UNREAD_SOURCE' && b.severity === 'critical');
  const unreadWarn = by((b) => b.code === 'UNREAD_SOURCE' && b.severity === 'warning');
  const uncovered = by((b) => b.code === 'UNCOVERED_SOURCE');
  const conflicts = by((b) => b.code === 'CONFLICTS_PRESENT');
  const noName = by((b) => b.code === 'PROCESS_NAME_MISSING');
  const prep = by((b) => b.code === 'SINGLE_CONDITIONAL_BRANCH');
  const pendingNotation = by((b) => b.code === 'PENDING_NOTATION_PROPOSAL' || b.code === 'NOTATION_BAD_STEP');
  const checks: ReviewCheck[] = [
    mk('accepted', 'Робочу версію прийнято аналітиком', opts.accepted ? 'ok' : 'fail', opts.accepted ? 'Так (це не погодження AS-IS)' : 'Ні — прийняття ще не відбулося'),
    mk('sources', 'Усі прочитані джерела враховано у версії', uncovered.length ? 'fail' : 'ok', `${opts.covered} з ${opts.readable}${uncovered.length ? ' — не враховано: ' + uncovered.map((b) => b.message.replace(/^Джерело /, '').replace(/ не враховано в цій версії\.$/, '')).join(', ') : ''}`),
    mk('reading', 'Файли прочитано', unreadCrit.length ? 'fail' : unreadWarn.length ? 'warn' : 'ok',
      unreadCrit.length ? `Не прочитано обов’язкових: ${unreadCrit.length}` : unreadWarn.length ? `Не прочитано необов’язкових: ${unreadWarn.length}` : 'Усе прочитано'),
    mk('structure', 'Структурна повнота: межі, ролі, кроки, переходи, вплив проблем', structure.length ? 'fail' : 'ok',
      structure.length ? structure.slice(0, 3).map((b) => b.message).join(' · ') + (structure.length > 3 ? ` · …ще ${structure.length - 3}` : '') : 'Пропусків не виявлено'),
    mk('gaps', 'Критичних прогалин немає', gaps.length ? 'fail' : 'ok', gaps.length ? `Відкрито прогалин: ${gaps.length} (див. блок «Критичні прогалини»)` : 'Немає'),
    mk('integrity', 'Цілісність версії (хеш збігається зі змістом)', opts.integrityOk ? 'ok' : 'fail', opts.integrityOk ? 'Так' : 'Порушена: не використовуйте цю версію'),
    mk('process_name', 'Назву процесу зазначено (потрібна перед побудовою схеми)', noName.length ? 'warn' : 'ok', noName.length ? 'Не зазначено — не блокує погодження, але схему без назви не побудувати' : 'Так'),
    mk('conditions', 'Переходи придатні до побудови схеми (немає єдиного переходу з умовою)', prep.length ? 'warn' : 'ok', prep.length ? prep.slice(0, 2).map((b) => b.message).join(' · ') + (prep.length > 2 ? ` · …ще ${prep.length - 2}` : '') : 'Так'),
    mk('notation', 'Пропозиції агента щодо нотації мають рішення', pendingNotation.length ? 'fail' : 'ok', pendingNotation.length ? pendingNotation.map((b) => b.message).slice(0, 2).join(' · ') : 'Немає відкритих'),
    mk('conflicts', 'Конфлікти між правками аналітика й агента', conflicts.length ? 'warn' : 'ok', conflicts.length ? conflicts[0]!.message : 'Немає'),
  ];
  const ready = checks.every((c) => c.status !== 'fail');
  return { checks, ready, ready_text: ready ? 'Чернетка готова до передачі на погодження' : 'Чернетка ще не готова до передачі на погодження' };
}

export interface NextAction {
  key: string;
  label: string;
  hint: string;
  enabled: boolean;
  disabledReason?: string;
}

function computeNextAction(state: CaseState, blockers: Blocker[], accepted: boolean, bpmn: GuardResult): NextAction {
  const crit = criticalBlockers(blockers);
  if (state === 'research') {
    const q = crit.filter((b) => b.code === 'CRITICAL_QUESTION');
    if (q.length) return { key: 'resolve_blockers', enabled: true, label: `Закрити критичні питання (${q.length})`,
      hint: 'Отримайте відповідь від людей, які знають процес, і додайте її як уточнення.' };
    const other = crit.filter((b) => b.code !== 'NOT_ACCEPTED');
    if (other.length) return { key: 'resolve_blockers', enabled: true, label: `Усунути блокери (${other.length})`,
      hint: 'Заповніть відсутні дані або враховуйте нові матеріали та збережіть нову версію.' };
    // Для одного користувача службові переходи «прийняти» й «передати» окремими діями не показуємо:
    // їх виконує сервер в одній транзакції разом із погодженням (D97). Перевірки ті самі.
    return { key: 'approve', enabled: true, label: 'Погодити версію',
      hint: 'Блокерів немає. Погодження прив’язується до цієї версії; зміна після нього потребує нового погодження.' };
  }
  if (state === 'pending_approval') {
    if (crit.length) return { key: 'resolve_blockers', enabled: true, label: `Усунути блокери (${crit.length})`,
      hint: 'Цю версію не можна погодити, доки є блокери. Правка створить нову версію й поверне кейс до дослідження.' };
    return { key: 'approve', enabled: true, label: 'Погодити цю версію AS-IS',
      hint: 'Погодження прив’язується до цієї незмінної версії. Якщо є сумніви — поверніть на доопрацювання.' };
  }
  if (state === 'approved') {
    if (bpmn.reasons.some((r) => r.code === 'ENTRY_MISSING' || r.code === 'ENTRY_BAD_REF')) {
      return { key: 'clarify_entry', enabled: true, label: 'Уточнити початковий крок',
        hint: 'У погодженому описі немає (або хибний) початковий крок. Погоджений пакет не змінюється: ви задаєте крок вручну, створюється нова версія, і для неї потрібне нове погодження.',
        disabledReason: bpmn.reasons.map((r) => r.message).join(' ') };
    }
    if (bpmn.reasons.some((r) => r.code === 'PROCESS_NAME_MISSING') && !bpmn.reasons.some((r) => FLOW_CODES.has(r.code) || r.code.startsWith('UNKNOWN') || r.code.startsWith('ENTRY'))) {
      return { key: 'clarify_process_name', enabled: true, label: 'Уточнити назву процесу',
        hint: 'У погодженому описі немає назви процесу. Погоджений пакет не змінюється: ви вказуєте назву вручну, створюється нова версія, і для неї потрібне нове погодження. Назву кейсу в схему не підставляємо.',
        disabledReason: bpmn.reasons.map((r) => r.message).join(' ') };
    }
    if (bpmn.reasons.some((r) => FLOW_CODES.has(r.code) || r.code.includes('TRANSITION') || r.code.startsWith('UNKNOWN'))) {
      return { key: 'fix_flow', enabled: true, label: 'Виправити опис потоку (потрібна нова версія)',
        hint: 'Погоджений опис не дозволяє побудувати коректний потік. Виправлення створює нову версію й потребує нового погодження.',
        disabledReason: bpmn.reasons.map((r) => r.message).join(' ') };
    }
    return { key: 'start_bpmn', enabled: bpmn.ok, label: 'Перейти до схеми: смислова перевірка й побудова',
      hint: 'Серверний дозвіл надано. Далі — смислова перевірка опису моделлю, ваші рішення щодо зауважень і побудова схеми (вкладка «Схема»).',
      disabledReason: bpmn.ok ? undefined : bpmn.reasons.map((r) => r.message).join(' ') };
  }
  return { key: 'none', enabled: false, label: 'Немає дій', hint: '' };
}

export function buildCard(db: DB, caseId: string, mode: string) {
  const c = getCase(db, caseId);
  const head = headVersion(db, caseId);
  const content = versionContent(head);
  const sources = listSources(db, caseId);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const parent = head.parent_id ? getVersion(db, head.parent_id) : null;
  const changes = diffVersions(
    parent ? versionContent(parent) : null, content,
    parent ? (JSON.parse(parent.covered_json) as string[]) : [], JSON.parse(head.covered_json) as string[],
    (id) => byId.get(id)?.title ?? id,
  );
  const blockers = submissionBlockers(db, caseId);
  const accepted = isAccepted(db, head.id);
  const integrityOk = verifyVersionIntegrity(db, head.id);
  const bpmn = bpmnGuard(db, caseId);
  const covered = new Set(JSON.parse(head.covered_json) as string[]);
  const criticalOpen = content.questions.filter((q) => q.status === 'open' && q.critical);

  const claims = content.claims.map((cl) => {
    const src = cl.source_id ? byId.get(cl.source_id) : undefined;
    const m = src && cl.quote ? findQuote(src.content, cl.quote) : null;
    return {
      ...cl,
      type_label: CLAIM_TYPE_LABEL[cl.type],
      source_title: src?.title ?? null,
      source_ref: src?.ref ?? null,
      quote_check: !cl.source_id || !cl.quote ? 'no_quote' : m && m.kind !== 'not_found' ? 'quote_found' : 'quote_not_found',
      quote_exact: m?.kind === 'exact',
      quote_elided: m?.kind === 'elided',
      quote_start: m?.kind === 'exact' ? m.index : null,
    };
  });

  return {
    mode,
    case: { id: c.id, title: c.title, state: c.state, state_label: STATE_LABEL[c.state], is_demo_script: c.is_demo_script === 1 },
    head: {
      id: head.id, number: head.number, created_by: head.created_by, actor_name: head.actor_name, mode: head.mode,
      created_at: head.created_at, accepted, integrity_ok: integrityOk, note: head.note,
      hash: head.content_hash, content,
    },
    changes,
    blockers,
    gaps: criticalGaps(blockers),
    gap_items: gapItems(criticalGaps(blockers), content),
    unknown_transitions: unknownTransitions(content),
    review: draftReview(blockers, {
      accepted, integrityOk,
      readable: sources.filter((x) => x.read_status === 'ok').length,
      covered: sources.filter((x) => x.read_status === 'ok' && covered.has(x.id)).length,
    }),
    critical_open_questions: criticalOpen,
    other_open_questions_count: content.questions.filter((q) => q.status === 'open' && !q.critical).length,
    next_action: computeNextAction(c.state, blockers, accepted, bpmn),
    bpmn_guard: bpmn,
    // `origin` тут — ЧИННЕ походження (з урахуванням виправлень, D77); позначка показує, що воно було виправлене.
    sources: (() => {
      const corrected = new Set(originCorrections(db, caseId).map((x) => x.source_id));
      return sources.map((s) => ({
        id: s.id, ref: s.ref, title: s.title, kind: s.kind, origin: s.origin, origin_corrected: corrected.has(s.id),
        required: s.required === 1, read_status: s.read_status,
        read_error: s.read_error, author: s.author, added_at: s.added_at, covered: covered.has(s.id),
        // Підстава уточнення (D93): три ознаки окремо — звідки факт, хто правив текст, чим є твердження.
        derived_from_source_id: s.derived_from_source_id, derived_quote: s.derived_quote,
        edited_by: s.edited_by, content_type: s.content_type,
        content_type_label: s.content_type ? ANSWER_CONTENT_TYPE_LABEL[s.content_type] : null,
      }));
    })(),
    claims,
    versions: all<VersionRow>(db, 'SELECT * FROM as_is_version WHERE case_id = ? ORDER BY number DESC', caseId).map((v) => ({
      id: v.id, number: v.number, kind: v.kind, created_by: v.created_by, actor_name: v.actor_name, mode: v.mode,
      created_at: v.created_at, note: v.note, accepted: isAccepted(db, v.id), is_head: v.id === head.id,
    })),
    approval: currentApproval(db, caseId) ?? null,
    approvals_history: all(db,
      `SELECT a.id, a.version_id, a.approver, a.created_at, r.reason AS revoked_reason, r.revoked_at
         FROM approval a LEFT JOIN approval_revocation r ON r.approval_id = a.id WHERE a.case_id = ? ORDER BY a.created_at DESC`, caseId),
    runs: all(db, 'SELECT * FROM run WHERE case_id = ? ORDER BY started_at DESC LIMIT 20', caseId),
    audit: all(db, 'SELECT at, actor, action, details_json FROM audit_log WHERE case_id = ? ORDER BY id DESC LIMIT 40', caseId),
    proposal_previews: previewProposals(content, { caseId, versionId: head.id }),
    // Прив'язки відкритих питань до кроків, яких немає (D82): показ і наслідки для кожної — з програми, а не з браузера.
    stale_links: staleQuestionLinks(content).map((x) => ({ ...x, preview: previewUnlink(content, x.question_id, x.step_id, x.condition) })),
    link_kinds: LINK_KIND_LABEL,
    cause_statuses: CAUSE_STATUS_LABEL,
    // Підстава причини проблеми (D70): видно, що сказало джерело, що є гіпотезою агента, а де причину не з'ясовано.
    problems_view: content.problems.map((p) => {
      const src = p.cause_source_id ? byId.get(p.cause_source_id) : undefined;
      const m = src && p.cause_quote ? findQuote(src.content, p.cause_quote) : null;
      return {
        ...p,
        cause_source_title: src?.title ?? null,
        cause_quote_check: m ? (m.kind === 'not_found' ? 'quote_not_found' : 'quote_found') : null,
        cause_hypothesis_check: p.cause_hypothesis_id
          ? content.hypotheses.find((h) => h.id === p.cause_hypothesis_id && h.check_method.trim()) ? 'ok' : 'missing'
          : null,
      };
    }),
    step_proposals: (content.step_proposals ?? []).map((p) => {
      const src = byId.get(p.evidence_source_id);
      const m = src && p.evidence_quote ? findQuote(src.content, p.evidence_quote) : null;
      return {
        ...p,
        step_action: content.steps.find((x) => x.id === p.step_id)?.action ?? null,
        step_exists: content.steps.some((x) => x.id === p.step_id),
        step_analyst_edited: (JSON.parse(head.owned_json) as string[]).includes(`step:${p.step_id}`),
        evidence_title: src?.title ?? null,
        evidence_check: m && m.kind !== 'not_found' ? 'quote_found' : 'quote_not_found',
      };
    }),
    process_name: { value: content.process_name ?? '', defined: !!(content.process_name ?? '').trim() },
    notation_kinds: NOTATION_KIND_LABEL,
    notation_requirements: (content.notation_requirements ?? []).map((r) => {
      const src = byId.get(r.evidence_source_id);
      const m = src && r.evidence_quote ? findQuote(src.content, r.evidence_quote) : null;
      return {
        ...r,
        kind_label: NOTATION_KIND_LABEL[r.kind],
        step_action: content.steps.find((x) => x.id === r.step_id)?.action ?? null,
        step_exists: content.steps.some((x) => x.id === r.step_id),
        evidence_title: src?.title ?? null,
        evidence_check: !r.evidence_quote ? 'no_quote' : m && m.kind !== 'not_found' ? 'quote_found' : 'quote_not_found',
      };
    }),
    entry: {
      id: content.entry_step_id ?? null,
      defined: !!content.entry_step_id && content.steps.some((x) => x.id === content.entry_step_id),
      legacy: content.entry_step_id === undefined,
    },
    editable: {
      entry_step_id: content.entry_step_id ?? '',
      process_name: content.process_name ?? '',
      summary: content.summary,
      business_context: content.business_context,
      boundaries: content.boundaries,
      roles_text: rolesToText(content.roles),
      steps_text: stepsToText(content.steps),
      problems_text: problemsToText(content.problems),
    },
  };
}

export function listCases(db: DB) {
  return all<CaseRow>(db, 'SELECT * FROM "case" ORDER BY created_at DESC').map((c) => ({
    id: c.id, title: c.title, state: c.state, state_label: STATE_LABEL[c.state], mode: c.mode, is_demo_script: c.is_demo_script === 1,
    created_at: c.created_at,
  }));
}

export type { Step, Question };
