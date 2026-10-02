/**
 * Довгий зовнішній підпис початкової події (тригер процесу) — D86.
 *
 * Блокер особистого прогону: побудова зупинилась на `LABEL_TOO_LONG` (тригер 715 символів, межа 600), хоча
 * смислова перевірка пройдена й рішення людини прийняті. Виправлення — не «підняти константу»: генератор
 * рахує рамку зовнішнього підпису з реального переносу тексту, збільшує доріжку й лишає підпис дослівним;
 * у `.drawio` ширина колонки переносу (`labelWidth`) береться з тієї самої рамки `.bpmn`.
 *
 * Тут перевіряється: 715 символів проходять; текст дослівний в обох форматах; рамка вміщує всі рядки;
 * накладань і обрізань немає; зворотна звірка обох форматів проходить; межі для підписів ВСЕРЕДИНІ фігур
 * не послаблені; повторна технічна побудова використовує збережену перевірку без виклику моделі.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { readBpmn } from '../src/bpmn/read.ts';
import { readDrawio } from '../src/bpmn/drawio.ts';
import { parseStyle } from '../src/bpmn/drawio-style.ts';
import { fixtureToPackage, type Fixture } from '../src/bpmn/fixture.ts';
import { LINE_HEIGHT, MAX_EVENT_LABEL_CHARS, MAX_LABEL_CHARS, wrapLines } from '../src/bpmn/text.ts';
import { analyzePackage } from '../src/bpmn/validate.ts';
import { buildArtifact, technicalLimits } from '../src/bpmn-artifacts.ts';
import { all } from '../src/db.ts';
import { getCaseReview, runBpmnReviewForCase } from '../src/review-runs.ts';
import {
  acceptDraft, approve, headVersion, insertVersion, returnToResearch, submitForApproval, versionContent,
} from '../src/domain.ts';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, okStep, policyOf, reviewer } from './review-helpers.ts';

/** Текст тригера на рівно 715 символів — довжина з блокера. */
const SENT = 'Клієнт або внутрішня команда повідомляє про потребу змінити умови обслуговування, і цю потребу треба зафіксувати до початку будь-яких дій; джерело звернення буває різним: лист, чат, усна домовленість на зустрічі або запис у системі обліку звернень; ';
const TRIGGER = SENT.repeat(3).slice(0, 715);

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  id: 'long-trigger', title: 'Довгий тригер', created_without_ai: true, synthetic: true,
  what_it_tests: 'Зовнішній підпис початкової події на 715 символів зберігається дослівно й лишається читабельним.',
  expect: { status: 'ok' }, version_id: 'TEST-LONG-V1', process_name: 'Зміна умов обслуговування (синтетичний процес)',
  trigger: TRIGGER, roles: ['Менеджер', 'Оператор'], entry_step_id: 'S1',
  steps: [
    { id: 'S1', role: 'Менеджер', action: 'Реєструє звернення клієнта', next: [{ to: 'S2', condition: '' }] },
    { id: 'S2', role: 'Оператор', action: 'Вносить зміну в договір', next: [{ to: 'END', condition: '' }] },
  ],
  ...over,
});

// ───────── 1. Відтворення випадку: 715 символів ─────────

test('1. Тригер на 715 символів: до виправлення це був блокер, тепер схема будується', async () => {
  assert.ok(TRIGGER.length === 715 && TRIGGER.length > MAX_LABEL_CHARS, `довжина ${TRIGGER.length}`);
  const r = await generateBpmn(fixtureToPackage(fixture()));
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 600));
});

test('1. Підпис збережено ДОСЛІВНО в .bpmn і в .drawio', async () => {
  const r = await generateBpmn(fixtureToPackage(fixture()));
  assert.ok(r.status === 'ok');
  const { model } = readBpmn(r.bpmn);
  const start = [...model!.nodes.values()].find((n) => n.tag === 'startEvent')!;
  assert.equal(start.name, TRIGGER, 'текст у .bpmn дослівний, без скорочення');
  const d = readDrawio(r.drawio.xml!);
  const cell = d.cells.find((c) => c.id === start.id)!;
  assert.equal(cell.value, TRIGGER, 'текст у .drawio дослівний');
});

test('1. Рамка підпису вміщує ВСІ рядки переносу (нічого не обрізано)', async () => {
  const r = await generateBpmn(fixtureToPackage(fixture()));
  assert.ok(r.status === 'ok');
  const { model } = readBpmn(r.bpmn);
  const start = [...model!.nodes.values()].find((n) => n.tag === 'startEvent')!;
  const box = model!.shapeLabels.get(start.id);
  assert.ok(box, 'у початкової події має бути рамка зовнішнього підпису');
  const lines = wrapLines(TRIGGER, box!.w - 8).length;
  assert.ok(lines >= 15, `очікували багаторядковий підпис, отримали ${lines}`);
  assert.ok(lines * LINE_HEIGHT <= box!.h, `потрібно ${Math.ceil(lines * LINE_HEIGHT)} px, рамка ${box!.h} px`);
  assert.ok(box!.w >= 100, `рамка завузька: ${box!.w}`);
});

test('1. Жодних попереджень про обрізання чи накладання підписів', async () => {
  const r = await generateBpmn(fixtureToPackage(fixture()));
  assert.ok(r.status === 'ok');
  const codes = [...r.verification.warnings, ...r.verification.errors].map((i) => i.code);
  for (const bad of ['LABEL_TRUNCATED', 'LABEL_MAY_OVERFLOW', 'LABEL_OVERLAP', 'SHAPE_OVERLAP']) {
    assert.ok(!codes.includes(bad), `${bad} не має бути: ${JSON.stringify([...r.verification.warnings, ...r.verification.errors]).slice(0, 400)}`);
  }
  assert.equal(r.verification.errors.length, 0);
});

test('1. Зворотна звірка обох форматів проходить; ширина колонки .drawio = рамці .bpmn', async () => {
  const r = await generateBpmn(fixtureToPackage(fixture()));
  assert.ok(r.status === 'ok');
  assert.equal(r.drawio.status, 'ok', JSON.stringify(r.drawio.issues).slice(0, 400));
  assert.equal(r.drawio.issues.filter((i) => i.severity === 'error').length, 0);
  const { model } = readBpmn(r.bpmn);
  const start = [...model!.nodes.values()].find((n) => n.tag === 'startEvent')!;
  const box = model!.shapeLabels.get(start.id)!;
  const cell = readDrawio(r.drawio.xml!).cells.find((c) => c.id === start.id)!;
  const style = parseStyle(cell.style).map;
  assert.equal(style.get('labelWidth'), String(Math.round(box.w)), 'колонка переносу в .drawio має дорівнювати рамці .bpmn');
  assert.equal(style.get('whiteSpace'), 'wrap');
});

// ───────── 2. Межі не послаблені ─────────

test('2. Довший за межу зовнішній підпис — чесна відмова, а не мовчазне обрізання', async () => {
  const over = 'я'.repeat(MAX_EVENT_LABEL_CHARS + 1);
  const r = await generateBpmn(fixtureToPackage(fixture({ trigger: over, expect: { status: 'unsupported' } })));
  assert.equal(r.status, 'unsupported');
  const f = r.findings.find((x) => x.code === 'LABEL_TOO_LONG')!;
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f.message, new RegExp(String(MAX_EVENT_LABEL_CHARS)));
  assert.match(f.message, /не буде скорочено/);
});

test('2. Для підписів УСЕРЕДИНІ фігур межа лишилась попередньою (600)', async () => {
  const long = 'я'.repeat(MAX_LABEL_CHARS + 1);
  const r = await generateBpmn(fixtureToPackage(fixture({
    expect: { status: 'unsupported' },
    steps: [
      { id: 'S1', role: 'Менеджер', action: long, next: [{ to: 'S2', condition: '' }] },
      { id: 'S2', role: 'Оператор', action: 'Вносить зміну в договір', next: [{ to: 'END', condition: '' }] },
    ],
  })));
  assert.equal(r.status, 'unsupported');
  assert.ok(r.findings.some((x) => x.code === 'LABEL_TOO_LONG' && /дія/i.test(x.message)), JSON.stringify(r.findings).slice(0, 400));
  assert.equal(MAX_LABEL_CHARS, 600, 'межа підписів усередині фігур не піднімалась');
});

// ───────── 3. Повторна технічна побудова — без нового виклику моделі ─────────

/** Погоджений кейс, у якому тригер — довгий (як у блокері). */
function approvedWithLongTrigger(db = freshDb()) {
  const { c } = approvedCase(db);
  returnToResearch(db, human, c.id, 'уточнення тригера (тест)');
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  content.boundaries = { ...content.boundaries, trigger: TRIGGER };
  const v = insertVersion(db, {
    caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: head.id,
    covered: JSON.parse(head.covered_json) as string[], owned: [],
  });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  return { db, caseId: c.id };
}

test('3. Побудова з довгим тригером у застосунку: одна смислова перевірка, повтор — без виклику моделі', async () => {
  const { db, caseId } = approvedWithLongTrigger();
  const client = new FakeReviewClient([okStep([])]);
  const rev = await runBpmnReviewForCase(db, human, caseId, reviewer(client, policyOf()));
  assert.ok(rev.ok, JSON.stringify(rev));
  assert.equal(client.calls, 1);
  assert.ok(getCaseReview(db, caseId).gate!.ok);

  const first = await buildArtifact(db, human, caseId);
  assert.equal(first.artifact.status, 'ok', JSON.stringify(first.artifact).slice(0, 300));
  assert.equal(first.reused, false);
  assert.equal(client.calls, 1, 'побудова моделі не викликає');

  const again = await buildArtifact(db, human, caseId);
  assert.equal(again.reused, true, 'повторна побудова бере готовий результат');
  assert.equal(client.calls, 1, 'повторна побудова теж без виклику моделі');
  assert.equal(getCaseReview(db, caseId).reviewId, rev.ok ? (rev as { reviewId: string }).reviewId : '', 'використано ту саму збережену перевірку');
});

// ───────── 4. Технічні обмеження видно ДО платної перевірки ─────────

test('4. Технічні обмеження видно ДО перевірки: лише читання, без схеми й файлів', async () => {
  const { db, caseId } = approvedWithLongTrigger();
  // Перевірки ще не було — а обмеження вже видно (і їх немає, бо довгий тригер тепер підтримується).
  assert.equal(getCaseReview(db, caseId).state, 'none');
  const tl = technicalLimits(db, caseId);
  assert.equal(tl.available, true, tl.reason ?? '');
  assert.deepEqual([tl.blocking, tl.unsupported], [[], []]);
  assert.ok(!JSON.stringify(tl).includes('bpmndi'), 'жодної схеми чи файлу в технічному розборі немає');
  assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0, 'нічого не збудовано');

  // Той самий розбір бачить обмеження, яких модель не виправить.
  const over = fixtureToPackage(fixture({ trigger: 'я'.repeat(MAX_EVENT_LABEL_CHARS + 1), expect: { status: 'unsupported' } }));
  assert.ok(analyzePackage(over).unsupported.some((i) => i.code === 'LABEL_TOO_LONG'));
});

test('4. Технічний розбір пакета працює без моделі й називає обмеження до запуску перевірки', () => {
  const over = fixtureToPackage(fixture({ trigger: 'я'.repeat(MAX_EVENT_LABEL_CHARS + 1), expect: { status: 'unsupported' } }));
  const a = analyzePackage(over);
  assert.ok(a.unsupported.some((i) => i.code === 'LABEL_TOO_LONG'), JSON.stringify(a.unsupported));
  // Той самий розбір на коректному пакеті обмежень не вигадує.
  const okPkg = analyzePackage(fixtureToPackage(fixture()));
  assert.equal(okPkg.unsupported.length, 0);
  assert.equal(okPkg.blocking.length, 0);
});
