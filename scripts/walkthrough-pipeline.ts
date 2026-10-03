/**
 * Браузерний наскрізний сценарій нового шляху побудови (D87, D88). Знімки — `docs/bpmn-3c`.
 *
 * Запуск: node --import tsx scripts/walkthrough-pipeline.ts
 *
 * ВАЖЛИВО. «Відповідь агента 2» (знахідки + таблиця процесу) дає ПІДСТАВНИЙ клієнт, оголошений у цьому файлі:
 * справжніх викликів моделі, мережі й ключів немає. Знімки доводять роботу ПРОГРАМИ (перевірка таблиці,
 * скрипти пайплайна, звірка файлів, інтерфейс), а не якість AI.
 *
 * Шлях: погоджений AS-IS → погодження короткого підпису події → смислова перевірка з таблицею →
 * програмна перевірка таблиці → скрипти → звірка .bpmn і .drawio → перегляд і завантаження.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { acceptDraft, addSource, approve, createCase, currentApproval, getVersion, headVersion, saveAnalystVersion, submitForApproval, versionContent, type Actor } from '../src/domain.ts';
import { createApp } from '../src/server.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { makePolicy } from '../src/ai/budget.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { ModelCallResult } from '../src/ai/types.ts';
import { scriptedCsv } from '../tests/csv-fixture.ts';

const OUT = 'docs/bpmn-3c';
mkdirSync(OUT, { recursive: true });
const dbPath = join(mkdtempSync(join(tmpdir(), 'cx-walk-pipe-')), 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };
const CODE = 'walk-pipe-code';

/** Довгий тригер (715 символів) — та сама довжина, що зупинила побудову в особистому прогоні. */
const SENT = 'Клієнт або внутрішня команда повідомляє про потребу змінити умови обслуговування, і цю потребу треба зафіксувати до початку будь-яких дій; джерело звернення буває різним: лист, чат, усна домовленість на зустрічі або запис у системі обліку звернень; ';
const TRIGGER = SENT.repeat(3).slice(0, 715);
const SHORT = 'Надійшла потреба змінити умови обслуговування';

const FIELDS = {
  summary: 'Синтетичний процес: менеджер приймає запит, спеціаліст перевіряє умови, далі або зміна, або відмова.',
  business_context: 'Вигаданий навчальний процес. Не стосується жодного реального кейсу й жодної реальної команди.',
  boundaries: { trigger: TRIGGER, input: 'Запит', completion: 'Умови оновлено або відмовлено', result: 'Рішення за запитом' },
  roles_text: 'Менеджер\nСпеціаліст',
  entry_step_id: 'S1',
  process_name: 'Зміна умов обслуговування (синтетичний процес)',
  steps_text: [
    'S1 | Менеджер | Приймає запит і фіксує його в системі | Запит зафіксовано | S2',
    'S2 | Спеціаліст | Перевіряє умови договору | Умови перевірено | S3 (зміна можлива); S4 (зміна неможлива)',
    'S3 | Спеціаліст | Вносить зміну в договір | Умови оновлено | END',
    'S4 | Менеджер | Повідомляє клієнта про відмову | Клієнта повідомлено | END',
  ].join('\n'),
};

/** Підставний агент 2: знахідок немає, таблиця — сценарна (у продукті її складає модель). */
class ScriptedReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (демонстрація, не AI)';
  async review(input: BpmnReviewInput): Promise<ModelCallResult> {
    return {
      output: { findings: [], csv: scriptedCsv(input.pkg.content, input.pkg.startLabel) },
      usage: { input_tokens: 2500, output_tokens: 900 },
    };
  }
}

const caseId = (() => {
  const db = openDb(dbPath);
  const c = createCase(db, human, 'Кейс: побудова схеми ланцюгом скриптів (підставна відповідь, не AI)', 'demo');
  addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: 'Менеджер приймає запит. Спеціаліст перевіряє умови: якщо зміна можлива — вносить її, інакше менеджер повідомляє про відмову.', origin: 'synthetic' });
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
const server = createApp({ db, mode: 'demo', accessCode: CODE, reviewer: { client: new ScriptedReviewClient(), policy, instruction: loadBpmnInstruction() } });
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
  await page.getByRole('link', { name: /ланцюгом скриптів/ }).click();
  await page.waitForSelector('#tabs');
  await page.getByRole('tab', { name: /Схема/ }).click();
  await page.waitForSelector('text=Смислова перевірка опису');

  // 1. ДО платної перевірки видно: підпис події потребує рішення людини.
  const before = await panel(page).innerText();
  assert.ok(/715/.test(before), 'видно довжину тригера: ' + before.slice(0, 600));
  assert.ok(/Погодити короткий підпис початкової події/.test(before), 'дія названа зрозуміло');
  await shot(page, '01-технічні-обмеження-до-перевірки');

  // 2. Рішення людини про подання: короткий підпис, повний текст лишається.
  await page.getByRole('button', { name: 'Погодити короткий підпис початкової події' }).click();
  await page.waitForSelector('dialog textarea');
  const dialogText = await page.locator('dialog').innerText();
  assert.ok(dialogText.includes(TRIGGER.slice(0, 60)), 'у діалозі показано повний текст тригера');
  assert.ok(/не змінюється/.test(dialogText), 'сказано, що повний текст не змінюється');
  await shot(page, '02-діалог-короткого-підпису', false);
  await page.locator('dialog input[type=text]').fill(SHORT);
  await page.locator('dialog textarea').fill('На схемі потрібен короткий підпис; повний текст тригера лишається в описі й у деталях події.');
  await page.locator('dialog').getByRole('button', { name: 'Погодити підпис' }).click();
  await page.waitForFunction(() => !document.getElementById('panel')!.innerText.includes('Погодити короткий підпис початкової події'), null, { timeout: 20000 });

  // 3. Смислова перевірка (підставна відповідь із таблицею) → побудова.
  await page.getByRole('button', { name: 'Запустити смислову перевірку' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('Побудувати схему'), null, { timeout: 30000 });
  await shot(page, '03-перевірка-пройдена-побудова-доступна');
  await page.getByRole('button', { name: 'Побудувати схему' }).click();
  await page.waitForFunction(() => document.getElementById('panel')!.innerText.includes('схему побудовано й перевірено'), null, { timeout: 60000 });
  await page.waitForSelector('.djs-container svg', { timeout: 20000 });
  const after = await panel(page).innerText();
  assert.ok(/cx-bpmn-pipeline-1@/.test(after), 'видно, яким ланцюгом і якою версією скриптів побудовано: ' + after.slice(0, 400));
  assert.ok(/Повний текст тригера/.test(after), 'повний текст тригера доступний поруч зі схемою');
  assert.ok(/Завантажити таблицю/.test(after), 'таблицю можна завантажити');
  await shot(page, '04-схема-побудована');

  // 4. Повний текст тригера поруч зі схемою.
  await page.locator('[data-block="full-trigger"] summary').click();
  await page.waitForTimeout(300);
  const full = (await page.locator('[data-block="full-trigger"] blockquote').textContent()) ?? '';
  assert.equal(full, TRIGGER, 'повний текст показано дослівно, без скорочення');
  await shot(page, '05-повний-текст-тригера');

  // 5. Файли: обидва формати й таблиця віддаються сервером після перевірок.
  const files: Record<string, string> = {};
  for (const [kind, ext] of [['bpmn', 'bpmn'], ['drawio', 'drawio'], ['csv', 'csv']] as const) {
    const res = await page.request.get(`${app.url}/api/cases/${caseId}/bpmn/file/${kind}`);
    assert.equal(res.status(), 200, kind);
    files[ext] = await res.text();
    writeFileSync(join(OUT, `walkthrough.${ext}`), files[ext]!, 'utf8');
  }
  assert.ok(files.bpmn!.includes(TRIGGER), 'повний текст тригера є у .bpmn');
  assert.ok(files.drawio!.includes(TRIGGER.slice(0, 80)), 'повний текст тригера є у .drawio');
  assert.ok(files.bpmn!.includes(SHORT), 'короткий підпис є у .bpmn');
  assert.match(files.csv!, /^id,label,type,role,next,yes,no,assoc/, 'таблиця віддається як є');

  // 6. Контроль: погоджений опис не змінено.
  const v = getVersion(db, currentApproval(db, caseId)!.version_id);
  assert.equal(versionContent(v).boundaries.trigger, TRIGGER, 'тригер у погодженому описі лишився повним');

  console.log('\nНаскрізний сценарій нового шляху пройдено: 5 знімків і 3 файли в docs/bpmn-3c.');
} finally {
  await browser.close();
  await app.stop();
  db.close();
}
