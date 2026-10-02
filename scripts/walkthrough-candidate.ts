/**
 * Браузерний сценарій (Chromium): рішення людини щодо припущення агента 2 про непідтримувану нотацію (D84).
 * Знімки — `docs/bpmn-3b/10–12`.
 *
 * Запуск: node --import tsx scripts/walkthrough-candidate.ts
 *
 * ВАЖЛИВО. «Відповідь агента 2» дає ПІДСТАВНИЙ клієнт, оголошений у цьому файлі: справжніх викликів моделі,
 * мережі й ключів немає. Знімки доводять роботу інтерфейсу й програмної логіки, а не якість AI.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { acceptDraft, addSource, approve, createCase, headVersion, saveAnalystVersion, submitForApproval, type Actor } from '../src/domain.ts';
import { createApp } from '../src/server.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { makePolicy } from '../src/ai/budget.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { ModelCallResult } from '../src/ai/types.ts';

const OUT = 'docs/bpmn-3b';
mkdirSync(OUT, { recursive: true });
const dbPath = join(mkdtempSync(join(tmpdir(), 'cx-walk-cand-')), 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const CODE = 'walk-cand-code';

class ScriptedReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const;          // лише щоб пройти шлюз і облік бюджету; справжнього виклику немає
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (демонстрація, не AI)';
  constructor(private readonly findings: unknown[]) {}
  async review(_input: BpmnReviewInput): Promise<ModelCallResult> {
    return { output: { findings: this.findings }, usage: { input_tokens: 2500, output_tokens: 400 } };
  }
}

const SUMMARY = 'Синтетичний процес: виконавець уточнює строк і за орієнтовного строку чекає підтвердження.';
const FIELDS = {
  summary: SUMMARY,
  business_context: 'Вигаданий навчальний процес. Не стосується жодного реального кейсу й жодної реальної команди.',
  boundaries: { trigger: 'Надійшов запит', input: 'Запит', completion: 'Результат надіслано', result: 'Виконаний запит' },
  roles_text: 'Виконавець',
  entry_step_id: 'S1',
  process_name: 'Обробка запиту (синтетичний процес)',
  steps_text: [
    'S1 | Виконавець | Уточнює строк і отримує підтвердження | Строк підтверджено | S2',
    'S2 | Виконавець | Виконує запит і надсилає результат | Результат надіслано | END',
  ].join('\n'),
};

/** Припущення агента: цитата зі СУТІ опису (не з кроку) — саме той випадок, що розбирали в D83/D85. */
const CANDIDATE = [{
  code: 'UNSUPPORTED_CANDIDATE',
  step_ids: ['S1'],
  quote: 'за орієнтовного строку чекає підтвердження',
  question: 'Це окремий стан очікування, який має показати схема, чи звичайна дія в межах кроку?',
  class: 'blocks_flow',
  options: ['Окремий стан очікування', 'Звичайна дія в межах кроку'],
}];

const caseId = (() => {
  const db = openDb(dbPath);
  const c = createCase(db, human, 'Кейс: припущення агента про нотацію (підставна відповідь, не AI)', 'demo');
  addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: 'Виконавець уточнює строк і отримує підтвердження, далі виконує запит.', origin: 'synthetic' });
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: FIELDS, coverAllSources: true });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  db.close();
  return c.id;
})();

const db = openDb(dbPath);
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());
const server = createApp({ db, mode: 'demo', accessCode: CODE, reviewer: { client: new ScriptedReviewClient(CANDIDATE), policy, instruction: loadBpmnInstruction() } });
const app = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }));
});

async function shot(page: Page, name: string, full = true) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('знімок', name);
}
const panel = (page: Page) => page.locator('#panel');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 950 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('text=Кейси');
  await page.getByRole('link', { name: /припущення агента/ }).click();
  await page.waitForSelector('#tabs');
  await page.getByRole('tab', { name: /Схема/ }).click();
  await page.waitForSelector('text=Смислова перевірка опису');

  // 1. Перевірка → припущення блокує побудову, дія названа зрозуміло.
  await page.getByRole('button', { name: 'Запустити смислову перевірку' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('блокує побудову'), null, { timeout: 20000 });
  const blocked = await panel(page).innerText();
  assert.ok(/Побудова зараз недоступна/.test(blocked), 'побудова закрита: ' + blocked);
  assert.ok(/Цитата з: суть/.test(blocked), 'видно, звідки взято цитату: ' + blocked);
  assert.equal(await page.getByRole('button', { name: 'Відхилити припущення агента…' }).count(), 1, 'дія названа зрозуміло');
  await shot(page, '10-припущення-агента-блокує-побудову');

  // 2. Діалог: знахідка, цитата, походження, порожнє поле пояснення.
  await page.getByRole('button', { name: 'Відхилити припущення агента…' }).click();
  await page.waitForSelector('dialog textarea');
  const dialog = await page.locator('dialog').innerText();
  for (const must of ['Відхилити припущення агента', 'кроки: S1', 'Це окремий стан очікування', 'за орієнтовного строку чекає підтвердження', 'Цитата з: суть', 'НЕ означає']) {
    assert.ok(dialog.includes(must), `у діалозі немає «${must}»: ` + dialog);
  }
  assert.equal(await page.locator('dialog textarea').inputValue(), '', 'готове обґрунтування не підставляється');
  await shot(page, '11-діалог-відхилення-припущення', false);

  // Порожнє пояснення не проходить.
  await page.locator('dialog').getByRole('button', { name: 'Відхилити припущення' }).click();
  await page.waitForSelector('text=Потрібне пояснення');
  assert.ok(await page.locator('dialog').count(), 'діалог лишився відкритим');

  // 3. Рішення з поясненням → шлюз відкривається, побудова доступна.
  await page.locator('dialog textarea').fill('Крок описує звичайну дію виконавця: окремого стану очікування в процесі немає (синтетичний приклад).');
  await page.locator('dialog').getByRole('button', { name: 'Відхилити припущення' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('Ваше рішення: відхилено'), null, { timeout: 20000 });
  const after = await panel(page).innerText();
  assert.ok(/Аналітикиня/.test(after), 'видно автора рішення');
  assert.ok(/окремого стану очікування в процесі немає/.test(after), 'видно пояснення');
  assert.ok(/Побудувати схему/.test(after), 'після рішення побудова доступна: ' + after);
  await page.getByRole('button', { name: 'Побудувати схему' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('схему побудовано й перевірено'), null, { timeout: 30000 });
  await page.waitForSelector('.djs-container svg', { timeout: 20000 });
  await shot(page, '12-після-рішення-схему-побудовано');
  console.log('\nБраузерний сценарій рішення щодо припущення агента пройдено: 3 знімки в docs/bpmn-3b.');
} finally {
  await browser.close();
  await app.stop();
  db.close();
}
