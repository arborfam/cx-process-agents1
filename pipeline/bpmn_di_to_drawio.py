#!/usr/bin/env python3
"""BPMN 2.0 XML (з DI-координатами) → .drawio з нативними BPMN-фігурами draw.io.

РОБОЧА КОПІЯ скрипта власниці (оригінал — reference/bpmn-pipeline/original/bpmn_di_to_drawio.py,
він НЕ змінюється). Відмінності та їхні причини — pipeline/DIFFERENCES.md.

Координати НЕ рахуємо — беремо готові з DI (bpmn-auto-layout + fix_labels.py).
Кожен елемент — ОДНА нативна фігура draw.io (task2/event/gateway2), редагована через меню draw.io.
"""
import argparse
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr

NS = {
    'bpmn': 'http://www.omg.org/spec/BPMN/20100524/MODEL',
    'bpmndi': 'http://www.omg.org/spec/BPMN/20100524/DI',
    'dc': 'http://www.omg.org/spec/DD/20100524/DC',
    'di': 'http://www.omg.org/spec/DD/20100524/DI',
}

# Відмінність 7: підпис проходить через html_text() — текст екранується як HTML, а перенос рядка
# стає <br>. html=1 лишається (як в оригіналі), бо БЕЗ нього draw.io взагалі не переносить підписи:
# довгий підпис лягає одним рядком. Без екранування «<» у дії кроку зникав би з екрана як розмітка.
EVENT_BASE = ('points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],'
              '[0.855,0.855,0],[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];'
              'shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;'
              'labelBackgroundColor=#ffffff;verticalAlign=top;align=center;'
              'perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;whiteSpace=wrap;')
GW_BASE = ('points=[[0.25,0.25,0],[0.5,0,0],[0.75,0.25,0],[1,0.5,0],'
           '[0.75,0.75,0],[0.5,1,0],[0.25,0.75,0],[0,0.5,0]];'
           'shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;'
           'labelBackgroundColor=#ffffff;verticalAlign=top;align=center;'
           'perimeter=rhombusPerimeter;outlineConnect=0;')
TASK_BASE = ('shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;'
             'html=1;container=0;expand=0;collapsible=0;taskMarker=')

TASK_MARKER = {
    'task': 'abstract', 'userTask': 'user', 'manualTask': 'manual',
    'serviceTask': 'service', 'scriptTask': 'script',
    'businessRuleTask': 'businessRule', 'sendTask': 'send',
    'receiveTask': 'receive', 'callActivity': 'abstract',
}
GW_TYPE = {
    'exclusiveGateway': 'exclusive', 'parallelGateway': 'parallel',
    'inclusiveGateway': 'inclusive', 'complexGateway': 'complex',
    'eventBasedGateway': 'exclusive',
}
EVENT_SYMBOL = {'timerEventDefinition': 'timer', 'messageEventDefinition': 'message',
                'errorEventDefinition': 'error', 'signalEventDefinition': 'signal',
                'linkEventDefinition': 'link'}

POOL_STYLE = ('swimlane;html=1;childLayout=stackLayout;horizontal=0;startSize=30;'
              'horizontalStack=0;resizeParent=1;resizeParentMax=0;collapsible=0;'
              'swimlaneFillColor=#ffffff;whiteSpace=wrap;fontStyle=0;')
LANE_STYLE = ('swimlane;html=1;startSize=30;horizontal=0;collapsible=0;'
              'swimlaneLine=1;swimlaneFillColor=#ffffff;fillColor=none;'
              'whiteSpace=wrap;fontStyle=0;')
EDGE_STYLE = ('edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;'
              'jettySize=auto;html=1;endArrow=blockThin;endFill=1;fontSize=11;'
              'labelBackgroundColor=#ffffff;whiteSpace=wrap;')
# Відмінність 8: startSize=30 (а не 25) — заголовок доріжки такий самий, як у DI-геометрії
# (POOL_HEADER у fix_labels.py), інакше зміст і межа доріжки розходяться на 5 px.


def local(tag):
    return tag.split('}')[-1]


def html_text(value):
    """Текст підпису для html=1: екранування HTML + перенос рядка як <br>."""
    return (value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('\r\n', '\n').replace('\n', '<br>'))


def node_style(el, label_width=None):
    t = local(el.tag)
    extra = '' if label_width is None else f'labelWidth={int(round(label_width))};'
    if t in TASK_MARKER:
        return TASK_BASE + TASK_MARKER[t] + ';'
    if t in GW_TYPE:
        return GW_BASE + 'outline=none;symbol=none;gwType=' + GW_TYPE[t] + ';' + extra
    if t == 'startEvent':
        sym = 'general'
        for ch in el:
            sym = EVENT_SYMBOL.get(local(ch.tag), sym)
        return EVENT_BASE + f'outline=standard;symbol={sym};' + extra
    if t == 'endEvent':
        return EVENT_BASE + 'outline=end;symbol=general;' + extra
    if t in ('intermediateCatchEvent', 'intermediateThrowEvent'):
        outline = 'catching' if t == 'intermediateCatchEvent' else 'throwing'
        sym = 'general'
        for ch in el:
            sym = EVENT_SYMBOL.get(local(ch.tag), sym)
        return EVENT_BASE + f'outline={outline};symbol={sym};' + extra
    if t == 'subProcess':
        return TASK_BASE + 'abstract;isLoopSub=1;'
    if t == 'dataObjectReference':
        return ('shape=mxgraph.bpmn.data2;labelPosition=center;'
                'verticalLabelPosition=bottom;align=center;verticalAlign=top;'
                'size=15;html=1;')
    if t == 'dataStoreReference':
        return ('shape=datastore;html=1;labelPosition=center;'
                'verticalLabelPosition=bottom;align=center;verticalAlign=top;')
    if t == 'textAnnotation':
        return ('shape=partialRectangle;left=1;right=0;top=0;bottom=0;html=1;'
                'align=left;spacingLeft=4;whiteSpace=wrap;')
    return 'rounded=1;whiteSpace=wrap;html=1;'


def place_label(pts, center):
    """Положення підпису лінії у draw.io: частка довжини (x від -1 до 1) і зсув від тієї точки.

    draw.io ставить підпис у точку на відстані ((x+1)/2 · довжина) від початку лінії плюс offset.
    Беремо найближчу до заданого центра точку на ламаній — підпис стає там, де його порахував fix_labels.
    """
    total = 0.0
    segs = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        segs.append(((x0, y0), (x1, y1), d))
        total += d
    if total <= 0:
        return 0.0, 0.0, 0.0
    best = None
    walked = 0.0
    for (x0, y0), (x1, y1), d in segs:
        if d <= 0:
            continue
        # проєкція центра на відрізок
        t = max(0.0, min(1.0, ((center[0] - x0) * (x1 - x0) + (center[1] - y0) * (y1 - y0)) / (d * d)))
        px, py = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        dist = ((center[0] - px) ** 2 + (center[1] - py) ** 2) ** 0.5
        if best is None or dist < best[0]:
            best = (dist, walked + d * t, px, py)
        walked += d
    _, along, px, py = best
    return (2 * along / total - 1, center[0] - px, center[1] - py)


def convert(bpmn_path, drawio_path):
    tree = ET.parse(bpmn_path)
    root = tree.getroot()

    # семантика
    procs = root.findall('bpmn:process', NS)
    collab = root.find('bpmn:collaboration', NS)
    participants = collab.findall('bpmn:participant', NS) if collab is not None else []
    pool_name = participants[0].get('name', '') if participants else ''
    pool_sem_id = participants[0].get('id') if participants else None

    # Відмінність 13: прив'язка до погодженої версії переноситься й у .drawio (атрибути <diagram>),
    # інакше з окремо збереженого файлу неможливо дізнатися, на якій версії його побудовано.
    binding = {}
    for defs in [root]:
        for ext in defs.iter():
            if local(ext.tag) == 'asIsBinding':
                binding = dict(ext.attrib)
    sem, node_lane, lanes, seq_flows, annotations, assocs, docs = {}, {}, [], {}, {}, [], {}
    for p in procs:
        for el in p.iter():
            eid = el.get('id')
            if eid:
                sem[eid] = el
        for lane in p.findall('.//bpmn:lane', NS):
            lanes.append((lane.get('id'), lane.get('name', '')))
            for ref in lane.findall('bpmn:flowNodeRef', NS):
                node_lane[ref.text.strip()] = lane.get('id')
        for f in p.findall('bpmn:sequenceFlow', NS):
            seq_flows[f.get('id')] = (f.get('name', ''), f.get('sourceRef'), f.get('targetRef'))
        for a in p.findall('bpmn:textAnnotation', NS):
            txt = a.find('bpmn:text', NS)
            annotations[a.get('id')] = txt.text if txt is not None else ''
        for a in p.findall('bpmn:association', NS):
            assocs.append((a.get('sourceRef'), a.get('targetRef')))
        for el in p.iter():
            d = el.find('bpmn:documentation', NS)
            if d is not None and el.get('id') and (d.text or '').strip():
                docs[el.get('id')] = d.text

    # DI
    shapes, labels, edges, edge_labels = {}, {}, {}, {}
    for sh in root.findall('.//bpmndi:BPMNShape', NS):
        b = sh.find('dc:Bounds', NS)
        shapes[sh.get('bpmnElement')] = (float(b.get('x')), float(b.get('y')),
                                         float(b.get('width')), float(b.get('height')))
        lb = sh.find('bpmndi:BPMNLabel/dc:Bounds', NS)
        if lb is not None:
            labels[sh.get('bpmnElement')] = (float(lb.get('x')), float(lb.get('y')),
                                             float(lb.get('width')), float(lb.get('height')))
    for ed in root.findall('.//bpmndi:BPMNEdge', NS):
        edges[ed.get('bpmnElement')] = [(float(w.get('x')), float(w.get('y')))
                                        for w in ed.findall('di:waypoint', NS)]
        lb = ed.find('bpmndi:BPMNLabel/dc:Bounds', NS)
        if lb is not None:
            edge_labels[ed.get('bpmnElement')] = (float(lb.get('x')), float(lb.get('y')),
                                                  float(lb.get('width')), float(lb.get('height')))

    cells = ['<mxCell id="0" /><mxCell id="1" parent="0" />']
    nid = [1]

    # Відмінність 9: ID клітинки draw.io = ID елемента .bpmn (в оригіналі це були n2, n3…).
    # Завдяки цьому ID кроку видно в самому файлі draw.io, карта «крок ↔ елемент» лишається читабельною,
    # а зворотна звірка .drawio з .bpmn можлива поелементно, а не «за кількістю».
    def new_id(seed=None):
        if seed:
            return seed
        nid[0] += 1
        return f'n{nid[0]}'

    def num(v):
        return ('%f' % v).rstrip('0').rstrip('.') if v % 1 else str(int(v))

    def vertex(cid, value, style, parent, x, y, w, h, doc=None):
        # Відмінність 1: значення в атрибутах екрануються разом із лапками (quoteattr).
        geom = (f'<mxGeometry x="{num(x)}" y="{num(y)}" width="{num(w)}" height="{num(h)}" as="geometry" />')
        if doc:
            # Відмінність 4: повний текст доступний людині як підказка (tooltip) на елементі.
            return (f'<object id="{escape(cid)}" label={quoteattr(html_text(value))} tooltip={quoteattr(doc)}>'
                    f'<mxCell style={quoteattr(style)} vertex="1" parent="{escape(parent)}">{geom}</mxCell></object>')
        return (f'<mxCell id="{escape(cid)}" value={quoteattr(html_text(value))} style={quoteattr(style)} '
                f'vertex="1" parent="{escape(parent)}">{geom}</mxCell>')

    id_map = {}
    pool_di = shapes.get(pool_sem_id)
    pool_cell = new_id(pool_sem_id)
    px, py = (pool_di[0], pool_di[1]) if pool_di else (40, 40)
    if pool_di:
        cells.append(vertex(pool_cell, pool_name, POOL_STYLE, '1', px, py, pool_di[2], pool_di[3]))
    lane_cells = {}
    for lid, lname in lanes:
        d = shapes.get(lid)
        if d is None:
            continue
        c = new_id(lid)
        lane_cells[lid] = (c, d)
        cells.append(vertex(c, lname, LANE_STYLE, pool_cell, d[0] - px, d[1] - py, d[2], d[3]))

    for eid, el in sem.items():
        t = local(el.tag)
        if t in ('process', 'laneSet', 'lane', 'sequenceFlow', 'association', 'documentation',
                 'incoming', 'outgoing', 'flowNodeRef', 'text', 'participant', 'collaboration'):
            continue
        d = shapes.get(eid)
        if d is None:
            continue
        c = new_id(eid)
        id_map[eid] = c
        lane_id = node_lane.get(eid)
        if lane_id in lane_cells:
            parent, (lx, ly, _, _) = lane_cells[lane_id][0], lane_cells[lane_id][1]
            rx, ry = d[0] - lx, d[1] - ly
        else:
            parent, rx, ry = '1', d[0], d[1]
        value = annotations.get(eid, el.get('name', '') or '')
        # Відмінність 16: ширина колонки переносу зовнішнього підпису = рамка підпису з DI,
        # інакше draw.io переносить підпис у вузький стовпчик (≈100 px) незалежно від розрахунку.
        lw = labels.get(eid, (0, 0, None, 0))[2]
        cells.append(vertex(c, value, node_style(el, lw), parent, rx, ry, d[2], d[3], docs.get(eid)))

    for fid, (name, src, tgt) in seq_flows.items():
        if src not in id_map or tgt not in id_map:
            continue
        c = new_id(fid)
        pts = edges.get(fid, [])
        inner = ''
        if len(pts) > 2:
            mid = ''.join(f'<mxPoint x="{num(x)}" y="{num(y)}" />' for x, y in pts[1:-1])
            inner = f'<Array as="points">{mid}</Array>'
        geom_attrs = ''
        style = EDGE_STYLE
        # Відмінність 17: підпис переходу ставимо туди, де його порахував fix_labels.py
        # (інакше draw.io кладе всі підписи в середину лінії й вони накладаються).
        if fid in edge_labels and len(pts) >= 2:
            lx, ly, lw, lh = edge_labels[fid]
            gx, dx, dy = place_label(pts, (lx + lw / 2, ly + lh / 2))
            geom_attrs = f' x="{num(round(gx, 4))}"'
            inner += f'<mxPoint x="{num(round(dx))}" y="{num(round(dy))}" as="offset" />'
            # ширина переносу підпису переходу — та сама рамка, що порахував fix_labels.py
            style = EDGE_STYLE + f'labelWidth={int(round(lw))};'
        cells.append(
            f'<mxCell id="{escape(c)}" value={quoteattr(html_text(name))} style={quoteattr(style)} edge="1" '
            f'parent="1" source="{escape(id_map[src])}" target="{escape(id_map[tgt])}">'
            f'<mxGeometry relative="1"{geom_attrs} as="geometry">{inner}</mxGeometry></mxCell>')

    for src, tgt in assocs:
        if src not in id_map or tgt not in id_map:
            continue
        c = new_id()
        cells.append(
            f'<mxCell id="{escape(c)}" style="endArrow=none;dashed=1;html=1;" edge="1" '
            f'parent="1" source="{escape(id_map[src])}" target="{escape(id_map[tgt])}">'
            f'<mxGeometry relative="1" as="geometry" /></mxCell>')

    snake = {'versionId': 'cx_version_id', 'contentHash': 'cx_content_hash',
             'origin': 'cx_origin', 'generator': 'cx_generator'}
    battrs = ''.join(f' {snake.get(k, "cx_" + k)}={quoteattr(v)}' for k, v in sorted(binding.items()))
    xml = (f'<mxfile host="app.diagrams.net"><diagram id="bpmn" name="Process"{battrs}>'
           '<mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" '
           'tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" '
           'math="0" shadow="0"><root>'
           + ''.join(cells) + '</root></mxGraphModel></diagram></mxfile>')
    with open(drawio_path, 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f'OK: {len(id_map)} nodes, {len(seq_flows)} flows, {len(lanes)} lanes')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='BPMN з DI → .drawio')
    ap.add_argument('bpmn_in')
    ap.add_argument('drawio_out')
    a = ap.parse_args()
    convert(a.bpmn_in, a.drawio_out)
