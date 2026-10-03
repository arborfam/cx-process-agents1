/**
 * Погоджений короткий підпис початкової події (D88) і довгий тригер (блокер 715 символів).
 *
 * Що саме доводиться:
 *  1. довгий тригер НЕ скорочується мовчки: без рішення людини побудова чесно зупиняється, а причина
 *     видно ще ДО платної смислової перевірки;
 *  2. короткий підпис — явне рішення людини з поясненням; агент його ухвалити не може;
 *  3. після рішення схема будується, на події стоїть короткий підпис, а ПОВНИЙ текст тригера
 *     лишається дослівно: у погодженому описі, у деталях події `.bpmn` і в підказці `.drawio`;
 *  4. межі підписів не послаблені; рішення прив'язане до конкретної версії та її хеша;
 *  5. повторна технічна побудова не викликає моделі.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBpmn } from '../src/bpmn/read.ts';
import { readDrawio } from '../src/pipeline/verify-drawio.ts';
import { fixtureToPackage, type Fixture } from '../src/bpmn/fixture.ts';
import { MAX_EVENT_LABEL_CHARS, MAX_LABEL_CHARS } from '../src/bpmn/text.ts';
import { analyzePackage } from '../src/bpmn/validate.ts';
import { buildArtifact, buildPreflight, technicalLimits } from '../src/bpmn-artifacts.ts';
import { confirmStartLabel, previewStartLabel, startLabelState } from '../src/start-label.ts';
import { all, one } from '../src/db.ts';
import { getCaseReview, runBpmnReviewForCase } from '../src/review-runs.ts';
import {
  acceptDraft, approve, getVersion, headVersion, insertVersion, returnToResearch, submitForApproval, versionContent, currentApproval,
} from '../src/domain.ts';
import { approvedCase, agent, freshDb, human } from './helpers.ts';
import { FakeReviewClient, okStep, policyOf, reviewer } from './review-helpers.ts';
import { generateOk } from './bpmn-helpers.ts';

/** Текст тригера на рівно 715 символів — довжина з блокера. */
const SENT = 'Клієнт або внутрішня команда повідомляє про потребу змінити умови обслуговування, і цю потребу треба зафіксувати до початку будь-яких дій; джерело звернення буває різним: лист, чат, усна домовленість на зустрічі або запис у системі обліку звернень; ';
const TRIGGER = SENT.repeat(3).slice(0, 715);
const SHORT = 'Надійшла потреба змінити умови обслуговування';

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  id: 'long-trigger', title: 'Довгий тригер', created_without_ai: true, synthetic: true,
  what_it_tests: 'Довгий тригер із погодженим коротким підписом початкової події.',
  expect: { status: 'ok' }, version_id: 'TEST-LONG-V1', process_name: 'Зміна умов обслуговування (синтетичний процес)',
  trigger: TRIGGER, roles: ['Менеджер', 'Оператор'], entry_step_id: 'S1',
  steps: [
    { id: 'S1', role: 'Менеджер', action: 'Реєструє звернення клієнта', next: [{ to: 'S2', condition: '' }] },
    { id: 'S2', role: 'Оператор', action: 'Вносить зміну в договір', next: [{ to: 'END', condition: '' }] },
  ],
  ...over,
});

/** Погоджений кейс, у якому тригер — довгий (як у блокері). */
function approvedWithLongTrigger(trigger = TRIGGER) {
  const db = freshDb();
  const { c } = approvedCase(db);
  returnToResearch(db, human, c.id, 'уточнення тригера (тест)');
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  content.boundaries = { ...content.boundaries, trigger };
  const v = insertVersion(db, {
    caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: head.id,
    covered: JSON.parse(head.covered_json) as string[], owned: [],
  });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  return { db, caseId: c.id, versionId: v.id };
}

// ───────── 1. Без рішення людини — чесна зупинка, видима до оплати ─────────

test('1. Довгий тригер без погодженого підпису: побудова зупиняється, текст не скорочується', async () => {
  assert.equal(TRIGGER.length, 715);
  assert.ok(TRIGGER.length > MAX_EVENT_LABEL_CHARS);
  const { db, caseId } = approvedWithLongTrigger();
  const client = new FakeReviewClient([okStep([])]);
  await runBpmnReviewForCase(db, human, caseId, reviewer(client, policyOf()));
  const pre = buildPreflight(db, caseId);
  assert.equal(pre.ok, false);
  assert.equal(pre.ok ? '' : pre.code, 'START_LABEL_REQUIRED');
  assert.match(pre.ok ? '' : pre.message, /715/);
  assert.match(pre.ok ? '' : pre.message, /не скорочується/);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: { code?: string }) => e.code === 'START_LABEL_REQUIRED');
  assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0, 'жодного файлу не створено');
});

test('1. Потребу рішення видно ДО платної перевірки — у технічних обмеженнях', () => {
  const { db, caseId } = approvedWithLongTrigger();
  assert.equal(getCaseReview(db, caseId).state, 'none', 'перевірки ще не було');
  const tl = technicalLimits(db, caseId);
  assert.equal(tl.available, true, tl.reason ?? '');
  assert.equal(tl.start_label!.needs_decision, true);
  assert.equal(tl.start_label!.trigger_chars, 715);
  assert.ok(tl.unsupported.some((f) => f.code === 'LABEL_TOO_LONG'), JSON.stringify(tl.unsupported));
  assert.match(tl.unsupported.find((f) => f.code === 'LABEL_TOO_LONG')!.message, /погодити короткий підпис/);
  assert.ok(!JSON.stringify(tl).includes('bpmndi'), 'у технічному розборі немає схеми й файлів');
  assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0);
});

// ───────── 2. Рішення ухвалює людина ─────────

test('2. Рішення: потрібне пояснення; агент його ухвалити не може; підпис не довший за межу й коротший за тригер', () => {
  const { db, caseId } = approvedWithLongTrigger();
  assert.throws(() => confirmStartLabel(db, human, caseId, { label: SHORT, reason: '' }), (e: { code?: string }) => e.code === 'EXPLANATION_REQUIRED');
  assert.throws(() => confirmStartLabel(db, human, caseId, { label: '', reason: 'бо так' }), (e: { code?: string }) => e.code === 'BAD_INPUT');
  assert.throws(() => confirmStartLabel(db, agent, caseId, { label: SHORT, reason: 'агент' }), (e: { code?: string }) => e.code === 'FORBIDDEN');
  assert.throws(() => confirmStartLabel(db, human, caseId, { label: 'я'.repeat(MAX_EVENT_LABEL_CHARS + 1), reason: 'довгий' }), (e: { code?: string }) => e.code === 'LABEL_TOO_LONG');
  // «не коротший за тригер» перевіряємо окремо — на кейсі з КОРОТКИМ тригером (тут спрацювала б межа довжини).
  const short = approvedWithLongTrigger('Надійшов запит клієнта');
  assert.throws(() => confirmStartLabel(short.db, human, short.caseId, { label: 'Надійшов запит клієнта', reason: 'той самий текст' }), (e: { code?: string }) => e.code === 'BAD_INPUT');
  const row = confirmStartLabel(db, human, caseId, { label: SHORT, reason: 'короткий підпис для схеми; повний текст лишається в описі' });
  assert.equal(row.label, SHORT);
  assert.equal(row.confirmed_by, human.name);
});

test('2. Попередній перегляд показує повний текст, запропонований підпис і наслідки — до рішення', () => {
  const { db, caseId } = approvedWithLongTrigger();
  const p = previewStartLabel(db, caseId, SHORT);
  assert.equal(p.trigger, TRIGGER);
  assert.equal(p.proposed_label, SHORT);
  assert.equal(p.current_label, TRIGGER, 'поки рішення немає, підписом є сам тригер');
  assert.ok(p.consequences.some((x) => /не змінюється/.test(x)));
  assert.equal(all(db, 'SELECT id FROM start_label').length, 0, 'перегляд нічого не записує');
});

test('2. Запис незмінний і прив’язаний до версії: зміна запису робить його недійсним, нова версія його не успадковує', () => {
  const { db, caseId, versionId } = approvedWithLongTrigger();
  confirmStartLabel(db, human, caseId, { label: SHORT, reason: 'причина' });
  const v = getVersion(db, versionId);
  assert.equal(startLabelState(db, caseId, versionId, v.content_hash, TRIGGER).label, SHORT);
  assert.throws(() => db.prepare('UPDATE start_label SET label = ?').run('інше'), /незмінна/);
  assert.throws(() => db.prepare('DELETE FROM start_label').run(), /незмінна/);
  // Рішення ухвалювалось для ЦЬОГО тексту тригера: для іншого воно не діє.
  assert.equal(startLabelState(db, caseId, versionId, v.content_hash, 'інший тригер').label, 'інший тригер');
  // І для іншої версії теж.
  assert.equal(startLabelState(db, caseId, 'ver_інша', v.content_hash, TRIGGER).label, TRIGGER);
});

// ───────── 3. Після рішення: схема будується, повний текст збережено ─────────

test('3. Схема будується: короткий підпис на події, ПОВНИЙ текст — у деталях обох форматів', async () => {
  const { db, caseId } = approvedWithLongTrigger();
  confirmStartLabel(db, human, caseId, { label: SHORT, reason: 'причина' });
  const client = new FakeReviewClient([okStep([])]);
  const rev = await runBpmnReviewForCase(db, human, caseId, reviewer(client, policyOf()));
  assert.ok(rev.ok, JSON.stringify(rev));
  const out = await buildArtifact(db, human, caseId);
  assert.equal(out.artifact.status, 'ok', JSON.stringify(out.artifact.detail).slice(0, 400));
  assert.equal(out.artifact.row.drawio_status, 'ok');
  assert.equal(client.calls, 1, 'побудова моделі не викликає');

  const { model } = readBpmn(out.artifact.row.bpmn_xml!);
  const start = [...model!.nodes.values()].find((n) => n.tag === 'startEvent')!;
  assert.equal(start.name, SHORT, 'на схемі — погоджений короткий підпис');
  assert.ok(out.artifact.row.bpmn_xml!.includes(TRIGGER), 'повний текст тригера є у .bpmn дослівно');
  const cell = readDrawio(out.artifact.row.drawio_xml!).cells.find((c) => c.id === start.id)!;
  assert.equal(cell.tooltip, TRIGGER, 'повний текст тригера є в підказці .drawio дослівно');
  assert.equal(cell.value, SHORT);
  // Погоджений опис не змінено: тригер у версії лишився повним.
  const v = getVersion(db, currentApproval(db, caseId)!.version_id);
  assert.equal(versionContent(v).boundaries.trigger, TRIGGER);
});

test('3. Повторна технічна побудова — без нового виклику моделі', async () => {
  const { db, caseId } = approvedWithLongTrigger();
  confirmStartLabel(db, human, caseId, { label: SHORT, reason: 'причина' });
  const client = new FakeReviewClient([okStep([])]);
  await runBpmnReviewForCase(db, human, caseId, reviewer(client, policyOf()));
  const first = await buildArtifact(db, human, caseId);
  assert.equal(first.reused, false);
  const again = await buildArtifact(db, human, caseId);
  assert.equal(again.reused, true);
  assert.equal(client.calls, 1);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM bpmn_artifact')!.n, 1);
});

// ───────── 4. Межі не послаблені ─────────

test('4. Межі підписів лишились: усередині фігур — 600, зовнішній підпис події — 240', async () => {
  assert.equal(MAX_LABEL_CHARS, 600);
  assert.equal(MAX_EVENT_LABEL_CHARS, 240);
  const long = 'я'.repeat(MAX_LABEL_CHARS + 1);
  const a = analyzePackage(fixtureToPackage(fixture({
    expect: { status: 'unsupported' },
    steps: [
      { id: 'S1', role: 'Менеджер', action: long, next: [{ to: 'S2', condition: '' }] },
      { id: 'S2', role: 'Оператор', action: 'Вносить зміну в договір', next: [{ to: 'END', condition: '' }] },
    ],
  })), { startLabel: SHORT });
  assert.ok(a.unsupported.some((x) => x.code === 'LABEL_TOO_LONG' && /дія/i.test(x.message)), JSON.stringify(a.unsupported));
});

test('4. Короткий підпис теж перевіряється: задовгий підпис побудову не відкриває', () => {
  const over = 'я'.repeat(MAX_EVENT_LABEL_CHARS + 1);
  const a = analyzePackage(fixtureToPackage(fixture()), { startLabel: over });
  assert.ok(a.unsupported.some((x) => x.code === 'LABEL_TOO_LONG' && /короткий підпис/i.test(x.message)), JSON.stringify(a.unsupported));
});

test('4. Короткий тригер нічого не потребує: підписом лишається сам текст', async () => {
  const r = await generateOk(fixtureToPackage(fixture({ trigger: 'Надійшов запит клієнта' })));
  const { model } = readBpmn(r.bpmn);
  const start = [...model!.nodes.values()].find((n) => n.tag === 'startEvent')!;
  assert.equal(start.name, 'Надійшов запит клієнта');
  assert.ok(!r.bpmn.includes('<bpmn:documentation'), 'окремих деталей події без короткого підпису не з’являється');
});
