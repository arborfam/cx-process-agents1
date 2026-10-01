/**
 * Структурні метрики якості агента 1 за експортом кейсу (лише читання файлу; ключів і бази не торкається):
 *   node --import tsx scripts/check-export.ts export-scenario-a.json
 * Порівнює версії, створені агентом, з їхніми батьківськими: самоузгодженість, початок, умови переходів, довжина дій, нотація, спроби запусків.
 * Це програмні сигнали за `evals/cx-preparation/next-run-criteria.md`; змістову оцінку (гіпотези, межі, шари тверджень) виконує людина.
 */
import { readFileSync } from 'node:fs';
import { flowIssues, linkKindOf, preparationIssues, transitionIssues } from '../src/domain.ts';
import { ContentSchema, type Content } from '../src/schema.ts';

interface Ver { number: number; id: string; parent_id: string | null; created_by: string; run_id: string | null; content: unknown }
interface Run { id: string; agent: string; instruction_version: string; technical_state: string; attempts: number; cost_usd: number | null; scenario_stage: number | null; checks: { failed_attempts?: { kind: string; violations?: { code: string }[] }[] } | null; usage: { output_tokens?: number } }

const file = process.argv[2];
if (!file) { console.error('Вкажіть файл експорту: node --import tsx scripts/check-export.ts export.json'); process.exit(2); }
const data = JSON.parse(readFileSync(file, 'utf8')) as { versions: Ver[]; runs: Run[] };
const parse = (v: Ver): Content => ContentSchema.parse(v.content);
const byId = new Map(data.versions.map((v) => [v.id, v]));

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
