/**
 * Робоча копія ланцюга власниці проти ОРИГІНАЛУ (D87, вимога 3).
 *
 * Оригінали в `reference/bpmn-pipeline/original/` не змінюються й виконуються лише на читання з їхнього місця;
 * усі виходи — в унікальній тимчасовій теці. Робоча копія лежить у `pipeline/`.
 *
 * Що доводиться:
 *  1. оригінали на місці й не змінені (контрольні суми);
 *  2. кожна відмінність робочої копії ПОЗНАЧЕНА в коді й ОПИСАНА в `pipeline/DIFFERENCES.md` — і навпаки;
 *  3. на тому самому вході обидва ланцюги дають однаковий ЗМІСТ (кроки, підписи, ролі, переходи);
 *  4. відомі дефекти оригіналу робоча копія не відтворює (лапка ламає XML, повторні ID ліній,
 *     дві різні лінії лягають одна на одну).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseXml, walk, attr, elementChildren, type XmlElement } from '../src/bpmn/xml.ts';
import { PIPELINE_STEPS, scriptPath } from '../src/pipeline/scripts.ts';
import { runPipeline } from '../src/pipeline/run.ts';
import { scriptedCsv } from './csv-fixture.ts';
import { pkgOf } from './bpmn-helpers.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';

const ROOT = join(import.meta.dirname, '..');
const ORIG = join(ROOT, 'reference', 'bpmn-pipeline', 'original');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

const ORIGINAL_SHA: Record<string, string> = {
  'table_to_bpmn.py': '6270e141902f5f6afd43660e3b5db214f6ee5d8844e4f89cb66f79ad9e7b6e5c',
  'bpmn_di_to_drawio.py': 'cb36a0661ac71d18b632815a8a12d07e9c262c6c4884b2cef6974af4704e18e9',
  'layout_step.mjs': '6fec376e70317829f1dc3bd85115502e7238cb3b20c12ee05126aa8e06a9ce43',
  'run_pipeline.sh': '07154ed2199560e22b80b0713ce8d214c64ab473aa69c0d5048b879ee7b74e69',
};

test('1. оригінали на місці й не змінені (контрольні суми з reference/bpmn-pipeline/SOURCE.md)', () => {
  for (const [f, h] of Object.entries(ORIGINAL_SHA)) assert.equal(sha(join(ORIG, f)), h, `${f} змінено!`);
});

// ───────────────────────── 2. відмінності позначені й описані ─────────────────────────

test('2. кожна відмінність робочої копії позначена в коді й описана в pipeline/DIFFERENCES.md', () => {
  const doc = readFileSync(join(ROOT, 'pipeline', 'DIFFERENCES.md'), 'utf8');
  const inCode = new Set<string>();
  for (const s of PIPELINE_STEPS) {
    for (const m of readFileSync(scriptPath(s.name), 'utf8').matchAll(/Відмінність (\d+)/g)) inCode.add(m[1]!);
  }
  const inDoc = new Set([...doc.matchAll(/^### (\d+)\./gm)].map((m) => m[1]!));
  assert.ok(inCode.size >= 10, `контроль: відмінності в коді позначені (знайдено ${inCode.size})`);
  assert.deepEqual([...inCode].sort((a, b) => Number(a) - Number(b)), [...inDoc].sort((a, b) => Number(a) - Number(b)),
    'перелік відмінностей у коді й у DIFFERENCES.md має збігатися');
});

test('2. робоча копія справді відрізняється від оригіналу (інакше копія не потрібна)', () => {
  for (const s of PIPELINE_STEPS) {
    const original = join(ORIG, s.name);
    if (s.name === 'fix_labels.py') continue; // цього кроку в оригіналі немає взагалі
    assert.notEqual(sha(scriptPath(s.name)), sha(original), `${s.name}: робоча копія не відрізняється`);
  }
});

// ───────────────────────── 3. однаковий зміст на тому самому вході ─────────────────────────

/** Запуск ОРИГІНАЛЬНОГО ланцюга (table_to_bpmn.py → layout_step.mjs) на готовій таблиці. */
function runOriginal(csv: string, poolName: string): { semantic: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cx-orig-'));
  try {
    const inCsv = join(dir, 'in.csv'), sem = join(dir, 'sem.bpmn');
    writeFileSync(inCsv, csv, 'utf8');
    const a = spawnSync('python3', [join(ORIG, 'table_to_bpmn.py'), inCsv, sem, poolName], { encoding: 'utf8' });
    assert.equal(a.status, 0, `table_to_bpmn.py: ${a.stderr}`);
    return { semantic: readFileSync(sem, 'utf8'), stdout: a.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Norm { tasks: [string, string, string][]; start: string; flows: [string, string, string][]; lanes: string[] }

/** Нормалізований зміст схеми: ID без префікса «e», userTask ≈ task, доріжки як множина. */
function normalize(xml: string): Norm {
  const root = parseXml(xml);
  const id = (x: string): string => x.replace(/^e/, '');
  const tags = new Map<string, string>();
  const names = new Map<string, string>();
  const laneOf = new Map<string, string>();
  const lanes: string[] = [];
  const flows: [string, string, string][] = [];
  walk(root, (e: XmlElement) => {
    const eid = attr(e, 'id');
    if (eid && ['task', 'userTask', 'startEvent', 'endEvent', 'exclusiveGateway'].includes(e.local)) {
      tags.set(id(eid), e.local === 'userTask' ? 'task' : e.local);
      names.set(id(eid), attr(e, 'name') ?? '');
    }
    if (e.local === 'lane') {
      const name = attr(e, 'name') ?? '';
      lanes.push(name);
      for (const ch of elementChildren(e)) if (ch.local === 'flowNodeRef') laneOf.set(id(ch.children.join('').trim()), name);
    }
    if (e.local === 'sequenceFlow') flows.push([id(attr(e, 'sourceRef') ?? ''), id(attr(e, 'targetRef') ?? ''), attr(e, 'name') ?? '']);
  });
  const tasks: [string, string, string][] = [];
  for (const [eid, tag] of tags) if (tag === 'task') tasks.push([eid, names.get(eid) ?? '', laneOf.get(eid) ?? '']);
  const start = [...tags].find(([, t]) => t === 'startEvent')?.[0] ?? '';
  return {
    tasks: tasks.sort(), start,
    flows: flows.sort(), lanes: [...new Set(lanes)].sort(),
  };
}

for (const id of ['p01-sequence', 'p02-branch', 'p03-loop', 'p07-large']) {
  test(`3. ${id}: оригінал і робоча копія дають однаковий зміст (кроки, підписи, ролі, переходи)`, { skip: hasPython ? false : 'python3 недоступний' }, () => {
    const pkg: ApprovedPackage = pkgOf(id);
    const csv = scriptedCsv(pkg.content);
    const lanes = pkg.content.roles.filter((r) => pkg.content.steps.some((s) => s.role === r));
    const mine = runPipeline({ csv, poolName: pkg.content.process_name ?? '', lanes });
    assert.ok(mine.ok, mine.ok ? '' : mine.message);
    const orig = normalize(runOriginal(csv, pkg.content.process_name ?? '').semantic);
    const ours = normalize(mine.bpmn);
    assert.equal(orig.tasks.length, pkg.content.steps.length, 'контроль: оригінал справді розібрано');
    assert.deepEqual(ours.tasks, orig.tasks, 'кроки: ID, дія, доріжка');
    assert.deepEqual(ours.lanes, orig.lanes, 'доріжки з діями');
    assert.deepEqual(ours.flows, orig.flows, 'переходи з умовами');
    assert.equal(ours.start, orig.start);
  });
}

// ───────────────────────── 4. дефекти оригіналу не відтворюються ─────────────────────────

test('4. лапка в дії ламає XML оригіналу — робоча копія зберігає текст дослівно', { skip: hasPython ? false : 'python3 недоступний' }, () => {
  const csv = 'id,label,type,role,next,yes,no,assoc\n'
    + 'StartEvent_1,Початок,start,,Task_S1,,,\n'
    + 'Task_S1,"Реєструє звернення ""Де моє замовлення?"" в CRM",task,Оператор,End_S1_1,,,\n'
    + 'End_S1_1,,end,,,,,\n';
  const orig = runOriginal(csv, 'Тест');
  assert.match(orig.stdout, /OK: \d+ rows/, 'оригінал каже «успіх»');
  assert.throws(() => parseXml(orig.semantic), /./, 'але XML оригіналу зіпсований');
  const mine = runPipeline({ csv, poolName: 'Тест', lanes: ['Оператор'] });
  assert.ok(mine.ok, mine.ok ? '' : mine.message);
  const names: string[] = [];
  walk(parseXml(mine.bpmn), (e) => { if (e.local === 'task') names.push(attr(e, 'name') ?? ''); });
  assert.deepEqual(names, ['Реєструє звернення "Де моє замовлення?" в CRM']);
});

test('4. два різні переходи в ту саму ціль: в оригіналі однакові ID ліній, у робочій копії — різні й розведені', { skip: hasPython ? false : 'python3 недоступний' }, () => {
  const pkg = pkgOf('p06-same-target');
  const csv = scriptedCsv(pkg.content);
  const ids: string[] = [];
  walk(parseXml(runOriginal(csv, 'Тест').semantic), (e) => { if (e.local === 'sequenceFlow') ids.push(attr(e, 'id')!); });
  assert.ok(ids.filter((x, i) => ids.indexOf(x) !== i).length > 0, 'контроль: оригінал справді дає повторні ID');
  const lanes = pkg.content.roles.filter((r) => pkg.content.steps.some((s) => s.role === r));
  const mine = runPipeline({ csv, poolName: pkg.content.process_name ?? '', lanes });
  assert.ok(mine.ok, mine.ok ? '' : mine.message);
  const myIds: string[] = [];
  const paths: string[] = [];
  walk(parseXml(mine.bpmn), (e) => {
    if (e.local === 'sequenceFlow') myIds.push(attr(e, 'id')!);
    if (e.local === 'BPMNEdge') paths.push(elementChildren(e).filter((w) => w.local === 'waypoint').map((w) => `${attr(w, 'x')},${attr(w, 'y')}`).join(' '));
  });
  assert.equal(new Set(myIds).size, myIds.length, 'ID ліній унікальні');
  assert.equal(new Set(paths).size, paths.length, 'жодні дві лінії не лежать одна на одній');
});

test('4. глобального стану немає: той самий вхід дає той самий файл незалежно від попередніх запусків', { skip: hasPython ? false : 'python3 недоступний' }, () => {
  const a = pkgOf('p07-large'), b = pkgOf('p02-branch');
  const run = (p: ApprovedPackage) => runPipeline({
    csv: scriptedCsv(p.content), poolName: p.content.process_name ?? '',
    lanes: p.content.roles.filter((r) => p.content.steps.some((s) => s.role === r)),
  });
  const first = run(a);
  run(b);
  const second = run(a);
  assert.ok(first.ok && second.ok);
  assert.equal(first.ok && second.ok && first.bpmn, second.ok ? second.bpmn : '', 'схема не залежить від історії запусків');
});
