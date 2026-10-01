import { all, one, type DB } from '../db.ts';
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

/** Для кирилиці беремо запас: ~1.8 символа на токен (реально 1.8–2.5). Оцінка завищує вхід, щоб не недооцінити витрати. */
export const CHARS_PER_TOKEN = 1.8;
export const estimateInputTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

export function worstCaseCostUsd(p: ModelPolicy, promptChars: number): number {
  return (estimateInputTokens(promptChars) * p.price.input + p.maxOutputTokens * p.price.output) / 1e6;
}

export function actualCostUsd(p: ModelPolicy, u: Usage): number {
  const fresh = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25;
  return (fresh * p.price.input + (u.cache_read_input_tokens ?? 0) * p.price.cache_read + u.output_tokens * p.price.output) / 1e6;
}

export function spentUsd(db: DB): number {
  return one<{ s: number | null }>(db, `SELECT SUM(cost_usd) AS s FROM run WHERE mode = 'real'`)?.s ?? 0;
}

export function budgetLeftUsd(db: DB, p: ModelPolicy): number {
  return Math.max(0, p.budgetTotalUsd - spentUsd(db));
}

/** Перевірка до виклику (і до повторної спроби). Нічого не відправляє й не записує. */
export function preflight(db: DB, caseId: string, p: ModelPolicy, promptChars: number, now = new Date(), retry?: { alreadyUsd: number }): { worstCaseUsd: number } {
  if (promptChars > p.maxInputChars) {
    throw new DomainError('INPUT_TOO_LARGE', `Обсяг джерел (${promptChars} символів) перевищує ліміт ${p.maxInputChars}. Запуск не виконано, витрат немає.`, 413);
  }
  if (!retry) checkRunCounts(db, caseId, p, now);
  const worst = worstCaseCostUsd(p, promptChars);
  if (worst + (retry?.alreadyUsd ?? 0) > p.budgetPerRunUsd) {
    throw new DomainError('BUDGET_PER_RUN', `Найгірша оцінка вартості запуску $${worst.toFixed(2)} перевищує ліміт на запуск $${p.budgetPerRunUsd.toFixed(2)}. Запуск не виконано.`, 429);
  }
  const left = budgetLeftUsd(db, p);
  if (worst > left) {
    throw new DomainError('BUDGET_TOTAL', `Запуск може коштувати до $${worst.toFixed(2)}, а залишок бюджету $${left.toFixed(2)} (витрачено $${spentUsd(db).toFixed(2)} із $${p.budgetTotalUsd.toFixed(2)}). Запуск не виконано.`, 429);
  }
  return { worstCaseUsd: worst };
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
