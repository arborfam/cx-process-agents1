/**
 * Браузерний сценарій (Chromium) для підкроків 3b-3…3b-7: смислова перевірка → рішення аналітикині → побудова схеми →
 * перегляд у bpmn-js → завантаження файлів → застарівання. Знімки — `docs/bpmn-3b/`, файли схем — там же.
 *
 * Запуск: node --import tsx scripts/walkthrough-bpmn.ts
 *
 * ВАЖЛИВО. «Відповідь агента 2» тут дає ПІДСТАВНИЙ клієнт, оголошений у цьому файлі: справжніх викликів моделі,
 * мережі й ключів немає. Саме тому назви кейсів і підписи знімків прямо кажуть «підставна відповідь, не AI» —
 * ці знімки доводять роботу інтерфейсу й програмної логіки, а не якість AI. У продукті такого клієнта немає
 * (за цим стежить `tests/bpmn-isolation.test.ts`).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { acceptDraft, addSource, approve, createCase, headVersion, saveAnalystVersion, submitForApproval, type Actor } from '../src/domain.ts';
import { createApp, sessionToken } from '../src/server.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { makePolicy } from '../src/ai/budget.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { ModelCallResult } from '../src/ai/types.ts';

const OUT = 'docs/bpmn-3b';
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cx-walk-bpmn-'));
const dbPath = join(dir, 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const CODE = 'walk-bpmn-code';

/** ПІДСТАВНИЙ клієнт: повертає заздалегідь задані знахідки. Не модель. Назва моделі про це каже прямо. */
class ScriptedReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const; // лише щоб пройти шлюз і облік бюджету; справжнього виклику немає
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (демонстрація, не AI)';
  constructor(private readonly byCase: (text: string) => unknown[]) {}
  async review(input: BpmnReviewInput): Promise<ModelCallResult> {
    return { output: { findings: this.byCase(JSON.stringify(input.pkg.content)) }, usage: { input_tokens: 2500, output_tokens: 400 } };
  }
}

const SRC_TEXT = 'Замовник надсилає запит. Виконавець перевіряє повноту запиту: якщо даних не вистачає, повертає на доповнення, '
  + 'інакше виконує й надсилає результат. Що робити, коли запит повернено двічі, не з’ясовано.';

const FIELDS = {
  summary: 'Синтетичний процес обробки запиту: перевірка повноти, виконання, надсилання результату.',
  business_context: 'Вигаданий навчальний процес. Не стосується жодного реального кейсу й жодної реальної команди.',
  boundaries: { trigger: 'Надійшов запит від замовника', input: 'Запит', completion: 'Результат надіслано замовнику', result: 'Виконаний запит' },
  roles_text: 'Замовник\nВиконавець',
  entry_step_id: 'S1',
  process_name: 'Обробка запиту (синтетичний процес)',
  steps_text: [
    'S1 | Замовник | Надсилає запит | Запит надіслано | S2',
    'S2 | Виконавець | Перевіряє повноту запиту | Запит перевірено | S3 (дані повні); S4 (даних не вистачає)',
    'S3 | Виконавець | Виконує запит | Запит виконано | S5',
    'S4 | Виконавець | Повертає запит на доповнення | Запит повернено | S1',
    'S5 | Виконавець | Надсилає результат замовнику | Результат надіслано | END',
  ].join('\n'),
  problems_text: 'P1 | Запит іноді повертають кілька разів | Замовник чекає довше (оцінка, метрик немає)',
};

function seed(title: string): string {
  const db = openDb(dbPath);
  const c = createCase(db, human, title, 'demo');
  addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: SRC_TEXT, origin: 'synthetic' });
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: FIELDS, coverAllSources: true });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  db.close();
  return c.id;
}

const titleA = 'Кейс A — повний шлях до схеми (підставна відповідь, не AI)';
const titleB = 'Кейс B — блокувальне зауваження і рішення (підставна відповідь, не AI)';
const caseA = seed(titleA);
const caseB = seed(titleB);

/** Для кейсу B — одна блокувальна знахідка з дослівною цитатою з погодженого опису. */
const BLOCKING = [{
  code: 'CONDITIONS_NOT_EXHAUSTIVE',
  step_ids: ['S2'],
  quote: 'Перевіряє повноту запиту',
  question: 'Чи є випадки, крім «дані повні» і «даних не вистачає»? Якщо так, куди веде процес у них?',
  class: 'blocks_flow',
  options: ['Додати третю гілку', 'Залишити дві гілки й описати виняток окремо'],
}];

const db = openDb(dbPath);
const client = new ScriptedReviewClient(() => []);
const clientB = new ScriptedReviewClient(() => BLOCKING);
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());

/** Той самий застосунок, що й у продукті, але з підставним клієнтом перевірки замість моделі. */
function startApp(reviewerClient: BpmnReviewClient) {
  const server = createApp({ db, mode: 'demo', accessCode: CODE, reviewer: { client: reviewerClient, policy, instruction: loadBpmnInstruction() } });
  return new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      stop: () => new Promise<void>((r) => server.close(() => r())),
    }));
  });
}

async function shot(page: Page, name: string, full = true) {
  // Спливне повідомлення ховаємо, щоб воно не перекривало змісту на знімку.
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('знімок', name);
}
const tab = (page: Page, label: string) => page.getByRole('tab', { name: new RegExp(label) }).click();
const panel = (page: Page) => page.locator('#panel');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let app = await startApp(client);
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 950 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('text=Кейси');

  // ───────── Кейс A: перевірка без блокерів → побудова → перегляд → завантаження ─────────
  await page.getByRole('link', { name: /Кейс A/ }).click();
  await page.waitForSelector('#tabs');
  await tab(page, 'Схема');
  await page.waitForSelector('text=Смислова перевірка опису');
  assert.ok((await panel(page).innerText()).includes('перевірки ще не було'), 'початковий стан — перевірки не було');
  await shot(page, '01-схема-до-перевірки');

  await page.getByRole('button', { name: 'Запустити смислову перевірку' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('зауважень, що блокують, немає'), null, { timeout: 20000 });
  assert.ok((await panel(page).innerText()).includes('Побудувати схему'), 'після чистої перевірки побудова доступна');
  await shot(page, '02-перевірка-пройдена-без-блокерів');

  await page.getByRole('button', { name: 'Побудувати схему' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('схему побудовано й перевірено'), null, { timeout: 30000 });
  await page.waitForSelector('.djs-container svg', { timeout: 20000 });
  const text = await panel(page).innerText();
  for (const must of ['Обробка запиту (синтетичний процес)', 'Відповідність кроків опису елементам схеми', 'чинна',
    'Технічна перевірка доводить лише', 'Завантажити .bpmn', 'Завантажити .drawio', 'Показати всю схему']) {
    assert.ok(text.includes(must), `у вкладці немає: ${must}`);
  }
  // Водяний знак bpmn.io має бути присутній і видимий (умова ліцензії, D30).
  const wm = page.locator('.bjs-powered-by');
  assert.equal(await wm.count(), 1, 'водяний знак bpmn.io відсутній');
  assert.ok(await wm.first().isVisible(), 'водяний знак перекрито або приховано');
  await shot(page, '03-схема-побудована-перегляд');

  await page.getByRole('button', { name: 'Показати всю схему' }).click();
  await shot(page, '04-показати-всю-схему');

  // Завантаження через ті самі маршрути, що й кнопки: файли зберігаємо для особистого перегляду.
  for (const kind of ['bpmn', 'drawio'] as const) {
    const res = await page.request.get(`${app.url}/api/cases/${caseA}/bpmn/file/${kind}`, { headers: { 'x-requested-with': 'cx' } });
    assert.equal(res.status(), 200, `${kind}: сервер не віддав файл`);
    const body = await res.text();
    writeFileSync(join(OUT, `кейс-A-схема.${kind === 'bpmn' ? 'bpmn' : 'drawio'}`), body);
    console.log(`файл ${kind}: ${body.length} символів`);
  }

  // ───────── Кейс A: уточнення опису → схема застаріла ─────────
  const dbEdit = openDb(dbPath);
  addSource(dbEdit, human, caseA, { kind: 'clarification', title: 'Нове уточнення (синтетичне)', content: 'Додаткові подробиці запиту.', origin: 'synthetic' });
  dbEdit.close();
  await page.reload();
  await page.waitForSelector('#tabs');
  await tab(page, 'Схема');
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('Застаріла — побудована за версією'), null, { timeout: 20000 });
  const stale = await panel(page).innerText();
  assert.ok(stale.includes('Як чинний результат вона не видається'), 'пояснення застарілості має бути');
  assert.ok(!stale.includes('Завантажити .bpmn'), 'для застарілої схеми кнопки завантаження немає');
  const refused = await page.request.get(`${app.url}/api/cases/${caseA}/bpmn/file/bpmn`, { headers: { 'x-requested-with': 'cx' } });
  assert.equal(refused.status(), 409, 'сервер мусить відмовити у видачі застарілого файлу');
  console.log('пряме завантаження застарілої схеми: сервер відмовив (409) —', (await refused.json()).error.code);
  await shot(page, '05-схема-застаріла-після-уточнення');

  // ───────── Кейс B: блокувальне зауваження → рішення → побудова ─────────
  await app.stop();
  app = await startApp(clientB);
  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('text=Кейси');
  await page.getByRole('link', { name: /Кейс B/ }).click();
  await page.waitForSelector('#tabs');
  await tab(page, 'Схема');
  await page.getByRole('button', { name: 'Запустити смислову перевірку' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('чекає ваших рішень'), null, { timeout: 20000 });
  const bText = await panel(page).innerText();
  for (const must of ['Зауваження, що блокують побудову (1)', 'умови не покривають усі випадки', 'Питання агента',
    'Перевіряє повноту запиту', 'Відхилити з поясненням', 'Уточнити опис (нова версія)', 'Побудова зараз недоступна']) {
    assert.ok(bText.includes(must), `у вкладці немає: ${must}`);
  }
  assert.ok(bText.includes('Варіанти від агента'), 'варіанти показані як текст для людини');
  await shot(page, '06-блокувальне-зауваження-чекає-рішення');

  await page.getByRole('button', { name: 'Відхилити з поясненням' }).click();
  await page.waitForSelector('dialog[open] textarea');
  await shot(page, '07-діалог-відхилення-потрібне-пояснення', false);
  await page.locator('dialog[open] textarea').fill('Інших випадків у цьому процесі немає: перевірка повноти дає лише дві відповіді (синтетичне пояснення для демонстрації).');
  await page.locator('dialog[open]').getByRole('button', { name: 'Відхилити з поясненням' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('Ваше рішення: відхилено'), null, { timeout: 20000 });
  const afterText = await panel(page).innerText();
  assert.ok(afterText.includes('Побудувати схему'), 'після рішення побудова доступна');
  assert.ok(afterText.includes('Запис незмінний'), 'видно, що рішення незмінне');
  await shot(page, '08-рішення-записано-побудова-доступна');

  await page.getByRole('button', { name: 'Побудувати схему' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('схему побудовано й перевірено'), null, { timeout: 30000 });
  await page.waitForSelector('.djs-container svg', { timeout: 20000 });
  await shot(page, '09-схема-після-мотивованого-відхилення');
  const resB = await page.request.get(`${app.url}/api/cases/${caseB}/bpmn/file/bpmn`, { headers: { 'x-requested-with': 'cx' } });
  writeFileSync(join(OUT, 'кейс-B-схема.bpmn'), await resB.text());

  // Повторний клік: другого артефакту не з'являється.
  const again = await page.request.post(`${app.url}/api/cases/${caseB}/bpmn/build`, { headers: { 'x-requested-with': 'cx' }, data: {} });
  const body = await again.json();
  assert.equal(again.status(), 200);
  assert.equal(body.reused, true, 'повторна побудова мусить повернути наявний артефакт');
  console.log('повторний клік «Побудувати»: повернено наявний артефакт (reused=true)');

  console.log('\nГОТОВО. Знімки й файли схем — у', OUT);
  console.log('УВАГА: відповіді «агента 2» у цьому сценарії дав ПІДСТАВНИЙ клієнт. Це демонстрація інтерфейсу й програмної логіки, НЕ якості AI.');
} finally {
  await browser.close();
  await app.stop();
  db.close();
}
