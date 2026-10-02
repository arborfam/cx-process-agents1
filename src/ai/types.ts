import type { Content } from '../schema.ts';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Помилка виклику моделі. Повідомлення завжди пройшло редагування (без ключів). */
export type FailureKind = 'transient' | 'timeout' | 'auth' | 'bad_request' | 'refusal' | 'truncated' | 'invalid_json' | 'invalid_output' | 'other';

/**
 * Чи могла помилка бути оплаченою без відомого usage: 'none' — помилка до генерації (відповідь API 4xx),
 * 'unknown' (за замовчуванням) — обрив, тайм-аут, мережа, 5xx: вартість невідома, резервуємо консервативно.
 */
export type Billing = 'none' | 'unknown';

export class ModelFailure extends Error {
  constructor(public readonly kind: FailureKind, message: string, public readonly usage?: Usage, public readonly billing: Billing = 'unknown') {
    super(message);
    this.name = 'ModelFailure';
  }
  /** Одна автоматична повторна спроба має сенс лише для цих видів збоїв. */
  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'invalid_json' || this.kind === 'invalid_output';
  }
}

/**
 * Контракт відповіді агента 1 (D80). `full` — повна оновлена версія змісту щоразу (початковий контракт);
 * `delta` — лише нові й змінені елементи (`analyst-delta-v1`, docs/agent1-delta-contract.md).
 */
export type OutputContract = 'full' | 'delta';

export interface InstructionInfo {
  text: string;
  version: string;
  hash: string;
}

export interface AnalystSource {
  /** Ідентифікатор, який бачить модель (SRC-01…); для кейсів без ref — внутрішній ID. */
  id: string;
  title: string;
  kind: string;
  origin: string;
  text: string;
}

export interface AnalystInput {
  instruction: InstructionInfo;
  /** Контракт відповіді. За замовчуванням `full`: старі виклики поводяться як раніше. */
  contract?: OutputContract;
  /** Версія, від якої рахується оновлення: модель повертає її як є (захист від застосування до іншої основи). */
  baseVersion?: string;
  /** Поточна робоча версія у «вигляді моделі» (ID джерел замінено на ref). */
  head_content: Content;
  /** Лише джерела, додані до цього запуску, і лише прочитані. */
  sources: AnalystSource[];
  /** Для повторної спроби: список порушень попередньої відповіді. */
  retry_feedback?: string[];
}

export interface ModelCallResult {
  output: unknown;
  usage?: Usage;
  stopReason?: string | null;
}

export interface AnalystClient {
  readonly mode: 'demo' | 'real';
  readonly model: string;
  analyze(input: AnalystInput, signal: AbortSignal): Promise<ModelCallResult>;
}
