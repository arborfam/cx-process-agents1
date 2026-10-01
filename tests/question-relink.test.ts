/**
 * Явне виправлення помилкової прив'язки питання до потоку: нова версія, історія, питання лишається відкритим і критичність не знижується,
 * масового відкріплення немає, справжній невідомий перехід «виправити» не можна, блокування лишається, агент правку не переписує.
 * Синтетичні приклади, що відтворюють класи питань першого справжнього прогону: Q7-подібне (виняток), Q11-подібне, Q13-подібне (порядок), Q12-подібне (завершення).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import { UNKNOWN, type Content } from '../src/schema.ts';
import { agent, freshDb, human, startTestServer } from './helpers.ts';
import { Q, T, baseContent, caseWith, headContent } from './agent1-fixtures.ts';
import { ScriptedDemoClient, runAnalyst } from '../src/runs.ts';
import { headVersion, relinkQuestion, submissionBlockers, transitionIssues, versionContent } from '../src/domain.ts';

/** Усі чотири питання агент прив'язав «за замовчуванням» (як напрямок) до відомих переходів, окрім кінця процесу. */
function mislinked(): Content {
  const c = baseContent();
  c.entry_step_id = 'K1';
  c.steps = [
    T('K1', 'Замовник', 'Надсилає запит', 'Запит надіслано', [{ to: 'K2' }]),
    T('K2', 'Виконавець', 'Просить матеріали', 'Матеріали отримано', [{ to: 'K3' }]),
    T('K3', 'Виконавець', 'Готує текст', 'Текст готовий', [{ to: 'K4' }]),
    T('K4', 'Виконавець', 'Публікує', 'Опубліковано', [{ to: UNKNOWN, condition: '' }]),
  ];
  c.questions = [
    Q('Q7', 'Що відбувається, коли інформація надходить пізно?', [{ step: 'K1', condition: '' }]),
    Q('Q11', 'Що, якщо матеріалів не надано?', [{ step: 'K2', condition: '' }]),
    Q('Q13', 'Чи встановлений порядок: текст, потім публікація?', [{ step: 'K3', condition: '' }]),
    Q('Q12', 'Де завершується процес?', [{ step: 'K4', condition: '' }], { critical: true }),
  ];
  return c;
}
const contradictions = (c: Content) => transitionIssues(c).filter((i) => i.code === 'CONTRADICTION').map((i) => i.ref).sort();
const rel = (db: ReturnType<typeof freshDb>, caseId: string, q: string, step: string, to: 'direction' | 'unconfirmed_sequence' | 'exception' | 'step_detail', note = 'питання не про напрямок') =>
  relinkQuestion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: q, stepId: step, condition: '', toKind: to, note });

test('Стан до виправлення: три «суперечності» (Q7, Q11, Q13) і справжній невідомий кінець (Q12)', () => {
  const c = mislinked();
  assert.deepEqual(contradictions(c), ['Q11', 'Q13', 'Q7']);
  assert.deepEqual(transitionIssues(c).filter((i) => i.code === 'UNRESOLVED_TRANSITION').map((i) => i.ref), ['K4']);
});

test('Q7/Q11 (невідомий виняток): виправлення створює нову версію з історією; питання відкрите, критичність і текст незмінні; суперечність зникає лише для нього', () => {
  const db = freshDb();
  const { caseId, version } = caseWith(db, mislinked(), 'analyst');
  const oldRow = one(db, 'SELECT content_json, content_hash FROM as_is_version WHERE id = ?', version.id);
  const n0 = all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', caseId).length;
  const v = rel(db, caseId, 'Q7', 'K1', 'exception', 'Це питання про виняток, а не про напрямок');
  const c = versionContent(v);
  const q = c.questions.find((x) => x.id === 'Q7')!;
  assert.deepEqual([q.status, q.critical, q.text], ['open', false, 'Що відбувається, коли інформація надходить пізно?']);
  assert.equal(q.affects_transitions![0]!.kind, 'exception');
  assert.equal(q.link_history!.length, 1);
  assert.deepEqual([q.link_history![0]!.from, q.link_history![0]!.to, q.link_history![0]!.by], ['direction', 'exception', 'Аналітикиня']);
  assert.match(q.link_history![0]!.note, /виняток/);
  assert.equal(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', caseId).length, n0 + 1, 'нова версія');
  assert.deepEqual(one(db, 'SELECT content_json, content_hash FROM as_is_version WHERE id = ?', version.id), oldRow, 'історична версія незмінна');
  assert.deepEqual(contradictions(c), ['Q11', 'Q13'], 'масового відкріплення немає: інші питання лишились як були');
  assert.match(v.note, /Q7.*змінено з «напрямок переходу невизначений» на «невідомий виняток/);
  assert.ok(all<{ action: string }>(db, 'SELECT action FROM audit_log WHERE case_id = ?', caseId).some((a) => a.action === 'question_link_changed'));
});

test('Q13 (порядок не підтверджено): виправлення на «послідовність не підтверджена» ЗБЕРІГАЄ блокування, але з правильним поясненням', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, mislinked(), 'analyst');
  const v = rel(db, caseId, 'Q13', 'K3', 'unconfirmed_sequence', 'Порядок кроків справді не підтверджено джерелами');
  const issues = transitionIssues(versionContent(v));
  assert.ok(!issues.some((i) => i.code === 'CONTRADICTION' && i.ref === 'Q13'));
  assert.ok(issues.some((i) => i.code === 'SEQUENCE_UNCONFIRMED' && i.ref === 'Q13'));
  assert.ok(submissionBlockers(db, caseId).some((b) => b.code === 'SEQUENCE_UNCONFIRMED' && b.severity === 'critical'));
  // відповідь на питання закриває прогалину
  const closed = versionContent(v);
  closed.questions.find((q) => q.id === 'Q13')!.status = 'closed';
  assert.ok(!transitionIssues(closed).some((i) => i.code === 'SEQUENCE_UNCONFIRMED'));
});

test('Q12 (справжній невідомий кінець): прив’язку про напрямок «виправити» не можна; змінити на не-напрямок також; блокування лишається', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, mislinked(), 'analyst');
  for (const to of ['exception', 'unconfirmed_sequence', 'step_detail'] as const) {
    assert.throws(() => rel(db, caseId, 'Q12', 'K4', to), (e: any) => e.code === 'TRANSITION_UNKNOWN', to);
  }
  assert.ok(submissionBlockers(db, caseId).some((b) => b.code === 'UNRESOLVED_TRANSITION' && b.severity === 'critical'));
});

test('Критичність не знижується: критичне питання після виправлення лишається критичним і блокує як критичне', () => {
  const db = freshDb();
  const c = mislinked();
  c.questions.find((q) => q.id === 'Q11')!.critical = true;
  const { caseId } = caseWith(db, c, 'analyst');
  const v = rel(db, caseId, 'Q11', 'K2', 'exception');
  assert.equal(versionContent(v).questions.find((q) => q.id === 'Q11')!.critical, true);
  assert.ok(submissionBlockers(db, caseId).some((b) => b.code === 'CRITICAL_QUESTION' && b.ref === 'Q11'));
});

test('Відхилення: без пояснення; закрите питання; немає прив’язки; той самий вид; невідомий вид; «напрямок» для відомого переходу; винятки/послідовність для невідомого; агент', () => {
  const db = freshDb();
  const c = mislinked();
  c.questions.push(Q('Q20', 'Закрите?', [{ step: 'K1', condition: '' }], { status: 'closed' }));
  const { caseId } = caseWith(db, c, 'analyst');
  const head = () => headVersion(db, caseId).id;
  const call = (over: Record<string, unknown>) => relinkQuestion(db, human, caseId, { baseVersionId: head(), questionId: 'Q7', stepId: 'K1', condition: '', toKind: 'exception', note: 'пояснення є', ...over } as never);
  assert.throws(() => call({ note: '  ' }), (e: any) => e.code === 'VALIDATION');
  assert.throws(() => call({ note: 'ні' }), (e: any) => e.code === 'VALIDATION');
  assert.throws(() => call({ questionId: 'Q20' }), (e: any) => e.code === 'QUESTION_CLOSED');
  assert.throws(() => call({ questionId: 'Q404' }), (e: any) => e.code === 'NOT_FOUND');
  assert.throws(() => call({ stepId: 'K3' }), (e: any) => e.code === 'LINK_NOT_FOUND');
  assert.throws(() => call({ toKind: 'direction' }), (e: any) => e.code === 'VALIDATION', 'той самий вид');
  assert.throws(() => call({ toKind: 'вигаданий' }), (e: any) => e.code === 'VALIDATION');
  call({});
  assert.throws(() => call({ toKind: 'direction' }), (e: any) => e.code === 'LINK_TARGET_KNOWN', 'відомий перехід не може мати питання про напрямок');
  assert.throws(() => relinkQuestion(db, agent, caseId, { baseVersionId: head(), questionId: 'Q11', stepId: 'K2', condition: '', toKind: 'exception', note: 'агент' }), (e: any) => e.code === 'FORBIDDEN');
  assert.throws(() => call({ baseVersionId: 'ver_stale', questionId: 'Q11', stepId: 'K2', toKind: 'exception' }), (e: any) => e.code === 'VERSION_CONFLICT');
});

test('Агент не переписує виправлену прив’язку: зміна відкидається із записом конфлікту, історія лишається', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, mislinked(), 'analyst');
  rel(db, caseId, 'Q7', 'K1', 'exception');
  const cur = headContent(db, caseId);
  const out = structuredClone(cur);
  const q = out.questions.find((x) => x.id === 'Q7')!;
  q.affects_transitions![0]!.kind = 'unconfirmed_sequence';
  q.link_history = [];
  const res = await runAnalyst(db, caseId, new ScriptedDemoClient(() => out));
  assert.ok(res.ok, res.ok ? '' : res.error);
  const head = headContent(db, caseId);
  const kept = head.questions.find((x) => x.id === 'Q7')!;
  assert.equal(kept.affects_transitions![0]!.kind, 'exception');
  assert.equal(kept.link_history!.length, 1);
  assert.ok(head.conflicts.some((c) => c.key === 'question:Q7.link'));
});

test('Агент у нових відповідях сам обирає вид прив’язки: допустимі види проходять, а відомий перехід із «напрямком» відхиляється й не потрапляє у версію', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, mislinked(), 'analyst');
  const out = mislinked();
  // агент виправив власну ваду: Q7 → виняток, Q13 → порядок, Q11 → виняток; Q12 лишається напрямком
  out.questions.find((q) => q.id === 'Q7')!.affects_transitions![0]!.kind = 'exception';
  out.questions.find((q) => q.id === 'Q11')!.affects_transitions![0]!.kind = 'exception';
  out.questions.find((q) => q.id === 'Q13')!.affects_transitions![0]!.kind = 'unconfirmed_sequence';
  const res = await runAnalyst(db, caseId, new ScriptedDemoClient(() => out));
  assert.ok(res.ok, res.ok ? '' : res.error);
  assert.deepEqual(contradictions(headContent(db, caseId)), []);
  const before = headVersion(db, caseId).id;
  const bad = structuredClone(headContent(db, caseId));
  bad.questions.push(Q('Q30', 'Нове питання про напрямок відомого переходу?', [{ step: 'K2', condition: '' }]));
  const r2 = await runAnalyst(db, caseId, new ScriptedDemoClient(() => bad));
  assert.ok(!r2.ok);
  assert.equal(headVersion(db, caseId).id, before, 'суперечливий результат не збережено');
});

test('HTTP: виправлення потребує сесії й заголовка; тіло з «закритий»/«критичне» ігнорується; невідомий вид — 400; картка показує історію й підписи видів', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, mislinked(), 'analyst');
  const s = await startTestServer(db);
  try {
    const card = (await s.call('GET', `/api/cases/${caseId}`)).body;
    const body = { base_version_id: card.head.id, question_id: 'Q7', step_id: 'K1', condition: '', to_kind: 'exception', note: 'це виняток', status: 'closed', critical: false };
    assert.equal((await s.call('POST', `/api/cases/${caseId}/questions/relink`, body, { auth: false })).status, 401);
    assert.equal((await s.call('POST', `/api/cases/${caseId}/questions/relink`, { ...body, to_kind: 'щось' })).status, 400);
    const ok = await s.call('POST', `/api/cases/${caseId}/questions/relink`, body);
    assert.equal(ok.status, 201);
    const after = (await s.call('GET', `/api/cases/${caseId}`)).body;
    const q7 = after.head.content.questions.find((q: any) => q.id === 'Q7');
    assert.deepEqual([q7.status, q7.critical, q7.link_history.length], ['open', false, 1]);
    assert.ok(after.link_kinds.unconfirmed_sequence);
    assert.equal(after.gaps.filter((g: any) => g.code === 'CONTRADICTION').length, 2);
  } finally { await s.close(); }
});
