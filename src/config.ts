import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputContract } from './ai/types.ts';

export type ModelMode = 'demo' | 'real';
export type OutputMode = 'structured' | 'text_json';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type { OutputContract } from './ai/types.ts';

/** Налаштування справжньої моделі. Усі обмеження обов’язкові: без них платні запуски не вмикаються. */
export interface ModelConfig {
  apiKey: string;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  timeoutMs: number;
  maxInputChars: number;
  outputMode: OutputMode;
  /** Контракт відповіді агента 1 (D80): `delta` — лише нові й змінені елементи, `full` — повна версія щоразу. */
  outputContract: OutputContract;
  budgetTotalUsd: number;
  budgetPerRunUsd: number;
  maxRunsPerCase: number;
  maxRunsPerDay: number;
}

export interface AppConfig {
  mode: ModelMode;
  port: number;
  dbPath: string;
  /** Є лише в режимі real і лише на сервері. */
  model?: ModelConfig;
}

export interface Pricing {
  verified_at: string;
  source: string;
  models: Record<string, { input: number; output: number; cache_read: number }>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadPricing(path = join(ROOT, 'config', 'model-pricing.json')): Pricing {
  return JSON.parse(readFileSync(path, 'utf8')) as Pricing;
}

const num = (env: Record<string, string | undefined>, key: string, dflt: number | undefined, problems: string[], opts: { int?: boolean } = {}): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    if (dflt === undefined) { problems.push(`${key} не задано (обов’язково)`); return 0; }
    return dflt;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || (opts.int && !Number.isInteger(v))) {
    problems.push(`${key} має бути додатним ${opts.int ? 'цілим ' : ''}числом, отримано: ${raw}`);
    return 0;
  }
  return v;
};

/**
 * Читає налаштування. Мовчазного переходу з real на demo немає: якщо режим real
 * налаштовано не повністю, застосунок не стартує й перелічує, чого бракує.
 * Значення ключа ніколи не потрапляє в повідомлення про помилку.
 */
export function loadConfig(env: Record<string, string | undefined>, pricing: Pricing = loadPricing()): AppConfig {
  const mode = (env.MODEL_MODE ?? 'demo') as string;
  if (mode !== 'demo' && mode !== 'real') {
    throw new Error(`MODEL_MODE має бути demo або real, отримано: ${mode}`);
  }
  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Некоректний PORT: ${env.PORT}`);
  const base = { port, dbPath: env.CX_DB_PATH || 'data/cx.sqlite' };
  if (mode === 'demo') return { mode, ...base };

  const problems: string[] = [];
  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) problems.push('ANTHROPIC_API_KEY не задано');
  const model = env.CX_MODEL ?? '';
  if (!model) problems.push('CX_MODEL не задано (модель обирається явно, значення за замовчуванням немає)');
  else if (!pricing.models[model]) {
    problems.push(`для моделі «${model}» немає ціни в config/model-pricing.json — без ціни неможливо обмежити витрати`);
  }
  const effort = (env.CX_EFFORT || 'medium') as Effort;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) problems.push(`CX_EFFORT має бути low|medium|high|xhigh|max, отримано: ${env.CX_EFFORT}`);
  const outputMode = (env.CX_OUTPUT_MODE || 'structured') as OutputMode;
  if (outputMode !== 'structured' && outputMode !== 'text_json') problems.push(`CX_OUTPUT_MODE має бути structured або text_json, отримано: ${env.CX_OUTPUT_MODE}`);
  // За замовчуванням — часткове оновлення (D80): за повного контракту відповідь дорівнює всьому накопиченому
  // опису й рано чи пізно впирається в стелю виходу. `full` лишається доступним явно.
  const outputContract = (env.CX_OUTPUT_CONTRACT || 'delta') as OutputContract;
  if (outputContract !== 'delta' && outputContract !== 'full') problems.push(`CX_OUTPUT_CONTRACT має бути delta або full, отримано: ${env.CX_OUTPUT_CONTRACT}`);
  const cfg: ModelConfig = {
    apiKey, model, effort, outputMode, outputContract,
    maxOutputTokens: num(env, 'CX_MAX_OUTPUT_TOKENS', 32_000, problems, { int: true }),
    timeoutMs: num(env, 'CX_TIMEOUT_MS', 300_000, problems, { int: true }),
    maxInputChars: num(env, 'CX_MAX_INPUT_CHARS', 150_000, problems, { int: true }),
    budgetTotalUsd: num(env, 'CX_BUDGET_USD_TOTAL', undefined, problems),
    budgetPerRunUsd: num(env, 'CX_BUDGET_USD_PER_RUN', 1.5, problems),
    maxRunsPerCase: num(env, 'CX_MAX_RUNS_PER_CASE', 12, problems, { int: true }),
    maxRunsPerDay: num(env, 'CX_MAX_RUNS_PER_DAY', 20, problems, { int: true }),
  };
  if (problems.length) {
    throw new Error(
      'MODEL_MODE=real налаштовано не повністю, застосунок не переходить на деморежим мовчки. Бракує або некоректно:\n - ' +
        problems.join('\n - ') + '\nЗапустіть з MODEL_MODE=demo, якщо справжня модель не потрібна.',
    );
  }
  return { mode, ...base, model: cfg };
}

export const DEMO_BANNER = 'ДЕМОРЕЖИМ — не AI. Це перевірка програмної логіки, а не якості аналізу.';

/** Чи доступний зараз аналіз моделлю, і якщо ні — зрозуміла причина (без технічного жаргону). */
export function aiAvailability(cfg: Pick<AppConfig, 'mode' | 'model'>): { available: boolean; reason: string | null } {
  if (cfg.mode !== 'real' || !cfg.model) {
    return { available: false, reason: 'Застосунок працює в деморежимі: справжню модель не підключено. Щоб увімкнути, налаштуйте ключ і модель (див. docs/model-setup.md) та запустіть у режимі real.' };
  }
  return { available: true, reason: null };
}
