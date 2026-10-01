/**
 * Побудова семантичного BPMN (без координат) із погодженого пакета.
 *
 * Правила (D21, D26, D27; оцінка пайплайна власниці):
 *  • початок — лише `entry_step_id`; порядок кроків у пакеті змісту не має (обхід у ширину від початкового кроку);
 *  • кожен крок — одна нейтральна задача `task` з ID `Task_<ID кроку>`; дія, роль і умова — дослівно;
 *  • крок із ≥2 переходами → безіменний ексклюзивний шлюз; умови — підписи ліній;
 *  • кожне «END» — окрема безіменна кінцева подія; початкова подія названа тригером;
 *  • усі ID унікальні за конструкцією; перевіряється наприкінці;
 *  • без глобального стану, без файлів: чиста функція від пакета.
 */
import { escapeAttr } from './xml.ts';
import { GENERATOR_NAME, ID, NS } from './ids.ts';
import { poolNameOf, type ApprovedPackage } from './types.ts';

export interface SemanticBuild {
  xml: string;
  /** Усі ID елементів — для перевірки унікальності. */
  allIds: string[];
  /** Кроки в порядку обходу (детермінованому, не залежить від порядку в пакеті). */
  order: string[];
}

interface Node { id: string; tag: string; name?: string; lane: number; incoming: string[]; outgoing: string[] }
interface Flow { id: string; name: string; source: string; target: string }

export function buildSemantic(pkg: ApprovedPackage): SemanticBuild {
  const c = pkg.content;
  const entry = c.entry_step_id;
  if (!entry) throw new Error('buildSemantic: entry_step_id відсутній (валідація мала це відхилити)');
  const byId = new Map(c.steps.map((s) => [s.id, s]));
  const laneIndex = new Map(c.roles.map((r, i) => [r, i]));

  // обхід у ширину від початкового кроку, у порядку переходів (порядок рядків пакета не використовується)
  const order: string[] = [];
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const nx of byId.get(id)!.next) {
      if (nx.to !== 'END' && !seen.has(nx.to)) { seen.add(nx.to); queue.push(nx.to); }
    }
  }

  const nodes: Node[] = [];
  const flows: Flow[] = [];
  const nodeById = new Map<string, Node>();
  const addNode = (n: Omit<Node, 'incoming' | 'outgoing'>): Node => {
    const node: Node = { ...n, incoming: [], outgoing: [] };
    nodes.push(node);
    nodeById.set(node.id, node);
    return node;
  };
  const addFlow = (f: Flow): void => {
    flows.push(f);
    nodeById.get(f.source)!.outgoing.push(f.id);
    nodeById.get(f.target)?.incoming.push(f.id);
  };

  const entryLane = laneIndex.get(byId.get(entry)!.role)!;
  addNode({ id: ID.start, tag: 'startEvent', name: c.boundaries.trigger, lane: entryLane });

  // вузли
  const pendingFlows: Flow[] = [];
  pendingFlows.push({ id: ID.startFlow, name: '', source: ID.start, target: ID.task(entry) });
  for (const sid of order) {
    const s = byId.get(sid)!;
    const lane = laneIndex.get(s.role)!;
    addNode({ id: ID.task(sid), tag: 'task', name: s.action, lane });
    const branching = s.next.length >= 2;
    if (branching) {
      addNode({ id: ID.gateway(sid), tag: 'exclusiveGateway', lane });
      pendingFlows.push({ id: ID.toGateway(sid), name: '', source: ID.task(sid), target: ID.gateway(sid) });
    }
    s.next.forEach((nx, i) => {
      const k = i + 1;
      let target: string;
      if (nx.to === 'END') {
        target = ID.end(sid, k);
        addNode({ id: target, tag: 'endEvent', lane });
      } else target = ID.task(nx.to);
      pendingFlows.push({
        id: ID.branchFlow(sid, k), name: branching ? nx.condition : '',
        source: branching ? ID.gateway(sid) : ID.task(sid), target,
      });
    });
  }
  for (const f of pendingFlows) addFlow(f);

  // ── XML ──
  const out: string[] = [];
  const w = (depth: number, line: string): void => { out.push('  '.repeat(depth) + line); };
  const a = (name: string, value: string): string => ` ${name}="${escapeAttr(value)}"`;

  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  w(0, `<bpmn:definitions xmlns:bpmn="${NS.bpmn}" xmlns:bpmndi="${NS.bpmndi}" xmlns:dc="${NS.dc}" xmlns:di="${NS.di}" xmlns:cx="${NS.cx}"${a('id', ID.definitions)}${a('targetNamespace', 'urn:cx-process-agents:as-is')}>`);
  w(1, `<bpmn:collaboration${a('id', ID.collaboration)}>`);
  w(2, `<bpmn:participant${a('id', ID.participant)}${a('name', poolNameOf(pkg))}${a('processRef', ID.process)} />`);
  w(1, '</bpmn:collaboration>');
  w(1, `<bpmn:process${a('id', ID.process)}${a('isExecutable', 'false')}>`);
  w(2, '<bpmn:extensionElements>');
  w(3, `<cx:asIsBinding${a('versionId', pkg.versionId)}${a('contentHash', pkg.contentHash)}${a('origin', pkg.origin)}${a('generator', GENERATOR_NAME)} />`);
  w(2, '</bpmn:extensionElements>');
  w(2, `<bpmn:laneSet${a('id', ID.laneSet)}>`);
  c.roles.forEach((role, i) => {
    const members = nodes.filter((n) => n.lane === i);
    if (members.length === 0) {
      w(3, `<bpmn:lane${a('id', ID.lane(i))}${a('name', role)} />`);
      return;
    }
    w(3, `<bpmn:lane${a('id', ID.lane(i))}${a('name', role)}>`);
    for (const m of members) w(4, `<bpmn:flowNodeRef>${m.id}</bpmn:flowNodeRef>`);
    w(3, '</bpmn:lane>');
  });
  w(2, '</bpmn:laneSet>');
  for (const n of nodes) {
    const attrs = `${a('id', n.id)}${n.name !== undefined && n.name !== '' ? a('name', n.name) : ''}`;
    if (n.incoming.length === 0 && n.outgoing.length === 0) { w(2, `<bpmn:${n.tag}${attrs} />`); continue; }
    w(2, `<bpmn:${n.tag}${attrs}>`);
    for (const f of n.incoming) w(3, `<bpmn:incoming>${f}</bpmn:incoming>`);
    for (const f of n.outgoing) w(3, `<bpmn:outgoing>${f}</bpmn:outgoing>`);
    w(2, `</bpmn:${n.tag}>`);
  }
  for (const f of flows) {
    w(2, `<bpmn:sequenceFlow${a('id', f.id)}${f.name !== '' ? a('name', f.name) : ''}${a('sourceRef', f.source)}${a('targetRef', f.target)} />`);
  }
  w(1, '</bpmn:process>');
  w(0, '</bpmn:definitions>');

  const allIds = [
    ID.definitions, ID.collaboration, ID.participant, ID.process, ID.laneSet,
    ...c.roles.map((_, i) => ID.lane(i)), ...nodes.map((n) => n.id), ...flows.map((f) => f.id),
  ];
  const dup = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  if (dup.length) throw new Error(`buildSemantic: повторні ID елементів: ${[...new Set(dup)].join(', ')}`);
  return { xml: out.join('\n') + '\n', allIds, order };
}
