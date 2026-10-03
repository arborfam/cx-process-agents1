/**
 * Чотири відтворення незалежної перевірки механізму збереження введення (D99).
 *
 * Запуск: node --import tsx scripts/verify-ui-drafts.ts
 *
 * 1. Чернетка редактора перекривала новішу версію.
 * 2. Введення зникало при переході між вкладками й поверталося лише після автооновлення.
 * 3. Прапорці `required` двох форм впливали один на одного.
 * 4. Автооновлення забирало фокус і позицію курсора.
 *
 * Усе робиться через інтерфейс. Агент 1 — локальний підставний клієнт, оголошений тут:
 * мережі, ключів і витрат немає. Чернетки з тесту вручну НЕ чистяться: це робить сам продукт.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { ScriptedDemoClient } from '../src/runs.ts';
import type { AnalystInput } from '../src/ai/types.ts';

const OUT = 'docs/ux/shots';
mkdirSync(OUT, { recursive: true });
const CODE = 'ui-drafts';
const R: { n: string; ok: boolean; d: string }[] = [];
const ck = (n: string, ok: boolean, d = '') => { R.push({ n, ok, d }); };
const need = async (loc: { count(): Promise<number> }, n: string) => {
  const c = await loc.count();
  ck(n + ': елемент присутній', c > 0, `знайдено ${c}`);
  return c > 0;
};

let runNo = 0;
const analyst = new ScriptedDemoClient((input: AnalystInput) => {
  const refs = input.sources.map((s) => s.id);
  const base = structuredClone(input.head_content);
  runNo += 1;
  base.summary = `Суть від підставного клієнта, прогін ${runNo}.`;
  base.business_context = `Контекст від підставного клієнта, прогін ${runNo}.`;
  base.boundaries = { trigger: 'Клієнт звернувся', input: 'Звернення', completion: 'Потребу закрито', result: 'Рішення' };
  base.roles = ['Менеджерка', 'Оператор'];
  base.steps = [
    { id: 'S1', role: 'Менеджерка', action: 'Прийняти звернення', entry_condition: 'Надійшло звернення', input_artifact: '', result: 'Зафіксовано', next: [{ to: 'S2', condition: '' }], source_ids: refs },
    { id: 'S2', role: 'Оператор', action: 'Опрацювати звернення', entry_condition: 'Зафіксовано', input_artifact: '', result: 'Рішення ухвалено', next: [{ to: 'END', condition: '' }], source_ids: refs },
  ];
  base.claims = []; base.problems = []; base.questions = [];
  return base;
});

const db = openDb(join(mkdtempSync(join(tmpdir(), 'cx-ui-drafts-')), 'cx.sqlite'));
const server = createApp({ db, mode: 'demo', accessCode: CODE, analyst: { client: analyst } });
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
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const T = async (sel: string) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
  const openEditor = async (subtab = 'Кроки') => {
    await page.getByRole('tab', { name: 'AS-IS' }).click();
    await page.locator('.subtabs .tab', { hasText: subtab }).click();
    await page.waitForTimeout(350);
    await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
    await page.waitForTimeout(150);
  };
  const headNo = async () => String(await page.evaluate('String(state.card.head.number)'));

  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('#newtitle');
  await page.fill('#newtitle', 'Кейс для чернеток (синтетичний)');
  await page.getByRole('button', { name: 'Створити кейс' }).click();
  await page.waitForSelector('#toptabs', { timeout: 15000 });

  // вихідний опис — через інтерфейс
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Інтерв’ю 1 (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Менеджерка приймає звернення, оператор його опрацьовує.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(800);
  await page.locator('[data-block="analysis"] button').first().click();
  await page.waitForTimeout(2500);
  ck('вихідний опис створено через інтерфейс', (await headNo()) === '2', await headNo());

  /* ───── 2. Введення переживає перехід між вкладками ───── */
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Назва, набрана до перемикання');
  await page.fill('[data-draft="src-content"]', 'Текст, набраний до перемикання');
  await page.getByRole('tab', { name: 'Огляд' }).click(); await page.waitForTimeout(250);
  await page.getByRole('tab', { name: 'Історія' }).click(); await page.waitForTimeout(250);
  await page.getByRole('tab', { name: /^Джерела/ }).click(); await page.waitForTimeout(350);
  ck('назва на місці одразу після повернення на вкладку', (await page.inputValue('[data-draft="src-title"]')) === 'Назва, набрана до перемикання', await page.inputValue('[data-draft="src-title"]'));
  ck('текст на місці одразу після повернення на вкладку', (await page.inputValue('[data-draft="src-content"]')) === 'Текст, набраний до перемикання');

  // те саме для внутрішніх вкладок AS-IS
  await openEditor('Бізнес-контекст');
  await page.fill('[data-block="edit-inline"] textarea[name="summary"]', 'Суть, набрана до перемикання підвкладок');
  await page.locator('.subtabs .tab', { hasText: 'Питання' }).click(); await page.waitForTimeout(250);
  await openEditor('Бізнес-контекст');
  ck('введення переживає перехід між підвкладками AS-IS',
    (await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]')) === 'Суть, набрана до перемикання підвкладок',
    await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]'));

  /* ───── 3. Прапорці `required` двох форм незалежні ───── */
  await page.getByRole('tab', { name: /^Джерела/ }).click();
  await page.waitForTimeout(350);
  const reqText = page.locator('[data-form="src"] input[name="required"]');
  const reqFile = page.locator('[data-form="file"] input[name="required"]');
  if (await need(reqText, 'прапорець «обов’язкове» у формі тексту') && await need(reqFile, 'прапорець «обов’язкове» у формі файлу')) {
    await reqText.check();
    await page.waitForTimeout(150);
    ck('позначка у формі тексту не вмикає прапорець форми файлу', !(await reqFile.isChecked()));
    await page.evaluate('route()'); await page.waitForTimeout(600);
    ck('після оновлення позначка лишилась у формі тексту', await reqText.isChecked());
    ck('після оновлення прапорець форми файлу лишився вимкненим', !(await reqFile.isChecked()));
    await reqText.uncheck(); await reqFile.check();
    await page.evaluate('route()'); await page.waitForTimeout(600);
    ck('зворотний випадок: позначено лише форму файлу', (await reqFile.isChecked()) && !(await reqText.isChecked()),
      `текст=${await reqText.isChecked()} файл=${await reqFile.isChecked()}`);
    await reqFile.uncheck();
  }

  /* ───── 4. Автооновлення не забирає фокус і позицію курсора ───── */
  await page.click('[data-draft="src-content"]');
  await page.fill('[data-draft="src-content"]', 'Текст із курсором усередині');
  await page.evaluate('(() => { const e = document.querySelector(\'[data-draft="src-content"]\'); e.focus(); e.setSelectionRange(6, 6); })()');
  await page.evaluate('route()'); await page.waitForTimeout(700);
  const after = JSON.parse(String(await page.evaluate(
    'JSON.stringify((() => { const a = document.activeElement; return { d: a.dataset ? a.dataset.draft || null : null, s: a.selectionStart, v: a.value }; })())')));
  ck('після автооновлення фокус лишився в тому самому полі', after.d === 'src-content', JSON.stringify(after.d));
  ck('після автооновлення позиція курсора збережена', after.s === 6, String(after.s));
  ck('після автооновлення текст у полі збережений', after.v === 'Текст із курсором усередині');
  // Поле без `id` і без `data-draft` — лише з `name`.
  await openEditor('Бізнес-контекст');
  await page.click('[data-block="edit-inline"] textarea[name="business_context"]');
  await page.fill('[data-block="edit-inline"] textarea[name="business_context"]', 'Контекст, що правиться');
  await page.evaluate('(() => { const e = document.querySelector(\'[data-block="edit-inline"] textarea[name="business_context"]\'); e.focus(); e.setSelectionRange(9, 9); })()');
  await page.evaluate('route()'); await page.waitForTimeout(700);
  const after2 = JSON.parse(String(await page.evaluate(
    'JSON.stringify((() => { const a = document.activeElement; return { n: a.getAttribute ? a.getAttribute("name") : null, s: a.selectionStart }; })())')));
  ck('фокус зберігається й у полі лише з name', after2.n === 'business_context', JSON.stringify(after2.n));
  ck('позиція курсора зберігається й у полі лише з name', after2.s === 9, String(after2.s));

  /* ───── 1. Чернетка редактора не перекриває новішу версію ───── */
  const beforeNo = await headNo();
  await openEditor('Бізнес-контекст');
  await page.fill('[data-block="edit-inline"] textarea[name="summary"]', 'МОЯ НЕЗБЕРЕЖЕНА ПРАВКА');
  // Новіша версія зʼявляється іншим шляхом: нове джерело + оновлення аналізу.
  await page.getByRole('tab', { name: /^Джерела/ }).click(); await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Інтерв’ю 2 (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Друге інтерв’ю: оператор інколи повертає звернення.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(800);
  await page.locator('[data-block="analysis"] button').first().click();
  await page.waitForTimeout(2500);
  const newNo = await headNo();
  ck('зʼявилася новіша версія', Number(newNo) > Number(beforeNo), `${beforeNo} → ${newNo}`);

  await openEditor('Бізнес-контекст');
  const shown = await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]');
  ck('чернетка не підставлена мовчки поверх нового змісту', shown !== 'МОЯ НЕЗБЕРЕЖЕНА ПРАВКА' && shown.includes('підставного клієнта'), shown.slice(0, 60));
  if (await need(page.locator('[data-block="draft-stale"]'), 'повідомлення про відкладені правки')) {
    await page.locator('[data-block="draft-stale"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/125-відкладені-правки-редактора.png`, fullPage: false });
    ck('повідомлення пояснює, що правки збережено', (await T('[data-block="draft-stale"]')).includes('незбережені правки'), (await T('[data-block="draft-stale"]')).slice(0, 90));
    await page.locator('[data-act="draft-apply"]').click();
    await page.waitForTimeout(300);
    ck('правки повертаються в поля явною дією',
      (await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]')) === 'МОЯ НЕЗБЕРЕЖЕНА ПРАВКА');
    ck('після повернення правок повідомлення зникає', (await page.locator('[data-block="draft-stale"]').count()) === 0);
  }

  // повторне збереження після появи новішої версії
  await page.selectOption('[data-block="edit-inline"] select[name="entry"]', 'S1');
  await page.fill('[data-block="edit-inline"] input[name="process_name"]', 'Опрацювання звернення (синтетичний)');
  await page.getByRole('button', { name: 'Зберегти як нову версію' }).click();
  await page.waitForTimeout(1500);
  const savedNo = await headNo();
  ck('повторне збереження після новішої версії пройшло', Number(savedNo) > Number(newNo), `${newNo} → ${savedNo}`);
  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Бізнес-контекст' }).click();
  await page.waitForTimeout(400);
  ck('збережено саме правку людини', (await T('#panel')).includes('МОЯ НЕЗБЕРЕЖЕНА ПРАВКА'), (await T('#panel')).slice(0, 80));

  // після успішного збереження чернетки редактора немає
  await openEditor('Бізнес-контекст');
  ck('після збереження повідомлення про відкладені правки не зʼявляється', (await page.locator('[data-block="draft-stale"]').count()) === 0);
  await page.getByRole('tab', { name: /^Джерела/ }).click(); await page.waitForTimeout(300);
  await page.fill('[data-draft="src-title"]', 'Інтерв’ю 3 (синтетичне)');
  await page.fill('[data-draft="src-content"]', 'Третє інтерв’ю.');
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await page.waitForTimeout(800);
  await page.locator('[data-block="analysis"] button').first().click();
  await page.waitForTimeout(2500);
  await openEditor('Бізнес-контекст');
  // Поле має показувати рівно те, що лежить на сервері: збережене більше не є чернеткою й нічого
  // не перекриває. (Сам текст правки у змісті лишається — оновлення аналізу правок не знищує.)
  const latest = await page.inputValue('[data-block="edit-inline"] textarea[name="summary"]');
  const onServer = String(await page.evaluate('state.card.head.content.summary'));
  ck('поле показує зміст сервера, а не чернетку', latest === onServer, `поле=${latest.slice(0, 40)} сервер=${onServer.slice(0, 40)}`);
  ck('після збереження чернетки редактора не лишилось',
    String(await page.evaluate('String([...(drafts.get(state.caseId) || new Map()).keys()].filter((k) => k.startsWith("edit|")).length)')) === '0');
  ck('після збереження форма не вважає себе зміненою', (await page.locator('[data-block="draft-stale"]').count()) === 0);

  // надіслані форми джерел теж не відновлюються
  await page.getByRole('tab', { name: /^Джерела/ }).click(); await page.waitForTimeout(300);
  ck('надіслана форма джерела лишається порожньою', (await page.inputValue('[data-draft="src-title"]')) === '',
    await page.inputValue('[data-draft="src-title"]'));

  await ctx.close();
} finally {
  await browser.close(); await app.stop(); db.close();
}
const failed = R.filter((x) => !x.ok);
console.log(JSON.stringify({ failed, passed: R.length - failed.length, total: R.length, errors: [...new Set(errs)].slice(0, 6) }, null, 1));
if (failed.length || errs.length) process.exitCode = 1;
