/**
 * Очікувана поведінка агента 1 після НОВОЇ зустрічі (docs/agent1-consistency-spec.md, доповнення D70):
 *  • часткове уточнення: закриття питання відповіддю з джерела позначає опис прив'язаного кроку як місце
 *    для перевірки людиною (правило переглянуто в D73: попередження, а не відмова — код не встановлює змісту);
 *  • справді невідоме зберігається: незмінене «невідоме» з переписаним поясненням видно аналітикині;
 *  • причина проблеми має підставу: слова джерела, гіпотеза зі способом перевірки або «причину не з'ясовано».
 * Дані — мінімальні синтетичні; відповіді «агента» підставні: це перевірка логіки програми, а не якості моделі.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentOutput } from '../src/ai/verify.ts';
import { buildCard, headVersion, insertVersion, protectAnalystEdits } from '../src/domain.ts';
import { parseProblems } from '../src/text-format.ts';
import { loadInstruction } from '../src/ai/prompt.ts';
import { ContentSchema, type Content, type Problem } from '../src/schema.ts';
import { canonical, sha256 } from '../src/hash.ts';
import { Q, T, baseContent } from './agent1-fixtures.ts';
import { freshDb, human } from './helpers.ts';
import { run as sqlRun } from '../src/db.ts';

const setHeadForTest = (db: ReturnType<typeof freshDb>, caseId: string, versionId: string) =>
  sqlRun(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', versionId, caseId);
import { addSource, createCase } from '../src/domain.ts';

/** Кейс із одним синтетичним джерелом і заданим змістом як головою версії. */
function caseWithSource(db: ReturnType<typeof freshDb>, text: string, content: Content) {
  const c = createCase(db, human, 'Кейс для перевірки підстави причини', 'demo');
  const src = addSource(db, human, c.id, { kind: 'transcript', title: 'Синтетична розмова', content: text, origin: 'synthetic' });
  return { caseId: c.id, srcId: src.id, content };
}

const SRC = 'src_test0000001';
const SRC_TEXT = 'Опис зміни я переписую простішою мовою, а потім публікую повідомлення. Мітки для таких випадків у нас немає.';

const ctx = (base: Content) => ({ base, sources: [{ id: SRC, text: SRC_TEXT }], fromModel: (c: Content) => c });
const verify = (base: Content, out: Content) => verifyAgentOutput(structuredClone(out), ctx(base));
const codes = (r: ReturnType<typeof verify>) => (r.ok ? [] : r.violations.map((v) => v.code));
const warns = (r: ReturnType<typeof verify>) => (r.ok ? r.warnings : []);

const step = (id: string, action: string, details: string, next: { to: string; condition?: string }[]) => ({ ...T(id, 'Виконавець', action, 'результат', next), details });

/** Стан після першої зустрічі: загальний крок B із позначкою «зміст невідомий» і питання про його зміст. */
function beforeSecondMeeting(): Content {
  const c = baseContent();
  c.steps = [
    step('A', 'Надсилає запит', 'Канали невідомі.', [{ to: 'B' }]),
    step('B', 'Готує відповідь', 'Зміст підготовки невідомий.', [{ to: 'END' }]),
  ];
  c.questions = [Q('Q1', 'Що саме входить у підготовку відповіді?', [{ step: 'B', condition: '', kind: 'step_detail' }])];
  c.claims = [
    { id: 'C1', text: 'Невідомо, як відповідь потрапляє до замовника і чим завершується процес.', type: 'unknown', source_id: null, quote: '', scope: 'Висновок агента: джерела цього не описують.' },
  ];
  return c;
}

/** Після нової зустрічі: питання Q1 закрито відповіддю з джерела, деталізацію додано окремими кроками. */
function afterSecondMeeting(): Content {
  const c = structuredClone(beforeSecondMeeting());
  c.steps.push(
    step('C', 'Переписує опис простішою мовою', 'За джерелом.', [{ to: 'D' }]),
    step('D', 'Публікує повідомлення', 'За джерелом.', [{ to: 'END' }]),
  );
  c.questions[0] = { ...c.questions[0]!, status: 'closed', answer: 'За джерелом: переписує опис і публікує повідомлення (кроки C–D).', closed_by_source_id: SRC };
  return c;
}

// ───────── 1. Часткове уточнення: місце для перевірки людиною, не блокування ─────────
// Переглянуто в D73 за незалежною перевіркою (Codex). Початкові два тести цього розділу вимагали ВІДМОВИ,
// якщо об'єкт прив'язаного кроку не змінився, — і це закріплювало помилкову вимогу: підтвердження вже
// правильного опису відхилялось, а застарілий текст зі зміненими службовими полями проходив. Код не
// встановлює, чи опис тепер правильний, тому тут попередження з чесним формулюванням; вимога оновлювати
// опис лишається в інструкції (п. 12) і в критерії B11. Деталі випадків А/Б/В — tests/agent1-review-v06.test.ts.

test('1. Агент закрив питання про зміст кроку, а крок лишив без змін — місце позначається для перевірки людиною, без відмови', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  assert.equal(canonical(out.steps[1]), canonical(base.steps[1]), 'крок B у цьому прикладі справді незмінний');
  const r = verify(base, out);
  assert.deepEqual(codes(r), [], `відмови не має бути; отримали: ${codes(r).join(',')}`);
  assert.ok(warns(r).some((w) => w.includes('Q1') && w.includes('кроку B')),
    `очікували попередження про Q1 і крок B, отримали: ${warns(r).join(' | ') || '(порожньо)'}`);
});

test('1. Контроль: якщо агент оновив опис кроку (що з’ясовано і що лишилось невідомим) — відмови немає, місце лишається для перевірки', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.steps[1] = { ...out.steps[1]!, details: 'За джерелом: переписування опису і публікація повідомлення (кроки C–D). Чи повністю вони покривають цей крок, не з’ясовано.' };
  const r = verify(base, out);
  assert.deepEqual(codes(r), []);
  assert.ok(warns(r).some((w) => w.includes('кроку B') && w.includes('опис кроку змінено')),
    'зміна тексту сама по собі не доводить правильності — місце лишається для перевірки');
});

test('1. Контроль: якщо питання лишилось відкритим (уточнено лише частково) — ні відмови, ні місця для перевірки', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.questions[0] = { ...out.questions[0]!, status: 'open', answer: '', closed_by_source_id: null };
  const r = verify(base, out);
  assert.deepEqual(codes(r), []);
  assert.ok(!warns(r).some((w) => w.includes('кроку B')));
});

test('1. Пропозиція заміни кроку не робить застарілий опис актуальним: попередження лишається й прямо це каже', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.step_proposals = [{
    id: 'R1', action: 'replace', step_id: 'B', replacement_step_id: 'C', reason: 'крок B об’єднує кілька дій',
    evidence_source_id: SRC, evidence_quote: 'Опис зміни я переписую простішою мовою', status: 'proposed', decided_by: '', decision_note: '',
  }];
  const r = verify(base, out);
  assert.deepEqual(codes(r), [], 'пропозиція не блокує й сама не застосовується');
  assert.ok(warns(r).some((w) => w.includes('кроку B') && w.includes('пропозиція')),
    `очікували попередження зі згадкою пропозиції, отримали: ${warns(r).join(' | ') || '(порожньо)'}`);
});

test('1. Контроль: питання, прив’язане до нового кроку, застарілим бути не може', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.questions.push({ ...Q('Q2', 'Хто публікує повідомлення?', [{ step: 'D', condition: '', kind: 'step_detail' }]), status: 'closed', answer: 'за джерелом', closed_by_source_id: SRC });
  out.steps[1] = { ...out.steps[1]!, details: 'За джерелом: кроки C–D; решта не з’ясована.' };
  assert.deepEqual(codes(verify(base, out)), []);
});

test('1. Контроль: питання, закрите в попередній версії, не перевіряється знову', () => {
  const base = beforeSecondMeeting();
  base.questions[0] = { ...base.questions[0]!, status: 'closed', answer: 'відповідь', closed_by_source_id: SRC };
  const out = structuredClone(base);
  out.steps.push(step('C', 'Переписує опис простішою мовою', 'За джерелом.', [{ to: 'END' }]));
  assert.deepEqual(codes(verify(base, out)), []);
});

// ───────── 2. Справді невідоме зберігається, але застаріле видно ─────────

test('2. «Невідоме» з переписаним поясненням і незмінним твердженням — попередження аналітикині (не відмова)', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.steps[1] = { ...out.steps[1]!, details: 'За джерелом: кроки C–D.' };
  out.claims[0] = { ...out.claims[0]!, scope: 'Висновок агента за першою зустріччю. Джерело описує публікацію повідомлення; завершення процесу не визначено.' };
  const r = verify(base, out);
  assert.deepEqual(codes(r), [], 'незавершеність не блокує');
  assert.ok(warns(r).some((w) => w.includes('C1')), `очікували попередження про C1, отримали: ${warns(r).join(' | ') || '(порожньо)'}`);
});

test('2. Контроль: незмінене «невідоме» без зміни пояснення попередження не дає (справді невідоме зберігається)', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.steps[1] = { ...out.steps[1]!, details: 'За джерелом: кроки C–D.' };
  const r = verify(base, out);
  assert.deepEqual(codes(r), []);
  assert.ok(!warns(r).some((w) => w.includes('C1')));
});

test('2. Контроль: якщо агент розділив складене «невідоме» — попередження немає', () => {
  const base = beforeSecondMeeting();
  const out = afterSecondMeeting();
  out.steps[1] = { ...out.steps[1]!, details: 'За джерелом: кроки C–D.' };
  out.claims[0] = { ...out.claims[0]!, text: 'Невідомо, чим завершується процес після публікації повідомлення.', scope: 'Висновок агента; джерело описує публікацію, але не завершення.' };
  assert.ok(!warns(verify(base, out)).some((w) => w.includes('C1')));
});

// ───────── 3. Причина проблеми має підставу ─────────

const problem = (over: Partial<Problem> = {}): Problem => ({
  id: 'P1', symptom: 'Випадки не позначаються.', cause: '', impact: 'Масштаб не можна порахувати.', impact_is_estimate: true, ...over,
});

function withProblem(p: Problem, hyp: Content['hypotheses'] = []): Content {
  const c = afterSecondMeeting();
  c.steps[1] = { ...c.steps[1]!, details: 'За джерелом: кроки C–D.' };
  c.problems = [p];
  c.hypotheses = hyp;
  return c;
}

test('3. Нова проблема з причиною без підстави відхиляється (причина не може бути переказом симптому)', () => {
  const base = beforeSecondMeeting();
  const out = withProblem(problem({ cause: 'Немає позначки чи обліку таких випадків.' }));
  assert.ok(codes(verify(base, out)).includes('PROBLEM_CAUSE_NO_BASIS'),
    `очікували PROBLEM_CAUSE_NO_BASIS, отримали: ${codes(verify(base, out)).join(',') || '(порожньо)'}`);
});

test('3. «Причину не з’ясовано» — допустимий стан: текст причини при цьому порожній', () => {
  const base = beforeSecondMeeting();
  assert.deepEqual(codes(verify(base, withProblem(problem({ cause_status: 'not_established' })))), []);
  assert.ok(codes(verify(base, withProblem(problem({ cause_status: 'not_established', cause: 'Немає позначки таких випадків.' }))))
    .includes('PROBLEM_CAUSE_NO_BASIS'), 'при «не з’ясовано» текст причини має бути порожнім');
});

test('3. Причина зі слів джерела потребує джерела й дослівної цитати', () => {
  const base = beforeSecondMeeting();
  const no = withProblem(problem({ cause_status: 'source_stated', cause: 'За словами співрозмовника — мітки немає.' }));
  assert.ok(codes(verify(base, no)).includes('PROBLEM_CAUSE_NO_EVIDENCE'));
  const wrong = withProblem(problem({ cause_status: 'source_stated', cause: 'За словами співрозмовника.', cause_source_id: SRC, cause_quote: 'цього в джерелі немає' }));
  assert.ok(codes(verify(base, wrong)).includes('QUOTE_NOT_FOUND'));
  const ok = withProblem(problem({ cause_status: 'source_stated', cause: 'За словами співрозмовника, мітки для таких випадків немає.', cause_source_id: SRC, cause_quote: 'Мітки для таких випадків у нас немає.' }));
  assert.deepEqual(codes(verify(base, ok)), []);
});

test('3. Можлива причина від агента оформлюється як гіпотеза зі способом перевірки', () => {
  const base = beforeSecondMeeting();
  const hyp = (check: string): Content['hypotheses'] => [{ id: 'H1', author: 'agent', text: 'Випадки не позначають, бо мітка не передбачена в інструменті обліку.', status: 'open', evidence_for: [], evidence_against: [], check_method: check, history: [] }];
  const noRef = withProblem(problem({ cause_status: 'agent_hypothesis', cause: 'Можливо, мітка не передбачена в інструменті обліку.' }), hyp('Перевірити налаштування обліку.'));
  assert.ok(codes(verify(base, noRef)).includes('PROBLEM_CAUSE_NO_HYPOTHESIS'));
  const badRef = withProblem(problem({ cause_status: 'agent_hypothesis', cause: 'Можливо, мітка не передбачена.', cause_hypothesis_id: 'H9' }), hyp('Перевірити налаштування обліку.'));
  assert.ok(codes(verify(base, badRef)).includes('PROBLEM_CAUSE_NO_HYPOTHESIS'));
  const noCheck = withProblem(problem({ cause_status: 'agent_hypothesis', cause: 'Можливо, мітка не передбачена.', cause_hypothesis_id: 'H1' }), hyp(''));
  assert.ok(codes(verify(base, noCheck)).includes('PROBLEM_CAUSE_NO_HYPOTHESIS'));
  const ok = withProblem(problem({ cause_status: 'agent_hypothesis', cause: 'Можливо, мітка не передбачена в інструменті обліку.', cause_hypothesis_id: 'H1' }), hyp('Перевірити налаштування обліку.'));
  assert.deepEqual(codes(verify(base, ok)), []);
});

test('3. Підстава причини перевіряється лише для нових і змінених агентом проблем (старі записи не переписуються)', () => {
  const base = beforeSecondMeeting();
  base.problems = [problem({ cause: 'Немає позначки чи обліку таких випадків.' })];
  const out = withProblem(problem({ cause: 'Немає позначки чи обліку таких випадків.' }));
  assert.deepEqual(codes(verify(base, out)), [], 'наявна проблема без змін не карається');
  const changed = withProblem(problem({ cause: 'Немає позначки чи обліку таких випадків.', impact: 'Інший вплив.' }));
  assert.ok(codes(verify(base, changed)).includes('PROBLEM_CAUSE_NO_BASIS'), 'змінену проблему перевіряємо за новим контрактом');
});

// ───────── 4. Сумісність і захист правок людини ─────────

test('4. Зміст без нових полів читається й хешується як раніше (золотий хеш, обчислений старим кодом)', () => {
  const c = beforeSecondMeeting();
  c.problems = [problem({ cause: 'причина' })];
  const parsed = ContentSchema.parse(JSON.parse(JSON.stringify(c)));
  assert.equal(JSON.stringify(parsed), JSON.stringify(c), 'нові поля не додаються самі');
  assert.equal(sha256(JSON.stringify(parsed)), sha256(JSON.stringify(c)));
});

test('4. Правку аналітикині в проблемі агент не перезаписує разом із підставою причини', () => {
  const base = beforeSecondMeeting();
  base.problems = [problem({ cause: 'Формулювання аналітикині.', cause_status: 'not_established' })];
  const out = structuredClone(base);
  out.problems = [problem({ cause: 'Переказ симптому від агента.', cause_status: 'source_stated', cause_source_id: SRC, cause_quote: 'Мітки для таких випадків у нас немає.' })];
  const { content, conflicts } = protectAnalystEdits(base, out, new Set(['problem:P1']), new Set([SRC]));
  assert.equal(content.problems[0]!.cause, 'Формулювання аналітикині.');
  assert.equal(content.problems[0]!.cause_status, 'not_established');
  assert.ok(conflicts.some((x) => x.key === 'problem:P1'));
});

test('4. Форма аналітикині (симптом | вплив) зберігає підставу причини з попередньої версії', () => {
  const prev = [problem({ cause: 'За словами співрозмовника.', cause_status: 'source_stated', cause_source_id: SRC, cause_quote: 'Мітки для таких випадків у нас немає.' })];
  const next = parseProblems('P1 | Інший симптом | Інший вплив', prev);
  assert.equal(next[0]!.cause_status, 'source_stated');
  assert.equal(next[0]!.cause_quote, 'Мітки для таких випадків у нас немає.');
  assert.equal(next[0]!.cause_source_id, SRC);
  assert.equal(next[0]!.symptom, 'Інший симптом');
});

test('4. Картка показує підставу причини окремо від тексту: джерело з перевіркою цитати, гіпотеза, «не з’ясовано»', () => {
  const db = freshDb();
  const c = beforeSecondMeeting();
  const { caseId, srcId } = caseWithSource(db, SRC_TEXT, c);
  c.problems = [
    problem({ id: 'P1', cause_status: 'not_established' }),
    problem({ id: 'P2', cause: 'За словами співрозмовника, мітки немає.', cause_status: 'source_stated', cause_source_id: srcId, cause_quote: 'Мітки для таких випадків у нас немає.' }),
    problem({ id: 'P3', cause: 'Можливо, мітка не передбачена в інструменті обліку.', cause_status: 'agent_hypothesis', cause_hypothesis_id: 'H1' }),
  ];
  c.hypotheses = [{ id: 'H1', author: 'agent', text: 'Мітка не передбачена в інструменті обліку.', status: 'open', evidence_for: [], evidence_against: [], check_method: 'Перевірити налаштування обліку.', history: [] }];
  const v = insertVersion(db, { caseId, content: c, createdBy: 'analyst', actorName: 'Аналітикиня', parentId: headVersion(db, caseId).id, covered: [], owned: [] });
  setHeadForTest(db, caseId, v.id);
  const card = buildCard(db, caseId, 'demo') as { problems_view: Record<string, unknown>[]; cause_statuses: Record<string, string> };
  const view = new Map(card.problems_view.map((x) => [x.id as string, x]));
  assert.equal(card.cause_statuses.not_established, 'причину не з’ясовано');
  assert.equal(view.get('P1')!.cause_status, 'not_established');
  assert.equal(view.get('P2')!.cause_quote_check, 'quote_found');
  assert.equal(view.get('P3')!.cause_hypothesis_check, 'ok');
});

test('5. Інструкція агента v0.7 містить правила часткового уточнення, межі цитати й підставу причини; службові примітки моделі не передаються', () => {
  const i = loadInstruction();
  assert.equal(i.version, 'analyst-v0.7');
  for (const marker of [
    'Опис стану — не доказ наслідку',
    'Часткове уточнення',
    'Одне «невідоме» — одне твердження',
    'cause_status',
    'not_established',
    'переказ симптому',
  ]) assert.ok(i.text.includes(marker), `в інструкції немає правила: ${marker}`);
  assert.ok(!i.text.includes('evals/'), 'критерії оцінювання не потрапляють у контекст моделі');
  assert.ok(!i.text.includes('runtime:end'));
});
