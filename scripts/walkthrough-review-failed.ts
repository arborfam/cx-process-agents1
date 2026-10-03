/**
 * Браузерний сценарій: невдала смислова перевірка й відновлення роботи після неї. Знімки — `docs/bpmn-3c/09–11`.
 *
 * Запуск: node --import tsx scripts/walkthrough-review-failed.ts
 *
 * Дві частини:
 *  1. агент повертає таблицю за СТАРИМ контрактом ID (саме це сталося в платному запуску) → запуск
 *     завершується помилкою, і в інтерфейсі видно справжню причину, порушення й журнал спроб;
 *  2. після цього перевірка запускається заново з відповіддю за ВИПРАВЛЕНОЮ інструкцією → схема будується.
 *
 * Таблицю другої частини написано РУКАМИ за текстом інструкції `prompts/bpmn.md` (а не хелпером, складеним
 * за правилами валідатора) — саме так перевіряється, що інструкція й перевірка описують один контракт.
 * Справжніх викликів моделі, мережі й ключів тут немає.
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
import type { BpmnReviewClient } from '../src/ai/bpmn-review.ts';
import type { ModelCallResult } from '../src/ai/types.ts';

const OUT = 'docs/bpmn-3c';
mkdirSync(OUT, { recursive: true });
const dbPath = join(mkdtempSync(join(tmpdir(), 'cx-walk-fail-')), 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const CODE = 'walk-fail-code';

const FIELDS = {
  summary: 'Синтетичний процес: оператор реєструє звернення, аналітик перевіряє дані й закриває звернення.',
  business_context: 'Вигаданий навчальний процес. Не стосується жодного реального кейсу й жодної реальної команди.',
  boundaries: { trigger: 'Клієнт звернувся', input: 'Звернення', completion: 'Звернення закрито', result: 'Закрите звернення' },
  roles_text: 'Оператор\nАналітик',
  entry_step_id: 'S1',
  process_name: 'Обробка звернення (синтетичний процес)',
  steps_text: [
    'S1 | Оператор | Зареєструвати звернення | Звернення зареєстровано | S2',
    'S2 | Аналітик | Перевірити дані | Дані перевірено | S3 (дані повні); S1 (дані неповні)',
    'S3 | Аналітик | Закрити звернення | Звернення закрито | КІНЕЦЬ',
  ].join('\n'),
};

/** Таблиця за СТАРИМ (помилковим) контрактом ID — відтворення платного запуску, що впав. */
const OLD_CSV = [
  'id,label,type,role,next,yes,no,assoc',
  'START,Клієнт звернувся,start,,S1,,,',
  'S1,Зареєструвати звернення,task,Оператор,S2,,,',
  'S2,Перевірити дані,task,Аналітик,G_S2,,,',
  'G_S2,,xor,,дані повні>S3|дані неповні>S1,,,',
  'S3,Закрити звернення,task,Аналітик,END_S3_1,,,',
  'END_S3_1,,end,,,,,',
].join('\n') + '\n';

/** Таблиця за ВИПРАВЛЕНОЮ інструкцією (v0.7), написана руками за її текстом. */
const NEW_CSV = [
  'id,label,type,role,next,yes,no,assoc',
  'StartEvent_1,Клієнт звернувся,start,,Task_S1,,,',
  'Task_S1,Зареєструвати звернення,task,Оператор,Task_S2,,,',
  'Task_S2,Перевірити дані,task,Аналітик,Gateway_S2,,,',
  'Gateway_S2,,xor,,дані повні>Task_S3|дані неповні>Task_S1,,,',
  'Task_S3,Закрити звернення,task,Аналітик,End_S3_1,,,',
  'End_S3_1,,end,,,,,',
].join('\n') + '\n';

/** Підставний агент: спершу стара таблиця (обидві спроби), потім — виправлена. */
class ScriptedReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (демонстрація, не AI)';
  csv = OLD_CSV;
  async review(): Promise<ModelCallResult> {
    return { output: { findings: [], csv: this.csv }, usage: { input_tokens: 2500, output_tokens: 900 } };
  }
}

const caseId = (() => {
  const db = openDb(dbPath);
  const c = createCase(db, human, 'Кейс: невдала перевірка й відновлення (підставна відповідь, не AI)', 'demo');
  addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: 'Оператор реєструє звернення. Аналітик перевіряє дані: якщо повні — закриває, якщо ні — повертає оператору.', origin: 'synthetic' });
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: FIELDS, coverAllSources: true });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  db.close();
  return c.id;
})();

const db = openDb(dbPath);
const client = new ScriptedReviewClient();
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());
const server = createApp({ db, mode: 'demo', accessCode: CODE, reviewer: { client, policy, instruction: loadBpmnInstruction() } });
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('text=Кейси');
  await page.getByRole('link', { name: /невдала перевірка/ }).click();
  await page.waitForSelector('#tabs');
  await page.getByRole('tab', { name: /Схема/ }).click();
  await page.waitForSelector('text=Смислова перевірка опису');

  // ── 1. Невдалий запуск: справжня причина, порушення, журнал спроб, наступна дія ──
  await page.getByRole('button', { name: 'Запустити смислову перевірку' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('Смислова перевірка не завершилась'), null, { timeout: 30000 });
  const failed = await panel(page).innerText();
  assert.ok(!/undefined/.test(failed), 'у стані «помилка» не має бути «undefined»: ' + failed.slice(0, 400));
  assert.ok(/CSV_START_ID/.test(failed), 'видно порушення відповіді агента: ' + failed.slice(0, 600));
  assert.ok(/StartEvent_1/.test(failed), 'видно, чого саме бракує');
  assert.ok(/Опис, погодження й рішення не змінилися/.test(failed), 'сказано, що нічого не змінилось');
  assert.ok(/Запустити смислову перевірку/.test(failed), 'наступна дія доступна');
  await shot(page, '09-невдала-перевірка-справжня-причина');

  await page.locator('[data-block="review-failed"] details summary').click();
  await page.waitForTimeout(200);
  const journal = await page.locator('[data-block="review-failed"] details').innerText();
  assert.ok(/Спроба 1/.test(journal) && /Спроба 2/.test(journal), 'журнал має обидві спроби: ' + journal.slice(0, 300));
  await shot(page, '10-журнал-спроб');

  // Технічні обмеження лишаються видимими навіть після невдалого запуску.
  assert.ok(await page.locator('[data-block="tech-limits"]').count() > 0, 'технічні обмеження показані');

  // ── 2. Відновлення: відповідь за виправленою інструкцією → схема будується ──
  client.csv = NEW_CSV;
  await page.getByRole('button', { name: 'Запустити смислову перевірку' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('Побудувати схему'), null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Побудувати схему' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('схему побудовано й перевірено'), null, { timeout: 60000 });
  await page.waitForSelector('.djs-container svg', { timeout: 20000 });
  const ok = await panel(page).innerText();
  assert.ok(/cx-bpmn-pipeline-1@/.test(ok), 'видно ланцюг і версію скриптів');
  assert.ok(!/Смислова перевірка не завершилась/.test(ok), 'блок помилки зник');
  await shot(page, '11-відновлення-після-невдалої-перевірки');

  // ── 3. Збій завантаження стану — ОКРЕМИЙ випадок, не «помилка запуску» ──
  await page.route('**/api/cases/*/bpmn/review', (r) => r.abort());
  await page.evaluate(() => (window as unknown as { loadDiagram?: () => void }).loadDiagram?.());
  await page.getByRole('tab', { name: /Питання/ }).click();
  await page.getByRole('tab', { name: /Схема/ }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('не вдалося завантажити'), null, { timeout: 20000 });
  const loadFail = await panel(page).innerText();
  assert.ok(!/undefined/.test(loadFail), 'у збої завантаження не має бути «undefined»');
  assert.ok(/збій зв.язку з сервером/.test(loadFail), 'сказано, що це збій зв’язку, а не результат перевірки');
  assert.ok(/Спробувати ще раз/.test(loadFail), 'є дія «спробувати ще раз»');
  await shot(page, '12-збій-завантаження-стану');

  console.log('\nСценарій невдалої перевірки й відновлення пройдено: 4 знімки в docs/bpmn-3c.');
} finally {
  await browser.close();
  await app.stop();
  db.close();
}
