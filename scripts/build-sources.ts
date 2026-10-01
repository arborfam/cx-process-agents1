// Розбиває оригінальний пакет на джерела зі стабільними ID і перевіряє, що
// кожен витяг із оригіналу є дослівним фрагментом. Оригінал не змінюється.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'scenarios', 'cx-preparation');
const originalPath = join(root, 'original', 'CX_ASIS_discovery_inputs_draft1.md');
const original = readFileSync(originalPath, 'utf8');
const lines = original.split('\n');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type Entry = {
  id: string; title: string; kind: string; origin: 'synthetic'; stage: number | null;
  provenance: string; lines?: [number, number]; file: string; sha256: string;
};
const manifest: Entry[] = [];
const write = (dir: string, id: string, text: string) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, `${id}.md`), text);
};

const fromOriginal: [string, string, string, number, [number, number], string][] = [
  ['SRC-01', 'Jira-запит', 'jira_ticket', 1, [7, 9], '§1'],
  ['SRC-02', 'Розмова із замовником із CX', 'interview', 1, [13, 19], '§1а'],
  ['SRC-03', 'Розмова з відповідальною за підготовку агентів у CX', 'interview', 2, [23, 49], '§2'],
  ['SRC-04', 'Розмова з представницею команди Growth', 'interview', 3, [53, 63], '§3'],
  ['SRC-05', 'Розмова з представницею команди знижок і комісійних програм', 'interview', 4, [67, 77], '§4'],
  ['SRC-06', 'Розмова з представником команди, що відповідає за реліз', 'interview', 4, [81, 87], '§5'],
  ['SRC-07', 'Відомості із первинного опису проблеми', 'reference_note', 4, [91, 91], '§6'],
];
for (const [id, title, kind, stage, [a, b], section] of fromOriginal) {
  const text = lines.slice(a - 1, b).join('\n').trim() + '\n';
  for (const l of text.split('\n').filter(Boolean)) {
    if (!original.includes(l)) throw new Error(`${id}: рядок не знайдено в оригіналі`);
  }
  if (!original.includes(text.trimEnd())) throw new Error(`${id}: витяг не є суцільним фрагментом оригіналу`);
  write('sources', id, text);
  manifest.push({ id, title, kind, origin: 'synthetic', stage, provenance: `оригінал, ${section}, рядки ${a}–${b}`, lines: [a, b], file: `sources/${id}.md`, sha256: sha(text) });
}

const authored = (n: string) => readFileSync(join(root, 'authored', n), 'utf8');
const common = authored('SRC-08-common.md');
const moved = authored('SRC-08-moved.md');
const A: [string, string, string, number | null, string, string, string][] = [
  ['SRC-00', 'Навчальна межа від аналітика', 'analyst_note', 1, 'додано аналітиком як рамку вправи; не з оригіналу', 'sources', authored('SRC-00.md')],
  ['SRC-08p', 'Синтетичне уточнення (позитивний сценарій)', 'analyst_clarification', 5, 'вигадано для тесту; не з оригіналу', 'sources', common + '\n' + moved],
  ['SRC-08n', 'Синтетичне уточнення (негативний сценарій)', 'analyst_clarification', 5, 'вигадано для тесту; не з оригіналу; без відповіді про перенесення/вилучення', 'sources', common],
  ['SRC-09', 'Явне уточнення про перенесення/вилучення (негативний сценарій)', 'analyst_clarification', null, 'вигадано для тесту; подається лише явною дією аналітика', 'hidden', moved],
];
for (const [id, title, kind, stage, provenance, dir, text] of A) {
  write(dir, id, text);
  manifest.push({ id, title, kind, origin: 'synthetic', stage, provenance, file: `${dir}/${id}.md`, sha256: sha(text) });
}
writeFileSync(join(root, 'manifest.json'), JSON.stringify({
  original: { file: 'original/CX_ASIS_discovery_inputs_draft1.md', sha256: sha(original) },
  sources: manifest,
}, null, 2) + '\n');
console.log(`OK: ${manifest.length} джерел; sha256 оригіналу ${sha(original).slice(0, 12)}…`);
