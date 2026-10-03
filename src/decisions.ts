/**
 * Рішення аналітикині та їхня актуальність на реальних даних (D96).
 *
 * Правила, задані власницею:
 *  • зміна назви або технічного ID сама по собі НЕ доводить зміни змісту;
 *  • зв'язок між версіями об'єкта має бути надійним, а не збігом рядків;
 *  • коли зіставлення неоднозначне — показуємо попереднє рішення й конкретну причину перегляду;
 *  • «нової суперечності немає» не стверджуємо беззастережно, якщо перевірка не завершилась
 *    або не охоплює потрібних джерел.
 *
 * Тому кожна перевірка має ТРИ стани: `ok`, `changed`, `unknown`. Жоден `unknown` не читається як «усе гаразд».
 */
import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import { audit, getCase, getVersion, headVersion, requireHuman, versionContent, type Actor } from './domain.ts';
import { canonical, sha256 } from './hash.ts';
import { findQuote } from './ai/quote.ts';
import type { Content, Step } from './schema.ts';

export interface DecisionEvidence { source_id: string; quote: string }
export interface DecisionScope { question_ids: string[]; step_ids: string[] }

export interface DecisionRow {
  id: string; case_id: string; subject: string; explanation: string;
  author: string; created_at: string;
  version_id: string; content_hash: string;
  scope_json: string; evidence_json: string; record_hash: string;
}

export interface DecisionApplicationRow {
  id: string; decision_id: string; case_id: string; version_id: string; content_hash: string;
  kind: 'created' | 'confirmed' | 'edited' | 'superseded';
  actor: string; at: string; note: string;
}

const FIELDS = ['id', 'case_id', 'subject', 'explanation', 'author', 'created_at', 'version_id', 'content_hash', 'scope_json', 'evidence_json'] as const;
export function decisionHash(r: Omit<DecisionRow, 'record_hash'>): string {
  const o: Record<string, unknown> = {};
  for (const k of FIELDS) o[k] = r[k];
  return sha256(canonical(o));
}

const newId = (p: string): string => `${p}_${Math.random().toString(16).slice(2, 14)}`;
const nowIso = (): string => new Date().toISOString();

/* ─────────────────────── створення й читання ─────────────────────── */

export function createDecision(
  db: DB, actor: Actor, caseId: string,
  input: { subject: string; explanation: string; scope: DecisionScope; evidence: DecisionEvidence[] },
): DecisionRow {
  requireHuman(actor, 'рішення аналітикині');
  const subject = input.subject.trim();
  const explanation = input.explanation.trim();
  if (!subject) throw new DomainError('VALIDATION', 'Назвіть предмет рішення.', 400);
  if (!explanation) throw new DomainError('VALIDATION', 'Поясніть рішення: без пояснення його не можна буде ні перевірити, ні повторно застосувати.', 400);
  const scope: DecisionScope = { question_ids: [...new Set(input.scope.question_ids ?? [])], step_ids: [...new Set(input.scope.step_ids ?? [])] };
  if (!scope.question_ids.length && !scope.step_ids.length) {
    throw new DomainError('VALIDATION', 'Укажіть, до чого рішення застосовується: до питання, до кроків або до того й того.', 400);
  }
  return tx(db, () => {
    getCase(db, caseId);
    const head = headVersion(db, caseId);
    const c = versionContent(head);
    for (const q of scope.question_ids) {
      if (!c.questions.some((x) => x.id === q)) throw new DomainError('NOT_FOUND', `Питання ${q} у поточній версії немає.`, 404);
    }
    for (const sid of scope.step_ids) {
      if (!c.steps.some((x) => x.id === sid)) throw new DomainError('NOT_FOUND', `Кроку ${sid} у поточній версії немає.`, 404);
    }
    const evidence: DecisionEvidence[] = [];
    for (const e of input.evidence ?? []) {
      const src = one<{ id: string; content: string; title: string; read_status: string }>(
        db, 'SELECT id, content, title, read_status FROM source WHERE id = ? AND case_id = ?', e.source_id, caseId);
      if (!src) throw new DomainError('NOT_FOUND', 'Джерело доказу в цьому кейсі не знайдено.', 404);
      if (src.read_status !== 'ok') throw new DomainError('VALIDATION', `Джерело «${src.title}» не прочитано повністю — доказом воно бути не може.`, 400);
      const quote = (e.quote ?? '').trim();
      if (quote && findQuote(src.content, quote).kind === 'not_found') {
        throw new DomainError('QUOTE_NOT_FOUND', `Фрагмента немає в джерелі «${src.title}».`, 400);
      }
      evidence.push({ source_id: e.source_id, quote });
    }
    const base: Omit<DecisionRow, 'record_hash'> = {
      id: newId('dec'), case_id: caseId, subject, explanation, author: actor.name, created_at: nowIso(),
      version_id: head.id, content_hash: head.content_hash,
      scope_json: JSON.stringify(scope), evidence_json: JSON.stringify(evidence),
    };
    run(db,
      `INSERT INTO decision (id, case_id, subject, explanation, author, created_at, version_id, content_hash, scope_json, evidence_json, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      base.id, base.case_id, base.subject, base.explanation, base.author, base.created_at,
      base.version_id, base.content_hash, base.scope_json, base.evidence_json, decisionHash(base));
    recordApplication(db, actor, caseId, base.id, head.id, head.content_hash, 'created', 'Рішення ухвалено');
    audit(db, caseId, actor, 'decision_created', { decision_id: base.id, subject, scope });
    return one<DecisionRow>(db, 'SELECT * FROM decision WHERE id = ?', base.id)!;
  });
}

export function listDecisions(db: DB, caseId: string): DecisionRow[] {
  return all<DecisionRow>(db, 'SELECT * FROM decision WHERE case_id = ? ORDER BY created_at, rowid', caseId);
}
export function getDecision(db: DB, caseId: string, id: string): DecisionRow {
  const d = one<DecisionRow>(db, 'SELECT * FROM decision WHERE id = ? AND case_id = ?', id, caseId);
  if (!d) throw new DomainError('NOT_FOUND', 'Рішення не знайдено', 404);
  return d;
}
export function decisionApplications(db: DB, decisionId: string): DecisionApplicationRow[] {
  return all<DecisionApplicationRow>(db, 'SELECT * FROM decision_application WHERE decision_id = ? ORDER BY rowid', decisionId);
}
function recordApplication(
  db: DB, actor: Actor, caseId: string, decisionId: string, versionId: string, contentHash: string,
  kind: DecisionApplicationRow['kind'], note: string,
): void {
  run(db,
    `INSERT INTO decision_application (id, decision_id, case_id, version_id, content_hash, kind, actor, at, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId('dapp'), decisionId, caseId, versionId, contentHash, kind, actor.name, nowIso(), note);
}

/* ─────────────────────── актуальність ─────────────────────── */

export type CheckStatus = 'ok' | 'changed' | 'unknown';
export interface DecisionCheck {
  key: string; label: string; status: CheckStatus; detail: string;
  /** Конкретні зміни: об'єкт, поле, було → стало. Порожньо, якщо точне порівняння неможливе. */
  diffs?: FieldDiff[];
}
export type DecisionState = 'valid' | 'needs_confirmation' | 'review' | 'void';

export interface DecisionCurrency {
  decision_id: string;
  state: DecisionState;
  state_label: string;
  /** Чи застосовували рішення саме до цієї версії. */
  applied_to_current: boolean;
  checks: DecisionCheck[];
  changed: string[];
  unknown: string[];
  /** Усі конкретні зміни пласким списком: об'єкт · поле · було → стало. */
  diffs: FieldDiff[];
}

export const DECISION_STATE_LABEL: Record<DecisionState, string> = {
  valid: 'Діє — пов’язаний зміст не змінився',
  needs_confirmation: 'Потрібне ваше підтвердження',
  review: 'Потрібно переглянути — змінився пов’язаний зміст',
  void: 'Попереднє рішення не застосовується',
};

/**
 * Зміст кроку без його ID і без назви ролі: саме він визначає, чи крок той самий по суті.
 * Перейменування ID або зміна підпису ролі змістом кроку не є.
 */
function stepFingerprint(s: Step): string {
  return sha256(canonical({
    action: s.action.trim(), entry_condition: s.entry_condition.trim(), result: s.result.trim(),
    input_artifact: (s.input_artifact ?? '').trim(), details: (s.details ?? '').trim(),
    next: [...s.next].map((n) => ({ to: n.to, condition: n.condition.trim() })).sort((a, b) => (a.to + a.condition).localeCompare(b.to + b.condition)),
    source_ids: [...s.source_ids].sort(),
  }));
}
/** Зміст кроку БЕЗ переходів: дозволяє відрізнити «перейменували» від «переписали дію». */
function stepBodyFingerprint(s: Step): string {
  return sha256(canonical({
    action: s.action.trim(), entry_condition: s.entry_condition.trim(), result: s.result.trim(),
    details: (s.details ?? '').trim(),
  }));
}

/** Поля кроку, зміну яких показуємо поіменно: загальне «щось змінилося» людині нічого не дає. */
const STEP_FIELDS: [keyof Step, string][] = [
  ['action', 'дія'], ['entry_condition', 'умова входу'], ['result', 'результат'],
  ['input_artifact', 'вхідний артефакт'], ['details', 'деталі опису'],
];

export interface FieldDiff { object: string; field: string; was: string; now: string }

function stepDiffs(before: Step, after: Step): FieldDiff[] {
  const out: FieldDiff[] = [];
  const name = `Крок ${before.id}` + (after.id !== before.id ? ` (тепер ${after.id})` : '');
  for (const [k, label] of STEP_FIELDS) {
    const a = String(before[k] ?? '').trim(), b = String(after[k] ?? '').trim();
    if (a !== b) out.push({ object: name, field: label, was: a, now: b });
  }
  const tr = (s: Step) => [...s.next].map((n) => `${n.condition || '(без умови)'} → ${n.to}`).sort().join('; ');
  if (tr(before) !== tr(after)) out.push({ object: name, field: 'переходи', was: tr(before), now: tr(after) });
  const src = (s: Step) => [...s.source_ids].sort().join(', ');
  if (src(before) !== src(after)) out.push({ object: name, field: 'джерела', was: src(before), now: src(after) });
  return out;
}

function matchStep(stepId: string, was: Content, now: Content): { kind: 'same' | 'renamed' | 'changed' | 'ambiguous' | 'gone'; to?: string; detail: string; diffs?: FieldDiff[] } {
  const before = was.steps.find((s) => s.id === stepId);
  if (!before) return { kind: 'gone', detail: `Кроку ${stepId} не було й у версії, на якій ухвалювалось рішення.` };
  const sameId = now.steps.find((s) => s.id === stepId);
  if (sameId) {
    if (stepFingerprint(sameId) === stepFingerprint(before)) return { kind: 'same', to: stepId, detail: `Крок ${stepId} не змінився.` };
    const diffs = stepDiffs(before, sameId);
    return { kind: 'changed', to: stepId, diffs, detail: `Крок ${stepId}: ${diffs.map((d) => d.field).join(', ')}.` };
  }
  // ID зник. Зміна ID сама по собі не доводить зміни змісту — шукаємо той самий зміст під іншим ID.
  const byBody = now.steps.filter((s) => stepBodyFingerprint(s) === stepBodyFingerprint(before));
  if (byBody.length === 1) {
    const to = byBody[0]!;
    if (stepFingerprint(to) === stepFingerprint(before)) {
      return { kind: 'renamed', to: to.id, detail: `Крок ${stepId} має тепер ID ${to.id}; зміст той самий.` };
    }
    const diffs = stepDiffs(before, to);
    return { kind: 'changed', to: to.id, diffs, detail: `Крок ${stepId} має тепер ID ${to.id}; змінилося: ${diffs.map((d) => d.field).join(', ')}.` };
  }
  if (byBody.length > 1) {
    return { kind: 'ambiguous', detail: `Крок ${stepId} зник, а з таким самим описом у поточній версії є кілька кроків (${byBody.map((s) => s.id).join(', ')}): зіставити надійно не вдалося.` };
  }
  return { kind: 'gone', detail: `Кроку ${stepId} у поточній версії немає, і кроку з таким самим описом теж.` };
}

export function decisionCurrency(db: DB, caseId: string, decisionId: string): DecisionCurrency {
  const d = getDecision(db, caseId, decisionId);
  const { record_hash, ...rest } = d;
  const head = headVersion(db, caseId);
  const checks: DecisionCheck[] = [];

  if (decisionHash(rest) !== record_hash) {
    checks.push({ key: 'record', label: 'Цілісність запису', status: 'changed', detail: 'Запис рішення змінено поза програмою — спиратися на нього не можна.' });
    return finish(d, head, checks);
  }
  const was = versionContent(getVersion(db, d.version_id));
  const now = versionContent(head);
  const scope = JSON.parse(d.scope_json) as DecisionScope;
  const evidence = JSON.parse(d.evidence_json) as DecisionEvidence[];

  // 1. Те саме питання?
  for (const qid of scope.question_ids) {
    const before = was.questions.find((q) => q.id === qid);
    const after = now.questions.find((q) => q.id === qid);
    if (!after) {
      checks.push({ key: 'question:' + qid, label: `Питання ${qid}`, status: 'changed', detail: `Питання ${qid} у поточній версії немає.` });
    } else if (before && before.text.trim() !== after.text.trim()) {
      checks.push({
        key: 'question:' + qid, label: `Питання ${qid}`, status: 'changed', detail: `Питання ${qid}: формулювання.`,
        diffs: [{ object: `Питання ${qid}`, field: 'формулювання', was: before.text.trim(), now: after.text.trim() }],
      });
    } else if (!before) {
      checks.push({ key: 'question:' + qid, label: `Питання ${qid}`, status: 'unknown', detail: `Питання ${qid} немає у версії, на якій ухвалювалось рішення: порівняти немає з чим.` });
    } else {
      checks.push({ key: 'question:' + qid, label: `Питання ${qid}`, status: 'ok', detail: 'Те саме питання.' });
    }
  }

  // 2. Пов'язані кроки. Перейменування ID — не зміна змісту.
  for (const sid of scope.step_ids) {
    const m = matchStep(sid, was, now);
    const status: CheckStatus = m.kind === 'same' || m.kind === 'renamed' ? 'ok' : m.kind === 'ambiguous' ? 'unknown' : 'changed';
    checks.push({
      key: 'step:' + sid, label: `Крок ${sid}`, status, diffs: m.diffs,
      // Коли крок зник, порівнювати поля немає з чим — кажемо це прямо, а не вигадуємо різницю.
      detail: m.kind === 'gone' ? m.detail + ' Точно порівняти поля немає з чим.' : m.detail,
    });
  }

  // 3. Докази. Зміна тексту джерела або зникнення цитати — зміна підстави.
  for (const e of evidence) {
    const src = one<{ id: string; title: string; content: string; read_status: string }>(
      db, 'SELECT id, title, content, read_status FROM source WHERE id = ? AND case_id = ?', e.source_id, caseId);
    if (!src) {
      checks.push({ key: 'evidence:' + e.source_id, label: 'Доказ', status: 'changed', detail: 'Джерела доказу в кейсі більше немає.' });
      continue;
    }
    if (src.read_status !== 'ok') {
      checks.push({ key: 'evidence:' + e.source_id, label: `Доказ «${src.title}»`, status: 'unknown', detail: 'Джерело не прочитано повністю — перевірити доказ не вдалося.' });
      continue;
    }
    if (e.quote && findQuote(src.content, e.quote).kind === 'not_found') {
      checks.push({
        key: 'evidence:' + e.source_id, label: `Доказ «${src.title}»`, status: 'changed',
        detail: 'Фрагмента, на який спиралося рішення, у джерелі більше немає.',
        diffs: [{ object: `Джерело «${src.title}»`, field: 'фрагмент-доказ', was: e.quote, now: '— у тексті джерела не знайдено —' }],
      });
      continue;
    }
    checks.push({ key: 'evidence:' + e.source_id, label: `Доказ «${src.title}»`, status: 'ok', detail: 'Доказ на місці.' });
  }

  // 4. Нові суперечності. Беззастережного «немає» тут не буває:
  //    якщо хоч одне джерело поточної версії не прочитане, перевірка не охоплює потрібного матеріалу.
  const covered = JSON.parse(head.covered_json) as string[];
  const unreadable = covered.filter((id) => {
    const s = one<{ read_status: string }>(db, 'SELECT read_status FROM source WHERE id = ?', id);
    return !s || s.read_status !== 'ok';
  });
  const newConflicts = now.conflicts.filter((c) => !was.conflicts.some((w) => w.key === c.key && w.kept === c.kept && w.proposed === c.proposed));
  if (newConflicts.length) {
    checks.push({ key: 'conflicts', label: 'Суперечності', status: 'changed', detail: `З’явилися нові суперечності: ${newConflicts.map((c) => c.key).join(', ')}.` });
  } else if (unreadable.length) {
    checks.push({
      key: 'conflicts', label: 'Суперечності', status: 'unknown',
      detail: `Перевірка не охоплює ${unreadable.length} ${unreadable.length === 1 ? 'джерело' : 'джерел'} поточної версії: воно не прочитане. Сказати, що нових суперечностей немає, не можна.`,
    });
  } else {
    checks.push({ key: 'conflicts', label: 'Суперечності', status: 'ok', detail: 'Нових суперечностей у версії не зафіксовано.' });
  }

  return finish(d, head, checks);
}

function finish(d: DecisionRow, head: { id: string; content_hash: string }, checks: DecisionCheck[]): DecisionCurrency {
  const changed = checks.filter((c) => c.status === 'changed').map((c) => c.detail);
  const diffs = checks.flatMap((c) => c.diffs ?? []);
  const unknown = checks.filter((c) => c.status === 'unknown').map((c) => c.detail);
  // Зміна доказу чи цілісності — це зміна ПІДСТАВИ: рішення не переноситься.
  const basisGone = checks.some((c) => c.status === 'changed' && (c.key.startsWith('evidence:') || c.key === 'record'));
  const state: DecisionState = basisGone ? 'void' : changed.length ? 'review' : unknown.length ? 'needs_confirmation' : 'valid';
  return {
    decision_id: d.id, state, state_label: DECISION_STATE_LABEL[state],
    applied_to_current: d.content_hash === head.content_hash,
    checks, changed, unknown, diffs,
  };
}

/* ─────────────────────── підтвердження людиною ─────────────────────── */

/**
 * Явне підтвердження рішення для поточної версії. Чинне рішення підтверджувати не треба —
 * воно діє саме собою; підтвердження потрібне там, де перевірка не дала однозначного «так».
 */
export function confirmDecision(
  db: DB, actor: Actor, caseId: string,
  input: { decisionId: string; explanation?: string; note?: string },
): DecisionRow {
  requireHuman(actor, 'підтвердження рішення');
  return tx(db, () => {
    const d = getDecision(db, caseId, input.decisionId);
    const cur = decisionCurrency(db, caseId, d.id);
    if (cur.state === 'void') {
      throw new DomainError('DECISION_VOID',
        'Підстава цього рішення змінилася, тому переносити його не можна: ухваліть нове рішення. Попереднє пояснення лишається в історії.', 409);
    }
    const head = headVersion(db, caseId);
    const text = (input.explanation ?? '').trim();
    const edited = text.length > 0 && text !== d.explanation;
    if (edited) {
      const base: Omit<DecisionRow, 'record_hash'> = {
        id: d.id, case_id: d.case_id, subject: d.subject, explanation: text, author: d.author, created_at: d.created_at,
        version_id: d.version_id, content_hash: d.content_hash, scope_json: d.scope_json, evidence_json: d.evidence_json,
      };
      run(db, 'UPDATE decision SET explanation = ?, record_hash = ? WHERE id = ?', text, decisionHash(base), d.id);
    }
    recordApplication(db, actor, caseId, d.id, head.id, head.content_hash,
      edited ? 'edited' : 'confirmed',
      (input.note ?? '').trim() || (edited ? 'Пояснення відредаговано й підтверджено' : 'Підтверджено без змін'));
    audit(db, caseId, actor, 'decision_confirmed', { decision_id: d.id, state: cur.state, edited, version_id: head.id });
    return one<DecisionRow>(db, 'SELECT * FROM decision WHERE id = ?', d.id)!;
  });
}
