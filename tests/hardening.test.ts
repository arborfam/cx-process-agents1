/** Перевірки за результатами незалежної перевірки: резервування бюджету, невідома вартість, цитати, пропозиції вилучення кроків. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb } from '../src/db.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import { makePolicy, spentUsd, worstCaseCostUsd } from '../src/ai/budget.ts';
import { findQuote } from '../src/ai/quote.ts';
import { ModelFailure, type AnalystClient, type ModelCallResult } from '../src/ai/types.ts';
import { beginAnalystRun, executeAnalystRun, recoverStuckRuns, runAnalyst } from '../src/runs.ts';
import { newCase, tempDbPath } from './helpers.ts';

const KEY = 'sk-ant-api03-TESTTESTTESTTEST123456';
const policyFor = (extra: Record<string, string>) =>
  makePolicy(loadConfig({ MODEL_MODE: 'real', ANTHROPIC_API_KEY: KEY, CX_MODEL: 'claude-opus-5-5', CX_BUDGET_USD_TOTAL: '15', ...extra }).model!, loadPricing());
const hang = (): AnalystClient => ({ mode: 'real', model: 'claude-opus-5-5', analyze: () => new Promise<ModelCallResult>(() => {}) });
const codeOf = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

// ─────────── 1. Резервування бюджету ───────────
test('1. Бюджет $0,90: другий паралельний запуск іншого кейсу відхиляється — перший резервує кошти', () => {
  const db = openDb(tempDbPath());
  const p = policyFor({ CX_BUDGET_USD_TOTAL: '0.90' });
  const a = newCase(db, 'А'), b = newCase(db, 'Б');
  const first = beginAnalystRun(db, a.id, hang(), { policy: p });
  assert.ok(first.runId);
  assert.ok(spentUsd(db) > 0.6, 'активний запуск зарезервував кошти: ' + spentUsd(db));
  assert.equal(codeOf(() => beginAnalystRun(db, b.id, hang(), { policy: p })), 'BUDGET_TOTAL');
  assert.equal(all(db, `SELECT id FROM run WHERE case_id = ?`, b.id).length, 0, 'відхилений запуск не створює запису');
  // після завершення резерв замінюється фактичною вартістю й звільняє бюджет
  db.prepare(`UPDATE run SET technical_state = 'error' WHERE id = ?`).run(first.runId);
});

test('1б. Багато паралельних запусків: сума резервів ніколи не перевищує бюджет', () => {
  const db = openDb(tempDbPath());
  const p = policyFor({ CX_BUDGET_USD_TOTAL: '2' });
  let started = 0;
  for (let i = 0; i < 8; i++) {
    const c = newCase(db, 'К' + i);
    try { beginAnalystRun(db, c.id, hang(), { policy: p }); started++; } catch (e) { assert.equal((e as { code: string }).code, 'BUDGET_TOTAL'); }
  }
  assert.ok(started >= 1 && started < 8, 'запущено ' + started + ' із 8; решту відхилено');
  assert.ok(spentUsd(db) <= 2 + 1e-9);
});

test('1в. Повтор також резервується: якщо під час першої спроби хтось інший зайняв бюджет, повтор не виконується', async () => {
  const db = openDb(tempDbPath());
  const p = policyFor({ CX_BUDGET_USD_TOTAL: '1.5', CX_BUDGET_USD_PER_RUN: '1.4' });
  const a = newCase(db, 'А'), b = newCase(db, 'Б');
  let calls = 0;
  const client: AnalystClient = {
    mode: 'real', model: 'claude-opus-5-5',
    analyze: async () => {
      calls++;
      // поки триває перша спроба, паралельний запуск іншого кейсу намагається взяти залишок
      if (calls === 1) { try { beginAnalystRun(db, b.id, hang(), { policy: p }); } catch { /* очікувано можливо */ } }
      throw new ModelFailure('transient', 'збій', { input_tokens: 100, output_tokens: 10 });
    },
  };
  const ctx = beginAnalystRun(db, a.id, client, { policy: p });
  const res = await executeAnalystRun(db, ctx, client, { policy: p });
  assert.equal(res.ok, false);
  const total = spentUsd(db);
  assert.ok(total <= 1.5 + 1e-9, 'бюджет не перевищено: ' + total);
  assert.ok(calls <= 2);
});

test('1г. Резерв активного запуску видно в бюджеті; завершений запуск віддає невикористане', async () => {
  const db = openDb(tempDbPath());
  const p = policyFor({});
  const c = newCase(db, 'К');
  const client: AnalystClient = { mode: 'real', model: 'claude-opus-5-5', analyze: async (i) => ({ output: i.head_content, usage: { input_tokens: 1000, output_tokens: 1000 } }) };
  const ctx = beginAnalystRun(db, c.id, client, { policy: p });
  const during = spentUsd(db);
  assert.ok(during > 0.5);
  const r = await executeAnalystRun(db, ctx, client, { policy: p });
  assert.ok(r.ok);
  const after = spentUsd(db);
  assert.ok(after < 0.05, 'після завершення — лише фактична вартість: ' + after);
  assert.equal(one<{ reserved_usd: number }>(db, 'SELECT reserved_usd FROM run')!.reserved_usd, 0);
});

// ─────────── 2. Невідома вартість ───────────
test('2. Тайм-аут без usage: вартість явно невідома (NULL), консервативний резерв лишається й після перезапуску', async () => {
  const path = tempDbPath();
  let db = openDb(path);
  const p = policyFor({});
  const c = newCase(db, 'К');
  const client: AnalystClient = { mode: 'real', model: 'claude-opus-5-5', analyze: async () => { throw new ModelFailure('timeout', 'тайм-аут'); } };
  const r = await runAnalyst(db, c.id, client, { policy: p });
  assert.equal(r.ok, false);
  let row = one<{ cost_usd: number | null; reserved_usd: number; cost_known: number }>(db, 'SELECT cost_usd, reserved_usd, cost_known FROM run')!;
  assert.equal(row.cost_known, 0);
  assert.equal(row.cost_usd, null, 'невідома вартість — NULL, а не 0');
  assert.ok(row.reserved_usd > 0.5, 'резерв: ' + row.reserved_usd);
  const before = spentUsd(db);
  assert.ok(before >= row.reserved_usd);
  db.close();
  db = openDb(path);
  assert.equal(spentUsd(db), before, 'після перезапуску резерв не зник');
  // повторне відкриття не звільняє резерв
  recoverStuckRuns(db);
  assert.equal(spentUsd(db), before);
  db.close();
});

test('2б. Перезапуск під час активного запуску: застряглий запуск лишає резерв (вартість невідома)', () => {
  const path = tempDbPath();
  let db = openDb(path);
  const c = newCase(db, 'К');
  beginAnalystRun(db, c.id, hang(), { policy: policyFor({}) });
  const reserved = spentUsd(db);
  db.close();
  db = openDb(path);
  assert.equal(recoverStuckRuns(db), 1);
  const row = one<{ cost_known: number; technical_state: string; reserved_usd: number }>(db, 'SELECT * FROM run')!;
  assert.equal(row.technical_state, 'error');
  assert.equal(row.cost_known, 0);
  assert.equal(spentUsd(db), reserved, 'резерв збережено');
});

test('2в. Помилки до генерації (401/400) — вартість відома й нульова; відомий usage замінює резерв', async () => {
  const db = openDb(tempDbPath());
  const p = policyFor({});
  const c = newCase(db, 'К');
  const auth: AnalystClient = { mode: 'real', model: 'claude-opus-5-5', analyze: async () => { throw new ModelFailure('auth', 'ключ відхилено', undefined, 'none'); } };
  await runAnalyst(db, c.id, auth, { policy: p });
  const row = one<{ cost_usd: number | null; cost_known: number; reserved_usd: number }>(db, 'SELECT * FROM run')!;
  assert.equal(row.cost_known, 1);
  assert.equal(row.cost_usd, 0);
  assert.equal(row.reserved_usd, 0);
  assert.equal(spentUsd(db), 0);
});

test('2г. Оцінка входу враховує інструкцію, запит і схему відповіді, має запас і не називається гарантованою межею', () => {
  const p = policyFor({});
  const small = worstCaseCostUsd(p, 1000);
  assert.ok(small > 0.64, 'вихід за максимумом + схема й запас на вхід');
  // схема відповіді враховується: оцінка без схеми була б меншою
  assert.ok(worstCaseCostUsd(p, 1000) > (Math.ceil(1000 / 1.8) * p.price.input + p.maxOutputTokens * p.price.output) / 1e6);
});

// ─────────── 3. Цитати ───────────
test('3. Вигаданий короткий фрагмент із «…» не приймається; законні скорочення позначаються окремо', () => {
  const src = 'Повідомлення опубліковано.';
  assert.equal(findQuote(src, 'НЕ БУЛО … Повідомлення опубліковано.').kind, 'not_found');
  assert.equal(findQuote(src, 'НЕ БУЛО ... Повідомлення опубліковано.').kind, 'not_found');
  assert.equal(findQuote(src, 'Повідомлення … опубліковано.').kind, 'elided');
  assert.equal(findQuote(src, '… опубліковано.').kind, 'elided');
  const long = 'Так. Ні, не було. Повідомлення опубліковано.';
  assert.equal(findQuote(long, 'Так … опубліковано.').kind, 'elided', 'короткі непорожні частини теж перевіряються, а не відкидаються');
  assert.equal(findQuote(long, 'Ні … Так').kind, 'not_found', 'порядок частин має збігатися');
  assert.equal(findQuote(long, '…').kind, 'not_found');
});

// ─────────── 4. Пропозиції вилучення/заміни кроків ───────────
import { acceptDraft, approve, bpmnGuard, buildCard, currentApproval, decideStepProposal, getCase, getVersion, headVersion, saveAnalystVersion, submissionBlockers, submitForApproval, verifyVersionIntegrity, versionContent } from '../src/domain.ts';
import { verifyAgentOutput } from '../src/ai/verify.ts';
import { ScriptedDemoClient } from '../src/runs.ts';
import { UNKNOWN, type Content, type StepProposalT } from '../src/schema.ts';
import { addSource } from '../src/domain.ts';
import { COMPLETE_FIELDS, agent, freshDb, human, startTestServer } from './helpers.ts';

const SRC_TEXT = 'Менеджер приймає запит. Оператор вносить зміну. Перевірка керівником не існує.';
const PLAN_FIELDS = {
  ...COMPLETE_FIELDS,
  roles_text: 'Менеджер\nОператор',
  steps_text: [
    'S1 | Менеджер | Приймає запит | Заявка в CRM | S2',
    'S2 | Оператор | Вносить зміну | Умови оновлено | S3',
    'S3 | Оператор | Передає на перевірку керівнику | Перевірено | END',
    'S4 | Оператор | Повідомляє клієнта | Клієнта повідомлено | END',
  ].join('\n'),
};
function setup(approved = false) {
  const db = freshDb();
  const c = newCase(db, 'К');
  const src = addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю', content: SRC_TEXT, origin: 'synthetic' });
  const fields = approved ? { ...PLAN_FIELDS, steps_text: PLAN_FIELDS.steps_text.split('\n').slice(0, 3).join('\n') } : PLAN_FIELDS; // для погодженого — без недосяжного S4
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields, coverAllSources: true });
  if (approved) { acceptDraft(db, human, c.id, v.id); submitForApproval(db, human, c.id); approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true }); }
  return { db, c, src, v };
}
const prop = (srcId: string, extra: Partial<StepProposalT> = {}): StepProposalT => ({
  id: 'SP1', action: 'remove', step_id: 'S3', replacement_step_id: '', reason: 'Джерело каже, що перевірки керівником немає',
  evidence_source_id: srcId, evidence_quote: 'Перевірка керівником не існує.', status: 'proposed', decided_by: '', decision_note: '', ...extra,
});
const withProps = (c: Content, ...ps: StepProposalT[]): Content => ({ ...structuredClone(c), step_proposals: ps });
const violationCodes = (raw: Content, base: Content, srcId: string) => {
  const r = verifyAgentOutput(raw, { base, sources: [{ id: srcId, text: SRC_TEXT }], fromModel: (x) => x });
  return r.ok ? [] : r.violations.map((x) => x.code);
};

test('4a. Відтворення: прибрати крок у відповіді агента прямо не можна — DELETED_ITEMS; прийнятний шлях — явна пропозиція', async () => {
  const { db, c, src } = setup();
  const base = versionContent(headVersion(db, c.id));
  const direct = structuredClone(base); direct.steps = direct.steps.filter((s) => s.id !== 'S3');
  direct.steps.find((s) => s.id === 'S2')!.next = [{ to: 'END', condition: '' }];
  assert.ok(violationCodes(direct, base, src.id).includes('DELETED_ITEMS'), 'пряме видалення відхиляється');
  const res = await runAnalyst(db, c.id, new ScriptedDemoClient(() => direct));
  assert.equal(res.ok, false);
  assert.ok(versionContent(headVersion(db, c.id)).steps.some((s) => s.id === 'S3'), 'крок лишився');
  // пропозиція — приймається
  const ok = await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(base, prop(src.id))));
  assert.ok(ok.ok, ok.ok ? '' : (ok as { error: string }).error);
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  assert.ok(content.steps.some((s) => s.id === 'S3'), 'пропозиція не вилучає крок сама');
  assert.equal(content.step_proposals![0]!.status, 'proposed');
  const card = buildCard(db, c.id, 'demo');
  assert.equal(card.step_proposals[0]!.step_exists, true);
  assert.equal(card.step_proposals[0]!.evidence_check, 'quote_found');
  assert.ok(card.changes.some((x) => x.label === 'Пропозиція' && /вилучити крок S3/.test(x.text)));
  // доки рішення немає — прогалина, передача на погодження неможлива
  assert.ok(submissionBlockers(db, c.id).some((b) => b.code === 'PENDING_STEP_PROPOSAL' && b.severity === 'critical'));
  assert.ok(card.gap_items.some((g) => g.codes.includes('PENDING_STEP_PROPOSAL')));
  acceptDraft(db, human, c.id, head.id);
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED');
});

test('4б. Пропозиція без причини, доказу, з вигаданою цитатою, хибним кроком, самостійним рішенням чи дублем відхиляється', () => {
  const { db, c, src } = setup();
  const base = versionContent(headVersion(db, c.id));
  const codes = (...ps: StepProposalT[]) => violationCodes(withProps(base, ...ps), base, src.id);
  assert.ok(codes(prop(src.id, { reason: '  ' })).includes('PROPOSAL_NO_REASON'));
  assert.ok(codes(prop(src.id, { evidence_quote: '' })).includes('PROPOSAL_NO_EVIDENCE'));
  assert.ok(codes(prop('', {})).includes('PROPOSAL_NO_EVIDENCE'));
  assert.ok(codes(prop(src.id, { evidence_quote: 'НЕ БУЛО … Перевірка керівником не існує.' })).includes('QUOTE_NOT_FOUND'), 'вигадана цитата');
  assert.ok(codes(prop('SRC-404')).includes('UNKNOWN_SOURCE'));
  assert.ok(codes(prop(src.id, { step_id: 'S9' })).includes('PROPOSAL_BAD_STEP'));
  assert.ok(codes(prop(src.id, { action: 'replace', replacement_step_id: '' })).includes('PROPOSAL_BAD_REPLACEMENT'));
  assert.ok(codes(prop(src.id, { action: 'replace', replacement_step_id: 'S3' })).includes('PROPOSAL_BAD_REPLACEMENT'));
  assert.ok(codes(prop(src.id, { action: 'replace', replacement_step_id: 'S99' })).includes('PROPOSAL_BAD_REPLACEMENT'));
  assert.ok(codes(prop(src.id, { replacement_step_id: 'S4' })).includes('PROPOSAL_BAD_REPLACEMENT'));
  assert.ok(codes(prop(src.id, { status: 'accepted' })).includes('AGENT_CANNOT_DECIDE'));
  assert.ok(codes(prop(src.id, { decided_by: 'analyst-agent' })).includes('AGENT_CANNOT_DECIDE'));
  assert.ok(codes(prop(src.id), prop(src.id, { id: 'SP2' })).includes('DUPLICATE_PROPOSAL'));
  assert.deepEqual(codes(prop(src.id)), [], 'коректна пропозиція проходить');
  assert.deepEqual(codes(prop(src.id, { action: 'replace', replacement_step_id: 'S4' })), []);
});

test('4в. Прийняття вилучення: нова версія, старі збережено; переходи на вилучений крок стають «невідомо» з питанням; погодження скасовано й перевіряється заново', async () => {
  const { db, c, src, v } = setup(true);
  assert.ok(currentApproval(db, c.id));
  await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(versionContent(headVersion(db, c.id)), prop(src.id))));
  const withP = headVersion(db, c.id);
  assert.equal(getCase(db, c.id).state, 'research', 'агент змінив зміст — погодження не діє');
  assert.throws(() => decideStepProposal(db, agent, c.id, { baseVersionId: withP.id, proposalId: 'SP1', decision: 'accept' }), (e: any) => /людин|Агент/i.test(e.message) || e.code);
  assert.throws(() => decideStepProposal(db, human, c.id, { baseVersionId: v.id, proposalId: 'SP1', decision: 'accept' }), (e: any) => e.code === 'VERSION_CONFLICT');
  assert.throws(() => decideStepProposal(db, human, c.id, { baseVersionId: withP.id, proposalId: 'SPX', decision: 'accept' }), (e: any) => e.code === 'NOT_FOUND');

  const nv = decideStepProposal(db, human, c.id, { baseVersionId: withP.id, proposalId: 'SP1', decision: 'accept', note: 'Підтверджую' });
  const nc = versionContent(nv);
  assert.ok(!nc.steps.some((s) => s.id === 'S3'), 'крок вилучено в НОВІЙ версії');
  assert.equal(nc.step_proposals![0]!.status, 'accepted');
  assert.equal(nc.step_proposals![0]!.decided_by, 'Аналітикиня');
  assert.equal(nc.step_proposals![0]!.decision_note, 'Підтверджую');
  assert.equal(nv.created_by, 'analyst');
  // старі версії незмінні й цілісні
  for (const id of [v.id, withP.id]) assert.ok(verifyVersionIntegrity(db, id));
  assert.ok(versionContent(getVersion(db, v.id)).steps.some((s) => s.id === 'S3'), 'стара версія зберігає крок');
  // переходи перевіряються заново
  assert.equal(nc.steps.find((s) => s.id === 'S2')!.next[0]!.to, UNKNOWN);
  const q = nc.questions.find((x) => x.affects_transitions?.some((a) => a.step_id === 'S2'))!;
  assert.ok(q && q.critical && q.status === 'open');
  const codes = submissionBlockers(db, c.id).filter((b) => b.severity === 'critical').map((b) => b.code);
  assert.ok(codes.includes('UNRESOLVED_TRANSITION') && codes.includes('CRITICAL_QUESTION'), codes.join());
  assert.ok(!codes.includes('PENDING_STEP_PROPOSAL'));
  assert.equal(bpmnGuard(db, c.id).ok, false);
  assert.equal(getCase(db, c.id).state, 'research');
  assert.throws(() => decideStepProposal(db, human, c.id, { baseVersionId: nv.id, proposalId: 'SP1', decision: 'accept' }), (e: any) => e.code === 'PROPOSAL_NOT_PENDING');
});

test('4г. Прийняття заміни: переходи переходять на крок-заміну; вона стає «власністю» аналітикині', async () => {
  const { db, c, src } = setup();
  await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(versionContent(headVersion(db, c.id)), prop(src.id, { action: 'replace', replacement_step_id: 'S4' }))));
  const nv = decideStepProposal(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, proposalId: 'SP1', decision: 'accept' });
  const nc = versionContent(nv);
  assert.ok(!nc.steps.some((s) => s.id === 'S3'));
  assert.equal(nc.steps.find((s) => s.id === 'S2')!.next[0]!.to, 'S4', 'перехід перенаправлено на заміну');
  assert.ok(!nc.questions.some((q) => /після вилучення/.test(q.text)), 'питання не потрібне: заміна відома');
  assert.ok((JSON.parse(nv.owned_json) as string[]).includes('step:S2'));
  // агент не може повернути вилучений крок: це власність аналітикині
  const back = structuredClone(nc);
  back.steps.push({ id: 'S3', role: 'Оператор', action: 'Повернений агентом', entry_condition: '', input_artifact: '', result: 'х', next: [{ to: 'END', condition: '' }], source_ids: [] });
  const r = await runAnalyst(db, c.id, new ScriptedDemoClient(() => back));
  assert.ok(r.ok);
  assert.ok(!versionContent(headVersion(db, c.id)).steps.some((s) => s.id === 'S3'), 'захист правок аналітика зберігся');
  assert.ok(versionContent(headVersion(db, c.id)).conflicts.some((x) => x.key === 'step:S3'));
});

test('4д. Початковий крок, що вилучається, знімається (без заміни) — прогалина ENTRY_MISSING', async () => {
  const { db, c, src } = setup();
  const h = headVersion(db, c.id);
  const cur = versionContent(h);
  assert.equal(cur.entry_step_id, 'S1');
  await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(cur, prop(src.id, { step_id: 'S1', reason: 'тест', evidence_quote: 'Менеджер приймає запит.' }))));
  const nv = decideStepProposal(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, proposalId: 'SP1', decision: 'accept' });
  assert.equal(versionContent(nv).entry_step_id, null);
  assert.ok(submissionBlockers(db, c.id).some((b) => b.code === 'ENTRY_MISSING' || b.code === 'ENTRY_BAD_REF'));
});

test('4е. Відхилення: крок лишається; агент не може змінити рішення чи прибрати пропозицію (конфлікт показано)', async () => {
  const { db, c, src } = setup();
  await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(versionContent(headVersion(db, c.id)), prop(src.id))));
  const rejected = decideStepProposal(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, proposalId: 'SP1', decision: 'reject', note: 'Крок усе ж є' });
  assert.ok(versionContent(rejected).steps.some((s) => s.id === 'S3'));
  assert.equal(versionContent(rejected).step_proposals![0]!.status, 'rejected');
  assert.ok(!submissionBlockers(db, c.id).some((b) => b.code === 'PENDING_STEP_PROPOSAL'));
  // агент пробує «воскресити» пропозицію зі статусом accepted, а потім прибрати її
  const tamper = structuredClone(versionContent(rejected)); tamper.step_proposals![0]!.status = 'accepted';
  const r1 = await runAnalyst(db, c.id, new ScriptedDemoClient(() => tamper));
  assert.ok(r1.ok);
  assert.equal(versionContent(headVersion(db, c.id)).step_proposals![0]!.status, 'rejected', 'рішення аналітикині збережено');
  const dropped = structuredClone(versionContent(headVersion(db, c.id))); delete dropped.step_proposals;
  const r2 = await runAnalyst(db, c.id, new ScriptedDemoClient(() => dropped));
  assert.ok(r2.ok);
  assert.equal(versionContent(headVersion(db, c.id)).step_proposals!.length, 1);
  assert.ok(versionContent(headVersion(db, c.id)).conflicts.some((x) => x.key === 'proposal:SP1'));
});

test('4є. Крок, який редагувала аналітикиня: пропозиція не змінює його; на картці є позначка', async () => {
  const { db, c, src } = setup();
  const edited = PLAN_FIELDS.steps_text.replace('Передає на перевірку керівнику', 'Передає на перевірку (правка аналітикині)');
  saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: { steps_text: edited } });
  const before = versionContent(headVersion(db, c.id)).steps.find((s) => s.id === 'S3')!;
  await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(versionContent(headVersion(db, c.id)), prop(src.id))));
  assert.deepEqual(versionContent(headVersion(db, c.id)).steps.find((s) => s.id === 'S3'), before);
  assert.equal(buildCard(db, c.id, 'demo').step_proposals[0]!.step_analyst_edited, true);
});

test('4ж. HTTP: рішення за пропозицією — лише через людський ендпоінт, з перевіркою версії', async () => {
  const { db, c, src } = setup();
  await runAnalyst(db, c.id, new ScriptedDemoClient(() => withProps(versionContent(headVersion(db, c.id)), prop(src.id))));
  const s = await startTestServer(db);
  try {
    const head = headVersion(db, c.id).id;
    assert.equal((await s.call('POST', `/api/cases/${c.id}/step-proposals/decide`, { base_version_id: head, proposal_id: 'SP1', decision: 'accept' }, { auth: false })).status, 401);
    assert.equal((await s.call('POST', `/api/cases/${c.id}/step-proposals/decide`, { base_version_id: head, proposal_id: 'SP1', decision: 'maybe' })).status, 400);
    const r = await s.call('POST', `/api/cases/${c.id}/step-proposals/decide`, { base_version_id: head, proposal_id: 'SP1', decision: 'accept', note: 'ок' });
    assert.equal(r.status, 201);
    const card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.equal(card.step_proposals[0].status, 'accepted');
    assert.ok(!card.head.content.steps.some((x: any) => x.id === 'S3'));
  } finally { await s.close(); }
});
