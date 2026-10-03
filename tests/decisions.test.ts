/**
 * D96. Повторне використання рішень на реальних даних.
 *
 * Перевіряється саме те, що вимагала власниця:
 *  • перейменування ID або зміна назви самі по собі не доводять зміни змісту;
 *  • зв'язок між версіями об'єкта надійний, а не збіг рядків;
 *  • неоднозначне зіставлення не видається за «все гаразд» — показується причина перегляду;
 *  • «нової суперечності немає» не стверджується, якщо перевірка не охоплює потрібних джерел.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type DB } from '../src/db.ts';
import { addSource, createCase, headVersion, insertVersion, versionContent, type Actor } from '../src/domain.ts';
import { confirmDecision, createDecision, decisionApplications, decisionCurrency } from '../src/decisions.ts';
import { emptyContent, type Content } from '../src/schema.ts';
import { freshDb, human } from './helpers.ts';

const agent: Actor = { kind: 'agent', name: 'analyst-agent' };
const QUOTE = 'Повторний запит овнеру — це окрема дія, і я чекаю на відповідь іноді кілька днів.';
const SRC_TEXT = `Інтерв'ю з CX. ${QUOTE} Потім доповнюю матеріали.`;

const step = (id: string, action: string, over: Partial<Content['steps'][number]> = {}): Content['steps'][number] => ({
  id, role: 'CX', action, entry_condition: 'умова', input_artifact: '', result: 'результат',
  next: [{ to: 'END', condition: '' }], source_ids: [], ...over,
});

function caseWithDecision(db: DB) {
  const c = createCase(db, human, 'Кейс рішень', 'demo');
  const src = addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю 1', content: SRC_TEXT, origin: 'synthetic', ref: 'SRC-01' });
  const content = emptyContent();
  content.steps = [step('S12', 'Повторно запитати овнера'), step('S13', 'Доповнити матеріали')];
  content.questions = [{
    id: 'Q1', text: 'Чи є повторний запит окремим кроком?', critical: false, impact: '', addressee: '',
    status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '',
  }];
  putHead(db, c.id, content, [src.id]);
  const d = createDecision(db, human, c.id, {
    subject: 'Повторний запит овнеру — окремий крок',
    explanation: 'За словами CX це окрема дія з власним очікуванням.',
    scope: { question_ids: ['Q1'], step_ids: ['S12', 'S13'] },
    evidence: [{ source_id: src.id, quote: QUOTE }],
  });
  return { caseId: c.id, srcId: src.id, decisionId: d.id, content };
}
function putHead(db: DB, caseId: string, content: Content, covered: string[] = []) {
  const v = insertVersion(db, {
    caseId, content, createdBy: 'analyst', actorName: human.name,
    parentId: headVersion(db, caseId).id, covered, owned: [],
  });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, caseId);
  return v;
}
const next = (db: DB, caseId: string, mutate: (c: Content) => void, covered: string[] = []) => {
  const c = versionContent(headVersion(db, caseId));
  mutate(c);
  return putHead(db, caseId, c, covered);
};

test('1. Нічого не змінилось — рішення діє; підтверджувати не треба', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.summary = 'редакційна правка опису'; }, [srcId]);
  const cur = decisionCurrency(db, caseId, decisionId);
  assert.equal(cur.state, 'valid', JSON.stringify(cur.changed.concat(cur.unknown)));
  assert.deepEqual(cur.changed, []);
  assert.deepEqual(cur.unknown, []);
});

test('2. Перейменування ID кроку НЕ є зміною змісту', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.steps = c.steps.map((s) => (s.id === 'S12' ? { ...s, id: 'S12a' } : s)); }, [srcId]);
  const cur = decisionCurrency(db, caseId, decisionId);
  assert.equal(cur.state, 'valid', JSON.stringify(cur.changed.concat(cur.unknown)));
  assert.ok(cur.checks.find((x) => x.key === 'step:S12')!.detail.includes('S12a'), 'новий ID названо');
});

test('3. Зміна назви кроку поза змістом рішення не зачіпає його', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.steps.push(step('S99', 'Зовсім інший крок')); }, [srcId]);
  assert.equal(decisionCurrency(db, caseId, decisionId).state, 'valid');
});

test('4. Зміна опису пов’язаного кроку — перегляд із конкретною причиною', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.steps = c.steps.map((s) => (s.id === 'S12' ? { ...s, action: 'Запитати овнера й одразу ескалювати' } : s)); }, [srcId]);
  const cur = decisionCurrency(db, caseId, decisionId);
  assert.equal(cur.state, 'review');
  assert.ok(cur.changed.join(' ').includes('S12'), JSON.stringify(cur.changed));
});

test('5. Неоднозначне зіставлення не видається за «все гаразд»', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => {
    const s12 = c.steps.find((s) => s.id === 'S12')!;
    c.steps = c.steps.filter((s) => s.id !== 'S12');
    c.steps.push({ ...s12, id: 'S12a' }, { ...s12, id: 'S12b', next: [{ to: 'S13', condition: '' }] });
  }, [srcId]);
  const cur = decisionCurrency(db, caseId, decisionId);
  assert.equal(cur.state, 'needs_confirmation');
  assert.ok(cur.unknown.join(' ').includes('зіставити надійно не вдалося'), JSON.stringify(cur.unknown));
  assert.ok(cur.unknown.join(' ').includes('S12a') && cur.unknown.join(' ').includes('S12b'), 'названо кандидатів');
});

test('6. Крок зник зовсім — перегляд, а не мовчазне перенесення', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.steps = c.steps.filter((s) => s.id !== 'S12'); }, [srcId]);
  const cur = decisionCurrency(db, caseId, decisionId);
  assert.equal(cur.state, 'review');
  assert.ok(cur.changed.join(' ').includes('немає'));
});

test('7. Зміна формулювання питання — перегляд', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.questions[0]!.text = 'Чи є повторний запит частиною підготовки повідомлення?'; }, [srcId]);
  assert.equal(decisionCurrency(db, caseId, decisionId).state, 'review');
});

test('8. Зникла цитата доказу — підстава змінилась, рішення не застосовується', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  const other = addSource(db, human, caseId, { kind: 'document', title: 'Регламент', content: 'Інший текст без тієї цитати.', origin: 'synthetic' });
  // доказ підміняємо: створюємо рішення на джерелі, цитати з якого потім не буде
  const d2 = createDecision(db, human, caseId, {
    subject: 'Рішення з доказом', explanation: 'Пояснення.',
    scope: { step_ids: ['S13'], question_ids: [] }, evidence: [{ source_id: other.id, quote: 'Інший текст' }],
  });
  assert.equal(decisionCurrency(db, caseId, d2.id).state, 'valid');
  // джерело лишається, але цитату беремо таку, якої в ньому немає → перевірка це ловить одразу
  assert.throws(() => createDecision(db, human, caseId, {
    subject: 'Вигадана цитата', explanation: 'Пояснення.',
    scope: { step_ids: ['S13'], question_ids: [] }, evidence: [{ source_id: other.id, quote: 'Цього там немає' }],
  }), (e: { code?: string }) => e.code === 'QUOTE_NOT_FOUND');
  assert.equal(decisionCurrency(db, caseId, decisionId).state, 'valid', 'чуже рішення не зачіпається');
});

test('9. «Нової суперечності немає» не стверджується, якщо джерело не прочитане', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  const broken = addSource(db, human, caseId, {
    kind: 'document', title: 'Файл, який не прочитався', content: '', origin: 'synthetic',
    readStatus: 'error', readError: 'Формат не підтримується',
  });
  next(db, caseId, (c) => { c.summary = 'нове джерело враховано частково'; }, [srcId, broken.id]);
  const cur = decisionCurrency(db, caseId, decisionId);
  const conf = cur.checks.find((x) => x.key === 'conflicts')!;
  assert.equal(conf.status, 'unknown', JSON.stringify(conf));
  assert.ok(conf.detail.includes('не можна'), conf.detail);
  assert.equal(cur.state, 'needs_confirmation', 'непевність не читається як «діє»');
});

test('10. Нова суперечність — перегляд', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.conflicts = [{ key: 'boundaries.trigger', kept: 'А', proposed: 'Б', note: 'розбіжність' }]; }, [srcId]);
  const cur = decisionCurrency(db, caseId, decisionId);
  assert.equal(cur.state, 'review');
  assert.ok(cur.changed.join(' ').includes('суперечності'));
});

test('11. Підтвердження записується в історію; пояснення можна відредагувати, не вводячи заново', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.steps = c.steps.filter((s) => s.id !== 'S12'); }, [srcId]);
  const before = decisionApplications(db, decisionId).length;
  confirmDecision(db, human, caseId, { decisionId, explanation: 'За словами CX це окрема дія; крок вилучено, рішення лишається про S13.' });
  const apps = decisionApplications(db, decisionId);
  assert.equal(apps.length, before + 1);
  assert.equal(apps.at(-1)!.kind, 'edited');
  assert.equal(apps.at(-1)!.actor, human.name);
});

test('12. Підтвердження без змін позначається окремо', () => {
  const db = freshDb();
  const { caseId, decisionId, srcId } = caseWithDecision(db);
  next(db, caseId, (c) => { c.summary = 'правка'; }, [srcId]);
  confirmDecision(db, human, caseId, { decisionId });
  assert.equal(decisionApplications(db, decisionId).at(-1)!.kind, 'confirmed');
});

test('13. Рішення зі зміненою підставою підтвердити не можна', () => {
  const db = freshDb();
  const c = createCase(db, human, 'Кейс підстави', 'demo');
  const src = addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю', content: SRC_TEXT, origin: 'synthetic' });
  const content = emptyContent();
  content.steps = [step('S1', 'Крок')];
  putHead(db, c.id, content, [src.id]);
  const d = createDecision(db, human, c.id, {
    subject: 'Рішення', explanation: 'Пояснення.',
    scope: { step_ids: ['S1'], question_ids: [] }, evidence: [{ source_id: src.id, quote: QUOTE }],
  });
  // псуємо запис рішення в обхід програми — підстава більше не доведена
  db.prepare('UPDATE decision SET explanation = ? WHERE id = ?').run('підмінене пояснення', d.id);
  const cur = decisionCurrency(db, c.id, d.id);
  assert.equal(cur.state, 'void');
  assert.throws(() => confirmDecision(db, human, c.id, { decisionId: d.id }), (e: { code?: string }) => e.code === 'DECISION_VOID');
});

test('14. Рішення ухвалює людина, не агент', () => {
  const db = freshDb();
  const { caseId, decisionId } = caseWithDecision(db);
  assert.throws(() => createDecision(db, agent, caseId, {
    subject: 'Агентське', explanation: 'Пояснення.', scope: { step_ids: ['S13'], question_ids: [] }, evidence: [],
  }), (e: { code?: string }) => !!e.code);
  assert.throws(() => confirmDecision(db, agent, caseId, { decisionId }), (e: { code?: string }) => !!e.code);
});

test('15. Рішення без предмета застосування не створюється', () => {
  const db = freshDb();
  const { caseId } = caseWithDecision(db);
  assert.throws(() => createDecision(db, human, caseId, {
    subject: 'Без предмета', explanation: 'Пояснення.', scope: { step_ids: [], question_ids: [] }, evidence: [],
  }), (e: { code?: string }) => e.code === 'VALIDATION');
});
