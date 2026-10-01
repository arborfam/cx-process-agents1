import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ModelConfig } from '../config.ts';
import { ContentSchema } from '../schema.ts';
import type { ModelPolicy } from './budget.ts';
import { buildUserMessage } from './prompt.ts';
import { redact } from './redact.ts';
import { ModelFailure, type AnalystClient, type AnalystInput, type ModelCallResult, type Usage } from './types.ts';

/**
 * Справжній клієнт моделі. Працює ЛИШЕ на сервері; ключ не виходить за межі цього файлу
 * і не потрапляє в помилки (redact). Автоматичні повтори SDK вимкнено (maxRetries: 0):
 * єдину повторну спробу контролює runAnalyst, щоб витрати були обмежені.
 * Структурований вивід — output_config.format; thinking адаптивний (для Opus 5.5 увімкнений завжди,
 * параметр thinking не передається).
 */
export class AnthropicAnalystClient implements AnalystClient {
  readonly mode = 'real' as const;
  readonly model: string;
  private readonly sdk: Anthropic;

  constructor(private readonly cfg: ModelConfig, private readonly policy: ModelPolicy, sdk?: Anthropic) {
    this.model = cfg.model;
    this.sdk = sdk ?? new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0, timeout: cfg.timeoutMs });
  }

  async analyze(input: AnalystInput, signal: AbortSignal): Promise<ModelCallResult> {
    const structured = this.cfg.outputMode === 'structured';
    let user = buildUserMessage(input);
    if (!structured) {
      user += '\n\nФормат: лише JSON за такою JSON-схемою, без пояснень і без markdown-огорож:\n' + JSON.stringify(z.toJSONSchema(ContentSchema));
    }
    try {
      const stream = this.sdk.messages.stream(
        {
          model: this.cfg.model,
          max_tokens: this.policy.maxOutputTokens,
          system: input.instruction.text,
          messages: [{ role: 'user', content: user }],
          output_config: structured ? { effort: this.cfg.effort, format: zodOutputFormat(ContentSchema) } : { effort: this.cfg.effort },
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
        throw new ModelFailure('refusal', 'Модель відмовилась відповідати на цей запит (refusal). Поточну версію не змінено.', usage);
      }
      if (msg.stop_reason === 'max_tokens') {
        throw new ModelFailure('truncated', `Відповідь обірвано через ліміт довжини (${this.policy.maxOutputTokens} токенів). Неповну відповідь не прийнято; збільшіть CX_MAX_OUTPUT_TOKENS свідомо.`, usage);
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
      throw this.classify(e);
    }
  }

  private classify(e: unknown): ModelFailure {
    if (e instanceof ModelFailure) return e;
    const clean = (s: string) => redact(s, [this.cfg.apiKey]);
    if (e instanceof Anthropic.APIUserAbortError) return new ModelFailure('timeout', 'Запит перервано (тайм-аут або скасування).');
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return new ModelFailure('auth', 'Доступ до моделі відхилено (ключ недійсний, відкликаний або без прав). Перевірте ключ у налаштуваннях; повторювати не буду.', undefined, 'none');
    }
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
      return new ModelFailure('bad_request', clean(`API відхилив запит (${e.status}): ${e.message}`), undefined, 'none');
    }
    if (e instanceof Anthropic.RateLimitError) return new ModelFailure('transient', 'Перевищено ліміт швидкості API (429). Спробуйте пізніше.', undefined, 'none');
    if (e instanceof Anthropic.APIConnectionError) return new ModelFailure('transient', 'Немає зв’язку з API або тайм-аут з’єднання.');
    if (e instanceof Anthropic.APIError) {
      const pre = e.status !== undefined && e.status >= 400 && e.status < 500;
      return new ModelFailure(e.status !== undefined && e.status >= 500 ? 'transient' : 'other', clean(`Помилка API (${e.status ?? '?'}): ${e.message}`), undefined, pre ? 'none' : 'unknown');
    }
    return new ModelFailure('other', clean(e instanceof Error ? e.message : String(e)));
  }
}

function stripFences(t: string): string {
  const s = t.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  return m ? m[1]! : s;
}
