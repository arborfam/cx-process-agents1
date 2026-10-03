/**
 * Зворотна звірка `.drawio` з перевіреним `.bpmn` і погодженим описом.
 *
 * `.drawio` — окремий файл, який читає інша програма. Тому перевіряється не «файл створився», а те, що в
 * ньому той самий зміст і та сама геометрія: кожен елемент і кожен перехід на місці, підписи дослівні
 * (з урахуванням HTML-екранування), ширина переносу підпису події — та сама рамка, що в `.bpmn`,
 * повний текст тригера збережено в деталях елемента, і нічого не зроблено невидимим стилем.
 */
import { attr, elementChildren, parseXml, walk, XmlError, type XmlElement } from '../bpmn/xml.ts';
import type { Issue } from '../bpmn/types.ts';
import { START_ID } from '../csv/check.ts';
import type { BpmnModel } from './verify.ts';

export interface DrawioCell {
  id: string; value: string; style: string; parent: string;
  edge: boolean; vertex: boolean; source: string | null; target: string | null;
  geometry: { x: number; y: number; w: number; h: number } | null;
  tooltip: string | null;
}

const err = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'error', message, refs });

/** Зворотне перетворення тексту підпису html=1 → звичайний текст. */
export const unhtml = (v: string): string =>
  v.replaceAll('<br>', '\n').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function readDrawio(xml: string): { cells: DrawioCell[]; issues: Issue[] } {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    return { cells: [], issues: [err('DRAWIO_XML_MALFORMED', `Файл .drawio не є коректним XML: ${e instanceof XmlError ? e.message : String(e)}`)] };
  }
  const cells: DrawioCell[] = [];
  const issues: Issue[] = [];
  const readCell = (el: XmlElement, id: string, value: string, tooltip: string | null): void => {
    let geometry: DrawioCell['geometry'] = null;
    for (const ch of elementChildren(el)) {
      if (ch.local !== 'mxGeometry') continue;
      const x = Number(attr(ch, 'x') ?? 0), y = Number(attr(ch, 'y') ?? 0);
      const w = Number(attr(ch, 'width') ?? 0), h = Number(attr(ch, 'height') ?? 0);
      if ([x, y, w, h].every(Number.isFinite)) geometry = { x, y, w, h };
    }
    cells.push({
      id, value, tooltip, style: attr(el, 'style') ?? '', parent: attr(el, 'parent') ?? '',
      edge: attr(el, 'edge') === '1', vertex: attr(el, 'vertex') === '1',
      source: attr(el, 'source') ?? null, target: attr(el, 'target') ?? null, geometry,
    });
  };
  walk(root, (e) => {
    if (e.local === 'object') {
      const inner = elementChildren(e).find((c) => c.local === 'mxCell');
      if (!inner) { issues.push(err('DRAWIO_BAD_OBJECT', `Елемент <object> ${attr(e, 'id') ?? ''} без mxCell.`)); return; }
      readCell(inner, attr(e, 'id') ?? '', attr(e, 'label') ?? '', attr(e, 'tooltip') ?? null);
    } else if (e.local === 'mxCell' && e.parent?.local !== 'object') {
      readCell(e, attr(e, 'id') ?? '', attr(e, 'value') ?? '', null);
    }
  });
  return { cells, issues };
}

const styleMap = (style: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const part of style.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    m.set(i < 0 ? part : part.slice(0, i), i < 0 ? '' : part.slice(i + 1));
  }
  return m;
};

/** Параметри, якими елемент чи текст можна зробити невидимим. Їх у файлі бути не повинно. */
const HIDING = ['opacity', 'textOpacity', 'fillOpacity', 'strokeOpacity', 'noLabel', 'visible', 'fontColor', 'rotation', 'overflow'];

/** Який маркер/символ стилю відповідає якому елементу BPMN. Інше значення — нотація, якої в схемі немає. */
const STYLE_EXPECT: Record<string, { key: string; value: string }> = {
  task: { key: 'taskMarker', value: 'abstract' },
  userTask: { key: 'taskMarker', value: 'user' },
  serviceTask: { key: 'taskMarker', value: 'service' },
  manualTask: { key: 'taskMarker', value: 'manual' },
  exclusiveGateway: { key: 'gwType', value: 'exclusive' },
  startEvent: { key: 'symbol', value: 'general' },
  endEvent: { key: 'symbol', value: 'general' },
};

export function verifyDrawioAgainstBpmn(
  xml: string, bpmn: BpmnModel, fullTrigger: string | null,
  binding?: { versionId: string; contentHash: string },
): Issue[] {
  const out: Issue[] = [];
  if (!/<mxGraphModel[\s\S]*<\/mxGraphModel>/.test(xml)) {
    return [err('DRAWIO_STRUCTURE', 'У файлі .drawio немає розгорнутої моделі <mxGraphModel>: вміст перевірити неможливо (стиснена діаграма не приймається).')];
  }
  const { cells, issues } = readDrawio(xml);
  if (issues.length > 0) return issues;

  // прив'язка до погодженої версії
  if (binding) {
    const d = /<diagram\b[^>]*>/.exec(xml)?.[0] ?? '';
    const got = (k: string): string => new RegExp(`${k}="([^"]*)"`).exec(d)?.[1] ?? '';
    if (got('cx_version_id') !== binding.versionId || got('cx_content_hash') !== binding.contentHash) {
      out.push(err('DRAWIO_BINDING_MISMATCH', `Прив’язка .drawio до погодженої версії відсутня або не збігається з .bpmn (у файлі версія «${got('cx_version_id')}»).`));
    }
  }

  const byId = new Map<string, DrawioCell>();
  for (const c of cells) {
    if (byId.has(c.id)) out.push(err('DRAWIO_DUPLICATE_ID', `ID клітинки «${c.id}» використано двічі: яка з них справжня — невідомо.`, [c.id]));
    else byId.set(c.id, c);
  }

  const absolute = (c: DrawioCell): { x: number; y: number; w: number; h: number } | null => {
    if (!c.geometry) return null;
    let x = c.geometry.x, y = c.geometry.y;
    let p = byId.get(c.parent);
    let guard = 0;
    while (p && p.geometry && guard < 8) { x += p.geometry.x; y += p.geometry.y; p = byId.get(p.parent); guard += 1; }
    return { x, y, w: c.geometry.w, h: c.geometry.h };
  };

  const laneCellOf = (name: string): string | null => bpmn.lanes.find((l) => l.name === name)?.id ?? null;

  for (const n of bpmn.nodes.values()) {
    const cell = byId.get(n.id);
    if (!cell) {
      out.push(err('DRAWIO_CELL_MISSING', `У .drawio немає елемента ${n.id}.`, [n.id]));
      out.push(err('DRAWIO_STEP_MISSING', `Крок або подія ${n.id} у .drawio відсутні: файл показує не той процес.`, [n.id]));
      continue;
    }
    if (unhtml(cell.value) !== n.name) {
      out.push(err('DRAWIO_LABEL_MISMATCH', `Підпис елемента ${n.id} у .drawio «${unhtml(cell.value)}» не збігається з .bpmn «${n.name}».`, [n.id]));
    }
    // доріжка: клітинка має лежати в клітинці своєї доріжки
    const wantLane = n.lane ? laneCellOf(n.lane) : null;
    if (wantLane && cell.parent !== wantLane) {
      out.push(err('DRAWIO_WRONG_LANE', `Елемент ${n.id} у .drawio лежить у доріжці «${cell.parent}», а має — у «${wantLane}» (${n.lane}).`, [n.id]));
    }
    const a = absolute(cell);
    if (!a || !n.box) { out.push(err('DRAWIO_GEOMETRY', `Елемент ${n.id} у .drawio без геометрії.`, [n.id])); continue; }
    if (Math.abs(a.x - n.box.x) > 1 || Math.abs(a.y - n.box.y) > 1 || Math.abs(a.w - n.box.w) > 1 || Math.abs(a.h - n.box.h) > 1) {
      out.push(err('DRAWIO_GEOMETRY', `Елемент ${n.id}: координати в .drawio (${a.x}, ${a.y}, ${a.w}×${a.h}) не збігаються з .bpmn (${n.box.x}, ${n.box.y}, ${n.box.w}×${n.box.h}).`, [n.id]));
    }
    const st = styleMap(cell.style);
    for (const k of HIDING) {
      if (st.has(k)) out.push(err('DRAWIO_STYLE_HIDDEN', `Елемент ${n.id}: стиль містить «${k}», який може приховати елемент або його текст.`, [n.id]));
    }
    if (st.get('html') !== '1') out.push(err('DRAWIO_STYLE', `Елемент ${n.id}: html=${st.get('html') ?? '—'}; без html=1 draw.io не переносить довгий підпис.`, [n.id]));
    const expect = STYLE_EXPECT[n.tag];
    if (expect && st.get(expect.key) !== expect.value) {
      out.push(err('DRAWIO_UNSUPPORTED_STYLE', `Елемент ${n.id}: у стилі «${expect.key}=${st.get(expect.key) ?? '—'}», а за схемою має бути «${expect.value}». Інший маркер показує нотацію, якої в погодженому описі немає.`, [n.id]));
    }
    if (n.label) {
      const lw = Number(st.get('labelWidth'));
      if (!Number.isFinite(lw) || Math.abs(lw - n.label.w) > 1) {
        out.push(err('DRAWIO_LABEL_WIDTH', `Елемент ${n.id}: ширина переносу підпису в .drawio «${st.get('labelWidth') ?? '—'}» не збігається з рамкою підпису в .bpmn (${n.label.w}).`, [n.id]));
      }
    }
  }
  for (const c of cells) {
    if (!c.vertex || c.id === '0' || c.id === '1') continue;
    if (bpmn.nodes.has(c.id)) continue;
    if (c.style.includes('swimlane')) continue; // пул і доріжки
    out.push(err('DRAWIO_CELL_EXTRA', `У .drawio є зайвий елемент «${c.id}», якого немає в .bpmn.`, [c.id]));
  }

  // ── переходи ──
  const edges = cells.filter((c) => c.edge);
  if (edges.length !== bpmn.flows.length) {
    out.push(err('DRAWIO_EDGE_COUNT', `У .drawio ${edges.length} ліній, у .bpmn — ${bpmn.flows.length}.`));
  }
  for (const e of edges) {
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
    const st = styleMap(e.style);
    if (st.get('endArrow') !== 'blockThin' || st.get('endFill') !== '1') {
      out.push(err('DRAWIO_ARROW', `Лінія ${f.id}: наконечник стрілки змінено (endArrow=${st.get('endArrow') ?? '—'}), напрямок переходу стане невидимим.`, [f.id]));
    }
  }
  for (const f of bpmn.flows) {
    if (!edges.some((e) => e.id === f.id)) out.push(err('DRAWIO_CELL_MISSING', `У .drawio немає лінії ${f.id} (${f.source} → ${f.target}).`, [f.id]));
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
  const bySource = new Map<string, FlowLike[]>();
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

interface FlowLike { id: string; name: string; source: string; target: string }
const TASK_LIKE = new Set(['task', 'userTask', 'serviceTask', 'manualTask']);
