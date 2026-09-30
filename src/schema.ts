import { z } from 'zod';

/**
 * Схема змісту версії AS-IS (спец. §6). Усі об'єкти strict: зайві поля, наприклад
 * «status: approved» чи «approval», відхиляються — агент не може записати погодження.
 */
export const ClaimType = z.enum(['source_fact', 'analyst_confirmed', 'hypothesis', 'improvement_proposal', 'unknown']);
export type ClaimTypeT = z.infer<typeof ClaimType>;

const Step = z
  .object({
    id: z.string().min(1).max(40),
    role: z.string(),
    action: z.string(),
    entry_condition: z.string(),
    input_artifact: z.string(),
    result: z.string(),
    next: z.array(z.object({ to: z.string(), condition: z.string() }).strict()),
    source_ids: z.array(z.string()),
  })
  .strict();

const Problem = z
  .object({
    id: z.string().min(1).max(40),
    symptom: z.string(),
    cause: z.string(),
    impact: z.string(),
    impact_is_estimate: z.boolean(),
  })
  .strict();

const Claim = z
  .object({
    id: z.string().min(1).max(40),
    text: z.string(),
    type: ClaimType,
    source_id: z.string().nullable(),
    quote: z.string(),
    scope: z.string(),
  })
  .strict();

const Hypothesis = z
  .object({
    id: z.string().min(1).max(40),
    author: z.enum(['analyst', 'agent']),
    text: z.string(),
    status: z.enum(['open', 'supported', 'refuted', 'confirmed']),
    evidence_for: z.array(z.string()),
    evidence_against: z.array(z.string()),
    check_method: z.string(),
    history: z.array(z.object({ at: z.string(), status: z.string(), note: z.string() }).strict()),
  })
  .strict();

const Question = z
  .object({
    id: z.string().min(1).max(40),
    text: z.string(),
    critical: z.boolean(),
    impact: z.string(),
    addressee: z.string(),
    status: z.enum(['open', 'closed']),
    answer: z.string(),
    closed_by_source_id: z.string().nullable(),
    origin: z.enum(['analyst', 'demo_script', 'agent']),
    criticality_note: z.string(),
    /** Переходи, про які це питання: доки воно відкрите, такий перехід має бути «невідомим», а не фактом. */
    affects_transitions: z.array(z.object({ step_id: z.string(), condition: z.string() }).strict()).optional(),
  })
  .strict();

const Conflict = z.object({ key: z.string(), kept: z.string(), proposed: z.string(), note: z.string() }).strict();

export const ContentSchema = z
  .object({
    summary: z.string(),
    business_context: z.string(),
    boundaries: z.object({ trigger: z.string(), input: z.string(), completion: z.string(), result: z.string() }).strict(),
    roles: z.array(z.string()),
    /** Явний початковий крок (D27). Необов’язкове поле: старі версії його не мають і не переписуються. Ніколи не виводиться з порядку кроків. */
    entry_step_id: z.string().nullable().optional(),
    steps: z.array(Step),
    problems: z.array(Problem),
    claims: z.array(Claim),
    hypotheses: z.array(Hypothesis),
    questions: z.array(Question),
    conflicts: z.array(Conflict),
  })
  .strict();

/** Спеціальна ціль переходу: «що далі — невідомо». Не є кроком і не є завершенням. */
export const UNKNOWN = 'UNKNOWN';

export type Content = z.infer<typeof ContentSchema>;
export type Step = z.infer<typeof Step>;
export type Problem = z.infer<typeof Problem>;
export type Question = z.infer<typeof Question>;

export function emptyContent(): Content {
  return {
    summary: '',
    business_context: '',
    boundaries: { trigger: '', input: '', completion: '', result: '' },
    roles: [],
    steps: [],
    problems: [],
    claims: [],
    hypotheses: [],
    questions: [],
    conflicts: [],
  };
}

export function parseContent(value: unknown): Content {
  return ContentSchema.parse(value);
}

export const CLAIM_TYPE_LABEL: Record<ClaimTypeT, string> = {
  source_fact: 'Твердження джерела',
  analyst_confirmed: 'Підтверджено аналітиком',
  hypothesis: 'Гіпотеза',
  improvement_proposal: 'Пропозиція покращення (не факт AS-IS)',
  unknown: 'Невідоме',
};
