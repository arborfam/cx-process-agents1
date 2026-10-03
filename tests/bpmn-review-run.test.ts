/**
 * Зріз 3b-2: запуск агента 2, бюджет, довіре збереження результату, відновлення після перезапуску.
 * Усе — на ПІДСТАВНОМУ клієнті (tests/review-helpers.ts); справжніх викликів моделі й мережі немає.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { all, one, openDb, type DB } from '../src/db.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import { actualCostUsd, makePolicy, spentUsd } from '../src/ai/budget.ts';
import { loadBpmnInstruction, loadInstruction } from '../src/ai/prompt.ts';
import { AnthropicBpmnClient } from '../src/ai/anthropic-bpmn-client.ts';
import { ModelFailure } from '../src/ai/types.ts';
import {
  acceptDraft, addNotationRequirement, addSource, approve, bpmnGuard, currentApproval, getCase, headVersion, returnToResearch, saveAnalystVersion,
  submitForApproval,
} from '../src/domain.ts';
import { beginAnalystRun, recoverStuckRuns } from '../src/runs.ts';
import {
  beginBpmnReview, executeBpmnReview, getCaseReview, listBpmnReviews, recordHash, runBpmnReviewForCase,
} from '../src/review-runs.ts';
import { agent, approvedCase, draftReadyCase, freshDb, human, startTestServer, tempDbPath } from './helpers.ts';
import { FAKE_MODEL, FakeReviewClient, USAGE, failStep, finding, okStep, policyOf, reviewer, type Step } from './review-helpers.ts';
import { pkgOf } from './bpmn-helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const CHILD = join(ROOT, 'tests', 'review-restart-child.ts');

const runRow = (db: DB, id: string) => one<Record<string, any>>(db, 'SELECT * FROM run WHERE id = ?', id)!;
const recRow = (db: DB, runId: string) => one<Record<string, any>>(db, 'SELECT * FROM bpmn_review WHERE run_id = ?', runId);
const approvalSnapshot = (db: DB, caseId: string) => JSON.stringify([getCase(db, caseId).state, currentApproval(db, caseId), all(db, 'SELECT id, content_hash FROM as_is_version WHERE case_id = ?', caseId)]);

async function doneReview(db: DB, caseId: string, steps: Step[] = [okStep([])], policy = policyOf()) {
  const client = new FakeReviewClient(steps);
  const r = await runBpmnReviewForCase(db, human, caseId, reviewer(client, policy));
  assert.ok(r.ok, JSON.stringify(r));
  return { client, r: r as Extract<typeof r, { ok: true }> };
}

// ───────── Успішний запуск і запис ─────────

test('успішна перевірка: незмінний запис із ID запуску, прив’язкою до пакета й інструкції, відповіддю, знахідками й обліком спроб; погодження не змінено', async () => {
  const db = freshDb();
  const { c, a } = approvedCase(db);
  const before = approvalSnapshot(db, c.id);
  const { client, r } = await doneReview(db, c.id);
  assert.equal(client.calls, 1);
  assert.equal(r.outcome, 'clear');
  const run = runRow(db, r.runId);
  const ins = loadBpmnInstruction();
  assert.deepEqual([run.agent, run.technical_state, run.mode, run.model, run.input_approval_id, run.instruction_version, run.instruction_hash, run.attempts],
    ['bpmn', 'done', 'real', FAKE_MODEL, a.id, 'bpmn-v0.7', ins.hash, 1]);
  assert.ok(Math.abs(run.cost_usd - actualCostUsd(policyOf(), USAGE)) < 1e-12 && run.reserved_usd === 0 && run.cost_known === 1);
  const rec = recRow(db, r.runId)!;
  assert.equal(rec.id, r.reviewId);
  assert.deepEqual([rec.outcome, rec.version_id, rec.approval_id, rec.client_mode, rec.instruction_hash], ['clear', a.version_id, a.id, 'real', ins.hash]);
  assert.equal(rec.content_hash, a.content_hash);
  assert.match(rec.content_fingerprint, /^[0-9a-f]{64}$/);
  // Відповідь зберігається дослівно; крім знахідок у ній тепер є таблиця процесу (D87).
  const response = JSON.parse(rec.response_json) as { findings: unknown[]; csv?: string };
  assert.deepEqual(response.findings, []);
  assert.match(response.csv ?? '', /^id,label,type,role,next,yes,no,assoc\n/);
  const att = JSON.parse(rec.attempts_json);
  assert.equal(att.attempts, 1);
  assert.deepEqual(att.usage, [USAGE]);
  assert.equal(att.attemptCosts[0].billing, 'known');
  assert.equal(rec.record_hash, recordHash(rec as never));
  assert.equal(approvalSnapshot(db, c.id), before, 'агент 2 не змінює ні версії, ні погодження, ні стан кейсу');
  const st = getCaseReview(db, c.id);
  assert.equal(st.state, 'clear');
  assert.deepEqual(st.gate, { ok: true });
  assert.equal(listBpmnReviews(db, c.id).length, 1);
});

test('запис незмінний: UPDATE і DELETE відхиляє сама база', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const { r } = await doneReview(db, c.id);
  assert.throws(() => db.prepare("UPDATE bpmn_review SET outcome = 'clear' WHERE id = ?").run(r.reviewId), /незмінна/);
  assert.throws(() => db.prepare('DELETE FROM bpmn_review WHERE id = ?').run(r.reviewId), /незмінна/);
});

test('блокувальні знахідки: перевірка завершена, але запуск лишається в очікуванні (awaiting_analyst), шлюз закритий, обходу немає', async () => {
  for (const f of [finding(), finding({ code: 'UNSUPPORTED_CANDIDATE', class: 'informational' })]) {
    const db = freshDb();
    const { c } = approvedCase(db);
    const before = approvalSnapshot(db, c.id);
    const { r } = await doneReview(db, c.id, [okStep([f])]);
    assert.equal(r.outcome, 'awaiting_analyst');
    const st = getCaseReview(db, c.id);
    assert.equal(st.state, 'awaiting_analyst');
    assert.ok(st.gate && !st.gate.ok && ['BLOCKING_FINDINGS', 'UNSUPPORTED_CANDIDATE'].includes(st.gate.code));
    assert.equal(st.findings?.length, 1);
    assert.equal(approvalSnapshot(db, c.id), before);
  }
});

test('informational-знахідки не блокують: стан clear, шлюз відкритий', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  await doneReview(db, c.id, [okStep([finding({ class: 'informational' })])]);
  const st = getCaseReview(db, c.id);
  assert.equal(st.state, 'clear');
  assert.equal(st.gate?.ok, true);
});

// ───────── Дозвіл, пакет із бази, актор ─────────

test('перед запуском перевіряються погодження, версія, хеш і програмні блокери: відмова — без виклику моделі й без запуску', async () => {
  // без погодження
  const db = freshDb();
  const { c } = draftReadyCase(db);
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl)), (e: any) => e.code === 'GUARD_FAILED' && e.details.reasons.some((x: any) => x.code === 'NOT_APPROVED_STATE'));
  // версія змінилась після погодження
  const db2 = freshDb();
  const { c: c2 } = approvedCase(db2);
  addSource(db2, human, c2.id, { kind: 'transcript', title: 'Нове', content: 'Нове джерело після погодження', origin: 'synthetic' });
  assert.throws(() => beginBpmnReview(db2, human, c2.id, reviewer(cl)), (e: any) => e.code === 'GUARD_FAILED');
  // хеш версії не збігається зі змістом (змінено запис у БД)
  const db3 = freshDb();
  const { c: c3, a: a3 } = approvedCase(db3);
  db3.exec('DROP TRIGGER as_is_version_no_update');
  db3.prepare("UPDATE as_is_version SET content_json = replace(content_json, 'Вносить зміну', 'Підроблена дія') WHERE id = ?").run(a3.version_id);
  assert.throws(() => beginBpmnReview(db3, human, c3.id, reviewer(cl)), (e: any) => e.code === 'GUARD_FAILED' && e.details.reasons.some((x: any) => x.code === 'HASH_MISMATCH'));
  for (const d of [db, db2, db3]) assert.equal(all(d, `SELECT id FROM run WHERE agent = 'bpmn'`).length, 0);
  assert.equal(cl.calls, 0);
});

test('запустити перевірку може лише людина; другий запуск, поки перший триває, відхиляється', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, agent, c.id, reviewer(cl)), (e: any) => e.code === 'FORBIDDEN');
  const first = beginBpmnReview(db, human, c.id, reviewer(cl));
  assert.equal(first.kind, 'started');
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl)), (e: any) => e.code === 'GUARD_FAILED' && e.details.reasons.some((x: any) => x.code === 'RUN_ACTIVE'));
  assert.equal(cl.calls, 0);
});

test('пакет для моделі береться з бази за погодженням, а не від викликача: модель отримує саме погоджений зміст і прив’язку', async () => {
  const db = freshDb();
  const { c, a } = approvedCase(db);
  const { client } = await doneReview(db, c.id);
  const input = client.inputs[0]!;
  assert.equal(input.pkg.versionId, a.version_id);
  assert.equal(input.pkg.contentHash, a.content_hash);
  assert.ok(input.pkg.content.steps.some((s) => s.action === 'Вносить зміну'));
  assert.equal(input.instruction.version, 'bpmn-v0.7');
});

// ───────── unsupported без моделі ─────────

function approvedWithRequirement(db: DB) {
  const { c, v } = draftReadyCase(db);
  const v2 = addNotationRequirement(db, human, c.id, { baseVersionId: v.id, kind: 'parallel_branches', stepId: 'S2', detail: 'дві дії виконуються одночасно' });
  acceptDraft(db, human, c.id, v2.id);
  submitForApproval(db, human, c.id);
  const a = approve(db, human, c.id, { versionId: v2.id, checklistConfirmed: true });
  return { c, a };
}

test('підтверджена непідтримувана нотація → unsupported БЕЗ виклику моделі (навіть без клієнта), погодження AS-IS чинне, бюджет не зачеплено', async () => {
  for (const withClient of [true, false]) {
    const db = freshDb();
    const { c } = approvedWithRequirement(db);
    const before = approvalSnapshot(db, c.id);
    const cl = new FakeReviewClient([okStep([])]);
    const r = await runBpmnReviewForCase(db, human, c.id, withClient ? reviewer(cl) : undefined);
    assert.ok(r.ok && r.outcome === 'unsupported');
    assert.match((r as { explanation: string }).explanation, /паралельні гілки \(крок S2\)/);
    assert.equal(cl.calls, 0, 'модель не викликалась');
    const run = runRow(db, r.runId);
    assert.deepEqual([run.mode, run.technical_state, run.cost_usd, run.reserved_usd], ['none', 'done', null, 0]);
    assert.equal(spentUsd(db), 0, 'такий запуск не витрачає бюджет');
    assert.equal(approvalSnapshot(db, c.id), before, 'погодження AS-IS не скасовано');
    assert.equal(getCase(db, c.id).state, 'approved');
    const st = getCaseReview(db, c.id);
    assert.equal(st.state, 'unsupported');
    assert.equal(st.requirements?.[0]?.kind, 'parallel_branches');
    assert.equal(st.gate, undefined, 'шлюзу до генерації немає: схему не будуємо');
  }
});

// ───────── деморежим ─────────

test('продуктовий деморежим: без налаштованого клієнта смислова перевірка не імітується — відмова AI_UNAVAILABLE, запуску й запису немає', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  assert.throws(() => beginBpmnReview(db, human, c.id, undefined), (e: any) => e.code === 'AI_UNAVAILABLE' && /не вигадуються/.test(e.message));
  assert.equal(all(db, 'SELECT id FROM run').length, 0);
  assert.equal(all(db, 'SELECT id FROM bpmn_review').length, 0);
  assert.equal(getCaseReview(db, c.id).state, 'none');
  assert.ok(all<{ action: string }>(db, 'SELECT action FROM audit_log').some((x) => x.action === 'bpmn_review_refused'));
  const s = await startTestServer(db);
  try {
    const r = await s.call('POST', `/api/cases/${c.id}/bpmn/review`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'AI_UNAVAILABLE');
    const g = await s.call('GET', `/api/cases/${c.id}/bpmn/review`);
    assert.equal(g.body.state, 'none');
    assert.equal(g.body.generation_gate.ok, false);
  } finally { await s.close(); }
});

test('клієнт, що назвався demo, може відпрацювати, але шлюз до генерації закритий (REVIEW_DEMO_MODE) і бюджет не рахується', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([okStep([])], 'demo');
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(cl, null));
  assert.ok(r.ok);
  const st = getCaseReview(db, c.id);
  assert.equal(st.state, 'clear');
  assert.ok(st.gate && !st.gate.ok && st.gate.code === 'REVIEW_DEMO_MODE');
  assert.equal(spentUsd(db), 0);
});

test('справжній клієнт без політики (ліміти й ціни) не запускається', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl, null)), (e: any) => e.code === 'AI_UNAVAILABLE');
  assert.equal(cl.calls, 0);
});

test('джерела з позначкою «реальні» блокують запуск справжньої моделі (D18): нічого не надсилається', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  addSource(db, human, c.id, { kind: 'transcript', title: 'Реальне', content: 'Реальні дані клієнта', origin: 'real' });
  // нове джерело робить дозвіл недійсним — перевіряємо порядок: спершу серверний дозвіл
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl)), (e: any) => ['GUARD_FAILED', 'REAL_DATA_BLOCKED'].includes(e.code));
  assert.equal(cl.calls, 0);
});

// ───────── Бюджет ─────────

test('бюджет спільний для двох агентів: резерв агента 1 зменшує доступне агентові 2, і навпаки (атомарне резервування)', async () => {
  const policy = policyOf({ CX_BUDGET_USD_TOTAL: '1.0' });
  // агент 1 резервує → агент 2 відхилено
  const db = freshDb();
  const { c } = approvedCase(db);
  const other = draftReadyCase(db).c;
  const analystClient = { mode: 'real' as const, model: FAKE_MODEL, analyze: async () => ({ output: {} }) };
  beginAnalystRun(db, other.id, analystClient, { policy, instruction: loadInstruction() });
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl, policy)), (e: any) => e.code === 'BUDGET_TOTAL');
  assert.equal(cl.calls, 0);
  // агент 2 резервує → агент 1 відхилено
  const db2 = freshDb();
  const { c: c2 } = approvedCase(db2);
  const other2 = draftReadyCase(db2).c;
  const s = beginBpmnReview(db2, human, c2.id, reviewer(cl, policy));
  assert.equal(s.kind, 'started');
  assert.ok(runRow(db2, (s as { ctx: { runId: string } }).ctx.runId).reserved_usd > 0.3);
  assert.throws(() => beginAnalystRun(db2, other2.id, analystClient, { policy, instruction: loadInstruction() }), (e: any) => e.code === 'BUDGET_TOTAL');
});

test('після завершення резерв заміняється фактичною вартістю, і бюджет звільняється для наступного запуску', async () => {
  const policy = policyOf({ CX_BUDGET_USD_TOTAL: '1.0' });
  const db = freshDb();
  const { c } = approvedCase(db);
  const { c: c2 } = approvedCase(db);
  const first = beginBpmnReview(db, human, c.id, reviewer(new FakeReviewClient([okStep([])]), policy));
  assert.equal(first.kind, 'started');
  assert.throws(() => beginBpmnReview(db, human, c2.id, reviewer(new FakeReviewClient([okStep([])]), policy)), (e: any) => e.code === 'BUDGET_TOTAL', 'резерв першого тримає бюджет');
  const r = await executeBpmnReview(db, (first as Extract<ReturnType<typeof beginBpmnReview>, { kind: "started" }>).ctx, reviewer(new FakeReviewClient([okStep([])]), policy));
  assert.ok(r.ok);
  assert.ok(Math.abs(spentUsd(db) - actualCostUsd(policy, USAGE)) < 1e-12);
  assert.equal(beginBpmnReview(db, human, c2.id, reviewer(new FakeReviewClient([okStep([])]), policy)).kind, 'started');
});

test('ліміт на запуск ($1,5 в політиці) діє разом із повтором: повтор, що його перевищив би, не виконується; невідома вартість першої спроби лишається в резерві', async () => {
  const policy = policyOf({ CX_BUDGET_USD_PER_RUN: '1.0' });
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([failStep('transient')]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(cl, policy));
  assert.ok(!r.ok);
  assert.equal(cl.calls, 1, 'повторної спроби немає');
  const run = runRow(db, r.runId);
  assert.equal(run.technical_state, 'error');
  assert.match(run.error, /Повторну спробу не виконано/);
  assert.match(run.error, /лімітом на запуск/);           // формулювання уточнено в D81: ліміт названо разом із числами
  assert.match(run.error, /уже витрачено|перша спроба/i); // і видно, що перша спроба вже виконана
  assert.deepEqual([run.cost_known, run.cost_usd], [0, null]);
  assert.ok(run.reserved_usd > 0.3 && run.reserved_usd <= 1.0, `резерв першої спроби лишився: ${run.reserved_usd}`);
  assert.equal(recRow(db, r.runId), undefined, 'результату перевірки немає');
  assert.equal(getCaseReview(db, c.id).state, 'failed');
});

test('збій із невідомою вартістю (обрив/тайм-аут без usage): помилка, резерв обох спроб лишається, спільний бюджет це враховує, кейс і погодження без змін', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const before = approvalSnapshot(db, c.id);
  const cl = new FakeReviewClient([failStep('transient')]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(cl));
  assert.ok(!r.ok);
  assert.equal(cl.calls, 2, 'одна автоматична повторна спроба');
  const run = runRow(db, r.runId);
  assert.deepEqual([run.technical_state, run.cost_known, run.cost_usd, run.attempts], ['error', 0, null, 2]);
  assert.ok(run.reserved_usd > 1.0, `резерв двох спроб: ${run.reserved_usd}`);
  assert.ok(Math.abs(spentUsd(db) - run.reserved_usd) < 1e-12);
  assert.equal(approvalSnapshot(db, c.id), before);
  assert.equal(all(db, 'SELECT id FROM bpmn_review').length, 0);
});

test('збій без оплати (API відхилив запит ще до генерації, напр. «credit balance too low»): вартість відома й нульова, повтору немає', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([failStep('bad_request', undefined, 'none')]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(cl));
  assert.ok(!r.ok);
  assert.equal(cl.calls, 1);
  const run = runRow(db, r.runId);
  assert.deepEqual([run.cost_known, run.cost_usd, run.reserved_usd], [1, 0, 0]);
  assert.equal(spentUsd(db), 0);
});

test('повтор після некоректної відповіді: друга спроба має резерв, фактична вартість — сума двох спроб; успіх із відомим usage', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const bad = okStep([finding({ quote: 'вигадана цитата, якої немає в пакеті' })]);
  const cl = new FakeReviewClient([bad, okStep([])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(cl));
  assert.ok(r.ok);
  assert.equal(cl.calls, 2);
  assert.ok(cl.inputs[1]!.retry_feedback?.some((f) => /QUOTE_NOT_FOUND/.test(f)));
  const run = runRow(db, r.runId);
  assert.ok(Math.abs(run.cost_usd - 2 * actualCostUsd(policyOf(), USAGE)) < 1e-12);
  assert.deepEqual([run.reserved_usd, run.cost_known, run.attempts], [0, 1, 2]);
  const att = JSON.parse(recRow(db, r.runId)!.attempts_json);
  assert.equal(att.failedAttempts.length, 1);
  assert.equal(att.failedAttempts[0].kind, 'invalid_output');
});

test('успішна відповідь без usage: вартість невідома, резерв лишається (cost_usd = NULL)', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(new FakeReviewClient([okStep([], null)])));
  assert.ok(r.ok);
  const run = runRow(db, r.runId);
  assert.deepEqual([run.cost_known, run.cost_usd], [0, null]);
  assert.ok(run.reserved_usd > 0.3);
});

test('перевищення обсягу входу й ліміти запусків відхиляються до виклику', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl, policyOf({ CX_MAX_INPUT_CHARS: '500' }))), (e: any) => e.code === 'INPUT_TOO_LARGE');
  assert.equal(cl.calls, 0);
});

// ───────── Застарілий результат ─────────

function staleCases(): [string, (db: DB, caseId: string) => void][] {
  return [
    ['нове джерело', (db, id) => { addSource(db, human, id, { kind: 'transcript', title: 'Нове', content: 'Нова інформація під час перевірки', origin: 'synthetic' }); }],
    ['нова версія AS-IS', (db, id) => { saveAnalystVersion(db, human, id, { baseVersionId: headVersion(db, id).id, fields: { summary: 'Змінений опис під час перевірки' }, coverAllSources: true }); }],
    ['скасоване погодження', (db, id) => { returnToResearch(db, human, id, 'повернено під час перевірки'); }],
  ];
}

for (const [what, mutate] of staleCases()) {
  test(`застарілий результат (${what} під час роботи моделі): зберігається як застарілий, генерацію не дозволяє, вартість облікована`, async () => {
    const db = freshDb();
    const { c } = approvedCase(db);
    // Таблиця — сценарна, як і в решті тестів: без неї відповідь не пройшла б перевірки (D87).
    const side: Step = (input, signal) => { mutate(db, c.id); return okStep([])(input, signal); };
    const r = await runBpmnReviewForCase(db, human, c.id, reviewer(new FakeReviewClient([side])));
    assert.ok(r.ok && r.outcome === 'stale', JSON.stringify(r));
    const rec = recRow(db, r.runId)!;
    assert.equal(rec.outcome, 'stale');
    assert.ok(JSON.parse(rec.detail_json).stale_reasons.length > 0);
    const st = getCaseReview(db, c.id);
    assert.equal(st.state, 'stale');
    assert.equal(st.gate, undefined, 'шлюзу немає: застарілий результат генерацію не дозволяє');
    assert.equal(st.review, undefined);
    assert.ok(Math.abs(runRow(db, r.runId).cost_usd - actualCostUsd(policyOf(), USAGE)) < 1e-12, 'гроші витрачено — облік є');
    assert.equal(bpmnGuard(db, c.id).ok, false, 'самі зміни зробили серверний дозвіл недійсним');
  });
}

test('результат, що був чинним, стає застарілим, коли після нього змінюється AS-IS, джерела чи погодження', async () => {
  for (const [what, mutate] of staleCases()) {
    const db = freshDb();
    const { c } = approvedCase(db);
    await doneReview(db, c.id);
    assert.equal(getCaseReview(db, c.id).state, 'clear', what);
    mutate(db, c.id);
    const st = getCaseReview(db, c.id);
    assert.equal(st.state, 'stale', what);
    assert.equal(st.review, undefined);
    assert.ok(st.reasons!.length > 0);
  }
});

test('результат старої версії не переноситься на нове погодження: потрібна нова перевірка', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  await doneReview(db, c.id);
  returnToResearch(db, human, c.id, 'доопрацювання');
  const head = headVersion(db, c.id);
  const v2 = saveAnalystVersion(db, human, c.id, { baseVersionId: head.id, fields: { summary: 'Оновлений опис' }, coverAllSources: true });
  acceptDraft(db, human, c.id, v2.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v2.id, checklistConfirmed: true });
  assert.equal(getCaseReview(db, c.id).state, 'stale', 'перевірка стосується іншого погодження');
  await doneReview(db, c.id);
  assert.equal(getCaseReview(db, c.id).state, 'clear');
});

// ───────── Підроблений або змінений запис ─────────

function forge(db: DB, runId: string, patch: Record<string, unknown>, opts: { rehash?: boolean } = { rehash: true }) {
  db.exec('DROP TRIGGER IF EXISTS bpmn_review_no_update');
  const row = recRow(db, runId)!;
  const next = { ...row, ...patch };
  const { record_hash: _old, ...rest } = next;
  const hash = opts.rehash === false ? row.record_hash : recordHash(rest as never);
  const keys = Object.keys(patch);
  db.prepare(`UPDATE bpmn_review SET ${[...keys, 'record_hash'].map((k) => `${k} = ?`).join(', ')} WHERE run_id = ?`).run(...keys.map((k) => next[k] as never), hash, runId);
}

const blocking = finding();

test('змінений запис без перерахунку хеша відхиляється: знахідки, висновок, прив’язка, відповідь, попередження, версія', async () => {
  const patches: Record<string, unknown>[] = [
    { findings_json: '[]' }, { outcome: 'clear' }, { warnings_json: '["підроблено"]' }, { response_json: JSON.stringify({ findings: [] }) },
    { content_hash: 'f'.repeat(64) }, { content_fingerprint: 'e'.repeat(64) }, { client_mode: 'demo' }, { instruction_hash: 'a'.repeat(64) },
  ];
  for (const p of patches) {
    const db = freshDb();
    const { c } = approvedCase(db);
    const { r } = await doneReview(db, c.id, [okStep([blocking])]);
    forge(db, r.runId, p, { rehash: false });
    const st = getCaseReview(db, c.id);
    assert.equal(st.state, 'untrusted', JSON.stringify(Object.keys(p)));
    assert.equal(st.review, undefined);
    assert.equal(st.gate, undefined);
    assert.match(st.reasons!.join(' '), /Хеш запису/);
  }
});

test('запис із перерахованим хешем, але змістом, що суперечить збереженій відповіді, відхиляється повторною перевіркою кодом', async () => {
  const make = async () => { const db = freshDb(); const { c } = approvedCase(db); const { r } = await doneReview(db, c.id, [okStep([blocking])]); return { db, c, r }; };
  // знахідки «прибрано» (вдає чисту перевірку), відповідь лишилась блокувальною
  let t = await make();
  forge(t.db, t.r.runId, { findings_json: '[]', outcome: 'clear' });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
  // лише висновок змінено на clear
  t = await make();
  forge(t.db, t.r.runId, { outcome: 'clear' });
  let st = getCaseReview(t.db, t.c.id);
  assert.equal(st.state, 'untrusted');
  assert.match(st.reasons!.join(' '), /Висновок у записі/);
  // відповідь замінено порожньою, знахідки лишили блокувальними
  t = await make();
  forge(t.db, t.r.runId, { response_json: JSON.stringify({ findings: [] }) });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
  // відповідь із вигаданою цитатою (не проходить перевірку) + узгоджені знахідки
  t = await make();
  const fake = { findings: [finding({ quote: 'цитата, якої немає в погодженому описі' })] };
  forge(t.db, t.r.runId, { response_json: JSON.stringify(fake), findings_json: JSON.stringify(fake.findings) });
  st = getCaseReview(t.db, t.c.id);
  assert.equal(st.state, 'untrusted');
  assert.match(st.reasons!.join(' '), /більше не проходить/);
  // знахідки не збігаються за порядком/вмістом
  t = await make();
  forge(t.db, t.r.runId, { findings_json: JSON.stringify([finding({ class: 'informational' })]) });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
});

test('запис, не узгоджений із журналом запуску (інший режим, модель, інструкція, погодження, стан) або без запуску, відхиляється', async () => {
  const mk = async () => { const db = freshDb(); const { c } = approvedCase(db); const { r } = await doneReview(db, c.id); return { db, c, r }; };
  let t = await mk();
  forge(t.db, t.r.runId, { client_mode: 'demo' }); // хеш перераховано, а запуск має mode=real
  assert.match(getCaseReview(t.db, t.c.id).reasons!.join(' '), /Режим чи модель/);
  t = await mk();
  forge(t.db, t.r.runId, { client_model: 'інша модель' });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
  t = await mk();
  forge(t.db, t.r.runId, { instruction_hash: 'b'.repeat(64) });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
  t = await mk();
  t.db.prepare("UPDATE run SET input_approval_id = 'apr_чужий' WHERE id = ?").run(t.r.runId);
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
  // запуск не завершений
  t = await mk();
  t.db.prepare("UPDATE run SET technical_state = 'error' WHERE id = ?").run(t.r.runId);
  assert.equal(getCaseReview(t.db, t.c.id).state, 'failed', 'помилкового запуску за результат не вважаємо');
  // запису взагалі немає, запуск «done» (нібито завершений)
  t = await mk();
  t.db.exec('DROP TRIGGER bpmn_review_no_delete');
  t.db.exec('PRAGMA foreign_keys = OFF');
  t.db.prepare('DELETE FROM bpmn_review WHERE run_id = ?').run(t.r.runId);
  const st = getCaseReview(t.db, t.c.id);
  assert.equal(st.state, 'untrusted');
  assert.match(st.reasons!.join(' '), /запису результату немає/);
});

test('запис, вставлений напряму в обхід запуску (з довільним хешем), довіри не має', async () => {
  const db = freshDb();
  const { c, a } = approvedCase(db);
  const ins = loadBpmnInstruction();
  db.prepare(`INSERT INTO run (id, case_id, agent, instruction_version, instruction_hash, mode, model, base_version_id, input_approval_id, technical_state, started_at, finished_at)
    VALUES ('run_fake','${c.id}','bpmn','bpmn-v0.7','${ins.hash}','real','${FAKE_MODEL}','${a.version_id}','${a.id}','done','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO bpmn_review VALUES ('rev_fake','run_fake','${c.id}','clear','${a.version_id}','${a.id}','${a.content_hash}','${'0'.repeat(64)}','bpmn-v0.7','${ins.hash}','real','${FAKE_MODEL}','{"findings":[]}','[]','[]','{"attempts":1,"usage":[],"failedAttempts":[],"attemptCosts":[]}','{}','2099-01-01T00:00:00.000Z','${'1'.repeat(64)}')`).run();
  const st = getCaseReview(db, c.id);
  assert.equal(st.state, 'untrusted');
  assert.equal(st.gate, undefined);
});

test('змінений зміст версії в базі (порушена цілісність) робить результат недовіреним', async () => {
  const db = freshDb();
  const { c, a } = approvedCase(db);
  await doneReview(db, c.id);
  db.exec('DROP TRIGGER as_is_version_no_update');
  db.prepare("UPDATE as_is_version SET content_json = replace(content_json, 'Вносить зміну', 'Підроблена дія') WHERE id = ?").run(a.version_id);
  const st = getCaseReview(db, c.id);
  assert.ok(['untrusted', 'stale'].includes(st.state));
  assert.equal(st.review, undefined);
  assert.equal(st.gate, undefined);
});

test('рекреація: інструкція змінилась після перевірки → стан clear, але шлюз закритий (REVIEW_INSTRUCTION_MISMATCH)', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  await doneReview(db, c.id);
  const cur = loadBpmnInstruction();
  const st = getCaseReview(db, c.id, { ...cur, hash: 'd'.repeat(64) });
  assert.equal(st.state, 'clear');
  assert.ok(st.gate && !st.gate.ok && st.gate.code === 'REVIEW_INSTRUCTION_MISMATCH');
});

// ───────── Окремі шари перевірки запису (мутації 04/05/06/09/18 були не виявлені) ─────────

test('кожен шар довіри працює окремо: погодження в записі, цілісність версії, відбиток змісту — із перерахованим хешем запису', async () => {
  const mk = async () => { const db = freshDb(); const { c, a } = approvedCase(db); const { r } = await doneReview(db, c.id); return { db, c, a, r }; };
  // (а) відбиток змісту в записі не збігається зі змістом версії
  let t = await mk();
  forge(t.db, t.r.runId, { content_fingerprint: 'e'.repeat(64) });
  let st = getCaseReview(t.db, t.c.id);
  assert.equal(st.state, 'untrusted');
  assert.match(st.reasons!.join(' '), /Відбиток змісту/);
  // (б) погодження в записі існує, але належить іншій версії/хешу (після повторного погодження)
  t = await mk();
  returnToResearch(t.db, human, t.c.id, 'доопрацювання');
  const v2 = saveAnalystVersion(t.db, human, t.c.id, { baseVersionId: headVersion(t.db, t.c.id).id, fields: { summary: 'Оновлений опис' }, coverAllSources: true });
  acceptDraft(t.db, human, t.c.id, v2.id);
  submitForApproval(t.db, human, t.c.id);
  const a2 = approve(t.db, human, t.c.id, { versionId: v2.id, checklistConfirmed: true });
  t.db.prepare('UPDATE run SET input_approval_id = ? WHERE id = ?').run(a2.id, t.r.runId);
  forge(t.db, t.r.runId, { approval_id: a2.id });
  st = getCaseReview(t.db, t.c.id);
  assert.equal(st.state, 'untrusted', 'запис посилається на чинне погодження, але з версією й хешем іншого');
  assert.match(st.reasons!.join(' '), /Погодження в записі/);
  // (в) цілісність версії: хеш версії, погодження й запису підроблено узгоджено, зміст не змінено
  t = await mk();
  const fakeHash = 'c'.repeat(64);
  t.db.exec('DROP TRIGGER as_is_version_no_update; DROP TRIGGER approval_no_update;');
  t.db.prepare('UPDATE as_is_version SET content_hash = ? WHERE id = ?').run(fakeHash, t.a.version_id);
  t.db.prepare('UPDATE approval SET content_hash = ? WHERE id = ?').run(fakeHash, t.a.id);
  forge(t.db, t.r.runId, { content_hash: fakeHash });
  st = getCaseReview(t.db, t.c.id);
  assert.equal(st.state, 'untrusted');
  assert.match(st.reasons!.join(' '), /Цілісність версії/);
});

test('запис unsupported перевіряється проти підтверджених вимог погодженої версії: підроблені вимоги, чужа відповідь чи режим відхиляються', async () => {
  const mk = async () => { const db = freshDb(); const { c } = approvedWithRequirement(db); const r = await runBpmnReviewForCase(db, human, c.id); assert.ok(r.ok); return { db, c, r: r as { runId: string } }; };
  let t = await mk();
  assert.equal(getCaseReview(t.db, t.c.id).state, 'unsupported');
  t = await mk();
  forge(t.db, t.r.runId, { detail_json: JSON.stringify({ requirements: [{ id: 'N9', kind: 'timer', label: 'таймер', step_id: 'S1', detail: 'підроблено', evidence_quote: '' }] }) });
  assert.match(getCaseReview(t.db, t.c.id).reasons!.join(' '), /не відповідає підтвердженим вимогам/);
  t = await mk();
  forge(t.db, t.r.runId, { detail_json: JSON.stringify({ requirements: [] }) });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted');
  t = await mk();
  forge(t.db, t.r.runId, { response_json: JSON.stringify({ findings: [] }) });
  assert.equal(getCaseReview(t.db, t.c.id).state, 'untrusted', 'unsupported не може мати відповіді моделі');
});

function approvedWithRealSource(db: DB) {
  const c = draftReadyCase(db).c;
  addSource(db, human, c.id, { kind: 'transcript', title: 'Реальне інтерв’ю', content: 'Реальні дані клієнта', origin: 'real' });
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: {}, coverAllSources: true });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  return c;
}

test('джерела з позначкою «реальні» у погодженому кейсі: справжня модель не викликається (REAL_DATA_BLOCKED), запуску й резерву немає; unsupported без моделі допустимий', async () => {
  const db = freshDb();
  const c = approvedWithRealSource(db);
  assert.equal(bpmnGuard(db, c.id).ok, true, 'серверний дозвіл є: блокує саме правило D18 для моделі');
  const cl = new FakeReviewClient([okStep([])]);
  assert.throws(() => beginBpmnReview(db, human, c.id, reviewer(cl)), (e: any) => e.code === 'REAL_DATA_BLOCKED');
  assert.equal(cl.calls, 0);
  assert.equal(all(db, `SELECT id FROM run WHERE agent = 'bpmn'`).length, 0);
  assert.equal(spentUsd(db), 0);
});

// ───────── Відновлення без нового виклику ─────────

test('відновлення завершеної перевірки НЕ викликає модель: скільки б разів не читали стан, клієнт викликано рівно один раз', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const { client } = await doneReview(db, c.id, [okStep([])]);
  for (let i = 0; i < 5; i++) {
    const st = getCaseReview(db, c.id);
    assert.equal(st.state, 'clear');
    assert.deepEqual(st.gate, { ok: true });
    assert.notEqual(st.review, undefined);
  }
  assert.equal(client.calls, 1);
});

test('СПРАВЖНІЙ перезапуск процесу: завершена перевірка відновлюється з БД у новому процесі без клієнта моделі й без мережі, шлюз працює (чиста й блокувальна)', async () => {
  const path = tempDbPath();
  const db = openDb(path);
  const clear = approvedCase(db).c;
  const blockedCase = approvedCase(db).c;
  await doneReview(db, clear.id, [okStep([])]);
  await doneReview(db, blockedCase.id, [okStep([blocking])]);
  db.close();
  const ask = (caseId: string) => {
    const p = spawnSync(process.execPath, ['--import', 'tsx', CHILD, 'restore', path, caseId], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout.trim().split('\n').pop()!) as Record<string, any>;
  };
  const a = ask(clear.id);
  assert.notEqual(a.pid, process.pid, 'це інший процес ОС');
  assert.deepEqual([a.state, a.gateOk, a.fetchCalls, a.recovered], ['clear', true, 0, 0]);
  const b = ask(blockedCase.id);
  assert.deepEqual([b.state, b.gateOk, b.gateCode, b.findings, b.fetchCalls], ['awaiting_analyst', false, 'BLOCKING_FINDINGS', 1, 0]);
});

test('СПРАВЖНІЙ перезапуск під час запуску: процес убито посеред виклику → після старту запуск = помилка (не успіх), резерв лишається, платно мовчки не повторюється, повтор — лише вручну', async () => {
  const path = tempDbPath();
  const db = openDb(path);
  const { c } = approvedCase(db);
  db.close();
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, 'hang', path, c.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('дочірній процес не дійшов до виклику клієнта: ' + out)), 60_000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('CALLED')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));

  const db2 = openDb(path);
  const mid = one<Record<string, any>>(db2, `SELECT * FROM run WHERE agent = 'bpmn'`)!;
  assert.equal(mid.technical_state, 'running', 'убитий процес лишив запуск «виконується»');
  assert.ok(mid.reserved_usd > 0.3);
  assert.equal(getCaseReview(db2, c.id).state, 'running');
  assert.equal(all(db2, 'SELECT id FROM bpmn_review').length, 0);
  db2.close();

  const p = spawnSync(process.execPath, ['--import', 'tsx', CHILD, 'restore', path, c.id], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(p.status, 0, p.stderr);
  const st = JSON.parse(p.stdout.trim().split('\n').pop()!);
  assert.deepEqual([st.recovered, st.state, st.gateOk, st.fetchCalls], [1, 'failed', null, 0]);

  const db3 = openDb(path);
  const after = one<Record<string, any>>(db3, `SELECT * FROM run WHERE id = ?`, mid.id)!;
  assert.equal(after.technical_state, 'error');
  assert.match(after.error, /перервано перезапуском/);
  assert.deepEqual([after.cost_known, after.cost_usd], [0, null]);
  assert.ok(after.reserved_usd >= mid.reserved_usd, 'резерв невідомої вартості не звільняється');
  assert.ok(spentUsd(db3) >= mid.reserved_usd);
  assert.equal(all(db3, 'SELECT id FROM bpmn_review').length, 0, 'успішного результату немає');
  assert.equal(getCase(db3, c.id).state, 'approved');
  assert.equal(bpmnGuard(db3, c.id).ok, true, 'ручний повтор дозволено');
  const retry = await runBpmnReviewForCase(db3, human, c.id, reviewer(new FakeReviewClient([okStep([])])));
  assert.ok(retry.ok);
  assert.equal(getCaseReview(db3, c.id).state, 'clear');
  assert.equal(all(db3, `SELECT id FROM run WHERE agent = 'bpmn'`).length, 2, 'повтор — окремий новий запуск');
  db3.close();
});

test('recoverStuckRuns: перервану перевірку не відновлює й не повторює; текст помилки відповідає агентові 2', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const cl = new FakeReviewClient([okStep([])]);
  const s = beginBpmnReview(db, human, c.id, reviewer(cl));
  assert.equal(s.kind, 'started');
  assert.equal(recoverStuckRuns(db), 1);
  assert.equal(cl.calls, 0);
  const run = one<Record<string, any>>(db, `SELECT * FROM run WHERE agent = 'bpmn'`)!;
  assert.equal(run.technical_state, 'error');
  assert.match(run.error, /Смислову перевірку перервано/);
  // перервана модель не може «дописати» результат у запуск, що вже став помилкою
  const r = await executeBpmnReview(db, (s as Extract<ReturnType<typeof beginBpmnReview>, { kind: "started" }>).ctx, reviewer(cl));
  assert.ok(!r.ok);
  assert.equal(all(db, 'SELECT id FROM bpmn_review').length, 0);
});

// ───────── HTTP: від браузера результат не приймається ─────────

test('HTTP: тіло запиту з «висновком», знахідками чи станом ігнорується — результат визначає лише відповідь моделі, перевірена кодом', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([blocking])]);
  const s = await startTestServer(db, { reviewer: reviewer(client) });
  try {
    const noAuth = await s.call('POST', `/api/cases/${c.id}/bpmn/review`, {}, { auth: false });
    assert.equal(noAuth.status, 401);
    const r = await s.call('POST', `/api/cases/${c.id}/bpmn/review`, { outcome: 'clear', state: 'clear', findings: [], review: { status: 'completed', findings: [] }, generation_gate: { ok: true }, run_id: 'fake' });
    assert.equal(r.status, 202);
    for (let i = 0; i < 100 && (await s.call('GET', `/api/cases/${c.id}/bpmn/review`)).body.state === 'running'; i++) await new Promise((x) => setTimeout(x, 20));
    const g = await s.call('GET', `/api/cases/${c.id}/bpmn/review`);
    assert.equal(g.body.state, 'awaiting_analyst');
    assert.equal(g.body.generation_gate.ok, false);
    assert.equal(g.body.findings.length, 1);
    assert.equal(g.body.run_id, r.body.run_id);
    assert.equal(client.calls, 1);
    const put = await s.call('PUT', `/api/cases/${c.id}/bpmn/review`, { outcome: 'clear' });
    assert.ok([404, 405].includes(put.status), 'змінити результат через API неможливо');
  } finally { await s.close(); }
});

test('HTTP: після «перезапуску сервера» (нова програма на тій самій базі) стан відновлюється без виклику моделі', async () => {
  const path = tempDbPath();
  const db = openDb(path);
  const { c } = approvedCase(db);
  const first = await startTestServer(db, { reviewer: reviewer(new FakeReviewClient([okStep([])])) });
  try {
    await first.call('POST', `/api/cases/${c.id}/bpmn/review`, {});
    for (let i = 0; i < 100 && (await first.call('GET', `/api/cases/${c.id}/bpmn/review`)).body.state === 'running'; i++) await new Promise((x) => setTimeout(x, 20));
    assert.equal((await first.call('GET', `/api/cases/${c.id}/bpmn/review`)).body.state, 'clear');
  } finally { await first.close(); } // сервер закривається й при провалі перевірки: інакше процес тестів висить
  db.close();

  const db2 = openDb(path);
  recoverStuckRuns(db2);
  const never = new FakeReviewClient([() => { throw new Error('модель не повинна викликатись'); }]);
  const second = await startTestServer(db2, { reviewer: reviewer(never) });
  try {
    const g = await second.call('GET', `/api/cases/${c.id}/bpmn/review`);
    assert.equal(g.body.state, 'clear');
    assert.equal(g.body.generation_gate.ok, true);
    assert.equal(never.calls, 0);
  } finally { await second.close(); }
});

test('HTTP: підтверджена непідтримувана нотація → 200 unsupported без моделі (і без налаштованого клієнта)', async () => {
  const db = freshDb();
  const { c } = approvedWithRequirement(db);
  const s = await startTestServer(db);
  try {
    const r = await s.call('POST', `/api/cases/${c.id}/bpmn/review`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'unsupported');
    assert.match(r.body.explanation, /паралельні гілки/);
    assert.equal((await s.call('GET', `/api/cases/${c.id}/bpmn/review`)).body.state, 'unsupported');
  } finally { await s.close(); }
});

test('дві перевірки одного кейсу: чинним вважається останній запуск; невдалий повтор після чистої перевірки показує failed, а не старий успіх', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  await doneReview(db, c.id);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(new FakeReviewClient([failStep('auth', undefined, 'none')])));
  assert.ok(!r.ok);
  assert.equal(getCaseReview(db, c.id).state, 'failed');
  assert.equal(listBpmnReviews(db, c.id).length, 1);
});

// ───────── Клієнт Anthropic (підставний SDK, без мережі) ─────────

function fakeSdk(msg: unknown | Error) {
  const calls: any[] = [];
  const sdk = { messages: { stream: (params: any, opts: any) => { calls.push({ params, opts }); return { finalMessage: async () => { if (msg instanceof Error) throw msg; return msg; } }; } } };
  return { sdk: sdk as unknown as Anthropic, calls };
}
const SECRET = 'sk-ant-api03-SECRETSECRETSECRET1234567890';
const mkClient = (sdk: Anthropic, extra: Record<string, string> = {}) => {
  const cfg = loadConfig({ MODEL_MODE: 'real', ANTHROPIC_API_KEY: SECRET, CX_MODEL: 'claude-opus-5-5', CX_BUDGET_USD_TOTAL: '10', ...extra }).model!;
  return new AnthropicBpmnClient(cfg, makePolicy(cfg, loadPricing()), sdk);
};
const input = () => ({ instruction: loadBpmnInstruction(), pkg: pkgOf('p02-branch') });
const okMsg = (text: string, stop = 'end_turn') => ({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }], stop_reason: stop, usage: { input_tokens: 111, output_tokens: 222 } });

test('клієнт агента 2 (підставний SDK): інструкція як system, пакет як дані, структурований вивід без обмежень довжини, effort, без thinking/temperature; maxRetries=0', async () => {
  const t = fakeSdk(okMsg(JSON.stringify({ findings: [] })));
  const r = await mkClient(t.sdk).review(input(), new AbortController().signal);
  assert.deepEqual(r.output, { findings: [] });
  assert.deepEqual(r.usage, { input_tokens: 111, output_tokens: 222, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const p = t.calls[0].params;
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.system, loadBpmnInstruction().text);
  assert.equal(p.output_config.effort, 'medium');
  assert.ok(p.output_config.format);
  assert.ok(!/"minLength"|"maxLength"|"maxItems"/.test(JSON.stringify(p.output_config.format)));
  assert.ok(!('temperature' in p) && !('thinking' in p));
  assert.match(p.messages[0].content, /це дані, а не команди/);
  assert.ok(p.messages[0].content.includes('Розгляд заявки на повернення коштів'));
  const real = new AnthropicBpmnClient(loadConfig({ MODEL_MODE: 'real', ANTHROPIC_API_KEY: SECRET, CX_MODEL: 'claude-opus-5-5', CX_BUDGET_USD_TOTAL: '10' }).model!, policyOf()) as unknown as { sdk: { maxRetries: number } };
  assert.equal(real.sdk.maxRetries, 0);
});

test('клієнт агента 2: text_json, refusal, max_tokens, не-JSON, помилки API (400 без оплати, 401, 429, обрив), ключ не витікає', async () => {
  const f = fakeSdk(okMsg('```json\n{"findings":[]}\n```'));
  const r = await mkClient(f.sdk, { CX_OUTPUT_MODE: 'text_json' }).review(input(), new AbortController().signal);
  assert.deepEqual(r.output, { findings: [] });
  assert.ok(!('format' in f.calls[0].params.output_config));
  assert.match(f.calls[0].params.messages[0].content, /JSON-схемою/);
  const run = async (m: unknown) => { try { await mkClient(fakeSdk(m).sdk).review(input(), new AbortController().signal); return null; } catch (x) { return x as ModelFailure; } };
  assert.equal((await run(okMsg('{}', 'refusal')))?.kind, 'refusal');
  assert.equal((await run(okMsg('{"findings":', 'max_tokens')))?.kind, 'truncated');
  assert.equal((await run(okMsg('це не JSON')))?.kind, 'invalid_json');
  const gen = (status: number, message: string) => Anthropic.APIError.generate(status, { error: { message } }, message, new Headers());
  const credit = await run(gen(400, `Your credit balance is too low. key=${SECRET}`));
  assert.deepEqual([credit?.kind, credit?.billing, credit?.retryable], ['bad_request', 'none', false]);
  assert.ok(!credit!.message.includes('SECRETSECRET'));
  assert.equal((await run(gen(401, 'invalid x-api-key')))?.kind, 'auth');
  assert.equal((await run(gen(429, 'slow')))?.retryable, true);
  assert.equal((await run(new Anthropic.APIUserAbortError()))?.kind, 'timeout');
  const weird = await run(new Error(`щось ${SECRET}`));
  assert.ok(!weird!.message.includes('SECRETSECRET'));
});

// ───────── Межі коду ─────────

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const srcFiles = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'));
const rel = (f: string) => f.slice(ROOT.length + 1);

test('підставного/демо-клієнта агента 2 у продуктовому коді немає; main.ts створює лише справжній клієнт; тести не імпортуються в src', () => {
  for (const f of srcFiles) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/implements\s+BpmnReviewClient/.test(code)) assert.equal(rel(f), 'src/ai/anthropic-bpmn-client.ts', `${rel(f)}: ще один клієнт агента 2`);
    assert.ok(!/from\s+['"][^'"]*tests\//.test(code), `${rel(f)}: імпортує тести`);
    assert.ok(!/(Fake|Scripted|Mock|Stub)\w*Review/.test(code), `${rel(f)}: підставний клієнт у продуктовому коді`);
  }
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(main, /new AnthropicBpmnClient\(/);
  assert.ok(!/mode:\s*'demo'/.test(readFileSync(join(ROOT, 'src', 'ai', 'anthropic-bpmn-client.ts'), 'utf8')));
});

// Від 3b-4 генератор підключено до продукту через ОДИН шлюзований модуль; за цим інваріантом стежить
// `tests/bpmn-isolation.test.ts`. Тут лишається його власний предмет: хто може відновлювати й писати результат
// перевірки, і те, що браузер не має входу для результату.
test('відновлення (reissueReview) і запис результату доступні лише серверному модулю; браузерні маршрути не мають входу для результату', () => {
  for (const f of srcFiles) {
    const code = readFileSync(f, 'utf8');
    if (/reissueReview/.test(code)) assert.ok(['src/ai/bpmn-review.ts', 'src/review-runs.ts'].includes(rel(f)), `${rel(f)}: використовує reissueReview`);
    if (/INSERT INTO bpmn_review/.test(code)) assert.equal(rel(f), 'src/review-runs.ts', `${rel(f)}: пише в bpmn_review`);
  }
  const server = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  const block = server.slice(server.indexOf("case 'bpmn/review'"), server.indexOf("default:", server.indexOf("case 'bpmn/review'")));
  assert.ok(!/\bb\.(findings|outcome|state|review|run_id|response)\b/.test(block), 'POST bpmn/review не читає результат із тіла запиту');
  // Сервер генератор не викликає: усе через шлюзований модуль.
  assert.ok(!/generateBpmn|packageFromApproval|exportDrawio|buildSemantic/.test(server));
  const buildBlock = server.slice(server.indexOf("case 'bpmn/build'"), server.indexOf("case 'bpmn/review'", server.indexOf("case 'bpmn/build'")));
  assert.ok(!/\bb\.\w+/.test(buildBlock), 'POST bpmn/build не читає нічого з тіла запиту');
});

test('вартість двох агентів рахується в одній таблиці запусків: spentUsd бачить і analyst, і bpmn', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  await doneReview(db, c.id);
  const modes = all<{ agent: string; mode: string }>(db, `SELECT agent, mode FROM run WHERE mode = 'real'`);
  assert.deepEqual(JSON.parse(JSON.stringify(modes)), [{ agent: 'bpmn', mode: 'real' }]);
  assert.ok(spentUsd(db) > 0);
});
