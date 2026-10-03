/**
 * Перевірка навігації широкою схемою на ЗБЕРЕЖЕНОМУ результаті версії 29 (вимога 4).
 *
 * Запуск: node --import tsx scripts/verify-v29-navigation.ts
 *
 * Таблицю процесу бере ПІДСТАВНИЙ клієнт із реального файлу `docs/bpmn-3c/v29-pipeline.csv`
 * — справжніх викликів моделі, мережі й ключів немає. Схему будує той самий продуктовий
 * ланцюг скриптів, тож топологія лишається тією, що й у збереженому результаті.
 *
 * Перевіряється: доступ до всіх гілок, переміщення, масштабування, перехід до вибраного кроку,
 * відкриття деталей; збереження топології, повного тексту тригера й водяного знака.
 */
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { acceptDraft, addSource, approve, createCase, headVersion, saveAnalystVersion, type Actor } from '../src/domain.ts';
import { submitForApproval } from '../src/domain.ts';
import { confirmStartLabel } from '../src/start-label.ts';
import { createApp } from '../src/server.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { makePolicy } from '../src/ai/budget.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { ModelCallResult } from '../src/ai/types.ts';

const OUT = 'docs/ux/shots';
mkdirSync(OUT, { recursive: true });
/**
 * Збережена таблиця версії 29 складалася ДО чинного контракту: у ній колонка `role` заповнена
 * і в подій, і в шлюзів, а чинна перевірка вимагає там порожнечі (`CSV_EVENT_ROLE`) — доріжка
 * успадковується від кроку. Тому перед подачею очищається РІВНО ця колонка рівно в цих рядках.
 * Топологія, підписи й умови переходів лишаються дослівно тими самими.
 */
function v29Csv(): string {
  const lines = readFileSync('docs/bpmn-3c/v29-pipeline.csv', 'utf8').trim().split('\n');
  const header = lines[0]!;
  const width = header.split(',').length;
  const out = [header];
  for (const line of lines.slice(1)) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((x) => x.replace(/,$/, '')).slice(0, width);
    while (cells.length < width) cells.push('');
    const type = cells[2];
    if (type === 'start' || type === 'end' || type === 'xor') cells[3] = '';
    out.push(cells.join(','));
  }
  return out.join('\n') + '\n';
}
const CSV = v29Csv();
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const CODE = 'v29-nav-code';
const ROLE = 'Відповідальна за підготовку агентів (CX)';
const SHORT = 'CX дізналася про майбутню велику продуктову зміну';
const TRIGGER = ('CX дізнається про майбутню велику продуктову зміну по-різному: овнер пише особисто, згадка з’являється в каналі релізів, '
  + 'або про зміну стає відомо на спільній зустрічі; підготовка вважається початою з моменту, коли CX про зміну дізналася, '
  + 'навіть якщо жодного матеріалу ще не передано й дата запуску не підтверджена (синтетичний опис для перевірки навігації). ').repeat(2).trim();

/** Кроки рівно ті, що в таблиці версії 29: ті самі ID, ролі, дії й переходи. */
const STEPS = [
  ['S4', 'Запитати в овнера handover, матеріали й доступи', 'Матеріали отримано або ні', 'S5'],
  ['S5', 'Переписати опис зміни простішою мовою', 'Текст для агентів', 'S6 (Нова тема); S7 (Тема вже є в базі знань)'],
  ['S6', 'Створити статтю в базі знань', 'Нова стаття', 'S8'],
  ['S7', 'Оновити статтю в базі знань', 'Оновлена стаття', 'S8'],
  ['S8', 'Підготувати повідомлення агентам', 'Чернетка повідомлення', 'S12 (Матеріалів від овнера бракує); S17 (Матеріалів від овнера достатньо)'],
  ['S12', 'Повторно запитати овнера про відсутні матеріали', 'Відповідь овнера', 'S13'],
  ['S13', 'Доповнити статтю й повідомлення за відповіддю овнера', 'Доповнені матеріали', 'S17'],
  ['S17', 'Перевірити, чи є пряме підтвердження дати запуску', 'Дата підтверджена або орієнтовна', 'S19 (Овнер або відповідальна команда прямо повідомили підтверджену дату запуску); S18 (Відома лише орієнтовна дата запуску)'],
  ['S18', 'Уточнити в овнера дату запуску й отримати підтвердження', 'Підтверджена дата', 'S19'],
  ['S19', 'Перевірити, чи зміну не перенесено й не скасовано', 'Статус зміни відомий', 'S9 (Зміну не перенесено й не скасовано); S16 (Зміну перенесено або скасовано)'],
  ['S9', 'Опублікувати повідомлення агентам', 'Повідомлення опубліковано', 'END'],
  ['S16', 'Припинити підготовку й зберегти напрацьовані матеріали', 'Матеріали збережено', 'END'],
];

const FIELDS = {
  summary: 'Синтетичний опис для перевірки навігації схемою версії 29.',
  business_context: 'Перевірка переглядача. Зміст синтетичний і жодної реальної команди не стосується.',
  boundaries: { trigger: TRIGGER, input: 'Повідомлення про зміну', completion: 'Повідомлення опубліковано або підготовку припинено', result: 'Агенти підготовлені' },
  roles_text: ROLE,
  entry_step_id: 'S4',
  process_name: 'Підготовка матеріалів CX до великої продуктової зміни (перевірка навігації)',
  steps_text: STEPS.map(([id, action, result, next]) => `${id} | ${ROLE} | ${action} | ${result} | ${next}`).join('\n'),
  problems_text: '',
};

/** Віддає РЕАЛЬНУ таблицю версії 29 дослівно. Жодного звернення до моделі. */
class V29Client implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ КЛІЄНТ: таблиця версії 29 з файлу (не AI)';
  async review(_input: BpmnReviewInput): Promise<ModelCallResult> {
    return { output: { findings: [], csv: CSV }, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

const dbPath = join(mkdtempSync(join(tmpdir(), 'cx-v29-nav-')), 'cx.sqlite');
const caseId = (() => {
  const db = openDb(dbPath);
  const c = createCase(db, human, 'Перевірка навігації схемою версії 29', 'demo');
  addSource(db, human, c.id, { kind: 'transcript', title: 'Синтетичне джерело', content: 'Синтетичний текст для перевірки навігації.', origin: 'synthetic' });
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: FIELDS, coverAllSources: true });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  confirmStartLabel(db, human, c.id, { label: SHORT, reason: 'Короткий підпис для схеми; повний текст тригера лишається в описі.' });
  db.close();
  return c.id;
})();

const db = openDb(dbPath);
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());
const server = createApp({ db, mode: 'demo', accessCode: CODE, reviewer: { client: new V29Client(), policy, instruction: loadBpmnInstruction() } });
const app = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }));
});

const results: { n: string; ok: boolean; d?: string }[] = [];
const ck = (n: string, ok: boolean, d = '') => { results.push({ n, ok, d }); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'uk-UA' });
  const page: Page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.getByRole('link', { name: /навігації схемою/ }).click();
  await page.waitForSelector('#tabs');
  await page.getByRole('tab', { name: /Схема/ }).click();
  await page.waitForTimeout(500);

  // смислова перевірка (підставна відповідь) → побудова
  for (let i = 0; i < 4; i++) {
    const b2 = page.locator('#panel button').filter({ hasText: /перевірк|Побудувати|побудов/i }).first();
    if (!(await b2.count())) break;
    await b2.click(); await page.waitForTimeout(3500);
    if (await page.locator('.djs-container').count()) break;
  }
  await page.waitForSelector('.djs-container', { timeout: 20000 });
  await page.waitForTimeout(1200);

  // 1. Топологія збережена. Читаємо з полотна — так, як її бачить людина.
  const counts = await page.evaluate(`(function () {
    var ids = [].slice.call(document.querySelectorAll('.djs-element[data-element-id]'))
      .map(function (e) { return e.getAttribute('data-element-id'); })
      .filter(function (x) { return !/_label$/.test(x); });   // зовнішній підпис події — окремий елемент того ж ID
    function n(re) { return ids.filter(function (x) { return re.test(x); }).length; }
    return {
      tasks: n(/^Task_/), gw: n(/^Gateway_/), start: n(/^StartEvent_/), end: n(/^End_/),
      flows: document.querySelectorAll('.djs-connection[data-element-id]').length
    };
  })()`) as { tasks: number; gw: number; start: number; end: number; flows: number };
  ck('топологія збережена: 12 дій, 4 шлюзи, 1 початок, 2 кінці, 21 перехід',
    counts.tasks === 12 && counts.gw === 4 && counts.start === 1 && counts.end === 2 && counts.flows === 21, JSON.stringify(counts));

  // 2. Доступ до всіх гілок: кожен крок таблиці має елемент і до нього можна перейти
  const rows = await page.locator('tr[data-step-row]').count();
  ck('у таблиці відповідності всі 12 кроків', rows === 12, String(rows));
  const unreachable: string[] = [];
  for (const [id] of STEPS) {
    await page.locator(`tr[data-step-row="${id}"] button:has-text("деталі")`).click();
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Показати на схемі' }).click();
    await page.waitForTimeout(450);
    const marked = await page.evaluate("document.querySelectorAll('.djs-element.cx-selected').length") as number;
    const inView = await page.evaluate(`(function () {
      var e = document.querySelector('.djs-element.cx-selected');
      if (!e) return false;
      var b = e.getBoundingClientRect(), c = document.querySelector('.djs-container').getBoundingClientRect();
      return b.left >= c.left - 2 && b.right <= c.right + 2 && b.top >= c.top - 2 && b.bottom <= c.bottom + 2;
    })()`) as boolean;
    if (marked !== 1 || !inView) unreachable.push(id + (marked !== 1 ? ' (не підсвічено)' : ' (поза полем зору)'));
  }
  ck('перехід до кожного кроку центрує й підсвічує елемент', unreachable.length === 0, unreachable.join(', '));

  // 3. Деталі кроку відкриваються й показують повний опис
  await page.locator('tr[data-step-row="S17"] button:has-text("деталі")').click();
  await page.waitForTimeout(300);
  const det = (await page.locator('dialog').textContent()) || '';
  ck('деталі кроку показують дію, роль і елемент схеми',
    det.includes('Перевірити, чи є пряме підтвердження дати запуску') && det.includes(ROLE) && det.includes('Task_S17'), det.slice(0, 120));
  await page.screenshot({ path: `${OUT}/90-продукт-v29-деталі-кроку.png`, fullPage: false });
  await page.getByRole('button', { name: 'Закрити' }).last().click();
  await page.waitForTimeout(300);

  // 4. Масштабування
  const ctm = "document.querySelector('.djs-container .viewport').getCTM()";
  const scale = async () => await page.evaluate(`(function () { var m = ${ctm}; return Math.sqrt(m.a * m.a + m.b * m.b); })()`) as number;
  const panX = async () => await page.evaluate(`(function () { return ${ctm}.e; })()`) as number;
  const z0 = await scale();
  await page.getByRole('button', { name: 'Збільшити' }).click(); await page.waitForTimeout(300);
  const z1 = await scale();
  await page.getByRole('button', { name: 'Показати всю схему' }).click(); await page.waitForTimeout(300);
  const z2 = await scale();
  ck('масштабування працює й «вся схема» відрізняється від збільшеного', z1 > z0 && z2 < z1, `${z0.toFixed(2)} → ${z1.toFixed(2)} → ${z2.toFixed(2)}`);

  // 5. Переміщення полотна
  await page.getByRole('button', { name: 'Збільшити' }).click(); await page.waitForTimeout(300);
  const box = (await page.locator('.djs-container').boundingBox())!;
  const before = await panX();
  const fromX = box.x + box.width / 2, fromY = box.y + 24;   // порожнє місце над доріжкою
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX - 150, fromY, { steps: 10 });
  await page.mouse.move(fromX - 300, fromY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await panX();
  ck('полотно переміщується перетягуванням', Math.abs(after - before) > 20, `зсув по x: ${before.toFixed(0)} → ${after.toFixed(0)}`);

  // 6. Повний текст тригера поруч зі схемою
  const full = page.locator('[data-block="full-trigger"]');
  ck('повний текст тригера доступний поруч зі схемою', (await full.count()) === 1);
  if (await full.count()) {
    await full.locator('summary').click(); await page.waitForTimeout(250);
    const t = (await full.textContent()) || '';
    ck('повний текст не скорочено', t.includes(TRIGGER.slice(0, 80)) && t.includes(TRIGGER.slice(-40)), String(t.length));
    ck('на схемі стоїть погоджений короткий підпис', t.includes(SHORT));
  }

  // 7. Водяний знак
  const wm = await page.evaluate(`(function () {
    var a = document.querySelector('.bjs-powered-by');
    if (!a) return { present: false, visible: false };
    var s = getComputedStyle(a), b = a.getBoundingClientRect();
    return { present: true, visible: s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && b.width > 0 && b.height > 0 };
  })()`) as { present: boolean; visible: boolean };
  ck('ліцензійний водяний знак присутній і видимий', wm.present && wm.visible, JSON.stringify(wm));

  await page.getByRole('button', { name: 'Показати всю схему' }).click(); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/91-продукт-v29-схема-і-таблиця.png`, fullPage: true });
  await page.locator('tr[data-step-row="S16"] td button.link').first().click(); await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/92-продукт-v29-перехід-до-кроку.png`, fullPage: false });
  await ctx.close();
} finally {
  await browser.close(); await app.stop(); db.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ failed, passed: results.length - failed.length, total: results.length }, null, 1));
if (failed.length) process.exitCode = 1;
