#!/usr/bin/env python3
"""Таблиця процесу (id,label,type,next,yes,no,assoc) → BPMN 2.0 XML без координат.

Ролі мапляться на доріжки. Це детермінована ланка ланцюга:
таблиця → [цей скрипт] → BPMN → bpmn-auto-layout → bpmn_di_to_drawio → .drawio
"""
import csv
import io
import sys
from xml.sax.saxutils import escape

# type з таблиці → (BPMN-елемент, доріжка)
TYPE_MAP = {
    'start':   ('startEvent', None),
    'end':     ('endEvent', None),
    'timer':   ('intermediateCatchEvent:timer', None),
    'xor':     ('exclusiveGateway', None),
    'and':     ('parallelGateway', None),
    'note':    ('textAnnotation', None),
    'task':    ('userTask', None),
    'srv':     ('serviceTask', None),
    'manual':  ('manualTask', None),
    'complex': ('complexGateway', None),
    'sub':     ('subProcess', None),
    'msg':     ('intermediateCatchEvent:message', None),
    'linkEnd':   ('intermediateThrowEvent:link', None),
    'linkStart': ('intermediateCatchEvent:link', None),
    'data':    ('dataObjectReference', None),
    'db':      ('dataStoreReference', None),
    # сумісність зі старими таблицями Company Hub:
    'taskInit':  ('userTask', 'Ініціатор'),
    'taskTeam':  ('userTask', 'Команда-замовник'),
    'taskIC':    ('userTask', 'Internal Coms'),
    'taskOwner': ('userTask', 'Власник сторінки'),
    'service':   ('serviceTask', None),
}

LANE_ORDER = ['Ініціатор', 'Команда-замовник', 'Internal Coms', 'Власник сторінки']


def table_to_bpmn(rows, pool_name):
    nodes, flows, annos, assocs, artifacts = {}, [], {}, [], {}
    lane_of = {}

    # доріжка для не-задач: успадковується від контексту (попередній вузол у потоці)
    for r in rows:
        rid = 'e' + r['id']
        bpmn_type, lane = TYPE_MAP[r['type'].strip()]
        if bpmn_type in ('textAnnotation', 'dataObjectReference', 'dataStoreReference'):
            if bpmn_type == 'textAnnotation':
                annos[rid] = r['label']
            else:
                artifacts[rid] = (bpmn_type, r['label'])
            if r.get('assoc', '').strip():
                assocs.append((rid, 'e' + r['assoc'].strip()))
            continue
        nodes[rid] = (bpmn_type, r['label'])
        role_col = (r.get('role') or '').strip()
        if role_col:
            lane = role_col
        if lane:
            lane_of[rid] = lane
            if lane not in LANE_ORDER:
                LANE_ORDER.append(lane)
        nxt = r.get('next', '').strip()
        if '>' in nxt:  # багатогілковий шлюз: умова>id|умова>id
            for br in (b.strip() for b in nxt.split('|') if b.strip()):
                lbl, tgt = br.rsplit('>', 1)
                flows.append((f'f{rid}_{tgt.strip()}', rid, 'e' + tgt.strip(), lbl.strip()))
            cols = (('yes', 'Так'), ('no', 'Ні'))
        else:
            cols = (('next', ''), ('yes', 'Так'), ('no', 'Ні'))
        for col, label in cols:
            for tgt in (t.strip() for t in r.get(col, '').split('|') if t.strip()):
                flows.append((f'f{rid}_{tgt}', rid, 'e' + tgt, label))

    # події/шлюзи без ролі → доріжка джерела вхідного потоку (перший прохід),
    # старт → доріжка першого наступника
    changed = True
    while changed:
        changed = False
        for fid, src, tgt, _ in flows:
            if tgt in nodes and tgt not in lane_of and src in lane_of:
                lane_of[tgt] = lane_of[src]; changed = True
        for fid, src, tgt, _ in flows:
            if src in nodes and src not in lane_of and tgt in lane_of:
                lane_of[src] = lane_of[tgt]; changed = True

    lanes_used = [l for l in LANE_ORDER if l in lane_of.values()]

    b = io.StringIO()
    b.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    b.write('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
            'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
            'id="Defs_1" targetNamespace="http://uklon.ua/bpu">\n')
    b.write('  <bpmn:collaboration id="Collab_1">\n')
    b.write(f'    <bpmn:participant id="Pool_1" name="{escape(pool_name)}" processRef="Process_1" />\n')
    b.write('  </bpmn:collaboration>\n')
    b.write('  <bpmn:process id="Process_1" isExecutable="false">\n')
    b.write('    <bpmn:laneSet id="LaneSet_1">\n')
    for i, lname in enumerate(lanes_used):
        b.write(f'      <bpmn:lane id="Lane_{i}" name="{escape(lname)}">\n')
        for nid_, lane in lane_of.items():
            if lane == lname:
                b.write(f'        <bpmn:flowNodeRef>{nid_}</bpmn:flowNodeRef>\n')
        b.write('      </bpmn:lane>\n')
    b.write('    </bpmn:laneSet>\n')

    incoming = {}
    outgoing = {}
    for fid, src, tgt, _ in flows:
        outgoing.setdefault(src, []).append(fid)
        incoming.setdefault(tgt, []).append(fid)

    for nid_, (btype, label) in nodes.items():
        tag = btype.split(':')[0]
        b.write(f'    <bpmn:{tag} id="{nid_}" name="{escape(label)}">\n')
        for fid in incoming.get(nid_, []):
            b.write(f'      <bpmn:incoming>{fid}</bpmn:incoming>\n')
        for fid in outgoing.get(nid_, []):
            b.write(f'      <bpmn:outgoing>{fid}</bpmn:outgoing>\n')
        if ':' in btype:
            kind = btype.split(':')[1]
            defs = {'timer': 'timerEventDefinition', 'message': 'messageEventDefinition',
                    'link': 'linkEventDefinition'}
            extra = f' name="{escape(label)}"' if kind == 'link' else ''
            b.write(f'      <bpmn:{defs[kind]} id="{nid_}_def"{extra} />\n')
        b.write(f'    </bpmn:{tag}>\n')

    for fid, src, tgt, label in flows:
        nm = f' name="{escape(label)}"' if label else ''
        b.write(f'    <bpmn:sequenceFlow id="{fid}"{nm} sourceRef="{src}" targetRef="{tgt}" />\n')

    for aid, (atype, aname) in artifacts.items():
        b.write(f'    <bpmn:{atype} id="{aid}" name="{escape(aname)}" />\n')
    for aid, text in annos.items():
        b.write(f'    <bpmn:textAnnotation id="{aid}"><bpmn:text>{escape(text)}</bpmn:text></bpmn:textAnnotation>\n')
    for i, (aid, tgt) in enumerate(assocs):
        b.write(f'    <bpmn:association id="assoc_{i}" sourceRef="{aid}" targetRef="{tgt}" />\n')

    b.write('  </bpmn:process>\n</bpmn:definitions>\n')
    return b.getvalue()


def parse_roles(spec):
    """--roles "taskAnalyst=Аналітик,srvAI=AI-двигун"
    Префікс task → userTask, srv → serviceTask."""
    extra = {}
    for pair in spec.split(','):
        tname, lane = pair.split('=', 1)
        tname, lane = tname.strip(), lane.strip()
        el = 'serviceTask' if tname.startswith('srv') else 'userTask'
        extra[tname] = (el, lane)
    return extra


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--roles' in args:
        i = args.index('--roles')
        TYPE_MAP.update(parse_roles(args[i + 1]))
        LANE_ORDER[:0] = [lane for _, lane in parse_roles(args[i + 1]).values()]
        args = args[:i] + args[i + 2:]
    with open(args[0], encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    xml = table_to_bpmn(rows, args[2] if len(args) > 2 else 'Process')
    with open(args[1], 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f'OK: {len(rows)} rows')
