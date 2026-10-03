/**
 * Наскрізна перевірка КЛЮЧОВОГО ШЛЯХУ продукту на поточному інтерфейсі (D102).
 *
 * Запуск: node --import tsx scripts/verify-key-path.ts
 *
 * Шлях: джерела → аналіз → перегляд і уточнення AS-IS → погодження конкретної версії →
 * агент 2 (таблиця процесу) → програмна перевірка таблиці → скрипти пайплайна (Python + Node) →
 * звірені .bpmn і .drawio → перегляд у bpmn-js і завантаження файлів.
 *
 * Окремо перевіряються три блокування: критична прогалина, застаріле погодження, некоректна таблиця.
 *
 * Обидва агенти — ПІДСТАВНІ клієнти, оголошені в цьому файлі: мережі, ключів і платних викликів немає.
 * Скрипти пайплайна виконуються СПРАВЖНІ (`pipeline/`), тому доказ стосується програми, а не якості AI.
 * База — окрема тимчасова; робочі дані не чіпаються.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { ScriptedDemoClient } from '../src/runs.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { makePolicy } from '../src/ai/budget.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { AnalystInput, ModelCallResult } from '../src/ai/types.ts';
import { scriptedCsv } from '../tests/csv-fixture.ts';

const OUT = 'docs/ux/shots/key-path';
mkdirSync(OUT, { recursive: true });
const CODE = 'key-path';
const R: { n: string; ok: boolean; d: string }[] = [];
const ck = (n: string, ok: boolean, d = '') => { R.push({ n, ok, d }); };
const need = async (loc: { count(): Promise<number> }, n: string) => {
  const c = await loc.count();
  ck(n + ': елемент присутній', c > 0, `знайдено ${c}`);
  return c > 0;
};

/** Чи додавати критичне питання у відповідь агента 1 (для перевірки блокування). */
let withCritical = true;

const analyst = new ScriptedDemoClient((input: AnalystInput) => {
  const refs = input.sources.map((s) => s.id);
  const base = structuredClone(input.head_content);
  base.summary = 'Опис, складений підставним клієнтом за джерелами кейсу.';
  base.business_context = 'Навчальний синтетичний приклад для перевірки ключового шляху.';
  base.boundaries = { trigger: 'Клієнт звернувся', input: 'Звернення', completion: 'Потребу закрито', result: 'Рішення за зверненням' };
  base.roles = ['Оператор', 'Старший спеціаліст'];
  base.steps = [
    { id: 'S1', role: 'Оператор', action: 'Прийняти звернення', entry_condition: 'Надійшло звернення', input_artifact: '', result: 'Звернення зафіксовано', next: [{ to: 'S2', condition: '' }], source_ids: refs },
    { id: 'S2', role: 'Старший спеціаліст', action: 'Ухвалити рішення', entry_condition: 'Звернення зафіксовано', input_artifact: '', result: 'Рішення ухвалено', next: [{ to: 'END', condition: '' }], source_ids: refs },
  ];
  base.claims = []; base.problems = []; base.hypotheses = [];
  base.questions = withCritical
    ? [{
      id: 'Q1', text: 'Чи є окрема гілка повернення звернення на перший рівень?',
      impact: 'Від цього залежить послідовність після ухвалення рішення.', critical: true,
      addressee: 'керівництво підтримки', status: 'open' as const, answer: '', closed_by_source_id: null,
      origin: 'agent' as const, criticality_note: '',
    }]
    : [];
  return base;
});

/** Підставний агент 2. `broken` змушує його видати таблицю, що не відповідає погодженому опису. */
let broken = false;
class ReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ КЛІЄНТ (не AI)';
  async review(input: BpmnReviewInput): Promise<ModelCallResult> {
    const csv = scriptedCsv(input.pkg.content, input.pkg.startLabel);
    // Некоректний результат: у таблиці зʼявляється крок, якого в погодженому описі немає.
    const bad = csv.replace('Task_S2', 'Task_S9');
    return { output: { findings: [], csv: broken ? bad : csv }, usage: { input_tokens: 10, output_tokens: 10 } };
  }
}

const db = openDb(join(mkdtempSync(join(tmpdir(), 'cx-keypath-')), 'cx.sqlite'));
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());
const server = createApp({
  db, mode: 'demo', accessCode: CODE,
  analyst: { client: analyst },
  reviewer: { client: new ReviewClient(), policy, instruction: loadBpmnInstruction() },
});
const app = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }));
});

const errs: string[] = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'uk-UA' });
  const page: Page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errs.push(m.text()); });
  const T = async (sel: string) => {
    const t = await page.locator(sel).first().textContent({ timeout: 4000 }).catch(() => '');
    return (t || '').replace(/\s+/g, ' ').trim();
  };
  const card = async (expr: string) => String(await page.evaluate(
    'fetch("/api/cases/" + state.caseId).then(r => r.json()).then(c => String(' + expr + '))'));
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: false });

  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('#newtitle');

  /* ───── 1. Джерела ───── */
  await page.fill('#newtitle', 'Ключовий шлях (синтетичний)');
  await page.getByRole('button', { name: 'Створити кейс' }).click();
  await page.waitForSelector('#toptabs', { timeout: 15000 });
  const id = String(await page.evaluate('location.hash')).replace('#/case/', '');
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Інтерв’ю з підтримкою (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Оператор приймає звернення. Старший спеціаліст ухвалює рішення.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(900);
  ck('1. джерело додано через інтерфейс', (await T('#main')).includes('Інтерв’ю з підтримкою'));

  /* ───── 2. Аналіз ───── */
  await page.locator('[data-block="analysis"] button').first().click();
  await page.waitForTimeout(2600);
  ck('2. аналіз створив опис', (await card('c.head.content.steps.length')) === '2');

  /* ───── 3. Критична прогалина не дає погодити ───── */
  ck('3. критичне питання блокує погодження', (await card('c.next_action.key')) === 'resolve_blockers', await card('c.next_action.label'));
  const direct = String(await page.evaluate(
    'fetch("/api/cases/" + state.caseId + "/approve/direct", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "cx" }, body: JSON.stringify({ version_id: state.card.head.id, checklist_confirmed: true }) }).then(r => String(r.status))'));
  ck('3. пряме погодження в обхід інтерфейсу теж відхилено', direct === '409', direct);
  await shot('1-критична-прогалина');

  /* ───── 4. Перегляд і уточнення AS-IS через інтерфейс ───── */
  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Питання' }).click();
  await page.waitForTimeout(400);
  const ans = page.locator('#answer-Q1');
  if (await need(ans, '4. поле уточнення')) {
    // Критичне питання можна закрити лише з фактичною підставою: дослівний фрагмент джерела.
    const QUOTE = 'Старший спеціаліст ухвалює рішення';
    await ans.fill(QUOTE);
    const basis = page.locator('[data-form="q-Q1"] [data-block="basis"]');
    await basis.locator('input[value="source"]').check().catch(() => {});
    await page.waitForTimeout(200);
    const sel = page.locator('[data-form="q-Q1"] [data-block="basis"] select').first();
    if ((await sel.locator('option').count()) > 1) await sel.selectOption({ index: 1 });
    await page.waitForTimeout(200);
    await page.locator('[data-form="q-Q1"] [data-block="basis"] textarea').first().fill(QUOTE);
    await page.waitForTimeout(200);
    await page.locator('[data-form="q-Q1"]').getByRole('button', { name: 'Закрити питання уточненням' }).first().click();
    await page.waitForTimeout(1800);
  }
  ck('4. критичне питання закрито уточненням', (await card('c.critical_open_questions.length')) === '0', await card('JSON.stringify(c.critical_open_questions.map(q => q.id))'));

  // Початковий крок і назва процесу — через видиму форму редагування.
  await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click();
  await page.waitForTimeout(400);
  await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
  await page.selectOption('[data-block="edit-inline"] select[name="entry"]', 'S1');
  await page.fill('[data-block="edit-inline"] input[name="process_name"]', 'Опрацювання звернення (синтетичний)');
  await page.getByRole('button', { name: 'Зберегти як нову версію' }).click();
  await page.waitForTimeout(1600);
  ck('4. правки збережено новою версією', Number(await card('c.head.number')) >= 4, await card('c.head.number'));

  /* ───── 5. Погодження конкретної версії ───── */
  const approvedVersion = await card('c.head.id');
  await page.getByRole('tab', { name: 'Огляд' }).click(); await page.waitForTimeout(500);
  ck('5. наступна дія — погодження', /Погодити/.test(await T('#main .rail .next button.primary')), await T('#main .rail .next button.primary'));
  await page.locator('#main .rail .next button.primary').click(); await page.waitForTimeout(800);
  const boxes = page.locator('dialog input[type="checkbox"]');
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
  await page.locator('dialog button.primary').click(); await page.waitForTimeout(1800);
  ck('5. версію погоджено', (await T('#app')).includes('AS-IS погоджено'), await card('c.case.state'));
  ck('5. погодження привʼязане саме до цієї версії', (await card('c.approval && c.approval.version_id')) === approvedVersion);
  await shot('2-погоджено');

  /* ───── 6. Некоректна таблиця агента 2 не проходить перевірку ───── */
  broken = true;
  await page.getByRole('tab', { name: 'Схема' }).click(); await page.waitForTimeout(1200);
  const runBtn = page.locator('#main button').filter({ hasText: /Запустити смислову перевірку/ }).first();
  if (await need(runBtn, '6. дія смислової перевірки')) {
    await runBtn.click();
    for (let i = 0; i < 25 && !/помилка|не прийнято|failed|Запустити смислову перевірку/.test(await T('#main')); i++) await page.waitForTimeout(700);
    await page.waitForTimeout(800);
    const st = String(await page.evaluate('fetch("/api/cases/" + state.caseId + "/bpmn/review").then(r => r.json()).then(x => x.state)'));
    ck('6. некоректна таблиця дає стан «failed»', st === 'failed', st);
    const art = String(await page.evaluate('fetch("/api/cases/" + state.caseId + "/bpmn/artifact").then(r => r.json()).then(x => JSON.stringify([x.can_build, x.artifact]))'));
    ck('6. побудова після некоректної таблиці недоступна', art.startsWith('[false'), art.slice(0, 80));
    const force = String(await page.evaluate(
      'fetch("/api/cases/" + state.caseId + "/bpmn/build", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "cx" }, body: "{}" }).then(r => String(r.status))'));
    ck('6. пряма побудова в обхід інтерфейсу відхилена', force === '409', force);
    await shot('3-некоректна-таблиця');
  }

  /* ───── 7. Коректна таблиця → скрипти пайплайна → звірені файли ───── */
  broken = false;
  await page.reload(); await page.waitForSelector('#toptabs');
  await page.getByRole('tab', { name: 'Схема' }).click(); await page.waitForTimeout(1200);
  const again = page.locator('#main button').filter({ hasText: /смислову перевірку/ }).first();
  if (await need(again, '7. повторний запуск перевірки')) {
    await again.click();
    for (let i = 0; i < 30 && !/Побудувати схему/.test(await T('#main')); i++) await page.waitForTimeout(700);
    ck('7. перевірка пройдена, побудова дозволена', /Побудувати схему/.test(await T('#main')), (await T('#main')).slice(0, 120));
    await page.locator('#main button').filter({ hasText: 'Побудувати схему' }).first().click();
    for (let i = 0; i < 40 && !/Схему побудовано|готова|\.bpmn/.test(await T('#main')); i++) await page.waitForTimeout(700);
    await page.waitForTimeout(1200);
    const a = String(await page.evaluate('fetch("/api/cases/" + state.caseId + "/bpmn/artifact").then(r => r.json()).then(x => JSON.stringify({ s: x.artifact && x.artifact.status, cur: x.artifact && x.artifact.current }))'));
    ck('7. схему побудовано справжніми скриптами пайплайна', /"s":"ok"/.test(a) && /"cur":true/.test(a), a);
    await shot('4-схема-побудована');
    /* ───── 8. Перегляд і завантаження ───── */
    await need(page.locator('.djs-container, [data-block="diagram"] svg, #main svg'), '8. схема показана переглядачем');
    for (const kind of ['bpmn', 'drawio', 'csv']) {
      const st = String(await page.evaluate('fetch("/api/cases/" + state.caseId + "/bpmn/file/' + kind + '").then(r => String(r.status))'));
      ck(`8. файл ${kind} доступний для завантаження`, st === '200', st);
    }
  }

  /* ───── 9. Застаріле погодження не дозволяє видавати схему як чинну ───── */
  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click();
  await page.waitForTimeout(400);
  await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
  await page.fill('[data-block="edit-inline"] textarea[name="summary"]', 'Опис змінено після погодження (перевірка застарівання).');
  await page.getByRole('button', { name: 'Зберегти як нову версію' }).click();
  await page.waitForTimeout(1600);
  ck('9. правка після погодження повертає кейс до дослідження', (await card('c.case.state')) === 'research', await card('c.case.state'));
  ck('9. чинного погодження більше немає', (await card('c.approval ? "є" : "немає"')) === 'немає');
  const stale = String(await page.evaluate('fetch("/api/cases/" + state.caseId + "/bpmn/artifact").then(r => r.json()).then(x => JSON.stringify({ cur: x.artifact && x.artifact.current, status: x.artifact && x.artifact.status, can: x.can_build }))'));
  ck('9. побудована схема більше не видається як чинна', /"cur":false/.test(stale) || /"can":false/.test(stale), stale);
  const file = String(await page.evaluate('fetch("/api/cases/" + state.caseId + "/bpmn/file/bpmn").then(r => String(r.status))'));
  ck('9. файл застарілої схеми не віддається на прямий запит', file !== '200', file);
  await shot('5-застаріле-погодження');

  await ctx.close();
} finally {
  await browser.close(); await app.stop(); db.close();
}
const failed = R.filter((x) => !x.ok);
console.log(JSON.stringify({ failed, passed: R.length - failed.length, total: R.length, errors: [...new Set(errs)].slice(0, 6) }, null, 1));
if (failed.length || errs.length) process.exitCode = 1;
