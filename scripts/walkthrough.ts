/**
 * Проходить сценарій демо у справжньому браузері (Chromium) і знімає екрани в docs/demo/.
 * Запуск: npx tsx scripts/walkthrough.ts
 * Дані синтетичні; база тимчасова; жодних викликів моделі.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';

const OUT = 'docs/demo';
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cx-walk-'));
const env = { ...process.env, MODEL_MODE: 'demo', PORT: '0', CX_DB_PATH: join(dir, 'cx.sqlite'), CX_ACCESS_CODE: 'walk-code' };

function startApp(): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--seed-demo'], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); const m = /http:\/\/localhost:(\d+)\//.exec(out); if (m) resolve({ url: `http://localhost:${m[1]}`, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); }) }); });
    child.stderr.on('data', (d) => { out += String(d); });
    setTimeout(() => reject(new Error('не стартував: ' + out)), 20000);
  });
}

async function shot(page: Page, name: string, full = true) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('знімок', name);
}
const tab = (page: Page, label: string) => page.getByRole('tab', { name: new RegExp(label) }).click();

const app = await startApp();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=walk-code`);
  await page.waitForSelector('text=Кейси');
  await shot(page, '01-список-кейсів');

  await page.getByRole('link', { name: /ДЕМО: Зміна умов/ }).click();
  await page.waitForSelector('text=Критичні прогалини');
  // ── перевірка структури картки (не лише знімок) ──
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-block]')].map((e) => (e as HTMLElement).dataset.block));
  assert.deepEqual(order, ['essence', 'asis', 'gaps', 'changes', 'review'], 'порядок блоків: Суть → опис AS-IS → прогалини й дія → зміни → перевірки');
  const tabNames = await page.locator('[role=tab]').allInnerTexts();
  assert.ok(tabNames[0]!.startsWith('Бізнес-контекст і межі'), 'перша вкладка — «Бізнес-контекст і межі»: ' + tabNames[0]);
  assert.ok(tabNames[1]!.startsWith('Кроки процесу'), 'друга вкладка — «Кроки процесу»: ' + tabNames[1]);
  const selected = await page.locator('[role=tab][aria-selected=true]').innerText();
  assert.ok(selected.startsWith('Бізнес-контекст і межі'), 'за замовчуванням відкрита перша вкладка: ' + selected);
  assert.ok(await page.locator('#panel').innerText().then((t) => t.includes('Навіщо існує процес') && t.includes('Тригер') && t.includes('Фактичне завершення')), 'у першій вкладці — навіщо процес, тригер, межі, завершення');
  assert.equal(await page.locator('[data-block=review] details').evaluate((e) => (e as HTMLDetailsElement).open), false, 'перевірки готовності за замовчуванням згорнуті');
  console.log('перевірка структури картки: ок');
  await shot(page, '02-картка-з-критичним-блокером');
  await tab(page, 'Кроки процесу');
  await shot(page, '02b-вкладка-кроки-процесу');
  await tab(page, 'Бізнес-контекст');

  // спроба: кнопка наступної дії відкриває питання
  await page.getByRole('button', { name: /Закрити критичні питання/ }).click();
  await shot(page, '03-вкладка-питань');

  await tab(page, 'Твердження');
  await page.getByRole('button', { name: /Показати фрагмент/ }).first().click();
  await shot(page, '04-доказ-у-джерелі', false);
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();

  // уточнення
  await tab(page, 'Питання');
  await page.locator('textarea').first().fill('Керівник відділу повідомляє клієнта листом про відхилення винятку, після чого заявку закривають.');
  await page.getByRole('button', { name: /Закрити питання уточненням/ }).first().click();
  await page.waitForSelector('text=Критичні прогалини: 1');
  await shot(page, '05-після-уточнення-нова-версія');

  // правка кроків: відхилення веде до нового кроку S6
  await tab(page, 'Редагувати');
  const steps = page.locator('textarea[name=steps]');
  let text = await steps.inputValue();
  text = text.replace('S4 (погоджено); ? (відхилено)', 'S4 (погоджено); S6 (відхилено)') + '\nS6 | Керівник відділу | Повідомляє клієнта листом про відхилення | Клієнта поінформовано | END';
  await steps.fill(text);
  await page.getByRole('button', { name: /Зберегти як нову версію/ }).click();
  await page.waitForSelector('text=Версія 4');
  await page.waitForSelector('text=Критичних прогалин немає');
  await shot(page, '06-після-правки-кроків');

  await page.getByRole('button', { name: 'Прийняти робочу версію' }).click();
  await page.waitForSelector('text=Передати на погодження');
  await page.getByRole('button', { name: 'Передати на погодження' }).click();
  await page.waitForSelector('text=Погодити цю версію AS-IS');
  await shot(page, '07-на-погодженні');

  await page.getByRole('button', { name: 'Погодити цю версію AS-IS' }).click();
  await page.locator('dialog input[type=checkbox]').evaluateAll((els) => els.forEach((e) => (e as HTMLInputElement).click()));
  await shot(page, '08-діалог-погодження', false);
  await page.getByRole('button', { name: /^Погодити версію/ }).click();
  await page.waitForSelector('text=Дозволити створення BPMN');
  await shot(page, '09-погоджено');

  await page.getByRole('button', { name: 'Дозволити створення BPMN' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  await shot(page, '10-дозвіл-наступного-етапу', false);

  // нове джерело після погодження
  await tab(page, 'Джерела');
  await page.locator('form input[name=title]').fill('Інтерв’ю 2 — оператор (синтетичне)');
  await page.locator('form textarea[name=content]').first().fill('Оператор: винятки розглядаються приблизно за день. (синтетичний текст)');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForSelector('text=Статус: Дослідження');
  await shot(page, '11-нове-джерело-повертає-до-дослідження');
  await tab(page, 'Історія');
  await shot(page, '12-історія-погодження-скасовано');

  // невідоме не стає фактом: питання про перехід робить його невідомим, а подання його як факту — суперечність
  await tab(page, 'Питання');
  await page.locator('form input[name=text]').fill('Чи завжди заявка після S1 одразу йде на перевірку повноти?');
  await page.locator('select[name=transition]').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Додати питання' }).click();
  await page.waitForSelector('text=Невизначений перехід');
  await tab(page, 'Кроки');
  await shot(page, '13-питання-про-перехід-робить-його-невідомим');
  await tab(page, 'Редагувати');
  const steps2 = page.locator('textarea[name=steps]');
  await steps2.fill((await steps2.inputValue()).replace(/\| \?\n/, '| S2\n'));
  await page.getByRole('button', { name: /Зберегти як нову версію/ }).click();
  await page.waitForSelector('text=Суперечність');
  await shot(page, '14-невідоме-подано-як-факт-суперечність');
} finally {
  await browser.close();
  await app.stop();
}
