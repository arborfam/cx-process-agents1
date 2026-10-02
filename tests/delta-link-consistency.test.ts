/**
 * Блокер першого справжнього запуску analyst-delta-v1 (D81): відповідь відхилено через
 * `LINK_BROKEN — питання прив'язане до переходу з умовою «», якого в кроці немає`, а повтор не виконався
 * (оцінка перевищила ліміт на запуск).
 *
 * Тут перевіряється ШЛЯХ: delta → повний кандидат → перевірка прив'язок. Перевіряється, що
 * (1) перевірка бачить саме ПОВНИЙ результат після злиття, а не лише надіслані зміни;
 * (2) розірваний зв'язок, який створив або зламав агент, і далі відхиляється — але повідомлення називає,
 *     що саме доступно в кроці й що саме робити;
 * (3) зв'язок, РОЗІРВАНИЙ УЖЕ У ВХІДНІЙ ВЕРСІЇ, не є виною цієї відповіді: програма позначає його для
 *     аналітикині, а не відхиляє оплачену відповідь (той самий принцип, що в D73);
 * (4) коректний зв'язок проходить, і уточнення змісту кроку не вимагає вигаданого переходу.
 *
 * Усе — на підставному клієнті: платних викликів немає. Кейс CX (Q39/S18) тут не відтворюється: його сирої
 * відповіді немає, тому тести описують ПРАВИЛО, а не конкретний кейс.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, type DB } from '../src/db.ts';
import { canonical } from '../src/hash.ts';
import { DELTA_CONTRACT } from '../src/ai/delta.ts';
import { loadInstruction } from '../src/ai/prompt.ts';
import { runAnalyst, ScriptedDemoClient, type RunResult } from '../src/runs.ts';
import {
  addSource, acceptDraft, approve, headVersion, insertVersion, listSources, requestBpmnStart, submissionBlockers,
  submitForApproval, versionContent,
} from '../src/domain.ts';
import { emptyContent, UNKNOWN, type Content, type Question, type Step } from '../src/schema.ts';
import { draftReadyCase, freshDb, human } from './helpers.ts';

const QUOTE = 'Менеджер приймає запит';

const step = (over: Partial<Step> & { id: string }): Step => ({
  role: 'Оператор', action: 'Виконує дію', entry_condition: '', input_artifact: '', result: 'Результат', next: [], source_ids: [], ...over,
});
const question = (over: Partial<Question> & { id: string }): Question => ({
  text: 'Питання про зміст кроку?', critical: false, impact: 'Уточнить опис', addressee: 'Оператор', status: 'open',
  answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '', ...over,
});

/** Вхідна версія: S1 → S2 (звичайна послідовність), S3 без переходів. */
function baseContent(srcId: string, extra: Partial<Content> = {}): Content {
  const c = emptyContent();
  c.summary = 'Вхідний опис.';
  c.entry_step_id = 'S1';
  c.steps = [
    step({ id: 'S1', role: 'Менеджер', action: 'Приймає запит', result: 'Заявка в CRM', next: [{ to: 'S2', condition: '' }], source_ids: [srcId] }),
    step({ id: 'S2', action: 'Вносить зміну', result: 'Умови оновлено', next: [{ to: 'END', condition: '' }], source_ids: [srcId] }),
    step({ id: 'S3', action: 'Повідомляє клієнта', result: 'Клієнта повідомлено', next: [] }),
  ];
  c.claims = [{ id: 'C1', text: 'Менеджер приймає запит.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' }];
  return { ...c, ...extra };
}

function caseWith(db: DB, make: (srcId: string) => Content) {
  const { c } = draftReadyCase(db);
  const srcId = listSources(db, c.id)[0]!.id;
  const content = make(srcId);
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, c.id).id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  return { caseId: c.id, srcId, base: content };
}

const runDelta = (db: DB, caseId: string, make: (head: Content) => Record<string, unknown>): Promise<RunResult> =>
  runAnalyst(db, caseId, new ScriptedDemoClient((i) => ({ contract: DELTA_CONTRACT, base_version: i.baseVersion, ...make(i.head_content) })), { contract: 'delta' });
const head = (db: DB, caseId: string) => versionContent(headVersion(db, caseId));
const warningsOf = (db: DB, runId: string): string[] => {
  const row = one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', runId)!;
  return (JSON.parse(row.checks_json) as { warnings?: string[] }).warnings ?? [];
};

// ───────── 1. Відтворення: зв'язок, якого немає в повному результаті ─────────

test('1. Нове питання про НОВИЙ крок із відсутньою умовою переходу — відхилено, і сказано, що в кроці є', async () => {
  const db = freshDb();
  const { caseId, base } = caseWith(db, baseContent);
  const r = await runDelta(db, caseId, () => ({
    steps: [step({ id: 'S4', action: 'Фіксує результат', next: [{ to: 'END', condition: 'результат зафіксовано' }] })],
    questions: [question({ id: 'Q9', text: 'Що відбувається далі?', affects_transitions: [{ step_id: 'S4', condition: '' }] })],
  }));
  assert.equal(r.ok, false, 'зв’язок, якого немає в повному результаті, приймати не можна');
  const msg = r.ok ? '' : r.error;
  assert.match(msg, /LINK_BROKEN/);
  assert.match(msg, /результат зафіксовано/, 'повідомлення має назвати, які умови в кроці справді є');
  assert.match(msg, /step_detail/, 'має бути названо, що уточнення змісту кроку переходу не потребує');
  assert.equal(canonical(head(db, caseId)), canonical(base), 'поточна версія не змінилась');
});

test('1. Нове питання про ЗМІНЕНИЙ крок із відсутньою умовою — відхилено; названо крок без переходів', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, baseContent);
  const r = await runDelta(db, caseId, (h) => ({
    steps: [{ ...structuredClone(h.steps[2]!), details: 'Деталі уточнено.' }],   // S3, переходів немає
    questions: [question({ id: 'Q9', affects_transitions: [{ step_id: 'S3', condition: '' }] })],
  }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /переходів немає|немає жодного переходу/);
});

test('1. Зміна умови наявного переходу розриває прив’язку відкритого питання — відхилено з прямою вказівкою', async () => {
  const db = freshDb();
  const { caseId, base } = caseWith(db, (srcId) => {
    const c = baseContent(srcId);
    c.steps[0]!.next = [{ to: 'S2', condition: 'заявка повна' }, { to: UNKNOWN, condition: 'заявка неповна' }];
    c.questions = [question({ id: 'Q5', text: 'Що з неповною заявкою?', critical: true, affects_transitions: [{ step_id: 'S1', condition: 'заявка неповна', kind: 'direction' }] })];
    return c;
  });
  const r = await runDelta(db, caseId, (h) => ({
    // агент перейменував умову, до якої прив'язане відкрите питання
    steps: [{ ...structuredClone(h.steps[0]!), next: [{ to: 'S2', condition: 'заявка повна' }, { to: UNKNOWN, condition: 'заявка не повна' }] }],
  }));
  assert.equal(r.ok, false, 'розірваний наявний зв’язок приймати не можна');
  const msg = r.ok ? '' : r.error;
  assert.match(msg, /LINK_BROKEN/);
  assert.match(msg, /не перенос|рішення аналітикині|такою, якою вона була/i, 'має бути сказано, що прив’язку відкритого питання агент не переносить');
  assert.equal(canonical(head(db, caseId)), canonical(base));
});

// ───────── 2. Контроль коректного зв'язку ─────────

test('2. Уточнення змісту кроку (step_detail) переходу не потребує — проходить', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, baseContent);
  const r = await runDelta(db, caseId, () => ({
    questions: [question({ id: 'Q9', text: 'Що саме входить у повідомлення клієнта?', affects_transitions: [{ step_id: 'S3', condition: '', kind: 'step_detail' }] })],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(head(db, caseId).questions.length, 1);
});

test('2. Новий невідомий перехід разом із питанням про напрямок — проходить', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, baseContent);
  const r = await runDelta(db, caseId, (h) => ({
    steps: [{ ...structuredClone(h.steps[2]!), next: [{ to: UNKNOWN, condition: '' }] }],
    questions: [question({ id: 'Q9', text: 'Що відбувається після повідомлення клієнта?', critical: true, affects_transitions: [{ step_id: 'S3', condition: '', kind: 'direction' }] })],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(head(db, caseId).steps[2]!.next, [{ to: UNKNOWN, condition: '' }]);
});

// ───────── 3. Пов'язаний елемент лишився у вхідній версії без змін у delta ─────────

test('3. Крок не згадано в оновленні: перевірка бачить перехід із вхідної версії — проходить', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, baseContent);
  const r = await runDelta(db, caseId, () => ({
    // S2 в оновленні немає; його перехід «» → END існує лише у вхідній версії
    questions: [question({ id: 'Q9', text: 'Чи підтверджено послідовність S2 → END?', affects_transitions: [{ step_id: 'S2', condition: '', kind: 'unconfirmed_sequence' }] })],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(head(db, caseId).steps[1]!.next, [{ to: 'END', condition: '' }], 'крок із вхідної версії збережено');
});

test('3. Контроль не порожній: той самий випадок із умовою, якої у вхідній версії немає, — відхилено', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, baseContent);
  const r = await runDelta(db, caseId, () => ({
    questions: [question({ id: 'Q9', affects_transitions: [{ step_id: 'S2', condition: 'якась умова', kind: 'unconfirmed_sequence' }] })],
  }));
  assert.equal(r.ok, false, 'перевірка не стає сліпою, коли крок не надіслано в оновленні');
  assert.match(r.ok ? '' : r.error, /LINK_BROKEN/);
});

// ───────── 4. Зв'язок, розірваний УЖЕ у вхідній версії ─────────

test('4. Розірваний зв’язок із вхідної версії — попередження для аналітикині, а не відмова оплаченій відповіді', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, (srcId) => {
    const c = baseContent(srcId);
    // у вхідній версії зв'язок уже не збігається з жодним переходом кроку (історія старіших правил)
    c.questions = [question({ id: 'Q5', text: 'Що з заявкою далі?', affects_transitions: [{ step_id: 'S2', condition: 'умови, якої немає', kind: 'direction' }] })];
    return c;
  });
  const r = await runDelta(db, caseId, (h) => ({
    questions: [{ ...structuredClone(h.questions[0]!), text: 'Що з заявкою далі (звужено до залишку)?' }],
  }));
  assert.equal(r.ok, true, `зв'язок був розірваний до цієї відповіді — відхиляти її не можна: ${r.ok ? '' : r.error}`);
  const w = warningsOf(db, r.ok ? r.runId : '');
  assert.ok(w.some((x) => /Q5/.test(x) && /розірван|не збігається/i.test(x)), `очікували попередження про зв'язок: ${JSON.stringify(w)}`);
  assert.equal(head(db, caseId).questions[0]!.text, 'Що з заявкою далі (звужено до залишку)?');
});

test('4. Контроль: якщо зв’язок новий, він і далі відхиляється (послаблення немає)', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, (srcId) => {
    const c = baseContent(srcId);
    c.questions = [question({ id: 'Q5', text: 'Старе питання', affects_transitions: [{ step_id: 'S2', condition: 'умови, якої немає', kind: 'direction' }] })];
    return c;
  });
  const r = await runDelta(db, caseId, () => ({
    questions: [question({ id: 'Q9', affects_transitions: [{ step_id: 'S2', condition: 'ще одна умова, якої немає', kind: 'direction' }] })],
  }));
  assert.equal(r.ok, false, 'новий розірваний зв’язок — відмова');
  assert.match(r.ok ? '' : r.error, /LINK_BROKEN/);
});


// ───────── 5. Складання в «вигляді моделі»: позначки джерел SRC-xx ─────────

test('5. Кейс із позначками SRC-xx: незгадані кроки повертаються побайтово, зміненими не вважаються', async () => {
  const db = freshDb();
  const { c } = draftReadyCase(db);
  // Друге джерело з позначкою, як у навчальному сценарії: саме її бачить модель замість внутрішнього ID.
  const s2 = addSource(db, human, c.id, { kind: 'clarification', title: 'SRC-02 · Уточнення', content: 'Оператор вносить зміну того ж дня.', origin: 'synthetic', ref: 'SRC-02' });
  const srcs = listSources(db, c.id);
  const first = srcs.find((x) => x.ref === null)!.id;
  const content = baseContent(first);
  content.steps[1]!.source_ids = [first, s2.id];
  content.questions = [question({ id: 'Q5', text: 'Чи підтверджено порядок?', affects_transitions: [{ step_id: 'S2', condition: '', kind: 'unconfirmed_sequence' }] })];
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, c.id).id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);

  let seen: Content | null = null;
  const r = await runAnalyst(db, c.id, new ScriptedDemoClient((i) => {
    seen = i.head_content;
    return { contract: DELTA_CONTRACT, base_version: i.baseVersion, summary: 'Суть уточнено.' };
  }), { contract: 'delta' });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  // Модель бачить позначку, а не внутрішній ID.
  assert.deepEqual(seen!.steps[1]!.source_ids, [first, 'SRC-02']);
  // Після злиття й переведення назад кроки побайтово ті самі, тому «зміненими» вони не вважаються
  // (інакше перевірка прив'язок почала б перевіряти всю стару історію питань).
  const after = head(db, c.id);
  assert.equal(canonical(after.steps), canonical(content.steps), 'кроки не змінились ні в чому');
  assert.deepEqual(after.steps[1]!.source_ids, [first, s2.id], 'внутрішні ID джерел відновлено');
  const checks = JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', r.runId)!.checks_json) as
    { delta: { lists: Record<string, { changed: number; added: number }> }; warnings?: string[] };
  assert.equal(checks.delta.lists.steps!.changed, 0);
  assert.equal(checks.delta.lists.steps!.added, 0);
  assert.equal(after.summary, 'Суть уточнено.');
});


// ───────── 6. Виняток для старих зв'язків не відкриває дорогу погодженню ─────────
//
// Збереження чернетки з розірваним зв'язком допустиме (це чернетка), але невирішена невизначеність потоку
// має й далі блокувати погодження та BPMN. Інакше попередження замість відмови було б послабленням.

test('6. Чернетку з розірваним зв’язком зберегти можна, але погодження заблоковано саме через цей зв’язок', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);           // повний, у звичайному стані придатний до погодження опис
  const content = versionContent(v);
  content.questions = [question({ id: 'Q5', text: 'Що з заявкою далі?', critical: false, origin: 'analyst',
    affects_transitions: [{ step_id: 'S2', condition: 'умови, якої немає', kind: 'direction' }] })];
  const v2 = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: v.id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v2.id, c.id);

  // 1) Запуск агента проходить: зв'язок був розірваний до цієї відповіді (D81), чернетка зберігається.
  const r = await runDelta(db, c.id, (h) => ({ questions: [{ ...structuredClone(h.questions[0]!), text: 'Що з заявкою далі (звужено)?' }] }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.ok(warningsOf(db, r.ok ? r.runId : '').some((x) => /Q5/.test(x)), 'попередження для аналітикині є');

  // 2) Передача на погодження заблокована, і саме через розірваний зв'язок.
  const blockers = submissionBlockers(db, c.id);
  assert.ok(blockers.some((b) => b.code === 'QUESTION_LINK_BROKEN' && b.severity === 'critical' && b.ref === 'Q5'),
    `очікували критичний блокер QUESTION_LINK_BROKEN: ${JSON.stringify(blockers)}`);
  assert.throws(() => submitForApproval(db, human, c.id), (e: { code?: string; details?: { blockers?: { code: string }[] } }) =>
    e.code === 'GUARD_FAILED' && !!e.details?.blockers?.some((b) => b.code === 'QUESTION_LINK_BROKEN'));

  // 3) Погодити не можна (стан лишився «дослідження»), отже й BPMN недоступний.
  const headId = headVersion(db, c.id).id;
  acceptDraft(db, human, c.id, headId);
  assert.throws(() => approve(db, human, c.id, { versionId: headId, checklistConfirmed: true }), (e: { code?: string }) => e.code === 'BAD_STATE' || e.code === 'GUARD_FAILED');
  assert.throws(() => requestBpmnStart(db, human, c.id, 'demo'), (e: { code?: string }) => e.code === 'GUARD_FAILED' || e.code === 'BAD_STATE');
});

test('6. Контроль: той самий опис без розірваного зв’язку на погодження передається', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);            // блокерів немає — отже в попередньому тесті блокував саме зв'язок
  assert.ok(!submissionBlockers(db, c.id).some((b) => b.code === 'QUESTION_LINK_BROKEN'));
});

test('6. Невизначений перехід із відкритим питанням блокує погодження (невирішена невизначеність потоку)', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const content = versionContent(v);
  const v2 = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: v.id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v2.id, c.id);
  // агент додає невідоме продовження з питанням про напрямок — це дозволено й зберігається
  const r = await runDelta(db, c.id, (h) => ({
    steps: [{ ...structuredClone(h.steps[1]!), next: [{ to: 'END', condition: 'умови дозволяють' }, { to: UNKNOWN, condition: 'умови не дозволяють' }] }],
    questions: [question({ id: 'Q9', text: 'Що відбувається, якщо умови не дозволяють зміну?', critical: true,
      criticality_note: 'Без цього гілку не описати', affects_transitions: [{ step_id: 'S2', condition: 'умови не дозволяють', kind: 'direction' }] })],
  }));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const blockers = submissionBlockers(db, c.id);
  assert.ok(blockers.some((b) => b.code === 'UNRESOLVED_TRANSITION' && b.severity === 'critical'), `очікували блокер невизначеного переходу: ${JSON.stringify(blockers)}`);
  assert.throws(() => submitForApproval(db, human, c.id), (e: { code?: string }) => e.code === 'GUARD_FAILED');
});


// ───────── 7. Інструкція однозначно описує саме той випадок, що стався ─────────

test('7. Інструкція (обидва контракти) прямо розводить питання про зміст кроку й питання про напрямок', () => {
  for (const contract of ['full', 'delta'] as const) {
    const t = loadInstruction(undefined, contract).text;
    // питання про зміст кроку — step_detail, переходу не потребує
    assert.match(t, /питання \*\*про зміст кроку\*\*[^.]*`step_detail`/, `${contract}: немає правила «питання про зміст кроку — step_detail»`);
    assert.match(t, /не вимагає \*\*вигаданого переходу\*\*|вигаданого переходу/, `${contract}: немає заборони вигадувати перехід`);
    // питання про напрямок — на перехід, що справді є, з дослівною умовою
    assert.match(t, /дослівно/, `${contract}: немає вимоги дослівної умови`);
    assert.match(t, /справді є/, `${contract}: немає вимоги, щоб перехід у кроці справді існував`);
    // випадок нового кроку без відомого продовження
    assert.match(t, /UNKNOWN` із \*\*порожньою\*\* умовою|порожньою. умовою/, `${contract}: не описано, що робити з новим кроком без відомого продовження`);
    assert.match(t, /переходів немає жодного, питання про потік не прив'язуй|переходів немає жодного, питання про потік не прив’язуй/, `${contract}: не сказано, що до кроку без переходів питання про потік не прив'язують`);
  }
  // Кейсових відповідей в інструкції немає.
  const d = loadInstruction(undefined, 'delta').text;
  for (const forbidden of ['Q39', 'S18', 'case_54a137']) assert.ok(!d.includes(forbidden), `в інструкції не має бути кейсових позначень: ${forbidden}`);
});
