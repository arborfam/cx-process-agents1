/**
 * Порівняння з оригінальним ланцюгом власниці (reference/bpmn-pipeline/original/): table_to_bpmn.py → layout_step.mjs.
 * Оригінальні файли НЕ змінюються й виконуються лише на читання з їхнього місця; усі виходи — в унікальній тимчасовій теці.
 *
 * Нормалізація перед порівнянням (різниці, що не є різницею змісту):
 *  1. тип задачі: оригінал дає userTask (іконка «людина»), ми — нейтральну task (D25);
 *  2. ID елементів: оригінал — `e<ID кроку>`, ми — `Task_<ID кроку>` тощо; порівнюємо за ID кроків;
 *  3. порядок доріжок: в оригіналі залежить від глобального LANE_ORDER — порівнюємо як множини;
 *  4. доріжки без жодного кроку: оригінал їх не створює — не порівнюємо;
 *  5. координати й розміри не порівнюються (ми додатково масштабуємо схему під довгі підписи);
 *  6. ID ліній переходів не порівнюються (в оригіналі вони можуть повторюватись).
 * Дефекти оригіналу (лапки, повторні ID ліній, глобальний стан) НЕ відтворюємо заради збігу — тест це підтверджує.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseXml, walk, attr, elementChildren, type XmlElement } from '../src/bpmn/xml.ts';
import { readBpmn } from '../src/bpmn/read.ts';
import { collapse, diffEdges, type GFlow, type GNode } from '../src/bpmn/graph.ts';
import { generateBpmn } from '../src/bpmn/generate.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import { clonePkg, generateOk, pkgOf } from './bpmn-helpers.ts';

const ORIG = join(import.meta.dirname, '..', 'reference', 'bpmn-pipeline', 'original');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

const ORIGINAL_SHA: Record<string, string> = {
  'table_to_bpmn.py': '6270e141902f5f6afd43660e3b5db214f6ee5d8844e4f89cb66f79ad9e7b6e5c',
  'bpmn_di_to_drawio.py': 'cb36a0661ac71d18b632815a8a12d07e9c262c6c4884b2cef6974af4704e18e9',
  'layout_step.mjs': '6fec376e70317829f1dc3bd85115502e7238cb3b20c12ee05126aa8e06a9ce43',
  'run_pipeline.sh': '07154ed2199560e22b80b0713ce8d214c64ab473aa69c0d5048b879ee7b74e69',
};

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Пакет → таблиця оригінального ланцюга (розгалуження — шлюз-рядок xor із записом «умова>ціль|умова>ціль»). */
function toCsv(pkg: ApprovedPackage): string {
  const c = pkg.content;
  const byId = new Map(c.steps.map((s) => [s.id, s]));
  const rows: string[][] = [['id', 'label', 'type', 'role', 'next', 'yes', 'no', 'assoc']];
  const entry = byId.get(c.entry_step_id!)!;
  rows.push(['START', c.boundaries.trigger, 'start', entry.role, entry.id, '', '', '']);
  for (const s of c.steps) {
    const tgt = (to: string, k: number): string => (to === 'END' ? `END_${s.id}_${k}` : to);
    if (s.next.length === 1) rows.push([s.id, s.action, 'task', s.role, tgt(s.next[0]!.to, 1), '', '', '']);
    else {
      rows.push([s.id, s.action, 'task', s.role, `G_${s.id}`, '', '', '']);
      rows.push([`G_${s.id}`, '', 'xor', s.role, s.next.map((n, i) => `${n.condition}>${tgt(n.to, i + 1)}`).join('|'), '', '', '']);
    }
    s.next.forEach((n, i) => { if (n.to === 'END') rows.push([`END_${s.id}_${i + 1}`, '', 'end', s.role, '', '', '', '']); });
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

interface Run { pyBpmn: string; layouted: string; stdout: string }

function runOriginal(pkg: ApprovedPackage): Run {
  const dir = mkdtempSync(join(tmpdir(), 'cx-orig-'));
  try {
    const csv = join(dir, 'in.csv'), sem = join(dir, 'sem.bpmn'), out = join(dir, 'out.bpmn');
    writeFileSync(csv, toCsv(pkg), 'utf8');
    const a = spawnSync('python3', [join(ORIG, 'table_to_bpmn.py'), csv, sem, pkg.poolName], { encoding: 'utf8' });
    assert.equal(a.status, 0, `table_to_bpmn.py: ${a.stderr}`);
    const b = spawnSync(process.execPath, [join(ORIG, 'layout_step.mjs'), sem, out], { encoding: 'utf8' });
    assert.equal(b.status, 0, `layout_step.mjs: ${b.stderr.slice(0, 500)}`);
    return { pyBpmn: readFileSync(sem, 'utf8'), layouted: readFileSync(out, 'utf8'), stdout: a.stdout + b.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Norm {
  tasks: Map<string, { name: string; lane: string }>;
  startName: string;
  startTarget: string;
  endCount: number;
  gatewayCount: number;
  usedLanes: Set<string>;
  edges: ReturnType<typeof collapse>['edges'];
}

/** Розбір результату ОРИГІНАЛЬНОГО ланцюга в нормалізований вигляд (кроки за ID, userTask ≈ task). */
function normalizeOriginal(xml: string): Norm {
  const root = parseXml(xml);
  const laneOf = new Map<string, string>();
  const nodes = new Map<string, GNode>();
  const names = new Map<string, string>();
  const flows: GFlow[] = [];
  let startId = '';
  const norm = (id: string, tag: string): string => {
    const raw = id.replace(/^e/, '');
    if (tag === 'startEvent') return 'StartEvent_1';
    if (tag === 'endEvent') return `End_${raw}`;
    if (tag === 'exclusiveGateway') return `Gateway_${raw.replace(/^G_/, '')}`;
    return `Task_${raw}`;
  };
  const idMap = new Map<string, string>();
  walk(root, (e: XmlElement) => {
    const id = attr(e, 'id');
    if (!id) return;
    const tag = e.local;
    if (['userTask', 'task', 'startEvent', 'endEvent', 'exclusiveGateway'].includes(tag)) {
      const n = norm(id, tag);
      idMap.set(id, n);
      names.set(n, attr(e, 'name') ?? '');
      nodes.set(n, { id: n, tag: tag === 'userTask' ? 'task' : (tag as GNode['tag']) });
      if (tag === 'startEvent') startId = n;
    }
  });
  walk(root, (e) => {
    if (e.local === 'lane') {
      const name = attr(e, 'name') ?? '';
      for (const ch of elementChildren(e)) if (ch.local === 'flowNodeRef') laneOf.set(idMap.get(ch.children.join('').trim()) ?? '', name);
    }
    if (e.local === 'sequenceFlow') {
      flows.push({ id: attr(e, 'id') ?? '', name: attr(e, 'name') || undefined, source: idMap.get(attr(e, 'sourceRef') ?? '') ?? '', target: idMap.get(attr(e, 'targetRef') ?? '') ?? '' });
    }
  });
  const tasks = new Map<string, { name: string; lane: string }>();
  for (const n of nodes.values()) if (n.tag === 'task') tasks.set(n.id.slice(5), { name: names.get(n.id) ?? '', lane: laneOf.get(n.id) ?? '' });
  return {
    tasks,
    startName: names.get(startId) ?? '',
    startTarget: flows.find((f) => f.source === startId)?.target ?? '',
    endCount: [...nodes.values()].filter((n) => n.tag === 'endEvent').length,
    gatewayCount: [...nodes.values()].filter((n) => n.tag === 'exclusiveGateway').length,
    usedLanes: new Set([...laneOf.values()]),
    edges: collapse(nodes, flows).edges,
  };
}

/** Те саме для нашого результату (через наш читач). */
function normalizeOurs(xml: string): Norm {
  const m = readBpmn(xml).model!;
  const laneOf = new Map<string, string>();
  for (const l of m.lanes) for (const r of l.refs) laneOf.set(r, l.name ?? '');
  const tasks = new Map<string, { name: string; lane: string }>();
  for (const n of m.nodes.values()) if (n.tag === 'task') tasks.set(n.id.slice(5), { name: n.name ?? '', lane: laneOf.get(n.id) ?? '' });
  const start = [...m.nodes.values()].find((n) => n.tag === 'startEvent')!;
  const nodes = new Map<string, GNode>([...m.nodes].map(([id, n]) => [id, { id, tag: n.tag }]));
  const flows: GFlow[] = m.flows.map((f) => ({ id: f.id, name: f.name, source: f.source, target: f.target }));
  const usedLanes = new Set<string>();
  for (const n of m.nodes.values()) usedLanes.add(laneOf.get(n.id) ?? '');
  return {
    tasks, startName: start.name ?? '', startTarget: flows.find((f) => f.source === start.id)!.target,
    endCount: [...m.nodes.values()].filter((n) => n.tag === 'endEvent').length,
    gatewayCount: [...m.nodes.values()].filter((n) => n.tag === 'exclusiveGateway').length,
    usedLanes, edges: collapse(nodes, flows).edges,
  };
}

test('оригінали на місці й не змінені (контрольні суми з reference/bpmn-pipeline/SOURCE.md)', () => {
  for (const [f, h] of Object.entries(ORIGINAL_SHA)) assert.equal(sha(join(ORIG, f)), h, `${f} змінено!`);
});

for (const id of ['p01-sequence', 'p02-branch', 'p03-loop', 'p04-entry-not-first', 'p07-large', 'p08-known-limits']) {
  test(`порівняння з оригінальним ланцюгом на коректному вході ${id}: зміст і структура збігаються після нормалізації`, { skip: hasPython ? false : 'python3 недоступний у цьому середовищі — порівняння не виконано' }, async () => {
    const pkg = pkgOf(id);
    const orig = normalizeOriginal(runOriginal(pkg).layouted);
    const ours = normalizeOurs((await generateOk(pkg)).bpmn);
    // контроль: розбір оригінального виходу не порожній (інакше «збіг» нічого не доводить)
    assert.equal(orig.tasks.size, pkg.content.steps.length);
    assert.ok(orig.edges.length >= pkg.content.steps.length, 'з оригінального виходу отримано переходи');
    assert.ok(orig.startName.length > 0 && orig.startTarget.startsWith('Task_'));
    // дії й доріжки кроків
    assert.deepEqual([...ours.tasks].sort(), [...orig.tasks].sort(), 'задачі: ID кроку, дія, доріжка');
    assert.equal(ours.startName, orig.startName);
    assert.equal(ours.startTarget, orig.startTarget, 'початок веде в той самий крок');
    // переходи (з умовами), зокрема цикли, — як мультимножини
    const d1 = diffEdges(orig.edges, ours.edges), d2 = diffEdges(ours.edges, orig.edges);
    assert.deepEqual([d1.missing, d1.extra, d2.missing, d2.extra], [[], [], [], []], 'множини переходів збігаються');
    assert.equal(ours.endCount, orig.endCount);
    assert.equal(ours.gatewayCount, orig.gatewayCount);
    assert.deepEqual([...ours.usedLanes].sort(), [...orig.usedLanes].sort(), 'використані доріжки (порожні не порівнюємо)');
    // і обидва збігаються з самим пакетом (еталоном є пакет, а не будь-який із ланцюгів)
    const exp = pkg.content.steps.flatMap((s) => s.next.map((n) => ({ from: s.id, to: n.to, condition: s.next.length >= 2 ? n.condition : '' })));
    assert.deepEqual([diffEdges(exp, ours.edges).missing, diffEdges(exp, ours.edges).extra], [[], []]);
  });
}

test('дефект оригіналу НЕ відтворюється: різні умови в одну ціль дають в оригіналі однакові ID ліній, у нас — унікальні', { skip: hasPython ? false : 'python3 недоступний' }, async () => {
  const pkg = pkgOf('p06-same-target');
  const run = runOriginal(pkg);
  const ids: string[] = [];
  walk(parseXml(run.pyBpmn), (e) => { if (e.local === 'sequenceFlow') ids.push(attr(e, 'id')!); });
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.ok(dup.length > 0, 'контроль: оригінал справді дає повторні ID ліній (відомий дефект)');
  const ours = await generateOk(pkg);
  const m = readBpmn(ours.bpmn).model!;
  assert.equal(new Set(m.flows.map((f) => f.id)).size, m.flows.length);
  assert.equal(m.flows.filter((f) => f.target === 'Task_S3').length, 2, 'обидві умови в одну ціль збережено');
  assert.equal(ours.drawio.status, 'ok');
});

test('дефект оригіналу НЕ відтворюється: лапка в дії ламає XML оригіналу, а ми зберігаємо текст дослівно', { skip: hasPython ? false : 'python3 недоступний' }, async () => {
  const pkg = clonePkg(pkgOf('p01-sequence'));
  pkg.content.steps[0]!.action = 'Реєструє звернення "Де моє замовлення?" в CRM';
  const run = runOriginal(pkg); // оригінал каже «OK» і завершується успішно
  assert.match(run.stdout, /OK: \d+ rows/);
  const bad = readBpmn(run.pyBpmn);
  assert.equal(bad.model, null, 'XML оригінального ланцюга зіпсований (строгий розбір це бачить)');
  assert.equal(bad.issues[0]!.code, 'XML_MALFORMED');
  const ours = await generateOk(pkg);
  assert.equal(readBpmn(ours.bpmn).model!.nodes.get('Task_S1')!.name, pkg.content.steps[0]!.action);
});

test('дефект оригіналу НЕ відтворюється: глобальний стан — той самий вхід у нас дає ту саму схему незалежно від попередніх запусків', async () => {
  const a = await generateOk(pkgOf('p07-large'));
  await generateOk(pkgOf('p05-special-text'));
  await generateOk(pkgOf('p02-branch'));
  const b = await generateOk(pkgOf('p07-large'));
  assert.equal(a.bpmn, b.bpmn);
  assert.deepEqual(readBpmn(a.bpmn).model!.lanes.map((l) => l.name), pkgOf('p07-large').content.roles, 'порядок доріжок = порядок ролей у пакеті, а не залежить від історії запусків');
  assert.equal((await generateBpmn(pkgOf('b01-unknown-transition'))).status, 'blocked');
});
