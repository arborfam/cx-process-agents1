/**
 * Пропозиції щодо кроків: наслідки ДО прийняття, пов'язані пропозиції одним рішенням, явне підтвердження наслідків, захист від обходу.
 * Мінімальні синтетичні приклади (tests/agent1-fixtures.ts): старий «скелет» K1/K2 + детальний ланцюжок K3…K6, початок K3, пропозиції R1 (K1→K3), R2 (K2→K4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import {
  bpmnGuard, currentApproval, decideStepProposal, decideStepProposals, flowIssues, getCase, headVersion, previewAccept, previewProposals, versionContent,
} from '../src/domain.ts';
import { UNKNOWN, type Content } from '../src/schema.ts';
import { ScriptedDemoClient, runAnalyst } from '../src/runs.ts';
import { agent, freshDb, human, startTestServer } from './helpers.ts';
import { P, T, pvHash, approvedWith, baseContent, caseWith, headContent, skeletonPlusChain } from './agent1-fixtures.ts';

const unreachable = (c: Content): string[] => flowIssues(c).filter((i) => i.code === 'STEP_UNREACHABLE').flatMap((i) => (i.ref ?? '').split(',')).sort();
const shape = (c: Content) => ({ steps: c.steps.map((s) => [s.id, s.next.map((n) => n.to).join('>')]), entry: c.entry_step_id ?? null, st: (c.step_proposals ?? []).map((p) => `${p.id}:${p.status}`) });
const historyRows = (db: ReturnType<typeof freshDb>, caseId: string) => JSON.stringify(all(db, 'SELECT id, content_json, content_hash FROM as_is_version WHERE case_id = ? ORDER BY number', caseId));

test('Наслідки ДО прийняття: що зникне, куди перейдуть зв’язки, чи зміниться початок, що стане недосяжним; пов’язана пропозиція названа', () => {
  const c = skeletonPlusChain();
  const pv = previewProposals(c);
  const r2 = pv.items.R2!;
  assert.deepEqual(r2.removed.map((x) => x.id), ['K2']);
  assert.deepEqual(r2.rewired, [{ from: 'K1', condition: '', was: 'K2', now: 'K4' }]);
  assert.deepEqual([r2.entry.before, r2.entry.after, r2.entry.changed], ['K3', 'K3', false]);
  assert.deepEqual(r2.flow_before, ['STEP_UNREACHABLE:K1', 'STEP_UNREACHABLE:K2']);
  assert.deepEqual(r2.flow_after, ['STEP_UNREACHABLE:K1']);
  assert.deepEqual(r2.resolved, ['STEP_UNREACHABLE:K2']);
  assert.ok(r2.needs_ack && r2.residual.includes('STEP_UNREACHABLE:K1'));
  assert.deepEqual(r2.better_with, ['R1']);
  const text = r2.lines.join('\n');
  assert.match(text, /Крок K2 .* зникне/);
  assert.match(text, /K1 → K2 перейде на K4/);
  assert.match(text, /Початковий крок не зміниться \(K3\)/);
  assert.match(text, /ЛИШАТЬСЯ проблеми потоку: недосяжний крок K1/);
  const r1 = pv.items.R1!;
  assert.deepEqual(r1.better_with, ['R2']);
  assert.ok(r1.needs_ack && r1.flow_after.join() === 'STEP_UNREACHABLE:K2');
  assert.equal(pv.bundles.length, 1);
  assert.deepEqual(pv.bundles[0]!.ids, ['R1', 'R2']);
  assert.deepEqual(pv.bundles[0]!.preview.flow_after, []);
  assert.equal(pv.bundles[0]!.preview.needs_ack, false);
  assert.match(pv.bundles[0]!.preview.lines.join('\n'), /проблем потоку .* не лишиться/);
});

test('Стан до і після SP2-подібної пропозиції та різні порядки рішень: однаковий кінцевий граф, але різна кількість версій', () => {
  const finals: unknown[] = [];
  const versionCounts: number[] = [];
  for (const order of [['R1', 'R2'], ['R2', 'R1'], ['GROUP']]) {
    const db = freshDb();
    const { caseId } = caseWith(db, skeletonPlusChain());
    const n0 = all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', caseId).length;
    if (order[0] === 'GROUP') decideStepProposals(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1', 'R2']), baseVersionId: headVersion(db, caseId).id, proposalIds: ['R1', 'R2'] });
    else for (const id of order) decideStepProposal(db, human, caseId, { previewHash: pvHash(db, caseId, [id]), baseVersionId: headVersion(db, caseId).id, proposalId: id, decision: 'accept', acknowledge: true });
    const c = headContent(db, caseId);
    finals.push(shape(c));
    versionContent(headVersion(db, caseId));
    versionCounts.push(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', caseId).length - n0);
    assert.deepEqual(unreachable(c), [], order.join('>'));
  }
  assert.deepEqual(finals[0], finals[1]);
  assert.deepEqual(finals[0], finals[2]);
  assert.deepEqual(versionCounts, [2, 2, 1], 'пов’язані зміни одним рішенням — одна нова версія');
});

test('Прийняття лише однієї із залежних пропозицій без підтвердження наслідків відхиляється й нічого не змінює; з підтвердженням лишає видимий наслідок', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, skeletonPlusChain());
  const head = headVersion(db, caseId).id;
  const history = historyRows(db, caseId);
  assert.throws(() => decideStepProposal(db, human, caseId, { previewHash: pvHash(db, caseId, ['R2']), baseVersionId: head, proposalId: 'R2', decision: 'accept' }),
    (e: any) => e.code === 'CONSEQUENCES_NOT_CONFIRMED' && e.status === 409 && e.details.preview.residual.includes('STEP_UNREACHABLE:K1'));
  assert.equal(headVersion(db, caseId).id, head);
  assert.equal(historyRows(db, caseId), history);
  decideStepProposal(db, human, caseId, { previewHash: pvHash(db, caseId, ['R2']), baseVersionId: head, proposalId: 'R2', decision: 'accept', acknowledge: true, note: 'розумію наслідок' });
  assert.deepEqual(unreachable(headContent(db, caseId)), ['K1'], 'наслідок лишився видимим прогалиною, а не прихованим');
});

test('Інші пропозиції автоматично не приймаються: група — рівно ті ідентифікатори, які обрала людина', () => {
  const db = freshDb();
  const c = skeletonPlusChain();
  c.steps.push(T('K7', 'Виконавець', 'Окремий крок', 'Р', [{ to: 'K6' }]));
  c.step_proposals!.push(P('R3', 'K7', 'K5'));
  const { caseId } = caseWith(db, c);
  decideStepProposals(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1', 'R2']), baseVersionId: headVersion(db, caseId).id, proposalIds: ['R1', 'R2'] });
  const after = headContent(db, caseId);
  assert.deepEqual(after.step_proposals!.map((p) => `${p.id}:${p.status}`), ['R1:accepted', 'R2:accepted', 'R3:proposed']);
  assert.ok(after.steps.some((s) => s.id === 'K7'), 'крок третьої пропозиції лишився');
});

test('Хеш показаних наслідків: хибний чи застарілий показ не приймається; правильний — приймається', () => {
  const db = freshDb();
  const { caseId } = caseWith(db, skeletonPlusChain());
  const head = headVersion(db, caseId);
  const pv = previewAccept(versionContent(head), ['R1', 'R2'], { caseId, versionId: head.id });
  assert.throws(() => decideStepProposals(db, human, caseId, { baseVersionId: head.id, proposalIds: ['R1', 'R2'], previewHash: 'x'.repeat(64) }), (e: any) => e.code === 'PREVIEW_STALE');
  assert.throws(() => decideStepProposals(db, human, caseId, { baseVersionId: head.id, proposalIds: ['R1'], previewHash: pv.hash }), (e: any) => e.code === 'PREVIEW_STALE', 'показ іншого набору');
  decideStepProposals(db, human, caseId, { baseVersionId: head.id, proposalIds: ['R1', 'R2'], previewHash: pv.hash });
  assert.deepEqual(unreachable(headContent(db, caseId)), []);
});

test('Вилучення без заміни: показано нове невідоме й питання; зняття початку вимагає підтвердження; заміна початку — без нього', () => {
  const c = baseContent();
  c.entry_step_id = 'K3';
  c.steps = [
    T('K3', 'Виконавець', 'Початок', 'Р', [{ to: 'K4' }]),
    T('K4', 'Виконавець', 'Лишній крок', 'Р', [{ to: 'K5' }]),
    T('K5', 'Виконавець', 'Кінець', 'Р', [{ to: 'END' }]),
  ];
  c.step_proposals = [{ ...P('R1', 'K4', ''), action: 'remove' as const }];
  const pv = previewAccept(c, ['R1']);
  assert.deepEqual(pv.new_unknown, [{ from: 'K3', condition: '', question_id: 'Q1' }]);
  assert.match(pv.lines.join('\n'), /стане «невідомо»; буде створено критичне питання Q1/);
  // K5 втрачає єдиний вхід (від K4): це пов'язаний наслідок, його треба побачити й підтвердити
  assert.deepEqual(pv.residual, ['STEP_UNREACHABLE:K5']);
  assert.equal(pv.needs_ack, true);
  const db = freshDb();
  const { caseId } = caseWith(db, c);
  assert.throws(() => decideStepProposal(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1']), baseVersionId: headVersion(db, caseId).id, proposalId: 'R1', decision: 'accept' }), (e: any) => e.code === 'CONSEQUENCES_NOT_CONFIRMED');
  decideStepProposal(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1']), baseVersionId: headVersion(db, caseId).id, proposalId: 'R1', decision: 'accept', acknowledge: true });
  const q = headContent(db, caseId).questions[0]!;
  assert.deepEqual([q.critical, q.status, q.affects_transitions?.[0]?.kind], [true, 'open', 'direction']);
  // початок: заміна переносить, зняття — потребує підтвердження
  const e = baseContent();
  e.entry_step_id = 'K1';
  e.steps = [T('K1', 'Виконавець', 'Старий початок', 'Р', [{ to: 'K2' }]), T('K2', 'Виконавець', 'Новий початок', 'Р', [{ to: 'END' }])];
  e.step_proposals = [P('R1', 'K1', 'K2')];
  const pe = previewAccept(e, ['R1']);
  assert.deepEqual(pe.entry, { before: 'K1', after: 'K2', changed: true });
  assert.equal(pe.needs_ack, false);
  assert.match(pe.lines.join('\n'), /Початковий крок зміниться: K1 → K2/);
  e.step_proposals = [{ ...P('R1', 'K1', ''), action: 'remove' as const }];
  assert.equal(previewAccept(e, ['R1']).needs_ack, true, 'початок знімається — наслідок треба підтвердити');
});

test('Група атомарна й перевіряється: невідома/вирішена пропозиція, зниклий крок, порожній набір; після помилки нічого не застосовано', () => {
  const db = freshDb();
  const c = skeletonPlusChain();
  c.step_proposals!.push(P('R3', 'K3', 'K9'));
  const { caseId } = caseWith(db, c);
  const head = headVersion(db, caseId).id;
  const history = historyRows(db, caseId);
  assert.throws(() => decideStepProposals(db, human, caseId, { baseVersionId: head, proposalIds: [] }), (e: any) => e.code === 'VALIDATION');
  assert.throws(() => decideStepProposals(db, human, caseId, { baseVersionId: head, proposalIds: ['R1', 'NOPE'] }), (e: any) => e.code === 'NOT_FOUND');
  assert.throws(() => decideStepProposals(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1', 'R3']), baseVersionId: head, proposalIds: ['R1', 'R3'] }), (e: any) => e.code === 'STEP_MISSING');
  assert.throws(() => decideStepProposals(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1']), baseVersionId: 'ver_stale', proposalIds: ['R1'] }), (e: any) => e.code === 'VERSION_CONFLICT');
  assert.equal(historyRows(db, caseId), history, 'жодної нової версії');
  decideStepProposal(db, human, caseId, { baseVersionId: head, proposalId: 'R2', decision: 'reject', note: 'ні' });
  assert.throws(() => decideStepProposals(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1', 'R2']), baseVersionId: headVersion(db, caseId).id, proposalIds: ['R1', 'R2'] }), (e: any) => e.code === 'PROPOSAL_NOT_PENDING');
});

test('Рішення лише людини; агент не приймає пропозицій; історичні версії й погодження не переписуються; нове рішення скасовує чинне погодження', () => {
  const db = freshDb();
  const ok = baseContent();
  ok.entry_step_id = 'K3';
  ok.steps = [T('K3', 'Виконавець', 'Початок', 'Р', [{ to: 'K4' }]), T('K4', 'Виконавець', 'Крок', 'Р', [{ to: 'K5' }]), T('K5', 'Виконавець', 'Кінець', 'Р', [{ to: 'END' }])];
  const { caseId, version } = approvedWith(db, ok);
  // нова версія з пропозицією від «агента» (як після запуску), потім погодження знову
  const base = headContent(db, caseId);
  base.step_proposals = [P('R1', 'K5', 'K4')];
  assert.throws(() => decideStepProposal(db, agent, caseId, { baseVersionId: headVersion(db, caseId).id, proposalId: 'R1', decision: 'accept' }), (e: any) => e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND');
  assert.throws(() => decideStepProposals(db, agent, caseId, { baseVersionId: headVersion(db, caseId).id, proposalIds: ['R1'] }), (e: any) => e.code === 'FORBIDDEN');
  assert.equal(getCase(db, caseId).state, 'approved');
  assert.equal(currentApproval(db, caseId)!.version_id, version.id);
});

test('Захист від обходу через API: без сесії — 401; тіло з «погоджено»/станом ігнорується; після рішення погодження скасовано й побудова недоступна; показ наслідків у картці', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, skeletonPlusChain());
  const s = await startTestServer(db);
  try {
    const card = await s.call('GET', `/api/cases/${caseId}`);
    assert.equal(card.status, 200);
    assert.deepEqual(card.body.proposal_previews.bundles.map((b: any) => b.ids), [['R1', 'R2']]);
    assert.ok(card.body.proposal_previews.items.R2.needs_ack);
    assert.equal(card.body.link_kinds.exception.length > 0, true);
    const payload = { base_version_id: card.body.head.id, proposal_id: 'R2', decision: 'accept', approved: true, state: 'approved', acknowledge: false, preview_hash: card.body.proposal_previews.items.R2.hash };
    assert.equal((await s.call('POST', `/api/cases/${caseId}/step-proposals/decide`, payload, { auth: false })).status, 401);
    const refused = await s.call('POST', `/api/cases/${caseId}/step-proposals/decide`, payload);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'CONSEQUENCES_NOT_CONFIRMED');
    assert.ok(refused.body.error.details.preview.lines.length > 0);
    const group = await s.call('POST', `/api/cases/${caseId}/step-proposals/decide`, { base_version_id: card.body.head.id, proposal_ids: ['R1', 'R2'], decision: 'accept', preview_hash: card.body.proposal_previews.bundles[0].preview.hash, note: 'разом' });
    assert.equal(group.status, 201);
    // група з одного елемента, що лишає недосяжний крок: без підтвердження — 409, з підтвердженням — 201 (сервер передає саме ЇХНІЙ прапорець)
    const db2 = freshDb();
    const c2 = caseWith(db2, skeletonPlusChain()).caseId;
    const s2 = await startTestServer(db2);
    try {
      const card2 = (await s2.call('GET', `/api/cases/${c2}`)).body;
      const h2 = card2.head.id; const ph2 = card2.proposal_previews.items.R2.hash;
      const no = await s2.call('POST', `/api/cases/${c2}/step-proposals/decide`, { base_version_id: h2, proposal_ids: ['R2'], decision: 'accept', preview_hash: ph2 });
      assert.deepEqual([no.status, no.body.error.code], [409, 'CONSEQUENCES_NOT_CONFIRMED']);
      assert.equal((await s2.call('POST', `/api/cases/${c2}/step-proposals/decide`, { base_version_id: h2, proposal_ids: ['R2'], decision: 'accept', acknowledge: true, preview_hash: ph2 })).status, 201);
    } finally { await s2.close(); }
    const rej = await s.call('POST', `/api/cases/${caseId}/step-proposals/decide`, { base_version_id: group.body.version_id, proposal_ids: ['R1', 'R2'], decision: 'reject' });
    assert.equal(rej.status, 400, 'групове відхилення не підтримується');
    assert.equal(getCase(db, caseId).state, 'research');
    assert.equal((await s.call('POST', `/api/cases/${caseId}/bpmn/start`, {})).status, 409);
    assert.equal(bpmnGuard(db, caseId).ok, false);
  } finally { await s.close(); }
});

test('Прогін агента не прибирає рішення: пропозиції, прийняті людиною, лишаються прийнятими; нові — лише пропозиції', async () => {
  const db = freshDb();
  const { caseId } = caseWith(db, skeletonPlusChain());
  decideStepProposals(db, human, caseId, { previewHash: pvHash(db, caseId, ['R1', 'R2']), baseVersionId: headVersion(db, caseId).id, proposalIds: ['R1', 'R2'], note: 'ок' });
  const cur = headContent(db, caseId);
  const tamper = structuredClone(cur);
  tamper.step_proposals = tamper.step_proposals!.map((p) => ({ ...p, status: 'proposed' as const }));
  const res = await runAnalyst(db, caseId, new ScriptedDemoClient(() => tamper));
  assert.ok(res.ok);
  assert.deepEqual(headContent(db, caseId).step_proposals!.map((p) => p.status), ['accepted', 'accepted']);
});

test('Багато відкритих пропозицій: повний перебір комбінацій пропускається, але наслідки кожної окремо показано', () => {
  const c = baseContent();
  c.entry_step_id = 'K0';
  c.steps = [T('K0', 'Виконавець', 'Початок', 'Р', [{ to: 'END' }])];
  c.step_proposals = [];
  for (let i = 1; i <= 9; i++) {
    c.steps.push(T(`X${i}`, 'Виконавець', `Зайвий ${i}`, 'Р', [{ to: 'END' }]), T(`Y${i}`, 'Виконавець', `Заміна ${i}`, 'Р', [{ to: 'END' }]));
    c.step_proposals.push(P(`R${i}`, `X${i}`, `Y${i}`));
  }
  const pv = previewProposals(c);
  assert.equal(pv.bundles_skipped, true);
  assert.equal(Object.keys(pv.items).length, 9);
  assert.ok(pv.items.R1!.lines.length > 0 && pv.items.R1!.better_with.length === 0);
  assert.equal(one<{ n: number }>(freshDb(), 'SELECT COUNT(*) AS n FROM run')!.n, 0);
  assert.ok(UNKNOWN);
});
