/**
 * Зворотна звірка `.drawio` з перевіреним `.bpmn` і погодженим описом.
 *
 * `.drawio` — окремий файл, який читає інша програма. Перевіряється не «файл створився», а те, що в ньому
 * той самий зміст, та сама геометрія **і той самий вигляд**: кожен елемент і кожен перехід на місці,
 * підписи дослівні, фігури й маркери ті самі, стрілки спрямовані так само, нічого не приховано.
 *
 * Межа перевірки — **явний контракт допустимого експорту** (`drawio-style.ts`), а не перелік заборонених
 * параметрів: дозволено рівно те, що пише конвертер, усе інше — помилка. Так ловляться й випадки, яких
 * у жодному «чорному списку» немає: прихований шар, підміна фігури, прозорі лінії.
 */
import { attr, elementChildren, parseXml, walk, XmlError, type XmlElement } from '../bpmn/xml.ts';
import type { Issue } from '../bpmn/types.ts';
import { START_ID } from '../csv/check.ts';
import { checkCellStyle, GRAPH_MODEL_ATTRS, type CellKind } from './drawio-style.ts';
import type { BpmnModel } from './verify.ts';

export interface DrawioCell {
  id: string; value: string; style: string; parent: string;
  edge: boolean; vertex: boolean; source: string | null; target: string | null;
  geometry: { x: number; y: number; w: number; h: number } | null;
  /** Проміжні точки лінії (`<Array as="points">`) — без першої й останньої, як їх пише конвертер. */
  points: { x: number; y: number }[];
  /** Положення підпису лінії: частка довжини й зсув. */
  labelX: string | null;
  labelOffset: { x: number; y: number } | null;
  tooltip: string | null;
  /** Усі атрибути клітинки (і обгортки `<object>`): зайвий атрибут — теж відхилення від контракту. */
  attrs: Map<string, string>;
}

const err = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'error', message, refs });

/** Зворотне перетворення тексту підпису html=1 → звичайний текст. */
export const unhtml = (v: string): string =>
  v.replaceAll('<br>', '\n').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

const attrsOf = (el: XmlElement): Map<string, string> => new Map(el.attrs.map((a) => [a.name, a.value]));

export function readDrawio(xml: string): { cells: DrawioCell[]; issues: Issue[]; modelAttrs: Map<string, string> } {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    return { cells: [], issues: [err('DRAWIO_XML_MALFORMED', `Файл .drawio не є коректним XML: ${e instanceof XmlError ? e.message : String(e)}`)], modelAttrs: new Map() };
  }
  const cells: DrawioCell[] = [];
  const issues: Issue[] = [];
  let modelAttrs = new Map<string, string>();
  const readCell = (el: XmlElement, id: string, value: string, tooltip: string | null, extra: Map<string, string>): void => {
    let geometry: DrawioCell['geometry'] = null;
    const points: { x: number; y: number }[] = [];
    let labelX: string | null = null;
    let labelOffset: { x: number; y: number } | null = null;
    for (const ch of elementChildren(el)) {
      if (ch.local !== 'mxGeometry') continue;
      const x = Number(attr(ch, 'x') ?? 0), y = Number(attr(ch, 'y') ?? 0);
      const w = Number(attr(ch, 'width') ?? 0), h = Number(attr(ch, 'height') ?? 0);
      if ([x, y, w, h].every(Number.isFinite)) geometry = { x, y, w, h };
      labelX = attr(ch, 'x') ?? null;
      for (const g of elementChildren(ch)) {
        if (g.local === 'Array' && attr(g, 'as') === 'points') {
          for (const p of elementChildren(g)) if (p.local === 'mxPoint') points.push({ x: Number(attr(p, 'x')), y: Number(attr(p, 'y')) });
        }
        if (g.local === 'mxPoint' && attr(g, 'as') === 'offset') labelOffset = { x: Number(attr(g, 'x')), y: Number(attr(g, 'y')) };
      }
    }
    const own = attrsOf(el);
    for (const [k, v] of extra) own.set(k, v);
    cells.push({
      id, value, tooltip, style: attr(el, 'style') ?? '', parent: attr(el, 'parent') ?? '',
      edge: attr(el, 'edge') === '1', vertex: attr(el, 'vertex') === '1',
      source: attr(el, 'source') ?? null, target: attr(el, 'target') ?? null,
      geometry, points, labelX, labelOffset, attrs: own,
    });
  };
  walk(root, (e) => {
    if (e.local === 'mxGraphModel') modelAttrs = attrsOf(e);
    if (e.local === 'object') {
      const inner = elementChildren(e).find((c) => c.local === 'mxCell');
      if (!inner) { issues.push(err('DRAWIO_STRUCTURE', `Елемент <object> ${attr(e, 'id') ?? ''} без mxCell.`)); return; }
      readCell(inner, attr(e, 'id') ?? '', attr(e, 'label') ?? '', attr(e, 'tooltip') ?? null, attrsOf(e));
    } else if (e.local === 'mxCell' && e.parent?.local !== 'object') {
      readCell(e, attr(e, 'id') ?? '', attr(e, 'value') ?? '', null, new Map());
    }
  });
  return { cells, issues, modelAttrs };
}

/** Атрибути, дозволені клітинці кожного виду. Будь-який інший (visible, collapsed, connectable…) — помилка. */
const ALLOWED_ATTRS: Record<'root0' | 'layer' | 'vertex' | 'object' | 'edge', Set<string>> = {
  root0: new Set(['id']),
  layer: new Set(['id', 'parent']),
  vertex: new Set(['id', 'value', 'style', 'vertex', 'parent']),
  object: new Set(['id', 'label', 'tooltip', 'style', 'vertex', 'parent']),
  edge: new Set(['id', 'value', 'style', 'edge', 'parent', 'source', 'target']),
};

export function verifyDrawioAgainstBpmn(
  xml: string, bpmn: BpmnModel, fullTrigger: string | null,
  binding?: { versionId: string; contentHash: string },
): Issue[] {
  const out: Issue[] = [];
  if (!/<mxGraphModel[\s\S]*<\/mxGraphModel>/.test(xml)) {
    return [err('DRAWIO_STRUCTURE', 'У файлі .drawio немає розгорнутої моделі <mxGraphModel>: вміст перевірити неможливо (стиснена діаграма не приймається).')];
  }
  const { cells, issues, modelAttrs } = readDrawio(xml);
  if (issues.length > 0) return issues;

  // ── прив'язка до погодженої версії ──
  if (binding) {
    const d = /<diagram\b[^>]*>/.exec(xml)?.[0] ?? '';
    const got = (k: string): string => new RegExp(`${k}="([^"]*)"`).exec(d)?.[1] ?? '';
    if (got('cx_version_id') !== binding.versionId || got('cx_content_hash') !== binding.contentHash) {
      out.push(err('DRAWIO_BINDING_MISMATCH', `Прив’язка .drawio до погодженої версії відсутня або не збігається з .bpmn (у файлі версія «${got('cx_version_id')}»).`));
    }
  }

  // ── атрибути самої діаграми: усе, що впливає на показ полотна ──
  for (const [k, v] of Object.entries(GRAPH_MODEL_ATTRS)) {
    if (modelAttrs.get(k) !== v) out.push(err('DRAWIO_STRUCTURE', `Атрибут діаграми «${k}» = ${modelAttrs.get(k) === undefined ? 'відсутній' : `«${modelAttrs.get(k)}»`}, очікується «${v}».`));
  }
  for (const k of modelAttrs.keys()) {
    if (!(k in GRAPH_MODEL_ATTRS)) out.push(err('DRAWIO_STRUCTURE', `У діаграмі є зайвий атрибут «${k}» = «${modelAttrs.get(k)}»: такий експорт не є еталонним.`));
  }

  const byId = new Map<string, DrawioCell>();
  for (const c of cells) {
    if (byId.has(c.id)) out.push(err('DRAWIO_DUPLICATE_ID', `ID клітинки «${c.id}» використано двічі: яка з них справжня — невідомо.`, [c.id]));
    else byId.set(c.id, c);
  }

  // ── корінь і шар: саме тут ховається вся схема одним атрибутом ──
  const checkAttrs = (c: DrawioCell, allowed: Set<string>, what: string, required: string[] = []): void => {
    for (const k of c.attrs.keys()) {
      if (allowed.has(k)) continue;
      const code = ['visible', 'collapsed', 'connectable'].includes(k) ? 'DRAWIO_STYLE_HIDDEN' : 'DRAWIO_STRUCTURE';
      out.push(err(code, `${what}: атрибут «${k}» = «${c.attrs.get(k)}» у еталонному експорті відсутній${k === 'visible' ? ' — ним можна приховати елемент або весь шар' : ''}.`, [c.id]));
    }
    for (const k of required) {
      // Без `vertex="1"` чи `edge="1"` draw.io не покаже клітинку як фігуру або лінію.
      if (c.attrs.get(k) !== '1') out.push(err('DRAWIO_STYLE_HIDDEN', `${what}: немає обов’язкового атрибута «${k}="1"» — у draw.io клітинка не буде показана як ${k === 'edge' ? 'лінія' : 'фігура'}.`, [c.id]));
    }
  };
  const root0 = byId.get('0'), layer = byId.get('1');
  if (!root0) out.push(err('DRAWIO_STRUCTURE', 'У файлі немає кореневої клітинки «0».'));
  else checkAttrs(root0, ALLOWED_ATTRS.root0, 'Корінь діаграми');
  if (!layer) out.push(err('DRAWIO_STRUCTURE', 'У файлі немає клітинки шару «1».'));
  else {
    checkAttrs(layer, ALLOWED_ATTRS.layer, 'Шар діаграми');
    if (layer.parent !== '0') out.push(err('DRAWIO_STRUCTURE', `Шар діаграми має батька «${layer.parent}», очікується «0».`, ['1']));
    if (layer.style !== '') out.push(err('DRAWIO_STYLE_HIDDEN', `Шар діаграми має стиль «${layer.style}»: у еталонному експорті стилю на шарі немає, а ним можна приховати всю схему.`, ['1']));
  }

  const laneCellOf = (name: string): string | null => bpmn.lanes.find((l) => l.name === name)?.id ?? null;
  // Пул шукаємо за ID учасника з `.bpmn`, а не за стилем: інакше підміна стилю ховала б і сам пул.
  const poolCell = byId.get(bpmn.poolId);

  // ── пул і доріжки ──
  if (bpmn.poolBox) {
    if (!poolCell) out.push(err('DRAWIO_CELL_MISSING', 'У .drawio немає пулу (учасника).'));
    else {
      checkAttrs(poolCell, ALLOWED_ATTRS.vertex, `Пул ${poolCell.id}`, ['vertex']);
      out.push(...checkCellStyle(poolCell.id, `пул «${unhtml(poolCell.value)}»`, 'pool', poolCell.style));
      if (unhtml(poolCell.value) !== bpmn.poolName) out.push(err('DRAWIO_LABEL_MISMATCH', `Напис на пулі «${unhtml(poolCell.value)}» не збігається з .bpmn «${bpmn.poolName}».`, [poolCell.id]));
      const g = poolCell.geometry;
      if (!g || Math.abs(g.x - bpmn.poolBox.x) > 1 || Math.abs(g.y - bpmn.poolBox.y) > 1 || Math.abs(g.w - bpmn.poolBox.w) > 1 || Math.abs(g.h - bpmn.poolBox.h) > 1) {
        out.push(err('DRAWIO_GEOMETRY', `Геометрія пулу в .drawio не збігається з .bpmn.`, [poolCell.id]));
      }
    }
  }
  for (const lane of bpmn.lanes) {
    const c = byId.get(lane.id);
    if (!c) { out.push(err('DRAWIO_CELL_MISSING', `У .drawio немає доріжки «${lane.name}».`, [lane.id])); continue; }
    checkAttrs(c, ALLOWED_ATTRS.vertex, `Доріжка ${c.id}`, ['vertex']);
    out.push(...checkCellStyle(c.id, `доріжка «${unhtml(c.value)}»`, 'lane', c.style));
    if (unhtml(c.value) !== lane.name) out.push(err('DRAWIO_LABEL_MISMATCH', `Назва доріжки «${unhtml(c.value)}» не збігається з .bpmn «${lane.name}».`, [lane.id]));
    if (poolCell && c.parent !== poolCell.id) out.push(err('DRAWIO_STRUCTURE', `Доріжка «${lane.name}» не лежить у пулі.`, [lane.id]));
  }

  // абсолютні координати: дитина доріжки задана відносно неї
  const absolute = (c: DrawioCell): { x: number; y: number; w: number; h: number } | null => {
    if (!c.geometry) return null;
    let x = c.geometry.x, y = c.geometry.y;
    let p = byId.get(c.parent);
    let guard = 0;
    while (p && p.geometry && guard < 8) { x += p.geometry.x; y += p.geometry.y; p = byId.get(p.parent); guard += 1; }
    return { x, y, w: c.geometry.w, h: c.geometry.h };
  };

  const kindOf = (tag: string): CellKind | null => {
    if (tag === 'startEvent' || tag === 'endEvent' || tag === 'exclusiveGateway') return tag;
    return 'task';
  };

  // ── вузли: склад, підпис, доріжка, геометрія, ВИГЛЯД ──
  for (const n of bpmn.nodes.values()) {
    const cell = byId.get(n.id);
    if (!cell) {
      out.push(err('DRAWIO_CELL_MISSING', `У .drawio немає елемента ${n.id}.`, [n.id]));
      out.push(err('DRAWIO_STEP_MISSING', `Крок або подія ${n.id} у .drawio відсутні: файл показує не той процес.`, [n.id]));
      continue;
    }
    checkAttrs(cell, cell.tooltip !== null ? ALLOWED_ATTRS.object : ALLOWED_ATTRS.vertex, `Елемент ${n.id}`, ['vertex']);
    if (unhtml(cell.value) !== n.name) {
      out.push(err('DRAWIO_LABEL_MISMATCH', `Підпис елемента ${n.id} у .drawio «${unhtml(cell.value)}» не збігається з .bpmn «${n.name}».`, [n.id]));
    }
    const wantLane = n.lane ? laneCellOf(n.lane) : null;
    if (wantLane && cell.parent !== wantLane) {
      out.push(err('DRAWIO_WRONG_LANE', `Елемент ${n.id} у .drawio лежить у «${cell.parent}», а має — у «${wantLane}» (${n.lane}).`, [n.id]));
    }
    const a = absolute(cell);
    if (!a || !n.box) { out.push(err('DRAWIO_GEOMETRY', `Елемент ${n.id} у .drawio без геометрії.`, [n.id])); continue; }
    if (Math.abs(a.x - n.box.x) > 1 || Math.abs(a.y - n.box.y) > 1 || Math.abs(a.w - n.box.w) > 1 || Math.abs(a.h - n.box.h) > 1) {
      out.push(err('DRAWIO_GEOMETRY', `Елемент ${n.id}: координати в .drawio (${a.x}, ${a.y}, ${a.w}×${a.h}) не збігаються з .bpmn (${n.box.x}, ${n.box.y}, ${n.box.w}×${n.box.h}).`, [n.id]));
    }
    const kind = kindOf(n.tag);
    if (kind) {
      out.push(...checkCellStyle(cell.id, `елемент ${n.id}`, kind, cell.style, { tag: n.tag, ...(n.label ? { labelWidth: n.label.w } : {}) }));
    }
  }
  for (const c of cells) {
    if (!c.vertex || c.id === '0' || c.id === '1') continue;
    if (bpmn.nodes.has(c.id)) continue;
    if (c === poolCell || bpmn.lanes.some((l) => l.id === c.id)) continue;
    out.push(err('DRAWIO_CELL_EXTRA', `У .drawio є зайвий елемент «${c.id}», якого немає в .bpmn.`, [c.id]));
  }

  // ── лінії: склад, підпис, напрямок, вигляд, проміжні точки ──
  const edges = cells.filter((c) => c.edge);
  if (edges.length !== bpmn.flows.length) {
    out.push(err('DRAWIO_EDGE_COUNT', `У .drawio ${edges.length} ліній, у .bpmn — ${bpmn.flows.length}.`));
  }
  for (const e of edges) {
    checkAttrs(e, ALLOWED_ATTRS.edge, `Лінія ${e.id}`, ['edge']);
    if (!e.source || !e.target) {
      out.push(err('DRAWIO_EDGE_DETACHED', `Лінія «${e.id}» не має джерела або цілі: у draw.io вона «висить у повітрі».`, [e.id]));
      continue;
    }
    const f = bpmn.flows.find((x) => x.id === e.id);
    if (!f) { out.push(err('DRAWIO_CELL_EXTRA', `У .drawio є лінія «${e.id}», якої немає в .bpmn.`, [e.id])); continue; }
    if (e.source !== f.source || e.target !== f.target) {
      out.push(err('DRAWIO_EDGE_MISMATCH', `Лінія ${f.id} у .drawio веде ${e.source} → ${e.target}, а в .bpmn ${f.source} → ${f.target}.`, [f.id]));
    }
    if (unhtml(e.value) !== f.name) {
      out.push(err('DRAWIO_LABEL_MISMATCH', `Підпис лінії ${f.id} у .drawio «${unhtml(e.value)}» не збігається з .bpmn «${f.name}».`, [f.id]));
    }
    out.push(...checkCellStyle(e.id, `лінія ${f.id}`, 'edge', e.style, f.label ? { labelWidth: f.label.w } : {}));
    // Проміжні точки мають збігатися з геометрією .bpmn: інакше лінія йде іншим маршрутом.
    const want = f.points.slice(1, -1);
    if (e.points.length !== want.length || e.points.some((p, i) => Math.abs(p.x - want[i]!.x) > 1 || Math.abs(p.y - want[i]!.y) > 1)) {
      out.push(err('DRAWIO_EDGE_ROUTE', `Лінія ${f.id}: проміжні точки в .drawio не збігаються з маршрутом у .bpmn (${e.points.length} проти ${want.length}).`, [f.id]));
    }
    if (f.label && (e.labelX === null || e.labelOffset === null)) {
      out.push(err('DRAWIO_LABEL_PLACE', `Лінія ${f.id}: у .bpmn є рамка підпису, а в .drawio положення підпису не задане — підпис ляже посеред лінії й може накластися на інший.`, [f.id]));
    }
  }
  for (const f of bpmn.flows) {
    if (edges.some((e) => e.id === f.id)) continue;
    const present = byId.get(f.id);
    if (present) {
      // Клітинка є, але вона не лінія: без `edge="1"` draw.io не покаже стрілку взагалі.
      out.push(err('DRAWIO_STYLE_HIDDEN', `Лінія ${f.id} у .drawio не позначена як лінія (немає edge="1") — стрілки не буде видно.`, [f.id]));
    } else {
      out.push(err('DRAWIO_CELL_MISSING', `У .drawio немає лінії ${f.id} (${f.source} → ${f.target}).`, [f.id]));
    }
  }
  // Клітинка, яка не фігура й не лінія, у еталонному експорті існує лише як корінь і шар.
  for (const c of cells) {
    if (c.vertex || c.edge || c.id === '0' || c.id === '1') continue;
    out.push(err('DRAWIO_STRUCTURE', `Клітинка «${c.id}» не позначена ні як фігура, ні як лінія: у draw.io вона не буде показана.`, [c.id]));
  }

  // ── переходи «крок → крок» за згорткою (те саме правило, що для .bpmn) ──
  const nodeTag = (id: string): string | undefined => bpmn.nodes.get(id)?.tag;
  const flowsFrom = (id: string): DrawioCell[] => edges.filter((e) => e.source === id);
  const got = new Set<string>();
  for (const n of bpmn.nodes.values()) {
    if (!TASK_LIKE.has(n.tag)) continue;
    for (const e of flowsFrom(n.id)) {
      if (nodeTag(e.target ?? '') === 'exclusiveGateway') {
        for (const g of flowsFrom(e.target!)) got.add(JSON.stringify([n.id, g.target, unhtml(g.value)]));
      } else got.add(JSON.stringify([n.id, e.target, unhtml(e.value)]));
    }
  }
  const want = new Set<string>();
  const bySource = new Map<string, { id: string; name: string; source: string; target: string }[]>();
  for (const f of bpmn.flows) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);
  for (const n of bpmn.nodes.values()) {
    if (!TASK_LIKE.has(n.tag)) continue;
    for (const f of bySource.get(n.id) ?? []) {
      if (nodeTag(f.target) === 'exclusiveGateway') {
        for (const g of bySource.get(f.target) ?? []) want.add(JSON.stringify([n.id, g.target, g.name]));
      } else want.add(JSON.stringify([n.id, f.target, f.name]));
    }
  }
  for (const k of want) if (!got.has(k)) { const e = JSON.parse(k) as string[]; out.push(err('DRAWIO_TRANSITION_MISSING', `У .drawio немає переходу ${e[0]} → ${e[1]}${e[2] ? ` («${e[2]}»)` : ''}.`, [e[0]!])); }
  for (const k of got) if (!want.has(k)) { const e = JSON.parse(k) as string[]; out.push(err('DRAWIO_TRANSITION_EXTRA', `У .drawio є зайвий перехід ${e[0]} → ${e[1]}${e[2] ? ` («${e[2]}»)` : ''}.`, [e[0]!])); }

  // ── повний текст тригера ──
  if (fullTrigger !== null) {
    const start = byId.get(START_ID);
    if (!start || start.tooltip !== fullTrigger) {
      out.push(err('DRAWIO_START_DOC', 'Повного тексту тригера немає в деталях початкової події .drawio (підказка на елементі) або він змінений.', [START_ID]));
    }
  }
  return out;
}

const TASK_LIKE = new Set(['task', 'userTask', 'serviceTask', 'manualTask']);
