import { canonical } from '../hash.ts';
import { ContentSchema, type Content } from '../schema.ts';
import { findQuote } from './quote.ts';

export interface Violation {
  code: string;
  path: string;
  message: string;
}

export interface VerifySource {
  /** Внутрішній ID (у змісті версій). */
  id: string;
  text: string;
}

export interface VerifyContext {
  /** Робоча версія, від якої рахується оновлення (у внутрішніх ID). */
  base: Content;
  /** Джерела, які реально були передані моделі. */
  sources: VerifySource[];
  /** Відповідь моделі вже переведено з ref у внутрішні ID. */
  fromModel: (c: Content) => Content;
}

export type VerifyResult =
  | { ok: true; content: Content; warnings: string[] }
  | { ok: false; violations: Violation[] };

const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

function referencedSourceIds(c: Content): Set<string> {
  const out = new Set<string>();
  for (const s of c.steps) s.source_ids.forEach((x) => out.add(x));
  for (const cl of c.claims) if (cl.source_id) out.add(cl.source_id);
  for (const q of c.questions) if (q.closed_by_source_id) out.add(q.closed_by_source_id);
  return out;
}

/**
 * Перевіряє відповідь моделі ДО збереження. Перевіряється: схема, існування джерел,
 * наявність і точність цитат, унікальність ID, неможливість «підтвердження» агентом,
 * збереження наявних елементів. Цитата доводить лише те, що джерело це сказало, —
 * не істинність висновку; смислову відповідність перевіряє людина.
 */
export function verifyAgentOutput(raw: unknown, ctx: VerifyContext): VerifyResult {
  const parsed = ContentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.slice(0, 6).map((i) => ({ code: 'SCHEMA', path: i.path.join('.') || '(корінь)', message: i.message })),
    };
  }
  const out = ctx.fromModel(parsed.data);
  const v: Violation[] = [];
  const warnings: string[] = [];
  const base = ctx.base;
  const provided = new Map(ctx.sources.map((s) => [s.id, s.text]));
  const allowed = new Set([...provided.keys(), ...referencedSourceIds(base)]);

  for (const [name, ids] of [
    ['steps', out.steps.map((s) => s.id)], ['claims', out.claims.map((c) => c.id)], ['questions', out.questions.map((q) => q.id)],
    ['problems', out.problems.map((p) => p.id)], ['hypotheses', out.hypotheses.map((h) => h.id)],
  ] as const) {
    for (const d of new Set(dupes([...ids]))) v.push({ code: 'DUPLICATE_ID', path: name, message: `ID «${d}» повторюється` });
  }

  const checkRef = (id: string | null, path: string) => {
    if (id && !allowed.has(id)) v.push({ code: 'UNKNOWN_SOURCE', path, message: `посилання на джерело «${id}», якого немає серед переданих` });
  };
  out.steps.forEach((s, i) => s.source_ids.forEach((id) => checkRef(id, `steps[${i}].source_ids`)));
  out.questions.forEach((q, i) => checkRef(q.closed_by_source_id, `questions[${i}].closed_by_source_id`));

  const baseClaims = new Map(base.claims.map((c) => [c.id, canonical(c)]));
  out.claims.forEach((c, i) => {
    const path = `claims[${i}] (${c.id})`;
    checkRef(c.source_id, path + '.source_id');
    const changed = baseClaims.get(c.id) !== canonical(c);
    if (c.type === 'analyst_confirmed' && changed) {
      v.push({ code: 'AGENT_CANNOT_CONFIRM', path, message: 'тип «підтверджено аналітиком» агент не створює й не змінює' });
    }
    if (!changed) return;
    if (c.type === 'source_fact' && (!c.source_id || !c.quote.trim())) {
      v.push({ code: 'NO_EVIDENCE', path, message: 'твердження джерела без source_id або цитати' });
    }
    if (c.quote.trim() && !c.source_id) v.push({ code: 'QUOTE_WITHOUT_SOURCE', path, message: 'є цитата, але не вказано джерело' });
    if (c.quote.trim() && c.source_id && provided.has(c.source_id)) {
      const m = findQuote(provided.get(c.source_id)!, c.quote);
      if (m.kind === 'not_found') v.push({ code: 'QUOTE_NOT_FOUND', path, message: `цитати немає в джерелі ${c.source_id}: «${c.quote.slice(0, 80)}»` });
      else if (m.kind === 'normalized') warnings.push(`Цитата ${c.id} збігається з джерелом лише після нормалізації пробілів/лапок.`);
    }
  });

  const claimIds = new Set(out.claims.map((c) => c.id));
  const baseHyp = new Map(base.hypotheses.map((h) => [h.id, h]));
  out.hypotheses.forEach((h, i) => {
    const path = `hypotheses[${i}] (${h.id})`;
    const was = baseHyp.get(h.id);
    if (h.status === 'confirmed' && was?.status !== 'confirmed') v.push({ code: 'AGENT_CANNOT_CONFIRM', path, message: 'статус «підтверджено» агент не ставить' });
    if ((h.status === 'supported' || h.status === 'refuted') && h.evidence_for.length + h.evidence_against.length === 0) {
      v.push({ code: 'HYPOTHESIS_NO_EVIDENCE', path, message: 'статус «підтримана/спростована» без тверджень у evidence_for/evidence_against' });
    }
    for (const e of [...h.evidence_for, ...h.evidence_against]) {
      if (!claimIds.has(e)) v.push({ code: 'EVIDENCE_REF', path, message: `доказ «${e}» не є ID твердження` });
    }
  });

  out.questions.forEach((q, i) => {
    if (q.status === 'closed' && !q.answer.trim()) v.push({ code: 'CLOSED_NO_ANSWER', path: `questions[${i}] (${q.id})`, message: 'питання закрито без відповіді' });
  });

  for (const [name, b, o] of [
    ['steps', base.steps.map((s) => s.id), out.steps.map((s) => s.id)],
    ['claims', base.claims.map((c) => c.id), out.claims.map((c) => c.id)],
    ['hypotheses', base.hypotheses.map((h) => h.id), out.hypotheses.map((h) => h.id)],
    ['problems', base.problems.map((p) => p.id), out.problems.map((p) => p.id)],
  ] as const) {
    const set = new Set<string>(o);
    const missing = b.filter((id) => !set.has(id));
    if (missing.length) v.push({ code: 'DELETED_ITEMS', path: name, message: `відсутні наявні ID: ${missing.join(', ')} (видаляти не можна)` });
  }
  if (v.length) return { ok: false, violations: v };

  // Нормалізація (не порушення): авторство нових елементів визначає програма, а не модель.
  const baseQ = new Set(base.questions.map((q) => q.id));
  for (const q of out.questions) if (!baseQ.has(q.id)) q.origin = 'agent';
  for (const h of out.hypotheses) if (!baseHyp.has(h.id)) h.author = 'agent';

  const used = referencedSourceIds(out);
  for (const s of ctx.sources) {
    if (!used.has(s.id)) warnings.push(`Джерело ${s.id} передано, але жодне твердження, крок чи питання на нього не посилається.`);
  }
  return { ok: true, content: out, warnings };
}

export function formatViolations(vs: Violation[]): string[] {
  return vs.map((x) => `${x.code} — ${x.path}: ${x.message}`);
}
