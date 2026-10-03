/**
 * Правило D28 (погоджено власницею 30.09.2026):
 * некритичні прогалини можуть лишатися в погодженому AS-IS;
 * невизначеність, яка заважає побудувати коректний потік, блокує BPMN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptDraft, addQuestion, answerQuestion, approve, bpmnGuard, buildCard, criticalGaps, currentApproval, headVersion,
  requestBpmnStart, saveAnalystVersion, submissionBlockers, submitForApproval, versionContent,
} from '../src/domain.ts';
import { seedDemoCase } from '../src/demo.ts';
import { draftReadyCase, freshDb, human } from './helpers.ts';

const S5_UNKNOWN = 'S5 | Керівник відділу | Вирішує, погодити чи відхилити виняток | Рішення щодо винятку | S4 (погоджено); ? (відхилено)';

test('K2: некритичні прогалини лишаються в погодженому AS-IS і не блокують ні погодження, ні дозвіл BPMN', () => {
  const db = freshDb();
  const id = seedDemoCase(db, 'demo');
  let card = buildCard(db, id, 'demo');
  // у демо-кейсі є некритичне питання Q2 (не пов’язане з потоком), відкрита гіпотеза H1 і проблема з оцінкою замість метрики
  const q2 = card.head.content.questions.find((q) => q.id === 'Q2')!;
  assert.equal(q2.critical, false);
  assert.equal(q2.status, 'open');
  assert.equal((q2.affects_transitions ?? []).length, 0, 'Q2 не пов’язане з переходами: це K2');

  // усуваємо лише K1 (питання Q1 і невизначений перехід S5)
  const v3 = answerQuestion(db, human, id, { baseVersionId: card.head.id, questionId: 'Q1', answer: 'Керівник повідомляє клієнта листом.' , origin: 'synthetic', basis: { kind: 'analyst_confirmed', note: 'Підтверджено аналітикинею', acknowledgedFactual: true } });
  const v4 = saveAnalystVersion(db, human, id, {
    baseVersionId: v3.id,
    fields: { steps_text: buildCard(db, id, 'demo').editable.steps_text.replace(S5_UNKNOWN, S5_UNKNOWN.replace('? (відхилено)', 'S6 (відхилено)')) +
      '\nS6 | Керівник відділу | Повідомляє клієнта листом | Клієнта поінформовано | END' },
  });
  card = buildCard(db, id, 'demo');
  assert.deepEqual(card.gaps, [], 'критичних прогалин (K1) немає');
  const warnings = submissionBlockers(db, id).filter((b) => b.severity === 'warning').map((b) => b.code);
  assert.ok(warnings.includes('OPEN_QUESTION'), 'K2 видно як попередження');
  assert.equal(card.review.checks.find((c) => c.key === 'gaps')!.status, 'ok');

  acceptDraft(db, human, id, v4.id);
  submitForApproval(db, human, id);                         // K2 не блокує передачу на погодження
  approve(db, human, id, { versionId: v4.id, checklistConfirmed: true }); // … і погодження
  const approved = versionContent(headVersion(db, id));
  assert.equal(approved.questions.find((q) => q.id === 'Q2')!.status, 'open', 'некритична прогалина лишилась у погодженому AS-IS');
  assert.equal(approved.hypotheses.find((h) => h.id === 'H1')!.status, 'open');
  assert.equal(bpmnGuard(db, id).ok, true, 'K2 не блокує дозвіл BPMN');
  requestBpmnStart(db, human, id, 'demo');
  assert.ok(currentApproval(db, id));
});

test('K1: невизначеність, що заважає побудувати потік, блокує — навіть коли питання позначене некритичним', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  // питання позначено НЕкритичним, але воно про перехід кроку S2 → це K1 за зв’язком із потоком
  const v3 = addQuestion(db, human, c.id, { baseVersionId: v.id, text: 'Що відбувається після S2?', critical: false, impact: 'Завершення процесу', affects: [{ step_id: 'S2', condition: '' }] });
  const gaps = criticalGaps(submissionBlockers(db, c.id));
  assert.ok(gaps.some((g) => g.code === 'UNRESOLVED_TRANSITION' && g.ref === 'S2'));
  acceptDraft(db, human, c.id, v3.id);
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED' &&
    e.details.blockers.some((b: any) => b.code === 'UNRESOLVED_TRANSITION'));
  assert.equal(bpmnGuard(db, c.id).ok, false);
});

test('K2 не потребує пояснення, K1 не знімається зміною позначки критичності', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  // некритичне питання без зв’язку з потоком — лише попередження
  const v3 = addQuestion(db, human, c.id, { baseVersionId: v.id, text: 'Який середній час обробки?', critical: false, impact: 'Оцінка впливу P1' });
  const b = submissionBlockers(db, c.id);
  assert.ok(b.some((x) => x.code === 'OPEN_QUESTION' && x.severity === 'warning'));
  assert.ok(!b.some((x) => x.severity === 'critical' && x.code !== 'NOT_ACCEPTED'));
  acceptDraft(db, human, c.id, v3.id);
  submitForApproval(db, human, c.id);
  assert.ok(approve(db, human, c.id, { versionId: v3.id, checklistConfirmed: true }));
});
