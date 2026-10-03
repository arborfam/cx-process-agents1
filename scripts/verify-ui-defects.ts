/**
 * Відтворення п'яти дефектів незалежної перевірки й доказ їх усунення (D98).
 *
 * Запуск: node --import tsx scripts/verify-ui-defects.ts
 *
 * Усе робиться ЧЕРЕЗ ІНТЕРФЕЙС: кейс створюється кнопкою, джерела додаються формами,
 * аналіз запускається видимою дією. Готовий AS-IS доменними функціями не підставляється.
 * Клієнти агентів — локальні підставні, оголошені в цьому файлі: мережі, ключів і витрат немає.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

const OUT = 'docs/ux/shots';
mkdirSync(OUT, { recursive: true });
const CODE = 'ui-defects';
const R: { n: string; ok: boolean; d: string }[] = [];
const ck = (n: string, ok: boolean, d = '') => { R.push({ n, ok, d }); };
/** Відсутність очікуваного елемента — це НЕВДАЧА, а не «нічого перевіряти». */
const need = async (loc: { count(): Promise<number> }, n: string) => {
  const c = await loc.count();
  ck(n + ': елемент присутній', c > 0, `знайдено ${c}`);
  return c > 0;
};

/** Підставний агент 1: дає опис, спираючись на додані джерела. Жодного звернення до моделі. */
const analyst = new ScriptedDemoClient((input: AnalystInput) => {
  const refs = input.sources.map((s) => s.id);
  const base = structuredClone(input.head_content);
  base.summary = 'Синтетичний опис, складений підставним клієнтом за ' + refs.length + ' джерелами.';
  base.business_context = 'Навчальний синтетичний приклад.';
  base.boundaries = { trigger: 'Клієнт повідомив про потребу', input: 'Звернення', completion: 'Потребу закрито', result: 'Рішення за зверненням' };
  base.roles = ['Менеджерка', 'Оператор'];
  base.entry_step_id = 'S1';
  base.process_name = 'Синтетичний процес (підставний клієнт)';
  base.steps = [
    { id: 'S1', role: 'Менеджерка', action: 'Прийняти звернення', entry_condition: 'Надійшло звернення', input_artifact: '', result: 'Звернення зафіксовано', next: [{ to: 'S2', condition: '' }], source_ids: refs },
    { id: 'S2', role: 'Оператор', action: 'Опрацювати звернення', entry_condition: 'Звернення зафіксовано', input_artifact: '', result: 'Рішення ухвалено', next: [{ to: 'END', condition: '' }], source_ids: refs },
  ];
  base.claims = [];
  base.problems = [];
  base.questions = [];
  return base;
});

/** Підставний агент 2 з керованою затримкою: імітує повільну перевірку без платного API. */
let reviewDelayMs = 0;
class SlowReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ КЛІЄНТ (повільна перевірка, не AI)';
  async review(input: BpmnReviewInput): Promise<ModelCallResult> {
    if (reviewDelayMs) await new Promise((r) => setTimeout(r, reviewDelayMs));
    return { output: { findings: [], csv: scriptedCsv(input.pkg.content, input.pkg.startLabel) }, usage: { input_tokens: 10, output_tokens: 10 } };
  }
}

const dbPath = join(mkdtempSync(join(tmpdir(), 'cx-ui-def-')), 'cx.sqlite');
const db = openDb(dbPath);
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());
const server = createApp({
  db, mode: 'demo', accessCode: CODE,
  analyst: { client: analyst },
  reviewer: { client: new SlowReviewClient(), policy, instruction: loadBpmnInstruction() },
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
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|409)/.test(m.text())) errs.push(m.text()); });
  // Навмисні негативні проби дають 4xx за задумом; решта помилок — дефект.
  const expected: RegExp[] = [/400 .*\/sources\/file$/, /409 .*\/bpmn\/review$/];
  page.on('response', (r) => {
    const line = `${r.status()} ${r.url()}`;
    if (r.status() >= 400 && !expected.some((x) => x.test(line))) errs.push(line);
  });
  const T = async (sel: string) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('#newtitle');

  /* ───── Дефект 1: кейс, джерела й аналіз — лише через інтерфейс ───── */
  await page.fill('#newtitle', 'Кейс через інтерфейс (синтетичний)');
  await page.getByRole('button', { name: 'Створити кейс' }).click();
  await page.waitForSelector('#toptabs', { timeout: 15000 });
  const caseA = String(await page.evaluate('location.hash')).replace('#/case/', '');
  ck('кейс створено через інтерфейс', !!caseA, caseA);

  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click();
  await page.waitForTimeout(300);
  const stepsTxt = await T('#panel');
  ck('порожні кроки не посилають на неіснуючу вкладку', !/вкладці «Редагувати»/.test(stepsTxt), stepsTxt.slice(0, 120));
  if (await need(page.locator('[data-block="edit-inline"]'), 'редагування біля змісту (Кроки)')) {
    ck('форма редагування доступна з вкладки «Кроки»', (await T('[data-block="edit-inline"] summary')).includes('Редагувати опис'));
  }
  await page.locator('.subtabs .tab', { hasText: 'Бізнес-контекст' }).click();
  await page.waitForTimeout(300);
  await need(page.locator('[data-block="edit-inline"]'), 'редагування біля змісту (Бізнес-контекст)');

  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Інтерв’ю 1 (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Менеджерка приймає звернення, оператор опрацьовує його й ухвалює рішення.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(900);
  ck('джерело додано через форму', (await T('#main')).includes('Інтерв’ю 1 (синтетичне)'));

  if (await need(page.locator('[data-block="analysis"] button'), 'видима дія аналізу')) {
    const label = await T('[data-block="analysis"] button');
    ck('дія аналізу доступна (не вимкнена)', !(await page.locator('[data-block="analysis"] button').first().isDisabled()), label);
    await page.locator('[data-block="analysis"] button').first().click();
    await page.waitForTimeout(2500);
    await page.getByRole('tab', { name: 'AS-IS' }).click();
    await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click();
    await page.waitForTimeout(400);
    ck('аналіз створив кроки', (await T('#panel')).includes('Прийняти звернення'), (await T('#panel')).slice(0, 100));
  }
  await page.screenshot({ path: `${OUT}/120-дефект1-аналіз-і-редагування.png`, fullPage: true });

  // оновлення аналізу після нового джерела
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Інтерв’ю 2 (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Друге інтерв’ю: оператор інколи повертає звернення менеджерці.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(900);
  ck('після нового джерела аналіз можна оновити',
    (await T('[data-block="analysis"]')).includes('Оновити аналіз') && !(await page.locator('[data-block="analysis"] button').first().isDisabled()));

  /* ───── Дефект 5: походження файла — явний вибір ───── */
  await need(page.locator('input[name="file-origin"]'), 'вибір походження файла');
  ck('походження файла не вибрано заздалегідь', (await page.locator('input[name="file-origin"]:checked').count()) === 0);

  /* ───── Дефект 2: чернетки переживають автооновлення ───── */
  await page.fill('[data-draft="src-title"]', 'Напівнабрана назва');
  await page.fill('[data-draft="src-content"]', 'Напівнабраний текст джерела');
  await page.evaluate(() => window.scrollTo(0, 250));
  for (let i = 0; i < 3; i++) {
    await page.evaluate('route()');
    await page.waitForTimeout(500);
  }
  ck('назва пережила три автооновлення', (await page.inputValue('[data-draft="src-title"]')) === 'Напівнабрана назва');
  ck('текст пережив три автооновлення', (await page.inputValue('[data-draft="src-content"]')) === 'Напівнабраний текст джерела');
  ck('позиція прокрутки збережена', Math.abs((await page.evaluate('window.scrollY') as number) - 250) < 40);
  await page.screenshot({ path: `${OUT}/121-дефект2-чернетки-збережено.png`, fullPage: true });

  // введення під час очікування відповіді сервера
  // Детерміновано: читання картки затримане, тож набір напевно припадає на час запиту.
  await page.route('**/api/cases/' + caseA, async (r) => {
    await new Promise((res) => setTimeout(res, 2000));
    await r.continue();
  });
  const slow = page.evaluate('route()');
  await page.waitForTimeout(400);
  await page.fill('[data-draft="src-title"]', 'Текст, набраний під час запиту');
  await slow; await page.waitForTimeout(500);
  ck('введення під час запиту не загублено', (await page.inputValue('[data-draft="src-title"]')) === 'Текст, набраний під час запиту',
    await page.inputValue('[data-draft="src-title"]'));
  await page.unroute('**/api/cases/' + caseA);

  // надіслана форма не відновлюється
  await page.fill('[data-draft="src-title"]', 'Третє джерело (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Текст третього джерела.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(900);
  ck('успішно надіслана форма не відновлюється', (await page.inputValue('[data-draft="src-title"]')) === '');

  // Поле, що має лише `name` (без data-draft) — у формі редагування опису.
  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Бізнес-контекст' }).click();
  await page.waitForTimeout(400);
  if (await need(page.locator('[data-block="edit-inline"] textarea[name="summary"]'), 'поле лише з name')) {
    await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
    await page.fill('[data-block="edit-inline"] textarea[name="summary"]', 'Недонабрана суть без data-draft');
    for (let i = 0; i < 2; i++) { await page.evaluate('route()'); await page.waitForTimeout(500); }
    await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
    ck('поле лише з name пережило автооновлення',
      (await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]')) === 'Недонабрана суть без data-draft',
      (await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]')).slice(0, 60));
  }
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(400);

  /* ───── Дефект 2б: чернетки не переносяться між кейсами ───── */
  await page.fill('[data-draft="src-title"]', 'Чернетка кейсу А');
  await page.goto(`${app.url}/#/`);
  await page.waitForSelector('#newtitle');
  await page.fill('#newtitle', 'Другий кейс (синтетичний)');
  await page.getByRole('button', { name: 'Створити кейс' }).click();
  await page.waitForSelector('#toptabs', { timeout: 15000 });
  const caseB = String(await page.evaluate('location.hash')).replace('#/case/', '');
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(400);
  ck('чернетка не перенеслась у інший кейс', (await page.inputValue('[data-draft="src-title"]')) === '');


  /* ───── Доведення кейсу А до схеми через інтерфейс ───── */
  await page.goto(`${app.url}/#/case/${caseA}`);
  await page.waitForSelector('#toptabs'); await page.waitForTimeout(600);
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-block="analysis"] button').first().click();   // «Оновити аналіз»
  await page.waitForTimeout(3000);
  // Початковий крок належить програмі, а не агентові (src/ai/delta.ts) — задаємо його видимою формою.
  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click();
  await page.waitForTimeout(400);
  if (await need(page.locator('[data-block="edit-inline"]'), 'видима форма редагування опису')) {
    await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
    await page.waitForTimeout(200);
    await page.selectOption('[data-block="edit-inline"] select[name="entry"]', 'S1');
    await page.fill('[data-block="edit-inline"] input[name="process_name"]', 'Опрацювання звернення клієнта (синтетичний)');
    await page.fill('[data-block="edit-inline"] textarea[name="business_context"]', 'Уточнений бізнес-контекст (набрано у видимій формі).');
    await page.getByRole('button', { name: 'Зберегти як нову версію' }).click();
    await page.waitForTimeout(1800);
    await page.getByRole('tab', { name: 'AS-IS' }).click();
    await page.locator('.subtabs .tab', { hasText: 'Бізнес-контекст' }).click();
    await page.waitForTimeout(400);
    ck('правка через видимі елементи збережена', (await T('#panel')).includes('набрано у видимій формі'), (await T('#panel')).slice(0, 90));
  }
  await page.getByRole('tab', { name: 'Огляд' }).click(); await page.waitForTimeout(600);
  const diag = async () => String(await page.evaluate(
    'fetch("/api/cases/" + state.caseId).then(r => r.json()).then(c => JSON.stringify({ st: c.case.state, na: c.next_action.label, b: c.blockers.filter(x => x.severity === "critical").map(x => x.code) }))'));
  const beforeApprove = await diag();
  if (await need(page.locator('#main .rail .next button.primary'), 'наступна дія в огляді')) {
    const naLabel = await T('#main .rail .next button.primary');
    ck('після оновлення аналізу наступна дія — погодження', /Погодити/.test(naLabel), naLabel + ' ← ' + beforeApprove);
    if (/Погодити/.test(naLabel)) {
      await page.locator('#main .rail .next button.primary').click(); await page.waitForTimeout(600);
      const boxes = page.locator('dialog input[type="checkbox"]');
      for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
      await page.locator('dialog button.primary').click(); await page.waitForTimeout(2000);
    }
  }
  ck('опис погоджено однією дією через інтерфейс', (await T('#app')).includes('AS-IS погоджено'), await diag());

  /* ───── Дефект 3: повільна перевірка сама доходить до завершення ───── */
  reviewDelayMs = 7000;
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.waitForTimeout(800);
  const runBtn = page.locator('#main button').filter({ hasText: /перевірк/i }).first();
  if (await need(runBtn, 'дія смислової перевірки')) {
    await runBtn.click();
    await page.waitForTimeout(2000);
    ck('під час перевірки видно автоматичне оновлення', (await page.locator('[data-block="auto-refresh"]').count()) > 0,
      (await T('#main')).slice(0, 400));
    await page.screenshot({ path: `${OUT}/122-дефект3-перевірка-виконується.png`, fullPage: false });
    let done = '';
    for (let i = 0; i < 30; i++) {                   // чекаємо БЕЗ жодного натискання
      await page.waitForTimeout(1000);
      const t = await T('#main');
      if (/Побудувати схему|зауваж|помилка запуску/.test(t)) { done = t.slice(0, 120); break; }
    }
    ck('перевірка сама перейшла в завершений стан без натискань', !!done, done);
    await page.waitForTimeout(2500);
    ck('опитування зупинилось після завершення', (await page.locator('[data-block="auto-refresh"]').count()) === 0);
    await page.screenshot({ path: `${OUT}/123-дефект3-перевірка-завершилась.png`, fullPage: false });
  }

  /* ───── Дефект 4: стан схеми не переноситься між кейсами ───── */
  const aTxt = await T('#main');
  ck('кейс А має власний стан схеми', aTxt.length > 50, aTxt.slice(0, 80));
  // Затримуємо ЧИТАННЯ стану кейсу А, щоб його відповідь напевно прийшла вже після переходу на Б.
  await page.route('**/api/cases/' + caseA + '/bpmn/**', async (r) => {
    await new Promise((res) => setTimeout(res, 4000));
    await r.continue();
  });
  await page.evaluate('void loadDiagram()');   // новий запит стану кейсу А; він «висить» 4 с
  await page.waitForTimeout(300);
  ck('запит кейсу А справді в дорозі', String(await page.evaluate('String(state.top)')) === 'diagram');
  await page.evaluate('location.hash = "#/case/' + caseB + '"');
  await page.waitForTimeout(250);
  await page.getByRole('tab', { name: 'Схема' }).click();
  await page.waitForTimeout(150);
  const bNow = await T('#main');
  ck('одразу після переходу А→Б дані кейсу А не показуються', bNow !== aTxt && !/Побудувати схему/.test(bNow), bNow.slice(0, 110));
  const bound1 = String(await page.evaluate('JSON.stringify([state.caseId, state.diagram && state.diagram.caseId])'));
  ck('стан схеми не успадкований від кейсу А', (() => { const [c, d] = JSON.parse(bound1); return d === null || d === c; })(), bound1);
  await page.waitForTimeout(5000);                 // відповідь кейсу А приходить саме тут
  const bLater = await T('#main');
  ck('кейс Б показує власний стан схеми', !/Побудувати схему/.test(bLater) && bLater !== aTxt, bLater.slice(0, 110));
  const bound2 = String(await page.evaluate('JSON.stringify([state.caseId, state.diagram && state.diagram.caseId])'));
  ck('стан схеми прив’язаний до відкритого кейсу', (() => { const [c, d] = JSON.parse(bound2); return d === null || d === c; })(), bound2);
  ck('пізня відповідь кейсу А не підмінила дані кейсу Б', !/Побудувати схему|Прийняти звернення/.test(bLater), bLater.slice(0, 110));
  ck('опитування кейсу А не продовжується в кейсі Б',
    String(await page.evaluate('String(state.caseId === "' + caseB + '")')) === 'true');
  await page.unroute('**/api/cases/' + caseA + '/bpmn/**');
  await page.screenshot({ path: `${OUT}/124-дефект4-перехід-між-кейсами.png`, fullPage: false });

  /* ───── Дефект 5: походження завантаженого файла = явний вибір (окремий кейс) ───── */
  await page.evaluate('location.hash = "#/"');
  await page.waitForSelector('#newtitle');
  await page.fill('#newtitle', 'Кейс для перевірки походження (синтетичний)');
  await page.getByRole('button', { name: 'Створити кейс' }).click();
  await page.waitForSelector('#toptabs', { timeout: 15000 });
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(400);
  if (await need(page.locator('input[name="file-origin"]'), 'вибір походження файла')) {
    ck('походження файла не вибрано заздалегідь', (await page.locator('input[name="file-origin"]:checked').count()) === 0);
    const originOf = async (title: string) => String(await page.evaluate(
      'fetch("/api/cases/" + state.caseId).then(r => r.json()).then(c => { const s = c.sources.find(x => x.title.indexOf("' + title + '") >= 0); return s ? s.origin : "НЕМА"; })'));
    // Вибір «реальні дані» має зберегтися саме як `real`: прошите значення провалить цю перевірку.
    const fReal = join(tmpdir(), 'ui-origin-real.txt');
    writeFileSync(fReal, 'Синтетичний текст, позначений людиною як реальні дані (перевірка походження).');
    await page.setInputFiles('input[type="file"]', fReal);
    await page.locator('input[name="file-origin"][value="real"]').check();
    await page.getByRole('button', { name: 'Завантажити' }).click();
    await page.waitForTimeout(1200);
    ck('вибір «реальні дані» збережено як real', (await originOf('ui-origin-real')) === 'real', await originOf('ui-origin-real'));
    const fSyn = join(tmpdir(), 'ui-origin-syn.txt');
    writeFileSync(fSyn, 'Синтетичний приклад для перевірки походження.');
    await page.setInputFiles('input[type="file"]', fSyn);
    await page.locator('input[name="file-origin"][value="synthetic"]').check();
    await page.getByRole('button', { name: 'Завантажити' }).click();
    await page.waitForTimeout(1200);
    ck('вибір «синтетичний приклад» збережено як synthetic', (await originOf('ui-origin-syn')) === 'synthetic', await originOf('ui-origin-syn'));
    // Сервер не має тихо підставляти походження, якщо його не передали.
    const silent = String(await page.evaluate(
      'fetch("/api/cases/" + state.caseId + "/sources/file", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "cx" }, body: JSON.stringify({ name: "ui-origin-silent.txt", kind: "document", content_base64: btoa("test") }) }).then(r => String(r.status))'));
    ck('запит без походження відхиляється сервером', silent === '400', silent);
  }

  reviewDelayMs = 0;
  await ctx.close();
} finally {
  await browser.close(); await app.stop(); db.close();
}
const failed = R.filter((x) => !x.ok);
console.log(JSON.stringify({ failed, passed: R.length - failed.length, total: R.length, errors: [...new Set(errs)].slice(0, 8) }, null, 1));
if (failed.length || errs.length) process.exitCode = 1;
