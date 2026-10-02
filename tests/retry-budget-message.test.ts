/**
 * Повтор, заблокований бюджетом: арифметика й повідомлення (D81).
 *
 * Підстава — перший справжній запуск analyst-delta-v1: спроба 1 виконана й оплачена ($0,504), відповідь
 * відхилено перевіркою, повтор не виконано (оцінка $1,77 проти ліміту $1,50). У журналі й картці при цьому
 * видно було лише бюджетне повідомлення зі словами «Запуск не виконано» — первинна причина й факт оплаченої
 * спроби губились.
 *
 * Тут перевіряється: (1) облік вартості збігається з фактом (одна спроба, без подвійного обліку);
 * (2) оцінка повтору = уже витрачене + найгірша оцінка НАСТУПНОЇ спроби; (3) повідомлення починається з
 * первинної причини, далі — блокування бюджетом, уже витрачене, і без слів «Запуск не виконано».
 * Усе — на підставному клієнті: платних викликів немає.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, run as sqlRun, type DB } from '../src/db.ts';
import { actualCostUsd, reserveRetry, spentUsd, worstCaseCostUsd } from '../src/ai/budget.ts';
import { DELTA_CONTRACT } from '../src/ai/delta.ts';
import { runAnalyst } from '../src/runs.ts';
import { headVersion, insertVersion, listSources, versionContent } from '../src/domain.ts';
import { emptyContent, type Content } from '../src/schema.ts';
import { draftReadyCase, freshDb, human } from './helpers.ts';
import { policyOf } from './review-helpers.ts';

const QUOTE = 'Менеджер приймає запит';
/** Та сама стеля виходу, що була в справжньому запуску. */
const policy48 = () => policyOf({ CX_MAX_OUTPUT_TOKENS: '48000' });

test('1. Облік вартості збігається з фактом справжнього запуску (47 485 вх. / 15 702 вих. = $0,504)', () => {
  const cost = actualCostUsd(policy48(), { input_tokens: 47_485, output_tokens: 15_702 });
  assert.equal(cost.toFixed(5), '0.50398', `очікували $0,504, отримано $${cost.toFixed(5)}`);
});

test('2. Оцінка повтору = уже витрачене + найгірша оцінка НАСТУПНОЇ спроби, без подвійного обліку', () => {
  const db = freshDb();
  const { c } = draftReadyCase(db);
  const p = policy48();
  const known = 0.50398;             // фактична вартість першої спроби
  const chars = 104_000;             // приблизний обсяг промпта того запуску
  sqlRun(db, `INSERT INTO run (id, case_id, agent, instruction_version, mode, model, input_source_ids_json, technical_state, started_at)
    VALUES ('run_t','${c.id}','analyst','test','real','m','[]','running','2026-10-02T00:00:00Z')`);
  const worst = worstCaseCostUsd(p, chars);
  try {
    reserveRetry(db, 'run_t', p, chars, known, 0);
    assert.fail('повтор мав бути заблокований');
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /BUDGET|ліміт/i);
    // У тексті мають бути ОБА числа окремо: уже витрачене й оцінка наступної спроби — тоді видно, що це сума, а не подвоєння.
    assert.ok(m.includes(known.toFixed(2)), `у повідомленні має бути вже витрачене $${known.toFixed(2)}: ${m}`);
    assert.ok(m.includes(worst.toFixed(2)), `у повідомленні має бути оцінка наступної спроби $${worst.toFixed(2)}: ${m}`);
    assert.ok(m.includes((known + worst).toFixed(2)), `у повідомленні має бути сума $${(known + worst).toFixed(2)}: ${m}`);
    assert.ok(!m.includes('Запуск не виконано'), `у повторі не можна писати «Запуск не виконано»: ${m}`);
    // Контроль арифметики: сума — це одна спроба факту плюс одна спроба оцінки, а не дві оцінки.
    assert.ok(known + worst < 2 * worst + 0.001);
  }
});

/** Кейс із версією, на яку агент відповість некоректно. */
function caseFor(db: DB) {
  const { c } = draftReadyCase(db);
  const srcId = listSources(db, c.id)[0]!.id;
  const content: Content = { ...emptyContent(), summary: 'Вхідний опис.',
    claims: [{ id: 'C1', text: 'Менеджер приймає запит.', type: 'source_fact', source_id: srcId, quote: QUOTE, scope: 'Слова менеджера.' }] };
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, c.id).id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  return { caseId: c.id, srcId, versionId: v.id, base: content };
}

/** Підставний клієнт у режимі `real`: відповідь із порушенням і відомим usage, як у справжньому запуску. */
class BadRealClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (тест, не модель)';
  calls = 0;
  constructor(private readonly srcId: string, private readonly fixOnSecond = false) {}
  async analyze(input: { baseVersion?: string }) {
    this.calls++;
    const bad = { id: 'C2', text: 'Твердження з чужою цитатою.', type: 'source_fact' as const, source_id: this.srcId, quote: 'ЦЬОГО В ДЖЕРЕЛІ НЕМАЄ', scope: '' };
    const good = { id: 'C2', text: 'Коректне твердження.', type: 'source_fact' as const, source_id: this.srcId, quote: QUOTE, scope: 'Слова менеджера.' };
    return {
      output: { contract: DELTA_CONTRACT, base_version: input.baseVersion, claims: [this.fixOnSecond && this.calls > 1 ? good : bad] },
      usage: { input_tokens: 47_485, output_tokens: 15_702 },
    };
  }
}

test('3. Повідомлення: первинна причина → повтор заблокований бюджетом → уже витрачено; без «Запуск не виконано»', async () => {
  const db = freshDb();
  const { caseId, srcId, versionId } = caseFor(db);
  const client = new BadRealClient(srcId);
  const r = await runAnalyst(db, caseId, client as never, { policy: policy48(), contract: 'delta' });
  assert.equal(r.ok, false);
  const msg = r.ok ? '' : r.error;
  const iPrimary = msg.search(/QUOTE_NOT_FOUND|не пройшла перевірку/);
  const iBudget = msg.search(/лімітом на запуск|ліміт на запуск|бюджет/);
  const iSpent = msg.search(/витрачено/);
  assert.ok(iPrimary >= 0, `первинна причина має бути в повідомленні: ${msg}`);
  assert.ok(iBudget > iPrimary, `блокування бюджетом має йти ПІСЛЯ первинної причини: ${msg}`);
  assert.ok(iSpent > iPrimary, `уже витрачене має бути назване: ${msg}`);
  assert.ok(!msg.includes('Запуск не виконано'), `перша спроба відбулась і оплачена — так писати не можна: ${msg}`);
  assert.equal(client.calls, 1, 'повторного виклику моделі не було');

  // Облік: одна спроба, її фактична вартість, резерв звільнено (без подвійного обліку).
  const row = one<{ cost_usd: number | null; reserved_usd: number; attempts: number; cost_known: number; technical_state: string }>(
    db, 'SELECT cost_usd, reserved_usd, attempts, cost_known, technical_state FROM run WHERE id = ?', r.runId)!;
  assert.equal(row.technical_state, 'error');
  assert.equal(row.attempts, 1);
  assert.equal(row.cost_known, 1);
  assert.equal(row.reserved_usd, 0, 'резерв першої спроби звільнено');
  assert.equal(row.cost_usd!.toFixed(5), '0.50398', 'списано рівно одну спробу');
  assert.equal(spentUsd(db).toFixed(5), '0.50398', 'у бюджеті враховано одну спробу, не дві');
  // Версія не змінилась.
  assert.equal(headVersion(db, caseId).id, versionId);
  assert.equal(versionContent(headVersion(db, caseId)).claims.length, 1);
  // Первинну причину видно і як перелік порушень, і в журналі спроб.
  const v = JSON.parse(one<{ violations_json: string }>(db, 'SELECT violations_json FROM run WHERE id = ?', r.runId)!.violations_json) as { code: string }[];
  assert.ok(v.some((x) => x.code === 'QUOTE_NOT_FOUND'));
  const fa = (JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', r.runId)!.checks_json) as
    { failed_attempts?: { attempt: number; message: string }[] }).failed_attempts ?? [];
  assert.equal(fa.length, 1);
  assert.match(fa[0]!.message, /QUOTE_NOT_FOUND/);
});

test('4. Контроль: якщо ліміт на запуск це дозволяє, повтор виконується (блокування не вимкнено)', async () => {
  const db = freshDb();
  const { caseId, srcId } = caseFor(db);
  const client = new BadRealClient(srcId, true);
  const r = await runAnalyst(db, caseId, client as never, { policy: policyOf({ CX_MAX_OUTPUT_TOKENS: '48000', CX_BUDGET_USD_PER_RUN: '5', CX_BUDGET_USD_TOTAL: '20' }), contract: 'delta' });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(client.calls, 2, 'друга спроба відбулась');
  const row = one<{ cost_usd: number | null; attempts: number }>(db, 'SELECT cost_usd, attempts FROM run WHERE id = ?', r.runId)!;
  assert.equal(row.attempts, 2);
  assert.equal(row.cost_usd!.toFixed(5), (2 * 0.50398).toFixed(5), 'оплачено дві спроби — рівно стільки, скільки виконано');
});
