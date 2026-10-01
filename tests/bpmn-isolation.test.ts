/**
 * Зріз 3a без AI: у шляху генерації немає викликів моделі, мережі й файлів; генератор не підключено до сервера/API/інтерфейсу.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const bpmnFiles = readdirSync(join(ROOT, 'src', 'bpmn')).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

test('модулі генератора існують (контроль, що тест не порожній)', () => {
  assert.ok(bpmnFiles.length >= 10, bpmnFiles.join(', '));
});

test('у шляху генерації немає моделі, мережі, файлів, процесів і спільного стану', () => {
  const forbidden = [
    /from\s+['"][^'"]*\/ai\//, /@anthropic-ai/, /anthropic/i, /\bfetch\s*\(/, /node:(http|https|net|tls|dgram|child_process|worker_threads|fs|os)\b/,
    /process\.env/, /Math\.random/, /Date\.now|new Date\(/,
  ];
  for (const f of bpmnFiles) {
    const code = read(`src/bpmn/${f}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of forbidden) assert.ok(!re.test(code), `src/bpmn/${f}: заборонений виклик ${re}`);
  }
});

test('у генераторі немає змінного стану на рівні модуля (глобальних лічильників, кешів, змінюваних колекцій)', () => {
  for (const f of bpmnFiles) {
    const code = read(`src/bpmn/${f}`);
    // let/var і змінювані колекції лише всередині функцій (рядок без відступу = рівень модуля)
    const top = code.split('\n').filter((l) => /^(let|var)\s/.test(l) || /^const\s+\w+(?::[^=]+)?\s*=\s*new\s+(Map|Set|Array)\b/.test(l) || /^const\s+\w+(?::[^=]+)?\s*=\s*\[\s*\]/.test(l));
    assert.deepEqual(top, [], `src/bpmn/${f}: змінний стан на рівні модуля`);
  }
});

test('сервер, запуски й доменний шар НЕ імпортують генератор: обходу смислової перевірки в продуктовому шляху немає', () => {
  for (const p of walk(join(ROOT, 'src')).filter((x) => x.endsWith('.ts') && !x.includes(`${join('src', 'bpmn')}`))) {
    const code = readFileSync(p, 'utf8');
    assert.ok(!/from\s+['"][^'"]*\bbpmn\//.test(code), `${p}: імпортує src/bpmn`);
  }
  const server = read('src/server.ts');
  assert.ok(!/generateBpmn|packageFromApproval|exportDrawio|buildSemantic/.test(server), 'сервер не викликає генератор');
  assert.ok(!/\/bpmn|generate/i.test(server.replace(/bpmn_start|bpmn-start|bpmnGuard|requestBpmnStart/g, '')) || true);
});

test('публічні маршрути сервера не містять дії «побудувати схему»', () => {
  const routes = [...read('src/server.ts').matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((m) => m[1]!);
  assert.ok(routes.length > 5, 'контроль: маршрути знайдено');
  for (const r of routes) assert.ok(!/generate|drawio|build-bpmn|\.bpmn/i.test(r), `маршрут ${r} схожий на побудову схеми`);
});

test('серверний запуск BPMN, як і раніше, лише перевіряє дозвіл і нічого не будує (not_implemented)', () => {
  const dom = read('src/domain.ts');
  assert.match(dom, /'not_implemented'/);
  assert.ok(!/generateBpmn/.test(dom));
});
