import { z } from 'zod';
import { all, one, run, tx, type DB } from '../db.ts';
import { ContentSchema } from '../schema.ts';
import { DomainError } from '../errors.ts';
import type { Effort, ModelConfig, Pricing } from '../config.ts';
import type { Usage } from './types.ts';

export interface ModelPolicy {
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  timeoutMs: number;
  maxInputChars: number;
  budgetTotalUsd: number;
  budgetPerRunUsd: number;
  maxRunsPerCase: number;
  maxRunsPerDay: number;
  price: { input: number; output: number; cache_read: number };
  pricingVerifiedAt: string;
}

export function makePolicy(cfg: ModelConfig, pricing: Pricing): ModelPolicy {
  const price = pricing.models[cfg.model];
  if (!price) throw new Error(`Немає ціни для моделі ${cfg.model}`);
  return {
    model: cfg.model, effort: cfg.effort, maxOutputTokens: cfg.maxOutputTokens, timeoutMs: cfg.timeoutMs, maxInputChars: cfg.maxInputChars,
    budgetTotalUsd: cfg.budgetTotalUsd, budgetPerRunUsd: cfg.budgetPerRunUsd, maxRunsPerCase: cfg.maxRunsPerCase, maxRunsPerDay: cfg.maxRunsPerDay,
    price, pricingVerifiedAt: pricing.verified_at,
  };
}

/**
 * ОЦІНКА, а не гарантована межа: для кирилиці беремо ~1.8 символа на токен і додаємо запас 25 %. Реальна токенізація
 * може відрізнятись, тому фактична вартість береться з usage відповіді; якщо вона перевищила резерв, обліковується фактична.
 * Вихід обмежено max_tokens (разом із міркуваннями) — це єдина жорстка межа. До входу входить УСЕ: інструкція,
 * повідомлення з джерелами й схема відповіді (structured output додає схему до запиту; у text_json вона в тексті).
 */
export const CHARS_PER_TOKEN = 1.8;
export const INPUT_MARGIN = 1.25;
let schemaCharsCache: number | null = null;
/** Розмір JSON-схеми відповіді в символах (береться з тієї самої схеми, що йде в API). */
export function schemaChars(): number {
  if (schemaCharsCache === null) schemaCharsCache = JSON.stringify(z.toJSONSchema(ContentSchema)).length;
  return schemaCharsCache;
}
/** `schemaLen` — розмір JSON-схеми відповіді саме цього агента (за замовчуванням — агента 1); бюджет спільний, оцінка — для кожного агента своя. */
export const estimateInputTokens = (chars: number, schemaLen: number = schemaChars()) => Math.ceil(((chars + schemaLen) / CHARS_PER_TOKEN) * INPUT_MARGIN);

export function worstCaseCostUsd(p: ModelPolicy, promptChars: number, schemaLen?: number): number {
  return (estimateInputTokens(promptChars, schemaLen) * p.price.input + p.maxOutputTokens * p.price.output) / 1e6;
}

export function actualCostUsd(p: ModelPolicy, u: Usage): number {
  const fresh = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25;
  return (fresh * p.price.input + (u.cache_read_input_tokens ?? 0) * p.price.cache_read + u.output_tokens * p.price.output) / 1e6;
}

/**
 * Витрачено + зарезервовано. Для кожного запуску: відома вартість (cost_usd) + резерв (reserved_usd).
 * Активний запуск тримає резерв найгіршого випадку; запуск із невідомою вартістю (cost_usd = NULL, cost_known = 0)
 * тримає консервативний резерв назавжди — він зберігається в базі й переживає перезапуск.
 */
export function spentUsd(db: DB, excludeRunId?: string): number {
  return one<{ s: number | null }>(db,
    `SELECT SUM(COALESCE(cost_usd, 0) + reserved_usd) AS s FROM run WHERE mode = 'real' AND id <> ?`, excludeRunId ?? '')?.s ?? 0;
}

export function budgetLeftUsd(db: DB, p: ModelPolicy): number {
  return Math.max(0, p.budgetTotalUsd - spentUsd(db));
}

export function unknownCostRuns(db: DB): number {
  return one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM run WHERE mode = 'real' AND cost_known = 0`)?.n ?? 0;
}

function checkMoney(db: DB, p: ModelPolicy, worst: number, alreadyUsd: number, excludeRunId?: string): void {
  if (alreadyUsd + worst > p.budgetPerRunUsd) {
    throw new DomainError('BUDGET_PER_RUN', `Найгірша оцінка вартості запуску $${(alreadyUsd + worst).toFixed(2)} перевищує ліміт на запуск $${p.budgetPerRunUsd.toFixed(2)}. Запуск не виконано.`, 429);
  }
  const spent = spentUsd(db, excludeRunId);
  if (spent + alreadyUsd + worst > p.budgetTotalUsd + 1e-12) {
    throw new DomainError('BUDGET_TOTAL', `Запуск може коштувати до $${worst.toFixed(2)} (оцінка), а вільно $${Math.max(0, p.budgetTotalUsd - spent - alreadyUsd).toFixed(2)}: витрачено й зарезервовано $${spent.toFixed(2)} із $${p.budgetTotalUsd.toFixed(2)} (враховано активні запуски й запуски з невідомою вартістю). Запуск не виконано.`, 429);
  }
}

/**
 * Перевірка до першого виклику. Викликати ВСЕРЕДИНІ тієї самої транзакції, що створює запис запуску з резервом
 * (beginAnalystRun), — тоді перевірка й резервування атомарні: паралельні запуски не можуть разом перевищити бюджет.
 */
export function preflight(db: DB, caseId: string, p: ModelPolicy, promptChars: number, now = new Date(), schemaLen?: number): { worstCaseUsd: number } {
  if (promptChars > p.maxInputChars) {
    throw new DomainError('INPUT_TOO_LARGE', `Обсяг джерел (${promptChars} символів) перевищує ліміт ${p.maxInputChars}. Запуск не виконано, витрат немає.`, 413);
  }
  checkRunCounts(db, caseId, p, now);
  const worst = worstCaseCostUsd(p, promptChars, schemaLen);
  checkMoney(db, p, worst, 0);
  return { worstCaseUsd: worst };
}

/**
 * Резервування під повторну спробу (атомарно). known — відома вартість попередніх спроб, unknownReserve — резерв спроб
 * із невідомою вартістю. Після успіху в записі запуску: cost_usd = known, reserved_usd = unknownReserve + найгірша оцінка нової спроби.
 */
export function reserveRetry(db: DB, runId: string, p: ModelPolicy, promptChars: number, known: number, unknownReserve: number, schemaLen?: number): number {
  return tx(db, () => {
    if (promptChars > p.maxInputChars) throw new DomainError('INPUT_TOO_LARGE', 'Обсяг запиту перевищує ліміт.', 413);
    const worst = worstCaseCostUsd(p, promptChars, schemaLen);
    checkMoney(db, p, worst, known + unknownReserve, runId);
    run(db, `UPDATE run SET cost_usd = ?, reserved_usd = ? WHERE id = ?`, known, unknownReserve + worst, runId);
    return worst;
  });
}

function checkRunCounts(db: DB, caseId: string, p: ModelPolicy, now: Date): void {
  const perCase = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM run WHERE case_id = ? AND mode = 'real'`, caseId)?.n ?? 0;
  if (perCase >= p.maxRunsPerCase) {
    throw new DomainError('RUN_LIMIT_CASE', `Досягнуто ліміт запусків моделі для цього кейсу (${p.maxRunsPerCase}). Збільште CX_MAX_RUNS_PER_CASE свідомо або продовжіть вручну.`, 429);
  }
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const perDay = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM run WHERE mode = 'real' AND started_at >= ?`, dayStart)?.n ?? 0;
  if (perDay >= p.maxRunsPerDay) {
    throw new DomainError('RUN_LIMIT_DAY', `Досягнуто добовий ліміт запусків моделі (${p.maxRunsPerDay}).`, 429);
  }
}

export function usageSummary(db: DB, caseId: string) {
  return all<{ id: string; cost_usd: number | null }>(db, 'SELECT id, cost_usd FROM run WHERE case_id = ?', caseId);
}
