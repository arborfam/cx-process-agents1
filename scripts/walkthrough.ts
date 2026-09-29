/**
 * Проходить сценарій демо у справжньому браузері (Chromium) і знімає екрани в docs/demo/.
 * Запуск: npx tsx scripts/walkthrough.ts
 * Дані синтетичні; база тимчасова; жодних викликів моделі.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await page.waitForSelector('text=Блокери погодження');
  await shot(page, '02-картка-з-критичним-блокером');

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
  await page.waitForSelector('text=Критичних блокерів немає').catch(() => {});
  await shot(page, '05-після-уточнення-нова-версія');

  // правка кроків: відхилення веде до нового кроку S6
  await tab(page, 'Редагувати');
  const steps = page.locator('textarea[name=steps]');
  let text = await steps.inputValue();
  text = text.replace('S4 (погоджено); END (відхилено)', 'S4 (погоджено); S6 (відхилено)') + '\nS6 | Керівник відділу | Повідомляє клієнта листом про відхилення | Клієнта поінформовано | END';
  await steps.fill(text);
  await page.getByRole('button', { name: /Зберегти як нову версію/ }).click();
  await page.waitForSelector('text=Версія 4');
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
} finally {
  await browser.close();
  await app.stop();
}
