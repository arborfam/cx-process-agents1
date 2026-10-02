import { z } from 'zod';
import { canonical } from '../hash.ts';
import { ItemSchemas, type Content } from '../schema.ts';
import type { Violation } from './verify.ts';

/**
 * Контракт часткового оновлення AS-IS (D80, `docs/agent1-delta-contract.md`).
 *
 * Навіщо: за контракту «повна версія щоразу» відповідь агента дорівнює всьому накопиченому опису, тому впирається
 * в будь-яку стелю виходу, а 82 % вартості прогону йде на переписування незмінного тексту (D78/D79). Тут агент
 * повертає лише нові й змінені елементи, а повний кандидат збирає програма — і проганяє на ньому ВСІ чинні перевірки.
 *
 * Правила однозначні: відсутність елемента = «без змін» (ніколи не видалення); присутній елемент заміняє попередній
 * ЦІЛКОМ (разом зі своїми вкладеними списками); поля, якими володіє програма (`conflicts`, `entry_step_id`,
 * `process_name`, `questions[].link_history`), у схемі відсутні — агент не може їх ні надіслати, ні змінити.
 */
export const DELTA_CONTRACT = 'analyst-delta-v1';

/** Питання без `link_history`: історію виправлень прив'язки веде лише застосунок за рішенням аналітикині. */
const QuestionNoHistory = ItemSchemas.question.omit({ link_history: true });

export const DeltaSchema = z
  .object({
    contract: z.literal(DELTA_CONTRACT),
    /** Ідентифікатор версії, від якої рахується оновлення: модель копіює його з запиту. */
    base_version: z.string().optional(),
    summary: z.string().optional(),
    business_context: z.string().optional(),
    /** Межі — по полях: передане поле заміняється, непередане лишається. */
    boundaries: ItemSchemas.boundaries.partial().strict().optional(),
    /** Роль без стабільного ID не можна «змінити частково», тому агент може лише ДОДАТИ роль. */
    roles_added: z.array(z.string()).optional(),
    steps: z.array(ItemSchemas.step).optional(),
    problems: z.array(ItemSchemas.problem).optional(),
    claims: z.array(ItemSchemas.claim).optional(),
    hypotheses: z.array(ItemSchemas.hypothesis).optional(),
    questions: z.array(QuestionNoHistory).optional(),
    step_proposals: z.array(ItemSchemas.step_proposal).optional(),
    notation_requirements: z.array(ItemSchemas.notation_requirement).optional(),
  })
  .strict();

export type Delta = z.infer<typeof DeltaSchema>;

export interface DeltaListStat { added: number; changed: number; unchanged: number }
export interface DeltaStats {
  /** Поля, які агент замінив (крім списків). */
  scalars: string[];
  lists: Record<string, DeltaListStat>;
  roles_added: number;
  /** Розмір відповіді агента й розмір повної версії — для журналу запуску. */
  delta_chars: number;
  full_chars: number;
}

const LIST_KEYS = ['steps', 'problems', 'claims', 'hypotheses', 'questions', 'step_proposals', 'notation_requirements'] as const;
type ListKey = (typeof LIST_KEYS)[number];

/** Чи схожа відповідь на часткове оновлення (за маркером контракту). Повна версія такого поля не має. */
export function looksLikeDelta(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && 'contract' in (raw as Record<string, unknown>);
}

/**
 * Злиття одного списку: елемент із відомим `id` заміняє попередній НА ЙОГО МІСЦІ, невідомий — додається в кінець.
 * Дублікат `id` у самій відповіді — суперечлива операція (її неможливо виконати однозначно), тому відмова.
 */
function mergeList<T extends { id: string }>(baseList: T[], patch: T[] | undefined, key: string, v: Violation[]): { list: T[]; stat: DeltaListStat } {
  const out = baseList.map((x) => structuredClone(x));
  const stat: DeltaListStat = { added: 0, changed: 0, unchanged: 0 };
  if (!patch) return { list: out, stat };
  const seen = new Set<string>();
  for (const item of patch) {
    if (seen.has(item.id)) {
      v.push({ code: 'DELTA_DUPLICATE_OP', path: key, message: `елемент «${item.id}» передано двічі в одній відповіді: яку з двох версій застосувати — невизначено` });
      continue;
    }
    seen.add(item.id);
    const i = out.findIndex((x) => x.id === item.id);
    if (i < 0) { out.push(structuredClone(item)); stat.added++; continue; }
    if (canonical(out[i]!) === canonical(item)) { stat.unchanged++; continue; }
    out[i] = structuredClone(item);
    stat.changed++;
  }
  return { list: out, stat };
}

export type ApplyResult =
  | { ok: true; content: Content; stats: DeltaStats }
  | { ok: false; violations: Violation[] };

/**
 * Застосовує часткове оновлення до ТОЧНОЇ вхідної версії (`base`) і повертає повний кандидат.
 * Нічого не зберігає й не перевіряє змістових правил: усі чинні перевірки виконуються далі, на повному кандидаті
 * (`verifyAgentOutput`, `protectAnalystEdits`). Відмова тут означає, що не застосовано НІЧОГО.
 *
 * `base` і відповідь мають бути в одному просторі ідентифікаторів джерел (у `completeAnalystRun` — у «вигляді моделі»).
 */
export function applyDelta(base: Content, raw: unknown, opts: { baseVersion?: string } = {}): ApplyResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, violations: [{ code: 'DELTA_CONTRACT', path: '(корінь)', message: `очікується один JSON-об'єкт за контрактом «${DELTA_CONTRACT}»` }] };
  }
  const contract = (raw as Record<string, unknown>).contract;
  if (contract !== DELTA_CONTRACT) {
    return { ok: false, violations: [{ code: 'DELTA_CONTRACT', path: 'contract', message:
      `цей запуск виконується за контрактом «${DELTA_CONTRACT}» (лише нові й змінені елементи), а у відповіді contract = ${JSON.stringify(contract) ?? '(немає)'}` }] };
  }
  const parsed = DeltaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.slice(0, 6).map((i) => ({
        code: 'SCHEMA', path: i.path.join('.') || '(корінь)',
        // Поля, якими володіє програма, у схемі відсутні свідомо: підказуємо це прямо, щоб повторна спроба була змістовною.
        message: i.message + (/^(conflicts|entry_step_id|process_name)$/.test(String(i.path[0] ?? '')) || i.path.includes('link_history')
          ? ' — це поле веде програма, а не агент: його не передають у частковому оновленні' : ''),
      })),
    };
  }
  const d = parsed.data;
  const v: Violation[] = [];
  if (d.base_version !== undefined && opts.baseVersion !== undefined && d.base_version !== opts.baseVersion) {
    v.push({ code: 'DELTA_BASE_MISMATCH', path: 'base_version', message:
      `оновлення рахується від версії «${opts.baseVersion}», а у відповіді base_version = «${d.base_version}»: застосувати його до іншої основи не можна` });
  }

  const content: Content = structuredClone(base);
  const scalars: string[] = [];
  if (d.summary !== undefined && d.summary !== content.summary) { content.summary = d.summary; scalars.push('summary'); }
  if (d.business_context !== undefined && d.business_context !== content.business_context) { content.business_context = d.business_context; scalars.push('business_context'); }
  for (const f of ['trigger', 'input', 'completion', 'result'] as const) {
    const value = d.boundaries?.[f];
    if (value !== undefined && value !== content.boundaries[f]) { content.boundaries[f] = value; scalars.push(`boundaries.${f}`); }
  }
  const newRoles = (d.roles_added ?? []).filter((r) => r.trim() && !content.roles.includes(r));
  content.roles = [...content.roles, ...newRoles];

  const lists: Record<string, DeltaListStat> = {};
  const merged = {
    steps: mergeList(base.steps, d.steps, 'steps', v),
    problems: mergeList(base.problems, d.problems, 'problems', v),
    claims: mergeList(base.claims, d.claims, 'claims', v),
    hypotheses: mergeList(base.hypotheses, d.hypotheses, 'hypotheses', v),
    questions: mergeList(base.questions, d.questions as Content['questions'] | undefined, 'questions', v),
    step_proposals: mergeList(base.step_proposals ?? [], d.step_proposals, 'step_proposals', v),
    notation_requirements: mergeList(base.notation_requirements ?? [], d.notation_requirements, 'notation_requirements', v),
  } satisfies Record<ListKey, { list: unknown[]; stat: DeltaListStat }>;
  for (const k of LIST_KEYS) lists[k] = merged[k].stat;
  if (v.length) return { ok: false, violations: v };

  content.steps = merged.steps.list;
  content.problems = merged.problems.list;
  content.claims = merged.claims.list;
  content.hypotheses = merged.hypotheses.list;
  content.questions = merged.questions.list;
  // Необов'язкові списки лишаються відсутніми, якщо їх не було й не додано: порожній список і «немає поля» — одне
  // й те саме («не зазначено»), і версії без них не мають змінюватись через сам факт часткового оновлення.
  if (merged.step_proposals.list.length) content.step_proposals = merged.step_proposals.list; else delete content.step_proposals;
  if (merged.notation_requirements.list.length) content.notation_requirements = merged.notation_requirements.list; else delete content.notation_requirements;

  // Історію виправлень прив'язки повертаємо з основи: агент її не бачить і не передає (її ж відновлює `verify.ts`).
  for (const q of content.questions) {
    const b = base.questions.find((x) => x.id === q.id);
    if (b?.link_history) q.link_history = structuredClone(b.link_history);
    else delete q.link_history;
  }
  // Конфлікти — поле програми: вона перераховує їх для КОЖНОЇ версії (`protectAnalystEdits`). Перенести їх з основи
  // означало б дублювати старі конфлікти у кожній наступній версії; за повного контракту агент повертає тут [].
  content.conflicts = [];

  return {
    ok: true,
    content,
    stats: { scalars, lists, roles_added: newRoles.length, delta_chars: JSON.stringify(d).length, full_chars: JSON.stringify(content).length },
  };
}

/** JSON-схема відповіді для режиму `text_json` і для структурованого виводу. */
export const deltaJsonSchema = () => z.toJSONSchema(DeltaSchema);
