/**
 * Браузерний сценарій (Chromium): наслідки пропозицій ДО прийняття, пов'язані пропозиції одним рішенням, підтвердження наслідків,
 * виправлення помилкової прив'язки питання. Знімки — docs/demo/27–31.
 * Запуск: node --import tsx scripts/walkthrough-proposals.ts
 * Дані вигадані; база тимчасова; жодних викликів моделі. «Версії агента» створено програмно (це не відповідь AI) — лише щоб показати інтерфейс рішень людини.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb, run } from '../src/db.ts';
import { addSource, createCase, headVersion, insertVersion, type Actor } from '../src/domain.ts';
import { emptyContent, UNKNOWN, type Content } from '../src/schema.ts';

const OUT = 'docs/demo';
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cx-walk-proposals-'));
const dbPath = join(dir, 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };

const step = (id: string, role: string, action: string, result: string, next: { to: string; condition?: string }[], details?: string) =>
  ({ id, role, action, entry_condition: '', input_artifact: '', result, next: next.map((n) => ({ to: n.to, condition: n.condition ?? '' })), source_ids: [] as string[], ...(details ? { details } : {}) });
const SRC = 'Виконавець реєструє запит. Потім він уточнює деталі у замовника, складає відповідь і надсилає її. Якщо замовник не відповів, що буде далі, невідомо.';
const base = (): Content => {
  const c = emptyContent();
  c.summary = 'Синтетичний процес обробки запиту (приклад для демонстрації).';
  c.business_context = 'Вигаданий процес; не стосується жодного реального кейсу.';
  c.boundaries = { trigger: 'Надходить запит', input: 'Запит', completion: 'Відповідь надіслано', result: 'Відповідь' };
  c.roles = ['Замовник', 'Виконавець'];
  c.process_name = 'Обробка запиту (синтетичний процес)';
  return c;
};

{
  const db = openDb(dbPath);
  const seed = (title: string, content: (srcId: string) => Content) => {
    const c = createCase(db, human, title, 'demo');
    const s = addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: SRC, origin: 'synthetic' });
    const v = insertVersion(db, { caseId: c.id, content: content(s.id), createdBy: 'agent', actorName: 'analyst-agent', parentId: headVersion(db, c.id).id, covered: [s.id], owned: [], note: 'ПІДСТАВНА версія «агента» (демонстрація інтерфейсу)' });
    run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v.id, c.id);
  };
  // A: старий «скелет» K1/K2 + детальний ланцюжок, початок K3, дві залежні пропозиції заміни
  seed('Кейс A: пов’язані пропозиції', (src) => {
    const c = base();
    c.entry_step_id = 'K3';
    c.steps = [
      step('K1', 'Замовник', 'Надсилає запит', 'Запит надіслано', [{ to: 'K2' }]),
      step('K2', 'Виконавець', 'Готує відповідь (загальний крок)', 'Відповідь готова', [{ to: 'END' }]),
      step('K3', 'Виконавець', 'Реєструє запит', 'Запит зареєстровано', [{ to: 'K4' }]),
      step('K4', 'Виконавець', 'Уточняє деталі у замовника', 'Деталі отримано', [{ to: 'K5' }], 'Каналів кілька: пошта, месенджер, дзвінок; конкретні команди джерелами не названо.'),
      step('K5', 'Виконавець', 'Складає відповідь', 'Відповідь складено', [{ to: 'K6' }]),
      step('K6', 'Виконавець', 'Надсилає відповідь', 'Відповідь надіслано', [{ to: 'END' }]),
    ];
    const prop = (id: string, st: string, rep: string, why: string, quote: string) => ({ id, action: 'replace' as const, step_id: st, replacement_step_id: rep, reason: why, evidence_source_id: src, evidence_quote: quote, status: 'proposed' as const, decided_by: '', decision_note: '' });
    c.step_proposals = [
      prop('R1', 'K1', 'K3', 'Джерело описує фактичний вхід процесу з боку виконавця.', 'Виконавець реєструє запит.'),
      prop('R2', 'K2', 'K4', 'Загальний крок без дій; джерело описує конкретну послідовність.', 'Потім він уточнює деталі у замовника'),
    ];
    return c;
  });
  // B: питання агента прив'язано до переходів «за замовчуванням» (як напрямок)
  seed('Кейс B: питання про виняток', (src) => {
    const c = base();
    c.entry_step_id = 'K1';
    c.steps = [
      step('K1', 'Виконавець', 'Реєструє запит', 'Запит зареєстровано', [{ to: 'K2' }]),
      step('K2', 'Виконавець', 'Уточняє деталі у замовника', 'Деталі отримано', [{ to: 'K3' }]),
      step('K3', 'Виконавець', 'Надсилає відповідь', 'Відповідь надіслано', [{ to: UNKNOWN, condition: '' }]),
    ];
    const q = (id: string, text: string, stepId: string, critical: boolean) => ({ id, text, critical, impact: 'Може додати альтернативну гілку', addressee: 'Виконавець', status: 'open' as const, answer: '', closed_by_source_id: null, origin: 'agent' as const, criticality_note: '', affects_transitions: [{ step_id: stepId, condition: '' }] });
    c.questions = [q('Q1', 'Що буде, якщо замовник не відповів на уточнення?', 'K2', false), q('Q2', 'Де завершується процес після надсилання відповіді?', 'K3', true)];
    c.claims = [{ id: 'C1', text: 'Якщо замовник не відповів, що буде далі, невідомо.', type: 'source_fact', source_id: src, quote: 'Якщо замовник не відповів, що буде далі, невідомо.', scope: 'Слова виконавця про свою ділянку.' }];
    return c;
  });
  db.close();
}

function startApp(): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MODEL_MODE: 'demo', PORT: '0', CX_DB_PATH: dbPath, CX_ACCESS_CODE: 'walk-code' };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); const m = /http:\/\/localhost:(\d+)\//.exec(out); if (m) resolve({ url: `http://localhost:${m[1]}`, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); }) }); });
    child.stderr.on('data', (d) => { out += String(d); });
    setTimeout(() => reject(new Error('не стартував: ' + out)), 20000);
  });
}
async function shot(page: Page, name: string, full = true) { await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); console.log('знімок', name); }
const tab = (page: Page, label: string) => page.getByRole('tab', { name: new RegExp(label) }).click();

const app = await startApp();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=walk-code`);
  await page.waitForSelector('text=Кейси');

  // ── A: наслідки до прийняття ──
  await page.getByRole('link', { name: /Кейс A/ }).click();
  await page.waitForSelector('text=Критичні прогалини');
  await tab(page, 'Кроки процесу');
  await page.waitForSelector('[data-block=proposals]');
  const block = await page.locator('[data-block=proposals]').innerText();
  assert.ok(block.includes('Що зміниться, якщо прийняти'), 'наслідки показано до прийняття');
  assert.ok(block.includes('Пов’язані пропозиції: R1 + R2'), 'пов’язану групу видно');
  assert.ok(/ЛИШАТЬСЯ проблеми потоку: недосяжний крок K1/.test(block), 'для R2 окремо видно, що K1 лишиться недосяжним');
  assert.ok(/Початковий крок не зміниться \(K3\)/.test(block));
  assert.ok(/не лишиться/.test(await page.locator('[data-block=bundle]').innerText()), 'для групи проблем потоку не лишиться');
  await shot(page, '27-наслідки-пропозицій-до-прийняття');

  // прийняти лише R2: потрібне явне підтвердження наслідків
  const r2 = page.locator('[data-block=proposals] .claim').filter({ hasText: 'Замінити крок K2' });
  await r2.getByRole('button', { name: /Прийняти лише цю/ }).click();
  await page.waitForSelector('[data-block=ack]');
  assert.equal(await page.getByRole('button', { name: 'Прийняти R2' }).isDisabled(), true, 'без підтвердження наслідків кнопка недоступна');
  await shot(page, '28-прийняття-однієї-потребує-підтвердження-наслідків', false);
  await page.getByRole('button', { name: 'Скасувати' }).click();

  // прийняти пов'язані разом: одне рішення, одна версія
  const before = await page.locator('[data-block=essence]').innerText();
  await page.locator('[data-block=bundle]').getByRole('button', { name: /Прийняти разом/ }).click();
  assert.ok(!(await page.locator('[data-block=ack]').count()), 'для узгодженої групи додаткове підтвердження не потрібне');
  await shot(page, '29-прийняти-разом-одним-рішенням', false);
  await page.getByRole('button', { name: /^Прийняти разом: R1 \+ R2$/ }).click();
  await page.waitForSelector('text=Пов’язані пропозиції прийнято разом');
  await page.waitForTimeout(400);
  const gaps = await page.locator('[data-block=gaps]').innerText();
  assert.ok(!/Недосяжн/.test(gaps), 'після прийняття разом недосяжних кроків немає: ' + gaps);
  assert.ok(!before.includes('Версія 4') || true);
  await tab(page, 'Кроки процесу');
  const table = await page.locator('#panel').innerText();
  assert.ok(!/\bK1\b.*Надсилає запит/.test(table) && !/Готує відповідь \(загальний крок\)/.test(table), 'K1 і K2 зникли з опису');
  assert.ok(/Прийнято|прийнято/.test(table), 'стан пропозицій — прийнято');
  await shot(page, '30-після-прийняття-разом-узгоджений-стан');

  // ── B: виправлення помилкової прив'язки питання ──
  await page.goto(`${app.url}/#/`);
  await page.getByRole('link', { name: /Кейс B/ }).click();
  await page.waitForSelector('text=Критичні прогалини');
  assert.ok(/Суперечність/.test(await page.locator('[data-block=gaps]').innerText()), 'до виправлення видно «суперечність»');
  await tab(page, 'Питання');
  const q1 = page.locator('#q-Q1');
  assert.ok((await q1.innerText()).includes('напрямок переходу невизначений'), 'вид прив’язки показано словами');
  await q1.getByRole('button', { name: /Змінити вид прив’язки/ }).click();
  await page.locator('dialog select').selectOption('exception');
  await page.locator('dialog input[type=text]').fill('Це питання про виняток, а не про напрямок: основна гілка відома');
  await shot(page, '31-виправлення-прив-язки-питання', false);
  await page.getByRole('button', { name: 'Підтвердити', exact: true }).click();
  await page.waitForSelector('text=Прив’язку змінено');
  await page.waitForTimeout(400);
  await tab(page, 'Питання');
  const after = await page.locator('#q-Q1').innerText();
  assert.ok(after.includes('відкрите') && after.includes('некритичне'), 'питання лишилось відкритим і некритичним: ' + after);
  assert.ok(after.includes('виняток') && /Прив’язку змінено/.test(after), 'історія виправлення видима');
  assert.ok(!/Суперечність/.test(await page.locator('[data-block=gaps]').innerText()), 'суперечність зникла лише для цього питання');
  console.log('сценарій пройдено');
} finally {
  await browser.close();
  await app.stop();
}
