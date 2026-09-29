export type ModelMode = 'demo' | 'real';

export interface AppConfig {
  mode: ModelMode;
  port: number;
  dbPath: string;
}

/**
 * Читає налаштування. Мовчазного переходу з real на demo немає:
 * у зрізі 1 режим real недоступний, і застосунок відмовляється стартувати.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const mode = (env.MODEL_MODE ?? 'demo') as string;
  if (mode !== 'demo' && mode !== 'real') {
    throw new Error(`MODEL_MODE має бути demo або real, отримано: ${mode}`);
  }
  if (mode === 'real') {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        'MODEL_MODE=real, але ANTHROPIC_API_KEY не задано. Застосунок не переходить на деморежим мовчки. ' +
          'Задайте ключ (зріз 2) або запустіть з MODEL_MODE=demo.',
      );
    }
    throw new Error('Режим real ще не реалізовано (зріз 2). Використовуйте MODEL_MODE=demo.');
  }
  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Некоректний PORT: ${env.PORT}`);
  return { mode, port, dbPath: env.CX_DB_PATH || 'data/cx.sqlite' };
}

export const DEMO_BANNER = 'ДЕМОРЕЖИМ — не AI. Це перевірка програмної логіки, а не якості аналізу.';
