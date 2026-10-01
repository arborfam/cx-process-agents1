/**
 * Очікувана поведінка агента 1 (docs/agent1-consistency-spec.md): допустима незавершеність, види прив'язки питань до потоку,
 * самоузгодженість виходу агента, початок як межа процесу, ранні перевірки, сумісність зі старими версіями.
 * Дані — мінімальні синтетичні (tests/agent1-fixtures.ts); відповіді «агента» — підставні: це перевірка логіки програми, а не якості моделі.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentOutput } from '../src/ai/verify.ts';
import { analyzePackage } from '../src/bpmn/validate.ts';
import { ScriptedDemoClient, runAnalyst } from '../src/runs.ts';
import { buildCard, bpmnGuard, flowIssues, headVersion, preparationIssues, protectAnalystEdits, submissionBlockers, transitionIssues, versionContent } from '../src/domain.ts';
import { ContentSchema, UNKNOWN, type Content } from '../src/schema.ts';
import { canonical, sha256 } from '../src/hash.ts';
import { one } from '../src/db.ts';
import { freshDb } from './helpers.ts';
import { Q, T, approvedWith, baseContent, caseWith } from './agent1-fixtures.ts';

const ctx = (base: Content) => ({ base, sources: [], fromModel: (c: Content) => c });
const verify = (base: Content, out: Content) => verifyAgentOutput(structuredClone(out), ctx(base));
const codes = (r: ReturnType<typeof verify>) => (r.ok ? [] : r.violations.map((v) => v.code));
const issueCodes = (c: Content) => [...transitionIssues(c), ...flowIssues(c), ...preparationIssues(c)].map((i) => i.code);

/** Чернетка після першої зустрічі: відомий успішний шлях і кілька відкритих невідомих. */
function draft(): Content {
  const c = baseContent();
  c.steps = [
    T('A', 'Замовник', 'Надсилає запит', 'Запит надіслано', [{ to: 'B' }]),
    T('B', 'Виконавець', 'Обробляє запит', 'Запит оброблено', [{ to: 'C' }]),
    T('C', 'Виконавець', 'Надсилає відповідь', 'Відповідь надіслано', [{ to: 'D', condition: 'відповідь прийнято' }, { to: UNKNOWN, condition: 'відповідь не прийнято' }]),
    T('D', 'Виконавець', 'Закриває запит', 'Запит закрито', [{ to: UNKNOWN, condition: '' }]),
  ];
  c.questions = [
    Q('Q1', 'Що відбувається, якщо замовник запізно надіслав дані?', [{ step: 'A', condition: '', kind: 'exception' }]),
    Q('Q2', 'Чи справді обробка йде після надсилання, а не паралельно?', [{ step: 'B', condition: '', kind: 'unconfirmed_sequence' }]),
    Q('Q3', 'Хто саме в команді обробляє запит?', [{ step: 'B', condition: '', kind: 'step_detail' }]),
    Q('Q4', 'Що відбувається, якщо відповідь не прийнято?', [{ step: 'C', condition: 'відповідь не прийнято', kind: 'direction' }]),
    Q('Q5', 'Де завершується процес?', [{ step: 'D', condition: '', kind: 'direction' }], { critical: true }),
  ];
  return c;
}

// ───────── А. Допустима незавершеність ─────────

test('А. Чернетка після першої зустрічі проходить перевірку агента: невідоме, винятки, непідтверджена послідовність, порожній початок — без вигаданих відповідей', () => {
  const base = baseContent();
  const out = draft();
  assert.equal(out.entry_step_id ?? null, null, 'початок не заданий');
  assert.deepEqual(codes(verify(base, out)), []);
});

test('А. Незавершеність не знімає блокувань: невизначені напрямки, непідтверджена послідовність, критичне питання й початок лишаються прогалинами', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, draft());
  const b = submissionBlockers(db, caseId).filter((x) => x.severity === 'critical').map((x) => x.code);
  for (const code of ['UNRESOLVED_TRANSITION', 'SEQUENCE_UNCONFIRMED', 'CRITICAL_QUESTION', 'ENTRY_MISSING']) assert.ok(b.includes(code), `${code} має блокувати; є: ${b.join(',')}`);
  assert.ok(!b.includes('CONTRADICTION'), 'жодного питання про напрямок відомого переходу');
});

test('Д. Відома гілка співіснує з невідомою альтернативою; виняток і уточнення кроку самі переходів не блокують', () => {
  const c = draft();
  const codesNow = transitionIssues(c).map((i) => `${i.code}:${i.ref}`);
  assert.ok(!codesNow.some((x) => x.startsWith('CONTRADICTION')));
  // виняток (Q1) і уточнення кроку (Q3) не дають жодного блокера переходів
  assert.ok(!transitionIssues(c).some((i) => i.ref === 'Q1' || i.ref === 'Q3'));
  // невідома альтернатива кроку C: блокує лише вона (питання про напрямок Q4)
  const unresolved = transitionIssues(c).filter((i) => i.code === 'UNRESOLVED_TRANSITION').map((i) => i.ref);
  assert.deepEqual(unresolved.sort(), ['C', 'D']);
});

test('Д. Виняток, позначений критичним, блокує як критичне питання (критичність не знижується видом прив’язки)', () => {
  const db = freshDb();
  const c = draft();
  c.questions.find((q) => q.id === 'Q1')!.critical = true;
  const { caseId } = caseWith(db, c);
  assert.ok(submissionBlockers(db, caseId).some((b) => b.code === 'CRITICAL_QUESTION' && b.ref === 'Q1'));
});

test('Д. Непідтверджена послідовність блокує й побудову: генератор бачить її як K1 до спроби побудови', () => {
  const c = draft();
  c.entry_step_id = 'A';
  const r = analyzePackage({ versionId: 'TEST', contentHash: 'a'.repeat(64), content: c, origin: 'test-fixture' });
  assert.ok(r.blocking.some((f) => f.code === 'SEQUENCE_UNCONFIRMED' && f.class === 'K1'), r.blocking.map((f) => f.code).join(','));
});

test('Д. Відкрите питання про напрямок невідомого переходу кінця процесу не можна «зняти» видом прив’язки у самій перевірці: UNKNOWN без питання про напрямок — порушення', () => {
  const base = baseContent();
  const out = draft();
  out.questions = out.questions.filter((q) => q.id !== 'Q5');
  assert.ok(codes(verify(base, out)).includes('UNKNOWN_WITHOUT_DIRECTION_QUESTION'));
  const out2 = draft();
  out2.questions.find((q) => q.id === 'Q5')!.affects_transitions![0]!.kind = 'exception';
  assert.ok(codes(verify(base, out2)).includes('LINK_KIND_UNKNOWN_TARGET'));
});

// ───────── В. Внутрішньо суперечливий результат ─────────

test('В. Відхиляється: питання про напрямок відомого переходу; підказка називає чотири способи виправлення', () => {
  const base = baseContent();
  const out = draft();
  out.questions.push(Q('Q6', 'Що, якщо обробка не вдалась?', [{ step: 'B', condition: '' }]));
  const r = verify(base, out);
  assert.ok(codes(r).includes('LINK_DIRECTION_KNOWN_TARGET'));
  const msg = r.ok ? '' : r.violations.find((v) => v.code === 'LINK_DIRECTION_KNOWN_TARGET')!.message;
  for (const w of [UNKNOWN, 'unconfirmed_sequence', 'exception', 'step_detail']) assert.ok(msg.includes(w), `підказка без «${w}»`);
});

test('В. НЕ відхиляється: єдиний перехід у «невідомо» з текстом, дві справжні гілки, незмінені старі кроки з тими самими вадами', () => {
  const base = baseContent();
  const out = draft();
  assert.deepEqual(codes(verify(base, out)), []);
  // стара вада, що вже була в батьківській версії, не карається повторно
  const withDefect = structuredClone(draft());
  withDefect.steps[0]!.next = [{ to: 'B', condition: 'запит надіслано' }];
  assert.ok(codes(verify(base, withDefect)).includes('SEQUENTIAL_WITH_CONDITION'));
  assert.deepEqual(codes(verify(withDefect, withDefect)), [], 'ті самі кроки в батьківській версії — не нове порушення агента');
});

test('В. Звичайну послідовність не перетворюють на розгалуження: умова на єдиному переході відхиляється, справжні умови (≥ 2 гілок) — ні, зміст не переписується', () => {
  const base = baseContent();
  const bad = draft();
  bad.steps[1]!.next = [{ to: 'C', condition: 'Запит оброблено' }];
  assert.ok(codes(verify(base, bad)).includes('SEQUENTIAL_WITH_CONDITION'));
  const good = draft();
  const r = verify(base, good);
  assert.ok(r.ok);
  assert.equal(canonical(r.ok ? r.content.steps[2]!.next : null), canonical(good.steps[2]!.next), 'справжні умови не чіпаємо');
});

test('В. Невизначеність не живе в тексті кроку («див. Q…»), назва дії коротка, деталі — окремо', () => {
  const base = baseContent();
  for (const field of ['action', 'result', 'condition'] as const) {
    const out = draft();
    if (field === 'condition') out.steps[2]!.next[0]!.condition = 'відповідь прийнято (див. Q4)'; else out.steps[0]![field] = `Текст (див. Q7)`;
    assert.ok(codes(verify(base, out)).includes('UNCERTAINTY_IN_STEP_TEXT'), field);
  }
  const edge = draft();
  // межа — 160 символів (літерал, а не імпорт константи: тест не має «підлаштовуватись» під змінене значення)
  edge.steps[0]!.action = 'а'.repeat(160);
  assert.deepEqual(codes(verify(base, edge)), []);
  edge.steps[0]!.action = 'а'.repeat(161);
  assert.ok(codes(verify(base, edge)).includes('ACTION_TOO_LONG'));
  const withDetails = draft();
  withDetails.steps[0]!.details = 'Канали, приклади й подробиці. '.repeat(30);
  assert.deepEqual(codes(verify(base, withDetails)), [], 'довгі деталі допустимі окремо від назви дії');
});

test('В. Питання, прив’язане до неіснуючого переходу чи кроку, відхиляється; уточнення кроку вимагає лише кроку', () => {
  const base = baseContent();
  const out = draft();
  out.questions.push(Q('Q6', 'Питання?', [{ step: 'B', condition: 'такої умови немає', kind: 'exception' }]));
  assert.ok(codes(verify(base, out)).includes('LINK_BROKEN'));
  const out2 = draft();
  out2.questions.push(Q('Q6', 'Питання?', [{ step: 'ZZ', condition: '', kind: 'step_detail' }]));
  assert.ok(codes(verify(base, out2)).includes('LINK_BROKEN'));
});

test('В. Агент не створює й не змінює історію виправлень прив’язки: вона нормалізується програмою', () => {
  const base = baseContent();
  const out = draft();
  (out.questions[0] as { link_history?: unknown }).link_history = [{ at: 'x', by: 'агент', step_id: 'A', condition: '', from: 'direction', to: 'exception', note: 'самовільно' }];
  const r = verify(base, out);
  assert.ok(r.ok);
  assert.equal(r.ok && r.content.questions[0]!.link_history, undefined);
});

test('В. Новий крок, недосяжний від початку аналітикині, — попередження, а не відмова (чернетка може бути незавершеною)', () => {
  const base = draft();
  base.entry_step_id = 'A';
  const out = structuredClone(base);
  out.steps.push(T('E', 'Виконавець', 'Окремий крок без входу', 'Результат', [{ to: 'END' }]));
  const r = verify(base, out);
  assert.ok(r.ok);
  assert.ok(r.ok && r.warnings.some((w) => /Новий крок E недосяжний/.test(w)));
});

// ───────── Б. Початок і межі — рішення людини ─────────

test('Б. Початковий крок задає лише аналітикиня: агент не ставить і не змінює його (зміна відкидається із записом конфлікту); та сама позиція без конфлікту', () => {
  const base = draft();
  const agentSets = structuredClone(base);
  agentSets.entry_step_id = 'B';
  const r1 = protectAnalystEdits(base, agentSets, new Set(), new Set());
  assert.equal(r1.content.entry_step_id ?? null, null);
  assert.ok(r1.conflicts.some((c) => c.key === 'entry_step_id' && /задає лише аналітикиня/.test(c.note)));
  const analystSet = structuredClone(base);
  analystSet.entry_step_id = 'A';
  const agentChanges = structuredClone(analystSet);
  agentChanges.entry_step_id = 'C';
  const r2 = protectAnalystEdits(analystSet, agentChanges, new Set(['entry_step_id']), new Set());
  assert.equal(r2.content.entry_step_id, 'A', 'вибір аналітикині збережено');
  const same = protectAnalystEdits(analystSet, structuredClone(analystSet), new Set(), new Set());
  assert.ok(!same.conflicts.some((c) => c.key === 'entry_step_id'));
});

test('Б. Прогін агента: початок, поставлений моделлю, не потрапляє у версію; правки й питання лишаються; версія — після запуску, історія незмінна', async () => {
  const db = freshDb();
  const { caseId, version } = caseWith(db, baseContent(), 'analyst');
  const before = one<{ content_json: string; content_hash: string }>(db, 'SELECT content_json, content_hash FROM as_is_version WHERE id = ?', version.id)!;
  const out = draft();
  out.entry_step_id = 'A';
  const res = await runAnalyst(db, caseId, new ScriptedDemoClient(() => out));
  assert.ok(res.ok, res.ok ? '' : res.error);
  const head = versionContent(headVersion(db, caseId));
  assert.equal(head.entry_step_id ?? null, null);
  assert.ok(head.conflicts.some((c) => c.key === 'entry_step_id'));
  assert.ok(submissionBlockers(db, caseId).some((b) => b.code === 'ENTRY_MISSING'));
  assert.deepEqual(one(db, 'SELECT content_json, content_hash FROM as_is_version WHERE id = ?', version.id), before, 'попередня версія незмінна');
});

// ───────── Е. Ранні перевірки узгоджено з генератором ─────────

test('Е. Єдиний перехід з умовою пояснюється до побудови: готовність чернетки і серверний дозвіл; справжні умови не чіпаються, зміст не переписується', () => {
  const db = freshDb();
  const c = baseContent();
  c.entry_step_id = 'A';
  c.steps = [
    T('A', 'Виконавець', 'Крок А', 'Р', [{ to: 'B', condition: 'Результат отримано' }]),
    T('B', 'Виконавець', 'Крок Б', 'Р', [{ to: 'END', condition: 'успіх' }, { to: 'A', condition: 'невдача' }]),
  ];
  const { caseId, version } = approvedWith(db, c);
  const hash = version.content_hash;
  const reasons = bpmnGuard(db, caseId).reasons;
  assert.deepEqual(reasons.map((r) => r.code), ['SINGLE_CONDITIONAL_BRANCH'], 'лише крок А; крок Б має справжні умови');
  assert.match(reasons[0]!.message, /Крок A: єдиний вихідний перехід має умову/);
  const card = buildCard(db, caseId, 'demo');
  const check = card.review.checks.find((x) => x.key === 'conditions')!;
  assert.equal(check.status, 'warn');
  assert.equal(one<{ content_hash: string }>(db, 'SELECT content_hash FROM as_is_version WHERE id = ?', version.id)!.content_hash, hash, 'зміст не переписано');
  // той самий результат дає генератор — правила узгоджені
  const g = analyzePackage({ versionId: 'T', contentHash: 'a'.repeat(64), content: c, origin: 'test-fixture' });
  assert.deepEqual(g.blocking.filter((f) => f.code === 'SINGLE_CONDITIONAL_BRANCH').map((f) => f.refs[0]), ['A']);
});

test('Е. Перехід у «невідомо» з текстом не рахується єдиним умовним (його пояснює питання)', () => {
  const c = draft();
  assert.ok(!preparationIssues(c).length);
});

// ───────── Ж. Сумісність зі старими версіями ─────────

test('Ж. Версії без нових полів читаються, хешуються й перевіряються як раніше: схема не дописує полів; «питання без виду» = напрямок', () => {
  const legacy = baseContent();
  legacy.entry_step_id = 'A';
  legacy.steps = [T('A', 'Виконавець', 'Крок', 'Р', [{ to: 'END', condition: 'Р' }])];
  legacy.questions = [Q('Q1', 'Питання про напрямок?', [{ step: 'A', condition: 'Р' }])];
  const raw = JSON.parse(JSON.stringify(legacy));
  assert.equal(canonical(ContentSchema.parse(raw)), canonical(raw), 'розбір не змінює зміст (хеш сталий)');
  assert.equal(sha256(canonical(ContentSchema.parse(raw))), sha256(canonical(raw)));
  assert.ok(!('kind' in (raw.questions[0].affects_transitions[0])) && !('details' in raw.steps[0]) && !('link_history' in raw.questions[0]));
  assert.ok(issueCodes(legacy).includes('CONTRADICTION'), 'без виду прив’язка — напрямок: поведінка не змінилась');
});

// ───────── З. Журнал спроб ─────────

test('З. Причини невдалої спроби зберігаються в журналі запуску навіть коли наступна спроба вдала', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, baseContent(), 'analyst');
  let n = 0;
  const bad = draft();
  bad.steps[0]!.next = [{ to: 'B', condition: 'запит надіслано' }];
  const res = await runAnalyst(db, caseId, new ScriptedDemoClient(() => (++n === 1 ? bad : draft())));
  assert.ok(res.ok, res.ok ? '' : res.error);
  const row = one<{ attempts: number; checks_json: string }>(db, 'SELECT attempts, checks_json FROM run WHERE id = ?', res.runId)!;
  assert.equal(row.attempts, 2);
  const checks = JSON.parse(row.checks_json) as { failed_attempts: { attempt: number; kind: string; violations: { code: string }[] }[] };
  assert.equal(checks.failed_attempts.length, 1);
  assert.equal(checks.failed_attempts[0]!.kind, 'invalid_output');
  assert.ok(checks.failed_attempts[0]!.violations.some((v) => v.code === 'SEQUENTIAL_WITH_CONDITION'));
});
