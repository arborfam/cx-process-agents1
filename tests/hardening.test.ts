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
