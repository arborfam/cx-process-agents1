/**
 * Підстава кандидата на непідтримувану нотацію (D83).
 *
 * Блокер особистого прогону: агент 2 повернув `UNSUPPORTED_CANDIDATE` для кроку, опис якого — звичайна робота
 * людини («уточнити й отримати підтвердження»), а цитата була взята НЕ з тексту цього кроку. Побудова
 * зупинена, відхилити кандидата за чинними правилами не можна.
 *
 * Тут перевіряється програмна частина, яка НЕ змінює погоджених правил: програма рахує й показує, звідки взято
 * цитату (з кроку чи з іншого місця опису), і це видно в картці. Блокування лишається незмінним — рішення за
 * людиною. Окремо перевірено, що інструкція bpmn-v0.4 містить загальні критерії (без відповідей цього кейсу).
 * Усе на підставних відповідях: доказом покращення AI ці тести не є.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFromCitedStep } from '../src/ai/bpmn-review.ts';
import { loadBpmnInstruction } from '../src/ai/prompt.ts';
import { getCaseReview, runBpmnReviewForCase, findingsView } from '../src/review-runs.ts';
import { headVersion, versionContent } from '../src/domain.ts';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, finding, okStep, policyOf, reviewer } from './review-helpers.ts';

/** Цитата з тексту кроку S2 («Вносить зміну») і цитата з суті опису — обидві є в пакеті. */
const FROM_STEP = 'Вносить зміну';
const FROM_SUMMARY = 'Синтетичний процес зміни умов';

test('1. Програма розрізняє, звідки взято цитату: з тексту кроку чи з іншого місця опису', () => {
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

test('3. Картка показує походження цитати, але блокування НЕ змінюється', async () => {
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
  assert.equal(f.quote_from_step, false, 'видно, що підстава взята не з тексту кроку');
  // Нічого не послаблено: кандидат блокує побудову й відхилити його, як і раніше, не можна.
  assert.equal(f.blocking, true);
  assert.equal(f.can_reject, false);
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
});

// ───────── Інструкція: загальні критерії, без відповідей цього кейсу ─────────

test('4. Інструкція bpmn-v0.4 розділяє звичайну дію людини й доведену потребу в нотації', () => {
  const i = loadBpmnInstruction();
  assert.equal(i.version, 'bpmn-v0.4');
  const t = i.text;
  // Слова самі по собі не є підставою.
  assert.match(t, /Слова нічого не доводять/);
  for (const word of ['Уточнити', 'отримати підтвердження', 'надіслати', 'повідомити']) {
    assert.ok(t.includes(word), `у критеріях має бути названо звичайне дієслово «${word}»`);
  }
  // Критерій справжньої потреби — перевірювана ознака в тексті кроку.
  assert.match(t, /перевірювана ознака в тексті самого кроку/);
  assert.match(t, /між двома учасниками \*\*процесу\*\*/);
  assert.match(t, /правило за часом, яке змінює маршрут/);
  // Неоднозначність — це питання, а не блокування.
  assert.match(t, /informational/);
  assert.match(t, /Кандидата став лише тоді, коли з тексту кроку видно саму конструкцію/);
  // Підстава кандидата — текст самого кроку.
  assert.match(t, /цитата має бути з тексту \*\*самого названого кроку\*\*/);
  // Опис під генератор не підганяємо — і навпаки.
  assert.match(t, /не вигадуй непідтримуваної нотації там, де опис показує звичайну роботу людини/);
  // Жодних відповідей конкретного кейсу.
  for (const forbidden of ['S18', 'C80', 'овнер', 'дата запуску']) {
    assert.ok(!t.includes(forbidden), `в інструкції не має бути кейсових подробиць: ${forbidden}`);
  }
});
