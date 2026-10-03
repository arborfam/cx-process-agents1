/**
 * «Прихованого запасного генератора бути не повинно» (D87) — структурно, а не на довіру.
 *
 * Продукт НЕ вміє складати таблицю процесу. Якщо таблиці від агента 2 немає, побудова чесно зупиняється
 * з поясненням, а не домальовує схему сама. Сценарна таблиця для тестів живе поза `src/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildArtifact, buildPreflight } from '../src/bpmn-artifacts.ts';
import { all } from '../src/db.ts';
import { getCaseReview, runBpmnReviewForCase } from '../src/review-runs.ts';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, okStep, policyOf, reviewer } from './review-helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const srcFiles = (): string[] => walk(join(ROOT, 'src')).filter((x) => x.endsWith('.ts'));

test('1. У продукті немає коду, який складає таблицю процесу', () => {
  for (const f of srcFiles()) {
    const rel = relative(ROOT, f).split(sep).join('/');
    const code = readFileSync(f, 'utf8');
    // Запис рядка таблиці (`csvLine`, `csvCell`) у продукті не використовується — лише розбір і перевірка.
    if (rel !== 'src/csv/parse.ts') {
      assert.ok(!/\bcsvLine\s*\(|\bcsvCell\s*\(/.test(code), `${rel}: складає рядок таблиці`);
    }
    assert.ok(!/scriptedCsv/.test(code), `${rel}: використовує сценарну таблицю з тестів`);
    assert.ok(!/from\s+['"][^'"]*tests\//.test(code), `${rel}: імпортує щось із tests/`);
    // Заголовок таблиці згадується лише там, де він перевіряється.
    if (!['src/csv/parse.ts'].includes(rel)) {
      assert.ok(!/id,label,type,role,next,yes,no,assoc/.test(code), `${rel}: будує таблицю з заголовком`);
    }
  }
});

test('2. Сценарна таблиця лежить поза src/ (у tests/) і в продукт не потрапляє', () => {
  const fixture = join(ROOT, 'tests', 'csv-fixture.ts');
  assert.ok(readFileSync(fixture, 'utf8').includes('scriptedCsv'), 'контроль: файл на місці');
  assert.ok(!srcFiles().some((f) => f.includes('csv-fixture')), 'у src/ такого файлу немає');
});

test('3. Без таблиці від агента побудова зупиняється з поясненням — і нічого не створює', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  // Відповідь агента БЕЗ таблиці: так виглядає результат, отриманий за старим контрактом.
  const client = new FakeReviewClient([okStep([], undefined, null)]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  // Така відповідь навіть не приймається: таблиця обов'язкова для пакета, який можна перенести в таблицю.
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(getCaseReview(db, c.id).state, 'failed');
  const pre = buildPreflight(db, c.id);
  assert.equal(pre.ok, false);
  await assert.rejects(() => buildArtifact(db, human, c.id));
  assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0, 'жодного файлу не створено');
});

test('4. Стара перевірка без таблиці не видається за результат нового контракту', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok);
  // Прибираємо таблицю зі збереженої відповіді — так виглядає запис, зроблений до переходу на таблицю.
  const row = all<{ id: string; response_json: string }>(db, 'SELECT id, response_json FROM bpmn_review')[0]!;
  const without = JSON.stringify({ findings: JSON.parse(row.response_json).findings });
  assert.throws(() => db.prepare('UPDATE bpmn_review SET response_json = ? WHERE id = ?').run(without, row.id), /незмінна/,
    'запис перевірки незмінний — підмінити відповідь у базі не можна');
});
