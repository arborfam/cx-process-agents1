import { randomUUID } from 'node:crypto';
import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import { canonical, sha256 } from './hash.ts';
import { CLAIM_TYPE_LABEL, ContentSchema, UNKNOWN, emptyContent, parseContent, type Content, type Question, type Step } from './schema.ts';
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
}

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

export function listSources(db: DB, caseId: string): SourceRow[] {
  return all<SourceRow>(db, 'SELECT * FROM source WHERE case_id = ? ORDER BY seq', caseId);
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
    n.createdBy, n.actorName, c.mode, n.runId ?? null, n.note ?? '', now());
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
  return v === undefined ? '(немає)' : v;
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
      const f = key.slice('boundaries.'.length) as keyof Content['boundaries'];
      result.boundaries[f] = base.boundaries[f];
    } else if (key === 'roles') result.roles = [...base.roles];
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

export function createCase(db: DB, actor: Actor, title: string, mode: string, opts: { demoScript?: boolean } = {}): CaseRow {
  requireHuman(actor, 'створення кейсу');
  const t = title.trim();
  if (!t) throw new DomainError('VALIDATION', 'Назва кейсу не може бути порожньою', 400);
  return tx(db, () => {
    const id = newId('case');
    run(db, 'INSERT INTO "case" (id, title, state, head_version_id, mode, is_demo_script, created_at) VALUES (?,?,?,?,?,?,?)',
      id, t, 'research', null, mode, opts.demoScript ? 1 : 0, now());
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
      `INSERT INTO source (id, case_id, seq, kind, title, content, content_hash, author, origin, required, read_status, read_error, added_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, caseId, (seqRow?.m ?? 0) + 1, s.kind, title, s.content, sha256(s.content), actor.name,
      s.origin ?? 'real', s.required ? 1 : 0, status, s.readError ?? null, now());
    audit(db, caseId, actor, 'source_added', { source_id: id, kind: s.kind, read_status: status, required: !!s.required });
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
  input: { baseVersionId: string; text: string; critical: boolean; impact: string; addressee?: string; affects?: { step_id: string; condition: string }[] },
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
      ...(affects.length ? { affects_transitions: affects.map((a) => ({ step_id: a.step_id, condition: a.condition })) } : {}),
    });
    return commitAnalystVersion(db, actor, caseId, head, c, JSON.parse(head.covered_json) as string[],
      `Додано ${input.critical ? 'критичне ' : ''}питання`);
  });
}

/** Уточнення = нове джерело (автор і дата) + нова версія, де питання закрите з посиланням на це джерело. */
export function answerQuestion(
  db: DB, actor: Actor, caseId: string,
  input: { baseVersionId: string; questionId: string; answer: string },
): VersionRow {
  requireHuman(actor, 'відповідь на питання');
  if (!input.answer.trim()) throw new DomainError('VALIDATION', 'Текст уточнення порожній', 400);
  return tx(db, () => {
    const head = assertBase(db, caseId, input.baseVersionId);
    const c = versionContent(head);
    const q = c.questions.find((x) => x.id === input.questionId);
    if (!q) throw new DomainError('NOT_FOUND', 'Питання не знайдено', 404);
    if (q.status === 'closed') throw new DomainError('VALIDATION', 'Питання вже закрите', 400);
    const demo = getCase(db, caseId).is_demo_script === 1;
    const src = addSource(db, actor, caseId, {
      kind: 'clarification', title: `Уточнення до ${q.id} (${actor.name})`, content: input.answer.trim(),
      origin: demo ? 'synthetic' : 'real',
    });
    q.status = 'closed';
    q.answer = input.answer.trim();
    q.closed_by_source_id = src.id;
    const covered = [...(JSON.parse(head.covered_json) as string[]), src.id];
    return commitAnalystVersion(db, actor, caseId, head, c, covered, `Закрито питання ${q.id} уточненням`);
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

// ───────────────────────── перевірки перед погодженням ─────────────────────────

export function submissionBlockers(db: DB, caseId: string): Blocker[] {
  const head = headVersion(db, caseId);
  const c = versionContent(head);
  const out: Blocker[] = [];
  const covered = new Set(JSON.parse(head.covered_json) as string[]);

  if (!isAccepted(db, head.id)) {
    out.push({ code: 'NOT_ACCEPTED', severity: 'critical', message: `Робочу версію ${head.number} ще не прийнято аналітиком.` });
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
  if (c.conflicts.length > 0) {
    out.push({ code: 'CONFLICTS_PRESENT', severity: 'warning', message: `Є конфлікти між правками аналітика й агента: ${c.conflicts.length}. Перегляньте обидва варіанти.` });
  }
  return out;
}

// ───────────────────── невизначені переходи ─────────────────────

const condText = (cond: string): string => (cond ? `«${cond}»` : '(без умови)');

/** Питання, що стосуються переходу (крок, умова). */
export function questionsAffecting(c: Content, stepId: string, condition: string): Question[] {
  return c.questions.filter((q) => (q.affects_transitions ?? []).some((a) => a.step_id === stepId && a.condition === condition));
}

/**
 * Правила «невідоме не стає фактом». Усі порушення критичні (це прогалини у ході процесу):
 *  • перехід «невідомо» без питання, з закритим питанням, або з відкритим питанням (залишається прогалиною);
 *  • відкрите питання про перехід, який поданий як встановлений (наприклад, END) — суперечність;
 *  • відкрите питання посилається на перехід, якого в описі немає.
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
            message: `Крок ${s.id}: перехід ${condText(n.condition)} позначено «невідомо», але немає питання, яке б це з’ясовувало. Додайте питання.` });
        } else if (open.length === 0) {
          out.push({ code: 'UNKNOWN_QUESTION_CLOSED', severity: 'critical', ref: s.id,
            message: `Крок ${s.id}: перехід ${condText(n.condition)} досі «невідомо», хоча питання ${linked.map((q) => q.id).join(', ')} закрито. Оновіть крок відповідно до уточнення.` });
        } else {
          out.push({ code: 'UNRESOLVED_TRANSITION', severity: 'critical', ref: s.id,
            message: `Крок ${s.id}: перехід ${condText(n.condition)} невизначений — див. питання ${open.map((q) => q.id).join(', ')}.` });
        }
      } else if (open.length > 0) {
        out.push({ code: 'CONTRADICTION', severity: 'critical', ref: open[0]!.id,
          message: `Суперечність: питання ${open.map((q) => q.id).join(', ')} про перехід ${condText(n.condition)} кроку ${s.id} відкрите, але перехід поданий як встановлений (→ ${n.to}). Невідоме не можна записувати як факт.` });
      }
    }
  }
  for (const q of c.questions) {
    if (q.status !== 'open') continue;
    for (const a of q.affects_transitions ?? []) {
      const exists = c.steps.some((s) => s.id === a.step_id && s.next.some((n) => n.condition === a.condition));
      if (!exists) {
        out.push({ code: 'QUESTION_LINK_BROKEN', severity: 'critical', ref: q.id,
          message: `Питання ${q.id} стосується переходу ${condText(a.condition)} кроку ${a.step_id}, якого в описі немає (змінено умову чи крок?).` });
      }
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
export function bpmnGuard(db: DB, caseId: string): GuardResult {
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
  }
  const active = one<{ id: string }>(db, `SELECT id FROM run WHERE case_id = ? AND agent = 'bpmn' AND technical_state IN ('queued','running')`, caseId);
  if (active) fail('RUN_ACTIVE', 'Для цього кейсу вже є активний запуск BPMN.');
  return { ok: reasons.length === 0, reasons };
}

/**
 * Зріз 1: перевіряє дозвіл і записує запуск. Побудови BPMN ще немає (зріз 3),
 * тому запуск має технічний стан not_implemented. Вхід береться з бази за погодженням,
 * а не із запиту.
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
      'Дозвіл підтверджено сервером. Побудову BPMN буде додано у зрізі 3.');
    audit(db, caseId, actor, 'bpmn_start_permitted', { run_id: id, approval_id: a.id, version_id: a.version_id });
    return { runId: id, versionId: a.version_id, approvalId: a.id };
  });
}

// ───────────────────────── картка для UI ─────────────────────────

export interface ChangeItem {
  label: 'Джерело' | 'Питання' | 'Крок' | 'Межі' | 'Суть' | 'Контекст' | 'Ролі' | 'Проблема' | 'Гіпотеза' | 'Твердження' | 'Конфлікт';
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

  // 2) кроки
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

const GAP_CODES = new Set(['CRITICAL_QUESTION', 'UNRESOLVED_TRANSITION', 'UNKNOWN_WITHOUT_QUESTION', 'UNKNOWN_QUESTION_CLOSED', 'CONTRADICTION', 'QUESTION_LINK_BROKEN']);
const STRUCTURE_CODES = new Set(['BOUNDARY_MISSING', 'NO_ROLES', 'NO_STEPS', 'STEP_INCOMPLETE', 'STEP_UNKNOWN_ROLE', 'STEP_NO_NEXT', 'STEP_BAD_NEXT', 'STEP_NO_CONDITION', 'PROBLEM_NO_IMPACT']);

/** Критичні змістові прогалини: чого про процес ще не з’ясовано або де опис суперечить сам собі. */
export function criticalGaps(blockers: Blocker[]): Blocker[] {
  return blockers.filter((b) => b.severity === 'critical' && GAP_CODES.has(b.code));
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
  const checks: ReviewCheck[] = [
    mk('accepted', 'Робочу версію прийнято аналітиком', opts.accepted ? 'ok' : 'fail', opts.accepted ? 'Так (це не погодження AS-IS)' : 'Ні — прийняття ще не відбулося'),
    mk('sources', 'Усі прочитані джерела враховано у версії', uncovered.length ? 'fail' : 'ok', `${opts.covered} з ${opts.readable}${uncovered.length ? ' — не враховано: ' + uncovered.map((b) => b.message.replace(/^Джерело /, '').replace(/ не враховано в цій версії\.$/, '')).join(', ') : ''}`),
    mk('reading', 'Файли прочитано', unreadCrit.length ? 'fail' : unreadWarn.length ? 'warn' : 'ok',
      unreadCrit.length ? `Не прочитано обов’язкових: ${unreadCrit.length}` : unreadWarn.length ? `Не прочитано необов’язкових: ${unreadWarn.length}` : 'Усе прочитано'),
    mk('structure', 'Структурна повнота: межі, ролі, кроки, переходи, вплив проблем', structure.length ? 'fail' : 'ok',
      structure.length ? structure.slice(0, 3).map((b) => b.message).join(' · ') + (structure.length > 3 ? ` · …ще ${structure.length - 3}` : '') : 'Пропусків не виявлено'),
    mk('gaps', 'Критичних прогалин немає', gaps.length ? 'fail' : 'ok', gaps.length ? `Відкрито прогалин: ${gaps.length} (див. блок «Критичні прогалини»)` : 'Немає'),
    mk('integrity', 'Цілісність версії (хеш збігається зі змістом)', opts.integrityOk ? 'ok' : 'fail', opts.integrityOk ? 'Так' : 'Порушена: не використовуйте цю версію'),
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
    if (!accepted) return { key: 'accept', enabled: true, label: 'Прийняти робочу версію',
      hint: 'Це ще не погодження AS-IS — лише ваша позначка, що чернетка вас влаштовує.' };
    return { key: 'submit', enabled: true, label: 'Передати на погодження', hint: 'Після цього версію можна буде погодити.' };
  }
  if (state === 'pending_approval') return { key: 'approve', enabled: true, label: 'Погодити цю версію AS-IS',
    hint: 'Погодження прив’язується до цієї незмінної версії. Якщо є сумніви — поверніть на доопрацювання.' };
  if (state === 'approved') {
    return { key: 'start_bpmn', enabled: bpmn.ok, label: 'Дозволити створення BPMN',
      hint: 'У зрізі 1 перевіряється лише дозвіл сервера; побудова схеми з’явиться у зрізі 3.',
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
    const idx = src && cl.quote ? src.content.indexOf(cl.quote) : -1;
    return {
      ...cl,
      type_label: CLAIM_TYPE_LABEL[cl.type],
      source_title: src?.title ?? null,
      quote_check: !cl.source_id || !cl.quote ? 'no_quote' : idx >= 0 ? 'quote_found' : 'quote_not_found',
      quote_start: idx >= 0 ? idx : null,
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
    sources: sources.map((s) => ({
      id: s.id, title: s.title, kind: s.kind, origin: s.origin, required: s.required === 1, read_status: s.read_status,
      read_error: s.read_error, author: s.author, added_at: s.added_at, covered: covered.has(s.id),
    })),
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
    editable: {
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
