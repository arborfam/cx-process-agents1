/**
 * Експорт `.drawio` із перевіреного `.bpmn` та власна зворотна звірка (D26).
 *
 * Правила, що виправляють дефекти оригінального конвертера (docs/bpmn-pipeline-assessment.md):
 *  • ID клітинок = ID елементів .bpmn, тому ID кроків (`Task_S1`, …) збережені в самій клітинці;
 *  • підписи записуються як звичайний текст (html=0), тож «<», «&», лапки й переноси не стають розміткою;
 *  • кожен елемент і кожен перехід мають клітинку/лінію з геометрією; відсутній елемент — не мовчазний пропуск, а помилка;
 *  • лінії проходять через ті самі проміжні точки, що й у .bpmn, і виходять/входять у ті самі точки блоків;
 *  • експорт видається, лише якщо власна звірка (за пакетом, а не за самим експортом) пройшла без помилок.
 */
import { escapeAttr, parseXml, XmlError, attr, elementChildren, type XmlElement } from './xml.ts';
import { GENERATOR_NAME, ID } from './ids.ts';
import { collapse, diffEdges, type GFlow, type GNode } from './graph.ts';
import { expectedTransitions } from './verify.ts';
import { checkCellStyle, EDGE_STYLE_FIXED, GRAPH_MODEL_ATTRS, POOL_STYLE, LANE_STYLE, START_STYLE, END_STYLE, GATEWAY_STYLE, TASK_STYLE, vertexStyleOf, type CellKind } from './drawio-style.ts';
import type { BpmnModel, Rect } from './read.ts';
import { poolNameOf, type ApprovedPackage, type DrawioExport, type Issue, type StepMapRow } from './types.ts';


const n2 = (v: number): string => String(Math.round(v * 100) / 100);
const err = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'error', message, refs });

function styleMap(style: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of style.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) m.set(part, ''); else m.set(part.slice(0, i), part.slice(i + 1));
  }
  return m;
}

// ───────────────────────── експорт ─────────────────────────

export function exportDrawio(model: BpmnModel, pkg: ApprovedPackage, _map: StepMapRow[], tamper?: (xml: string) => string): DrawioExport {
  const shape = (id: string): Rect | undefined => model.shapes.get(id)?.[0];
  const pool = model.participant ? shape(model.participant.id) : undefined;
  if (!model.participant || !pool) return failed([err('DRAWIO_EXPORT', 'Немає геометрії пулу: експорт неможливий.')]);

  const out: string[] = [];
  out.push('<mxfile host="cx-process-agents" agent="' + escapeAttr(GENERATOR_NAME) + '" version="1.0">');
  out.push('  <diagram id="AS-IS" name="AS-IS">');
  out.push(`    <mxGraphModel ${Object.entries(GRAPH_MODEL_ATTRS).map(([k, v]) => `${k}="${v}"`).join(' ')}>`);
  out.push('      <root>');
  out.push('        <mxCell id="0" />');
  out.push('        <mxCell id="1" parent="0" />');
  out.push(`        <object label="${escapeAttr(poolNameOf(pkg))}" cx_version_id="${escapeAttr(pkg.versionId)}" cx_content_hash="${escapeAttr(pkg.contentHash)}" cx_origin="${escapeAttr(pkg.origin)}" cx_generator="${escapeAttr(GENERATOR_NAME)}" id="${escapeAttr(model.participant.id)}">`);
  out.push(`          <mxCell style="${POOL_STYLE}" vertex="1" parent="1"><mxGeometry x="${n2(pool.x)}" y="${n2(pool.y)}" width="${n2(pool.w)}" height="${n2(pool.h)}" as="geometry" /></mxCell>`);
  out.push('        </object>');

  const laneRect = new Map<string, Rect>();
  for (const l of model.lanes) {
    const r = shape(l.id);
    if (!r) return failed([err('DRAWIO_EXPORT', `Немає геометрії доріжки ${l.id}: експорт неможливий.`, [l.id])]);
    laneRect.set(l.id, r);
    out.push(`        <mxCell id="${escapeAttr(l.id)}" value="${escapeAttr(l.name ?? '')}" style="${LANE_STYLE}" vertex="1" parent="${escapeAttr(model.participant.id)}"><mxGeometry x="${n2(r.x - pool.x)}" y="${n2(r.y - pool.y)}" width="${n2(r.w)}" height="${n2(r.h)}" as="geometry" /></mxCell>`);
  }
  const laneOfNode = new Map<string, string>();
  for (const l of model.lanes) for (const ref of l.refs) laneOfNode.set(ref, l.id);
  for (const nd of model.nodes.values()) {
    const r = shape(nd.id);
    const laneId = laneOfNode.get(nd.id);
    const lr = laneId ? laneRect.get(laneId) : undefined;
    if (!r || !laneId || !lr) return failed([err('DRAWIO_EXPORT', `Немає геометрії чи доріжки для елемента ${nd.id}: експорт неможливий.`, [nd.id])]);
    // Для події з зовнішнім підписом ширина колонки переносу береться з рамки підпису `.bpmn` (D86).
    const lbox = model.shapeLabels.get(nd.id);
    const style = nd.tag === 'task' ? TASK_STYLE
      : nd.tag === 'startEvent' || nd.tag === 'endEvent'
        ? vertexStyleOf(nd.tag, lbox && nd.name?.trim() ? { labelWidth: lbox.w } : {})
        : GATEWAY_STYLE;
    out.push(`        <mxCell id="${escapeAttr(nd.id)}" value="${escapeAttr(nd.name ?? '')}" style="${style}" vertex="1" parent="${escapeAttr(laneId)}"><mxGeometry x="${n2(r.x - lr.x)}" y="${n2(r.y - lr.y)}" width="${n2(r.w)}" height="${n2(r.h)}" as="geometry" /></mxCell>`);
  }
  for (const f of model.flows) {
    const pts = model.edges.get(f.id)?.[0];
    const s = shape(f.source), t = shape(f.target);
    if (!pts || pts.length < 2 || !s || !t) return failed([err('DRAWIO_EXPORT', `Немає лінії чи кінців для переходу ${f.id}: експорт неможливий.`, [f.id])]);
    const a = relPoint(pts[0]!, s), b = relPoint(pts[pts.length - 1]!, t);
    const style = `${EDGE_STYLE_FIXED}exitX=${a.x};exitY=${a.y};entryX=${b.x};entryY=${b.y};`;
    const mid = pts.slice(1, -1).map((p) => `<mxPoint x="${n2(p.x)}" y="${n2(p.y)}" />`).join('');
    const inner = mid ? `<Array as="points">${mid}</Array>` : '';
    // підпис: у ту саму точку, яку обрав лейаутер (положення вздовж лінії + зсув від неї)
    const lb = model.edgeLabels.get(f.id);
    let geoAttr = '';
    let offset = '';
    if (f.name && lb) {
      const place = placeLabel(pts, { x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 });
      geoAttr = ` x="${place.gx}"`;
      offset = `<mxPoint x="${n2(place.dx)}" y="${n2(place.dy)}" as="offset" />`;
    }
    out.push(`        <mxCell id="${escapeAttr(f.id)}" value="${escapeAttr(f.name ?? '')}" style="${style}" edge="1" parent="1" source="${escapeAttr(f.source)}" target="${escapeAttr(f.target)}"><mxGeometry${geoAttr} relative="1" as="geometry">${offset}${inner}</mxGeometry></mxCell>`);
  }
  out.push('      </root>', '    </mxGraphModel>', '  </diagram>', '</mxfile>', '');
  const xml = tamper ? tamper(out.join('\n')) : out.join('\n');

  // власна зворотна звірка: експорт не видається, доки не пройде її
  const issues = verifyDrawio(xml, pkg, model);
  if (issues.some((i) => i.severity === 'error')) return failed(issues);
  return { status: 'ok', xml, issues };
}

/** Точка на блоці у відносних координатах 0…1 (для exitX/exitY/entryX/entryY). */
export function relPoint(p: { x: number; y: number }, r: Rect): { x: number; y: number } {
  return {
    x: Math.min(1, Math.max(0, Math.round(((p.x - r.x) / r.w) * 10000) / 10000)),
    y: Math.min(1, Math.max(0, Math.round(((p.y - r.y) / r.h) * 10000) / 10000)),
  };
}

/**
 * draw.io ставить підпис лінії в точку на відстані ((x+1)/2 · довжина) уздовж лінії плюс зсув (offset).
 * Знаходимо на лінії найближчу до центра підпису точку й повертаємо x і зсув.
 */
export function placeLabel(pts: { x: number; y: number }[], center: { x: number; y: number }): { gx: number; dx: number; dy: number } {
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y); segs.push(l); total += l; }
  let best = { d: Infinity, arc: 0, x: pts[0]!.x, y: pts[0]!.y };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, l = segs[i - 1]!;
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((center.x - a.x) * (b.x - a.x) + (center.y - a.y) * (b.y - a.y)) / (l * l)));
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    const d = Math.hypot(center.x - px, center.y - py);
    if (d < best.d) best = { d, arc: acc + l * t, x: px, y: py };
    acc += l;
  }
  const f = total === 0 ? 0.5 : Math.max(0, Math.min(1, best.arc / total));
  const gx = Math.round((2 * f - 1) * 10000) / 10000;
  // draw.io округлює відстань до цілого пікселя; точку прив'язки беремо за тим самим правилом
  const anchorArc = Math.round(f * total);
  let rem = anchorArc, ax = pts[0]!.x, ay = pts[0]!.y;
  for (let i = 1; i < pts.length; i++) {
    const l = segs[i - 1]!;
    if (rem <= l || i === pts.length - 1) {
      const t = l === 0 ? 0 : Math.min(1, rem / l);
      ax = pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t;
      ay = pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t;
      break;
    }
    rem -= l;
  }
  return { gx, dx: center.x - ax, dy: center.y - ay };
}

function failed(issues: Issue[]): DrawioExport {
  return { status: 'failed', xml: null, issues };
}

// ───────────────────────── читання й звірка ─────────────────────────

interface Cell {
  id: string;
  value: string;
  style: string;
  parent: string;
  vertex: boolean;
  edge: boolean;
  source: string | undefined;
  target: string | undefined;
  geo: {
    x: number; y: number; w: number; h: number; relative: boolean; points: { x: number; y: number }[];
    offset: { x: number; y: number } | null;
    /** Імена всіх атрибутів і дочірніх елементів геометрії (для виявлення сторонніх параметрів). */
    attrNames: string[]; childNames: string[];
  } | null;
  props: Map<string, string>;
  /** Імена всіх атрибутів клітинки (mxCell) і, якщо є, обгортки object. */
  attrNames: string[];
  objectAttrNames: string[];
  /** Чи клітинка була обгорнута в object (потрібно лише для пулу). */
  wrapped: boolean;
}

export function readDrawio(xml: string): { cells: Cell[]; issues: Issue[]; modelAttrs: Map<string, string> } {
  const issues: Issue[] = [];
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    return { cells: [], modelAttrs: new Map(), issues: [err('DRAWIO_XML_MALFORMED', `Файл .drawio не є коректним XML: ${e instanceof XmlError ? e.message : String(e)}.`)] };
  }
  if (root.local !== 'mxfile') return { cells: [], modelAttrs: new Map(), issues: [err('DRAWIO_STRUCTURE', 'Кореневий елемент має бути mxfile.')] };
  const diagrams = elementChildren(root).filter((e) => e.local === 'diagram');
  if (diagrams.length !== 1) return { cells: [], modelAttrs: new Map(), issues: [err('DRAWIO_STRUCTURE', `У файлі ${diagrams.length} діаграм(и), а має бути одна.`)] };
  const model = elementChildren(diagrams[0]!).find((e) => e.local === 'mxGraphModel');
  if (!model) return { cells: [], modelAttrs: new Map(), issues: [err('DRAWIO_STRUCTURE', 'Діаграма стиснена або не містить mxGraphModel: такий вміст перевірити не можна.')] };
  const rootEl = elementChildren(model).find((e) => e.local === 'root');
  if (!rootEl) return { cells: [], modelAttrs: new Map(), issues: [err('DRAWIO_STRUCTURE', 'Немає елемента root.')] };

  const num = (e: XmlElement, k: string): number => { const v = attr(e, k); return v === undefined || v.trim() === '' ? NaN : Number(v); };
  const modelAttrs = new Map<string, string>(model.attrs.map((a) => [a.name, a.value]));
  const cells: Cell[] = [];
  for (const el of elementChildren(rootEl)) {
    let cell = el;
    const props = new Map<string, string>();
    let objectAttrNames: string[] = [];
    let wrapped = false;
    let id = attr(el, 'id') ?? '';
    let value = attr(el, 'value') ?? '';
    if (el.local === 'object' || el.local === 'UserObject') {
      const inner = elementChildren(el).find((c) => c.local === 'mxCell');
      if (!inner) { issues.push(err('DRAWIO_STRUCTURE', `Об’єкт ${id} без mxCell.`, [id])); continue; }
      cell = inner;
      wrapped = true;
      objectAttrNames = el.attrs.map((a) => a.name);
      value = attr(el, 'label') ?? '';
      for (const a of el.attrs) if (!['label', 'id'].includes(a.name)) props.set(a.name, a.value);
    } else if (el.local !== 'mxCell') {
      issues.push(err('DRAWIO_UNSUPPORTED', `Невідомий елемент <${el.name}> у діаграмі.`, [id]));
      continue;
    } else id = attr(el, 'id') ?? '';
    const geoEl = elementChildren(cell).find((c) => c.local === 'mxGeometry');
    let geo: Cell['geo'] = null;
    if (geoEl) {
      const arr = elementChildren(geoEl).find((c) => c.local === 'Array');
      const off = elementChildren(geoEl).find((c) => c.local === 'mxPoint' && attr(c, 'as') === 'offset');
      geo = {
        offset: off ? { x: num(off, 'x'), y: num(off, 'y') } : null,
        attrNames: geoEl.attrs.map((a) => a.name), childNames: elementChildren(geoEl).map((c) => `${c.local}${attr(c, 'as') ? `[as=${attr(c, 'as')}]` : ''}`),
        x: num(geoEl, 'x'), y: num(geoEl, 'y'), w: num(geoEl, 'width'), h: num(geoEl, 'height'),
        relative: attr(geoEl, 'relative') === '1',
        points: arr ? elementChildren(arr).filter((p) => p.local === 'mxPoint').map((p) => ({ x: num(p, 'x'), y: num(p, 'y') })) : [],
      };
    }
    cells.push({
      id, value, style: attr(cell, 'style') ?? '', parent: attr(cell, 'parent') ?? '',
      vertex: attr(cell, 'vertex') === '1', edge: attr(cell, 'edge') === '1',
      source: attr(cell, 'source'), target: attr(cell, 'target'), geo, props,
      attrNames: cell.attrs.map((a) => a.name), objectAttrNames, wrapped,
    });
  }
  return { cells, issues, modelAttrs };
}

/** Звірка .drawio з пакетом і з перевіреним .bpmn: підписи, ролі, переходи, ID, геометрія, зайва нотація. */
export function verifyDrawio(xml: string, pkg: ApprovedPackage, bpmn: BpmnModel): Issue[] {
  const read = readDrawio(xml);
  const issues: Issue[] = [...read.issues];
  if (read.cells.length === 0) return issues;
  const cells = read.cells;
  const byId = new Map<string, Cell>();
  for (const c of cells) {
    if (byId.has(c.id)) issues.push(err('DRAWIO_DUPLICATE_ID', `ID клітинки «${c.id}» повторюється: одна з клітинок «затирає» іншу.`, [c.id]));
    byId.set(c.id, c);
  }
  if (!byId.has('0') || !byId.has('1')) issues.push(err('DRAWIO_STRUCTURE', 'Немає службових клітинок 0 і 1.'));

  const stepById = new Map(pkg.content.steps.map((s) => [s.id, s]));
  const ref = (id: string): string => (id.startsWith('Task_') && stepById.has(id.slice(5)) ? `крок ${id.slice(5)}` : id);

  // прив'язка до версії
  const poolId = bpmn.participant?.id ?? ID.participant;
  const pool = byId.get(poolId);
  if (!pool) issues.push(err('DRAWIO_POOL_MISSING', 'У .drawio немає пулу.', [poolId]));
  else {
    const p = pool.props;
    if (p.get('cx_version_id') !== pkg.versionId) issues.push(err('DRAWIO_BINDING_MISMATCH', 'ID версії в .drawio відсутній або не збігається з погодженою.'));
    if (p.get('cx_content_hash') !== pkg.contentHash) issues.push(err('DRAWIO_BINDING_MISMATCH', 'Хеш версії в .drawio відсутній або не збігається з погодженим.'));
    if (p.get('cx_origin') !== pkg.origin) issues.push(err('DRAWIO_BINDING_MISMATCH', 'Позначка походження в .drawio не збігається з пакетом.'));
    if (pool.value !== poolNameOf(pkg)) issues.push(err('DRAWIO_LABEL_MISMATCH', `Назва пулу в .drawio «${pool.value}» не збігається з назвою процесу «${poolNameOf(pkg)}».`, [poolId]));
  }

  // множини ID: усе, що є у перевіреному .bpmn, має бути в .drawio, і нічого зайвого
  const expectedIds = new Set<string>([poolId, ...bpmn.lanes.map((l) => l.id), ...bpmn.nodes.keys(), ...bpmn.flows.map((f) => f.id)]);
  for (const id of expectedIds) {
    if (!byId.has(id)) issues.push(err('DRAWIO_CELL_MISSING', `У .drawio немає клітинки ${ref(id)} (ID ${id}): елемент схеми загублено при експорті.`, [id]));
  }
  for (const c of cells) {
    if (c.id === '0' || c.id === '1') continue;
    if (!expectedIds.has(c.id)) issues.push(err('DRAWIO_CELL_EXTRA', `У .drawio є зайва клітинка «${c.id}» (${c.value ? `«${c.value}»` : 'без тексту'}), якої немає у схемі.`, [c.id]));
  }

  // доріжки ↔ ролі; задачі ↔ дії; доріжка задачі = роль кроку
  const lanes = bpmn.lanes.map((l) => ({ id: l.id, cell: byId.get(l.id) }));
  const roleSet = new Set(pkg.content.roles);
  for (const l of lanes) {
    if (!l.cell) continue;
    if (!roleSet.has(l.cell.value)) issues.push(err('DRAWIO_LANE_EXTRA', `Доріжка «${l.cell.value}» у .drawio не відповідає жодній погодженій ролі.`, [l.id]));
    if (l.cell.parent !== poolId) issues.push(err('DRAWIO_STRUCTURE', `Доріжка ${l.id} не вкладена в пул.`, [l.id]));
  }
  for (const role of pkg.content.roles) {
    const n = lanes.filter((l) => l.cell?.value === role).length;
    if (n !== 1) issues.push(err('DRAWIO_LANE_MISSING', `Для ролі «${role}» у .drawio ${n} доріжок замість однієї.`));
  }

  const nodeTag = new Map<string, GNode>();
  for (const c of cells) {
    if (!c.vertex || c.id === poolId || lanes.some((l) => l.id === c.id)) continue;
    const st = styleMap(c.style);
    const shape = st.get('shape') ?? '';
    // дозволена нотація: нейтральна задача, проста початкова/кінцева подія, ексклюзивний шлюз
    let tag: GNode['tag'] | null = null;
    if (shape === 'mxgraph.bpmn.task2' && st.get('taskMarker') === 'abstract' && !st.has('isLoopSub')) tag = 'task';
    else if (shape === 'mxgraph.bpmn.event' && st.get('symbol') === 'general' && st.get('outline') === 'standard') tag = 'startEvent';
    else if (shape === 'mxgraph.bpmn.event' && st.get('symbol') === 'general' && st.get('outline') === 'end') tag = 'endEvent';
    else if (shape === 'mxgraph.bpmn.gateway2' && st.get('gwType') === 'exclusive') tag = 'exclusiveGateway';
    if (!tag) {
      issues.push(err('DRAWIO_UNSUPPORTED_STYLE', `Клітинка ${ref(c.id)} має стиль, якого немає в підтримуваному переліку (форма «${shape || '—'}», маркер «${st.get('taskMarker') ?? '—'}», символ «${st.get('symbol') ?? '—'}»): це зайва нотація.`, [c.id]));
      continue;
    }
    nodeTag.set(c.id, { id: c.id, tag });
    // тексти
    if (tag === 'task') {
      const stepId = c.id.startsWith('Task_') ? c.id.slice(5) : '';
      const s = stepById.get(stepId);
      if (!s) { issues.push(err('DRAWIO_TASK_EXTRA', `У .drawio є зайва задача «${c.value}» (ID ${c.id}).`, [c.id])); continue; }
      if (c.value !== s.action) issues.push(err('DRAWIO_LABEL_MISMATCH', `Дія кроку ${s.id} у .drawio змінена: погоджено «${s.action}», а в клітинці «${c.value}».`, [c.id]));
      const lane = byId.get(c.parent);
      if (!lane || lane.value !== s.role) issues.push(err('DRAWIO_WRONG_LANE', `Крок ${s.id} у .drawio лежить у доріжці «${lane?.value ?? '—'}», а його роль — «${s.role}».`, [c.id]));
    } else if (tag === 'startEvent') {
      if (c.value !== pkg.content.boundaries.trigger) issues.push(err('DRAWIO_LABEL_MISMATCH', `Назва початкової події в .drawio «${c.value}» не збігається з тригером «${pkg.content.boundaries.trigger}».`, [c.id]));
    } else if (c.value !== '') {
      issues.push(err('DRAWIO_LABEL_MISMATCH', `Технічний елемент ${c.id} у .drawio має текст «${c.value}», якого немає в описі.`, [c.id]));
    }
  }
  for (const s of pkg.content.steps) {
    if (!nodeTag.has(`Task_${s.id}`)) issues.push(err('DRAWIO_STEP_MISSING', `Крок ${s.id} («${s.action}») відсутній у .drawio як задача.`, [s.id]));
  }

  // лінії
  const flows: GFlow[] = [];
  for (const c of cells) {
    if (!c.edge) continue;
    if (!c.source || !c.target || !byId.has(c.source) || !byId.has(c.target)) {
      issues.push(err('DRAWIO_EDGE_DETACHED', `Лінія ${c.id} не з’єднана з існуючими блоками (джерело «${c.source ?? '—'}», ціль «${c.target ?? '—'}»): стрілку «видно», але вона нікуди не веде.`, [c.id]));
      continue;
    }
    flows.push({ id: c.id, name: c.value === '' ? undefined : c.value, source: c.source, target: c.target });
    if (!c.geo || (c.geo.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) {
      issues.push(err('DRAWIO_GEOMETRY', `Лінія ${c.id} без коректної геометрії.`, [c.id]));
    }
  }
  const expectedFlows = new Map(bpmn.flows.map((f) => [f.id, f]));
  for (const f of flows) {
    const e = expectedFlows.get(f.id);
    if (e && (e.source !== f.source || e.target !== f.target)) {
      issues.push(err('DRAWIO_EDGE_MISMATCH', `Лінія ${f.id} у .drawio з’єднує ${f.source} → ${f.target}, а у схемі ${e.source} → ${e.target}.`, [f.id]));
    }
    if (e && (e.name ?? '') !== (f.name ?? '')) {
      issues.push(err('DRAWIO_LABEL_MISMATCH', `Підпис лінії ${f.id} у .drawio «${f.name ?? ''}» не збігається зі схемою «${e.name ?? ''}».`, [f.id]));
    }
  }
  if (flows.length !== bpmn.flows.length) {
    issues.push(err('DRAWIO_EDGE_COUNT', `У .drawio ${flows.length} стрілок, а у схемі ${bpmn.flows.length}: частину переходів загублено.`));
  }

  // переходи за самим .drawio проти пакета (незалежно від .bpmn)
  const { edges, implicitSplits } = collapse(nodeTag, flows);
  for (const sp of implicitSplits) issues.push(err('DRAWIO_IMPLICIT_SPLIT', `З кроку ${sp.stepId} у .drawio виходить ${sp.count} ліній без шлюзу.`, [sp.stepId]));
  const { missing, extra } = diffEdges(expectedTransitions(pkg), edges);
  for (const m of missing) issues.push(err('DRAWIO_TRANSITION_MISSING', `У .drawio втрачено перехід ${m.from} → ${m.to}${m.condition ? ` за умовою «${m.condition}»` : ''}.`, [m.from]));
  for (const x of extra) issues.push(err('DRAWIO_TRANSITION_EXTRA', `У .drawio є перехід ${x.from} → ${x.to}${x.condition ? ` за умовою «${x.condition}»` : ''}, якого немає в погодженому описі.`, [x.from]));

  // геометрія: кожен блок має координати й розмір, що збігаються з .bpmn
  const abs = new Map<string, { x: number; y: number }>();
  if (pool?.geo) abs.set(poolId, { x: pool.geo.x, y: pool.geo.y });
  for (const l of lanes) if (l.cell?.geo && abs.has(l.cell.parent)) abs.set(l.id, { x: abs.get(l.cell.parent)!.x + l.cell.geo.x, y: abs.get(l.cell.parent)!.y + l.cell.geo.y });
  for (const c of cells) {
    if (!c.vertex || !expectedIds.has(c.id)) continue;
    const g = c.geo;
    if (!g || ![g.x, g.y, g.w, g.h].every(Number.isFinite) || g.w <= 0 || g.h <= 0) {
      issues.push(err('DRAWIO_GEOMETRY', `Клітинка ${ref(c.id)} без коректної геометрії: її не буде видно.`, [c.id]));
      continue;
    }
    const origin = c.id === poolId ? { x: 0, y: 0 } : abs.get(c.parent);
    const want = bpmn.shapes.get(c.id)?.[0];
    if (!origin || !want) continue;
    const ax = origin.x + g.x, ay = origin.y + g.y;
    if (Math.abs(ax - want.x) > 0.6 || Math.abs(ay - want.y) > 0.6 || Math.abs(g.w - want.w) > 0.6 || Math.abs(g.h - want.h) > 0.6) {
      issues.push(err('DRAWIO_GEOMETRY', `Геометрія клітинки ${ref(c.id)} у .drawio не збігається зі схемою .bpmn.`, [c.id]));
    }
  }
  // ── зображення має передавати процес так само, як зміст: стиль, видимість, напрямок стрілок, службові атрибути ──
  const modelAttrs = read.modelAttrs;
  for (const [k, want] of Object.entries(GRAPH_MODEL_ATTRS)) {
    if (modelAttrs.get(k) !== want) issues.push(err('DRAWIO_MODEL_ATTR', `Параметр діаграми «${k}» = «${modelAttrs.get(k) ?? '—'}», а в еталонному експорті «${want}».`));
  }
  for (const k of modelAttrs.keys()) {
    if (!(k in GRAPH_MODEL_ATTRS)) issues.push(err('DRAWIO_MODEL_ATTR', `У діаграмі є сторонній параметр «${k}» (наприклад, колір тла чи розмір сторінки може сховати вміст).`));
  }
  const core0 = byId.get('0'), core1 = byId.get('1');
  if (core0 && (core0.attrNames.join(',') !== 'id' || core0.style !== '')) issues.push(err('DRAWIO_CELL_ATTR', 'Службова клітинка 0 має сторонні параметри.', ['0']));
  if (core1 && (core1.attrNames.slice().sort().join(',') !== 'id,parent' || core1.parent !== '0' || core1.style !== '')) {
    issues.push(err('DRAWIO_CELL_ATTR', 'Службова клітинка 1 (шар із усім вмістом) має сторонні параметри, наприклад «visible», «style»: шар може бути схований чи прозорий.', ['1']));
  }
  const kindOf = (id: string): CellKind | null => {
    if (id === poolId) return 'pool';
    if (lanes.some((l) => l.id === id)) return 'lane';
    const nd = bpmn.nodes.get(id);
    if (nd) return nd.tag;
    return bpmn.flows.some((f) => f.id === id) ? 'edge' : null;
  };
  const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  const flowById = new Map(bpmn.flows.map((f) => [f.id, f]));
  for (const c of cells) {
    if (c.id === '0' || c.id === '1') continue;
    const kind = kindOf(c.id);
    if (!kind) continue; // зайві клітинки вже відхилено
    const label = kind === 'edge' ? `лінії ${c.id}` : `${ref(c.id)}`;
    let ports: { exitX: number; exitY: number; entryX: number; entryY: number } | undefined;
    const f = kind === 'edge' ? flowById.get(c.id) : undefined;
    const pts = f ? bpmn.edges.get(f.id)?.[0] : undefined;
    if (f && pts && pts.length >= 2) {
      const s0 = bpmn.shapes.get(f.source)?.[0], t0 = bpmn.shapes.get(f.target)?.[0];
      if (s0 && t0) {
        const a = relPoint(pts[0]!, s0), b = relPoint(pts[pts.length - 1]!, t0);
        ports = { exitX: a.x, exitY: a.y, entryX: b.x, entryY: b.y };
      }
    }
    const lb = kind === 'startEvent' || kind === 'endEvent' ? bpmn.shapeLabels.get(c.id) : undefined;
    const named = kind === 'startEvent' || kind === 'endEvent' ? !!bpmn.nodes.get(c.id)?.name?.trim() : false;
    issues.push(...checkCellStyle({
      cellId: c.id, label, kind, style: c.style, ...(ports ? { ports } : {}),
      ...(lb && named ? { labelWidth: lb.w } : {}),
    }));
    // службові параметри клітинки (visible, collapsed, connectable …)
    const wantAttrs = kind === 'edge' ? ['id', 'value', 'style', 'edge', 'parent', 'source', 'target'] : kind === 'pool' ? ['style', 'vertex', 'parent'] : ['id', 'value', 'style', 'vertex', 'parent'];
    if (!sameSet(c.attrNames, wantAttrs)) {
      const extra = c.attrNames.filter((n) => !wantAttrs.includes(n));
      issues.push(err('DRAWIO_CELL_ATTR', `Клітинка ${label} має сторонні службові параметри (${extra.join(', ') || 'набір параметрів відрізняється'}): наприклад «visible» ховає елемент.`, [c.id]));
    }
    if (kind === 'pool') {
      const wantObj = ['label', 'cx_version_id', 'cx_content_hash', 'cx_origin', 'cx_generator', 'id'];
      if (!c.wrapped || !sameSet(c.objectAttrNames, wantObj)) issues.push(err('DRAWIO_CELL_ATTR', 'Обгортка пулу має сторонні чи відсутні параметри.', [c.id]));
    } else if (c.wrapped) issues.push(err('DRAWIO_CELL_ATTR', `Клітинка ${label} має зайву обгортку object.`, [c.id]));
    // службові параметри геометрії
    if (c.geo) {
      const wantG = kind === 'edge' ? ['relative', 'as', 'x'] : ['x', 'y', 'width', 'height', 'as'];
      const extraG = c.geo.attrNames.filter((n) => !wantG.includes(n));
      const extraC = c.geo.childNames.filter((n) => !(kind === 'edge' && (n === 'mxPoint[as=offset]' || n === 'Array[as=points]')));
      if (extraG.length || extraC.length) issues.push(err('DRAWIO_GEOMETRY_ATTR', `Геометрія ${label} має сторонні параметри чи вкладені елементи (${[...extraG, ...extraC].join(', ')}).`, [c.id]));
    }
    // лінія: проміжні точки й положення підпису — як у схемі .bpmn
    if (kind === 'edge' && f && pts && c.geo) {
      const want = pts.slice(1, -1);
      const got = c.geo.points;
      if (got.length !== want.length || want.some((w, i) => Math.abs(w.x - got[i]!.x) > 0.6 || Math.abs(w.y - got[i]!.y) > 0.6)) {
        issues.push(err('DRAWIO_GEOMETRY', `Маршрут стрілки ${f.id} у .drawio не збігається зі схемою .bpmn: стрілка піде не туди, куди в схемі.`, [c.id]));
      }
      const lb = bpmn.edgeLabels.get(f.id);
      const gx = Number.isFinite(c.geo.x) ? c.geo.x : 0;
      if (f.name && lb) {
        const place = placeLabel(pts, { x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 });
        const off = c.geo.offset ?? { x: 0, y: 0 };
        if (Math.abs(gx - place.gx) > 0.01 || Math.abs(off.x - place.dx) > 1 || Math.abs(off.y - place.dy) > 1) {
          issues.push(err('DRAWIO_GEOMETRY', `Підпис стрілки ${f.id} у .drawio стоїть не там, де в схемі .bpmn (його може бути не видно чи не зрозуміло, до якої стрілки він належить).`, [c.id]));
        }
      } else if (Math.abs(gx) > 0.01 || c.geo.offset) {
        issues.push(err('DRAWIO_GEOMETRY', `Стрілка ${f.id} без підпису має зсув підпису.`, [c.id]));
      }
    }
  }
  return issues;
}
