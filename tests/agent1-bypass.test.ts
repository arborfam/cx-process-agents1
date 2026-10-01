/**
 * Дефекти, знайдені незалежною перевіркою ZIP після T0/T1 (D68), — відтворення ДО виправлення (мають бути червоними):
 *  1. агент знімає блокувальний зміст відкритого питання через перекласифікацію, видалення чи перенесення прив'язки;
 *  2. показ наслідків пропозицій необов'язковий на сервері (previewHash можна не передавати).
 * Синтетичні приклади без ідентифікаторів кейсу; «агент» — підставний клієнт (перевірка логіки програми, не якості моделі).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedDemoClient, runAnalyst } from '../src/runs.ts';
import { acceptDraft, addSource, bpmnGuard, decideStepProposal, decideStepProposals, headVersion, protectAnalystEdits, submissionBlockers, submitForApproval, transitionIssues, versionContent } from '../src/domain.ts';
import type { Content } from '../src/schema.ts';
import { freshDb, human, startTestServer } from './helpers.ts';
import { Q, T, baseContent, caseWith, headContent, skeletonPlusChain } from './agent1-fixtures.ts';

/** Коректний процес A → B → END, початок A (задано аналітикинею), відкрите некритичне питання про послідовність A → B. */
function sequenceDoubt(): Content {
  const c = baseContent();
  c.entry_step_id = 'A';
  c.steps = [T('A', 'Виконавець', 'Реєструє запит', 'Запит зареєстровано', [{ to: 'B' }]), T('B', 'Виконавець', 'Надсилає відповідь', 'Відповідь надіслано', [{ to: 'END' }])];
  c.questions = [Q('Q1', 'Чи справді реєстрація завжди передує відповіді?', [{ step: 'A', condition: '', kind: 'unconfirmed_sequence' }])];
  return c;
}
const blocked = (db: ReturnType<typeof freshDb>, caseId: string) => submissionBlockers(db, caseId).some((b) => b.code === 'SEQUENCE_UNCONFIRMED' && b.severity === 'critical');

const attacks: [string, (c: Content) => void][] = [
  ['перекласифікація на exception', (c) => { c.questions[0]!.affects_transitions![0]!.kind = 'exception'; }],
  ['перекласифікація на step_detail', (c) => { c.questions[0]!.affects_transitions![0]!.kind = 'step_detail'; }],
  ['перекласифікація на direction', (c) => { c.questions[0]!.affects_transitions![0]!.kind = 'direction'; }],
  ['видалення прив’язки', (c) => { delete c.questions[0]!.affects_transitions; }],
  ['порожній список прив’язок', (c) => { c.questions[0]!.affects_transitions = []; }],
  ['перенесення на інший перехід', (c) => { c.questions[0]!.affects_transitions![0]!.step_id = 'B'; }],
];

for (const [name, attack] of attacks) {
  test(`ДЕФЕКТ 1: агент не знімає блокування відкритого питання: ${name}`, async () => {
    const db = freshDb();
    const { caseId } = caseWith(db, sequenceDoubt(), 'analyst');
    assert.ok(blocked(db, caseId), 'до запуску SEQUENCE_UNCONFIRMED є');
    const out = structuredClone(sequenceDoubt());
    attack(out);
    const res = await runAnalyst(db, caseId, new ScriptedDemoClient(() => out));
    // відповідь може бути прийнята (захист лишає прив'язку) або відхилена, але блокування не зникає
    const q = headContent(db, caseId).questions[0]!;
    assert.equal(q.status, 'open', 'питання лишилось відкритим');
    assert.ok(blocked(db, caseId), 'SEQUENCE_UNCONFIRMED не зник після запуску агента');
    assert.deepEqual(q.affects_transitions, [{ step_id: 'A', condition: '', kind: 'unconfirmed_sequence' }], 'прив’язку агент не змінив');
    assert.ok(res.ok ? headContent(db, caseId).conflicts.some((c) => c.key === 'question:Q1.link') : true, 'зміну відхилено із записом конфлікту');
    acceptDraft(db, human, caseId, headVersion(db, caseId).id);
    assert.throws(() => submitForApproval(db, human, caseId), (e: any) => e.code === 'GUARD_FAILED', 'без людського рішення передати на погодження неможливо');
    assert.equal(bpmnGuard(db, caseId).ok, false);
  });
}

test('ДЕФЕКТ 1 (контроль): закрити питання за належною відповіддю з джерела агент МОЖЕ; без джерела — ні; зміна прив’язки вже закритого питання нічого не блокує', () => {
  const base = sequenceDoubt();
  const closed = structuredClone(base);
  Object.assign(closed.questions[0]!, { status: 'closed', answer: 'Так, реєстрація завжди передує відповіді.', closed_by_source_id: 's1' });
  delete closed.questions[0]!.affects_transitions;
  const ok = protectAnalystEdits(base, closed, new Set(), new Set(['s1']));
  assert.equal(ok.content.questions[0]!.status, 'closed');
  assert.equal(transitionIssues(ok.content).filter((i) => i.code === 'SEQUENCE_UNCONFIRMED').length, 0, 'за відповіддю з джерела блокування знімається за чинними правилами');
  const noSource = protectAnalystEdits(base, closed, new Set(), new Set());
  assert.equal(noSource.content.questions[0]!.status, 'open', 'без наявного джерела питання лишається відкритим');
});

test('ДЕФЕКТ 1 (контроль): додати НОВУ прив’язку до відкритого питання агент може (це лише посилює), а наявну зберігає', () => {
  const base = sequenceDoubt();
  const out = structuredClone(base);
  out.questions[0]!.affects_transitions!.push({ step_id: 'B', condition: '', kind: 'step_detail' });
  const r = protectAnalystEdits(base, out, new Set(), new Set());
  assert.equal(r.content.questions[0]!.affects_transitions!.length, 2);
  assert.equal(r.conflicts.filter((c) => c.key === 'question:Q1.link').length, 0);
});

// ───────── Дефект 2: показ наслідків обов'язковий на сервері ─────────

test('ДЕФЕКТ 2: групове прийняття без previewHash відхиляється (PREVIEW_REQUIRED); acknowledge показ не замінює', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, skeletonPlusChain());
  const head = headVersion(db, caseId).id;
  assert.throws(() => decideStepProposals(db, human, caseId, { baseVersionId: head, proposalIds: ['R1', 'R2'] }), (e: any) => e.code === 'PREVIEW_REQUIRED');
  assert.throws(() => decideStepProposals(db, human, caseId, { baseVersionId: head, proposalIds: ['R1', 'R2'], acknowledge: true }), (e: any) => e.code === 'PREVIEW_REQUIRED');
  assert.throws(() => decideStepProposal(db, human, caseId, { baseVersionId: head, proposalId: 'R2', decision: 'accept', acknowledge: true }), (e: any) => e.code === 'PREVIEW_REQUIRED');
  assert.equal(headVersion(db, caseId).id, head, 'версію не змінено');
  assert.deepEqual(headContent(db, caseId).step_proposals!.map((p) => p.status), ['proposed', 'proposed']);
});

test('ДЕФЕКТ 2 (HTTP): без preview_hash — відмова; хеш іншого набору, іншої версії, іншого кейсу чи вигаданий — відмова; правильний — прийняття', async () => {
  const dbA = freshDb();
  const a = caseWith(dbA, skeletonPlusChain()).caseId;
  const dbB = freshDb(); // інша база з тим самим змістом: «чужий» хеш
  const b = caseWith(dbB, skeletonPlusChain()).caseId;
  const sA = await startTestServer(dbA);
  const sB = await startTestServer(dbB);
  try {
    const cardA = (await sA.call('GET', `/api/cases/${a}`)).body;
    const cardB = (await sB.call('GET', `/api/cases/${b}`)).body;
    const groupHash: string = cardA.proposal_previews.bundles[0].preview.hash;
    const aloneHash: string = cardA.proposal_previews.items.R2.hash;
    const post = (s: typeof sA, id: string, body: Record<string, unknown>) => s.call('POST', `/api/cases/${id}/step-proposals/decide`, { decision: 'accept', ...body });
    const base = { base_version_id: cardA.head.id };
    const missing = await post(sA, a, { ...base, proposal_ids: ['R1', 'R2'] });
    assert.deepEqual([missing.status, missing.body.error.code], [428, 'PREVIEW_REQUIRED']);
    const ackOnly = await post(sA, a, { ...base, proposal_ids: ['R1', 'R2'], acknowledge: true });
    assert.deepEqual([ackOnly.status, ackOnly.body.error.code], [428, 'PREVIEW_REQUIRED']);
    const singleMissing = await post(sA, a, { ...base, proposal_id: 'R2', acknowledge: true });
    assert.deepEqual([singleMissing.status, singleMissing.body.error.code], [428, 'PREVIEW_REQUIRED']);
    for (const [label, hash, ids] of [
      ['вигаданий', 'f'.repeat(64), ['R1', 'R2']], ['хеш одиночного для групи', aloneHash, ['R1', 'R2']], ['хеш групи для одиночного', groupHash, ['R2']],
      ['чужий кейс із тим самим змістом', cardB.proposal_previews.bundles[0].preview.hash, ['R1', 'R2']],
    ] as [string, string, string[]][]) {
      const r = await post(sA, a, { ...base, ...(ids.length > 1 ? { proposal_ids: ids } : { proposal_id: ids[0] }), preview_hash: hash, acknowledge: true });
      assert.deepEqual([label, r.status, r.body.error.code], [label, 409, 'PREVIEW_STALE']);
    }
    assert.equal(headContent(dbA, a).step_proposals!.every((p) => p.status === 'proposed'), true, 'жодної зміни до коректного показу');
    const one = await post(sA, a, { ...base, proposal_id: 'R2', preview_hash: aloneHash, acknowledge: true });
    assert.equal(one.status, 201);
    const staleAfter = await post(sA, a, { base_version_id: one.body.version_id, proposal_ids: ['R1'], preview_hash: groupHash });
    assert.equal(staleAfter.status, 409, 'хеш застарів після нової версії');
  } finally { await sA.close(); await sB.close(); }
  void versionContent;
});
