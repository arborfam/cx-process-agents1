/**
 * D94. Короткий підпис початкової події з уже дозволеного AI-маршруту.
 *
 * Пропозицію дає агент 1 у ТІЙ САМІЙ відповіді, що й повний опис, — окремого платного
 * виклику для неї не потрібно. Вона нічого не змінює сама собою: на схему підпис
 * потрапляє лише через погодження людини, а погоджений підпис непомітно не змінюється.
 * Межі беруться з чинного контракту (`MAX_EVENT_LABEL_CHARS`), нових не вводиться.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EVENT_LABEL_CHARS } from '../src/bpmn/text.ts';
import { triggerShortProposal, startLabelState, confirmStartLabel, previewStartLabel } from '../src/start-label.ts';
import { approve, acceptDraft, headVersion, insertVersion, returnToResearch, submitForApproval, versionContent } from '../src/domain.ts';
import { approvedCase, freshDb, human } from './helpers.ts';

const LONG = 'Працівниця або працівник підрозділу повідомляє про потребу в товарі чи послузі, якої немає на складі й яку не покриває чинний рамковий договір, — усно керівникові, листом на спільну скриньку закупівель або заявкою в обліковій системі; саме з цього моменту підрозділ вважає закупівлю початою, навіть якщо заявку ще не оформлено в системі (синтетичний приклад).';
const SHORT = 'Підрозділ повідомив про потребу поза складом і рамковим договором';

const C = (trigger: string, short?: string) => ({ boundaries: { trigger, trigger_short: short } });

test('1. Межа береться з контракту, а не з інтерфейсу', () => {
  assert.equal(MAX_EVENT_LABEL_CHARS, 240, 'якщо межа змінилась — оновіть контракт, а не інтерфейс');
  assert.ok(LONG.length > MAX_EVENT_LABEL_CHARS);
});

test('2. Придатна пропозиція приймається як пропозиція', () => {
  const p = triggerShortProposal(C(LONG, SHORT));
  assert.ok(p); assert.equal(p.text, SHORT); assert.equal(p.source, 'agent'); assert.equal(p.chars, SHORT.length);
});

test('3. Задовга пропозиція не показується й НЕ обрізається', () => {
  const tooLong = 'я'.repeat(MAX_EVENT_LABEL_CHARS + 1);
  assert.equal(triggerShortProposal(C(LONG, tooLong)), null, 'механічного обрізання бути не має');
});

test('4. Порожня пропозиція, повтор тригера й непридатний текст пропозицією не є', () => {
  assert.equal(triggerShortProposal(C(LONG, '   ')), null);
  assert.equal(triggerShortProposal(C(LONG)), null);
  assert.equal(triggerShortProposal(C(LONG, LONG)), null, 'це не коротший підпис');
  assert.equal(triggerShortProposal(C(LONG, 'Підпис\tз табуляцією')), null, 'у схему дослівно не записати');
});

test('5. Короткий тригер рішення не потребує — підпис лишається повним текстом', () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const v = headVersion(db, c.id);
  const short = 'Клієнт подав запит на зміну умов';
  const st = startLabelState(db, c.id, v.id, v.content_hash, short, null);
  assert.equal(st.needsDecision, false);
  assert.equal(st.label, short);
  assert.equal(st.documentation, null, 'коротшого підпису не потрібно — повний текст і є підписом');
});

function approvedCaseWithTrigger(trigger: string, short?: string) {
  const db = freshDb();
  const { c } = approvedCase(db);
  returnToResearch(db, human, c.id, 'уточнення тригера (тест)');
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  content.boundaries = { ...content.boundaries, trigger, ...(short === undefined ? {} : { trigger_short: short }) };
  const v = insertVersion(db, {
    caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: head.id,
    covered: JSON.parse(head.covered_json) as string[], owned: [],
  });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  return { db, caseId: c.id, versionId: v.id, version: headVersion(db, c.id) };
}

test('6. Довгий тригер без погодження блокує побудову; пропозиція згадана, але не застосована', () => {
  const { db, caseId, version } = approvedCaseWithTrigger(LONG, SHORT);
  const st = startLabelState(db, caseId, version.id, version.content_hash, LONG, triggerShortProposal(versionContent(version)));
  assert.equal(st.needsDecision, true, 'пропозиція сама собою рішення не замінює');
  assert.equal(st.label, LONG, 'на схему досі йде повний текст — отже побудова лишається заблокованою');
  assert.ok(st.proposal && st.proposal.text === SHORT);
  assert.ok(st.message!.includes('Агент запропонував'), 'людині сказано, що варіант є');
  assert.equal(st.maxChars, MAX_EVENT_LABEL_CHARS);
});

test('7. Погоджений людиною підпис діє; нова пропозиція агента його не змінює', () => {
  const { db, caseId, version } = approvedCaseWithTrigger(LONG, SHORT);
  confirmStartLabel(db, human, caseId, { label: SHORT, reason: 'Короткий підпис для схеми; повний текст лишається в описі.' });
  const other = 'Зовсім інший підпис, запропонований агентом пізніше';
  const st = startLabelState(db, caseId, version.id, version.content_hash, LONG, { text: other, source: 'agent', chars: other.length });
  assert.equal(st.needsDecision, false);
  assert.equal(st.label, SHORT, 'погоджений підпис непомітно не замінюється пропозицією');
  assert.equal(st.documentation, LONG, 'повний текст тригера лишається');
});

test('8. Прев’ю віддає межу з контракту й пропозицію', () => {
  const { db, caseId } = approvedCaseWithTrigger(LONG, SHORT);
  const pv = previewStartLabel(db, caseId, SHORT);
  assert.equal(pv.max_chars, MAX_EVENT_LABEL_CHARS);
  assert.ok(pv.agent_proposal && pv.agent_proposal.text === SHORT);
  assert.equal(pv.trigger, LONG, 'повний текст не змінюється');
});

test('9. Пропозиції немає — лишається ручний шлях, межа ту саму', () => {
  const { db, caseId, version } = approvedCaseWithTrigger(LONG);
  const st = startLabelState(db, caseId, version.id, version.content_hash, LONG, triggerShortProposal(versionContent(version)));
  assert.equal(st.proposal, null);
  assert.equal(st.needsDecision, true);
  assert.ok(!st.message!.includes('Агент запропонував'));
  assert.equal(st.maxChars, MAX_EVENT_LABEL_CHARS);
});

test('10. Агент підпис не погоджує — це дія людини', () => {
  const { db, caseId } = approvedCaseWithTrigger(LONG, SHORT);
  assert.throws(
    () => confirmStartLabel(db, { kind: 'agent', name: 'analyst-agent' }, caseId, { label: SHORT, reason: 'бо так' }),
    (e: { code?: string }) => !!e.code);
});
