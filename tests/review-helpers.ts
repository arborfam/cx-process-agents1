/**
 * Допоміжне для тестів 3b-2. Підставний клієнт агента 2 існує ЛИШЕ тут (у `src/` його немає: тест це перевіряє).
 * Він позначений як `real` лише для того, щоб випробувати облік бюджету й шлюз; справжнього виклику моделі немає
 * (назва моделі в журналі каже про це прямо).
 */
import { loadConfig, loadPricing } from '../src/config.ts';
import { makePolicy, type ModelPolicy } from '../src/ai/budget.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { ModelFailure, type ModelCallResult } from '../src/ai/types.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { Reviewer } from '../src/review-runs.ts';
import { scriptedCsv } from './csv-fixture.ts';

export const FAKE_MODEL = 'ПІДСТАВНИЙ-КЛІЄНТ (тест, не модель)';

export const policyOf = (extra: Record<string, string> = {}): ModelPolicy =>
  makePolicy(loadConfig({ MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-TESTTESTTESTTEST', CX_MODEL: 'claude-opus-5-5', CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5', ...extra }).model!, loadPricing());

export type Step = (input: BpmnReviewInput, signal: AbortSignal) => Promise<ModelCallResult> | ModelCallResult;

export class FakeReviewClient implements BpmnReviewClient {
  readonly model = FAKE_MODEL;
  calls = 0;
  inputs: BpmnReviewInput[] = [];
  constructor(private readonly steps: Step[], readonly mode: 'demo' | 'real' = 'real') {}
  async review(input: BpmnReviewInput, signal: AbortSignal): Promise<ModelCallResult> {
    this.calls++;
    this.inputs.push(input);
    const s = this.steps[Math.min(this.calls - 1, this.steps.length - 1)]!;
    return s(input, signal);
  }
}

export const USAGE = { input_tokens: 3000, output_tokens: 800 };
/** `usage = null` — відповідь без usage (вартість невідома). */
/**
 * Успішна відповідь агента 2: знахідки + СЦЕНАРНА таблиця процесу (D87). Таблиця є завжди — вона лише
 * переносить погоджений опис і знахідок не скасовує (побудову блокує шлюз, а не брак таблиці).
 * `csv: null` — свідомо без таблиці (для перевірки відмови продукту).
 */
export const okStep = (findings: unknown[] = [], usage: typeof USAGE | null = USAGE, csv: string | null | undefined = undefined): Step => (input) => {
  const table = csv === null ? undefined : csv ?? scriptedCsv(input.pkg.content, input.pkg.startLabel);
  return { output: { findings, ...(table === undefined ? {} : { csv: table }) }, ...(usage ? { usage } : {}) };
};
export const failStep = (kind: ConstructorParameters<typeof ModelFailure>[0], usage?: typeof USAGE, billing: 'none' | 'unknown' = 'unknown'): Step => () => { throw new ModelFailure(kind, `збій ${kind}`, usage, billing); };

/** `policy = null` — свідомо без політики (undefined дав би типову, бо це параметр за замовчуванням). */
export const reviewer = (client: BpmnReviewClient, policy: ModelPolicy | null = policyOf()): Reviewer => ({ client, policy: policy ?? undefined, instruction: loadBpmnInstruction() });

/** Знахідка за схемою агента 2 з цитатою з погодженого опису тестового кейсу (COMPLETE_FIELDS). */
export const finding = (over: Record<string, unknown> = {}) => ({
  code: 'CONDITIONS_NOT_EXHAUSTIVE', step_ids: ['S2'], quote: 'Вносить зміну', question: 'Що відбувається в інших випадках?', class: 'blocks_flow', ...over,
});
