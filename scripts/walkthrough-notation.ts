/**
 * Проходить D61/D62 у справжньому браузері (Chromium) і знімає екрани в docs/demo/22–26.
 * Запуск: node --import tsx scripts/walkthrough-notation.ts
 * Дані синтетичні; база тимчасова; жодних викликів моделі. «Пропозицію агента» в базі створено програмно (не AI) —
 * це лише щоб показати інтерфейс рішення людини.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb, run } from '../src/db.ts';
import { acceptDraft, addNotationRequirement, addSource, createCase, headVersion, insertVersion, saveAnalystVersion, submitForApproval, versionContent, type Actor, type EditFields } from '../src/domain.ts';

const OUT = 'docs/demo';
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cx-walk-notation-'));
const dbPath = join(dir, 'cx.sqlite');
const human: Actor = { kind: 'human', name: 'Аналітикиня' };

const FIELDS: EditFields = {
  summary: 'Синтетичний процес зміни умов: менеджер приймає запит, оператор вносить зміну.',
  business_context: 'Навчальний синтетичний приклад.',
  boundaries: { trigger: 'Запит клієнта', input: 'Заявка', completion: 'Умови оновлено', result: 'Оновлений договір' },
  roles_text: 'Менеджер\nОператор', entry_step_id: 'S1',
  steps_text: ['S1 | Менеджер | Приймає запит | Заявка в CRM | S2', 'S2 | Оператор | Вносить зміну | Умови оновлено | END'].join('\n'),
  problems_text: 'P1 | Довге очікування | Клієнти чекають довше очікуваного (оцінка, метрик немає)',
};
const SRC_TEXT = 'Менеджер приймає запит. Оператор вносить зміну лише після того, як мине три дні очікування відповіді клієнта.';

// ── підготовка бази (до запуску застосунку) ──
{
  const db = openDb(dbPath);
  const mk = (title: string, fields: EditFields) => {
    const c = createCase(db, human, title, 'demo');
    addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю (синтетичне)', content: SRC_TEXT, origin: 'synthetic' });
    const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields, coverAllSources: true });
    return { c, v };
  };
  // A: пропозиція агента щодо нотації очікує рішення
  const a = mk('Кейс A: пропозиція агента', { ...FIELDS, process_name: 'Зміна умов договору' });
  const srcId = (db.prepare('SELECT id FROM source WHERE case_id = ?').get(a.c.id) as { id: string }).id;
  const content = versionContent(a.v);
  content.notation_requirements = [{ id: 'N1', kind: 'timer', step_id: 'S2', detail: 'Зміна вноситься лише після очікування три дні', origin: 'agent', status: 'proposed',
    evidence_source_id: srcId, evidence_quote: 'лише після того, як мине три дні очікування', decided_by: '', decision_note: '' }];
  const av = insertVersion(db, { caseId: a.c.id, content, createdBy: 'agent', actorName: 'analyst-agent', parentId: a.v.id, covered: JSON.parse(a.v.covered_json), owned: [], note: 'ПІДСТАВНА пропозиція (не AI) для показу інтерфейсу' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', av.id, a.c.id);
  // B: старий погоджений запис без назви процесу
  const b = mk('Кейс B: старий запис без назви', FIELDS);
  const legacy = structuredClone(versionContent(b.v));
  delete legacy.process_name;
  const lv = insertVersion(db, { caseId: b.c.id, content: legacy, createdBy: 'analyst', actorName: 'Аналітикиня', parentId: b.v.id, covered: JSON.parse(b.v.covered_json), owned: [], note: 'імітація старого запису (до D62)' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', lv.id, b.c.id);
  acceptDraft(db, human, b.c.id, lv.id);
  run(db, 'UPDATE "case" SET state = ? WHERE id = ?', 'approved', b.c.id);
  run(db, 'INSERT INTO approval (id, case_id, version_id, content_hash, approver, note, created_at) VALUES (?,?,?,?,?,?,?)', 'appr_legacy_demo', b.c.id, lv.id, lv.content_hash, 'Аналітикиня', '', new Date().toISOString());
  // C: готовий до погодження, з підтвердженою людиною вимогою до нотації
  const c = mk('Кейс C: на погодженні', { ...FIELDS, process_name: 'Зміна умов договору' });
  const cv = addNotationRequirement(db, human, c.c.id, { baseVersionId: c.v.id, kind: 'parallel_branches', stepId: 'S1', detail: 'Менеджер одночасно реєструє запит і повідомляє клієнта' });
  acceptDraft(db, human, c.c.id, cv.id);
  submitForApproval(db, human, c.c.id);
  db.close();
}

function startApp(): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MODEL_MODE: 'demo', PORT: '0', CX_DB_PATH: dbPath, CX_ACCESS_CODE: 'walk-code' };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env });
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

  // ── A: пропозиція агента щодо нотації ──
  await page.getByRole('link', { name: /Кейс A/ }).click();
  await page.waitForSelector('text=Критичні прогалини');
  const essence = await page.locator('[data-block=essence]').innerText();
  assert.ok(essence.includes('Назва процесу (напис на схемі): Зміна умов договору'), 'назва процесу видима в «Суті»: ' + essence);
  assert.ok(!essence.includes('Кейс A'), 'назва кейсу не підставляється як назва процесу');
  const gaps = await page.locator('[data-block=gaps]').innerText();
  assert.ok(gaps.includes('Пропозиція щодо нотації без рішення'), 'пропозиція — критична прогалина: ' + gaps);
  await tab(page, 'Бізнес-контекст');
  const panel = await page.locator('#panel').innerText();
  assert.ok(panel.includes('Назва процесу') && panel.includes('Вимоги до нотації') && panel.includes('очікує рішення') && panel.includes('цитату знайдено'), 'вкладка показує назву, вимоги, статус і перевірену цитату');
  assert.ok(panel.includes('Порожній список означає «не зазначено»'), 'пояснення «не зазначено»');
  await shot(page, '22-пропозиція-агента-щодо-нотації');
  await page.getByRole('button', { name: 'Підтвердити…' }).click();
  await shot(page, '23-діалог-підтвердження-вимоги', false);
  await page.getByRole('button', { name: 'Підтвердити', exact: true }).click();
  await page.waitForSelector('text=підтверджено');
  assert.ok((await page.locator('#panel').innerText()).includes('N1 · підтверджено'), 'після рішення вимога підтверджена (нова версія)');
  assert.ok(await page.locator('[data-block=gaps]').innerText().then((t) => !t.includes('Пропозиція щодо нотації без рішення')), 'прогалина зникла після рішення людини');

  // додавання вимоги вручну
  await page.locator('[data-block=notation] select[name=kind]').selectOption('message');
  await page.locator('[data-block=notation] input[name=detail]').fill('Повідомлення між відділами в окремій системі');
  await page.getByRole('button', { name: /Додати вимогу/ }).click();
  await page.waitForSelector('text=N2 · підтверджено');
  console.log('вимоги: підтвердження й додавання вручну — ок');

  // ── B: старий погоджений запис без назви ──
  await page.goto(`${app.url}/#/`);
  await page.getByRole('link', { name: /Кейс B/ }).click();
  await page.waitForSelector('text=Рекомендований наступний крок');
  const bEssence = await page.locator('[data-block=essence]').innerText();
  assert.ok(/не зазначено/.test(bEssence), 'для старого запису: назва «не зазначено»');
  assert.ok(!bEssence.includes('Кейс B: старий запис без назви') || /не підставляється/.test(bEssence), 'назву кейсу не підставлено');
  assert.ok((await page.locator('.nextaction').innerText()).includes('Уточнити назву процесу'), 'наступна дія — уточнити назву процесу');
  await shot(page, '24-старий-запис-без-назви-потрібне-уточнення');
  await page.getByRole('button', { name: 'Уточнити назву процесу' }).click();
  await page.waitForSelector('#process-name-input');
  await page.locator('#process-name-input').fill('Зміна умов обслуговування');
  await page.getByRole('button', { name: /Зберегти як нову версію/ }).click();
  await page.waitForSelector('text=Версія 4');
  assert.ok((await page.locator('[data-block=essence]').innerText()).includes('Назва процесу (напис на схемі): Зміна умов обслуговування'));
  console.log('уточнення назви → нова версія: ок');
  await shot(page, '25-після-уточнення-назви-нова-версія');

  // ── C: діалог погодження показує назву й вимоги ──
  await page.goto(`${app.url}/#/`);
  await page.getByRole('link', { name: /Кейс C/ }).click();
  await page.waitForSelector('text=Погодити цю версію AS-IS');
  await page.getByRole('button', { name: 'Погодити цю версію AS-IS' }).click();
  const facts = await page.locator('dialog [data-block=approve-facts]').innerText();
  assert.ok(facts.includes('Зміна умов договору'), 'у діалозі погодження видно назву процесу: ' + facts);
  assert.ok(facts.includes('паралельні гілки') && facts.includes('підтверджено'), 'і вимоги до нотації: ' + facts);
  await shot(page, '26-діалог-погодження-назва-процесу-і-вимоги', false);
  console.log('ПРОХОДЖЕННЯ D61/D62: усі перевірки браузера пройдені');
} finally {
  await browser.close();
  await app.stop();
}
