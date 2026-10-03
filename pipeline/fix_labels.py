#!/usr/bin/env python3
"""BPMN із координатами → BPMN із ЧИТАБЕЛЬНИМИ координатами (Відмінність 5: новий крок робочої копії).

Навіщо цей крок (pipeline/DIFFERENCES.md, відмінність 5): bpmn-auto-layout ставить усі задачі в
коробку 100x80 і переносить зовнішні підписи в колонку ~90 px. На справжньому описі це дає:
  • текст задачі, що не вміщується у фігуру;
  • підпис початкової події у вигляді стовпчика 90x980, який виходить за межі пулу;
  • підписи умов на 7 рядків;
  • накладання підписів на фігури.
Скрипт НЕ змінює змісту: ні назв, ні типів, ні переходів, ні складу елементів. Він змінює лише
геометрію (dc:Bounds, di:waypoint) і додає рамки підписів там, де їх бракує.

Вихід: виправлений BPMN + JSON-звіт у stdout (попередження про нерозв'язані накладання).
"""
import argparse
import json
import math
import re
import sys
import xml.etree.ElementTree as ET

NS = {
    'bpmn': 'http://www.omg.org/spec/BPMN/20100524/MODEL',
    'bpmndi': 'http://www.omg.org/spec/BPMN/20100524/DI',
    'dc': 'http://www.omg.org/spec/DD/20100524/DC',
    'di': 'http://www.omg.org/spec/DD/20100524/DI',
}
for k, v in NS.items():
    ET.register_namespace(k, v)

Q = {k: '{%s}' % v for k, v in NS.items()}

# ── метрика тексту: та сама оцінка, що в src/bpmn/text.ts (тест tests/pipeline-text.test.ts звіряє їх) ──
FONT_PX = 12.0
LINE_HEIGHT = 14.4
NARROW_PUNCT = set('.,:;!\'|()[]{}«»"`ʼ’‘“”-–—/\\')
WIDE_LOWER = set('шщюыжфмwmШ')
WIDE_UPPER = set('ШЩЮЖФМЫWM')


def char_width(ch):
    if ch == ' ':
        return 3.6
    cp = ord(ch)
    if cp >= 0x2e80 or (0x1f000 <= cp <= 0x1faff) or (0x2600 <= cp <= 0x27bf):
        return FONT_PX * 1.05
    if ch.isdigit():
        return 7.6
    if ch in WIDE_UPPER:
        return 12.0
    if ch in WIDE_LOWER:
        return 10.4
    if ch in NARROW_PUNCT:
        return 4.0
    if ch.isalpha() and ch == ch.upper() and ch != ch.lower():
        return 9.2
    return 7.2


def text_width(t):
    return sum(char_width(c) for c in t)


def wrap_lines(text, width):
    """Жадібний перенос за словами; задовге слово ріжеться за символами (як wrapLines у text.ts)."""
    out = []
    for paragraph in text.split('\n'):
        words = [w for w in re.split(r'\s+', paragraph) if w]
        if not words:
            out.append('')
            continue
        cur, cur_w = '', 0.0
        for word in words:
            ww = text_width(word)
            sep = char_width(' ') if cur else 0.0
            if cur and cur_w + sep + ww <= width:
                cur += ' ' + word
                cur_w += sep + ww
                continue
            if cur:
                out.append(cur); cur, cur_w = '', 0.0
            if ww <= width:
                cur, cur_w = word, ww
                continue
            for ch in word:
                cw = char_width(ch)
                if cur_w + cw > width and cur:
                    out.append(cur); cur, cur_w = '', 0.0
                cur += ch
                cur_w += cw
        if cur:
            out.append(cur)
    return out


def box_for(text, widths, max_lines, pad):
    """Найвужча рамка зі списку, за якої текст не стає стовпчиком вище max_lines рядків."""
    best = None
    for w in widths:
        lines = wrap_lines(text, max(20.0, w - 2 * pad))
        h = len(lines) * LINE_HEIGHT + 2 * pad
        best = (w, h)
        if len(lines) <= max_lines:
            return (w, math.ceil(h))
    return (best[0], math.ceil(best[1]))


# ── параметри подання ──
TASK_WIDTHS = [100, 120, 140, 160, 180, 200, 240]
# Вертикальний запас у задачі: 20 px — поля тексту, ще 20 px — місце під іконку типу задачі
# у лівому верхньому куті (без запасу перший рядок підпису лягає під іконку).
TASK_PAD = 10
TASK_ICON_ROOM = 20
TASK_MIN_H = 80
EVENT_LABEL_WIDTHS = [140, 180, 220, 260, 300]
EVENT_LABEL_PAD = 4
EVENT_LABEL_GAP = 6
EVENT_LABEL_LINES = 2   # підпис події — не стовпчик: спершу ширша колонка, лише потім більше рядків
EDGE_LABEL_WIDTHS = [80, 110, 140, 170, 200]
EDGE_LABEL_PAD = 2
MIN_GAP = 40          # мінімальний просвіт між сусідніми стовпцями/рядами
LANE_MARGIN = 20      # відступ змісту від межі доріжки
POOL_HEADER = 30
TASK_TAGS = {'task', 'userTask', 'serviceTask', 'manualTask', 'scriptTask', 'sendTask',
             'receiveTask', 'businessRuleTask', 'subProcess', 'callActivity'}
EVENT_TAGS = {'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent',
              'boundaryEvent'}


def local(tag):
    return tag.split('}')[-1]


class Box:
    __slots__ = ('x', 'y', 'w', 'h')

    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h

    @property
    def cx(self):
        return self.x + self.w / 2

    @property
    def cy(self):
        return self.y + self.h / 2

    @property
    def right(self):
        return self.x + self.w

    @property
    def bottom(self):
        return self.y + self.h

    def overlaps(self, o, pad=0.0):
        return (self.x - pad < o.right and o.x - pad < self.right
                and self.y - pad < o.bottom and o.y - pad < self.bottom)

    def as_tuple(self):
        return (self.x, self.y, self.w, self.h)


def read_bounds(el):
    b = el.find('dc:Bounds', NS)
    if b is None:
        return None
    return Box(float(b.get('x')), float(b.get('y')), float(b.get('width')), float(b.get('height')))


def write_bounds(el, box):
    b = el.find('dc:Bounds', NS)
    if b is None:
        b = ET.SubElement(el, Q['dc'] + 'Bounds')
    b.set('x', fmt(box.x)); b.set('y', fmt(box.y))
    b.set('width', fmt(box.w)); b.set('height', fmt(box.h))


def fmt(v):
    return str(int(round(v)))


def piecewise(breaks):
    """breaks — список (координата, наскільки розсунути). Повертає монотонне відображення координати."""
    pts = sorted(breaks)

    def f(v):
        return v + sum(d for c, d in pts if c <= v)
    return f


def fix(path_in, path_out, max_task_lines=4):
    tree = ET.parse(path_in)
    root = tree.getroot()
    warnings = []

    # ── семантика: тип і назва елемента ──
    tag_of, name_of, flow_name = {}, {}, {}
    for col in root.findall('bpmn:collaboration', NS):
        for el in col.iter():
            if el.get('id'):
                tag_of[el.get('id')] = local(el.tag)
                if el.get('name'):
                    name_of[el.get('id')] = el.get('name')
    for p in root.findall('bpmn:process', NS):
        for el in p.iter():
            eid = el.get('id')
            if eid:
                tag_of[eid] = local(el.tag)
                if el.get('name'):
                    name_of[eid] = el.get('name')
        for f in p.findall('bpmn:sequenceFlow', NS):
            if f.get('name'):
                flow_name[f.get('id')] = f.get('name')

    # ── DI ──
    shapes = {}        # id -> (element, Box)
    lanes, pool = [], None
    for sh in root.findall('.//bpmndi:BPMNShape', NS):
        eid = sh.get('bpmnElement')
        box = read_bounds(sh)
        if box is None:
            continue
        t = tag_of.get(eid, '')
        if t == 'lane':
            lanes.append((sh, box))
        elif t == 'participant':
            pool = (sh, box)
        else:
            shapes[eid] = (sh, box)
    edges = []
    for ed in root.findall('.//bpmndi:BPMNEdge', NS):
        pts = ed.findall('di:waypoint', NS)
        edges.append((ed, pts))

    # ── 1. розмір задач під текст (центр лишається на місці) ──
    for eid, (sh, box) in shapes.items():
        if tag_of.get(eid) not in TASK_TAGS:
            continue
        text = name_of.get(eid, '')
        if not text:
            continue
        w, h = box_for(text, TASK_WIDTHS, max_task_lines, TASK_PAD)
        cx, cy = box.cx, box.cy
        box.w = max(box.w, float(w))
        box.h = max(box.h, float(max(TASK_MIN_H, h + TASK_ICON_ROOM)))
        box.x, box.y = cx - box.w / 2, cy - box.h / 2

    # ── 2. рамки зовнішніх підписів подій ──
    event_labels = {}   # id -> Box (поки лише розмір)
    for eid, (sh, box) in shapes.items():
        if tag_of.get(eid) not in EVENT_TAGS:
            continue
        text = name_of.get(eid, '')
        if not text.strip():
            continue
        w, h = box_for(text, EVENT_LABEL_WIDTHS, EVENT_LABEL_LINES, EVENT_LABEL_PAD)
        event_labels[eid] = Box(box.cx - w / 2, box.bottom + EVENT_LABEL_GAP, float(w), float(h))

    # ── 3. рамки підписів переходів (поки лише розмір; позиція — навколо наявного центра) ──
    edge_labels = []    # (element_label, Box, edge_element)
    for ed, pts in edges:
        fid = ed.get('bpmnElement')
        text = flow_name.get(fid)
        if not text:
            continue
        lbl = ed.find('bpmndi:BPMNLabel', NS)
        w, h = box_for(text, EDGE_LABEL_WIDTHS, 4, EDGE_LABEL_PAD)
        old = read_bounds(lbl) if lbl is not None else None
        if lbl is None:
            lbl = ET.SubElement(ed, Q['bpmndi'] + 'BPMNLabel')
        if old is not None:
            cx, cy = old.cx, old.cy
        else:
            mid = pts[len(pts) // 2]
            cx, cy = float(mid.get('x')), float(mid.get('y')) - h / 2 - 4
        edge_labels.append((lbl, Box(cx - w / 2, cy - h / 2, float(w), float(h)), ed))

    # ── 4. просвіти між стовпцями й рядами (з урахуванням зовнішніх підписів подій) ──
    def footprint(eid):
        box = shapes[eid][1]
        lb = event_labels.get(eid)
        if lb is None:
            return box
        x0, y0 = min(box.x, lb.x), min(box.y, lb.y)
        return Box(x0, y0, max(box.right, lb.right) - x0, max(box.bottom, lb.bottom) - y0)

    def axis_breaks(key_c, key_lo, key_hi, bands, band_margin):
        """Розсунути сусідні стовпці/ряди до MIN_GAP і дати відступ від межі смуги.
        Точки розриву — у ВИХІДНИХ координатах, у просвітах між фігурами."""
        groups = {}
        for eid in shapes:
            groups.setdefault(round(key_c(eid), 1), []).append(eid)
        keys = sorted(groups)
        breaks = []
        for i in range(len(keys) - 1):
            hi = max(key_hi(e) for e in groups[keys[i]])
            lo = min(key_lo(e) for e in groups[keys[i + 1]])
            need = MIN_GAP - (lo - hi)
            if need > 0:
                breaks.append(((hi + lo) / 2, need))
        for lo_bound, hi_bound in bands:
            inside = [e for e in shapes if lo_bound <= key_c(e) <= hi_bound]
            if not inside:
                continue
            top = min(key_lo(e) for e in inside)
            need = band_margin - (top - lo_bound)
            if need > 0:
                breaks.append(((lo_bound + top) / 2, need))
        return breaks

    lane_y = [(b.y, b.bottom) for _, b in lanes] or ([(pool[1].y, pool[1].bottom)] if pool else [])
    lane_x0 = (pool[1].x + POOL_HEADER) if pool else None
    x_bands = [(lane_x0, float('inf'))] if lane_x0 is not None else []
    xmap = piecewise(axis_breaks(lambda e: footprint(e).cx, lambda e: footprint(e).x,
                                 lambda e: footprint(e).right, x_bands, LANE_MARGIN))
    ymap = piecewise(axis_breaks(lambda e: footprint(e).cy, lambda e: footprint(e).y,
                                 lambda e: footprint(e).bottom, lane_y, LANE_MARGIN))

    # ── 5. застосування відображень (центри фігур, підписи, точки ліній) ──
    for eid, (sh, box) in shapes.items():
        cx, cy = xmap(box.cx), ymap(box.cy)
        box.x, box.y = cx - box.w / 2, cy - box.h / 2
    for _, lb, _ in edge_labels:
        cx, cy = xmap(lb.cx), ymap(lb.cy)
        lb.x, lb.y = cx - lb.w / 2, cy - lb.h / 2
    for ed, pts in edges:
        for p in pts:
            p.set('x', fmt(xmap(float(p.get('x')))))
            p.set('y', fmt(ymap(float(p.get('y')))))
    bands = []
    for sh, b in sorted(lanes, key=lambda t: t[1].y):
        b.y, b.h = ymap(b.y), ymap(b.bottom) - ymap(b.y)
        bands.append((sh, b))

    # ── 6. зовнішні підписи подій: під подією, по центру ──
    for eid, lb in event_labels.items():
        box = shapes[eid][1]
        lb.x, lb.y = box.cx - lb.w / 2, box.bottom + EVENT_LABEL_GAP

    # ── 7. (приєднання стрілок виконується в кроці 11, після всіх переміщень) ──
    src_of, tgt_of = {}, {}
    for p in root.findall('bpmn:process', NS):
        for f in p.findall('bpmn:sequenceFlow', NS):
            src_of[f.get('id')] = f.get('sourceRef')
            tgt_of[f.get('id')] = f.get('targetRef')

    # ── 8. смуги доріжок під фактичний зміст; порядок доріжок збережено ──
    content_all = lambda: [shapes[e][1] for e in shapes] + list(event_labels.values()) + [b for _, b, _ in edge_labels]
    if pool is not None:
        if bands:
            assign = {}
            for eid in shapes:
                cy = shapes[eid][1].cy
                band = min(bands, key=lambda t: 0 if t[1].y <= cy <= t[1].bottom else min(abs(cy - t[1].y), abs(cy - t[1].bottom)))
                assign.setdefault(id(band[1]), []).append(eid)
            plan = []
            for sh, b in bands:
                ids = assign.get(id(b), [])
                boxes = [shapes[e][1] for e in ids] + [event_labels[e] for e in ids if e in event_labels]
                if boxes:
                    top = min(x.y for x in boxes) - LANE_MARGIN
                    bottom = max(x.bottom for x in boxes) + LANE_MARGIN
                else:
                    top, bottom = b.y, b.y + 60.0
                # Відмінність 15: заголовок доріжки вертикальний, тому його ДОВЖИНА обмежена ВИСОТОЮ доріжки.
                # Назву ролі не скорочуємо — збільшуємо доріжку (інакше підпис обрізається).
                title = name_of.get(sh.get('bpmnElement'), '')
                need = text_width(title) + 24 if title else 0
                bottom = max(bottom, top + max(60.0, need))
                plan.append((sh, b, ids, top, bottom))
            cursor = pool[1].y
            shifts = []
            for sh, b, ids, top, bottom in plan:
                dy = cursor - top
                for eid in ids:
                    shapes[eid][1].y += dy
                    if eid in event_labels:
                        event_labels[eid].y += dy
                shifts.append((b.y, b.bottom, dy))
                b.x, b.y, b.h = pool[1].x + POOL_HEADER, cursor, bottom - top
                cursor += b.h
            def shift_y(y):
                for lo, hi, dy in shifts:
                    if lo <= y <= hi:
                        return y + dy
                return y + (shifts[0][2] if shifts else 0.0)
            for _, lb, _ in edge_labels:
                lb.y = shift_y(lb.cy) - lb.h / 2
            for ed, pts in edges:
                for p in pts:
                    p.set('y', fmt(shift_y(float(p.get('y')))))
            pool[1].h = cursor - pool[1].y
            # те саме для напису на пулі: він теж вертикальний
            pool_title = name_of.get(pool[0].get('bpmnElement'), '')
            if pool_title:
                pool[1].h = max(pool[1].h, text_width(pool_title) + 24)
                if plan:
                    last = plan[-1][1]
                    last.h = pool[1].bottom - last.y
        else:
            pool[1].h = max(b.bottom for b in content_all()) + LANE_MARGIN - pool[1].y
        lane_x = pool[1].x + POOL_HEADER
        max_x = max(b.right for b in content_all())
        min_x = min(b.x for b in content_all())
        if min_x < lane_x:
            warnings.append('CONTENT_LEFT_OF_LANE: зміст виходить за ліву межу доріжки')
        lane_w = max_x + LANE_MARGIN - lane_x
        for sh, b in bands:
            b.x, b.w = lane_x, lane_w
        pool[1].w = lane_w + POOL_HEADER

    # ── 9. накладання підписів переходів: зсув, доки не звільниться ──
    solid = [shapes[e][1] for e in shapes] + list(event_labels.values())
    placed = []
    for lbl, b, ed in edge_labels:
        def free(cand):
            return (not any(cand.overlaps(o, -2) for o in solid)
                    and not any(cand.overlaps(p, -2) for p in placed))
        if not free(b):
            moved = False
            for step in range(1, 15):
                for dy in (-step * 8, step * 8):
                    cand = Box(b.x, b.y + dy, b.w, b.h)
                    if free(cand):
                        b.y = cand.y
                        moved = True
                        break
                if moved:
                    break
            if not moved:
                warnings.append('LABEL_OVERLAP: підпис переходу %s не вдалося розмістити без накладання' % ed.get('bpmnElement'))
        placed.append(b)

    # ── 9.5. дві різні лінії між тими самими фігурами не повинні збігатися ──
    # Відмінність 14: лейаутер веде обидві лінії однаково, і одну з двох стрілок на схемі просто не видно
    # (а з нею — і її умову). Другу й наступні розводимо паралельно.
    seen_paths = {}
    separated = []
    for ed, pts in edges:
        key = tuple((p.get('x'), p.get('y')) for p in pts)
        n = seen_paths.get(key, 0)
        seen_paths[key] = n + 1
        if n == 0 or len(pts) < 2:
            continue
        off = 22 * ((n + 1) // 2) * (1 if n % 2 else -1)
        horizontal = abs(float(pts[1].get('y')) - float(pts[0].get('y'))) < 1
        for p in pts:
            if horizontal:
                p.set('y', fmt(float(p.get('y')) + off))
            else:
                p.set('x', fmt(float(p.get('x')) + off))
        separated.append(ed.get('bpmnElement'))

    # ── 10. кінці стрілок — рівно на межі фігури (фігури змінили розмір і зсунулись) ──
    def attach(p_end, p_prev, box):
        x0, y0 = float(p_end.get('x')), float(p_end.get('y'))
        x1, y1 = float(p_prev.get('x')), float(p_prev.get('y'))
        if abs(x1 - x0) < 1.5:          # вертикальний підхід
            x = min(max(x0, box.x + 6), box.right - 6)
            p_end.set('x', fmt(x)); p_prev.set('x', fmt(x))
            p_end.set('y', fmt(box.bottom if y1 > box.cy else box.y))
        elif abs(y1 - y0) < 1.5:        # горизонтальний підхід
            y = min(max(y0, box.y + 6), box.bottom - 6)
            p_end.set('y', fmt(y)); p_prev.set('y', fmt(y))
            p_end.set('x', fmt(box.right if x1 > box.cx else box.x))
        else:                           # не осьовий — ставимо на найближчу вертикальну межу
            p_end.set('x', fmt(box.right if x1 > box.cx else box.x))
            p_end.set('y', fmt(min(max(y0, box.y + 6), box.bottom - 6)))

    for ed, pts in edges:
        if len(pts) < 2:
            continue
        fid = ed.get('bpmnElement')
        if src_of.get(fid) in shapes:
            attach(pts[0], pts[1], shapes[src_of[fid]][1])
        if tgt_of.get(fid) in shapes:
            attach(pts[-1], pts[-2], shapes[tgt_of[fid]][1])

    # ── 11. запис геометрії ──
    for eid, (sh, box) in shapes.items():
        write_bounds(sh, box)
    for eid, lb in event_labels.items():
        sh = shapes[eid][0]
        lbl = sh.find('bpmndi:BPMNLabel', NS)
        if lbl is None:
            lbl = ET.SubElement(sh, Q['bpmndi'] + 'BPMNLabel')
        write_bounds(lbl, lb)
    for lbl, b, _ in edge_labels:
        write_bounds(lbl, b)
    for sh, b in bands:
        write_bounds(sh, b)
    if pool is not None:
        write_bounds(pool[0], pool[1])

    # Відмінність 12: площина діаграми має посилатися на співпрацю (collaboration), а не на процес —
    # інакше пул і доріжки формально не належать діаграмі (DI_STRUCTURE у зворотній перевірці).
    collab = root.find('bpmn:collaboration', NS)
    for plane in root.findall('.//bpmndi:BPMNPlane', NS):
        if collab is not None and plane.get('bpmnElement') != collab.get('id'):
            plane.set('bpmnElement', collab.get('id'))

    tree.write(path_out, encoding='utf-8', xml_declaration=True)
    report = {
        'ok': True,
        'warnings': warnings,
        'pool': pool[1].as_tuple() if pool else None,
        'lanes': len(lanes),
        'shapes': len(shapes),
        'event_labels': len(event_labels),
        'edge_labels': len(edge_labels),
        # Лінії, які довелося розвести, щоб вони не лягли одна на одну (нормальна дія, не попередження).
        'edges_separated': separated,
    }
    print(json.dumps(report, ensure_ascii=False))
    return report


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Виправлення розмірів і розташування підписів у DI')
    ap.add_argument('bpmn_in')
    ap.add_argument('bpmn_out')
    ap.add_argument('--max-task-lines', type=int, default=4)
    a = ap.parse_args()
    fix(a.bpmn_in, a.bpmn_out, a.max_task_lines)
