/**
 * Наскрізна перевірка ПРОДУКТОВОГО маршруту в погодженому інтерфейсі (D97).
 *
 * Запуск: node --import tsx scripts/verify-product-route.ts
 *
 * Ізольоване середовище: тимчасова база, власний порт, деморежим. Жодних платних викликів,
 * мережі й ключів. Перевіряються два процеси — CX і погодження закупівлі — на справжніх
 * продуктових даних і правилах, а не в макеті.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { addSource, createCase, headVersion, saveAnalystVersion, type Actor } from '../src/domain.ts';
import { createApp } from '../src/server.ts';

const OUT = 'docs/ux/shots';
mkdirSync(OUT, { recursive: true });
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const CODE = 'route-code';

const CASES = [
  {
    key: 'cx', title: 'CX: підготовка матеріалів до продуктової зміни (синтетичний)',
    source: 'Інтерв’ю (синтетичне). CX дізнається про зміну від овнера. Потім переписує опис простішою мовою й готує повідомлення агентам. Якщо тема нова — створює статтю, інакше оновлює наявну.',
    fields: {
      summary: 'CX готує агентів підтримки до великої продуктової зміни: стаття в базі знань і повідомлення.',
      business_context: 'Синтетичний навчальний приклад. Жодної реальної команди не стосується.',
      boundaries: { trigger: 'CX дізналася про майбутню велику продуктову зміну', input: 'Повідомлення овнера', completion: 'Повідомлення агентам опубліковано', result: 'Агенти підготовлені' },
      roles_text: 'Відповідальна за підготовку агентів (CX)',
      entry_step_id: 'S1',
      process_name: 'Підготовка матеріалів CX (синтетичний процес)',
      steps_text: [
        'S1 | Відповідальна за підготовку агентів (CX) | Запитати в овнера матеріали й доступи | Матеріали отримано | S2',
        'S2 | Відповідальна за підготовку агентів (CX) | Переписати опис зміни простішою мовою | Текст для агентів | S3 (Нова тема); S4 (Тема вже є)',
        'S3 | Відповідальна за підготовку агентів (CX) | Створити статтю в базі знань | Нова стаття | S5',
        'S4 | Відповідальна за підготовку агентів (CX) | Оновити статтю в базі знань | Оновлена стаття | S5',
        'S5 | Відповідальна за підготовку агентів (CX) | Опублікувати повідомлення агентам | Повідомлення опубліковано | END',
      ].join('\n'),
      problems_text: 'P1 | Агенти дізнаються пізно | Повідомлення виходить після запуску зміни (оцінка, метрик немає)',
    },
  },
  {
    key: 'proc', title: 'Погодження закупівлі до 50 000 грн (синтетичний)',
    source: 'Інтерв’ю (синтетичне). Ініціаторка оформлює заявку, керівник перевіряє потребу, закупівельник збирає пропозиції й оформлює замовлення.',
    fields: {
      summary: 'Підрозділ отримує потрібний товар із контрольованою витратою бюджету.',
      business_context: 'Синтетичний навчальний приклад: ролі, суми й ліміти вигадані.',
      boundaries: { trigger: 'Підрозділ повідомив про потребу поза складом', input: 'Заявка', completion: 'Потребу закрито', result: 'Товар отримано або заявку закрито' },
      roles_text: 'Ініціаторка потреби\nКерівник підрозділу\nЗакупівельник',
      entry_step_id: 'Z1',
      process_name: 'Погодження закупівлі (синтетичний процес)',
      steps_text: [
        'Z1 | Ініціаторка потреби | Оформити заявку на закупівлю | Заявка створена | Z2',
        'Z2 | Керівник підрозділу | Перевірити потребу й обґрунтування | Заявка погоджена або повернена | Z3 (Повернено); Z4 (Погоджено)',
        'Z3 | Ініціаторка потреби | Доопрацювати заявку за зауваженнями | Оновлена заявка | Z2',
        'Z4 | Закупівельник | Зібрати комерційні пропозиції | Пропозиції зібрано | Z5',
        'Z5 | Закупівельник | Оформити замовлення постачальнику | Замовлення надіслано | END',
      ].join('\n'),
      problems_text: 'P1 | Довгий цикл погодження | Прості закупівлі проходять по два тижні (оцінка)',
    },
  },
];

const dbPath = join(mkdtempSync(join(tmpdir(), 'cx-route-')), 'cx.sqlite');
const db = openDb(dbPath);
const ids: Record<string, string> = {};
for (const c of CASES) {
  const row = createCase(db, human, c.title, 'demo');
  addSource(db, human, row.id, { kind: 'transcript', title: 'Інтерв’ю 1 (синтетичне)', content: c.source, origin: 'synthetic', ref: 'SRC-01' });
  saveAnalystVersion(db, human, row.id, { baseVersionId: headVersion(db, row.id).id, fields: c.fields, coverAllSources: true });
  ids[c.key] = row.id;
}
const server = createApp({ db, mode: 'demo', accessCode: CODE });
const app = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }));
});

const R: { n: string; ok: boolean; d: string }[] = [];
const ck = (n: string, ok: boolean, d = '') => { R.push({ n, ok, d }); };
const errs: string[] = [];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'uk-UA' });
  const page: Page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('response', (r) => { if (r.status() === 404) errs.push('404: ' + r.url()); });
  await page.goto(`${app.url}/login?code=${CODE}`);
  const T = async (sel: string) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

  for (const c of CASES) {
    const tag = c.key === 'cx' ? 'CX' : 'закупівля';
    await page.goto(`${app.url}/#/case/${ids[c.key]}`);
    await page.waitForSelector('#toptabs', { timeout: 15000 });
    await page.waitForTimeout(500);

    const tabs = (await page.locator('#toptabs .tab').allTextContents()).map((x) => x.replace(/\d+$/, '').trim());
    ck(`${tag}: п'ять вкладок погодженого дизайну`,
      JSON.stringify(tabs) === JSON.stringify(['Огляд', 'AS-IS', 'Джерела', 'Схема', 'Історія']), JSON.stringify(tabs));
    ck(`${tag}: огляд починається з короткого контексту`, (await T('#main .lead h2')) === 'Коротко');
    ck(`${tag}: наступна дія у правій колонці`, (await page.locator('#main .rail .next').count()) === 1);
    ck(`${tag}: головні зміни на огляді`, (await T('#main')).includes('Головні зміни'));
    ck(`${tag}: технічне не в основному полі`, (await page.locator('#main .rail details').count()) >= 1);
    const txt = await T('#app');
    ck(`${tag}: немає службових значень у розмітці`, !/\bnull\b|\bundefined\b|\[object Object\]/.test(txt),
      (txt.match(/.{0,40}(null|undefined|\[object Object\]).{0,40}/) || [''])[0]);
    ck(`${tag}: немає «передати на погодження» й «прийняти робочу версію»`,
      !/Передати на погодження|Прийняти робочу версію/.test(txt));
    await page.screenshot({ path: `${OUT}/110-продукт-огляд-${c.key}.png`, fullPage: true });

    await page.getByRole('tab', { name: 'AS-IS' }).click();
    await page.waitForTimeout(400);
    const subs = (await page.locator('.subtabs .tab').allTextContents()).map((x) => x.split('·')[0]!.trim());
    ck(`${tag}: внутрішня навігація AS-IS`,
      JSON.stringify(subs) === JSON.stringify(['Бізнес-контекст і межі', 'Кроки', 'Твердження й докази', 'Питання', 'Проблеми й гіпотези']), JSON.stringify(subs));
    await page.screenshot({ path: `${OUT}/111-продукт-asis-${c.key}.png`, fullPage: true });

    // погодження однією дією
    await page.getByRole('tab', { name: 'Огляд' }).click();
    await page.waitForTimeout(400);
    const na = await T('#main .rail .next button.primary');
    ck(`${tag}: наступна дія веде до погодження`, /Погодити|Прийняти|Передати/.test(na), na);
    await page.locator('#main .rail .next button.primary').click();
    await page.waitForTimeout(600);
    const dlgTxt = await T('dialog');
    ck(`${tag}: діалог погодження показує межі версії`, dlgTxt.includes('Початок процесу') && dlgTxt.includes('Фактичне завершення'), dlgTxt.slice(0, 120));
    ck(`${tag}: сказано, що погодження нічого не запускає`, dlgTxt.includes('нічого не запускає'));
    if (c.key === 'cx') await page.screenshot({ path: `${OUT}/112-продукт-погодження.png`, fullPage: false });
    const boxes = page.locator('dialog input[type="checkbox"]');
    for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
    await page.locator('dialog button.primary').click();
    await page.waitForTimeout(1500);
    const after = await T('#app');
    ck(`${tag}: погоджено однією дією`, after.includes('AS-IS погоджено') || after.includes('Погоджено'), after.slice(0, 120));
    await page.screenshot({ path: `${OUT}/113-продукт-після-погодження-${c.key}.png`, fullPage: true });
  }

  // збереження введення й позиції при автооновленні
  await page.goto(`${app.url}/#/case/${ids.cx}`);
  await page.waitForSelector('#toptabs'); await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'AS-IS' }).click(); await page.waitForTimeout(300);
  await page.locator('.subtabs .tab', { hasText: 'Питання' }).click(); await page.waitForTimeout(400);
  // Поле нового питання є на цій вкладці завжди (відповіді на закриті питання — ні).
  const ta = page.locator('#main [data-draft="q-new-text"]').first();
  // Відсутність поля — це НЕВДАЧА перевірки, а не підстава її зарахувати: без поля твердження
  // про збереження введення нічого не доводить.
  const taCount = await ta.count();
  ck('текстове поле присутнє (інакше перевірку збереження введення зараховувати нема за чим)', taCount > 0, `знайдено ${taCount}`);
  if (taCount > 0) {
    await ta.fill('Напівнабраний текст, який не має зникнути');
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.evaluate(() => (window as unknown as { route: () => Promise<void> }).route?.());
    await page.waitForTimeout(900);
    ck('введений текст не зник при оновленні стану', (await ta.inputValue()).includes('Напівнабраний'), (await ta.inputValue()).slice(0, 50));
  } else {
    ck('введений текст не зник при оновленні стану', false, 'поля немає — перевірити нічого');
  }
  ck('вкладка не скинулась', (await page.locator('.subtabs .tab[aria-selected="true"]').textContent() || '').includes('Питання'));

  await ctx.close();
} finally {
  await browser.close(); await app.stop(); db.close();
}
const failed = R.filter((x) => !x.ok);
console.log(JSON.stringify({ failed, passed: R.length - failed.length, total: R.length, errors: [...new Set(errs)].slice(0, 6) }, null, 1));
if (failed.length || errs.length) process.exitCode = 1;
