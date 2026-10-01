/**
 * Дві помилки, відтворені незалежною перевіркою (Codex) на analyst-v0.6 — D73:
 *  1. `problems[].cause_source_id` не перетворювався між позначками джерел (SRC-xx) і внутрішніми ID:
 *     коректна відповідь моделі відхилялась як UNKNOWN_SOURCE, а `toModel` лишав внутрішній ID у цьому полі.
 *  2. Правило застарілого опису кроку міряло зміну ОБ'ЄКТА, а не актуальність ЗМІСТУ: підтвердження вже
 *     правильного опису відхилялось, а застарілий текст зі зміненими лише `source_ids` проходив.
 * Дані — мінімальні синтетичні; «агент» — підставний клієнт: це перевірка логіки програми, а не якості моделі.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentOutput } from '../src/ai/verify.ts';
import { idMaps } from '../src/ai/idmap.ts';
import { ScriptedDemoClient, runAnalyst } from '../src/runs.ts';
import { addSource, buildCard, createCase, headVersion, insertVersion, versionContent } from '../src/domain.ts';
import { run as sqlRun } from '../src/db.ts';
import { emptyContent, type Content, type Problem } from '../src/schema.ts';
import { canonical } from '../src/hash.ts';
import { freshDb, human } from './helpers.ts';
import { Q, T, baseContent } from './agent1-fixtures.ts';

const SRC_TEXT = 'Оператор публікує повідомлення в каналі. Мітки для таких випадків у нас немає.';
const QUOTE = 'Мітки для таких випадків у нас немає.';

const step = (id: string, action: string, details: string, next: { to: string; condition?: string }[], sources: string[] = []) =>
  ({ ...T(id, 'Оператор', action, 'результат', next), details, source_ids: sources });

const problem = (over: Partial<Problem> = {}): Problem => ({
  id: 'P1', symptom: 'Випадки не позначаються.', cause: '', impact: 'Масштаб не можна порахувати.', impact_is_estimate: true, ...over,
});

/** Кейс із одним джерелом, у якого є і внутрішній ID, і позначка SRC-03 (як у сценарії). */
function caseWithRefSource(db: ReturnType<typeof freshDb>, content?: Content) {
  const c = createCase(db, human, 'Синтетичний кейс із позначкою джерела', 'demo');
  const src = addSource(db, human, c.id, { kind: 'transcript', title: 'Синтетична розмова', content: SRC_TEXT, origin: 'synthetic', ref: 'SRC-03' });
  if (content) {
    const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: 'Аналітикиня', parentId: headVersion(db, c.id).id, covered: [], owned: [] });
    sqlRun(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v.id, c.id);
  }
  return { caseId: c.id, srcId: src.id };
}

const maps = (srcId: string) => idMaps([{ id: srcId, ref: 'SRC-03' }]);

// ───────── 1. Перетворення cause_source_id в обидва боки ─────────

test('1. Відповідь моделі з cause_source_id у позначці SRC-03 приймається (ID перетворюється з позначки у внутрішній)', () => {
  const srcId = 'src_example0001';
  const base = baseContent();
  const out = baseContent();
  out.problems = [problem({ cause: 'За словами співрозмовника, мітки немає.', cause_status: 'source_stated', cause_source_id: 'SRC-03', cause_quote: QUOTE })];
  const r = verifyAgentOutput(out, { base, sources: [{ id: srcId, text: SRC_TEXT }], fromModel: maps(srcId).fromModel });
  assert.ok(r.ok, `очікували приймання, отримали: ${r.ok ? '' : r.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`);
  assert.equal(r.content.problems[0]!.cause_source_id, srcId, 'у збереженому змісті має бути внутрішній ID');
});

test('1. Контроль: та сама відповідь із внутрішнім ID теж приймається', () => {
  const srcId = 'src_example0001';
  const out = baseContent();
  out.problems = [problem({ cause: 'За словами співрозмовника.', cause_status: 'source_stated', cause_source_id: srcId, cause_quote: QUOTE })];
  const r = verifyAgentOutput(out, { base: baseContent(), sources: [{ id: srcId, text: SRC_TEXT }], fromModel: maps(srcId).fromModel });
  assert.ok(r.ok);
});

test('1. toModel показує моделі позначку SRC-03, а не внутрішній ID', () => {
  const srcId = 'src_example0001';
  const c = baseContent();
  c.problems = [problem({ cause: 'За словами співрозмовника.', cause_status: 'source_stated', cause_source_id: srcId, cause_quote: QUOTE })];
  assert.equal(maps(srcId).toModel(c).problems[0]!.cause_source_id, 'SRC-03');
});

test('1. Повний шлях: підставний клієнт бачить SRC-позначки й повертає їх — джерело й цитата збережені й відкриваються в картці', async () => {
  const db = freshDb();
  const { caseId, srcId } = caseWithRefSource(db);
  const seenSources: string[] = [];
  const client = new ScriptedDemoClient((input) => {
    seenSources.push(...input.sources.map((s) => s.id));
    const out = structuredClone(input.head_content);
    out.problems = [problem({ cause: 'За словами співрозмовника, мітки немає.', cause_status: 'source_stated', cause_source_id: input.sources[0]!.id, cause_quote: QUOTE })];
    return out;
  });
  const res = await runAnalyst(db, caseId, client);
  assert.ok(res.ok, `запуск не пройшов: ${res.ok ? '' : res.error}`);
  assert.deepEqual(seenSources, ['SRC-03'], 'моделі показано позначку, а не внутрішній ID');

  const saved = versionContent(headVersion(db, caseId)).problems[0]!;
  assert.equal(saved.cause_source_id, srcId);
  assert.equal(saved.cause_quote, QUOTE);

  const card = buildCard(db, caseId, 'demo') as { problems_view: Record<string, unknown>[] };
  const view = card.problems_view[0]!;
  assert.equal(view.cause_source_id, srcId);
  assert.equal(view.cause_source_title, 'Синтетична розмова');
  assert.equal(view.cause_quote_check, 'quote_found', 'цитата має відкриватися в джерелі');
});

test('1. Невідоме джерело в причині відхиляється', () => {
  const srcId = 'src_example0001';
  const out = baseContent();
  out.problems = [problem({ cause: 'причина', cause_status: 'source_stated', cause_source_id: 'SRC-404', cause_quote: QUOTE })];
  const r = verifyAgentOutput(out, { base: baseContent(), sources: [{ id: srcId, text: SRC_TEXT }], fromModel: maps(srcId).fromModel });
  assert.ok(!r.ok && r.violations.some((v) => v.code === 'UNKNOWN_SOURCE'));
});

test('1. Вигадана цитата причини відхиляється, навіть коли джерело вказане позначкою', () => {
  const srcId = 'src_example0001';
  const out = baseContent();
  out.problems = [problem({ cause: 'причина', cause_status: 'source_stated', cause_source_id: 'SRC-03', cause_quote: 'цього в джерелі немає' })];
  const r = verifyAgentOutput(out, { base: baseContent(), sources: [{ id: srcId, text: SRC_TEXT }], fromModel: maps(srcId).fromModel });
  assert.ok(!r.ok && r.violations.some((v) => v.code === 'QUOTE_NOT_FOUND'));
});

test('1. Старі версії без нових полів перетворення не змінює', () => {
  const srcId = 'src_example0001';
  const c = emptyContent();
  c.problems = [{ id: 'P1', symptom: 'с', cause: 'причина без підстави', impact: 'в', impact_is_estimate: false }];
  const m = maps(srcId);
  assert.equal(canonical(m.toModel(c)), canonical(c));
  assert.equal(canonical(m.fromModel(c)), canonical(c));
});

// ───────── 2. Актуальність опису ≠ зміна об'єкта ─────────

const ctx = (base: Content, srcId: string) => ({ base, sources: [{ id: srcId, text: SRC_TEXT }], fromModel: (c: Content) => c });
const verify = (base: Content, out: Content, srcId = 'src_example0001') => verifyAgentOutput(structuredClone(out), ctx(base, srcId));
const codes = (r: ReturnType<typeof verify>) => (r.ok ? [] : r.violations.map((v) => v.code));
const warns = (r: ReturnType<typeof verify>) => (r.ok ? r.warnings : []);

/** Крок B описаний ПРАВИЛЬНО; питання лише просило підтвердження. */
function correctStepBase(): Content {
  const c = baseContent();
  c.steps = [
    step('A', 'Надсилає запит', '', [{ to: 'B' }]),
    step('B', 'Оператор публікує повідомлення', 'Публікує в каналі.', [{ to: 'END' }]),
  ];
  c.questions = [Q('Q1', 'Чи справді оператор публікує повідомлення сам?', [{ step: 'B', condition: '', kind: 'step_detail' }])];
  return c;
}

/** Крок B описаний ЗАСТАРІЛО («невідомо, як…»). */
function staleStepBase(): Content {
  const c = correctStepBase();
  c.steps[1] = step('B', 'Готує повідомлення', 'Невідомо, як оператор публікує повідомлення.', [{ to: 'END' }]);
  return c;
}

const closeQ1 = (c: Content, srcId: string): Content => {
  const out = structuredClone(c);
  out.questions[0] = { ...out.questions[0]!, status: 'closed', answer: 'За джерелом: оператор публікує повідомлення сам.', closed_by_source_id: srcId };
  return out;
};

test('2А. Підтвердження вже правильного опису не відхиляється й не вимагає косметичного переписування', () => {
  const srcId = 'src_example0001';
  const base = correctStepBase();
  const out = closeQ1(base, srcId);
  assert.equal(canonical(out.steps[1]), canonical(base.steps[1]), 'крок справді не переписано');
  const r = verify(base, out, srcId);
  assert.deepEqual(codes(r), [], `відхилення не має бути; отримали: ${codes(r).join(',')}`);
  assert.ok(warns(r).some((w) => w.includes('кроку B')), `очікували попередження про крок B, отримали: ${warns(r).join(' | ') || '(порожньо)'}`);
});

test('2Б. Застарілий текст зі зміненими лише службовими полями не вважається оновленим', () => {
  const srcId = 'src_example0001';
  const base = staleStepBase();
  const out = closeQ1(base, srcId);
  out.steps[1] = { ...out.steps[1]!, source_ids: [srcId] }; // змінились лише джерела
  assert.notEqual(canonical(out.steps[1]), canonical(base.steps[1]), 'об’єкт кроку змінився');
  const r = verify(base, out, srcId);
  assert.deepEqual(codes(r), [], 'смислову суперечність програма не встановлює — відмови немає');
  assert.ok(warns(r).some((w) => w.includes('кроку B') && w.includes('службов')),
    `очікували попередження про зміну лише службових полів, отримали: ${warns(r).join(' | ') || '(порожньо)'}`);
});

test('2В. Зміна тексту опису сама по собі не вважається доказом правильності: місце все одно позначається для перевірки', () => {
  const srcId = 'src_example0001';
  const base = staleStepBase();
  const out = closeQ1(base, srcId);
  out.steps[1] = { ...out.steps[1]!, details: 'За джерелом: оператор публікує повідомлення в каналі.' };
  const r = verify(base, out, srcId);
  assert.deepEqual(codes(r), []);
  assert.ok(warns(r).some((w) => w.includes('кроку B')), 'оновлений опис теж лишається місцем для перевірки людиною');
});

test('2. Контроль: відкрите питання місця для перевірки не створює', () => {
  const srcId = 'src_example0001';
  const base = staleStepBase();
  const out = structuredClone(base);
  const r = verify(base, out, srcId);
  assert.deepEqual(codes(r), []);
  assert.ok(!warns(r).some((w) => w.includes('кроку B')));
});

test('2. Контроль: структурні блокування лишаються — невідомий перехід, суперечність і непідтверджена послідовність', () => {
  const srcId = 'src_example0001';
  const base = baseContent();
  const out = baseContent();
  out.steps = [step('A', 'Надсилає запит', '', [{ to: 'UNKNOWN' }])];
  assert.ok(codes(verify(base, out, srcId)).includes('UNKNOWN_WITHOUT_DIRECTION_QUESTION'));

  const out2 = baseContent();
  out2.steps = [step('A', 'Надсилає запит', '', [{ to: 'B' }]), step('B', 'Обробляє', '', [{ to: 'END' }])];
  out2.questions = [Q('Q1', 'Куди веде крок після A?', [{ step: 'A', condition: '', kind: 'direction' }])];
  assert.ok(codes(verify(base, out2, srcId)).includes('LINK_DIRECTION_KNOWN_TARGET'));

  const out3 = baseContent();
  out3.steps = [step('A', 'Надсилає запит', '', [{ to: 'UNKNOWN', condition: 'умова' }])];
  out3.questions = [Q('Q1', 'Що буде, якщо не надіслано?', [{ step: 'A', condition: 'умова', kind: 'exception' }])];
  assert.ok(codes(verify(base, out3, srcId)).includes('LINK_KIND_UNKNOWN_TARGET'));
});
