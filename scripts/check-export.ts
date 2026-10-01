/**
 * Структурні метрики якості агента 1 за експортом кейсу (лише читання файлу; ключів і бази не торкається):
 *   node --import tsx scripts/check-export.ts export-scenario-a.json
 * Порівнює версії, створені агентом, з їхніми батьківськими: самоузгодженість, початок, умови переходів, довжина дій, нотація, спроби запусків.
 * Це програмні сигнали за `evals/cx-preparation/next-run-criteria.md`; змістову оцінку (гіпотези, межі, шари тверджень) виконує людина.
 */
import { readFileSync } from 'node:fs';
import { flowIssues, linkKindOf, preparationIssues, transitionIssues } from '../src/domain.ts';
import { ContentSchema, type Content } from '../src/schema.ts';
import { canonical } from '../src/hash.ts';
import { findQuote } from '../src/ai/quote.ts';

interface Ver { number: number; id: string; parent_id: string | null; created_by: string; run_id: string | null; content: unknown }
interface Run { id: string; agent: string; instruction_version: string; technical_state: string; attempts: number; cost_usd: number | null; scenario_stage: number | null; checks: { failed_attempts?: { kind: string; violations?: { code: string }[] }[] } | null; usage: { output_tokens?: number } }

const file = process.argv[2];
if (!file) { console.error('Вкажіть файл експорту: node --import tsx scripts/check-export.ts export.json'); process.exit(2); }
const data = JSON.parse(readFileSync(file, 'utf8')) as { versions: Ver[]; runs: Run[]; sources?: { id: string; content: string }[] };
const srcText = new Map((data.sources ?? []).map((s) => [s.id, s.content]));
const parse = (v: Ver): Content => ContentSchema.parse(v.content);
const byId = new Map(data.versions.map((v) => [v.id, v]));

/** Кроки, не змінені агентом, хоча прив'язане до них питання він закрив відповіддю з джерела (D70). */
function staleSteps(base: Content, out: Content): string[] {
  const baseStep = new Map(base.steps.map((s) => [s.id, canonical(s)]));
  const stepById = new Map(out.steps.map((s) => [s.id, s]));
  const res: string[] = [];
  for (const q of out.questions) {
    if (q.status !== 'closed' || !q.closed_by_source_id) continue;
    const b = base.questions.find((x) => x.id === q.id);
    if (!b || b.status !== 'open') continue;
    for (const id of new Set([...(b.affects_transitions ?? []), ...(q.affects_transitions ?? [])].map((a) => a.step_id))) {
      const was = baseStep.get(id);
      const now = stepById.get(id);
      if (was !== undefined && now && canonical(now) === was) res.push(`${q.id}→${id}`);
    }
  }
  return res;
}

/** Твердження «невідоме» з переписаним поясненням і дослівно тим самим текстом (D70). */
function staleUnknowns(base: Content, out: Content): string[] {
  return base.claims.filter((b) => {
    if (b.type !== 'unknown') return false;
    const o = out.claims.find((x) => x.id === b.id);
    return !!o && o.type === 'unknown' && o.text === b.text && o.scope !== b.scope;
  }).map((b) => b.id);
}

const count = (c: Content, code: string): number => [...transitionIssues(c), ...flowIssues(c), ...preparationIssues(c)].filter((i) => i.code === code).length;
const rows: Record<string, unknown>[] = [];
for (const v of data.versions) {
  const c = parse(v);
  const parent = v.parent_id ? byId.get(v.parent_id) : undefined;
  const pc = parent ? parse(parent) : null;
  const stepText = c.steps.flatMap((s) => [s.action, s.result, s.entry_condition, s.input_artifact, ...s.next.map((n) => n.condition)]);
  const lens = c.steps.map((s) => s.action.length).sort((a, b) => a - b);
  const links = c.questions.flatMap((q) => (q.affects_transitions ?? []).map((a) => linkKindOf(a)));
  rows.push({
    версія: v.number, автор: v.created_by,
    'початок змінив агент': v.created_by === 'agent' && pc !== null && (c.entry_step_id ?? null) !== (pc.entry_step_id ?? null) ? `так (${pc.entry_step_id ?? '—'} → ${c.entry_step_id ?? '—'})` : 'ні',
    суперечності: count(c, 'CONTRADICTION'), 'послідовність не підтверджена': count(c, 'SEQUENCE_UNCONFIRMED'), недосяжних: flowIssues(c).filter((i) => i.code === 'STEP_UNREACHABLE').flatMap((i) => (i.ref ?? '').split(',')).filter(Boolean).length,
    'єдиний перехід з умовою': count(c, 'SINGLE_CONDITIONAL_BRANCH'), 'найдовша дія': lens.at(-1) ?? 0, 'медіана дії': lens[Math.floor(lens.length / 2)] ?? 0,
    'посилань «Q…» у кроках': stepText.filter((t) => /\bQ\d+\b/.test(t)).length,
    'вимог нотації (пропозицій)': (c.notation_requirements ?? []).filter((r) => r.status === 'proposed').length,
    'прив’язки за видами': links.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {}),
    'питань закрито агентом': parent ? c.questions.filter((q) => q.status === 'closed' && pc!.questions.find((x) => x.id === q.id)?.status === 'open').length : 0,
    // D70: часткове уточнення й підстава причини. Це структурні сигнали, не оцінка змісту.
    'застарілих кроків після закритого питання': pc ? staleSteps(pc, c).length : 0,
    'застарілих «невідомих»': pc ? staleUnknowns(pc, c).length : 0,
    'причин без підстави': c.problems.filter((p) => !p.cause_status && p.cause.trim()).length,
    'причин не з’ясовано': c.problems.filter((p) => p.cause_status === 'not_established').length,
    'причин зі слів джерела (з них цитата дослівна)': (() => {
      const list = c.problems.filter((p) => p.cause_status === 'source_stated');
      const ok = list.filter((p) => {
        const t = p.cause_source_id ? srcText.get(p.cause_source_id) : undefined;
        return !!t && !!p.cause_quote && findQuote(t, p.cause_quote).kind !== 'not_found';
      });
      return `${list.length} (${ok.length})`;
    })(),
    'причин-гіпотез (з них зі способом перевірки)': (() => {
      const list = c.problems.filter((p) => p.cause_status === 'agent_hypothesis');
      const ok = list.filter((p) => c.hypotheses.some((h) => h.id === p.cause_hypothesis_id && h.check_method.trim()));
      return `${list.length} (${ok.length})`;
    })(),
  });
}
console.log('=== Версії ===');
for (const r of rows) console.log(JSON.stringify(r, null, 0));
console.log('\n=== Запуски агента 1 ===');
for (const r of data.runs.filter((x) => x.agent === 'analyst')) {
  const fa = r.checks?.failed_attempts;
  console.log(JSON.stringify({ запуск: r.id, етап: r.scenario_stage, інструкція: r.instruction_version, стан: r.technical_state, спроб: r.attempts, 'вартість $': r.cost_usd, 'токенів виходу': r.usage?.output_tokens ?? null,
    'причини невдалих спроб': fa ? fa.map((a) => `${a.kind}${a.violations?.length ? ': ' + [...new Set(a.violations.map((x) => x.code))].join(',') : ''}`) : r.attempts > 1 ? 'НЕ ЗБЕРЕЖЕНО (журнал до D68)' : '—' }));
}
