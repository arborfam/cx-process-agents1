import { z } from 'zod';

/**
 * Схема змісту версії AS-IS (спец. §6). Усі об'єкти strict: зайві поля, наприклад
 * «status: approved» чи «approval», відхиляються — агент не може записати погодження.
 */
export const ClaimType = z.enum(['source_fact', 'analyst_confirmed', 'hypothesis', 'improvement_proposal', 'unknown']);
export type ClaimTypeT = z.infer<typeof ClaimType>;

export const LinkKind = z.enum(['direction', 'unconfirmed_sequence', 'exception', 'step_detail']);
export type LinkKindT = z.infer<typeof LinkKind>;
export const LINK_KIND_LABEL: Record<LinkKindT, string> = {
  direction: 'напрямок переходу невизначений',
  unconfirmed_sequence: 'послідовність кроків не підтверджена',
  exception: 'невідомий виняток або альтернатива (відома гілка існує)',
  step_detail: 'уточнення змісту кроку',
};
const LinkSchema = z.object({ step_id: z.string(), condition: z.string(), kind: LinkKind.optional() }).strict();

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
    /** Деталі, приклади й канали — окремо від короткої назви дії (`action` іде підписом на схемі). Необов'язкове: старі версії його не мають. */
    details: z.string().optional(),
  })
  .strict();

/** Підстава причини проблеми (D70). Немає поля = «не зазначено» (старі записи); для нових і змінених агентом — обов'язкове. */
export const CauseStatus = z.enum(['source_stated', 'agent_hypothesis', 'not_established']);
export type CauseStatusT = z.infer<typeof CauseStatus>;
export const CAUSE_STATUS_LABEL: Record<CauseStatusT, string> = {
  source_stated: 'причина зі слів джерела',
  agent_hypothesis: 'можлива причина (гіпотеза, потребує перевірки)',
  not_established: 'причину не з’ясовано',
};

const Problem = z
  .object({
    id: z.string().min(1).max(40),
    symptom: z.string(),
    cause: z.string(),
    impact: z.string(),
    impact_is_estimate: z.boolean(),
    /**
     * Звідки взялась причина. `source_stated` — джерело прямо її називає (потрібні `cause_source_id` і дослівна
     * `cause_quote`); `agent_hypothesis` — висновок агента (потрібна гіпотеза `cause_hypothesis_id` зі способом
     * перевірки); `not_established` — причину не з'ясовано, текст `cause` порожній. Переказ симптому замість
     * причини («механізму немає», «позначки немає») підстави не має: це `not_established`.
     * Необов'язкові поля: старі версії їх не мають, читаються й хешуються як раніше.
     */
    cause_status: CauseStatus.optional(),
    cause_source_id: z.string().optional(),
    cause_quote: z.string().optional(),
    cause_hypothesis_id: z.string().optional(),
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
    /**
     * Прив'язка питання до потоку. Вид `kind` (відсутній = `direction`, як було раніше) каже, ЩО саме невідомо:
     *  • direction — напрямок переходу невизначений: доки питання відкрите, перехід має бути «невідомим» (блокує);
     *  • unconfirmed_sequence — перехід відомий, але послідовність не підтверджена (блокує: заважає визначити потік);
     *  • exception — відома гілка існує, невідома лише альтернатива/виняток (саме по собі не блокує);
     *  • step_detail — уточнення змісту кроку, перехід не стосується (саме по собі не блокує).
     */
    affects_transitions: z.array(LinkSchema).optional(),
    /** Історія явних виправлень прив'язки аналітикинею (хто, коли, з якого виду на який, чому). Агент її не змінює. */
    link_history: z.array(z.object({ at: z.string(), by: z.string(), step_id: z.string(), condition: z.string(), from: LinkKind, to: LinkKind, note: z.string() }).strict()).optional(),
  })
  .strict();

/**
 * Явна пропозиція агента вилучити або замінити крок. Крок із `steps` агент не прибирає: він лишається, доки
 * аналітикиня не прийме пропозицію. Потрібні причина й доказ (джерело + дослівна цитата).
 */
const StepProposal = z
  .object({
    id: z.string().min(1).max(40),
    action: z.enum(['remove', 'replace']),
    step_id: z.string(),
    /** Для «replace» — ID кроку-заміни (він має бути в steps); для «remove» — порожній рядок. */
    replacement_step_id: z.string(),
    reason: z.string(),
    evidence_source_id: z.string(),
    evidence_quote: z.string(),
    status: z.enum(['proposed', 'accepted', 'rejected']),
    decided_by: z.string(),
    decision_note: z.string(),
  })
  .strict();

/** Види нотації, яких генератор BPMN v1 не підтримує (D21). Вимога, підтверджена людиною, веде до `unsupported` без моделі. */
export const NotationKind = z.enum(['parallel_branches', 'timer', 'message', 'subprocess', 'boundary_event', 'data_object', 'multiple_entry', 'other']);
export type NotationKindT = z.infer<typeof NotationKind>;

export const NOTATION_KIND_LABEL: Record<NotationKindT, string> = {
  parallel_branches: 'паралельні гілки',
  timer: 'таймер / очікування за часом',
  message: 'повідомлення між учасниками',
  subprocess: 'підпроцес',
  boundary_event: 'гранична подія',
  data_object: 'артефакт даних',
  multiple_entry: 'кілька точок входу',
  other: 'інша непідтримувана нотація',
};

/**
 * Явна вимога до нотації (D61): крок + вид + пояснення. Входить у зміст версії, а отже в хеш і в людське погодження.
 * Постановляє людина (origin «analyst», одразу «confirmed»); агент 1 лише ПРОПОНУЄ (origin «agent», status «proposed»,
 * обов'язкові джерело й дослівна цитата); підтверджує чи відхиляє людина. Непідтверджена пропозиція не є встановленим фактом.
 */
const NotationRequirement = z
  .object({
    id: z.string().min(1).max(40),
    kind: NotationKind,
    step_id: z.string(),
    detail: z.string(),
    origin: z.enum(['analyst', 'agent']),
    status: z.enum(['proposed', 'confirmed', 'rejected']),
    evidence_source_id: z.string(),
    evidence_quote: z.string(),
    decided_by: z.string(),
    decision_note: z.string(),
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
    /** Необов’язкове: старі версії його не мають. Рішення за пропозиціями приймає лише аналітикиня. */
    step_proposals: z.array(StepProposal).optional(),
    /**
     * Назва процесу (D62, варіант Б): входить у зміст версії, хеш і погодження; її зміна — нова версія.
     * У v1 це ж напис на єдиному пулі схеми. Немає поля чи порожнє = «не зазначено»; назва кейсу сюди ніколи не підставляється.
     * Необов’язкове: старі версії його не мають і не переписуються.
     */
    process_name: z.string().optional(),
    /**
     * Явні вимоги до нотації (D61). Немає поля чи порожній список = «не зазначено», а НЕ «особливостей немає»:
     * смислова перевірка агента 2 від цього не скасовується. Необов’язкове: старі версії його не мають.
     */
    notation_requirements: z.array(NotationRequirement).optional(),
  })
  .strict();

/** Спеціальна ціль переходу: «що далі — невідомо». Не є кроком і не є завершенням. */
export const UNKNOWN = 'UNKNOWN';

export type Content = z.infer<typeof ContentSchema>;
export type Step = z.infer<typeof Step>;
export type Problem = z.infer<typeof Problem>;
export type Question = z.infer<typeof Question>;
export type StepProposalT = z.infer<typeof StepProposal>;
export type NotationRequirementT = z.infer<typeof NotationRequirement>;

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
