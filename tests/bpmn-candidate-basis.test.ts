/**
 * Підстава кандидата на непідтримувану нотацію (D83, виправлено D85 за незалежною перевіркою).
 *
 * Факт із експорту: цитата «за орієнтовної дати чекає» лежала в `content.summary` версії 28 (не в C80 —
 * тверджень агент 2 не бачить узагалі). Підставою знахідки може бути **будь-яке** поле погодженого пакета;
 * вимоги «лише текст кроку» немає й бути не може.
 *
 * Тут перевіряється програмна частина, яка НЕ змінює погоджених правил: програма показує, **де саме** в пакеті
 * знайдено цитату (довідка для людини, а не оцінка знахідки). Блокування й заборона відхилення незмінні.
 * Окремо перевірено, що інструкція bpmn-v0.6 містить виправлені критерії. Перевірки тексту промпта доказом
 * якості моделі не є.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFromCitedStep, quoteLocations } from '../src/ai/bpmn-review.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { findingsView, getCaseReview, listResolutions, rejectFinding, runBpmnReviewForCase } from '../src/review-runs.ts';
import { buildArtifact } from '../src/bpmn-artifacts.ts';
import { canonical } from '../src/hash.ts';
import {
  acceptDraft, addNotationRequirement, approve, headVersion, requestBpmnStart, returnToResearch,
  saveAnalystVersion, submitForApproval, versionContent,
} from '../src/domain.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, finding, okStep, policyOf, reviewer } from './review-helpers.ts';

/** Цитата з тексту кроку S2 («Вносить зміну») і цитата з суті опису — обидві є в пакеті. */
const FROM_STEP = 'Вносить зміну';
const FROM_SUMMARY = 'Синтетичний процес зміни умов';

test('1. Програма показує, де саме в пакеті знайдено цитату (довідка, не критерій)', () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const content = versionContent(headVersion(db, c.id));
  assert.deepEqual(quoteLocations(content, FROM_STEP), ['крок S2 · дія']);
  assert.deepEqual(quoteLocations(content, FROM_SUMMARY), ['суть']);
  assert.deepEqual(quoteLocations(content, 'ЦЬОГО В ПАКЕТІ НЕМАЄ'), []);
  // Той самий текст у двох полях — видно обидва (це й є ознака можливої суперечності).
  content.business_context = `${content.business_context} ${FROM_SUMMARY}`;
  assert.deepEqual(quoteLocations(content, FROM_SUMMARY), ['суть', 'бізнес-контекст']);
});

test('1. Довідкова ознака «цитата з тексту кроку» лишається, але нічого не забороняє', () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const content = versionContent(headVersion(db, c.id));
  assert.equal(quoteFromCitedStep(content, { step_ids: ['S2'], quote: FROM_STEP }), true);
  assert.equal(quoteFromCitedStep(content, { step_ids: ['S2'], quote: FROM_SUMMARY }), false, 'цитата із суті — не текст кроку');
  assert.equal(quoteFromCitedStep(content, { step_ids: ['S2'], quote: 'ЦЬОГО В ПАКЕТІ НЕМАЄ ВЗАГАЛІ' }), null, 'цитати немає в пакеті — відповідь невідома');
  assert.equal(quoteFromCitedStep(content, { step_ids: [], quote: FROM_STEP }), null, 'кроків не названо — відповідь невідома');
});

test('2. Межа: умова переходу кроку — теж текст цього кроку, а питання й контекст — ні', () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const content = versionContent(headVersion(db, c.id));
  content.steps[0]!.next = [{ to: 'S2', condition: 'заявка повна' }, { to: 'END', condition: 'заявка неповна' }];
  content.questions = [{ id: 'Q1', text: 'Чи є окремий строк очікування підтвердження?', critical: false, impact: '', addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '' }];
  assert.equal(quoteFromCitedStep(content, { step_ids: ['S1'], quote: 'заявка неповна' }), true, 'умова переходу належить кроку');
  assert.equal(quoteFromCitedStep(content, { step_ids: ['S1'], quote: 'окремий строк очікування' }), false, 'текст питання — не опис кроку');
});

test('3. Картка показує походження цитати (у т.ч. із суті), але блокування НЕ змінюється', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([
    finding({ code: 'UNSUPPORTED_CANDIDATE', step_ids: ['S2'], quote: FROM_SUMMARY, question: 'Це окремий стан очікування чи звичайна дія?', class: 'blocks_flow' }),
  ])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok, JSON.stringify(r));
  const view = getCaseReview(db, c.id);
  assert.equal(view.state, 'awaiting_analyst');
  const f = view.findingsView![0]!;
  assert.equal(f.finding.code, 'UNSUPPORTED_CANDIDATE');
  assert.equal(f.quote_from_step, false, 'видно, що цитата не з тексту кроку');
  assert.deepEqual(f.quote_locations, ['суть'], 'видно, з якого саме поля пакета взято доказ');
  // Кандидат блокує побудову, доки щодо нього немає рішення людини (D84: дія доступна, але не автоматична).
  assert.equal(f.blocking, true);
  assert.equal(f.can_reject, true);
  assert.equal(f.resolution, null);
  assert.equal(view.gate!.ok, false);
  assert.equal(view.gate!.code, 'UNSUPPORTED_CANDIDATE');
  // Попередження перевірки цитат теж на місці (воно було й до цієї зміни).
  assert.ok(view.warnings!.some((w) => /не в тексті вказаних кроків/.test(w)), JSON.stringify(view.warnings));
});

test('3. Контроль: кандидат із цитатою з тексту кроку позначається як обґрунтований цитатою', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([
    finding({ code: 'UNSUPPORTED_CANDIDATE', step_ids: ['S2'], quote: FROM_STEP, question: 'Чи виконуються ці дії одночасно?', class: 'blocks_flow' }),
  ])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok, JSON.stringify(r));
  const f = getCaseReview(db, c.id).findingsView![0]!;
  assert.equal(f.quote_from_step, true);
  assert.equal(f.blocking, true, 'блокування те саме — програма не вирішує за людину');
});

test('3. Без змісту пакета ознака не вигадується', () => {
  const [v] = findingsView([finding({ code: 'UNSUPPORTED_CANDIDATE' }) as never], []);
  assert.equal(v!.quote_from_step, null);
  assert.deepEqual(v!.quote_locations, []);
});

// ───────── Інструкція: загальні критерії, без відповідей цього кейсу ─────────

test('4. Інструкція bpmn-v0.6: підстава — весь пакет, суперечність показують, клас визначає вплив на потік', () => {
  const i = loadBpmnInstruction();
  assert.equal(i.version, 'bpmn-v0.6');
  const t = i.text;

  // (1) Підстава — у всьому пакеті; суперечність полів не ігнорується й не вирішується агентом.
  assert.match(t, /У всьому погодженому пакеті/);
  assert.match(t, /Жодне поле не має переваги над іншим, і жодне не ігнорується/);
  assert.match(t, /Не обирай «правильне» поле сам і не ігноруй жодного/);
  assert.ok(!/лише в тексті кроку|цитата має бути з тексту \*\*самого названого кроку\*\*/.test(t), 'вимоги «лише текст кроку» бути не повинно');

  // (2) Клас визначає вплив на побудову, а не ступінь упевненості.
  assert.match(t, /Неоднозначність сама по собі не робить знахідку `informational`/);
  assert.match(t, /Слабкий доказ особливої нотації не означає, що потік безпечний/);
  assert.match(t, /Знижувати клас через брак упевненості не можна/);
  assert.ok(!/неоднозначність.{0,80}informational, а не блокування/i.test(t), 'автоматичного переведення неоднозначності в informational бути не повинно');

  // (3) BPMN за OMG 2.0.2: pool ≠ lane; message flow не між доріжками одного пулу; black-box учасник.
  assert.match(t, /Учасник \(participant, pool\) ≠ роль \(lane\)/);
  assert.match(t, /Message flow між доріжками одного пулу не проходить/);
  assert.match(t, /згорнутим \(black-box\) пулом/);
  assert.match(t, /не означає\*\*, що обміну повідомленнями немає/);
  assert.match(t, /не доводять\*\* потреби в особливій нотації й \*\*не виключають\*\* її/);
  assert.ok(!/Співрозмовник, якого немає серед ролей процесу/.test(t), 'помилкове ототожнення ролі й учасника прибрано');

  // (4) Приклади: звичайна задача, справжня непідтримувана поведінка, суперечність, неоднозначність що блокує.
  for (const must of ['**Звичайна задача.**', '**Справді непідтримувана поведінка в контексті.**', '**Суперечність контексту й кроку.**', '**Неоднозначність, що блокує потік.**']) {
    assert.ok(t.includes(must), `бракує прикладу: ${must}`);
  }

  // Жодних відповідей конкретного кейсу й жодних застарілих тверджень про стан агента.
  for (const forbidden of ['S18', 'C80', 'овнер', 'дата запуску']) {
    assert.ok(!t.includes(forbidden), `в інструкції не має бути кейсових подробиць: ${forbidden}`);
  }
});

test('4. Шапка інструкції не стверджує, що агента 2 не підключено й запусків не було', () => {
  const raw = readFileSync(join(import.meta.dirname, '..', 'prompts', 'bpmn.md'), 'utf8');
  assert.ok(!raw.includes('агент у застосунок ще не підключений'), 'застаріле твердження прибрано');
  assert.ok(!raw.includes('жодного справжнього виклику моделі не було'), 'застаріле твердження прибрано');
  assert.match(raw, /агент 2 \*\*підключений\*\*/);
  assert.match(raw, /якість смислових висновків лишається неперевіреною/i, 'межа перевіреності лишається названою');
  assert.match(raw, /доказом якості моделі не є/, 'сказано, що тести тексту інструкції — не доказ якості');
});

// ───────── Межі рішення щодо припущення агента (D84, варіант 1 — погоджено власницею) ─────────

test('5. Рішення знімає лише своє блокування: інші знахідки й нова версія лишаються чинними', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([
    finding({ code: 'UNSUPPORTED_CANDIDATE', step_ids: ['S2'], quote: FROM_SUMMARY, question: 'Це окремий стан очікування?', class: 'blocks_flow' }),
    finding({ code: 'CONDITIONS_NOT_EXHAUSTIVE', step_ids: ['S1'], quote: 'Приймає запит', question: 'Що в інших випадках?', class: 'blocks_flow' }),
  ])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok, JSON.stringify(r));
  const rev = getCaseReview(db, c.id);
  const cand = rev.findingsView!.find((v) => v.finding.code === 'UNSUPPORTED_CANDIDATE')!;
  const other = rev.findingsView!.find((v) => v.finding.code !== 'UNSUPPORTED_CANDIDATE')!;

  rejectFinding(db, human, c.id, { reviewId: rev.reviewId!, findingKey: cand.key, explanation: 'Опис кроку описує звичайну дію; окремого стану процесу тут немає (синтетичний приклад).' });
  const mid = getCaseReview(db, c.id);
  assert.equal(mid.gate!.ok, false, 'друга блокувальна знахідка лишається');
  assert.equal(mid.gate!.code, 'BLOCKING_FINDINGS');
  assert.equal(mid.findingsView!.find((v) => v.key === other.key)!.resolution, null);

  rejectFinding(db, human, c.id, { reviewId: rev.reviewId!, findingKey: other.key, explanation: 'Інших випадків немає: перевірено з виконавцем (синтетичний приклад).' });
  assert.equal(getCaseReview(db, c.id).gate!.ok, true, 'після рішень щодо обох шлюз відкритий');

  // Рішення не редагує AS-IS і не успадковується новою версією.
  const before = versionContent(headVersion(db, c.id));
  returnToResearch(db, human, c.id, 'уточнення (тест)');
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: { summary: 'Уточнено (синтетично).' } });
  assert.notEqual(canonical(versionContent(v)), canonical(before));
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  const fresh = getCaseReview(db, c.id);
  assert.notEqual(fresh.state, 'awaiting_analyst', `нова версія не успадковує рішень: ${fresh.state}`);
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: { code?: string }) => e.code !== undefined, 'побудова без нової перевірки неможлива');
});

test('5. Підтверджена вимога до нотації лишається блокером: рішення щодо неї не приймається', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  // Людина фіксує: тут потрібна непідтримувана нотація. Це не знахідка агента, а рішення у змісті версії.
  returnToResearch(db, human, c.id, 'потрібна вимога до нотації (тест)');
  const v = addNotationRequirement(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, kind: 'parallel_branches', stepId: 'S1', detail: 'Дві дії справді одночасні (синтетичний приклад).' });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  requestBpmnStart(db, human, c.id, 'demo');
  // Підтверджена вимога дає `unsupported` БЕЗ моделі — клієнта тут немає навмисно.
  const started = await runBpmnReviewForCase(db, human, c.id);
  assert.ok(started.ok && 'outcome' in started && started.outcome === 'unsupported', JSON.stringify(started));

  const r = getCaseReview(db, c.id);
  assert.equal(r.state, 'unsupported', `очікували стан «unsupported», отримали «${r.state}»`);
  assert.ok(!r.gate || !r.gate.ok, 'шлюз закритий');
  // Відхилити це рішенням щодо знахідки не можна: знахідок немає, стан не «чекає рішень».
  assert.throws(() => rejectFinding(db, human, c.id, { reviewId: r.reviewId ?? 'rev_000000000000', findingKey: 'будь-який', explanation: 'спроба обійти підтверджену вимогу' }),
    (e: { code?: string }) => e.code === 'BAD_STATE' || e.code === 'REVIEW_MISMATCH' || e.code === 'NOT_FOUND');
  assert.equal(listResolutions(db, c.id).length, 0);
});
