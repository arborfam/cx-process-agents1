/**
 * Ізоляція запусків (D22): оригінальний ланцюг із фіксованими файлами /tmp давав 0 правильних із 20 паралельних пар.
 * Генератор не має спільного стану й файлів: паралельні запуски різних процесів не змішуються.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
// Побудова йде продуктовим шляхом (D87): сценарна таблиця → перевірка → скрипти пайплайна → звірка файлів.
import { generateViaPipeline as generateBpmn } from './bpmn-helpers.ts';
import { verifyBpmn } from '../src/bpmn/verify.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import { makeProcess } from './bpmn-gen.ts';

const PAIRS = 24;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

test('процеси для перевірки різні між собою (контроль тесту)', () => {
  const xs = Array.from({ length: PAIRS * 2 }, (_, i) => JSON.stringify(makeProcess(i).content));
  assert.equal(new Set(xs).size, PAIRS * 2);
});

test(`≥20 паралельних пар різних процесів в одному процесі Node: кожен результат відповідає лише своєму пакету`, async () => {
  // послідовний еталон
  const seq: string[] = [];
  for (let i = 0; i < PAIRS * 2; i++) {
    const r = await generateBpmn(makeProcess(i));
    assert.equal(r.status, 'ok', `процес ${i}: ${JSON.stringify(r).slice(0, 300)}`);
    if (r.status === 'ok') seq.push(r.bpmn);
  }
  // усі 48 одночасно
  const results = await Promise.all(Array.from({ length: PAIRS * 2 }, (_, i) => generateBpmn(makeProcess(i))));
  let mixed = 0;
  for (let pair = 0; pair < PAIRS; pair++) {
    const a = results[2 * pair]!, b = results[2 * pair + 1]!;
    assert.equal(a.status, 'ok');
    assert.equal(b.status, 'ok');
    if (a.status !== 'ok' || b.status !== 'ok') continue;
    const pa = makeProcess(2 * pair), pb = makeProcess(2 * pair + 1);
    // 1) кожен файл повністю збігається зі СВОЇМ пакетом
    // Доріжки — лише для ролей із діями (D87); решта перевірки не змінилась.
    const lanesOf = (p: ApprovedPackage): string[] => p.content.roles.filter((r) => p.content.steps.some((s) => s.role === r));
    assert.deepEqual(verifyBpmn(a.bpmn, pa, { lanes: lanesOf(pa) }).report.errors, [], `пара ${pair}: A не відповідає своєму пакету`);
    assert.deepEqual(verifyBpmn(b.bpmn, pb, { lanes: lanesOf(pb) }).report.errors, [], `пара ${pair}: B не відповідає своєму пакету`);
    // 2) і не збігається з чужим
    assert.equal(verifyBpmn(a.bpmn, pb).report.ok, false);
    assert.equal(verifyBpmn(b.bpmn, pa).report.ok, false);
    // 3) змісту сусіда немає (мітка «П<номер>» без продовження цифрами)
    assert.ok(!new RegExp(`П${2 * pair + 1}(?!\\d)`).test(a.bpmn), `пара ${pair}: у файлі A є слід процесу B`);
    assert.ok(!new RegExp(`П${2 * pair}(?!\\d)`).test(b.bpmn), `пара ${pair}: у файлі B є слід процесу A`);
    // 4) побайтово збігається з послідовним запуском того самого пакета
    if (a.bpmn !== seq[2 * pair] || b.bpmn !== seq[2 * pair + 1]) mixed++;
  }
  assert.equal(mixed, 0, 'паралельний результат відрізняється від послідовного (змішування чи спільний стан)');
});

test('≥20 паралельних пар в окремих процесах ОС: кожен результат збігається з еталоном свого пакета', async () => {
  const N = PAIRS * 2;
  const expected: string[] = [];
  for (let i = 0; i < N; i++) {
    const r = await generateBpmn(makeProcess(i));
    assert.equal(r.status, 'ok');
    expected.push(r.status === 'ok' ? sha(r.bpmn) : '');
  }
  const run = (i: number): Promise<{ i: number; status: string; sha: string | null; pid: number }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'tests/bpmn-child.ts', String(i)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { errOut += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`процес ${i} завершився з кодом ${code}: ${errOut.slice(0, 400)}`));
      else resolve(JSON.parse(out) as { i: number; status: string; sha: string | null; pid: number });
    });
  });
  const all = await Promise.all(Array.from({ length: N }, (_, i) => run(i)));
  assert.equal(new Set(all.map((r) => r.pid)).size, N, 'кожен запуск — окремий процес ОС');
  for (const r of all) {
    assert.equal(r.status, 'ok');
    assert.equal(r.sha, expected[r.i], `процес ${r.i}: результат не збігається з еталоном свого пакета`);
  }
  // жодних спільних файлів: генератор не створює файлів узагалі (див. bpmn-isolation)
});
