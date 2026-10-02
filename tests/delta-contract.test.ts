/**
 * Контракт часткового оновлення відповіді агента 1 — `analyst-delta-v1` (D80, docs/agent1-delta-contract.md).
 *
 * Підстава: за контракту «повна версія щоразу» відповідь дорівнює всьому накопиченому опису, тому впирається в
 * будь-яку стелю виходу (D78/D79). Тут перевіряється, що часткове оновлення дає той самий результат, не послаблюючи
 * жодної перевірки: додавання, зміна, відсутність змін, збереження незгаданих елементів, захист людських рішень,
 * відмова без часткового застосування, стійкість до некоректних ID, дублікатів операцій і застарілої основи.
 * Усе — на підставному клієнті: платних викликів немає.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, type DB } from '../src/db.ts';
import { canonical } from '../src/hash.ts';
import { applyDelta, DELTA_CONTRACT } from '../src/ai/delta.ts';
import { loadInstruction } from '../src/ai/prompt.ts';
import { beginAnalystRun, completeAnalystRun, runAnalyst, ScriptedDemoClient, type RunResult } from '../src/runs.ts';
import {
  addSource, headVersion, insertVersion, listSources, saveAnalystVersion, versionContent,
} from '../src/domain.ts';
import { emptyContent, type Content } from '../src/schema.ts';
import { COMPLETE_FIELDS, draftReadyCase, freshDb, human } from './helpers.ts';
import { policyOf } from './review-helpers.ts';

const QUOTE = 'Менеджер приймає запит';
const SRC_TEXT = 'Менеджер приймає запит. Оператор вносить зміну.';

/** Накопичений синтетичний опис: кроки, твердження, питання, гіпотеза, вимога нотації від аналітикині. */
function richContent(srcId: string, claims = 3): Content {
  const c = emptyContent();
  c.summary = 'Накопичений опис: що відомо й що ні.';
  c.business_context = 'Синтетичний приклад для перевірки контракту.';
  c.boundaries = { trigger: 'Запит клієнта', input: 'Заявка', completion: 'Умови оновлено', result: 'Оновлений договір' };
  c.roles = ['Менеджер', 'Оператор'];
  c.entry_step_id = 'S1';
  c.process_name = 'Зміна умов договору (синтетичний процес)';
  c.steps = [
    { id: 'S1', role: 'Менеджер', action: 'Приймає запит', entry_condition: '', input_artifact: '', result: 'Заявка в CRM', next: [{ to: 'S2', condition: '' }], source_ids: [srcId] },
    { id: 'S2', role: 'Оператор', action: 'Вносить зміну', entry_condition: '', input_artifact: '', result: 'Умови оновлено', next: [{ to: 'S3', condition: '' }], source_ids: [srcId], details: 'Деталі кроку: канал і приклади.' },
    { id: 'S3', role: 'Оператор', action: 'Повідомляє клієнта', entry_condition: '', input_artifact: '', result: 'Клієнта повідомлено', next: [{ to: 'END', condition: '' }], source_ids: [] },
  ];
  c.claims = Array.from({ length: claims }, (_, i) => ({
    id: `C${i + 1}`, text: `Твердження ${i + 1}: менеджер приймає запит від клієнта.`, type: 'source_fact' as const,
    source_id: srcId, quote: QUOTE, scope: 'Слова менеджера про свою ділянку.',
  }));
  c.questions = [{
    id: 'Q1', text: 'Що саме входить у перевірку заявки?', critical: true, impact: 'Уточнить зміст кроку S2',
    addressee: 'Оператор', status: 'open' as const, answer: '', closed_by_source_id: null, origin: 'analyst' as const,
    criticality_note: 'Без цього крок описати не можна', affects_transitions: [{ step_id: 'S2', condition: '', kind: 'step_detail' as const }],
  }];
  c.hypotheses = [{ id: 'H1', author: 'analyst', text: 'Заявки надходять нерівномірно', status: 'open', evidence_for: [], evidence_against: [], check_method: 'Порахувати заявки за тиждень', history: [] }];
  c.notation_requirements = [{
    id: 'N1', kind: 'timer', step_id: 'S2', detail: 'Крок чекає на підтвердження до кінця дня', origin: 'analyst',
    status: 'confirmed', evidence_source_id: '', evidence_quote: '', decided_by: 'Аналітикиня', decision_note: 'Рішення аналітикині',
  }];
  return c;
}

/** Кейс із заданим змістом як поточною версією; `owned` — ключі, які редагувала аналітикиня. */
function caseWith(db: DB, content: Content, owned: string[] = []) {
  const { c } = draftReadyCase(db);
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, c.id).id, covered: [], owned });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  return { caseId: c.id, versionId: v.id };
}

function richCase(db: DB, claims = 3, owned: string[] = []) {
  const { c } = draftReadyCase(db);
  const srcId = listSources(db, c.id)[0]!.id;
  const content = richContent(srcId, claims);
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, c.id).id, covered: [], owned });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  return { caseId: c.id, srcId, base: content, versionId: v.id };
}

type Make = (head: Content, baseVersion: string) => Record<string, unknown>;
const deltaOf = (make: Make) => new ScriptedDemoClient((i) => ({ contract: DELTA_CONTRACT, base_version: i.baseVersion, ...make(i.head_content, i.baseVersion ?? '') }));
const runDelta = (db: DB, caseId: string, make: Make): Promise<RunResult> =>
  runAnalyst(db, caseId, deltaOf(make), { contract: 'delta' });
const head = (db: DB, caseId: string) => versionContent(headVersion(db, caseId));

// ───────── K1. Додавання ─────────

test('K1. Нові елементи додаються; решти опису відповідь не містить і не змінює', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db);
  const r = await runDelta(db, caseId, () => ({
    claims: [{ id: 'C4', text: 'Нове твердження: менеджер приймає запит.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' }],
    questions: [{ id: 'Q2', text: 'Чи є інші канали надходження заявок?', critical: false, impact: 'Уточнить межі', addressee: 'Менеджер', status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '' }],
    steps: [{ id: 'S4', role: 'Оператор', action: 'Фіксує результат', entry_condition: '', input_artifact: '', result: 'Результат зафіксовано', next: [{ to: 'END', condition: '' }], source_ids: [] }],
    roles_added: ['Керівник'],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.deepEqual(h.claims.map((x) => x.id), ['C1', 'C2', 'C3', 'C4']);
  assert.deepEqual(h.questions.map((x) => x.id), ['Q1', 'Q2']);
  assert.deepEqual(h.steps.map((x) => x.id), ['S1', 'S2', 'S3', 'S4']);
  assert.deepEqual(h.roles, ['Менеджер', 'Оператор', 'Керівник']);
  // Усе, чого у відповіді не було, лишилось дослівно тим самим.
  assert.equal(canonical(h.claims.slice(0, 3)), canonical(base.claims));
  assert.equal(canonical(h.steps.slice(0, 3)), canonical(base.steps));
  assert.equal(canonical(h.questions[0]), canonical(base.questions[0]));
  assert.equal(canonical(h.hypotheses), canonical(base.hypotheses));
  assert.equal(canonical(h.notation_requirements), canonical(base.notation_requirements));
  assert.equal(h.summary, base.summary);
  assert.equal(h.entry_step_id, 'S1');
  assert.equal(h.process_name, base.process_name);
  // Нове авторство визначає програма, а не модель.
  assert.equal(h.questions[1]!.origin, 'agent');
});

// ───────── K2. Зміна ─────────

test('K2. Змінений елемент заміняється на своєму місці, інші елементи списку не рухаються', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({
    steps: [{ ...structuredClone(h.steps[1]!), details: 'Деталі уточнено за новим джерелом.' }],
    claims: [{ ...structuredClone(h.claims[0]!), scope: 'Слова менеджера; спостереження, а не оцінка.' }],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.deepEqual(h.steps.map((x) => x.id), ['S1', 'S2', 'S3'], 'порядок кроків збережено');
  assert.equal(h.steps[1]!.details, 'Деталі уточнено за новим джерелом.');
  assert.equal(h.steps[1]!.action, 'Вносить зміну', 'решта полів кроку на місці');
  assert.deepEqual(h.claims.map((x) => x.id), ['C1', 'C2', 'C3']);
  assert.equal(h.claims[0]!.scope, 'Слова менеджера; спостереження, а не оцінка.');
  assert.equal(h.claims[0]!.quote, QUOTE);
  assert.equal(canonical(h.claims.slice(1)), canonical(base.claims.slice(1)));
  assert.equal(canonical(h.steps[0]), canonical(base.steps[0]));
  assert.ok(srcId);
});

test('K2. Вкладені списки подаються у складі свого елемента: доданий перехід не чіпає інших кроків', async () => {
  const db = freshDb();
  const { caseId, base } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({
    steps: [{ ...structuredClone(h.steps[0]!), next: [{ to: 'S2', condition: 'заявка повна' }, { to: 'UNKNOWN', condition: 'заявка неповна' }] }],
    questions: [{ id: 'Q3', text: 'Що відбувається з неповною заявкою?', critical: true, impact: 'Визначить гілку', addressee: 'Менеджер', status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: 'Без цього гілку не описати', affects_transitions: [{ step_id: 'S1', condition: 'заявка неповна', kind: 'direction' }] }],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.deepEqual(h.steps[0]!.next, [{ to: 'S2', condition: 'заявка повна' }, { to: 'UNKNOWN', condition: 'заявка неповна' }]);
  assert.equal(canonical(h.steps.slice(1)), canonical(base.steps.slice(1)));
});

// ───────── K3. Відсутність змін ─────────

test('K3. Порожнє оновлення: зміст лишається точно таким самим', async () => {
  const db = freshDb();
  const { caseId, base } = richCase(db);
  const r = await runDelta(db, caseId, () => ({}));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(canonical(head(db, caseId)), canonical(base), 'зміст не змінився ні в чому');
  const checks = JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', r.ok ? r.runId : '')!.checks_json) as
    { delta?: { lists: Record<string, { added: number; changed: number }> }; size?: { contract: string } };
  assert.equal(checks.size!.contract, 'delta');
  for (const k of Object.keys(checks.delta!.lists)) {
    assert.equal(checks.delta!.lists[k]!.added + checks.delta!.lists[k]!.changed, 0, `${k}: змін не було`);
  }
});

test('K3. Повернути елемент без змін — не порушення й не «зміна»', async () => {
  const db = freshDb();
  const { caseId, base } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({ claims: [structuredClone(h.claims[0]!)], steps: [structuredClone(h.steps[0]!)] }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(canonical(head(db, caseId)), canonical(base));
  const checks = JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', r.ok ? r.runId : '')!.checks_json) as { delta: { lists: Record<string, { unchanged: number }> } };
  assert.equal(checks.delta.lists.claims!.unchanged, 1);
});

// ───────── K4. Незгадані елементи ─────────

test('K4. Великий опис: змінено два елементи, усі інші збережені дослівно', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db, 60);
  const r = await runDelta(db, caseId, (h) => ({
    claims: [
      { ...structuredClone(h.claims[6]!), text: 'Твердження 7 переписано за новим джерелом: менеджер приймає запит.' },
      { id: 'C61', text: 'Нове твердження 61: менеджер приймає запит.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' },
    ],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.equal(h.claims.length, 61);
  for (let i = 0; i < 60; i++) {
    if (i === 6) continue;
    assert.equal(canonical(h.claims[i]), canonical(base.claims[i]), `твердження ${base.claims[i]!.id} не мало змінитися`);
  }
  assert.match(h.claims[6]!.text, /переписано/);
  assert.equal(canonical(h.steps), canonical(base.steps));
  assert.equal(canonical(h.questions), canonical(base.questions));
});

test('K4. Крок, не згаданий у відповіді, не зникає (відсутність ≠ видалення)', async () => {
  const db = freshDb();
  const { caseId } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({ steps: [{ ...structuredClone(h.steps[0]!), result: 'Заявку зареєстровано в CRM' }] }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(head(db, caseId).steps.map((s) => s.id), ['S1', 'S2', 'S3']);
});

// ───────── K5. Захист людських рішень ─────────

test('K5. Правку аналітикині агент не перезаписує й через часткове оновлення', async () => {
  const db = freshDb();
  const { caseId, base } = richCase(db, 3, ['summary']);
  const r = await runDelta(db, caseId, () => ({ summary: 'АГЕНТ ПЕРЕПИСАВ СУТЬ' }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.equal(h.summary, base.summary, 'варіант аналітикині збережено');
  assert.ok(h.conflicts.some((x) => x.key === 'summary'), 'конфлікт записано');
});

test('K5. Поля, якими володіє людина або програма, у контракті відсутні: спроба їх передати — відмова', async () => {
  for (const [field, body] of [
    ['entry_step_id', { entry_step_id: 'S2' }],
    ['process_name', { process_name: 'Інша назва процесу' }],
    ['conflicts', { conflicts: [] }],
  ] as [string, Record<string, unknown>][]) {
    const db = freshDb();
    const { caseId, base } = richCase(db);
    const before = headVersion(db, caseId).id;
    const r = await runDelta(db, caseId, () => body);
    assert.equal(r.ok, false, `${field}: мало бути відхилено`);
    assert.match(r.ok ? '' : r.error, new RegExp(field));
    assert.equal(headVersion(db, caseId).id, before, `${field}: поточна версія не змінилась`);
    assert.equal(canonical(head(db, caseId)), canonical(base));
  }
});

test('K5. `link_history` агент передати не може', async () => {
  const db = freshDb();
  const { caseId } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({
    questions: [{ ...structuredClone(h.questions[0]!), link_history: [{ at: '2026-01-01T00:00:00.000Z', by: 'агент', step_id: 'S2', condition: '', from: 'step_detail', to: 'direction', note: '' }] }],
  }));
  assert.equal(r.ok, false, 'історію виправлень прив’язки веде лише застосунок');
  assert.match(r.ok ? '' : r.error, /link_history/);
});

test('K5. Критичність і прив’язку відкритого питання агент не знижує', async () => {
  const db = freshDb();
  const { caseId } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({
    questions: [{ ...structuredClone(h.questions[0]!), critical: false, affects_transitions: [] }],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const q = head(db, caseId).questions[0]!;
  assert.equal(q.critical, true, 'критичність відновлено');
  assert.deepEqual(q.affects_transitions, [{ step_id: 'S2', condition: '', kind: 'step_detail' }], 'прив’язку відновлено');
  assert.ok(head(db, caseId).conflicts.length >= 2, 'обидві спроби записані як конфлікти');
});

test('K5. Вилучення кроку лишається пропозицією для рішення людини', async () => {
  const db = freshDb();
  const { caseId, srcId } = richCase(db);
  const r = await runDelta(db, caseId, () => ({
    step_proposals: [{ id: 'R1', action: 'remove', step_id: 'S3', replacement_step_id: '', reason: 'Крок описано хибно', evidence_source_id: srcId, evidence_quote: QUOTE, status: 'proposed', decided_by: '', decision_note: '' }],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.deepEqual(h.steps.map((s) => s.id), ['S1', 'S2', 'S3'], 'крок лишився в опису');
  assert.equal(h.step_proposals![0]!.status, 'proposed');
  assert.equal(h.step_proposals![0]!.decided_by, '');
});

test('K5. Рішення за пропозицією й «підтверджено аналітиком» агент не ставить і через часткове оновлення', async () => {
  const db = freshDb();
  const { caseId, srcId } = richCase(db);
  const accepted = await runDelta(db, caseId, () => ({
    step_proposals: [{ id: 'R1', action: 'remove', step_id: 'S3', replacement_step_id: '', reason: 'Крок хибний', evidence_source_id: srcId, evidence_quote: QUOTE, status: 'accepted', decided_by: 'агент', decision_note: 'сам вирішив' }],
  }));
  assert.equal(accepted.ok, false, 'агент не приймає рішень за пропозиціями');
  assert.match(accepted.ok ? '' : accepted.error, /AGENT_CANNOT_DECIDE/);

  const confirmed = await runDelta(db, caseId, () => ({
    claims: [{ id: 'C9', text: 'Встановлений факт', type: 'analyst_confirmed', source_id: srcId, quote: QUOTE, scope: '' }],
  }));
  assert.equal(confirmed.ok, false, 'тип «підтверджено аналітиком» агент не створює');
  assert.match(confirmed.ok ? '' : confirmed.error, /AGENT_CANNOT_CONFIRM/);
});

test('K5. Вимогу до нотації, яку вирішила людина, агент не змінює', async () => {
  const db = freshDb();
  const { caseId } = richCase(db);
  const r = await runDelta(db, caseId, (h) => ({
    notation_requirements: [{ ...structuredClone(h.notation_requirements![0]!), status: 'rejected', decision_note: 'агент не погоджується' }],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const n = head(db, caseId).notation_requirements![0]!;
  assert.equal(n.status, 'confirmed', 'рішення аналітикині збережено');
  assert.ok(head(db, caseId).conflicts.some((x) => x.key === 'notation:N1'));
});

// ───────── K6. Відмова без часткового застосування ─────────

test('K6. Порушення в одному елементі — не застосовано НІЧОГО', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db);
  const before = headVersion(db, caseId).id;
  const versions = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM as_is_version WHERE case_id = ?', caseId)!.n;
  const r = await runDelta(db, caseId, () => ({
    // перше твердження коректне, друге — з цитатою, якої в джерелі немає
    claims: [
      { id: 'C4', text: 'Коректне твердження.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' },
      { id: 'C5', text: 'Некоректне твердження.', type: 'source_fact', source_id: srcId, quote: 'ЦЬОГО В ДЖЕРЕЛІ НЕМАЄ', scope: '' },
    ],
    summary: 'Нова суть, яку не можна зберегти частково',
  }));
  assert.equal(r.ok, false, 'мало бути відхилено');
  assert.match(r.ok ? '' : r.error, /QUOTE_NOT_FOUND/);
  const h = head(db, caseId);
  assert.equal(headVersion(db, caseId).id, before, 'поточна версія не змінилась');
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM as_is_version WHERE case_id = ?', caseId)!.n, versions, 'нової версії не створено');
  assert.equal(canonical(h), canonical(base), 'коректна частина теж не застосована');
  assert.equal(one<{ technical_state: string }>(db, 'SELECT technical_state FROM run WHERE id = ?', r.runId)!.technical_state, 'error');
});

// ───────── K7. Некоректні ID, дублікати, застаріла основа ─────────

test('K7. Той самий ID двічі в одній відповіді — відмова, поточна версія недоторкана', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db);
  const r = await runDelta(db, caseId, () => ({
    claims: [
      { id: 'C4', text: 'Варіант А.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: '' },
      { id: 'C4', text: 'Варіант Б.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: '' },
    ],
  }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /DELTA_DUPLICATE_OP/);
  assert.equal(canonical(head(db, caseId)), canonical(base));
});

test('K7. Посилання на джерело, якого не передавали, — відмова', async () => {
  const db = freshDb();
  const { caseId, base } = richCase(db);
  const r = await runDelta(db, caseId, () => ({
    claims: [{ id: 'C4', text: 'Твердження з чужим джерелом.', type: 'source_fact', source_id: 'src_НЕМАЄ', quote: QUOTE, scope: '' }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /UNKNOWN_SOURCE/);
  assert.equal(canonical(head(db, caseId)), canonical(base));
});

test('K7. Невідповідний base_version — відмова: оновлення не застосовують до іншої основи', async () => {
  const db = freshDb();
  const { caseId, base } = richCase(db);
  const r = await runAnalyst(db, caseId, new ScriptedDemoClient(() => ({ contract: DELTA_CONTRACT, base_version: 'ver_ЧУЖА', summary: 'Інша суть' })), { contract: 'delta' });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /DELTA_BASE_MISMATCH/);
  assert.equal(canonical(head(db, caseId)), canonical(base));
});

test('K7. Застаріла основа: результат зберігається як пропозиція, поточною версією не стає (поведінка без змін)', async () => {
  const db = freshDb();
  const { caseId, srcId } = richCase(db);
  const ctx = beginAnalystRun(db, caseId, deltaOf(() => ({})), { contract: 'delta' });
  // поки «агент працює», аналітикиня зберігає власну версію
  const v2 = saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { ...COMPLETE_FIELDS, summary: 'Правка аналітикині під час роботи агента' } });
  const out = completeAnalystRun(db, ctx.runId, {
    contract: DELTA_CONTRACT, base_version: ctx.base.id,
    claims: [{ id: 'C4', text: 'Нове твердження під час роботи.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: '' }],
  });
  assert.equal(out.kind, 'proposal', 'результат на застарілій основі — пропозиція');
  assert.equal(headVersion(db, caseId).id, v2.id, 'поточною версією лишилась версія аналітикині');
  assert.equal(head(db, caseId).summary, 'Правка аналітикині під час роботи агента');
});

// ───────── K8. Обсяг відповіді ─────────

test('K8. На великому опису відповідь із кількома змінами — відсотки від повного повернення', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db, 200);
  const fullChars = JSON.stringify(base).length;
  let deltaChars = 0;
  const client = new ScriptedDemoClient((i) => {
    const d = {
      contract: DELTA_CONTRACT, base_version: i.baseVersion,
      claims: [
        { ...structuredClone(i.head_content.claims[41]!), text: 'Твердження 42 уточнено: менеджер приймає запит.' },
        { id: 'C201', text: 'Нове твердження: менеджер приймає запит.', type: 'source_fact' as const, source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' },
      ],
      questions: [{ id: 'Q9', text: 'Хто перевіряє результат?', critical: false, impact: 'Уточнить роль', addressee: 'Оператор', status: 'open' as const, answer: '', closed_by_source_id: null, origin: 'agent' as const, criticality_note: '' }],
    };
    deltaChars = JSON.stringify(d).length;
    return d;
  });
  const r = await runAnalyst(db, caseId, client, { contract: 'delta' });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const share = (deltaChars / fullChars) * 100;
  console.log(`   K8: повне повернення ${fullChars} симв., часткове оновлення (3 зміни) ${deltaChars} симв. — ${share.toFixed(1)} %`);
  assert.ok(fullChars > 40_000, `контроль: опис справді великий (${fullChars})`);
  assert.ok(share < 5, `часткове оновлення має бути відсотками від повного, отримано ${share.toFixed(1)} %`);
  // Результат повний: нічого не втрачено.
  assert.equal(head(db, caseId).claims.length, 201);
});

// ───────── Наскрізний прогін на опису розміром як справжній ─────────

/** Підставний клієнт у режимі `real`: проходять усі перевірки платного шляху (ліміти, бюджет, стеля виходу). */
class RealLikeDeltaClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (тест, не модель)';
  constructor(private readonly make: Make) {}
  async analyze(input: { head_content: Content; baseVersion?: string }) {
    return { output: { contract: DELTA_CONTRACT, base_version: input.baseVersion, ...this.make(input.head_content, input.baseVersion ?? '') }, usage: { input_tokens: 30_000, output_tokens: 900 } };
  }
}

test('Опис розміром як у справжньому кейсі (≈65 000 симв.) проходить наскрізь: за повним контрактом — зупинка, за частковим — результат', async () => {
  const db = freshDb();
  const { caseId, srcId, base } = richCase(db, 330);
  const chars = JSON.stringify(base).length;
  assert.ok(chars > 60_000, `контроль: опис справді великий (${chars} симв.)`);
  const policy = policyOf();

  // За повним контрактом такий опис зупиняється ДО оплати (D78) — відповідь мала б містити весь опис.
  assert.throws(() => beginAnalystRun(db, caseId, new RealLikeDeltaClient(() => ({})) as never, { policy }),
    (e: { code?: string }) => e.code === 'OUTPUT_TOO_LARGE');

  const client = new RealLikeDeltaClient(() => ({
    claims: [{ id: 'C999', text: 'Нове твердження на великому опису: менеджер приймає запит.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' }],
    summary: 'Суть оновлено за новим джерелом.',
  }));
  const r = await runAnalyst(db, caseId, client as never, { policy, contract: 'delta' });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const h = head(db, caseId);
  assert.equal(h.claims.length, 331, 'усі попередні твердження на місці, нове додано');
  assert.equal(h.summary, 'Суть оновлено за новим джерелом.');
  assert.equal(canonical(h.claims.slice(0, 330)), canonical(base.claims), 'накопичене не переписано');
  assert.equal(canonical(h.steps), canonical(base.steps));
  const row = one<{ cost_usd: number | null; output_contract: string }>(db, 'SELECT cost_usd, output_contract FROM run WHERE id = ?', r.runId)!;
  assert.equal(row.output_contract, 'delta');
  assert.ok((row.cost_usd ?? 0) > 0, 'вартість обчислено з usage');
});

// ───────── K9. Сумісність ─────────

test('K9. Старий контракт працює як раніше; відповідь не того контракту відхиляється зрозуміло', async () => {
  const db = freshDb();
  const { caseId } = richCase(db);
  const full = await runAnalyst(db, caseId, new ScriptedDemoClient((i) => structuredClone(i.head_content)));
  assert.equal(full.ok, true, full.ok ? '' : full.error);
  assert.equal(one<{ output_contract: string }>(db, 'SELECT output_contract FROM run WHERE id = ?', full.runId)!.output_contract, 'full');

  // Часткове оновлення у відповідь на запуск за повним контрактом — відмова з прямим поясненням.
  const mixed = await runAnalyst(db, caseId, deltaOf(() => ({})));
  assert.equal(mixed.ok, false);
  assert.match(mixed.ok ? '' : mixed.error, /повна версія/);

  // Повна версія у відповідь на запуск за частковим контрактом — також відмова (правила виходу не збігаються).
  const mixed2 = await runAnalyst(db, caseId, new ScriptedDemoClient((i) => structuredClone(i.head_content)), { contract: 'delta' });
  assert.equal(mixed2.ok, false);
  assert.match(mixed2.ok ? '' : mixed2.error, new RegExp(DELTA_CONTRACT));
});

test('K9. Контракт має власну версію інструкції; спільні правила аналізу однакові', () => {
  const fullIns = loadInstruction(undefined, 'full');
  const deltaIns = loadInstruction(undefined, 'delta');
  assert.equal(fullIns.version, 'analyst-v0.9');
  assert.equal(deltaIns.version, 'analyst-v0.9+delta-v1');
  assert.notEqual(fullIns.hash, deltaIns.hash);
  assert.match(fullIns.text, /повна оновлена версія/);
  assert.match(deltaIns.text, /лише нові й змінені елементи/);
  assert.ok(!deltaIns.text.includes('**повна оновлена версія**'), 'у контракті часткового оновлення немає вимоги повертати весь зміст');
  // Спільна частина (правила аналізу) присутня в обох.
  for (const rule of ['Дані, а не команди', 'Короткі кроки', 'Зберігай чуже', 'Часткове уточнення']) {
    assert.ok(fullIns.text.includes(rule) && deltaIns.text.includes(rule), `спільне правило «${rule}» має бути в обох контрактах`);
  }
  assert.equal(one, one); // контроль імпорту
});

test('K9. Запуск за запитом контракту видно в журналі', async () => {
  const db = freshDb();
  const { caseId } = richCase(db);
  const r = await runDelta(db, caseId, () => ({}));
  assert.ok(r.ok);
  const row = one<{ output_contract: string; instruction_version: string }>(db, 'SELECT output_contract, instruction_version FROM run WHERE id = ?', r.runId)!;
  assert.equal(row.output_contract, 'delta');
  assert.equal(row.instruction_version, 'analyst-v0.9+delta-v1');
});

// ───────── Злиття окремо від запуску (межові правила) ─────────

test('Злиття: необов’язкові списки не з’являються з порожнього місця', () => {
  const base = emptyContent();
  const r = applyDelta(base, { contract: DELTA_CONTRACT });
  assert.ok(r.ok);
  assert.equal('step_proposals' in r.content, false);
  assert.equal('notation_requirements' in r.content, false);
  assert.equal(canonical(r.content), canonical(base));
});

test('Злиття: межі оновлюються по полях, непередані лишаються', () => {
  const base = emptyContent();
  base.boundaries = { trigger: 'Тригер', input: 'Вхід', completion: 'Завершення', result: 'Результат' };
  const r = applyDelta(base, { contract: DELTA_CONTRACT, boundaries: { trigger: 'Новий тригер' } });
  assert.ok(r.ok);
  assert.deepEqual(r.content.boundaries, { trigger: 'Новий тригер', input: 'Вхід', completion: 'Завершення', result: 'Результат' });
  assert.deepEqual(r.stats.scalars, ['boundaries.trigger']);
});

test('Злиття: роль можна лише додати, і повторна не дублюється', () => {
  const base = emptyContent();
  base.roles = ['Менеджер'];
  const r = applyDelta(base, { contract: DELTA_CONTRACT, roles_added: ['Менеджер', 'Оператор', ' '] });
  assert.ok(r.ok);
  assert.deepEqual(r.content.roles, ['Менеджер', 'Оператор']);
});

test('Злиття: не JSON-об’єкт і чужий контракт — відмова з назвою контракту', () => {
  for (const raw of [null, 'текст', [], { contract: 'analyst-delta-v2' }, {}]) {
    const r = applyDelta(emptyContent(), raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.equal(r.ok ? '' : r.violations[0]!.code, 'DELTA_CONTRACT');
    assert.match(r.ok ? '' : r.violations[0]!.message, new RegExp(DELTA_CONTRACT));
  }
});

test('Злиття: конфлікти попередньої версії не переносяться в нову (їх рахує програма щоразу)', () => {
  const base = emptyContent();
  base.conflicts = [{ key: 'summary', kept: 'варіант аналітикині', proposed: 'варіант агента', note: 'старий конфлікт' }];
  const r = applyDelta(base, { contract: DELTA_CONTRACT });
  assert.ok(r.ok);
  assert.deepEqual(r.content.conflicts, []);
});

test('Злиття: додане джерело в кроці не чіпає інших полів кроку', () => {
  const db = freshDb();
  const { caseId, srcId } = richCase(db);
  const base = head(db, caseId);
  const step = { ...structuredClone(base.steps[2]!), source_ids: [srcId] };
  const r = applyDelta(base, { contract: DELTA_CONTRACT, steps: [step] });
  assert.ok(r.ok);
  assert.deepEqual(r.content.steps[2]!.source_ids, [srcId]);
  assert.equal(r.content.steps[2]!.action, 'Повідомляє клієнта');
  assert.equal(r.stats.lists.steps!.changed, 1);
  assert.ok(addSource);
});
