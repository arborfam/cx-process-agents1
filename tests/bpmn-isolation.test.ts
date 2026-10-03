/**
 * Інваріант «обходу смислової перевірки немає» — структурно, а не на довіру.
 *
 * Після D87 схему будує ланцюг скриптів власниці (`pipeline/`), запущений із `src/pipeline/run.ts`,
 * а `src/bpmn/` і `src/csv/` лишилися ПЕРЕВІРКАМИ (розбір XML, аналіз пакета, звірка таблиці). Тому інваріант
 * сформульовано навколо запуску пайплайна:
 *  • `src/pipeline/run.ts` (єдине місце, де виконуються скрипти) імпортує РІВНО ОДИН модуль — `src/bpmn-artifacts.ts`;
 *  • цей модуль обов'язково викликає `generationGate` й серверний дозвіл ДО запуску скриптів;
 *  • сервер, доменний шар і запуски схему самі не будують;
 *  • у перевірках (`src/bpmn/`, `src/csv/`) немає моделі, мережі, файлів і змінного стану на рівні модуля.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const bpmnFiles = readdirSync(join(ROOT, 'src', 'bpmn')).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const GEN_DIR = join(ROOT, 'src', 'bpmn') + sep;
/** Усі файли `src/`, КРІМ самого генератора. `src/bpmn-artifacts.ts` сюди входить: він не в теці генератора. */
const srcOutsideGenerator = (): string[] => walk(join(ROOT, 'src')).filter((x) => x.endsWith('.ts') && !x.startsWith(GEN_DIR));

/** Єдиний модуль, якому дозволено ЗАПУСКАТИ побудову. Зміна цього списку — зміна інваріанта. */
const ALLOWED_IMPORTER = 'src/bpmn-artifacts.ts';

/**
 * Хто може імпортувати перевірки `src/bpmn/` (розбір XML, аналіз пакета, межі тексту). Це вже не генератор:
 * після D87 схему будують скрипти, а ці модулі лише читають і звіряють. Кожен запис тут — свідоме рішення.
 */
const ALLOWED_CHECK_IMPORTERS = [
  'src/bpmn-artifacts.ts',        // шлюзований модуль побудови
  'src/csv/check.ts',             // звірка таблиці з погодженим описом (ID, межі тексту, типи)
  'src/pipeline/verify.ts',       // зворотна звірка .bpmn
  'src/pipeline/verify-drawio.ts',// зворотна звірка .drawio
  'src/pipeline/drawio-style.ts', // еталонний контракт вигляду .drawio
  'src/ai/bpmn-review.ts',        // перевірка відповіді агента 2 (та сама звірка таблиці)
  'src/start-label.ts',           // межа довжини підпису події (D88)
  'src/pipeline/scripts.ts',      // назва ланцюга побудови (GENERATOR_NAME) — спільний контракт ID
];

test('модулі генератора існують (контроль, що тест не порожній)', () => {
  assert.ok(bpmnFiles.length >= 10, bpmnFiles.join(', '));
});

test('у перевірках схеми й таблиці немає моделі, мережі, файлів, процесів і спільного стану', () => {
  const forbidden = [
    /from\s+['"][^'"]*\/ai\//, /@anthropic-ai/, /anthropic/i, /\bfetch\s*\(/, /node:(http|https|net|tls|dgram|child_process|worker_threads|fs|os)\b/,
    /process\.env/, /Math\.random/, /Date\.now|new Date\(/,
  ];
  const files = [...bpmnFiles.map((f) => `src/bpmn/${f}`), ...readdirSync(join(ROOT, 'src', 'csv')).map((f) => `src/csv/${f}`)];
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of forbidden) assert.ok(!re.test(code), `${f}: заборонений виклик ${re}`);
  }
});

test('у генераторі немає змінного стану на рівні модуля (глобальних лічильників, кешів, змінюваних колекцій)', () => {
  for (const f of bpmnFiles) {
    const code = read(`src/bpmn/${f}`);
    const top = code.split('\n').filter((l) => /^(let|var)\s/.test(l) || /^const\s+\w+(?::[^=]+)?\s*=\s*new\s+(Map|Set|Array)\b/.test(l) || /^const\s+\w+(?::[^=]+)?\s*=\s*\[\s*\]/.test(l));
    assert.deepEqual(top, [], `src/bpmn/${f}: змінний стан на рівні модуля`);
  }
});

test('запуск пайплайна доступний рівно одному модулю — шлюзованому src/bpmn-artifacts.ts', () => {
  const importers: string[] = [];
  for (const p of walk(join(ROOT, 'src')).filter((x) => x.endsWith('.ts'))) {
    const rel = relative(ROOT, p).split(sep).join('/');
    if (rel === 'src/pipeline/run.ts') continue;
    if (/from\s+['"][^'"]*pipeline\/run\.ts['"]/.test(readFileSync(p, 'utf8'))) importers.push(rel);
  }
  assert.deepEqual(importers, [ALLOWED_IMPORTER], `пайплайн має запускати лише ${ALLOWED_IMPORTER}; знайдено: ${importers.join(', ')}`);
});

test('перевірки src/bpmn імпортують лише свідомо дозволені модулі', () => {
  const importers: string[] = [];
  for (const p of srcOutsideGenerator()) {
    const code = readFileSync(p, 'utf8');
    if (/from\s+['"][^'"]*\bbpmn\/[^'"]+['"]/.test(code)) importers.push(relative(ROOT, p).split(sep).join('/'));
  }
  assert.deepEqual(importers.sort(), [...ALLOWED_CHECK_IMPORTERS].sort(), `додайте новий модуль у перелік свідомо; знайдено: ${importers.join(', ')}`);
});

test('шлюзований модуль не може згенерувати схему, не пройшовши перевірку: шлюз і дозвіл викликаються до генератора', () => {
  const code = read(ALLOWED_IMPORTER);
  // Шлюз береться з модуля перевірки й застосовується через buildPreflight; дозвіл і актуальність — там же.
  assert.match(code, /generationGate/, 'модуль має використовувати generationGate');
  assert.match(code, /bpmnGuard/, 'модуль має перевіряти серверний дозвіл');
  assert.match(code, /staleReasons/, 'модуль має перевіряти актуальність');
  assert.match(code, /getCaseReview/, 'модуль має відновлювати перевірку з довіреного запису');
  // Генерація викликається лише після buildPreflight: позиція в коді — груба, але дієва перевірка порядку.
  const gatePos = code.indexOf('review.gate?.ok');
  const genPos = code.indexOf('await buildThroughPipeline(pre');
  assert.ok(gatePos > 0 && genPos > gatePos, 'побудова має викликатися після перевірки шлюзу');
  // Таблиця береться з ПРИЙНЯТОЇ відповіді агента; своєї таблиці модуль не складає (див. no-csv-generator.test.ts).
  assert.match(code, /checkCsv/, 'модуль має перевіряти таблицю проти погодженого опису');
  // Другий шлюз — у транзакції перед збереженням.
  assert.ok(code.indexOf('buildPreflight(db, caseId, instruction)', genPos) > genPos, 'перед збереженням перевірки мають повторитися');
  // Клієнта моделі в цьому шляху немає: ні конфігурації режиму, ні клієнта Anthropic, ні виклику .review()/.analyze().
  assert.ok(!/MODEL_MODE|anthropic|AnalystClient|BpmnReviewClient/i.test(code), 'у шляху побудови немає клієнта моделі');
  assert.ok(!/\.(review|analyze)\s*\(/.test(code), 'у шляху побудови немає виклику моделі');
  assert.ok(!/from\s+['"]\.\/ai\/anthropic/.test(code), 'у шляху побудови немає імпорту клієнта Anthropic');
});

test('сервер і доменний шар генератор не імпортують і схему не будують самі', () => {
  for (const f of ['src/server.ts', 'src/domain.ts', 'src/runs.ts', 'src/review-runs.ts']) {
    const code = read(f);
    assert.ok(!/from\s+['"][^'"]*\bbpmn\/[^'"]+['"]/.test(code), `${f}: імпортує src/bpmn`);
    assert.ok(!/buildThroughPipeline|runPipeline|packageFromApproval/.test(code), `${f}: будує схему напряму`);
  }
});

test('усі маршрути, що видають схему чи файли, проходять через шлюзований модуль', () => {
  const server = read('src/server.ts');
  // Сервер може звертатися лише до функцій шлюзованого модуля.
  // `technicalLimits` додано свідомо (D86): воно лише ЧИТАЄ — повертає технічні обмеження пакета (той самий
  // розбір, що й на початку побудови), не генерує схеми, не створює файлів і нічого не дозволяє.
  const allowed = ['buildArtifact', 'getCaseArtifact', 'listCaseArtifacts', 'getArtifactById', 'readArtifactFile', 'readArtifactCsv', 'buildPreflight', 'technicalLimits', 'ArtifactView'];
  const imported = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/bpmn-artifacts\.ts['"]/.exec(server);
  assert.ok(imported, 'сервер має імпортувати шлюзований модуль іменовано');
  for (const name of imported![1]!.split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean)) {
    assert.ok(allowed.includes(name), `сервер імпортує ${name} зі шлюзованого модуля — додайте його у перелік свідомо`);
  }
});

test('у продукті немає перемикача, маршруту чи прапорця «без смислової перевірки»', () => {
  for (const p of walk(join(ROOT, 'src')).filter((x) => x.endsWith('.ts'))) {
    const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of [/skipReview/i, /skip_review/i, /noReview/i, /force(Build|Generate)/i, /bypass/i, /without[_-]?review/i]) {
      assert.ok(!re.test(code), `${relative(ROOT, p)}: схоже на обхід перевірки (${re})`);
    }
  }
  const routes = [...read('src/server.ts').matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((m) => m[1]!);
  assert.ok(routes.length > 5, 'контроль: маршрути знайдено');
  for (const r of routes) assert.ok(!/force|skip|bypass|nocheck/i.test(r), `маршрут ${r} схожий на обхід`);
});

test('підставного клієнта агента 2 у продукті немає (він лише в тестах)', () => {
  for (const p of walk(join(ROOT, 'src')).filter((x) => x.endsWith('.ts'))) {
    const code = readFileSync(p, 'utf8');
    assert.ok(!/FakeReviewClient|ScriptedReviewClient/.test(code), `${relative(ROOT, p)}: підставний клієнт агента 2 у src/`);
  }
});
