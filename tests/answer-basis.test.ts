/**
 * D93. Підстава відповіді на питання.
 *
 * Три ознаки зберігаються ОКРЕМО й не зводяться одна до одної:
 *  • походження інформації — `derived_from_source_id` + `derived_quote`;
 *  • авторство редакції — `edited_by`;
 *  • тип змісту — `content_type`.
 *
 * Редагування цитати НЕ перетворює відповідь на власний висновок аналітикині.
 * Критичне питання про фактичний AS-IS не закривається бажаним варіантом процесу.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, type DB } from '../src/db.ts';
import { addSource, answerQuestion, headVersion, insertVersion, versionContent, type SourceRow } from '../src/domain.ts';
import { createCase } from '../src/domain.ts';
import { emptyContent, type Content } from '../src/schema.ts';
import { freshDb, human, agent } from './helpers.ts';

const QUOTE = 'Після відхилення винятку менеджерка повідомляє клієнта листом.';
const SOURCE_TEXT = `Інтерв'ю. ${QUOTE} Далі заявку закривають.`;

function caseWith(db: DB, opts: { critical: boolean; srcOrigin: 'real' | 'synthetic' }) {
  const c = createCase(db, human, 'Кейс підстави', 'demo');
  const src = addSource(db, human, c.id, {
    kind: 'transcript', title: 'Інтерв’ю 1', content: SOURCE_TEXT, origin: opts.srcOrigin, ref: 'SRC-01',
  });
  const content: Content = emptyContent();
  content.questions = [{
    id: 'Q1', text: 'Що відбувається після відхилення винятку?', critical: opts.critical, impact: 'Опис завершення',
    addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '',
  }];
  const v = insertVersion(db, {
    caseId: c.id, content, createdBy: 'analyst', actorName: human.name,
    parentId: headVersion(db, c.id).id, covered: [src.id], owned: [],
  });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  return { caseId: c.id, versionId: v.id, srcId: src.id };
}
const clar = (db: DB, caseId: string) =>
  one<SourceRow>(db, 'SELECT * FROM source WHERE case_id = ? AND kind = ? ORDER BY rowid DESC', caseId, 'clarification')!;

test('1. Дослівна цитата: зв’язок із джерелом, редакції немає, походження успадковано', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: true, srcOrigin: 'synthetic' });
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1', answer: QUOTE,
    basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: false },
  });
  const s = clar(db, caseId);
  assert.equal(s.derived_from_source_id, srcId, 'зв’язок із джерелом збережено');
  assert.equal(s.derived_quote, QUOTE);
  assert.equal(s.edited_by, null, 'редакції не було');
  assert.equal(s.content_type, 'source_quote');
  assert.equal(s.origin, 'synthetic', 'походження успадковано від джерела, повторно питати не треба');
});

test('2. Відредагована відповідь НЕ стає «рішенням аналітика»: джерело й редакція зберігаються окремо', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: true, srcOrigin: 'real' });
  const edited = QUOTE + ' Копію листа зберігають у CRM.';
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1', answer: edited,
    basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: true },
  });
  const s = clar(db, caseId);
  assert.equal(s.derived_from_source_id, srcId, 'зв’язок із джерелом НЕ розірвано');
  assert.equal(s.derived_quote, QUOTE, 'вихідний фрагмент збережено — редакцію видно');
  assert.equal(s.edited_by, human.name, 'авторство редакції записано окремо');
  assert.equal(s.content_type, 'source_quote_edited', 'тип змісту — відредагована цитата, а не власний висновок');
  assert.notEqual(s.content_type, 'analyst_confirmed');
  assert.equal(s.content, edited);
});

test('3. Редагування без явної позначки все одно фіксується як редакція', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: false, srcOrigin: 'real' });
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1', answer: QUOTE + ' І ще дещо.',
    basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: false },
  });
  const s = clar(db, caseId);
  assert.equal(s.content_type, 'source_quote_edited', 'розбіжність тексту з цитатою сама по собі є редакцією');
  assert.equal(s.edited_by, human.name);
});

test('4. Цитати немає в джерелі — підстави немає, відповідь не приймається', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: true, srcOrigin: 'synthetic' });
  const before = versionContent(headVersion(db, caseId)!).questions[0]!.status;
  assert.throws(
    () => answerQuestion(db, human, caseId, {
      baseVersionId: versionId, questionId: 'Q1', answer: 'Будь-що',
      basis: { kind: 'source', sourceId: srcId, quote: 'Такого в джерелі не писали.', edited: false },
    }),
    (e: { code?: string }) => e.code === 'QUOTE_NOT_FOUND');
  assert.equal(versionContent(headVersion(db, caseId)!).questions[0]!.status, before, 'питання лишилось відкритим');
});

test('5. Критичне питання не закривається бажаним варіантом: потрібне явне твердження про факт', () => {
  const db = freshDb();
  const { caseId, versionId } = caseWith(db, { critical: true, srcOrigin: 'synthetic' });
  assert.throws(
    () => answerQuestion(db, human, caseId, {
      baseVersionId: versionId, questionId: 'Q1', answer: 'Треба, щоб менеджерка одразу дзвонила клієнту.',
      origin: 'synthetic',
      basis: { kind: 'analyst_confirmed', note: 'Так буде зручніше' },
    }),
    (e: { code?: string }) => e.code === 'FACTUAL_BASIS_REQUIRED',
    'без підтвердження фактичності критичне питання закривати не можна');
  assert.equal(versionContent(headVersion(db, caseId)!).questions[0]!.status, 'open');
});

test('6. Власний висновок потребує заявленої підстави', () => {
  const db = freshDb();
  const { caseId, versionId } = caseWith(db, { critical: false, srcOrigin: 'synthetic' });
  assert.throws(
    () => answerQuestion(db, human, caseId, {
      baseVersionId: versionId, questionId: 'Q1', answer: 'Відповідь', origin: 'synthetic',
      basis: { kind: 'analyst_confirmed', note: '   ' },
    }),
    (e: { code?: string }) => e.code === 'VALIDATION');
});

test('7. Підтверджений висновок аналітикині записується як окремий тип змісту', () => {
  const db = freshDb();
  const { caseId, versionId } = caseWith(db, { critical: true, srcOrigin: 'synthetic' });
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1', answer: 'Процес завершується закриттям заявки.',
    origin: 'synthetic',
    basis: { kind: 'analyst_confirmed', note: 'Спостерігала особисто на двох кейсах у вересні.', acknowledgedFactual: true },
  });
  const s = clar(db, caseId);
  assert.equal(s.content_type, 'analyst_confirmed');
  assert.equal(s.derived_from_source_id, null, 'джерела немає — це власний висновок');
  assert.equal(s.derived_quote, 'Спостерігала особисто на двох кейсах у вересні.', 'підстава збережена');
});

test('8. Редагування синтетичної цитати потребує підтвердження походження (захист D18)', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: false, srcOrigin: 'synthetic' });
  assert.throws(
    () => answerQuestion(db, human, caseId, {
      baseVersionId: versionId, questionId: 'Q1', answer: QUOTE + ' Клієнт Іваненко скаржився 3 вересня.',
      basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: true },
    }),
    (e: { code?: string }) => e.code === 'VALIDATION',
    'у відредагованому тексті могли з’явитися справжні дані — походження підтверджує людина');
  // з явним підтвердженням — проходить
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1', answer: QUOTE + ' Додано пояснення.',
    origin: 'synthetic', basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: true },
  });
  assert.equal(clar(db, caseId).origin, 'synthetic');
});

test('9. Редагування реальної цитати лишається реальним без повторного запитання', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: false, srcOrigin: 'real' });
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1', answer: QUOTE + ' Уточнення аналітикині.',
    basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: true },
  });
  assert.equal(clar(db, caseId).origin, 'real', 'реальні дані не можна мовчки перемаркувати синтетичними');
});

test('10. Підстава обов’язкова: без неї питання не закривається', () => {
  const db = freshDb();
  const { caseId, versionId } = caseWith(db, { critical: true, srcOrigin: 'synthetic' });
  assert.throws(
    () => answerQuestion(db, human, caseId, {
      baseVersionId: versionId, questionId: 'Q1', answer: 'Відповідь', origin: 'synthetic',
      basis: { kind: 'wish' } as never,
    }),
    (e: { code?: string }) => e.code === 'VALIDATION');
  assert.equal(versionContent(headVersion(db, caseId)!).questions[0]!.status, 'open');
});

test('11. Агент відповіді не дає — це дія людини', () => {
  const db = freshDb();
  const { caseId, versionId, srcId } = caseWith(db, { critical: false, srcOrigin: 'synthetic' });
  assert.throws(
    () => answerQuestion(db, agent, caseId, {
      baseVersionId: versionId, questionId: 'Q1', answer: QUOTE,
      basis: { kind: 'source', sourceId: srcId, quote: QUOTE, edited: false },
    }),
    (e: { code?: string }) => e.code === 'FORBIDDEN_ACTOR' || e.code === 'FORBIDDEN');
});

test('12. Джерело з іншого кейсу підставою бути не може', () => {
  const db = freshDb();
  const a = caseWith(db, { critical: false, srcOrigin: 'synthetic' });
  const b = caseWith(db, { critical: false, srcOrigin: 'synthetic' });
  assert.throws(
    () => answerQuestion(db, human, a.caseId, {
      baseVersionId: a.versionId, questionId: 'Q1', answer: QUOTE,
      basis: { kind: 'source', sourceId: b.srcId, quote: QUOTE, edited: false },
    }),
    (e: { code?: string }) => e.code === 'NOT_FOUND');
});
