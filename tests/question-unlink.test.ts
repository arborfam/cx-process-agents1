/**
 * Відкріплення питання від ВИЛУЧЕНОГО кроку — явна дія аналітикині (D82).
 *
 * Підстава — блокер особистого наскрізного прогону: після прийняття пропозицій вилучення кроків відкриті
 * питання лишились прив'язаними до кроків, яких уже немає. Це критичні технічні прогалини
 * (`QUESTION_LINK_BROKEN`), і прибрати їх було нічим: зміна ВИДУ прив'язки відсутнього кроку не лікує
 * (крок однаково відсутній), а закривати питання вигаданою відповіддю не можна.
 *
 * Тут перевіряється: відтворення дефекту, успішне відкріплення, збереження питання, історії та інших
 * прив'язок, межі дії (лише справді відсутній крок), захист від агента через чинний delta-шлях і те, що
 * справжні блокери погодження й BPMN лишаються. Усе синтетичне; жодних спеціальних умов для конкретних ID.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, type DB } from '../src/db.ts';
import { canonical } from '../src/hash.ts';
import { DELTA_CONTRACT } from '../src/ai/delta.ts';
import { runAnalyst, ScriptedDemoClient } from '../src/runs.ts';
import {
  acceptDraft, approve, decideStepProposals, getVersion, headVersion, insertVersion, listSources, previewAccept,
  previewUnlink, relinkQuestion, requestBpmnStart, staleQuestionLinks, submissionBlockers, submitForApproval,
  unlinkQuestionFromMissingStep, versionContent, type Actor,
} from '../src/domain.ts';
import type { Content, Question, Step } from '../src/schema.ts';
import { agent, draftReadyCase, freshDb, human, startTestServer } from './helpers.ts';

const QUOTE = 'Менеджер приймає запит';

const step = (over: Partial<Step> & { id: string }): Step => ({
  role: 'Оператор', action: 'Виконує дію', entry_condition: '', input_artifact: '', result: 'Результат', next: [], source_ids: [], ...over,
});
const question = (over: Partial<Question> & { id: string }): Question => ({
  text: 'Питання про ділянку процесу?', critical: false, impact: 'Уточнить опис', addressee: 'Оператор', status: 'open',
  answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '', ...over,
});

/**
 * Кейс у звичайному придатному до погодження стані + зайвий крок S3 (нікуди не веде з потоку), питання Q7 з
 * прив'язкою до нього й пропозиція агента цей крок вилучити. `extraQuestions` — «справжні» прогалини для контролю.
 */
function caseWithRemovable(db: DB, extraQuestions: Question[] = []) {
  const { c, v } = draftReadyCase(db);
  const srcId = listSources(db, c.id)[0]!.id;
  const content: Content = structuredClone(versionContent(v));
  content.steps.push(step({ id: 'S3', action: 'Готує окрему довідку', result: 'Довідка готова', next: [{ to: 'END', condition: '' }], source_ids: [srcId] }));
  content.questions = [
    question({ id: 'Q7', text: 'Що робить виконавець, коли інформація надходить після запуску?', affects_transitions: [{ step_id: 'S3', condition: '', kind: 'exception' }] }),
    ...extraQuestions,
  ];
  content.step_proposals = [{
    id: 'SP1', action: 'remove', step_id: 'S3', replacement_step_id: '', reason: 'Крок описано хибно: це інша ділянка процесу',
    evidence_source_id: srcId, evidence_quote: QUOTE, status: 'proposed', decided_by: '', decision_note: '',
  }];
  const v2 = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: v.id, covered: [srcId], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v2.id, c.id);
  return { caseId: c.id, srcId, versionId: v2.id };
}

/** Прийняття пропозиції вилучення (як це робить аналітикиня в інтерфейсі: показ наслідків → рішення). */
function acceptRemoval(db: DB, caseId: string) {
  const head = headVersion(db, caseId);
  const pv = previewAccept(versionContent(head), ['SP1'], { caseId, versionId: head.id });
  return { pv, version: decideStepProposals(db, human, caseId, { baseVersionId: head.id, proposalIds: ['SP1'], previewHash: pv.hash, acknowledge: true }) };
}

const blockerCodes = (db: DB, caseId: string) => submissionBlockers(db, caseId).map((b) => b.code);
const head = (db: DB, caseId: string) => versionContent(headVersion(db, caseId));

// ───────── 1. Відтворення дефекту ─────────

test('1. Дефект: після прийняття вилучення питання лишається прив’язаним до відсутнього кроку й блокує погодження', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  assert.deepEqual(staleQuestionLinks(head(db, caseId)), [], 'до прийняття прив’язка чинна');
  acceptRemoval(db, caseId);
  const after = head(db, caseId);
  assert.equal(after.steps.some((s) => s.id === 'S3'), false, 'крок вилучено');
  assert.deepEqual(after.questions[0]!.affects_transitions, [{ step_id: 'S3', condition: '', kind: 'exception' }], 'прив’язка лишилась — сама вона не зникає');
  assert.ok(blockerCodes(db, caseId).includes('QUESTION_LINK_BROKEN'), 'це критична технічна прогалина');
  assert.throws(() => submitForApproval(db, human, caseId), (e: { code?: string }) => e.code === 'GUARD_FAILED');
});

test('1. Зміна ВИДУ прив’язки відсутнього кроку проблему не вирішує (саме це й було тупиком)', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  relinkQuestion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', toKind: 'step_detail', note: 'спроба обійти прогалину' });
  assert.ok(blockerCodes(db, caseId).includes('QUESTION_LINK_BROKEN'), 'крок однаково відсутній — прогалина лишається');
});

// ───────── 2. Успішне відкріплення ─────────

test('2. Відкріплення прибирає прогалину, зберігає питання, історію й інші прив’язки', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  const before = head(db, caseId);
  const beforeQ = structuredClone(before.questions[0]!);
  const beforeVersionId = headVersion(db, caseId).id;
  const beforeHash = headVersion(db, caseId).content_hash;

  const v = unlinkQuestionFromMissingStep(db, human, caseId, {
    baseVersionId: beforeVersionId, questionId: 'Q7', stepId: 'S3', condition: '',
    note: 'Крок S3 вилучено разом із ділянкою процесу, яка не входить у межі',
  });

  const after = head(db, caseId);
  const q = after.questions.find((x) => x.id === 'Q7')!;
  assert.equal(after.questions.length, before.questions.length, 'питання не зникло й нових не з’явилось');
  assert.equal(q.status, 'open', 'питання лишилось відкритим');
  assert.equal(q.text, beforeQ.text, 'текст не змінився');
  assert.equal(q.critical, beforeQ.critical, 'критичність не змінилась');
  assert.equal(q.answer, '', 'відповіді ніхто не вигадав');
  assert.equal(q.closed_by_source_id, null);
  assert.equal(q.affects_transitions, undefined, 'єдину неактуальну прив’язку знято');
  assert.equal(q.link_history!.length, 1);
  const h = q.link_history![0]!;
  assert.deepEqual([h.by, h.step_id, h.condition, h.from, h.to], [human.name, 'S3', '', 'exception', undefined], 'в історії видно, хто, від чого і що це зняття');
  assert.match(h.note, /не входить у межі/);
  assert.ok(h.at.length > 10, 'час рішення записано');
  assert.ok(!blockerCodes(db, caseId).includes('QUESTION_LINK_BROKEN'), 'технічної прогалини більше немає');

  // Нова версія, старі не переписані.
  assert.notEqual(v.id, beforeVersionId);
  assert.equal(v.parent_id, beforeVersionId);
  assert.equal(getVersion(db, beforeVersionId).content_hash, beforeHash, 'хеш попередньої версії не змінився');
  assert.equal(canonical(versionContent(getVersion(db, beforeVersionId))), canonical(before), 'зміст попередньої версії не переписано');
  // Рішення в журналі.
  const a = one<{ action: string; details_json: string }>(db, `SELECT action, details_json FROM audit_log WHERE case_id = ? AND action = 'question_unlinked'`, caseId)!;
  assert.match(a.details_json, /Q7/);
  assert.match(a.details_json, /S3/);
});

test('2. Знімається лише вибрана прив’язка: інші прив’язки того самого питання лишаються', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  // друга прив'язка того самого питання — до чинного кроку
  const h0 = headVersion(db, caseId);
  const c0 = versionContent(h0);
  c0.questions[0]!.affects_transitions = [{ step_id: 'S3', condition: '', kind: 'exception' }, { step_id: 'S2', condition: '', kind: 'step_detail' }];
  const v0 = insertVersion(db, { caseId, content: c0, createdBy: 'analyst', actorName: human.name, parentId: h0.id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v0.id, caseId);
  acceptRemoval(db, caseId);
  unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', note: 'крок вилучено' });
  assert.deepEqual(head(db, caseId).questions[0]!.affects_transitions, [{ step_id: 'S2', condition: '', kind: 'step_detail' }], 'прив’язка до чинного кроку недоторкана');
});

// ───────── 3. Межі дії ─────────

test('3. Для ЧИННОГО кроку дія недоступна: невизначений перехід так приховати не можна', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  assert.throws(
    () => unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', note: 'хочу прибрати невизначеність' }),
    (e: { code?: string; message?: string }) => e.code === 'STEP_EXISTS' && /ВИД прив/.test(e.message!));
  assert.deepEqual(head(db, caseId).questions[0]!.affects_transitions, [{ step_id: 'S3', condition: '', kind: 'exception' }], 'нічого не змінилось');
});

test('3. Пояснення обов’язкове; закрите питання не відкріплюють; чужої прив’язки немає', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  const base = () => headVersion(db, caseId).id;
  assert.throws(() => unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: base(), questionId: 'Q7', stepId: 'S3', condition: '', note: ' ' }),
    (e: { code?: string }) => e.code === 'VALIDATION');
  assert.throws(() => unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: base(), questionId: 'Q7', stepId: 'S999', condition: '', note: 'немає такої прив’язки' }),
    (e: { code?: string }) => e.code === 'LINK_NOT_FOUND');
  assert.throws(() => unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: base(), questionId: 'Q404', stepId: 'S3', condition: '', note: 'немає такого питання' }),
    (e: { code?: string }) => e.code === 'NOT_FOUND');
  assert.equal(head(db, caseId).questions[0]!.affects_transitions!.length, 1, 'жодна відмова нічого не змінила');
});

test('3. Агент цієї дії виконати не може', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  assert.throws(() => unlinkQuestionFromMissingStep(db, agent as Actor, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', note: 'агент вирішив сам' }),
    (e: { code?: string }) => e.code === 'FORBIDDEN' || e.code === 'NOT_HUMAN');
  assert.equal(head(db, caseId).questions[0]!.affects_transitions!.length, 1);
});

// ───────── 4. Справжні блокери лишаються ─────────

test('4. Критичне відкрите питання після відкріплення лишається блокером; BPMN недоступний', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db, [question({ id: 'Q8', text: 'Хто ухвалює рішення про відмову?', critical: true, criticality_note: 'Без цього процес описати не можна' })]);
  acceptRemoval(db, caseId);
  unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', note: 'крок вилучено за межами процесу' });
  const codes = blockerCodes(db, caseId);
  assert.ok(!codes.includes('QUESTION_LINK_BROKEN'), 'технічна прогалина зникла');
  assert.ok(codes.includes('CRITICAL_QUESTION'), `справжня прогалина лишилась: ${JSON.stringify(codes)}`);
  assert.throws(() => submitForApproval(db, human, caseId), (e: { code?: string }) => e.code === 'GUARD_FAILED');
  assert.throws(() => requestBpmnStart(db, human, caseId, 'demo'), (e: { code?: string }) => e.code === 'GUARD_FAILED' || e.code === 'BAD_STATE');
  // Критичність питання відкріплення не знизило.
  assert.equal(head(db, caseId).questions.find((q) => q.id === 'Q8')!.critical, true);
});

test('4. Коли лишається лише технічна прогалина, відкріплення справді відкриває шлях далі', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  assert.throws(() => submitForApproval(db, human, caseId), (e: { code?: string }) => e.code === 'GUARD_FAILED');
  unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', note: 'крок вилучено за межами процесу' });
  acceptDraft(db, human, caseId, headVersion(db, caseId).id);
  submitForApproval(db, human, caseId);                           // не кидає — шлях відкрито
  const a = approve(db, human, caseId, { versionId: headVersion(db, caseId).id, checklistConfirmed: true });
  assert.ok(a.id, 'погодження стало можливим');
  // Питання лишилось відкритим і живим попри погодження опису.
  assert.equal(head(db, caseId).questions[0]!.status, 'open');
});

// ───────── 5. Захист через delta-шлях ─────────

test('5. Агент не відновлює прив’язку, яку аналітикиня явно зняла', async () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  unlinkQuestionFromMissingStep(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, questionId: 'Q7', stepId: 'S3', condition: '', note: 'крок вилучено за межами процесу' });

  const r = await runAnalyst(db, caseId, new ScriptedDemoClient((i) => {
    // Як бачить модель: `link_history` їй не показують і в контракті оновлення її немає (D78/D80),
    // тому агент повертає питання без історії — і саме так може «випадково» повернути зняту прив'язку.
    const { link_history: _h, ...q } = structuredClone(i.head_content.questions.find((x) => x.id === 'Q7')!);
    return { contract: DELTA_CONTRACT, base_version: i.baseVersion, questions: [{ ...q, affects_transitions: [{ step_id: 'S3', condition: '', kind: 'exception' }] }] };
  }), { contract: 'delta' });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const q = head(db, caseId).questions.find((x) => x.id === 'Q7')!;
  assert.equal(q.affects_transitions, undefined, 'прив’язку не відновлено');
  assert.ok(head(db, caseId).conflicts.some((c) => c.key === 'question:Q7.link'), 'спробу записано як конфлікт');
  const w = (JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', r.ok ? r.runId : '')!.checks_json) as { warnings?: string[] }).warnings ?? [];
  assert.ok(w.some((x) => /Q7/.test(x) && /явно зняла/.test(x)), `очікували попередження про спробу відновлення: ${JSON.stringify(w)}`);
  assert.ok(!blockerCodes(db, caseId).includes('QUESTION_LINK_BROKEN'), 'прогалина не повернулась');
});

test('5. Контроль: прив’язку до ЧИННОГО кроку агент так само не знімає', async () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  const r = await runAnalyst(db, caseId, new ScriptedDemoClient((i) => {
    const { link_history: _h, ...q } = structuredClone(i.head_content.questions.find((x) => x.id === 'Q7')!);
    return { contract: DELTA_CONTRACT, base_version: i.baseVersion, questions: [{ ...q, affects_transitions: [] }] };
  }), { contract: 'delta' });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(head(db, caseId).questions[0]!.affects_transitions, [{ step_id: 'S3', condition: '', kind: 'exception' }], 'прив’язку відкритого питання відновлено');
});

// ───────── 6. Показ наслідків у прев’ю вилучення ─────────

test('6. Прев’ю вилучення кроку показує наслідки для відкритих питань і не відкріплює їх саме', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  const h = headVersion(db, caseId);
  const pv = previewAccept(versionContent(h), ['SP1'], { caseId, versionId: h.id });
  assert.deepEqual(pv.stale_links.map((x) => [x.question_id, x.step_id]), [['Q7', 'S3']]);
  assert.ok(pv.lines.some((l) => /Q7/.test(l) && /Відкріпити від вилученого кроку/.test(l)), `очікували рядок про наслідок для питання: ${JSON.stringify(pv.lines)}`);
  assert.ok(pv.lines.some((l) => /не закривається й не відкріплюється/.test(l)));
  // Показ нічого не змінив.
  assert.deepEqual(head(db, caseId).questions[0]!.affects_transitions, [{ step_id: 'S3', condition: '', kind: 'exception' }]);
});

test('6. Показ наслідків відкріплення: питання, стара прив’язка, що лишається — і нічого не змінено', () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  acceptRemoval(db, caseId);
  const c = head(db, caseId);
  const pv = previewUnlink(c, 'Q7', 'S3', '');
  assert.equal(pv.errors.length, 0);
  assert.equal(pv.step_missing, true);
  assert.equal(pv.question.id, 'Q7');
  assert.equal(pv.link.kind, 'exception');
  assert.ok(pv.lines.some((l) => /лишається відкритим/.test(l)));
  assert.ok(pv.lines.some((l) => /НОВУ версію/.test(l)));
  assert.equal(canonical(head(db, caseId)), canonical(c), 'показ нічого не змінює');
});

// ───────── 7. Прямі HTTP-запити ─────────

test('7. HTTP: успіх, відсутнє пояснення, застаріла версія, чинний крок', async () => {
  const db = freshDb();
  const { caseId } = caseWithRemovable(db);
  const s = await startTestServer(db);
  try {
    // Чинний крок: дія недоступна (до прийняття вилучення).
    const live = await s.call('POST', `/api/cases/${caseId}/questions/unlink`, {
      base_version_id: headVersion(db, caseId).id, question_id: 'Q7', step_id: 'S3', condition: '', note: 'спроба прибрати невизначеність',
    });
    assert.equal(live.status, 409);
    assert.equal(live.body.error.code, 'STEP_EXISTS');

    acceptRemoval(db, caseId);
    const good = headVersion(db, caseId).id;

    // Пояснення обов'язкове.
    const noNote = await s.call('POST', `/api/cases/${caseId}/questions/unlink`, { base_version_id: good, question_id: 'Q7', step_id: 'S3', condition: '', note: '   ' });
    assert.equal(noNote.status, 400);
    assert.equal(noNote.body.error.code, 'VALIDATION');

    // Застаріла версія.
    const stale = await s.call('POST', `/api/cases/${caseId}/questions/unlink`, { base_version_id: 'ver_СТАРА', question_id: 'Q7', step_id: 'S3', condition: '', note: 'крок вилучено за межами процесу' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

    // Нічого з цього не змінило опису.
    assert.equal(headVersion(db, caseId).id, good);
    assert.equal(head(db, caseId).questions[0]!.affects_transitions!.length, 1);

    // Картка показує неактуальну прив'язку з наслідками — ДО рішення.
    const card = await s.call('GET', `/api/cases/${caseId}`);
    assert.equal(card.status, 200);
    const sl = card.body.stale_links;
    assert.equal(sl.length, 1);
    assert.deepEqual([sl[0].question_id, sl[0].step_id, sl[0].kind], ['Q7', 'S3', 'exception']);
    assert.ok(sl[0].preview.lines.length >= 4, 'наслідки показано');
    assert.ok(card.body.blockers.some((b: { code: string }) => b.code === 'QUESTION_LINK_BROKEN'));

    // Успіх.
    const ok = await s.call('POST', `/api/cases/${caseId}/questions/unlink`, { base_version_id: good, question_id: 'Q7', step_id: 'S3', condition: '', note: 'крок вилучено за межами процесу' });
    assert.equal(ok.status, 201);
    assert.ok(ok.body.version_id);
    const card2 = await s.call('GET', `/api/cases/${caseId}`);
    assert.equal(card2.body.stale_links.length, 0);
    assert.ok(!card2.body.blockers.some((b: { code: string }) => b.code === 'QUESTION_LINK_BROKEN'));
    const q = card2.body.head.content.questions.find((x: { id: string }) => x.id === 'Q7');
    assert.equal(q.status, 'open');
    assert.equal(q.affects_transitions, undefined);
    assert.equal(q.link_history.length, 1);

    // Повторна спроба тієї самої дії вже не проходить (прив'язки немає).
    const again = await s.call('POST', `/api/cases/${caseId}/questions/unlink`, { base_version_id: headVersion(db, caseId).id, question_id: 'Q7', step_id: 'S3', condition: '', note: 'крок вилучено за межами процесу' });
    assert.equal(again.status, 404);
    assert.equal(again.body.error.code, 'LINK_NOT_FOUND');
  } finally { await s.close(); }
});
