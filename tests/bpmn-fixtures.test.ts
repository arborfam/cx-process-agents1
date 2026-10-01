/**
 * Зріз 3a: тестові пакети (підготовлені вручну, без AI) → схеми. Очікування записані в самих пакетах ДО запуску.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { verifyBpmn } from '../src/bpmn/verify.ts';
import { readBpmn } from '../src/bpmn/read.ts';
import { readDrawio } from '../src/bpmn/drawio.ts';
import { fixtureToPackage } from '../src/bpmn/fixture.ts';
import { allFixtures, clonePkg, generateOk, pkgOf } from './bpmn-helpers.ts';

const fixtures = allFixtures();

test('набір тестових пакетів містить усі потрібні випадки', () => {
  assert.ok(fixtures.length >= 11, `пакетів ${fixtures.length}`);
  for (const f of fixtures) {
    assert.equal(f.created_without_ai, true, `${f.id}: має бути позначено «створено без AI»`);
    assert.equal(f.synthetic, true);
    assert.ok(f.what_it_tests.length > 20, `${f.id}: немає пояснення, що перевіряє пакет`);
  }
  const statuses = new Set(fixtures.map((f) => f.expect.status));
  assert.deepEqual([...statuses].sort(), ['blocked', 'ok', 'unsupported']);
});

for (const fx of fixtures) {
  test(`пакет ${fx.id}: результат збігається з очікуванням, записаним у пакеті`, async () => {
    const r = await generateBpmn(fixtureToPackage(fx));
    assert.equal(r.status, fx.expect.status, `${fx.id}: ${JSON.stringify(r).slice(0, 500)}`);
    if (r.status === 'ok') {
      assert.equal(r.verification.ok, true);
      assert.deepEqual(r.verification.errors, []);
      assert.deepEqual(r.verification.warnings, [], `${fx.id}: попередження геометрії: ${JSON.stringify(r.verification.warnings)}`);
      assert.equal(r.drawio.status, 'ok', JSON.stringify(r.drawio.issues));
      assert.deepEqual(r.layoutWarnings, []);
      assert.equal(r.map.length, fx.steps.length, 'у карті має бути рядок на кожен крок');
    } else {
      const codes = 'findings' in r ? r.findings.map((f) => f.code) : [];
      for (const c of fx.expect.codes ?? []) assert.ok(codes.includes(c), `${fx.id}: немає коду ${c}, є ${codes.join(',')}`);
      assert.equal('bpmn' in r, false, 'при відмові файл не створюється');
    }
  });
}

test('коректна послідовність, розгалуження, цикл із виходом: структура схеми', async () => {
  const seq = await generateOk(pkgOf('p01-sequence'));
  const m1 = readBpmn(seq.bpmn).model!;
  assert.equal([...m1.nodes.values()].filter((n) => n.tag === 'task').length, 5);
  assert.equal([...m1.nodes.values()].filter((n) => n.tag === 'exclusiveGateway').length, 0);
  assert.equal([...m1.nodes.values()].filter((n) => n.tag === 'endEvent').length, 1);

  const br = await generateOk(pkgOf('p02-branch'));
  const m2 = readBpmn(br.bpmn).model!;
  // S2 має три гілки → один шлюз; S5 має дві → ще один; кінцевих подій по одній на кожне END
  assert.equal([...m2.nodes.values()].filter((n) => n.tag === 'exclusiveGateway').length, 2);
  assert.equal([...m2.nodes.values()].filter((n) => n.tag === 'endEvent').length, 2);

  const loop = await generateOk(pkgOf('p03-loop'));
  const row = loop.map.find((r) => r.step_id === 'S2')!;
  assert.deepEqual(row.outgoing.map((o) => `${o.condition}→${o.to}`).sort(), ['потрібне доопрацювання→S1', 'текст затверджено→S3']);
});

test('початок визначається лише entry_step_id: початок не в першому рядку, перестановка рядків не змінює файл', async () => {
  const p = pkgOf('p04-entry-not-first');
  assert.equal(p.content.steps[0]!.id, 'S3', 'у пакеті перший рядок — не початковий крок');
  const a = await generateOk(p);
  const m = readBpmn(a.bpmn).model!;
  const start = [...m.nodes.values()].find((n) => n.tag === 'startEvent')!;
  assert.equal(m.flows.find((f) => f.source === start.id)!.target, 'Task_S2');
  // усі 6 перестановок рядків дають побайтово однаковий файл
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const perm of perms) {
    const q = clonePkg(p);
    q.content.steps = perm.map((i) => p.content.steps[i]!);
    const b = await generateOk(q);
    assert.equal(b.bpmn, a.bpmn, `перестановка ${perm} змінила схему`);
    assert.equal(b.drawio.xml, a.drawio.xml);
  }
  // великий процес: випадкова перестановка
  const big = pkgOf('p07-large');
  const base = await generateOk(big);
  const q = clonePkg(big);
  q.content.steps = [...big.content.steps].reverse();
  assert.equal((await generateOk(q)).bpmn, base.bpmn);
});

test('результат відтворюваний: однаковий вхід → однаковий файл', async () => {
  for (const id of ['p02-branch', 'p03-loop', 'p07-large']) {
    const a = await generateOk(pkgOf(id));
    const b = await generateOk(pkgOf(id));
    assert.equal(a.bpmn, b.bpmn);
    assert.equal(a.drawio.xml, b.drawio.xml);
  }
});

test('спецсимволи, лапки, кирилиця, довгі підписи, різні умови в одну ціль зберігаються дослівно в обох форматах', async () => {
  for (const id of ['p05-special-text', 'p06-same-target']) {
    const p = pkgOf(id);
    const r = await generateOk(p);
    const m = readBpmn(r.bpmn).model!;
    for (const s of p.content.steps) assert.equal(m.nodes.get(`Task_${s.id}`)!.name, s.action, `${id}: дія ${s.id}`);
    assert.equal(m.participant!.name, p.poolName);
    assert.deepEqual(m.lanes.map((l) => l.name), p.content.roles);
    const d = readDrawio(r.drawio.xml!);
    for (const s of p.content.steps) assert.equal(d.cells.find((c) => c.id === `Task_${s.id}`)!.value, s.action, `${id}: дія ${s.id} у .drawio`);
    for (const f of m.flows) {
      const cell = d.cells.find((c) => c.id === f.id)!;
      assert.equal(cell.value, f.name ?? '', `підпис лінії ${f.id} у .drawio`);
    }
    assert.equal(d.cells.filter((c) => c.edge).length, m.flows.length, 'кількість стрілок у .drawio = кількість переходів');
  }
  // дві умови в одну ціль: обидві лінії існують із різними ID, обидва підписи на місці
  const r = await generateOk(pkgOf('p06-same-target'));
  const m = readBpmn(r.bpmn).model!;
  const toS3 = m.flows.filter((f) => f.target === 'Task_S3');
  assert.deepEqual(toS3.map((f) => f.name).sort(), ['погоджено', 'погоджено умовно']);
  assert.equal(new Set(m.flows.map((f) => f.id)).size, m.flows.length, 'ID переходів унікальні');
});

test('довгий підпис: блок збільшується так, що текст вміщується (а не обрізається)', async () => {
  const r = await generateOk(pkgOf('p05-special-text'));
  assert.ok(r.layoutScale.x > 1 && r.layoutScale.y > 1, 'схему збільшено під довгу дію');
  const m = readBpmn(r.bpmn).model!;
  const long = m.shapes.get('Task_S3')![0]!;
  assert.ok(long.w > 100 && long.h > 80);
  // той самий вхід без довгої дії лишається компактним
  const short = await generateOk(pkgOf('p01-sequence'));
  assert.deepEqual(short.layoutScale, { x: 1, y: 1 });
});

test('карта «крок ↔ елемент» повна: кожен крок має задачу, доріжку й переходи з умовами', async () => {
  const p = pkgOf('p02-branch');
  const r = await generateOk(p);
  for (const s of p.content.steps) {
    const row = r.map.find((x) => x.step_id === s.id)!;
    assert.equal(row.bpmn_task_id, `Task_${s.id}`);
    assert.equal(row.drawio_cell_id, `Task_${s.id}`, 'ID кроку збережено в клітинці .drawio');
    assert.equal(row.role, s.role);
    assert.equal(row.outgoing.length, s.next.length);
    assert.equal(!!row.gateway_id, s.next.length >= 2);
  }
});

test('тип елемента: нейтральна задача без іконки «людина»; початкова й кінцева події без типу', async () => {
  const r = await generateOk(pkgOf('p02-branch'));
  assert.ok(!/userTask|serviceTask|manualTask/.test(r.bpmn));
  assert.ok(!/EventDefinition/.test(r.bpmn));
  assert.ok(/<bpmn:task id="Task_S1"/.test(r.bpmn));
  assert.ok(/taskMarker=abstract/.test(r.drawio.xml!) && !/taskMarker=user/.test(r.drawio.xml!));
});

test('відомі некритичні обмеження (K2) не блокують побудову й показуються поруч зі схемою', async () => {
  const r = await generateOk(pkgOf('p08-known-limits'));
  const codes = r.knownLimits.map((l) => l.code);
  for (const c of ['OPEN_QUESTION', 'OPEN_HYPOTHESIS', 'ESTIMATE', 'ROLE_WITHOUT_STEPS', 'FIELDS_NOT_ON_DIAGRAM']) assert.ok(codes.includes(c), `немає ${c}`);
  assert.equal(r.knownLimits.every((l) => l.class === 'K2'), true);
  // порожня доріжка існує (на кожну погоджену роль — одна доріжка)
  assert.deepEqual(readBpmn(r.bpmn).model!.lanes.map((l) => l.name), ['Бухгалтер', 'Фінансовий директор', 'Архіваріус']);
});

test('результат позначено походженням: тестовий пакет → test-fixture у файлі, у .drawio і в перегляді', async () => {
  const r = await generateOk(pkgOf('p01-sequence'));
  assert.match(r.bpmn, /origin="test-fixture"/);
  assert.match(r.drawio.xml!, /cx_origin="test-fixture"/);
  assert.equal(r.binding.origin, 'test-fixture');
  assert.equal(verifyBpmn(r.bpmn, pkgOf('p01-sequence')).report.ok, true);
});
