/**
 * Розкладка: `bpmn-auto-layout@2.0.0-alpha.2` (MIT) + власна постобробка геометрії.
 *
 * Чому постобробка: лейаутер ігнорує розміри з вхідного файлу й завжди малює задачі 100×80,
 * тож довга дія не вміщається й «виповзає» з блока. Після розкладки схема пропорційно збільшується
 * (задачі — разом зі схемою, події й шлюзи лишаються того самого розміру), доки найдовший підпис не вміститься.
 * Простір між елементами при цьому лише росте, тож розкладка без накладань лишається без накладань.
 *
 * Без глобального стану: усе в пам'яті, результат залежить тільки від входу.
 */
import { layoutProcess, LayoutError } from 'bpmn-auto-layout';
import { NS } from './ids.ts';
import { parseXml, serialize, attr, elementChildren, type XmlElement } from './xml.ts';
import { neededTaskHeight, textWidth } from './text.ts';
import { poolNameOf, type ApprovedPackage, type Issue } from './types.ts';

export interface LayoutOutcome {
  ok: boolean;
  xml: string;
  scale: { x: number; y: number };
  warnings: string[];
  issues: Issue[];
}

const WIDTHS = [100, 140, 180, 220, 260];
const DEFAULT_W = 100;
const DEFAULT_H = 80;
const HEADER = 30;

/** Підбір розміру задачі за найдовшою дією: перша ширина, за якої всі підписи вміщаються без надмірної висоти. */
export function chooseTaskSize(actions: string[]): { width: number; height: number } {
  for (const w of WIDTHS) {
    const h = Math.max(DEFAULT_H, ...actions.map((t) => neededTaskHeight(t, w)));
    if (h <= Math.max(DEFAULT_H, Math.round(w * 0.8))) return { width: w, height: roundUp10(h) };
  }
  const w = WIDTHS[WIDTHS.length - 1]!;
  return { width: w, height: roundUp10(Math.max(DEFAULT_H, ...actions.map((t) => neededTaskHeight(t, w)))) };
}

const roundUp10 = (v: number): number => Math.ceil(v / 10) * 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

interface Rect { x: number; y: number; w: number; h: number }
type Side = 'left' | 'right' | 'top' | 'bottom';

function boundsOf(el: XmlElement): { node: XmlElement; rect: Rect } | null {
  const b = elementChildren(el).find((c) => c.ns === NS.dc && c.local === 'Bounds');
  if (!b) return null;
  const n = (k: string): number => Number(attr(b, k));
  return { node: b, rect: { x: n('x'), y: n('y'), w: n('width'), h: n('height') } };
}

function setBounds(node: XmlElement, r: Rect): void {
  const set = (k: string, v: number): void => {
    const a = node.attrs.find((x) => x.local === k && x.ns === '');
    if (a) a.value = String(r2(v));
  };
  set('x', r.x); set('y', r.y); set('width', r.w); set('height', r.h);
}

function sideOf(p: { x: number; y: number }, r: Rect): { side: Side; t: number } | null {
  const tol = 1.5;
  const cands: { side: Side; d: number; t: number }[] = [];
  const inX = p.x >= r.x - tol && p.x <= r.x + r.w + tol;
  const inY = p.y >= r.y - tol && p.y <= r.y + r.h + tol;
  if (inY) {
    cands.push({ side: 'left', d: Math.abs(p.x - r.x), t: (p.y - r.y) / r.h });
    cands.push({ side: 'right', d: Math.abs(p.x - (r.x + r.w)), t: (p.y - r.y) / r.h });
  }
  if (inX) {
    cands.push({ side: 'top', d: Math.abs(p.y - r.y), t: (p.x - r.x) / r.w });
    cands.push({ side: 'bottom', d: Math.abs(p.y - (r.y + r.h)), t: (p.x - r.x) / r.w });
  }
  cands.sort((a, b) => a.d - b.d);
  const best = cands[0];
  return best && best.d <= tol ? { side: best.side, t: best.t } : null;
}

function pointOn(side: Side, t: number, r: Rect): { x: number; y: number } {
  switch (side) {
    case 'left': return { x: r.x, y: r.y + t * r.h };
    case 'right': return { x: r.x + r.w, y: r.y + t * r.h };
    case 'top': return { x: r.x + t * r.w, y: r.y };
    case 'bottom': return { x: r.x + t * r.w, y: r.y + r.h };
  }
}

export async function layoutAndScale(semanticXml: string, pkg: ApprovedPackage): Promise<LayoutOutcome> {
  const fail = (code: string, message: string, warnings: string[] = []): LayoutOutcome => ({
    ok: false, xml: '', scale: { x: 1, y: 1 }, warnings,
    issues: [{ code, severity: 'error', message, refs: [] }],
  });

  let laid: { xml: string; warnings: { code: string; elementId: string; message: string }[] };
  try {
    laid = await layoutProcess(semanticXml);
  } catch (e) {
    if (e instanceof LayoutError) {
      return fail('LAYOUT_ERROR', `Лейаутер відхилив схему (${e.code}, елемент ${e.elementId}): ${e.message}`);
    }
    return fail('LAYOUT_CRASH', `Лейаутер завершився збоєм: ${e instanceof Error ? e.message : String(e)}`);
  }
  const warnings = laid.warnings.map((w) => `${w.code} (${w.elementId}): ${w.message}`);
  // Будь-яке попередження лейаутера вважаємо ознакою втраченої геометрії (відомий код DI_NOT_CREATED) — файл не видається.
  if (warnings.length) {
    return fail('LAYOUT_WARNING', `Лейаутер повернув попередження: ${warnings.join('; ')}. Схему не видано: частина елементів могла лишитися без геометрії.`, warnings);
  }

  let root: XmlElement;
  try {
    root = parseXml(laid.xml);
  } catch (e) {
    return fail('LAYOUT_BAD_XML', `Результат лейаутера не є коректним XML: ${e instanceof Error ? e.message : String(e)}`);
  }

  // індекс семантичних елементів і DI
  const semTag = new Map<string, string>();
  const walk = (e: XmlElement): void => {
    const id = attr(e, 'id');
    if (id && e.ns === NS.bpmn) semTag.set(id, e.local);
    elementChildren(e).forEach(walk);
  };
  walk(root);

  const plane = findFirst(root, (e) => e.ns === NS.bpmndi && e.local === 'BPMNPlane');
  if (!plane) return fail('LAYOUT_NO_PLANE', 'У результаті лейаутера немає BPMNPlane.');
  const shapes = new Map<string, { node: XmlElement; b: { node: XmlElement; rect: Rect } }>();
  const edges: { node: XmlElement; id: string; pts: XmlElement[] }[] = [];
  for (const e of elementChildren(plane)) {
    const id = attr(e, 'bpmnElement') ?? '';
    if (e.ns === NS.bpmndi && e.local === 'BPMNShape') {
      const b = boundsOf(e);
      if (b) shapes.set(id, { node: e, b });
    } else if (e.ns === NS.bpmndi && e.local === 'BPMNEdge') {
      edges.push({ node: e, id, pts: elementChildren(e).filter((c) => c.ns === NS.di && c.local === 'waypoint') });
    }
  }
  const pool = shapes.get('Participant_1');
  if (!pool) return fail('LAYOUT_NO_POOL', 'Лейаутер не створив геометрії пулу.');

  // масштаб
  const actions = pkg.content.steps.map((s) => s.action);
  const size = chooseTaskSize(actions);
  let sx = size.width / DEFAULT_W;
  let sy = size.height / DEFAULT_H;
  // назви ролей і пулу (повернуті вздовж доріжки) мають вміщатися у 2 рядки заголовка
  const laneShapes = [...shapes.entries()].filter(([id]) => semTag.get(id) === 'lane');
  for (const [id, s] of laneShapes) {
    const role = pkg.content.roles[Number(id.replace('Lane_', ''))] ?? '';
    const need = textWidth(role) / 2 + 24;
    sy = Math.max(sy, need / s.b.rect.h);
  }
  const poolH = pool.b.rect.h;
  sy = Math.max(sy, (textWidth(poolNameOf(pkg)) / 2 + 24) / poolH);
  sx = Math.max(1, r2(sx));
  sy = Math.max(1, r2(Math.ceil(sy * 20) / 20));

  const X0 = pool.b.rect.x + HEADER;
  const Y0 = pool.b.rect.y;
  const tx = (x: number): number => X0 + (x - X0) * sx;
  const ty = (y: number): number => Y0 + (y - Y0) * sy;

  const oldRects = new Map<string, Rect>();
  for (const [id, s] of shapes) oldRects.set(id, { ...s.b.rect });
  const newRects = new Map<string, Rect>();

  for (const [id, s] of shapes) {
    const o = s.b.rect;
    const tag = semTag.get(id);
    let n: Rect;
    if (tag === 'participant') {
      n = { x: o.x, y: o.y, w: HEADER + (o.w - HEADER) * sx, h: o.h * sy };
    } else if (tag === 'lane') {
      n = { x: o.x, y: ty(o.y), w: o.w * sx, h: o.h * sy };
    } else if (tag === 'task') {
      const cx = tx(o.x + o.w / 2), cy = ty(o.y + o.h / 2);
      const w = o.w * sx, h = o.h * sy;
      n = { x: cx - w / 2, y: cy - h / 2, w, h };
    } else {
      const cx = tx(o.x + o.w / 2), cy = ty(o.y + o.h / 2);
      n = { x: cx - o.w / 2, y: cy - o.h / 2, w: o.w, h: o.h };
    }
    n = { x: r2(n.x), y: r2(n.y), w: r2(n.w), h: r2(n.h) };
    newRects.set(id, n);
    setBounds(s.b.node, n);
    // підпис події (зовнішній) — переносимо центр, розмір лишаємо
    // підпис події (зовнішній): відстань від центра події лишається незмінною (масштабується лише положення події)
    const label = elementChildren(s.node).find((c) => c.ns === NS.bpmndi && c.local === 'BPMNLabel');
    const lb = label ? boundsOf(label) : null;
    if (lb) {
      const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
      const ncx = n.x + n.w / 2, ncy = n.y + n.h / 2;
      const cx = ncx + (lb.rect.x + lb.rect.w / 2 - ocx), cy = ncy + (lb.rect.y + lb.rect.h / 2 - ocy);
      setBounds(lb.node, { x: cx - lb.rect.w / 2, y: cy - lb.rect.h / 2, w: lb.rect.w, h: lb.rect.h });
    }
  }

  // переходи
  const flowEnds = new Map<string, { source: string; target: string }>();
  const walkFlows = (e: XmlElement): void => {
    if (e.ns === NS.bpmn && e.local === 'sequenceFlow') {
      flowEnds.set(attr(e, 'id') ?? '', { source: attr(e, 'sourceRef') ?? '', target: attr(e, 'targetRef') ?? '' });
    }
    elementChildren(e).forEach(walkFlows);
  };
  walkFlows(root);

  interface Planned { e: (typeof edges)[number]; ends: { source: string; target: string }; pts: Pt2[]; newPts: Pt2[]; label: { node: XmlElement; rect: Rect; center: Pt2 } | null }
  const planned: Planned[] = [];
  for (const e of edges) {
    const ends = flowEnds.get(e.id);
    const pts = e.pts.map((p) => ({ x: Number(attr(p, 'x')), y: Number(attr(p, 'y')) }));
    if (!ends || pts.length < 2) continue;
    const newPts = pts.map((p) => ({ x: tx(p.x), y: ty(p.y) }));
    const fix = (idx: number, shapeId: string): void => {
      const o = oldRects.get(shapeId), n = newRects.get(shapeId);
      if (!o || !n) return;
      const s = sideOf(pts[idx]!, o);
      if (s) newPts[idx] = pointOn(s.side, s.t, n);
    };
    fix(0, ends.source);
    fix(pts.length - 1, ends.target);
    // ортогональність: сегмент, що був горизонтальним/вертикальним, лишається таким
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]!.y - pts[i - 1]!.y) < 0.01 && !(i === pts.length - 1)) newPts[i]!.y = newPts[i - 1]!.y;
      else if (Math.abs(pts[i]!.x - pts[i - 1]!.x) < 0.01 && !(i === pts.length - 1)) newPts[i]!.x = newPts[i - 1]!.x;
    }
    for (let i = pts.length - 2; i >= 0; i--) {
      if (Math.abs(pts[i]!.y - pts[i + 1]!.y) < 0.01 && i !== 0) newPts[i]!.y = newPts[i + 1]!.y;
      else if (Math.abs(pts[i]!.x - pts[i + 1]!.x) < 0.01 && i !== 0) newPts[i]!.x = newPts[i + 1]!.x;
    }
    // підпис умови: тієї ж точки вздовж лінії; відстань до лінії лишається, плюс 8 px запасу (текст ширший за рамку лейаутера)
    const label = elementChildren(e.node).find((c) => c.ns === NS.bpmndi && c.local === 'BPMNLabel');
    const lb = label ? boundsOf(label) : null;
    let planLabel: Planned['label'] = null;
    if (lb) {
      const c0 = { x: lb.rect.x + lb.rect.w / 2, y: lb.rect.y + lb.rect.h / 2 };
      const at = closestOnPolyline(pts, c0);
      const anchor = pointAt(newPts, at.seg, at.t);
      const ox = c0.x - at.x, oy = c0.y - at.y;
      const len = Math.hypot(ox, oy);
      const gap = len > 0 ? 8 / len : 0;
      planLabel = { node: lb.node, rect: lb.rect, center: { x: anchor.x + ox * (1 + gap), y: anchor.y + oy * (1 + gap) } };
    }
    planned.push({ e, ends, pts, newPts, label: planLabel });
  }

  // Лінії з одного джерела в ту саму ціль (різні умови) лейаутер малює однією лінією; розводимо їх біля цілі,
  // щоб кожну стрілку було видно окремо.
  const groups = new Map<string, Planned[]>();
  for (const p of planned) groups.set(`${p.ends.source}>${p.ends.target}`, [...(groups.get(`${p.ends.source}>${p.ends.target}`) ?? []), p]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sig = (q: Pt2[]): string => q.map((x) => `${Math.round(x.x)},${Math.round(x.y)}`).join(' ');
    const identical = new Map<string, Planned[]>();
    for (const p of g) identical.set(sig(p.newPts), [...(identical.get(sig(p.newPts)) ?? []), p]);
    for (const same of identical.values()) {
      if (same.length < 2) continue;
      const target = newRects.get(same[0]!.ends.target);
      if (target) separateCoincident(same.map((p) => p.newPts), target, same);
    }
  }

  for (const p of planned) {
    // кількість точок могла змінитися: замінюємо всі точки лінії
    for (const w of p.e.pts) p.e.node.children.splice(p.e.node.children.indexOf(w), 1);
    const firstLabel = p.e.node.children.findIndex((c) => typeof c !== 'string' && c.ns === NS.bpmndi && c.local === 'BPMNLabel');
    const at = firstLabel < 0 ? p.e.node.children.length : firstLabel;
    const nodes = p.newPts.map((pt): XmlElement => ({
      name: 'di:waypoint', ns: NS.di, local: 'waypoint', parent: p.e.node, children: [],
      attrs: [
        { name: 'x', value: String(r2(pt.x)), ns: '', local: 'x' },
        { name: 'y', value: String(r2(pt.y)), ns: '', local: 'y' },
      ],
    }));
    p.e.node.children.splice(at, 0, ...nodes);
    if (p.label) setBounds(p.label.node, { x: p.label.center.x - p.label.rect.w / 2, y: p.label.center.y - p.label.rect.h / 2, w: p.label.rect.w, h: p.label.rect.h });
  }

  return { ok: true, xml: serialize(root), scale: { x: sx, y: sy }, warnings: [], issues: [] };
}

function findFirst(e: XmlElement, pred: (e: XmlElement) => boolean): XmlElement | null {
  if (pred(e)) return e;
  for (const c of elementChildren(e)) {
    const r = findFirst(c, pred);
    if (r) return r;
  }
  return null;
}

interface Pt2 { x: number; y: number }

/** Найближча до точки `c` точка ламаної: номер відрізка, частка t уздовж відрізка й сама точка. */
function closestOnPolyline(pts: Pt2[], c: Pt2): { seg: number; t: number; x: number; y: number } {
  let best = { d: Infinity, seg: 0, t: 0, x: pts[0]!.x, y: pts[0]!.y };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / l2));
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < best.d) best = { d, seg: i - 1, t, x, y };
  }
  return best;
}

function pointAt(pts: Pt2[], seg: number, t: number): Pt2 {
  const a = pts[seg]!, b = pts[seg + 1]!;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Розводить лінії, що повністю збігаються (однакове джерело й ціль): кожна підходить до цілі на своєму рівні.
 * Зсув — паралельно останньому сегменту, у межах сторони цілі. Пряма лінія з двох точок отримує злам.
 */
function separateCoincident(lines: Pt2[][], target: Rect, items: { newPts: Pt2[] }[]): void {
  const k = lines.length;
  const first = lines[0]!;
  const a0 = first[first.length - 2]!, b0 = first[first.length - 1]!;
  const horizontal = Math.abs(a0.y - b0.y) < 0.5;
  const lo = (horizontal ? target.y : target.x) + 8;
  const hi = (horizontal ? target.y + target.h : target.x + target.w) - 8;
  const step = Math.min(18, (hi - lo) / Math.max(1, k));
  lines.forEach((pts, i) => {
    const n = pts.length;
    const b = pts[n - 1]!, a = pts[n - 2]!;
    const want = (horizontal ? b.y : b.x) + (i - (k - 1) / 2) * step;
    const clamped = Math.min(hi, Math.max(lo, want));
    const d = clamped - (horizontal ? b.y : b.x);
    if (n >= 3) {
      if (horizontal) { a.y += d; b.y += d; } else { a.x += d; b.x += d; }
    } else {
      // пряма лінія: додаємо злам посередині
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const next: Pt2[] = horizontal
        ? [a, { x: mx, y: a.y }, { x: mx, y: a.y + d }, { x: b.x, y: b.y + d }]
        : [a, { x: a.x, y: my }, { x: a.x + d, y: my }, { x: b.x + d, y: b.y }];
      items[i]!.newPts = next;
    }
  });
}
