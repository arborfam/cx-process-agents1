/**
 * Читабельність продуктового інтерфейсу на ДОВГИХ даних (D100).
 *
 * Запуск: node --import tsx scripts/verify-readability.ts [префікс-знімків]
 *
 * Два різні процеси, обидва з довгими текстами (абзаци, перелік усередині тексту, довгі межі,
 * питання з довгим впливом, кроки з деталями й доказами). Усе створюється через інтерфейс.
 * Агенти — підставні клієнти, оголошені в цьому файлі: мережі, ключів і платних викликів немає.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { ScriptedDemoClient } from '../src/runs.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { makePolicy } from '../src/ai/budget.ts';
import { loadConfig, loadPricing } from '../src/config.ts';
import type { BpmnReviewClient, BpmnReviewInput } from '../src/ai/bpmn-review.ts';
import type { AnalystInput, ModelCallResult } from '../src/ai/types.ts';
import { scriptedCsv } from '../tests/csv-fixture.ts';

const PREFIX = process.argv[2] || 'after';
const OUT = 'docs/ux/shots/readability';
mkdirSync(OUT, { recursive: true });
const CODE = 'readability';
const R: { n: string; ok: boolean; d: string }[] = [];
const ck = (n: string, ok: boolean, d = '') => { R.push({ n, ok, d }); };
const need = async (loc: { count(): Promise<number> }, n: string) => {
  const c = await loc.count();
  ck(n + ': елемент присутній', c > 0, `знайдено ${c}`);
  return c > 0;
};

/* ─── Довгі синтетичні тексти: такі ж густі, як у реальних кейсах ─── */
const LONG_SUMMARY = [
  'Процес охоплює шлях звернення клієнта від першого контакту до закриття потреби й передавання висновків у продуктову команду.',
  'Він почався як неформальна практика підтримки, тож частина кроків тримається на домовленостях між людьми, а не на регламенті. Через це однакові звернення можуть пройти різними шляхами залежно від того, хто саме їх узяв у роботу.',
  'Основні вузли, де звернення затримується:',
  '- очікування відповіді від суміжної команди, коли потрібне рішення щодо тарифу;',
  '- повторне уточнення деталей, якщо перший контакт зафіксував лише загальний опис;',
  '- ручне перенесення історії між системами підтримки й обліку.',
  'Описане стосується поточного стану AS-IS і не містить пропозицій щодо того, як процес мав би виглядати.',
].join('\n');
const LONG_CONTEXT = [
  'Процес існує, щоб клієнт отримав рішення за своїм зверненням у передбачуваний строк, а команда продукту — впорядковані сигнали про повторювані причини звернень.',
  'Результат потрібен трьом групам: клієнту (відповідь і дія за його запитом), керівництву підтримки (навантаження й строки), продуктовій команді (перелік причин, які варто прибрати в самому продукті).',
].join('\n\n');
const LONG_IMPACT = 'Від відповіді залежить, чи є після перевірки тарифу окрема гілка повернення звернення на перший рівень підтримки, чи воно одразу переходить до рішення. Без цього послідовність кроків після перевірки тарифу лишається невизначеною, а схема в цьому місці не може бути побудована коректно.';

const PROC: Record<string, { name: string; roles: string[]; steps: { id: string; role: string; action: string; entry: string; result: string; details: string; next: { to: string; condition: string }[] }[] }> = {
  cx: {
    name: 'Опрацювання звернення клієнта (синтетичний приклад)',
    roles: ['Оператор підтримки', 'Старший спеціаліст', 'Менеджер продукту'],
    steps: [
      { id: 'S1', role: 'Оператор підтримки', action: 'Прийняти звернення й зафіксувати суть', entry: 'Надійшло звернення будь-яким каналом', result: 'Звернення зафіксовано з описом і каналом надходження',
        details: 'Фіксуються канал, час, опис словами клієнта й ознака повторності.\nЯкщо звернення повторне, оператор додає посилання на попереднє.', next: [{ to: 'S2', condition: '' }] },
      { id: 'S2', role: 'Оператор підтримки', action: 'Перевірити тариф і права клієнта', entry: 'Звернення зафіксовано', result: 'Відомо, чи покриває тариф запитану дію',
        details: 'Перевірка виконується у двох системах, бо дані про тариф і про права не зведені в одну.', next: [{ to: 'S3', condition: 'тариф покриває запит' }, { to: 'UNKNOWN', condition: 'тариф не покриває запит' }] },
      { id: 'S3', role: 'Старший спеціаліст', action: 'Ухвалити рішення за зверненням', entry: 'Тариф перевірено', result: 'Рішення ухвалено й записано',
        details: '', next: [{ to: 'S4', condition: '' }] },
      { id: 'S4', role: 'Менеджер продукту', action: 'Зафіксувати причину звернення для продукту', entry: 'Рішення ухвалено', result: 'Причину додано до переліку повторюваних',
        details: 'Перелік ведеться вручну; формальної процедури звірки немає.', next: [{ to: 'END', condition: '' }] },
    ],
  },
  proc: {
    name: 'Закупівля обладнання до 50 тис. (синтетичний приклад)',
    roles: ['Ініціатор', 'Закупівельник', 'Фінансовий контролер'],
    steps: [
      { id: 'P1', role: 'Ініціатор', action: 'Оформити потребу в обладнанні', entry: 'Виникла потреба в обладнанні', result: 'Потребу описано із обґрунтуванням',
        details: 'Обґрунтування пишеться вільним текстом; єдиної форми немає.', next: [{ to: 'P2', condition: '' }] },
      { id: 'P2', role: 'Закупівельник', action: 'Зібрати пропозиції постачальників', entry: 'Потребу оформлено', result: 'Є щонайменше дві пропозиції',
        details: 'Якщо постачальник один, потрібне окреме письмове пояснення.', next: [{ to: 'P3', condition: 'пропозицій дві або більше' }, { to: 'UNKNOWN', condition: 'пропозиція одна' }] },
      { id: 'P3', role: 'Фінансовий контролер', action: 'Погодити витрату', entry: 'Пропозиції зібрано', result: 'Витрату погоджено або відхилено',
        details: '', next: [{ to: 'END', condition: '' }] },
    ],
  },
};

const analyst = new ScriptedDemoClient((input: AnalystInput) => {
  const refs = input.sources.map((s) => s.id);
  const kind = input.sources.some((s) => /закупівл/i.test(s.title) || /постачальник/i.test(s.text)) ? 'proc' : 'cx';
  const p = PROC[kind]!;
  const base = structuredClone(input.head_content);
  base.summary = kind === 'cx' ? LONG_SUMMARY : LONG_SUMMARY.replace(/звернення клієнта/g, 'заявки на закупівлю');
  base.business_context = LONG_CONTEXT;
  base.boundaries = kind === 'cx'
    ? { trigger: 'Клієнт звернувся будь-яким каналом: чат, пошта, телефон або форма у застосунку', input: 'Опис потреби словами клієнта', completion: 'Клієнт отримав рішення, а причину звернення записано для продуктової команди', result: 'Рішення за зверненням і запис причини' }
    : { trigger: 'Підрозділ оформив потребу в обладнанні вартістю до 50 тис.', input: 'Опис потреби з обґрунтуванням', completion: 'Витрату погоджено або відхилено з письмовим поясненням', result: 'Рішення щодо витрати' };
  base.roles = p.roles;
  base.process_name = '';
  base.steps = p.steps.map((st) => ({
    id: st.id, role: st.role, action: st.action, entry_condition: st.entry, input_artifact: '', result: st.result,
    details: st.details || undefined, next: st.next, source_ids: refs,
  }));
  base.claims = kind === 'cx'
    ? [
      { id: 'C1', type: 'source_fact', text: 'Перевірка тарифу виконується у двох різних системах, бо дані не зведені.', scope: 'крок перевірки тарифу', source_id: refs[0] ?? null, quote: 'у двох системах' },
      { id: 'C2', type: 'hypothesis', text: 'Частина повторних звернень виникає через неповну фіксацію на першому контакті.', scope: 'весь процес', source_id: null, quote: '' },
      { id: 'C3', type: 'unknown', text: 'Що відбувається, коли тариф не покриває запит.', scope: 'перехід після перевірки тарифу', source_id: null, quote: '' },
    ]
    : [
      { id: 'C1', type: 'source_fact', text: 'Коли постачальник один, потрібне окреме письмове пояснення.', scope: 'крок збирання пропозицій', source_id: refs[0] ?? null, quote: 'потрібне письмове пояснення' },
      { id: 'C2', type: 'hypothesis', text: 'Частина заявок затримується через вільну форму обґрунтування.', scope: 'весь процес', source_id: null, quote: '' },
      { id: 'C3', type: 'unknown', text: 'Що відбувається, коли пропозиція лише одна.', scope: 'перехід після збирання пропозицій', source_id: null, quote: '' },
    ];
  base.hypotheses = [];
  base.problems = [{ id: 'PR1', symptom: 'Однакові звернення проходять різними шляхами', cause: '', cause_status: 'not_established', impact: 'Строк відповіді коливається; метрики немає', impact_is_estimate: false }];
  const q = (id: string, text: string, impact: string, critical: boolean, addressee: string, affects: { step_id: string; condition: string }[]) => ({
    id, text, impact, critical, addressee, status: 'open' as const, answer: '', closed_by_source_id: null,
    origin: 'agent' as const, criticality_note: '',
    affects_transitions: affects.map((a) => ({ ...a, kind: 'direction' as const })),
  });
  base.questions = [
    q('Q1', kind === 'cx' ? 'Що відбувається зі зверненням, коли тариф не покриває запит?' : 'Що відбувається із заявкою, коли пропозиція лише одна?', LONG_IMPACT, true, 'керівництво підрозділу',
      [{ step_id: kind === 'cx' ? 'S2' : 'P2', condition: kind === 'cx' ? 'тариф не покриває запит' : 'пропозиція одна' }]),
    q('Q2', kind === 'cx' ? 'Хто відповідає за перелік повторюваних причин?' : 'Хто веде перелік погоджених постачальників?', 'Впливає на те, чий крок описувати як відповідальний за фіксацію причини.', false, '', []),
  ];
  return base;
});

class ReviewClient implements BpmnReviewClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ КЛІЄНТ (не AI)';
  async review(input: BpmnReviewInput): Promise<ModelCallResult> {
    return { output: { findings: [], csv: scriptedCsv(input.pkg.content, input.pkg.startLabel) }, usage: { input_tokens: 10, output_tokens: 10 } };
  }
}

const db = openDb(join(mkdtempSync(join(tmpdir(), 'cx-read-')), 'cx.sqlite'));
const policy = makePolicy(loadConfig({
  MODEL_MODE: 'real', ANTHROPIC_API_KEY: 'sk-ant-api03-DEMODEMODEMODEMO', CX_MODEL: 'claude-opus-5-5',
  CX_BUDGET_USD_TOTAL: '10', CX_BUDGET_USD_PER_RUN: '1.5',
}).model!, loadPricing());
const server = createApp({
  db, mode: 'demo', accessCode: CODE,
  analyst: { client: analyst },
  reviewer: { client: new ReviewClient(), policy, instruction: loadBpmnInstruction() },
});
const app = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }));
});

const errs: string[] = [];
const metrics: Record<string, number> = {};
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'uk-UA' });
  const page: Page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  // Порівняльний прогін «до» бачить інший інтерфейс: відсутній блок має давати порожній текст,
  // а не зупиняти знімки. Самі твердження від цього не слабшають — порожнє не збігається з очікуваним.
  const T = async (sel: string) => {
    const t = await page.locator(sel).first().textContent({ timeout: 2500 }).catch(() => '');
    return (t || '').replace(/\s+/g, ' ').trim();
  };
  const shot = async (name: string, full = true) => page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png`, fullPage: full });
  const pageH = async () => Number(await page.evaluate('document.getElementById("main").scrollHeight'));

  await page.goto(`${app.url}/login?code=${CODE}`);
  await page.waitForSelector('#newtitle');

  const build = async (title: string, srcTitle: string, srcText: string) => {
    await page.goto(`${app.url}/#/`);
    await page.waitForSelector('#newtitle');
    await page.fill('#newtitle', title);
    await page.getByRole('button', { name: 'Створити кейс' }).click();
    await page.waitForSelector('#toptabs', { timeout: 15000 });
    const id = String(await page.evaluate('location.hash')).replace('#/case/', '');
    await page.getByRole('tab', { name: /^Джерела/ }).click();
    await page.waitForTimeout(300);
    await page.fill('[data-draft="src-title"]', srcTitle);
    await page.fill('[data-draft="src-content"]', srcText);
    await page.getByRole('button', { name: 'Додати джерело' }).click();
    await page.waitForTimeout(800);
    await page.locator('[data-block="analysis"] button').first().click();
    await page.waitForTimeout(2600);
    return id;
  };

  const cxText = 'Оператор приймає звернення й фіксує суть. Далі перевіряємо у двох системах тариф і права клієнта. Якщо тариф покриває запит, рішення ухвалює старший спеціаліст. Причину звернення менеджер продукту додає до переліку повторюваних.';
  const procText = 'Ініціатор оформлює потребу в обладнанні. Закупівельник збирає пропозиції постачальників: якщо постачальник один, потрібне письмове пояснення. Фінансовий контролер погоджує витрату.';
  const cx = await build('Підтримка клієнтів (синтетичний, довгі тексти)', 'Інтерв’ю з підтримкою (синтетичне)', cxText);
  const proc = await build('Закупівлі до 50 тис. (синтетичний, довгі тексти)', 'Інтерв’ю про закупівлі (синтетичне)', procText);

  for (const [key, id] of [['cx', cx], ['proc', proc]] as const) {
    await page.goto(`${app.url}/#/case/${id}`);
    await page.waitForSelector('#toptabs'); await page.waitForTimeout(600);

    /* ── Огляд ── */
    await page.getByRole('tab', { name: 'Огляд' }).click(); await page.waitForTimeout(400);
    metrics[`${key}-огляд-висота`] = await pageH();
    await shot(`${key}-1-огляд`);
    const brief = await T('[data-block="brief"]');
    ck(`${key}: огляд не перетворюється на звіт`, metrics[`${key}-огляд-висота`]! < 1800, `висота ${metrics[`${key}-огляд-висота`]} px`);
    ck(`${key}: у «Коротко» немає довгого абзацу опису`, !brief.includes('Основні вузли'), brief.slice(0, 110));
    ck(`${key}: «Коротко» показує початок і завершення окремо`, brief.includes('Початок') && brief.includes('Завершення'));
    ck(`${key}: з огляду є перехід до повного опису`, (await T('[data-block="brief"] .actions')).includes('Повний опис процесу'));
    ck(`${key}: критичне питання видно без розкриття`, (await page.locator('.critline').count()) > 0 && (await T('.critline')).includes('Q1'));
    await need(page.locator('[data-block="attention"] .att-group'), `${key}: «Потребує уваги» розділено за типом`);
    ck(`${key}: «Що змінилося» подано списком`, (await page.locator('[data-block="changes"] ul.tight li').count()) > 0);

    /* ── Бізнес-контекст ── */
    await page.getByRole('tab', { name: 'AS-IS' }).click();
    await page.locator('.subtabs .tab', { hasText: 'Бізнес-контекст' }).click();
    await page.waitForTimeout(400);
    await shot(`${key}-2-бізнес-контекст`);
    const ctxTxt = await T('#panel');
    ck(`${key}: повний опис доступний на вкладці`, ctxTxt.includes('Основні вузли'), ctxTxt.slice(0, 80));
    ck(`${key}: перелік усередині тексту став списком`, (await page.locator('#panel .prose ul li').count()) >= 3,
      String(await page.locator('#panel .prose ul li').count()));
    ck(`${key}: мета, межі й учасники розділені`, ['Мета', 'Межі процесу', 'Учасники'].every((h) => ctxTxt.includes(h)));

    /* ── Кроки ── */
    await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click(); await page.waitForTimeout(400);
    await shot(`${key}-3-кроки`);
    if (await need(page.locator('ol.steps > li'), `${key}: кроки подано окремими блоками`)) {
      const first = await T('ol.steps > li');
      ck(`${key}: у кроці читаються дія, умова входу, результат і перехід`,
        ['Умова входу', 'Результат', 'Далі'].every((h) => first.includes(h)), first.slice(0, 120));
      ck(`${key}: умова переходу подана окремим рядком`, (await page.locator('ol.steps .cond').count()) > 0);
    }

    /* ── Твердження ── */
    await page.locator('.subtabs .tab', { hasText: 'Твердження' }).click(); await page.waitForTimeout(400);
    const claimTxt = await T('#panel');
    ck(`${key}: типи тверджень названо явно`,
      ['Факт із джерела', 'Гіпотеза', 'Невідоме'].every((t) => claimTxt.includes(t)), claimTxt.slice(0, 120));
    ck(`${key}: доказ названо джерелом, а не ідентифікатором`, claimTxt.includes('Інтерв’ю') && !/src_[0-9a-f]/.test(claimTxt), claimTxt.slice(0, 120));

    /* ── Питання ── */
    await page.locator('.subtabs .tab', { hasText: 'Питання' }).click(); await page.waitForTimeout(400);
    await shot(`${key}-4-питання`);
    const qTxt = await T('#panel');
    ck(`${key}: питання має «чому важливе» і «стан»`, qTxt.includes('Чому важливе') && qTxt.includes('Стан'), qTxt.slice(0, 120));
    ck(`${key}: критичність питання видно одразу`, qTxt.includes('Критичне'));

    /* ── Джерела ── */
    await page.getByRole('tab', { name: /^Джерела/ }).click(); await page.waitForTimeout(400);
    const sTxt = await T('#main');
    ck(`${key}: джерело показано назвою, типом, походженням і станом`,
      ['Інтерв’ю', 'Транскрипт', 'Походження', 'Опрацювання'].every((h) => sTxt.includes(h)), sTxt.slice(0, 140));
    ck(`${key}: сирих ідентифікаторів джерел у тексті немає`, !/src_[0-9a-f]{6}/.test(sTxt));

    /* ── універсальні формулювання ── */
    for (const tab of ['Огляд', 'AS-IS', 'Джерела', 'Історія']) {
      await page.getByRole('tab', { name: tab === 'Джерела' ? /^Джерела/ : tab }).click();
      await page.waitForTimeout(300);
      const t = await T('#app');
      ck(`${key}: на вкладці «${tab}» немає підписів, залежних від статі`,
        !/аналітикин|погодила|вирішила|редагувала|врахувала|прийнята аналітиком/i.test(t),
        (t.match(/аналітикин\S*|погодила|вирішила|редагувала|врахувала/i) || [''])[0]);
    }
    await shot(`${key}-5-історія`);
    ck(`${key}: історія подана короткими записами`, (await page.locator('[data-block="history-version"]').count()) > 0);
  }

  /* ── Вузькі екрани: горизонтального переповнення бути не повинно ── */
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [key, id] of [['cx', cx], ['proc', proc]] as const) {
      await page.goto(`${app.url}/#/case/${id}`);
      await page.waitForSelector('#toptabs'); await page.waitForTimeout(400);
      for (const tab of ['Огляд', 'AS-IS', 'Джерела', 'Історія']) {
        await page.getByRole('tab', { name: tab === 'Джерела' ? /^Джерела/ : tab }).click();
        await page.waitForTimeout(250);
        const over = Number(await page.evaluate('document.documentElement.scrollWidth'));
        ck(`${w}px · ${key} · ${tab}: немає горизонтального переповнення`, over <= w + 1, `${over} > ${w}`);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ── Схема: стан і результат одразу вгорі ── */
  await page.goto(`${app.url}/#/case/${cx}`);
  await page.waitForSelector('#toptabs'); await page.waitForTimeout(500);
  await page.getByRole('tab', { name: 'AS-IS' }).click();
  await page.locator('.subtabs .tab', { hasText: 'Кроки' }).click();
  await page.waitForTimeout(400);
  await page.evaluate('document.querySelector(\'[data-block="edit-inline"]\').open = true');
  await page.selectOption('[data-block="edit-inline"] select[name="entry"]', 'S1');
  await page.fill('[data-block="edit-inline"] input[name="process_name"]', PROC.cx!.name);
  await page.getByRole('button', { name: 'Зберегти як нову версію' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: 'Схема' }).click(); await page.waitForTimeout(1200);
  await shot('схема-до-погодження');
  const dTxt = await T('#main');
  ck('схема: стан перевірки й стан схеми видно вгорі', dTxt.indexOf('Смислова перевірка') < 60, dTxt.slice(0, 120));
  await need(page.locator('[data-block="diagram-status"]'), 'схема: компактний стан угорі');
  ck('схема: службові коди не переривають текст причин', !/NOT_APPROVED_STATE|NO_APPROVAL/.test(dTxt), (dTxt.match(/[A-Z_]{8,}/) || [''])[0]);

  await ctx.close();
} finally {
  await browser.close(); await app.stop(); db.close();
}
const failed = R.filter((x) => !x.ok);
console.log(JSON.stringify({ prefix: PREFIX, metrics, failed, passed: R.length - failed.length, total: R.length, errors: [...new Set(errs)].slice(0, 6) }, null, 1));
if (failed.length || errs.length) process.exitCode = 1;
