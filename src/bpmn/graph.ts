/**
 * Згортання технічних елементів: з графа «блоки + лінії» отримуємо переходи «крок → крок / END» з умовою.
 * Використовується однаково для звірки .bpmn і .drawio, тож обидва файли порівнюються з пакетом за одним правилом.
 */
import { TASK_PREFIX } from './ids.ts';

export interface GNode { id: string; tag: 'startEvent' | 'endEvent' | 'task' | 'exclusiveGateway' }
export interface GFlow { id: string; name: string | undefined; source: string; target: string }
export interface Edge { from: string; to: string; condition: string }

export const edgeKey = (e: Edge): string => JSON.stringify([e.from, e.to, e.condition]);

export interface Collapsed {
  edges: Edge[];
  /** Кроки, з яких виходить кілька ліній без шлюзу (неявне паралельне розгалуження). */
  implicitSplits: { stepId: string; count: number }[];
}

export function stepIdOfTask(id: string): string | null {
  return id.startsWith(TASK_PREFIX) ? id.slice(TASK_PREFIX.length) : null;
}

export function collapse(nodes: Map<string, GNode>, flows: GFlow[]): Collapsed {
  const bySource = new Map<string, GFlow[]>();
  for (const f of flows) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);
  const target = (id: string): string | null => {
    const n = nodes.get(id);
    if (!n) return null;
    if (n.tag === 'task') return stepIdOfTask(n.id) ?? `?${n.id}`;
    if (n.tag === 'endEvent') return 'END';
    return `?${n.id}`;
  };
  const edges: Edge[] = [];
  const implicitSplits: Collapsed['implicitSplits'] = [];
  for (const n of nodes.values()) {
    if (n.tag !== 'task') continue;
    const stepId = stepIdOfTask(n.id);
    if (stepId === null) continue;
    const outs = bySource.get(n.id) ?? [];
    if (outs.length > 1) implicitSplits.push({ stepId, count: outs.length });
    for (const f of outs) {
      const tgt = nodes.get(f.target);
      if (tgt?.tag === 'exclusiveGateway') {
        for (const g of bySource.get(tgt.id) ?? []) {
          const to = target(g.target);
          if (to !== null) edges.push({ from: stepId, to, condition: g.name ?? '' });
        }
      } else {
        const to = target(f.target);
        if (to !== null) edges.push({ from: stepId, to, condition: f.name ?? '' });
      }
    }
  }
  return { edges, implicitSplits };
}

/** Порівняння множин переходів як мультимножин: що втрачено і що зайве. */
export function diffEdges(expected: Edge[], actual: Edge[]): { missing: Edge[]; extra: Edge[] } {
  const count = (list: Edge[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of list) m.set(edgeKey(e), (m.get(edgeKey(e)) ?? 0) + 1);
    return m;
  };
  const expC = count(expected), actC = count(actual);
  const missing: Edge[] = [], extra: Edge[] = [];
  for (const e of expected) if ((actC.get(edgeKey(e)) ?? 0) < (expC.get(edgeKey(e)) ?? 0) && !missing.some((x) => edgeKey(x) === edgeKey(e))) missing.push(e);
  for (const e of actual) if ((expC.get(edgeKey(e)) ?? 0) < (actC.get(edgeKey(e)) ?? 0) && !extra.some((x) => edgeKey(x) === edgeKey(e))) extra.push(e);
  return { missing, extra };
}
