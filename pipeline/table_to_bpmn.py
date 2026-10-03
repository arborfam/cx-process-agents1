#!/usr/bin/env python3
"""Таблиця процесу (id,label,type,role,next,yes,no,assoc) → BPMN 2.0 XML без координат.

РОБОЧА КОПІЯ скрипта власниці (оригінал — reference/bpmn-pipeline/original/table_to_bpmn.py,
він НЕ змінюється). Відмінності та їхні причини перелічені в pipeline/DIFFERENCES.md.

Ланка ланцюга: CSV → [цей скрипт] → BPMN → layout_step.mjs → fix_labels.py → bpmn_di_to_drawio.py
"""
import argparse
import csv
import io
import json
import re
import sys
from xml.sax.saxutils import escape, quoteattr

# type з таблиці → (BPMN-елемент, доріжка)
TYPE_MAP = {
    'start':   ('startEvent', None),
    'end':     ('endEvent', None),
    'timer':   ('intermediateCatchEvent:timer', None),
    'xor':     ('exclusiveGateway', None),
    'and':     ('parallelGateway', None),
    'note':    ('textAnnotation', None),
    # Відмінність 10 (свідома, не випадкова): CSV-тип `task` у цьому шляху означає «крок погодженого опису»,
    # а не «крок, який виконує людина». Погоджений AS-IS не фіксує, людина чи система виконує крок, тому
    # нотаційно чесний елемент — нейтральна задача (D25). В оригіналі `task` → `userTask`, бо там таблиці
    # складала людина, яка цю різницю знала. Мовчки тип не підміняємо: `srv` і `manual` лишаються як були.
    'task':    ('task', None),
    'srv':     ('serviceTask', None),
    'manual':  ('manualTask', None),
    'complex': ('complexGateway', None),
    'sub':     ('subProcess', None),
    'msg':     ('intermediateCatchEvent:message', None),
    'linkEnd':   ('intermediateThrowEvent:link', None),
    'linkStart': ('intermediateCatchEvent:link', None),
    'data':    ('dataObjectReference', None),
    'db':      ('dataStoreReference', None),
    # Відмінність 19: прибрано сумісність зі старими таблицями Company Hub (taskInit, taskTeam, taskIC,
    # taskOwner, service). Ці типи мовчки призначали крокам чужі доріжки («Ініціатор», «Internal Coms»…),
    # яких у погодженому описі немає.
}

# Відмінність 6: ID елемента — сам ID рядка, якщо він уже припустимий як XML-ID (починається з літери,
# далі літери/цифри/«_»/«-»). Інакше, як в оригіналі, додається префікс «e» (щоб числові таблиці працювали).
ID_OK = re.compile(r'^[A-Za-z][A-Za-z0-9_-]*$')


def elem_id(raw):
    return raw if ID_OK.match(raw) else 'e' + raw


def table_to_bpmn(rows, pool_name, lane_order=None, docs=None, binding=None):
    """rows — список словників CSV; lane_order — бажаний порядок доріжок (ролі з погодженого опису);
    docs — {ID рядка: повний текст} для <bpmn:documentation> (дослівне збереження довгого тексту)."""
    nodes, flows, annos, assocs, artifacts = {}, [], {}, [], {}
    lane_of = {}
    docs = docs or {}
    # Відмінність 3: порядок доріжок — локальна змінна, а не глобальний список із чужими назвами.
    order = list(lane_order or [])
    flow_seq = [{}]

    for r in rows:
        rid = elem_id(r['id'].strip())
        bpmn_type, lane = TYPE_MAP[r['type'].strip()]
        if bpmn_type in ('textAnnotation', 'dataObjectReference', 'dataStoreReference'):
            if bpmn_type == 'textAnnotation':
                annos[rid] = r['label']
            else:
                artifacts[rid] = (bpmn_type, r['label'])
            if (r.get('assoc') or '').strip():
                assocs.append((rid, elem_id(r['assoc'].strip())))
            continue
        nodes[rid] = (bpmn_type, r['label'])
        role_col = (r.get('role') or '').strip()
        if role_col:
            lane = role_col
        if lane:
            lane_of[rid] = lane
            if lane not in order:
                order.append(lane)
        nxt = (r.get('next') or '').strip()

        def add_flow(src, tgt, label):
            # Відмінність 2: ID лінії — «f<джерело>_<ціль>», а для другої й наступної ліній між тією самою
            # парою додається номер. Два різні переходи в ту саму ціль НЕ отримують однакового ID
            # (в оригіналі це давало дублі ID у XML), і ID не залежить від порядку рядків таблиці.
            base = f'f{src}_{tgt}'
            n = flow_seq[0].get(base, 0) + 1
            flow_seq[0][base] = n
            flows.append((base if n == 1 else f'{base}_{n}', src, tgt, label))

        if '>' in nxt:  # багатогілковий шлюз: умова>id|умова>id
            for br in (b.strip() for b in nxt.split('|') if b.strip()):
                lbl, tgt = br.rsplit('>', 1)
                add_flow(rid, elem_id(tgt.strip()), lbl.strip())
            cols = (('yes', 'Так'), ('no', 'Ні'))
        else:
            cols = (('next', ''), ('yes', 'Так'), ('no', 'Ні'))
        for col, label in cols:
            for tgt in (t.strip() for t in (r.get(col) or '').split('|') if t.strip()):
                add_flow(rid, elem_id(tgt), label)

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

    # Доріжка створюється лише для ролі, яка справді має елементи (порожніх доріжок немає).
    lanes_used = [l for l in order if l in lane_of.values()]

    b = io.StringIO()
    b.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    b.write('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
            'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
            'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
            'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" '
            'xmlns:cx="urn:cx-process-agents:as-is-binding" '
            'id="Defs_1" targetNamespace="http://cx-process-agents/bpmn">\n')
    b.write('  <bpmn:collaboration id="Collaboration_1">\n')
    # Відмінність 1: значення атрибутів екрануються разом із лапками (quoteattr), інакше лапка в тексті
    # ламає XML, а скрипт при цьому завершується «успішно».
    b.write(f'    <bpmn:participant id="Participant_1" name={quoteattr(pool_name)} processRef="Process_1" />\n')
    b.write('  </bpmn:collaboration>\n')
    b.write('  <bpmn:process id="Process_1" isExecutable="false">\n')
    # Відмінність 11: прив'язка файлу до погодженої версії AS-IS. Без неї з готового файлу неможливо
    # дізнатися, на якій саме версії його побудовано (перевірка цього вимагає: BINDING_MISSING).
    if binding:
        b.write('    <bpmn:extensionElements>\n')
        attrs = ' '.join(f'{k}={quoteattr(str(v))}' for k, v in binding.items())
        b.write(f'      <cx:asIsBinding {attrs} />\n')
        b.write('    </bpmn:extensionElements>\n')
    b.write('    <bpmn:laneSet id="LaneSet_1">\n')
    for i, lname in enumerate(lanes_used):
        b.write(f'      <bpmn:lane id="Lane_{i}" name={quoteattr(lname)}>\n')
        for nid_, lane in lane_of.items():
            if lane == lname:
                b.write(f'        <bpmn:flowNodeRef>{escape(nid_)}</bpmn:flowNodeRef>\n')
        b.write('      </bpmn:lane>\n')
    b.write('    </bpmn:laneSet>\n')

    incoming = {}
    outgoing = {}
    for fid, src, tgt, _ in flows:
        outgoing.setdefault(src, []).append(fid)
        incoming.setdefault(tgt, []).append(fid)

    for nid_, (btype, label) in nodes.items():
        tag = btype.split(':')[0]
        nm = f' name={quoteattr(label)}' if label else ''
        b.write(f'    <bpmn:{tag} id="{escape(nid_)}"{nm}>\n')
        # Відмінність 4: повний текст (наприклад тригер процесу) зберігається дослівно в <documentation>,
        # навіть якщо на схемі стоїть коротший погоджений підпис.
        if nid_ in docs:
            b.write(f'      <bpmn:documentation id="{escape(nid_)}_doc">{escape(docs[nid_])}</bpmn:documentation>\n')
        for fid in incoming.get(nid_, []):
            b.write(f'      <bpmn:incoming>{escape(fid)}</bpmn:incoming>\n')
        for fid in outgoing.get(nid_, []):
            b.write(f'      <bpmn:outgoing>{escape(fid)}</bpmn:outgoing>\n')
        if ':' in btype:
            kind = btype.split(':')[1]
            defs = {'timer': 'timerEventDefinition', 'message': 'messageEventDefinition',
                    'link': 'linkEventDefinition'}
            extra = f' name={quoteattr(label)}' if kind == 'link' else ''
            b.write(f'      <bpmn:{defs[kind]} id="{escape(nid_)}_def"{extra} />\n')
        b.write(f'    </bpmn:{tag}>\n')

    for fid, src, tgt, label in flows:
        nm = f' name={quoteattr(label)}' if label else ''
        b.write(f'    <bpmn:sequenceFlow id="{escape(fid)}"{nm} sourceRef="{escape(src)}" targetRef="{escape(tgt)}" />\n')

    for aid, (atype, aname) in artifacts.items():
        b.write(f'    <bpmn:{atype} id="{escape(aid)}" name={quoteattr(aname)} />\n')
    for aid, text in annos.items():
        b.write(f'    <bpmn:textAnnotation id="{escape(aid)}"><bpmn:text>{escape(text)}</bpmn:text></bpmn:textAnnotation>\n')
    for i, (aid, tgt) in enumerate(assocs):
        b.write(f'    <bpmn:association id="assoc_{i}" sourceRef="{escape(aid)}" targetRef="{escape(tgt)}" />\n')

    b.write('  </bpmn:process>\n</bpmn:definitions>\n')
    return b.getvalue()


def main(argv):
    p = argparse.ArgumentParser(description='CSV процесу → BPMN 2.0 XML без координат')
    p.add_argument('csv_in')
    p.add_argument('bpmn_out')
    p.add_argument('pool_name', nargs='?', default='Process')
    p.add_argument('--lane-order', help='файл зі списком ролей (по одній у рядку): порядок доріжок')
    p.add_argument('--docs', help='файл JSON {ID рядка: повний текст} для <bpmn:documentation>')
    p.add_argument('--binding', help='файл JSON із прив’язкою до погодженої версії (versionId, contentHash, origin, generator)')
    a = p.parse_args(argv)
    lane_order = None
    if a.lane_order:
        with open(a.lane_order, encoding='utf-8') as f:
            lane_order = [l.rstrip('\n') for l in f if l.strip()]
    docs = None
    if a.docs:
        with open(a.docs, encoding='utf-8') as f:
            docs = {elem_id(k): v for k, v in json.load(f).items()}
    # Відмінність 18: newline='' і utf-8-sig — інакше перенос рядка всередині поля CSV читається
    # неправильно, а BOM на початку файлу потрапляє в перший ID.
    with open(a.csv_in, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    binding = None
    if a.binding:
        with open(a.binding, encoding='utf-8') as f:
            binding = json.load(f)
    xml = table_to_bpmn(rows, a.pool_name, lane_order, docs, binding)
    with open(a.bpmn_out, 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f'OK: {len(rows)} rows')


if __name__ == '__main__':
    main(sys.argv[1:])
