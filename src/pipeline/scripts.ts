/**
 * Реєстр скриптів пайплайна власниці (робоча копія) і їхня версія.
 *
 * Еталонні оригінали лежать у `reference/bpmn-pipeline/original/` і НЕ виконуються й не змінюються.
 * Продукт виконує робочу копію в `pipeline/`; усі відмінності перелічені в `pipeline/DIFFERENCES.md`
 * (тест `pipeline-copy.test.ts` стежить, щоб перелік відмінностей не розходився з файлами).
 *
 * `pipelineVersion` — хеш змісту всіх кроків разом. Він зберігається поруч із прийнятою таблицею, тому
 * видно, якою саме версією скриптів побудовано конкретний файл.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../hash.ts';

export const PIPELINE_DIR = join(import.meta.dirname, '..', '..', 'pipeline');
export const ORIGINAL_DIR = join(import.meta.dirname, '..', '..', 'reference', 'bpmn-pipeline', 'original');

/** Кроки ланцюга в порядку виконання. */
export const PIPELINE_STEPS = [
  { name: 'table_to_bpmn.py', runner: 'python' as const, title: 'таблиця → BPMN' },
  { name: 'layout_step.mjs', runner: 'node' as const, title: 'розкладка (bpmn-auto-layout)' },
  { name: 'fix_labels.py', runner: 'python' as const, title: 'розміри й розташування підписів' },
  { name: 'bpmn_di_to_drawio.py', runner: 'python' as const, title: 'BPMN → draw.io' },
];

export const scriptPath = (name: string): string => join(PIPELINE_DIR, name);

export function scriptHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of PIPELINE_STEPS) out[s.name] = sha256(readFileSync(scriptPath(s.name), 'utf8'));
  return out;
}

/** Версія ланцюга: хеш від переліку «ім'я → хеш». Змінився будь-який крок — змінилась версія. */
export function pipelineVersion(): string {
  return sha256(JSON.stringify(scriptHashes())).slice(0, 16);
}

export { GENERATOR_NAME } from '../bpmn/ids.ts';
