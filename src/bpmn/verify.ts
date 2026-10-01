/**
 * Звірка готового `.bpmn` із погодженим пакетом (технічний план §1а–1б).
 *
 * Принцип: перевіряється ФАЙЛ, а не генератор. Файл розбирається назад у граф і порівнюється з пакетом;
 * все, чого немає в пакеті, — відхилення, а все, що пакет вимагає й чого немає у файлі, — втрата.
 */
import { TASK_PREFIX, ID, GENERATOR_NAME } from './ids.ts';
import { readBpmn, type BpmnModel, type FlowNode } from './read.ts';
import { checkGeometry } from './geometry.ts';
import { collapse, diffEdges, edgeKey, type Edge, type GNode } from './graph.ts';
import { TO_DEFINE_RE } from './text.ts';
import { poolNameOf, type ApprovedPackage, type Issue, type StepMapRow, type VerifyReport } from './types.ts';

const clip = (t: string, n = 50): string => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
const q = (t: string | undefined): string => (t === undefined ? '(немає)' : `«${clip(t)}»`);
const err = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'error', message, refs });

const key = edgeKey;

/** Очікувані переходи кроків: «крок → крок / END» з умовою. */
export function expectedTransitions(pkg: ApprovedPackage): Edge[] {
  const out: Edge[] = [];
  for (const s of pkg.content.steps) {
    const branching = s.next.length >= 2;
    for (const nx of s.next) out.push({ from: s.id, to: nx.to, condition: branching ? nx.condition : '' });
  }
  return out;
}

export interface VerifyOutcome {
  report: VerifyReport;
  model: BpmnModel | null;
  map: StepMapRow[];
}

export function verifyBpmn(xml: string, pkg: ApprovedPackage): VerifyOutcome {
  const read = readBpmn(xml);
  const errors: Issue[] = [...read.issues];
  const warnings: Issue[] = [];
  const finish = (model: BpmnModel | null, map: StepMapRow[] = []): VerifyOutcome => {
    const e = errors.filter((i) => i.severity === 'error');
    const w = [...errors.filter((i) => i.severity === 'warning'), ...warnings];
    return { report: { ok: e.length === 0, errors: e, warnings: w }, model, map };
  };
  const m = read.model;
  if (!m) return finish(null);

  const c = pkg.content;
  const stepById = new Map(c.steps.map((s) => [s.id, s]));
  const stepRef = (id: string): string => {
    const s = stepById.get(id);
    return s ? `${id} («${clip(s.action, 30)}»)` : id;
  };

  // ── прив'язка до версії ──
  if (!m.binding) {
    errors.push(err('BINDING_MISSING', 'У файлі немає прив’язки до погодженої версії AS-IS (ID і хеш): невідомо, на якій версії побудовано схему.'));
  } else {
    if (m.binding.versionId !== pkg.versionId) errors.push(err('BINDING_MISMATCH', `Схему побудовано на іншій версії: у файлі ${q(m.binding.versionId)}, погоджена — ${q(pkg.versionId)}.`));
    if (m.binding.contentHash !== pkg.contentHash) errors.push(err('BINDING_MISMATCH', 'Хеш версії у файлі не збігається з хешем погодженої версії: схему побудовано на іншому змісті.'));
    if (m.binding.origin !== pkg.origin) errors.push(err('BINDING_MISMATCH', `Позначка походження у файлі ${q(m.binding.origin)} не збігається з пакетом ${q(pkg.origin)}.`));
    if (m.binding.generator !== GENERATOR_NAME) errors.push(err('BINDING_MISMATCH', `Невідомий генератор у прив’язці: ${q(m.binding.generator)}.`));
  }

  // ── структура: один пул, один процес, унікальні ID ──
  if (m.collaborationCount !== 1) errors.push(err('STRUCTURE', `У файлі ${m.collaborationCount} елементів collaboration, а має бути один.`));
  if (m.processCount !== 1) errors.push(err('STRUCTURE', `У файлі ${m.processCount} процесів, а має бути один.`));
  if (!m.participant) errors.push(err('STRUCTURE', 'У файлі немає учасника (пулу).'));
  else {
    if (m.participant.processRef !== m.processId) errors.push(err('STRUCTURE', 'Пул посилається не на процес зі схеми.'));
    if ((m.participant.name ?? '') !== poolNameOf(pkg)) errors.push(err('POOL_NAME_MISMATCH', `Назва пулу у файлі ${q(m.participant.name)} не збігається з назвою процесу у версії ${q(poolNameOf(pkg))}.`));
  }
  const seenIds = new Set<string>();
  for (const id of m.allIds) {
    if (seenIds.has(id)) errors.push(err('DUPLICATE_ID', `ID «${id}» у файлі повторюється: такі елементи неможливо розрізнити, один «затирає» інший.`, [id]));
    seenIds.add(id);
  }
  for (const n of m.allNames) {
    if (TO_DEFINE_RE.test(n.name)) errors.push(err('TO_DEFINE_IN_FILE', `У назві елемента ${n.id} є «[TO DEFINE …]»: невизначене місце потрапило на схему.`, [n.id]));
  }

  // ── кроки ↔ задачі ──
  const tasks = [...m.nodes.values()].filter((n) => n.tag === 'task');
  const taskByStep = new Map<string, FlowNode>();
  for (const t of tasks) {
    const stepId = t.id.startsWith(TASK_PREFIX) ? t.id.slice(TASK_PREFIX.length) : null;
    if (stepId === null || !stepById.has(stepId)) {
      errors.push(err('TASK_EXTRA', `У схемі є зайва задача ${q(t.name)} (ID ${t.id}), якої немає серед погоджених кроків: ID задачі має бути «${TASK_PREFIX}<ID кроку>».`, [t.id]));
      continue;
    }
    taskByStep.set(stepId, t);
  }
  for (const s of c.steps) {
    const t = taskByStep.get(s.id);
    if (!t) { errors.push(err('TASK_MISSING', `Крок ${stepRef(s.id)} відсутній у схемі: немає задачі ${ID.task(s.id)}.`, [s.id])); continue; }
    if ((t.name ?? '') !== s.action) {
      errors.push(err('TASK_NAME_MISMATCH', `Дія кроку ${s.id} змінена: погоджено «${clip(s.action, 80)}», а у схемі ${q(t.name)}.`, [s.id]));
    }
  }

  // ── доріжки ↔ ролі ──
  const laneByName = new Map<string, string[]>();
  for (const l of m.lanes) laneByName.set(l.name ?? '', [...(laneByName.get(l.name ?? '') ?? []), l.id]);
  for (const role of c.roles) {
    const ids = laneByName.get(role) ?? [];
    if (ids.length === 0) errors.push(err('LANE_MISSING', `Для погодженої ролі «${clip(role)}» немає доріжки.`));
    if (ids.length > 1) errors.push(err('LANE_DUPLICATE', `Для ролі «${clip(role)}» є ${ids.length} доріжки замість однієї.`, ids));
  }
  for (const l of m.lanes) {
    if (!c.roles.includes(l.name ?? '')) errors.push(err('LANE_EXTRA', `У схемі є доріжка ${q(l.name)}, якої немає серед погоджених ролей.`, [l.id]));
  }
  const nodeLane = new Map<string, string[]>();
  for (const l of m.lanes) {
    for (const r of l.refs) {
      if (!m.nodes.has(r)) errors.push(err('LANE_BAD_REF', `Доріжка ${q(l.name)} посилається на неіснуючий елемент «${r}».`, [l.id]));
      nodeLane.set(r, [...(nodeLane.get(r) ?? []), l.id]);
    }
  }
  const laneName = (laneId: string): string | undefined => m.lanes.find((l) => l.id === laneId)?.name;
  for (const n of m.nodes.values()) {
    const ls = nodeLane.get(n.id) ?? [];
    if (ls.length === 0) errors.push(err('NODE_NO_LANE', `Елемент ${n.id} не належить жодній доріжці.`, [n.id]));
    else if (ls.length > 1) errors.push(err('NODE_MULTI_LANE', `Елемент ${n.id} належить кільком доріжкам.`, [n.id]));
  }
  for (const [stepId, t] of taskByStep) {
    const ls = nodeLane.get(t.id) ?? [];
    const expected = stepById.get(stepId)!.role;
    if (ls.length === 1 && laneName(ls[0]!) !== expected) {
      errors.push(err('TASK_WRONG_LANE', `Крок ${stepRef(stepId)} лежить у доріжці ${q(laneName(ls[0]!))}, а його роль — «${clip(expected)}».`, [stepId]));
    }
  }

  // ── потік: початок, кінці, шлюзи, переходи ──
  const flowsBySource = new Map<string, typeof m.flows>();
  const flowsByTarget = new Map<string, typeof m.flows>();
  for (const f of m.flows) {
    flowsBySource.set(f.source, [...(flowsBySource.get(f.source) ?? []), f]);
    flowsByTarget.set(f.target, [...(flowsByTarget.get(f.target) ?? []), f]);
    if (!m.nodes.has(f.source)) errors.push(err('FLOW_BAD_REF', `Перехід ${f.id} виходить з неіснуючого елемента «${f.source}».`, [f.id]));
    if (!m.nodes.has(f.target)) errors.push(err('FLOW_BAD_REF', `Перехід ${f.id} веде до неіснуючого елемента «${f.target}».`, [f.id]));
  }
  // incoming/outgoing у вузлах мають збігатися з реальними переходами
  for (const n of m.nodes.values()) {
    const out = (flowsBySource.get(n.id) ?? []).map((f) => f.id).sort().join(',');
    const inn = (flowsByTarget.get(n.id) ?? []).map((f) => f.id).sort().join(',');
    if ([...n.outgoing].sort().join(',') !== out || [...n.incoming].sort().join(',') !== inn) {
      errors.push(err('FLOW_REFS_INCONSISTENT', `Списки вхідних/вихідних ліній елемента ${n.id} не збігаються з фактичними переходами.`, [n.id]));
    }
  }

  const starts = [...m.nodes.values()].filter((n) => n.tag === 'startEvent');
  if (starts.length !== 1) errors.push(err('START_COUNT', `Початкових подій ${starts.length}, а має бути одна (початок задається лише полем entry_step_id).`));
  const entryId = c.entry_step_id ?? '';
  const start = starts[0];
  if (start) {
    if ((start.name ?? '') !== c.boundaries.trigger) errors.push(err('START_NAME_MISMATCH', `Назва початкової події ${q(start.name)} не збігається з тригером ${q(c.boundaries.trigger)}.`, [start.id]));
    const so = flowsBySource.get(start.id) ?? [];
    if ((flowsByTarget.get(start.id) ?? []).length) errors.push(err('START_HAS_INCOMING', 'У початкову подію входить перехід.', [start.id]));
    if (so.length !== 1) errors.push(err('START_FLOW', `З початкової події виходить ${so.length} переходів, а має бути один — у початковий крок ${entryId}.`, [start.id]));
    else {
      if (so[0]!.target !== ID.task(entryId)) errors.push(err('START_WRONG_ENTRY', `Початкова подія веде в ${so[0]!.target}, а початковий крок за описом — ${stepRef(entryId)}.`, [start.id]));
      if (so[0]!.name) errors.push(err('START_FLOW_LABELED', 'Лінія з початкової події має підпис, якого немає в описі.', [so[0]!.id]));
    }
  }
  for (const n of m.nodes.values()) {
    if (n.tag === 'endEvent') {
      if (n.name) errors.push(err('END_NAMED', `Кінцева подія ${n.id} має назву ${q(n.name)}, якої немає в описі.`, [n.id]));
      if ((flowsBySource.get(n.id) ?? []).length) errors.push(err('END_HAS_OUTGOING', `З кінцевої події ${n.id} виходить перехід.`, [n.id]));
      if ((flowsByTarget.get(n.id) ?? []).length === 0) errors.push(err('END_UNREACHED', `У кінцеву подію ${n.id} не входить жоден перехід.`, [n.id]));
    }
    if (n.tag === 'exclusiveGateway') {
      if (n.name) errors.push(err('GATEWAY_NAMED', `Шлюз ${n.id} має назву ${q(n.name)}: технічні елементи не мають власного тексту.`, [n.id]));
      const inn = flowsByTarget.get(n.id) ?? [];
      const outg = flowsBySource.get(n.id) ?? [];
      const owner = n.id.replace(/^Gateway_/, '');
      if (!n.id.startsWith('Gateway_') || !stepById.has(owner)) errors.push(err('GATEWAY_EXTRA', `У схемі є зайвий шлюз ${n.id}, який не відповідає жодному кроку з розгалуженням.`, [n.id]));
      else if ((stepById.get(owner)?.next.length ?? 0) < 2) errors.push(err('GATEWAY_EXTRA', `Шлюз ${n.id} стоїть після кроку ${stepRef(owner)}, який не має розгалуження.`, [n.id]));
      if (inn.length !== 1 || m.nodes.get(inn[0]!.source)?.tag !== 'task') errors.push(err('GATEWAY_SHAPE', `У шлюз ${n.id} має входити рівно один перехід — із задачі.`, [n.id]));
      if (outg.length < 2) errors.push(err('GATEWAY_SHAPE', `Шлюз ${n.id} має ${outg.length} вихід(и): розгалуження потребує щонайменше двох.`, [n.id]));
      if (outg.some((f) => !f.name)) errors.push(err('GATEWAY_SHAPE', `Вихід шлюзу ${n.id} без підпису умови.`, [n.id]));
    }
  }

  // зворот графа: згортання шлюзів
  const nodeTarget = (id: string): string | null => {
    const n = m.nodes.get(id);
    if (!n) return null;
    if (n.tag === 'task') return n.id.startsWith(TASK_PREFIX) ? n.id.slice(TASK_PREFIX.length) : `?${n.id}`;
    if (n.tag === 'endEvent') return 'END';
    return `?${n.id}`;
  };
  const collapsed = collapse(new Map<string, GNode>([...m.nodes].map(([id, n]) => [id, { id, tag: n.tag }])), m.flows);
  for (const sp of collapsed.implicitSplits) {
    errors.push(err('IMPLICIT_SPLIT', `З задачі ${stepRef(sp.stepId)} виходить ${sp.count} ліній без шлюзу: це неявне паралельне розгалуження, якого немає в описі.`, [sp.stepId]));
  }
  const actual: Edge[] = collapsed.edges;
  const expected = expectedTransitions(pkg);
  const { missing, extra } = diffEdges(expected, actual);
  // цикли очікуваного графа — для пояснення втраченого повернення
  const onCycle = (e: Edge): boolean => {
    if (e.to === 'END') return false;
    const seen = new Set<string>([e.to]);
    const queue = [e.to];
    while (queue.length) {
      const x = queue.shift()!;
      if (x === e.from) return true;
      for (const nx of stepById.get(x)?.next ?? []) if (nx.to !== 'END' && !seen.has(nx.to)) { seen.add(nx.to); queue.push(nx.to); }
    }
    return false;
  };
  const paired = new Set<string>();
  for (const mi of missing) {
    const ex = extra.find((x) => x.from === mi.from && x.to === mi.to && !paired.has(key(x)));
    if (ex) {
      paired.add(key(ex));
      errors.push(err('CONDITION_MISMATCH', `Умову переходу ${mi.from} → ${mi.to} змінено: погоджено ${q(mi.condition || '(без умови)')}, а у схемі ${q(ex.condition || '(без умови)')}.`, [mi.from]));
    } else if (onCycle(mi)) {
      errors.push(err('LOOP_LOST', `Втрачено повернення (цикл) ${mi.from} → ${mi.to}${mi.condition ? ` за умовою ${q(mi.condition)}` : ''}: у схемі цього переходу немає.`, [mi.from]));
    } else {
      errors.push(err('TRANSITION_MISSING', `Втрачено перехід ${mi.from} → ${mi.to}${mi.condition ? ` за умовою ${q(mi.condition)}` : ''}: його немає у схемі.`, [mi.from]));
    }
  }
  for (const ex of extra) {
    if (paired.has(key(ex))) continue;
    errors.push(err('TRANSITION_EXTRA', `У схемі є перехід ${ex.from} → ${ex.to}${ex.condition ? ` за умовою ${q(ex.condition)}` : ''}, якого немає в погодженому описі.`, [ex.from]));
  }

  // ── повнота й зв'язність за самим файлом ──
  if (start) {
    const reach = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const x = queue.shift()!;
      for (const f of flowsBySource.get(x) ?? []) if (m.nodes.has(f.target) && !reach.has(f.target)) { reach.add(f.target); queue.push(f.target); }
    }
    const unreachable = [...m.nodes.keys()].filter((id) => !reach.has(id));
    if (unreachable.length) errors.push(err('UNREACHABLE_IN_FILE', `Недосяжні від початку елементи: ${unreachable.join(', ')}.`, unreachable));
    const canEnd = new Set<string>([...m.nodes.values()].filter((n) => n.tag === 'endEvent').map((n) => n.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of m.flows) if (canEnd.has(f.target) && !canEnd.has(f.source) && m.nodes.has(f.source)) { canEnd.add(f.source); grew = true; }
    }
    const stuck = [...m.nodes.keys()].filter((id) => reach.has(id) && !canEnd.has(id));
    if (stuck.length) errors.push(err('NO_PATH_TO_END', `З елементів ${stuck.join(', ')} неможливо дійти до жодної кінцевої події (глухий кут чи замкнений цикл).`, stuck));
  }

  // ── технічні елементи в доріжках власного кроку ──
  const ownerLaneRole = (nodeId: string): string | undefined => {
    const n = m.nodes.get(nodeId);
    if (!n) return undefined;
    if (n.tag === 'startEvent') return stepById.get(entryId)?.role;
    if (n.tag === 'exclusiveGateway') return stepById.get(nodeId.replace(/^Gateway_/, ''))?.role;
    if (n.tag === 'endEvent') {
      const src = (flowsByTarget.get(nodeId) ?? [])[0]?.source;
      if (!src) return undefined;
      const sn = m.nodes.get(src);
      const sid = sn?.tag === 'task' ? src.slice(TASK_PREFIX.length) : src.replace(/^Gateway_/, '');
      return stepById.get(sid)?.role;
    }
    return undefined;
  };
  for (const n of m.nodes.values()) {
    if (n.tag === 'task') continue;
    const ls = nodeLane.get(n.id) ?? [];
    const role = ownerLaneRole(n.id);
    if (ls.length === 1 && role !== undefined && laneName(ls[0]!) !== role) {
      errors.push(err('TECH_WRONG_LANE', `Технічний елемент ${n.id} лежить у доріжці ${q(laneName(ls[0]!))}, а має — у доріжці свого кроку («${clip(role)}»).`, [n.id]));
    }
  }

  // ── геометрія ──
  const nameOf = (id: string): string => {
    if (id.startsWith(TASK_PREFIX) && stepById.has(id.slice(TASK_PREFIX.length))) return `задачі ${stepRef(id.slice(TASK_PREFIX.length))}`;
    const lane = m.lanes.find((l) => l.id === id);
    if (lane) return `доріжки «${clip(lane.name ?? '', 30)}»`;
    const f = m.flows.find((x) => x.id === id);
    if (f) return `${f.id}${f.name ? ` («${clip(f.name, 30)}»)` : ''}`;
    return id;
  };
  const geo = checkGeometry(m, {
    nameOf,
    actionOfTask: (id) => stepById.get(id.slice(TASK_PREFIX.length))?.action,
    roleOfLane: (id) => m.lanes.find((l) => l.id === id)?.name,
    poolName: poolNameOf(pkg),
  });
  for (const i of geo) (i.severity === 'error' ? errors : warnings).push(i);

  // ── карта «крок ↔ елемент» ──
  const map: StepMapRow[] = c.steps.map((s) => {
    const t = taskByStep.get(s.id);
    const lanes = t ? nodeLane.get(t.id) ?? [] : [];
    const branching = s.next.length >= 2;
    const outs = t ? flowsBySource.get(t.id) ?? [] : [];
    const gw = branching && outs[0] && m.nodes.get(outs[0].target)?.tag === 'exclusiveGateway' ? outs[0].target : null;
    const branchFlows = gw ? flowsBySource.get(gw) ?? [] : outs;
    return {
      step_id: s.id, role: s.role, action: s.action,
      bpmn_task_id: t?.id ?? '', lane_id: lanes[0] ?? '', gateway_id: gw, drawio_cell_id: null,
      outgoing: branchFlows.map((f) => ({
        condition: branching ? f.name ?? '' : '', to: nodeTarget(f.target) ?? f.target, flow_id: f.id, target_element_id: f.target,
      })),
    };
  });
  return finish(m, map);
}
