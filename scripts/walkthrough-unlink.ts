/**
 * Браузерний сценарій (Chromium): прийняття пропозиції вилучення кроку → наслідки для відкритих питань →
 * явне відкріплення питання від вилученого кроку (D82). Знімки — docs/demo/32–35.
 * Запуск: node --import tsx scripts/walkthrough-unlink.ts
 * Дані вигадані; база тимчасова; жодних викликів моделі. «Версію агента» створено програмно (це не відповідь AI) —
 * лише щоб показати інтерфейс рішень людини.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb, run } from '../src/db.ts';
import { addSource, createCase, headVersion, insertVersion, type Actor } from '../src/domain.ts';
import { emptyContent, type Content } from '../src/schema.ts';

const OUT = 'docs/demo';
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cx-walk-unlink-'));
const dbPath = join(dir, 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const SRC = 'Виконавець реєструє запит, уточнює деталі й надсилає відповідь. Окрему довідку для іншого відділу готує не він.';

const step = (id: string, role: string, action: string, result: string, next: { to: string; condition?: string }[]) =>
  ({ id, role, action, entry_condition: '', input_artifact: '', result, next: next.map((n) => ({ to: n.to, condition: n.condition ?? '' })), source_ids: [] as string[] });

{
  const db = openDb(dbPath);
  const c = createCase(db, human, 'Кейс: відкріплення питання від вилученого кроку', 'demo');
  const s = addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: SRC, origin: 'synthetic' });
  const content: Content = {
    ...emptyContent(),
    summary: 'Синтетичний процес обробки запиту (приклад для демонстрації).',
    business_context: 'Вигаданий процес; не стосується жодного реального кейсу.',
    boundaries: { trigger: 'Надходить запит', input: 'Запит', completion: 'Відповідь надіслано', result: 'Відповідь' },
    roles: ['Виконавець'],
    process_name: 'Обробка запиту (синтетичний процес)',
    entry_step_id: 'K1',
    steps: [
      step('K1', 'Виконавець', 'Реєструє запит', 'Запит зареєстровано', [{ to: 'K2' }]),
      step('K2', 'Виконавець', 'Надсилає відповідь', 'Відповідь надіслано', [{ to: 'END' }]),
      step('K9', 'Виконавець', 'Готує окрему довідку для іншого відділу', 'Довідка готова', [{ to: 'END' }]),
    ],
    questions: [{
      id: 'Q7', text: 'Що робить виконавець, коли інформація про зміну надходить уже після надсилання відповіді?',
      critical: false, impact: 'Може додати альтернативну гілку', addressee: 'Виконавець', status: 'open', answer: '',
      closed_by_source_id: null, origin: 'agent', criticality_note: '',
      affects_transitions: [{ step_id: 'K9', condition: '', kind: 'exception' }],
    }],
    step_proposals: [{
      id: 'SP1', action: 'remove', step_id: 'K9', replacement_step_id: '',
      reason: 'Крок описує ділянку іншого відділу й лежить поза межами процесу',
      evidence_source_id: s.id, evidence_quote: 'Окрему довідку для іншого відділу готує не він.',
      status: 'proposed', decided_by: '', decision_note: '',
    }],
  };
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'agent', actorName: 'analyst-agent', parentId: headVersion(db, c.id).id, covered: [s.id], owned: [], note: 'ПІДСТАВНА версія «агента» (демонстрація інтерфейсу)' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v.id, c.id);
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
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 950 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=walk-code`);
  await page.waitForSelector('text=Кейси');
  await page.getByRole('link', { name: /відкріплення питання/ }).click();
  await page.waitForSelector('[data-block=gaps]');

  // ── 1. Наслідки вилучення: видно, що станеться з відкритим питанням ──
  await tab(page, 'Кроки процесу');
  await page.waitForSelector('[data-block=proposals]');
  const proposals = await page.locator('[data-block=proposals]').innerText();
  assert.ok(/Q7/.test(proposals) && /Відкріпити від вилученого кроку/.test(proposals),
    'у наслідках прийняття має бути сказано про питання Q7 і про те, що прив’язку знімає людина: ' + proposals);
  assert.ok(/не закривається й не відкріплюється/.test(proposals), 'має бути сказано, що автоматично нічого не робиться');
  await shot(page, '32-наслідки-вилучення-для-відкритого-питання');

  // ── 2. Прийняття пропозиції ──
  await page.locator('[data-block=proposals] .claim').filter({ hasText: 'Вилучити крок K9' }).getByRole('button', { name: /Прийняти лише цю/ }).click();
  await page.waitForSelector('[data-block=preview]');
  await page.getByRole('button', { name: /^Прийняти SP1$/ }).click();
  await page.waitForSelector('text=Рішення збережено');
  await page.waitForTimeout(400);
  const gaps = await page.locator('[data-block=gaps]').innerText();
  assert.ok(/Q7/.test(gaps) && /якого в описі немає/.test(gaps), 'після прийняття видно технічну прогалину: ' + gaps);
  assert.ok(/Відкріпити від вилученого кроку/.test(gaps), 'прогалина сама називає потрібну дію');

  // ── 3. Нова кнопка в картці питання ──
  await tab(page, 'Питання');
  await page.waitForSelector('[data-act=unlink]');
  const linkRow = await page.locator('[data-block=link]').first().innerText();
  assert.ok(/Кроку K9 у описі немає/.test(linkRow), 'видно, що крок вилучено: ' + linkRow);
  assert.equal(await page.locator('text=Змінити вид прив’язки…').count(), 0, 'для відсутнього кроку зміна виду прив’язки не пропонується');
  await shot(page, '33-кнопка-відкріпити-в-картці-питання');

  // ── 4. Показ перед підтвердженням + обов'язкове пояснення ──
  await page.locator('[data-act=unlink]').first().click();
  await page.waitForSelector('dialog [data-block=preview]');
  const dialog = await page.locator('dialog').innerText();
  for (const must of ['Q7', 'K9', 'лишається відкритим', 'НОВУ версію', 'НЕ закривається', 'Стара прив’язка']) {
    assert.ok(dialog.includes(must), `у показі перед підтвердженням немає «${must}»: ` + dialog);
  }
  await shot(page, '34-показ-наслідків-відкріплення-перед-підтвердженням', false);
  await page.locator('dialog').getByRole('button', { name: 'Відкріпити', exact: true }).click();   // без пояснення
  await page.waitForSelector('text=Поясніть, чому прив’язку знято');
  assert.ok(await page.locator('dialog').count(), 'без пояснення діалог лишається відкритим');

  // ── 5. Відкріплення з поясненням ──
  await page.locator('dialog input[type=text]').fill('Крок K9 вилучено: ділянка іншого відділу поза межами процесу');
  await page.locator('dialog').getByRole('button', { name: 'Відкріпити', exact: true }).click();
  await page.waitForSelector('text=Прив’язку знято');
  await page.waitForTimeout(400);
  await tab(page, 'Питання');
  const after = await page.locator('#panel').innerText();
  assert.ok(/Q7/.test(after) && /відкрите/.test(after), 'питання лишилось відкритим: ' + after);
  assert.ok(/Прив’язку знято \(Аналітикиня\)/.test(after), 'в історії видно, хто й чому зняв прив’язку: ' + after);
  assert.ok(/поза межами процесу/.test(after), 'причина збережена');
  assert.equal(await page.locator('[data-act=unlink]').count(), 0, 'неактуальної прив’язки більше немає');
  const gapsAfter = await page.locator('[data-block=gaps]').innerText();
  assert.ok(!/якого в описі немає/.test(gapsAfter), 'технічна прогалина зникла: ' + gapsAfter);
  await shot(page, '35-після-відкріплення-питання-живе-прогалини-немає');
  console.log('\nБраузерний сценарій відкріплення пройдено: 4 знімки в docs/demo.');
} finally {
  await browser.close();
  await app.stop();
}
