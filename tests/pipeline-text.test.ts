/**
 * Оцінка розміру тексту в кроці `fix_labels.py` і в перевірці (`src/bpmn/text.ts`) має збігатися.
 *
 * Навіщо: крок пайплайна рахує рамку підпису за своєю оцінкою ширини символів, а зворотна перевірка
 * перевіряє, чи текст уміщується, за своєю. Якщо оцінки розійдуться, перевірка або пропускатиме обрізаний
 * підпис, або відхилятиме нормальний файл. Тому вони звіряються на тих самих рядках.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findPython } from '../src/pipeline/run.ts';
import { PIPELINE_DIR } from '../src/pipeline/scripts.ts';
import { textWidth, wrapLines, LINE_HEIGHT } from '../src/bpmn/text.ts';

const python = findPython();

const SAMPLES = [
  'Коротка дія',
  'Реєструє звернення клієнта в CRM і призначає відповідального',
  'Перевіряє суму: якщо a < b && b > c — виділяє «жирним» у картці; знижка 100% - 15%',
  'CX дізналася про майбутню велику продуктову зміну',
  'ЩЮЖФМ Ш Щ Ю — широкі літери й розділові знаки: .,:;!()[]{}«»',
  'слово '.repeat(40).trim(),
];

test('оцінка ширини тексту й перенос у Python і в TypeScript збігаються', { skip: python ? false : 'python3 недоступний' }, () => {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PIPELINE_DIR)})
import fix_labels as F
data = json.loads(sys.stdin.read())
out = [{'w': F.text_width(t), 'lines': F.wrap_lines(t, 140), 'lh': F.LINE_HEIGHT} for t in data]
print(json.dumps(out, ensure_ascii=False))
`;
  const r = spawnSync(python!, ['-c', script], { input: JSON.stringify(SAMPLES), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout) as { w: number; lines: string[]; lh: number }[];
  SAMPLES.forEach((t, i) => {
    assert.ok(Math.abs(got[i]!.w - textWidth(t)) < 0.01, `ширина «${t.slice(0, 30)}…»: ${got[i]!.w} ≠ ${textWidth(t)}`);
    assert.deepEqual(got[i]!.lines, wrapLines(t, 140), `перенос «${t.slice(0, 30)}…»`);
    assert.equal(got[i]!.lh, LINE_HEIGHT);
  });
});
