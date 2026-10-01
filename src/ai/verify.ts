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
      else if (m.kind === 'elided') warnings.push(`Цитата ${c.id} зі скороченням «…»: усі частини є в джерелі в тому самому порядку, але пропущене між ними перевірте вручну.`);
    }
  });

  // Пропозиції вилучення/заміни кроків: причина й доказ обов’язкові; рішення агент не приймає.
  const baseProps = new Map((base.step_proposals ?? []).map((p) => [p.id, canonical(p)]));
  const outProps = out.step_proposals ?? [];
  for (const d of new Set(dupes(outProps.map((p) => p.id)))) v.push({ code: 'DUPLICATE_ID', path: 'step_proposals', message: `ID «${d}» повторюється` });
  const outStepIds = new Set(out.steps.map((s) => s.id));
  const baseStepIds = new Set(base.steps.map((s) => s.id));
  const pendingPerStep = new Map<string, number>();
  outProps.forEach((p, i) => {
    if (p.status === 'proposed') pendingPerStep.set(p.step_id, (pendingPerStep.get(p.step_id) ?? 0) + 1);
    if (baseProps.get(p.id) === canonical(p)) return; // наявна пропозиція без змін
    const path = `step_proposals[${i}] (${p.id})`;
    if (baseProps.has(p.id)) return; // зміну наявної програма все одно відновить (рішення за аналітикинею)
    if (p.status !== 'proposed' || p.decided_by || p.decision_note) v.push({ code: 'AGENT_CANNOT_DECIDE', path, message: 'агент лише пропонує (status «proposed»); рішення приймає аналітикиня' });
    if (!baseStepIds.has(p.step_id)) v.push({ code: 'PROPOSAL_BAD_STEP', path, message: `крок «${p.step_id}» відсутній у поточній версії` });
    if (!p.reason.trim()) v.push({ code: 'PROPOSAL_NO_REASON', path, message: 'не вказано причину' });
    if (!p.evidence_source_id || !p.evidence_quote.trim()) v.push({ code: 'PROPOSAL_NO_EVIDENCE', path, message: 'потрібні джерело й дослівна цитата-доказ' });
    else {
      checkRef(p.evidence_source_id, path + '.evidence_source_id');
      if (provided.has(p.evidence_source_id) && findQuote(provided.get(p.evidence_source_id)!, p.evidence_quote).kind === 'not_found') {
        v.push({ code: 'QUOTE_NOT_FOUND', path, message: `цитати-доказу немає в джерелі ${p.evidence_source_id}: «${p.evidence_quote.slice(0, 80)}»` });
      }
    }
    if (p.action === 'replace') {
      if (!p.replacement_step_id || p.replacement_step_id === p.step_id || !outStepIds.has(p.replacement_step_id)) {
        v.push({ code: 'PROPOSAL_BAD_REPLACEMENT', path, message: 'для заміни потрібен інший, існуючий у steps крок-заміна' });
      }
    } else if (p.replacement_step_id) v.push({ code: 'PROPOSAL_BAD_REPLACEMENT', path, message: 'для вилучення replacement_step_id має бути порожнім' });
  });
  for (const [sid, n] of pendingPerStep) if (n > 1) v.push({ code: 'DUPLICATE_PROPOSAL', path: 'step_proposals', message: `для кроку ${sid} кілька відкритих пропозицій` });

  // Вимоги до нотації (D61): агент лише ПРОПОНУЄ — з поясненням, джерелом і дослівною цитатою; підтверджує людина.
  // Наявні вимоги (особливо підтверджені) агент не змінює й не видаляє — це відновить програма (protectAnalystEdits).
  const baseReq = new Map((base.notation_requirements ?? []).map((r) => [r.id, canonical(r)]));
  const baseReqList = base.notation_requirements ?? [];
  const outReq = out.notation_requirements ?? [];
  for (const d of new Set(dupes(outReq.map((r) => r.id)))) v.push({ code: 'DUPLICATE_ID', path: 'notation_requirements', message: `ID «${d}» повторюється` });
  const seenNew = new Set<string>();
  outReq.forEach((r, i) => {
    if (baseReq.has(r.id)) return; // наявна: якщо змінена чи видалена — програма відновить і запише конфлікт
    const path = `notation_requirements[${i}] (${r.id})`;
    if (r.status !== 'proposed' || r.decided_by || r.decision_note) v.push({ code: 'AGENT_CANNOT_DECIDE', path, message: 'агент лише пропонує вимогу (status «proposed», decided_by і decision_note порожні); підтверджує людина' });
    if (!outStepIds.has(r.step_id)) v.push({ code: 'NOTATION_BAD_STEP', path, message: `крок «${r.step_id}» відсутній у steps` });
    if (!r.detail.trim()) v.push({ code: 'NOTATION_NO_DETAIL', path, message: 'не пояснено, що саме в описі потребує цієї нотації' });
    if (!r.evidence_source_id || !r.evidence_quote.trim()) v.push({ code: 'NOTATION_NO_EVIDENCE', path, message: 'потрібні джерело й дослівна цитата-доказ' });
    else {
      checkRef(r.evidence_source_id, path + '.evidence_source_id');
      if (provided.has(r.evidence_source_id) && findQuote(provided.get(r.evidence_source_id)!, r.evidence_quote).kind === 'not_found') {
        v.push({ code: 'QUOTE_NOT_FOUND', path, message: `цитати-доказу немає в джерелі ${r.evidence_source_id}: «${r.evidence_quote.slice(0, 80)}»` });
      }
    }
    const key = `${r.step_id}|${r.kind}`;
    const active = baseReqList.find((b) => b.status !== 'rejected' && b.step_id === r.step_id && b.kind === r.kind);
    if (active || seenNew.has(key)) v.push({ code: 'DUPLICATE_REQUIREMENT', path, message: `для кроку ${r.step_id} вимога цього виду вже є${active ? ` (${active.id})` : ''}` });
    seenNew.add(key);
    const rejected = baseReqList.find((b) => b.status === 'rejected' && b.step_id === r.step_id && b.kind === r.kind && b.evidence_quote.trim() === r.evidence_quote.trim());
    if (rejected) v.push({ code: 'REPEAT_WITHOUT_NEW_EVIDENCE', path, message: `вимогу ${rejected.id} цього виду для кроку ${r.step_id} уже відхилено; без нового доказу її не повторюють` });
  });
  if ((out.process_name ?? '') !== (base.process_name ?? '')) warnings.push('Агент змінив назву процесу: її задає лише аналітикиня, програма відновить попереднє значення.');

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
  for (const r of out.notation_requirements ?? []) if (!baseReq.has(r.id)) r.origin = 'agent';

  const used = referencedSourceIds(out);
  for (const p of outProps) if (p.evidence_source_id) used.add(p.evidence_source_id);
  for (const r of outReq) if (r.evidence_source_id) used.add(r.evidence_source_id);
  for (const s of ctx.sources) {
    if (!used.has(s.id)) warnings.push(`Джерело ${s.id} передано, але жодне твердження, крок чи питання на нього не посилається.`);
  }
  return { ok: true, content: out, warnings };
}

export function formatViolations(vs: Violation[]): string[] {
  return vs.map((x) => `${x.code} — ${x.path}: ${x.message}`);
}
