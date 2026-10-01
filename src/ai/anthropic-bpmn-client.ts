import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ModelConfig } from '../config.ts';
import { classifyAnthropicError, stripFences } from './anthropic-client.ts';
import { ReviewApiSchema, buildReviewMessage, type BpmnReviewClient, type BpmnReviewInput } from './bpmn-review.ts';
import type { ModelPolicy } from './budget.ts';
import { ModelFailure, type ModelCallResult, type Usage } from './types.ts';

/**
 * Справжній клієнт агента 2. Працює ЛИШЕ на сервері; ключ не виходить за межі цього файлу й не потрапляє в помилки.
 * Автоповтори SDK вимкнено (maxRetries: 0): єдину повторну спробу контролює `runBpmnReview` разом із бюджетом.
 * Це лише клієнт: смислову перевірку виконує модель, а чи можна довіряти відповіді — вирішує код (`verifyReviewOutput`).
 * Підставного/демо-клієнта в продуктовому коді немає: його можуть створювати лише тести.
 * Жодного виклику цього клієнта не робилось (доступ до API не перевірено); тести — на підставному SDK без мережі.
 */
export class AnthropicBpmnClient implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model: string;
  private readonly sdk: Anthropic;

  constructor(private readonly cfg: ModelConfig, private readonly policy: ModelPolicy, sdk?: Anthropic) {
    this.model = cfg.model;
    this.sdk = sdk ?? new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0, timeout: cfg.timeoutMs });
  }

  async review(input: BpmnReviewInput, signal: AbortSignal): Promise<ModelCallResult> {
    const structured = this.cfg.outputMode === 'structured';
    let user = buildReviewMessage(input);
    if (!structured) {
      user += '\n\nФормат: лише JSON за такою JSON-схемою, без пояснень і без markdown-огорож:\n' + JSON.stringify(z.toJSONSchema(ReviewApiSchema));
    }
    try {
      const stream = this.sdk.messages.stream(
        {
          model: this.cfg.model,
          max_tokens: this.policy.maxOutputTokens,
          system: input.instruction.text,
          messages: [{ role: 'user', content: user }],
          output_config: structured ? { effort: this.cfg.effort, format: zodOutputFormat(ReviewApiSchema) } : { effort: this.cfg.effort },
        },
        { signal },
      );
      const msg = await stream.finalMessage();
      const usage: Usage = {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
      };
      if (msg.stop_reason === 'refusal') {
        throw new ModelFailure('refusal', 'Модель відмовилась відповідати на цей запит (refusal). Смислову перевірку не виконано.', usage);
      }
      if (msg.stop_reason === 'max_tokens') {
        throw new ModelFailure('truncated', `Відповідь обірвано через ліміт довжини (${this.policy.maxOutputTokens} токенів). Неповну відповідь не прийнято.`, usage);
      }
      const text = msg.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
      let output: unknown;
      try {
        output = JSON.parse(stripFences(text));
      } catch {
        throw new ModelFailure('invalid_json', 'Відповідь моделі не є коректним JSON.', usage);
      }
      return { output, usage, stopReason: msg.stop_reason };
    } catch (e) {
      throw classifyAnthropicError(e, this.cfg.apiKey);
    }
  }
}
