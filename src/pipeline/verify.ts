/**
 * Зворотна перевірка ГОТОВИХ файлів проти погодженого опису AS-IS (а не проти таблиці).
 *
 * Навіщо проти опису: таблиця вже перевірена, але між таблицею й файлом стоять три скрипти. Якщо котрийсь
 * із них загубить крок, підпис, умову чи доріжку, це має бути помилкою побудови, а не непоміченою втратою.
 * Тому файл розбирається незалежно й порівнюється з тим самим погодженим описом, що й таблиця.
 *
 * Перевіряється зміст (елементи, підписи, ролі, переходи, повний текст у деталях події), геометрія
 * (усе в межах доріжки, підписи не накладаються, текст уміщується) і відповідність `.drawio` файлу `.bpmn`.
 */
import { attr, childText, elementChildren, parseXml, walk, XmlError, type XmlElement } from '../bpmn/xml.ts';
import { LINE_HEIGHT, wrapLines } from '../bpmn/text.ts';
import type { ApprovedPackage, Issue, StepMapRow } from '../bpmn/types.ts';
import { START_ID, endId, expectedEdges, gatewayId, taskId, type CsvPlan } from '../csv/check.ts';

const TASK_TAGS = new Set(['task', 'userTask', 'serviceTask', 'manualTask', 'scriptTask', 'sendTask', 'receiveTask', 'businessRuleTask']);
const EVENT_TAGS = new Set(['startEvent', 'endEvent']);
const GATEWAY_TAGS = new Set(['exclusiveGateway']);
/** Елементи, яких у схемі v1 бути не може: їхня поява означає, що скрипт домалював нотацію. */
const FORBIDDEN_TAGS = new Set(['parallelGateway', 'inclusiveGateway', 'complexGateway', 'eventBasedGateway',
  'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'subProcess', 'callActivity',
  'dataObjectReference', 'dataStoreReference', 'textAnnotation', 'messageFlow']);

export interface Box { x: number; y: number; w: number; h: number }
export interface NodeInfo { id: string; tag: string; name: string; documentation: string; lane: string | null; box: Box | null; label: Box | null }
export interface FlowInfo { id: string; name: string; source: string; target: string; points: { x: number; y: number }[]; label: Box | null }

export interface BpmnModel {
  /** ID учасника (пулу) у `.bpmn` — за ним шукається клітинка пулу в `.drawio`. */
  poolId: string;
  poolName: string;
  poolBox: Box | null;
  lanes: { id: string; name: string; box: Box | null; refs: string[] }[];
  nodes: Map<string, NodeInfo>;
  flows: FlowInfo[];
}

const err = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'error', message, refs });
const warn = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'warning', message, refs });

function boundsOf(el: XmlElement): Box | null {
  for (const ch of elementChildren(el)) {
    if (ch.local === 'Bounds') {
      const x = Number(attr(ch, 'x')), y = Number(attr(ch, 'y')), w = Number(attr(ch, 'width')), h = Number(attr(ch, 'height'));
      if ([x, y, w, h].every(Number.isFinite)) return { x, y, w, h };
    }
  }
  return null;
}

function labelBoundsOf(el: XmlElement): Box | null {
  for (const ch of elementChildren(el)) if (ch.local === 'BPMNLabel') return boundsOf(ch);
  return null;
}

export function readPipelineBpmn(xml: string): { model: BpmnModel | null; issues: Issue[] } {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    return { model: null, issues: [err('XML_MALFORMED', `Файл .bpmn не є коректним XML: ${e instanceof XmlError ? e.message : String(e)}`)] };
  }
  const issues: Issue[] = [];
  const nodes = new Map<string, NodeInfo>();
  const flows: FlowInfo[] = [];
  const lanes: BpmnModel['lanes'] = [];
  let poolName = '';
  let poolId = '';
  const laneOf = new Map<string, string>();

  walk(root, (e) => {
    if (e.local === 'participant') { poolName = attr(e, 'name') ?? ''; poolId = attr(e, 'id') ?? ''; }
    if (e.local === 'lane') {
      const refs = elementChildren(e).filter((c) => c.local === 'flowNodeRef').map((c) => childText(c).trim());
      lanes.push({ id: attr(e, 'id') ?? '', name: attr(e, 'name') ?? '', box: null, refs });
      for (const r of refs) laneOf.set(r, attr(e, 'name') ?? '');
    }
    if (e.local === 'sequenceFlow') {
      flows.push({ id: attr(e, 'id') ?? '', name: attr(e, 'name') ?? '', source: attr(e, 'sourceRef') ?? '', target: attr(e, 'targetRef') ?? '', points: [], label: null });
    }
    if (TASK_TAGS.has(e.local) || EVENT_TAGS.has(e.local) || GATEWAY_TAGS.has(e.local) || FORBIDDEN_TAGS.has(e.local)) {
      const id = attr(e, 'id') ?? '';
      const doc = elementChildren(e).find((c) => c.local === 'documentation');
      nodes.set(id, { id, tag: e.local, name: attr(e, 'name') ?? '', documentation: doc ? childText(doc) : '', lane: null, box: null, label: null });
    }
  });
  for (const [id, n] of nodes) n.lane = laneOf.get(id) ?? null;

  let poolBox: Box | null = null;
  walk(root, (e) => {
    if (e.local === 'BPMNShape') {
      const ref = attr(e, 'bpmnElement') ?? '';
      const box = boundsOf(e);
      if (ref === poolId) { poolBox = box; return; }
      const lane = lanes.find((l) => l.id === ref);
      if (lane) { lane.box = box; return; }
      const n = nodes.get(ref);
      if (n) { n.box = box; n.label = labelBoundsOf(e); }
    }
    if (e.local === 'BPMNEdge') {
      const f = flows.find((x) => x.id === attr(e, 'bpmnElement'));
      if (!f) return;
      f.points = elementChildren(e).filter((c) => c.local === 'waypoint')
        .map((c) => ({ x: Number(attr(c, 'x')), y: Number(attr(c, 'y')) }));
      f.label = labelBoundsOf(e);
    }
  });
  return { model: { poolId, poolName, poolBox, lanes, nodes, flows }, issues };
}

const overlap = (a: Box, b: Box, pad = 0): boolean =>
  a.x + pad < b.x + b.w && b.x + pad < a.x + a.w && a.y + pad < b.y + b.h && b.y + pad < a.y + a.h;

const inside = (inner: Box, outer: Box, slack = 1): boolean =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack
  && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;

/** Згортання рядків-шлюзів: переходи «крок → крок/кінець» з умовою. */
function collapse(model: BpmnModel): { from: string; to: string; condition: string }[] {
  const bySource = new Map<string, FlowInfo[]>();
  for (const f of model.flows) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);
  const out: { from: string; to: string; condition: string }[] = [];
  for (const n of model.nodes.values()) {
    if (!TASK_TAGS.has(n.tag)) continue;
    for (const f of bySource.get(n.id) ?? []) {
      const tgt = model.nodes.get(f.target);
      if (tgt && GATEWAY_TAGS.has(tgt.tag)) {
        for (const g of bySource.get(tgt.id) ?? []) out.push({ from: n.id, to: g.target, condition: g.name });
      } else {
        out.push({ from: n.id, to: f.target, condition: f.name });
      }
    }
  }
  return out;
}

export interface VerifyOutcome { issues: Issue[]; warnings: Issue[]; map: StepMapRow[]; model: BpmnModel | null }

/** Звірка .bpmn з погодженим описом. */
export function verifyBpmnAgainstPackage(xml: string, pkg: ApprovedPackage, plan: CsvPlan): VerifyOutcome {
  const read = readPipelineBpmn(xml);
  if (!read.model) return { issues: read.issues, warnings: [], map: [], model: null };
  const m = read.model;
  const issues: Issue[] = [...read.issues];
  const warnings: Issue[] = [];
  const c = pkg.content;

  if (m.poolName !== (c.process_name ?? '')) {
    issues.push(err('POOL_NAME', `Напис на пулі «${m.poolName}» не збігається з назвою процесу погодженої версії «${c.process_name ?? ''}».`));
  }
  // ── склад елементів ──
  for (const n of m.nodes.values()) {
    if (FORBIDDEN_TAGS.has(n.tag)) issues.push(err('EXTRA_NOTATION', `У схемі є елемент «${n.tag}» (${n.id}), якого цей шлях не будує.`, [n.id]));
  }
  for (const s of c.steps) {
    const n = m.nodes.get(taskId(s.id));
    if (!n) { issues.push(err('STEP_MISSING', `Кроку ${s.id} («${s.action}») у схемі немає.`, [s.id])); continue; }
    if (!TASK_TAGS.has(n.tag)) issues.push(err('STEP_TAG', `Крок ${s.id}: елемент має тип «${n.tag}», очікується задача.`, [s.id]));
    if (n.name !== s.action) issues.push(err('STEP_LABEL', `Крок ${s.id}: підпис у схемі «${n.name}» не збігається з дією погодженого опису «${s.action}».`, [s.id]));
    if ((n.lane ?? '') !== s.role) issues.push(err('STEP_LANE', `Крок ${s.id}: доріжка «${n.lane ?? '—'}» не збігається з роллю «${s.role}».`, [s.id]));
  }
  const taskIds = [...m.nodes.values()].filter((n) => TASK_TAGS.has(n.tag)).map((n) => n.id);
  for (const id of taskIds) if (!c.steps.some((s) => taskId(s.id) === id)) issues.push(err('EXTRA_STEP', `У схемі є задача «${id}», якої немає в погодженому описі.`, [id]));

  // ── доріжки: лише ролі з діями, у порядку погодженого списку ролей ──
  const laneNames = m.lanes.map((l) => l.name);
  if (JSON.stringify(laneNames) !== JSON.stringify(plan.lanes)) {
    issues.push(err('LANES', `Доріжки схеми [${laneNames.join(', ')}] не збігаються з ролями, що мають дії [${plan.lanes.join(', ')}].`));
  }

  // ── початкова подія ──
  const start = m.nodes.get(START_ID);
  if (!start || start.tag !== 'startEvent') issues.push(err('START_MISSING', 'У схемі немає початкової події з ID START.'));
  else {
    if (start.name !== plan.startLabel) issues.push(err('START_LABEL', `Підпис початкової події «${start.name}» не збігається з погодженим «${plan.startLabel}».`, [START_ID]));
    const full = plan.startDocumentation;
    if (full !== null && start.documentation !== full) {
      issues.push(err('START_DOC', 'Повного тексту тригера немає в деталях початкової події або він змінений: коротким підписом погоджений текст не замінюється.', [START_ID]));
    }
    if (full === null && start.documentation !== '' && start.documentation !== plan.startLabel) {
      warnings.push(warn('START_DOC_EXTRA', 'У деталях початкової події є текст, якого не очікували.', [START_ID]));
    }
  }

  // ── переходи ──
  const got = collapse(m);
  const want = expectedEdges(c);
  const key = (e: { from: string; to: string; condition: string }): string => JSON.stringify([e.from, e.to, e.condition]);
  const gotSet = new Map<string, number>(), wantSet = new Map<string, number>();
  for (const e of got) gotSet.set(key(e), (gotSet.get(key(e)) ?? 0) + 1);
  for (const e of want) wantSet.set(key(e), (wantSet.get(key(e)) ?? 0) + 1);
  for (const [k, n] of wantSet) if ((gotSet.get(k) ?? 0) < n) { const e = JSON.parse(k) as string[]; issues.push(err('EDGE_MISSING', `У схемі немає переходу ${e[0]} → ${e[1]}${e[2] ? ` («${e[2]}»)` : ''}.`, [e[0]!])); }
  for (const [k, n] of gotSet) if ((wantSet.get(k) ?? 0) < n) { const e = JSON.parse(k) as string[]; issues.push(err('EDGE_EXTRA', `У схемі є зайвий перехід ${e[0]} → ${e[1]}${e[2] ? ` («${e[2]}»)` : ''}.`, [e[0]!])); }

  // ── геометрія: усе в межах доріжки, нічого не накладається, текст уміщується ──
  const boxes: { id: string; box: Box }[] = [];
  for (const n of m.nodes.values()) {
    if (!n.box) { issues.push(err('NO_GEOMETRY', `Елемент ${n.id} не має координат.`, [n.id])); continue; }
    boxes.push({ id: n.id, box: n.box });
    const lane = m.lanes.find((l) => l.name === (n.lane ?? ''))?.box ?? m.poolBox;
    if (lane && !inside(n.box, lane)) issues.push(err('OUT_OF_LANE', `Елемент ${n.id} виходить за межі своєї доріжки.`, [n.id]));
    if (n.label) {
      boxes.push({ id: `${n.id}:підпис`, box: n.label });
      if (lane && !inside(n.label, lane)) issues.push(err('LABEL_OUT_OF_LANE', `Підпис елемента ${n.id} виходить за межі доріжки.`, [n.id]));
      const lines = wrapLines(n.name, Math.max(20, n.label.w - 8)).length;
      if (lines * LINE_HEIGHT > n.label.h + 1) issues.push(err('LABEL_CLIPPED', `Підпис елемента ${n.id} не вміщується в рамку: потрібно ${Math.ceil(lines * LINE_HEIGHT)} px, рамка ${n.label.h} px.`, [n.id]));
    } else if (TASK_TAGS.has(n.tag) && n.name) {
      const lines = wrapLines(n.name, Math.max(20, n.box.w - 20)).length;
      if (lines * LINE_HEIGHT + 20 > n.box.h + 1) issues.push(err('LABEL_CLIPPED', `Підпис задачі ${n.id} не вміщується у фігуру: потрібно ${Math.ceil(lines * LINE_HEIGHT + 20)} px, фігура ${n.box.h} px.`, [n.id]));
    }
  }
  for (const f of m.flows) if (f.label) boxes.push({ id: `перехід ${f.id}:підпис`, box: f.label });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a.id.split(':')[0] === b.id.split(':')[0]) continue; // фігура і її власний підпис
      if (overlap(a.box, b.box, 2)) warnings.push(warn('OVERLAP', `Накладаються: ${a.id} і ${b.id}.`, [a.id]));
    }
  }

  // ── карта «крок ↔ елемент» ──
  const map: StepMapRow[] = c.steps.map((s) => {
    // Кожен перехід отримує СВОЮ лінію: дві різні умови в ту саму ціль — це дві різні лінії,
    // тому вже використану лінію другий раз не беремо (інакше ID у карті повторились би).
    const used = new Set<string>();
    const pick = (target: string, condition: string): string => {
      const f = m.flows.find((x) => !used.has(x.id)
        && (x.source === taskId(s.id) || x.source === gatewayId(s.id))
        && x.target === target && x.name === condition);
      if (f) used.add(f.id);
      return f?.id ?? '';
    };
    return {
      step_id: s.id, role: s.role, action: s.action,
      bpmn_task_id: taskId(s.id),
      lane_id: m.lanes.find((l) => l.name === s.role)?.id ?? '',
      gateway_id: s.next.length >= 2 ? gatewayId(s.id) : null,
      drawio_cell_id: null,
      outgoing: s.next.map((n, i) => {
        const condition = s.next.length >= 2 ? n.condition : '';
        const target = n.to === 'END' ? endId(s.id, i + 1) : taskId(n.to);
        return { condition, to: n.to, flow_id: pick(target, condition), target_element_id: target };
      }),
    };
  });

  return { issues, warnings, map, model: m };
}
