#!/usr/bin/env python3
"""BPMN 2.0 XML (з DI-координатами) → .drawio з нативними BPMN-фігурами draw.io.

Координати НЕ рахуємо — беремо готові з DI (bpmn-auto-layout).
Кожен елемент — ОДНА нативна фігура draw.io (task2/event/gateway2),
редагована через стандартне контекстне меню draw.io.
"""
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

NS = {
    'bpmn': 'http://www.omg.org/spec/BPMN/20100524/MODEL',
    'bpmndi': 'http://www.omg.org/spec/BPMN/20100524/DI',
    'dc': 'http://www.omg.org/spec/DD/20100524/DC',
    'di': 'http://www.omg.org/spec/DD/20100524/DI',
}

EVENT_BASE = ('points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],'
              '[0.855,0.855,0],[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];'
              'shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;'
              'labelBackgroundColor=#ffffff;verticalAlign=top;align=center;'
              'perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;')
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

POOL_STYLE = ('swimlane;html=1;childLayout=stackLayout;horizontal=0;startSize=25;'
              'horizontalStack=0;resizeParent=1;resizeParentMax=0;collapsible=0;'
              'swimlaneFillColor=#ffffff;whiteSpace=wrap;fontStyle=0;')
LANE_STYLE = ('swimlane;html=1;startSize=25;horizontal=0;collapsible=0;'
              'swimlaneLine=1;swimlaneFillColor=#ffffff;fillColor=none;'
              'whiteSpace=wrap;fontStyle=0;')
EDGE_STYLE = ('edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;'
              'jettySize=auto;html=1;endArrow=blockThin;endFill=1;fontSize=11;')


def local(tag):
    return tag.split('}')[-1]


def node_style(el):
    t = local(el.tag)
    if t in TASK_MARKER:
        return TASK_BASE + TASK_MARKER[t] + ';'
    if t in GW_TYPE:
        return GW_BASE + 'outline=none;symbol=none;gwType=' + GW_TYPE[t] + ';'
    if t == 'startEvent':
        sym = 'general'
        for ch in el:
            sym = EVENT_SYMBOL.get(local(ch.tag), sym)
        return EVENT_BASE + f'outline=standard;symbol={sym};'
    if t == 'endEvent':
        return EVENT_BASE + 'outline=end;symbol=general;'
    if t in ('intermediateCatchEvent', 'intermediateThrowEvent'):
        outline = 'catching' if t == 'intermediateCatchEvent' else 'throwing'
        sym = 'general'
        for ch in el:
            sym = EVENT_SYMBOL.get(local(ch.tag), sym)
        return EVENT_BASE + f'outline={outline};symbol={sym};'
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


def convert(bpmn_path, drawio_path):
    tree = ET.parse(bpmn_path)
    root = tree.getroot()

    # семантика
    procs = root.findall('bpmn:process', NS)
    collab = root.find('bpmn:collaboration', NS)
    participants = collab.findall('bpmn:participant', NS) if collab is not None else []
    pool_name = participants[0].get('name', '') if participants else ''
    pool_sem_id = participants[0].get('id') if participants else None

    sem = {}           # id -> element
    node_lane = {}     # flowNode id -> lane id
    lanes = []         # (id, name)
    seq_flows = {}     # id -> (name, sourceRef, targetRef)
    annotations = {}   # id -> text
    assocs = []        # (source, target)
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

    # DI
    shapes = {}   # bpmnElement -> (x, y, w, h)
    edges = {}    # bpmnElement -> [(x, y), ...]
    for sh in root.findall('.//bpmndi:BPMNShape', NS):
        b = sh.find('dc:Bounds', NS)
        shapes[sh.get('bpmnElement')] = (float(b.get('x')), float(b.get('y')),
                                         float(b.get('width')), float(b.get('height')))
    for ed in root.findall('.//bpmndi:BPMNEdge', NS):
        pts = [(float(w.get('x')), float(w.get('y')))
               for w in ed.findall('di:waypoint', NS)]
        edges[ed.get('bpmnElement')] = pts

    # збірка drawio
    cells = []
    cells.append('<mxCell id="0" /><mxCell id="1" parent="0" />')
    nid = [1]

    def new_id():
        nid[0] += 1
        return f'n{nid[0]}'

    id_map = {}

    pool_di = shapes.get(pool_sem_id)
    pool_cell = new_id()
    px, py = (pool_di[0], pool_di[1]) if pool_di else (40, 40)
    if pool_di:
        cells.append(
            f'<mxCell id="{pool_cell}" value="{escape(pool_name)}" style="{POOL_STYLE}" '
            f'vertex="1" parent="1"><mxGeometry x="{px}" y="{py}" '
            f'width="{pool_di[2]}" height="{pool_di[3]}" as="geometry" /></mxCell>')
    lane_cells = {}
    for lid, lname in lanes:
        d = shapes.get(lid)
        if d is None:
            continue
        c = new_id()
        lane_cells[lid] = (c, d)
        cells.append(
            f'<mxCell id="{c}" value="{escape(lname)}" style="{LANE_STYLE}" '
            f'vertex="1" parent="{pool_cell}"><mxGeometry x="{d[0]-px}" y="{d[1]-py}" '
            f'width="{d[2]}" height="{d[3]}" as="geometry" /></mxCell>')

    for eid, el in sem.items():
        t = local(el.tag)
        if t in ('process', 'laneSet', 'lane', 'sequenceFlow', 'association',
                 'incoming', 'outgoing', 'flowNodeRef', 'text', 'participant',
                 'collaboration'):
            continue
        d = shapes.get(eid)
        if d is None:
            continue
        c = new_id()
        id_map[eid] = c
        lane_id = node_lane.get(eid)
        if lane_id in lane_cells:
            parent, (lx, ly, _, _) = lane_cells[lane_id][0], lane_cells[lane_id][1]
            rx, ry = d[0] - lx, d[1] - ly
        else:
            parent, rx, ry = '1', d[0], d[1]
        value = annotations.get(eid, el.get('name', '') or '')
        cells.append(
            f'<mxCell id="{c}" value="{escape(value)}" style="{node_style(el)}" '
            f'vertex="1" parent="{parent}"><mxGeometry x="{rx}" y="{ry}" '
            f'width="{d[2]}" height="{d[3]}" as="geometry" /></mxCell>')

    for fid, (name, src, tgt) in seq_flows.items():
        if src not in id_map or tgt not in id_map:
            continue
        c = new_id()
        pts = edges.get(fid, [])
        inner = ''
        if len(pts) > 2:
            mid = ''.join(f'<mxPoint x="{x}" y="{y}" />' for x, y in pts[1:-1])
            inner = f'<Array as="points">{mid}</Array>'
        cells.append(
            f'<mxCell id="{c}" value="{escape(name)}" style="{EDGE_STYLE}" edge="1" '
            f'parent="1" source="{id_map[src]}" target="{id_map[tgt]}">'
            f'<mxGeometry relative="1" as="geometry">{inner}</mxGeometry></mxCell>')

    for src, tgt in assocs:
        if src not in id_map or tgt not in id_map:
            continue
        c = new_id()
        cells.append(
            f'<mxCell id="{c}" style="endArrow=none;dashed=1;html=1;" edge="1" '
            f'parent="1" source="{id_map[src]}" target="{id_map[tgt]}">'
            f'<mxGeometry relative="1" as="geometry" /></mxCell>')

    xml = ('<mxfile host="app.diagrams.net"><diagram id="bpmn" name="Process">'
           '<mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" '
           'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
           'pageWidth="1600" pageHeight="900" math="0" shadow="0"><root>'
           + ''.join(cells) + '</root></mxGraphModel></diagram></mxfile>')
    with open(drawio_path, 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f'OK: {len(id_map)} nodes, {len(seq_flows)} flows, {len(lanes)} lanes')


if __name__ == '__main__':
    convert(sys.argv[1], sys.argv[2])
