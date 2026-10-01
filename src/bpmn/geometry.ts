/**
 * Перевірки геометрії готової схеми (технічний план §1б: «покриття геометрією»; доручення: накладання,
 * обрізані назви й невидимі стрілки — дефекти результату).
 *
 * Помилки (файл не видається): відсутня чи неправильна геометрія, накладання блоків, блок поза доріжкою,
 * стрілка, не прикріплена до своїх блоків, назва, що явно не вміщується в блок.
 * Попередження (показуються, не блокують): стрілка проходить крізь чужий блок, підпис накладається на блок.
 */
import type { BpmnModel, Pt, Rect } from './read.ts';
import { ID } from './ids.ts';
import { ARIAL_FACTOR, neededTaskHeight, textWidth, wrapLines, LINE_HEIGHT } from './text.ts';
import type { Issue } from './types.ts';

export interface GeometryContext {
  /** Дружня назва елемента для повідомлень (наприклад, «крок S3 («…»)»). */
  nameOf: (elementId: string) => string;
  /** Дія кроку за ID задачі — для оцінки, чи вміщується підпис. */
  actionOfTask: (taskId: string) => string | undefined;
  /** Назва ролі за ID доріжки — для оцінки заголовка доріжки. */
  roleOfLane: (laneId: string) => string | undefined;
  poolName: string;
}

const TOL = 1.5;
const err = (code: string, message: string, refs: string[]): Issue => ({ code, severity: 'error', message, refs });
const warn = (code: string, message: string, refs: string[]): Issue => ({ code, severity: 'warning', message, refs });

const finite = (n: number): boolean => Number.isFinite(n) && Math.abs(n) < 1e6;
const rectOk = (r: Rect): boolean => finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h) && r.w > 0 && r.h > 0;

function overlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w - margin && a.x + a.w > b.x + margin && a.y < b.y + b.h - margin && a.y + a.h > b.y + margin;
}

function onBoundary(p: Pt, r: Rect): boolean {
  const inX = p.x >= r.x - TOL && p.x <= r.x + r.w + TOL;
  const inY = p.y >= r.y - TOL && p.y <= r.y + r.h + TOL;
  if (!inX || !inY) return false;
  return Math.abs(p.x - r.x) <= TOL || Math.abs(p.x - (r.x + r.w)) <= TOL || Math.abs(p.y - r.y) <= TOL || Math.abs(p.y - (r.y + r.h)) <= TOL;
}

/** Чи перетинає відрізок внутрішність прямокутника (стискаємо на 2 px, щоб дотик краєм не рахувався). */
function segmentHits(a: Pt, b: Pt, r: Rect): boolean {
  const x1 = r.x + 2, x2 = r.x + r.w - 2, y1 = r.y + 2, y2 = r.y + r.h - 2;
  if (x1 >= x2 || y1 >= y2) return false;
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  if (maxX < x1 || minX > x2 || maxY < y1 || minY > y2) return false;
  if (Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01) return true; // ортогональний відрізок із перекриттям у межах
  // довільний нахил: перевірка перетину зі сторонами
  const sides: [Pt, Pt][] = [[{ x: x1, y: y1 }, { x: x2, y: y1 }], [{ x: x2, y: y1 }, { x: x2, y: y2 }], [{ x: x2, y: y2 }, { x: x1, y: y2 }], [{ x: x1, y: y2 }, { x: x1, y: y1 }]];
  const inside = (p: Pt): boolean => p.x > x1 && p.x < x2 && p.y > y1 && p.y < y2;
  if (inside(a) || inside(b)) return true;
  const ccw = (p: Pt, q: Pt, s: Pt): boolean => (s.y - p.y) * (q.x - p.x) > (q.y - p.y) * (s.x - p.x);
  return sides.some(([c, d]) => ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d));
}

export function checkGeometry(m: BpmnModel, ctx: GeometryContext): Issue[] {
  const out: Issue[] = [];
  const nm = ctx.nameOf;

  // ── кожен елемент має рівно одну фігуру/лінію ──
  const expectShape: string[] = [];
  if (m.participant) expectShape.push(m.participant.id);
  for (const l of m.lanes) expectShape.push(l.id);
  for (const id of m.nodes.keys()) expectShape.push(id);
  const known = new Set<string>([...expectShape, ...m.flows.map((f) => f.id), m.processId ?? '', ID.collaboration]);

  const rectOf = new Map<string, Rect>();
  for (const id of expectShape) {
    const rs = m.shapes.get(id);
    if (!rs || rs.length === 0) { out.push(err('GEOMETRY_MISSING', `Для елемента ${nm(id)} немає геометрії (фігури): на схемі його не видно.`, [id])); continue; }
    if (rs.length > 1) out.push(err('DI_DUPLICATE', `Елемент ${nm(id)} має ${rs.length} фігури замість однієї.`, [id]));
    if (!rectOk(rs[0]!)) { out.push(err('GEOMETRY_INVALID', `Елемент ${nm(id)} має некоректну геометрію (розмір чи координати нечислові, нульові або від’ємні).`, [id])); continue; }
    rectOf.set(id, rs[0]!);
  }
  for (const f of m.flows) {
    const es = m.edges.get(f.id);
    if (!es || es.length === 0) { out.push(err('GEOMETRY_MISSING', `Для переходу ${nm(f.id)} немає лінії: стрілку на схемі не видно.`, [f.id])); continue; }
    if (es.length > 1) out.push(err('DI_DUPLICATE', `Перехід ${nm(f.id)} має ${es.length} лінії замість однієї.`, [f.id]));
    const pts = es[0]!;
    if (pts.length < 2) { out.push(err('GEOMETRY_INVALID', `Лінія переходу ${nm(f.id)} має менше двох точок.`, [f.id])); continue; }
    if (pts.some((p) => !finite(p.x) || !finite(p.y))) { out.push(err('GEOMETRY_INVALID', `Лінія переходу ${nm(f.id)} має нечислові координати.`, [f.id])); continue; }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (len < 8) out.push(err('EDGE_TOO_SHORT', `Лінія переходу ${nm(f.id)} має довжину ${len.toFixed(1)} px: стрілка практично невидима.`, [f.id]));
  }
  for (const ref of m.diRefs) {
    if (!known.has(ref)) out.push(err('DI_DANGLING', `Геометрія посилається на елемент «${ref}», якого немає у схемі.`, [ref]));
  }
  if (m.diagramCount !== 1) out.push(err('DI_STRUCTURE', `У файлі ${m.diagramCount} діаграм(и), а має бути одна.`, []));
  else if (m.planeRef !== ID.collaboration) out.push(err('DI_STRUCTURE', 'Площина діаграми посилається не на співпрацю (collaboration).', []));

  // ── доріжки в пулі, блоки в доріжках ──
  const pool = m.participant ? rectOf.get(m.participant.id) : undefined;
  const laneOf = new Map<string, string>();
  for (const l of m.lanes) for (const r of l.refs) if (!laneOf.has(r)) laneOf.set(r, l.id);
  for (const l of m.lanes) {
    const lr = rectOf.get(l.id);
    if (lr && pool && (lr.x < pool.x - TOL || lr.y < pool.y - TOL || lr.x + lr.w > pool.x + pool.w + TOL || lr.y + lr.h > pool.y + pool.h + TOL)) {
      out.push(err('LANE_OUTSIDE_POOL', `Доріжка ${nm(l.id)} виходить за межі пулу.`, [l.id]));
    }
  }
  for (let i = 0; i < m.lanes.length; i++) {
    for (let j = i + 1; j < m.lanes.length; j++) {
      const a = rectOf.get(m.lanes[i]!.id), b = rectOf.get(m.lanes[j]!.id);
      if (a && b && overlap(a, b, 1)) out.push(err('LANE_OVERLAP', `Доріжки ${nm(m.lanes[i]!.id)} і ${nm(m.lanes[j]!.id)} накладаються.`, [m.lanes[i]!.id, m.lanes[j]!.id]));
    }
  }
  const nodeIds = [...m.nodes.keys()];
  for (const id of nodeIds) {
    const r = rectOf.get(id);
    const laneId = laneOf.get(id);
    const lr = laneId ? rectOf.get(laneId) : undefined;
    if (r && lr && (r.x < lr.x - TOL || r.y < lr.y - TOL || r.x + r.w > lr.x + lr.w + TOL || r.y + r.h > lr.y + lr.h + TOL)) {
      out.push(err('SHAPE_OUTSIDE_LANE', `Блок ${nm(id)} виходить за межі своєї доріжки ${nm(laneId!)}.`, [id]));
    }
  }

  // ── накладання блоків ──
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const a = rectOf.get(nodeIds[i]!), b = rectOf.get(nodeIds[j]!);
      if (a && b && overlap(a, b, 1)) {
        out.push(err('SHAPE_OVERLAP', `Блоки ${nm(nodeIds[i]!)} і ${nm(nodeIds[j]!)} накладаються один на одного.`, [nodeIds[i]!, nodeIds[j]!]));
      }
    }
  }

  // ── стрілки: прикріплені до своїх блоків; не крізь чужі ──
  for (const f of m.flows) {
    const pts = m.edges.get(f.id)?.[0];
    const s = rectOf.get(f.source), t = rectOf.get(f.target);
    if (!pts || pts.length < 2 || pts.some((p) => !finite(p.x) || !finite(p.y))) continue;
    if (s && !onBoundary(pts[0]!, s)) out.push(err('EDGE_DETACHED', `Початок стрілки ${nm(f.id)} не торкається блока-джерела ${nm(f.source)}: стрілка «висить у повітрі».`, [f.id]));
    if (t && !onBoundary(pts[pts.length - 1]!, t)) out.push(err('EDGE_DETACHED', `Кінець стрілки ${nm(f.id)} не торкається блока-цілі ${nm(f.target)}.`, [f.id]));
    for (const id of nodeIds) {
      if (id === f.source || id === f.target) continue;
      const r = rectOf.get(id);
      if (!r) continue;
      let hit = false;
      for (let i = 1; i < pts.length && !hit; i++) hit = segmentHits(pts[i - 1]!, pts[i]!, r);
      if (hit) out.push(warn('EDGE_CROSSES_NODE', `Стрілка ${nm(f.id)} проходить крізь блок ${nm(id)}: частину лінії може бути не видно.`, [f.id, id]));
    }
  }

  // ── лінії, що повністю збігаються: одну з них не видно ──
  const sigs = new Map<string, string>();
  for (const f of m.flows) {
    const pts = m.edges.get(f.id)?.[0];
    if (!pts || pts.length < 2 || pts.some((p) => !finite(p.x) || !finite(p.y))) continue;
    const sig = pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ');
    const other = sigs.get(sig);
    if (other) out.push(err('EDGE_HIDDEN', `Лінії ${nm(f.id)} і ${nm(other)} повністю збігаються: одну з двох стрілок на схемі не видно.`, [f.id, other]));
    else sigs.set(sig, f.id);
  }

  // ── підписи: чи вміщуються у свої блоки ──
  for (const id of nodeIds) {
    const n = m.nodes.get(id)!;
    const r = rectOf.get(id);
    if (!r || n.tag !== 'task' || n.name === undefined) continue;
    const need = neededTaskHeight(n.name, r.w);
    if (need > r.h + 0.5) {
      out.push(err('LABEL_TRUNCATED', `Назва блока ${nm(id)} не вміщується: потрібно приблизно ${need} px висоти, а блок має ${Math.round(r.h)} px. Текст буде обрізано чи виповзе за межі.`, [id]));
    }
  }
  for (const l of m.lanes) {
    const r = rectOf.get(l.id);
    const role = ctx.roleOfLane(l.id);
    if (!r || role === undefined) continue;
    const lines = Math.ceil(textWidth(role) / Math.max(10, r.h - 12));
    if (lines * LINE_HEIGHT > 30) out.push(err('LABEL_TRUNCATED', `Назва доріжки ${nm(l.id)} не вміщується в її заголовок (висота доріжки ${Math.round(r.h)} px).`, [l.id]));
  }
  if (pool && m.participant && ctx.poolName) {
    const lines = Math.ceil(textWidth(ctx.poolName) / Math.max(10, pool.h - 12));
    if (lines * LINE_HEIGHT > 30) out.push(err('LABEL_TRUNCATED', 'Назва пулу не вміщується в його заголовок.', [m.participant.id]));
  }
  // зовнішні підписи (початкова подія, умови): оцінка за шириною й висотою рамки підпису
  const checkLabelBox = (ownerId: string, box: Rect, text: string): void => {
    const lines = wrapLines(text, Math.max(10, (box.w - 2) / ARIAL_FACTOR)).length;
    if (lines * LINE_HEIGHT > box.h + 8) {
      out.push(warn('LABEL_MAY_OVERFLOW', `Підпис ${nm(ownerId)} (${lines} рядків) може не вміститися в рамку підпису ${Math.round(box.w)}×${Math.round(box.h)} px.`, [ownerId]));
    }
  };
  for (const [id, box] of m.shapeLabels) {
    const t = m.nodes.get(id)?.name;
    if (t) checkLabelBox(id, box, t);
  }
  for (const [id, box] of m.edgeLabels) {
    const t = m.flows.find((f) => f.id === id)?.name;
    if (t) checkLabelBox(id, box, t);
  }
  // підписи не мають накладатися на блоки
  const allLabels: [string, Rect][] = [...m.shapeLabels, ...m.edgeLabels];
  for (const [id, box] of allLabels) {
    for (const nid of nodeIds) {
      if (nid === id) continue;
      const r = rectOf.get(nid);
      if (r && overlap(box, r, 1)) out.push(warn('LABEL_OVERLAP', `Підпис ${nm(id)} накладається на блок ${nm(nid)}.`, [id, nid]));
    }
  }
  for (let i = 0; i < allLabels.length; i++) {
    for (let j = i + 1; j < allLabels.length; j++) {
      if (overlap(allLabels[i]![1], allLabels[j]![1], 1)) out.push(warn('LABEL_OVERLAP', `Підписи ${nm(allLabels[i]![0])} і ${nm(allLabels[j]![0])} накладаються.`, [allLabels[i]![0], allLabels[j]![0]]));
    }
  }
  return out;
}
