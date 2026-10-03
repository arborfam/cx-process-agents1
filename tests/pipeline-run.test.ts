/**
 * Запуск ланцюга скриптів (D87, вимога 3): ізоляція, помилки, Windows, відсутність оболонки.
 *
 * Окремо — вимога 5: технічна перебудова використовує ЗБЕРЕЖЕНУ таблицю й не викликає моделі.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPython, runPipeline, STEP_TIMEOUT_MS } from '../src/pipeline/run.ts';
import { PIPELINE_STEPS, pipelineVersion, scriptHashes, scriptPath } from '../src/pipeline/scripts.ts';
import { buildArtifact } from '../src/bpmn-artifacts.ts';
import { all } from '../src/db.ts';
import { runBpmnReviewForCase } from '../src/review-runs.ts';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, okStep, policyOf, reviewer } from './review-helpers.ts';
import { scriptedCsv } from './csv-fixture.ts';
import { pkgOf } from './bpmn-helpers.ts';

const hasPython = findPython() !== null;
const simple = (): { csv: string; poolName: string; lanes: string[] } => {
  const p = pkgOf('p01-sequence');
  return {
    csv: scriptedCsv(p.content), poolName: p.content.process_name ?? '',
    lanes: p.content.roles.filter((r) => p.content.steps.some((s) => s.role === r)),
  };
};

test('1. Запуск не лишає по собі тимчасових файлів і не має спільного стану між запусками', { skip: hasPython ? false : 'python3 недоступний' }, () => {
  // Власна тека для тимчасових файлів саме цього тесту: інакше паралельні запуски інших тестів
  // створювали б у спільному tmp свої теки й лічильник нічого не доводив би.
  const own = mkdtempSync(join(tmpdir(), 'cx-tmproot-'));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try {
    const a = runPipeline(simple());
    const b = runPipeline(simple());
    assert.ok(a.ok && b.ok, a.ok ? '' : a.message);
    assert.deepEqual(readdirSync(own), [], 'тимчасова тека видаляється після запуску');
    assert.equal(a.ok && b.ok && a.bpmn, b.ok ? b.bpmn : '', 'той самий вхід — той самий файл');
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    rmSync(own, { recursive: true, force: true });
  }
});

test('2. Помилка кроку — чесна зупинка з текстом stderr, а не «мовчазний успіх»', { skip: hasPython ? false : 'python3 недоступний' }, () => {
  const bad = runPipeline({ ...simple(), csv: 'id,label,type,role,next,yes,no,assoc\nX,щось,НЕВІДОМИЙ-ТИП,,,,,\n' });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? '' : bad.stage, 'table_to_bpmn.py');
  assert.match(bad.ok ? '' : bad.message, /table|таблиц|KeyError|помилк/i);
  assert.ok(bad.log.length >= 1, 'журнал кроків зберігається');
});

test('3. Текст моделі не стає командою оболонки: скрипти запускаються списком аргументів', () => {
  const code = readFileSync(join(import.meta.dirname, '..', 'src', 'pipeline', 'run.ts'), 'utf8');
  assert.match(code, /shell:\s*false/, 'оболонка вимкнена явно');
  assert.ok(!/exec\s*\(|execSync|`[^`]*\$\{[^}]*\}[^`]*`\s*,\s*\{\s*shell/.test(code), 'немає виклику через оболонку');
  // Сама таблиця передається ФАЙЛОМ, а не аргументом.
  assert.match(code, /writeFileSync\(f\('in\.csv'\), input\.csv/);
  assert.ok(!/args.*input\.csv/.test(code), 'таблиця не передається аргументом');
});

test('3. Небезпечний текст у підписах не виконується й зберігається дослівно', { skip: hasPython ? false : 'python3 недоступний' }, () => {
  const danger = '$(rm -rf /) `whoami` && echo ; | > <script>';
  const csv = 'id,label,type,role,next,yes,no,assoc\n'
    + `StartEvent_1,"${danger}",start,,Task_S1,,,\n`
    + 'Task_S1,"Крок",task,Роль,End_S1_1,,,\nEnd_S1_1,,end,,,,,\n';
  const r = runPipeline({ csv, poolName: danger, lanes: ['Роль'] });
  assert.ok(r.ok, r.ok ? '' : r.message);
  assert.ok(r.bpmn.includes('&lt;script&gt;') || r.bpmn.includes('&lt;script>'), 'текст екранований, а не виконаний');
  assert.ok(r.drawio.includes('whoami'), 'текст збережено дослівно');
});

test('4. Windows: Python шукається за змінною середовища, Bash не потрібен', () => {
  const code = readFileSync(join(import.meta.dirname, '..', 'src', 'pipeline', 'run.ts'), 'utf8');
  assert.match(code, /CX_PYTHON/);
  assert.match(code, /'python3', 'python'/);
  assert.match(code, /windowsHide/);
  // Згадка run_pipeline.sh у коментарі допустима (пояснює, чим цей запуск відрізняється); виклику немає.
  const body = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/run_pipeline\.sh|\bbash\b|\bsh -c\b/.test(body), 'оболонкового сценарію в продукті немає');
  assert.ok(STEP_TIMEOUT_MS > 0 && STEP_TIMEOUT_MS <= 120_000, 'крок має обмеження часу');
});

test('5. Версія скриптів фіксується й змінюється разом зі скриптами', () => {
  const h = scriptHashes();
  assert.equal(Object.keys(h).length, PIPELINE_STEPS.length);
  for (const s of PIPELINE_STEPS) assert.match(h[s.name]!, /^[0-9a-f]{64}$/);
  assert.equal(pipelineVersion(), pipelineVersion());
  assert.match(pipelineVersion(), /^[0-9a-f]{16}$/);
  for (const s of PIPELINE_STEPS) assert.ok(readFileSync(scriptPath(s.name), 'utf8').length > 100, s.name);
});

test('6. Технічна перебудова бере ЗБЕРЕЖЕНУ таблицю й версію скриптів — без нового виклику моделі', { skip: hasPython ? false : 'python3 недоступний' }, async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([])]);
  await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  const first = await buildArtifact(db, human, c.id);
  assert.equal(first.artifact.status, 'ok');
  assert.equal(client.calls, 1);
  const detail = first.artifact.detail;
  assert.match(detail.csv ?? '', /^id,label,type,role,next,yes,no,assoc\n/);
  assert.equal(detail.pipeline_version, pipelineVersion());
  assert.deepEqual(detail.pipeline_scripts, scriptHashes());
  assert.ok((detail.pipeline_log ?? []).length === PIPELINE_STEPS.length, 'журнал усіх кроків збережено');

  const again = await buildArtifact(db, human, c.id);
  assert.equal(again.reused, true);
  assert.equal(client.calls, 1, 'повтор не викликає моделі');
  assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 1);
});
