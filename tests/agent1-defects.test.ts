/**
 * ВІДТВОРЕННЯ ДЕФЕКТІВ першого справжнього прогону агента 1 (етапи 1–2) на мінімальних синтетичних прикладах.
 * Тут записано ОЧІКУВАНУ поведінку (docs/agent1-consistency-spec.md); до виправлень ці тести мають бути червоними.
 * Лише наявні API: перевірка відповіді моделі, захист правок, доменні перевірки, прийняття пропозицій.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentOutput } from '../src/ai/verify.ts';
import { protectAnalystEdits, bpmnGuard, decideStepProposal, headVersion, versionContent } from '../src/domain.ts';
import { freshDb, human } from './helpers.ts';
import { P, Q, T, UNKNOWN, approvedWith, baseContent, caseWith, skeletonPlusChain } from './agent1-fixtures.ts';
import type { Content } from '../src/schema.ts';

const ctx = (base: Content) => ({ base, sources: [], fromModel: (c: Content) => c });
const verify = (base: Content, out: Content) => verifyAgentOutput(structuredClone(out), ctx(base));
const codes = (r: ReturnType<typeof verify>) => (r.ok ? [] : r.violations.map((v) => v.code));

function withStep(c: Content, step: ReturnType<typeof T>): Content {
  const o = structuredClone(c);
  o.steps.push(step);
  return o;
}

test('ДЕФЕКТ: відкрите питання про НАПРЯМОК переходу, який подано як відомий, — самосуперечність агента має відхилятися на перевірці відповіді', () => {
  const base = baseContent();
  const out = withStep(base, T('A', 'Виконавець', 'Крок А', 'Результат А', [{ to: 'END' }]));
  out.questions = [Q('Q1', 'Що буде, якщо замовник не відповість?', [{ step: 'A', condition: '' }])];
  assert.ok(codes(verify(base, out)).includes('LINK_DIRECTION_KNOWN_TARGET'), JSON.stringify(verify(base, out)));
});

test('ДЕФЕКТ: єдиний послідовний перехід з «умовою», що дублює результат кроку, має відхилятися (генератор потім блокує SINGLE_CONDITIONAL_BRANCH)', () => {
  const base = baseContent();
  const out = withStep(base, T('A', 'Виконавець', 'Реєструє запит', 'Запит зареєстровано', [{ to: 'END', condition: 'Запит зареєстровано' }]));
  assert.ok(codes(verify(base, out)).includes('SEQUENTIAL_WITH_CONDITION'), JSON.stringify(verify(base, out)));
});

test('ДЕФЕКТ: посилання на питання («див. Q11») усередині тексту кроку не має потрапляти в зміст (текст піде на підпис схеми)', () => {
  const base = baseContent();
  const out = withStep(base, T('A', 'Виконавець', 'Просить матеріали', 'Отримано (інший результат не описано, див. Q11)', [{ to: 'END' }]));
  assert.ok(codes(verify(base, out)).includes('UNCERTAINTY_IN_STEP_TEXT'), JSON.stringify(verify(base, out)));
});

test('ДЕФЕКТ: агент сам ставить початковий крок (межа процесу — рішення аналітика): зміна має відкидатися із записом конфлікту', () => {
  const base = baseContent();
  const out = structuredClone(base);
  out.steps = [T('A', 'Виконавець', 'Крок А', 'Р', [{ to: 'END' }])];
  out.entry_step_id = 'A';
  const r = protectAnalystEdits(base, out, new Set(), new Set());
  assert.equal(r.content.entry_step_id ?? null, null, 'агент не визначає початок процесу');
  assert.ok(r.conflicts.some((c) => c.key === 'entry_step_id'));
});

test('ДЕФЕКТ: єдиний перехід з умовою виявляється лише генератором — серверний дозвіл BPMN має пояснити це ДО спроби побудови', () => {
  const db = freshDb();
  const c = baseContent();
  c.entry_step_id = 'A';
  c.steps = [T('A', 'Виконавець', 'Крок А', 'Результат', [{ to: 'B', condition: 'Результат отримано' }]), T('B', 'Виконавець', 'Крок Б', 'Р', [{ to: 'END' }])];
  const { caseId } = approvedWith(db, c);
  const reasons = bpmnGuard(db, caseId).reasons.map((r) => r.code);
  assert.ok(reasons.includes('SINGLE_CONDITIONAL_BRANCH'), reasons.join(','));
});

test('ДЕФЕКТ: «Прийняти» лише одну із залежних пропозицій приховано лишає недосяжний крок — без показу й підтвердження наслідків', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, skeletonPlusChain());
  const before = headVersion(db, caseId).id;
  assert.throws(
    () => decideStepProposal(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, proposalId: 'R2', decision: 'accept' }),
    (e: any) => e.code === 'CONSEQUENCES_NOT_CONFIRMED',
    'очікується вимога підтвердити наслідки (залишиться недосяжний крок K1)',
  );
  assert.equal(headVersion(db, caseId).id, before, 'версію не змінено, поки наслідки не підтверджено');
});

test('КОНТРОЛЬ (має бути зеленим і до, і після): чернетка з невідомим — відомий перехід + невідома альтернатива, UNKNOWN із питанням, порожній початок — допустима для агента', () => {
  const base = baseContent();
  const out = withStep(base, T('A', 'Виконавець', 'Крок А', 'Р', [{ to: UNKNOWN, condition: '' }]));
  out.questions = [Q('Q1', 'Куди далі після кроку А?', [{ step: 'A', condition: '' }], { critical: true })];
  assert.deepEqual(codes(verify(base, out)), []);
  assert.equal(out.entry_step_id ?? null, null);
});

test('КОНТРОЛЬ: правки аналітика збережено, а версії в історії не змінюються при застосуванні пропозицій', () => {
  const db = freshDb();
  const { caseId, version } = caseWith(db, skeletonPlusChain());
  const before = JSON.stringify(versionContent(version));
  decideStepProposal(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, proposalId: 'R1', decision: 'reject', note: 'не потрібно' });
  const row = db.prepare('SELECT content_json FROM as_is_version WHERE id = ?').get(version.id) as { content_json: string };
  assert.equal(row.content_json, before, 'історична версія незмінна');
  assert.ok(P('X', 'K1', 'K3').id);
});
