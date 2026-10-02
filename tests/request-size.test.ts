/**
 * Обсяг запиту й відповіді агента 1 (D78). Підстава — обірваний прогін analyst-v0.7:
 * 51 801 вх. / 48 000 вих. токенів, $1,167, версія не змінилась (`stop_reason: max_tokens`).
 *
 * Тут перевіряється: у запиті немає марної ваги (відступи JSON, поля, якими володіє програма),
 * нічого змістовного при цьому не зникає, і прогін, відповідь якого завідомо не вміщується
 * у стелю виходу, зупиняється ДО оплати з конкретними числами.
 *
 * Оцінка обсягу — ЕВРИСТИКА, а не гарантована межа, і нижня межа відповіді існує лише для контракту
 * «повна версія». Для часткового оновлення (D80) її не існує, тому оцінку накопиченого опису до нього
 * не застосовують і запуск за розміром опису не блокують — це теж перевіряється тут (K10).
 * Усе — на підставному клієнті: платних викликів немає.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { one, type DB } from '../src/db.ts';
import { buildUserMessage, loadInstruction } from '../src/ai/prompt.ts';
import { answerFeasibility, CHARS_PER_OUTPUT_TOKEN, THINKING_RATIO } from '../src/ai/budget.ts';
import { ScriptedDemoClient, beginAnalystRun, runAnalyst } from '../src/runs.ts';
import { addSource, headVersion, insertVersion, versionContent } from '../src/domain.ts';
import { emptyContent, type Content } from '../src/schema.ts';
import { approvedCase, draftReadyCase, freshDb, human, newCase } from './helpers.ts';
import { policyOf } from './review-helpers.ts';

const ins = loadInstruction();
const SRC = { id: 'SRC-01', title: 'Інтерв’ю (синтетичне)', kind: 'transcript', origin: 'synthetic', text: 'Виконавець реєструє запит, потім надсилає відповідь.' };

/** Зміст із «вагою»: багато тверджень, питань і кроків — як у накопиченому кейсі. */
function heavyContent(claims: number): Content {
  const c = emptyContent();
  c.summary = 'Синтетичний накопичений опис.';
  c.business_context = 'Вигаданий процес для перевірки обсягу.';
  c.process_name = 'Обробка запиту (синтетичний процес)';
  c.steps = [{ id: 'S1', role: 'Виконавець', action: 'Реєструє запит', entry_condition: '', input_artifact: '', result: 'Запит зареєстровано', next: [{ to: 'END', condition: '' }], source_ids: [], details: 'Подробиці кроку.' }];
  c.claims = Array.from({ length: claims }, (_, i) => ({
    id: `C${i + 1}`, text: `Твердження номер ${i + 1} про фактичну роботу виконавця у процесі обробки запиту.`,
    type: 'source_fact' as const, source_id: 'SRC-01', quote: 'Виконавець реєструє запит',
    scope: 'Слова виконавця про свою ділянку; спостереження, а не оцінка.',
  }));
  c.questions = Array.from({ length: 12 }, (_, i) => ({
    id: `Q${i + 1}`, text: `Питання номер ${i + 1} про межі та зміст процесу?`, critical: false,
    impact: 'Уточнить опис кроку', addressee: 'Виконавець', status: 'open' as const, answer: '',
    closed_by_source_id: null, origin: 'agent' as const, criticality_note: '',
  }));
  return c;
}

const msgOf = (content: Content) => buildUserMessage({ instruction: ins, head_content: content, sources: [SRC] });

// ───────── 1. У запиті немає марної ваги ─────────

test('1. AS-IS надсилається компактно: відступи JSON у запит не потрапляють', () => {
  const c = heavyContent(20);
  const msg = msgOf(c);
  const compact = JSON.stringify(c);
  const pretty = JSON.stringify(c, null, 1);
  assert.ok(msg.includes(compact), 'у запиті має бути компактний JSON');
  assert.ok(!msg.includes(pretty), 'відступлений JSON у запит не потрапляє');
  assert.ok(pretty.length - compact.length > 500, `контроль: відступи справді важать (${pretty.length - compact.length} симв.)`);
});

test('1. Поля, якими володіє програма, моделі не надсилаються (їх відповідь усе одно перезаписується)', () => {
  const c = heavyContent(3);
  c.conflicts = [{ key: 'step:S1', kept: 'варіант аналітикині (довгий текст, що накопичується)', proposed: 'варіант агента', note: 'пояснення' }];
  c.questions[0] = { ...c.questions[0]!, link_history: [{ at: '2026-01-01T00:00:00.000Z', by: 'Аналітикиня', step_id: 'S1', condition: '', from: 'direction', to: 'step_detail', note: 'виправлення' }] };
  const msg = msgOf(c);
  assert.ok(!msg.includes('варіант аналітикині'), 'конфлікти моделі не надсилаються');
  assert.ok(!msg.includes('link_history'), 'історія виправлень прив’язки моделі не надсилається');
  // Контроль: решта змісту на місці.
  assert.ok(msg.includes('Твердження номер 1'));
  assert.ok(msg.includes('Питання номер 1'));
});

test('1. Нічого змістовного не зникає: кроки, твердження з цитатами, питання, гіпотези, проблеми й тексти джерел на місці', () => {
  const c = heavyContent(5);
  c.problems = [{ id: 'P1', symptom: 'Симптом', cause: '', cause_status: 'not_established', impact: 'Вплив', impact_is_estimate: true }];
  c.hypotheses = [{ id: 'H1', author: 'agent', text: 'Гіпотеза про причину', status: 'open', evidence_for: ['C1'], evidence_against: [], check_method: 'Спосіб перевірки', history: [] }];
  c.step_proposals = [{ id: 'R1', action: 'remove', step_id: 'S1', replacement_step_id: '', reason: 'причина', evidence_source_id: 'SRC-01', evidence_quote: 'Виконавець реєструє запит', status: 'proposed', decided_by: '', decision_note: '' }];
  const msg = msgOf(c);
  for (const must of ['Реєструє запит', 'Виконавець реєструє запит', 'Твердження номер 5', 'Питання номер 12',
    'Гіпотеза про причину', 'Спосіб перевірки', 'Симптом', 'R1', SRC.text, 'Обробка запиту (синтетичний процес)']) {
    assert.ok(msg.includes(must), `у запиті немає: ${must}`);
  }
});

// ───────── 2. Оцінка вміщення відповіді ─────────

test('2. Оцінка вміщення рахується з накопиченого змісту й стелі виходу', () => {
  const small = heavyContent(5);
  const big = heavyContent(400);
  const f1 = answerFeasibility(small, 48_000);
  const f2 = answerFeasibility(big, 48_000);
  assert.equal(f1.ok, true, JSON.stringify(f1));
  assert.equal(f2.ok, false, JSON.stringify(f2));
  assert.ok(f2.needTokens! > 48_000 && f2.answerTokens! > 0);
  // Оцінка прозора: з неї видно, звідки взялось число.
  assert.equal(f2.answerTokens, Math.ceil((JSON.stringify(big).length / CHARS_PER_OUTPUT_TOKEN) * 1.25));
  assert.equal(f2.needTokens, Math.ceil(f2.answerTokens! * (1 + THINKING_RATIO)));
});

test('2. Калібровка відповідає справжньому прогону, який пройшов: він НЕ був би відхилений', () => {
  // Етап 2 контрольного прогону v0.5: відповідь 35 060 символів компактного JSON, стеля 48 000 — пройшов успішно.
  const fake = { ...emptyContent(), summary: 'x'.repeat(35_060 - JSON.stringify(emptyContent()).length) } as Content;
  const f = answerFeasibility(fake, 48_000);
  assert.equal(f.ok, true, `прогін, що справді завершився, має проходити перевірку: ${JSON.stringify(f)}`);
});

test('2. K10. Для часткового оновлення нижньої межі відповіді не існує: оцінку повного опису не застосовують', () => {
  const big = heavyContent(400);
  const full = answerFeasibility(big, 48_000, 'full');
  const delta = answerFeasibility(big, 48_000, 'delta');
  assert.equal(full.ok, false, 'контроль: за повного контракту такий опис не вміщується');
  assert.equal(delta.ok, true, 'за часткового оновлення розмір опису відповідь не визначає');
  assert.equal(delta.answerTokens, null, 'нижньої межі немає — це «невідомо наперед», а не нуль');
  assert.equal(delta.needTokens, null);
  assert.equal(delta.contentChars, full.contentChars, 'розмір опису рахується однаково — він лише не є межею');
});

// ───────── 3. Зупинка ДО оплати ─────────

/** Кейс із накопиченим змістом як головою версії. */
function caseWithContent(db: DB, content: Content) {
  const { c } = draftReadyCase(db);
  const v = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, c.id).id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  return c.id;
}

/** Підставний клієнт у режимі `real` — лише щоб перевірити, що до нього справа не дійшла. */
class CountingClient {
  readonly mode = 'real' as const;
  readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (тест, не модель)';
  calls = 0;
  async analyze() { this.calls++; return { output: emptyContent() }; }
}

test('3. Якщо відповідь завідомо не вміститься — запуск зупиняється до виклику моделі, без витрат', () => {
  const db = freshDb();
  const caseId = caseWithContent(db, heavyContent(600));
  const client = new CountingClient();
  const before = headVersion(db, caseId).id;
  const policy = policyOf();
  assert.throws(
    () => beginAnalystRun(db, caseId, client as never, { policy }),
    (e: { code?: string; message?: string }) => e.code === 'OUTPUT_TOO_LARGE' && e.message!.includes(String(policy.maxOutputTokens)),
    'очікували зупинку з конкретними числами (зокрема зі стелею виходу)');
  assert.equal(client.calls, 0, 'моделі не викликали');
  assert.equal(headVersion(db, caseId).id, before, 'версія не змінилась');
  assert.equal(one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM run WHERE case_id = ?`, caseId)!.n, 0, 'запуску не створено — витрат немає');
  // Відмова названа в журналі дій.
  const a = one<{ action: string; details_json: string }>(db, 'SELECT action, details_json FROM audit_log WHERE case_id = ? ORDER BY id DESC LIMIT 1', caseId)!;
  assert.equal(a.action, 'run_refused');
  assert.match(a.details_json, /OUTPUT_TOO_LARGE/);
});

test('3. Пояснення відмови називає числа й що робити далі, без поради «просто підніми ліміт»', () => {
  const db = freshDb();
  const caseId = caseWithContent(db, heavyContent(600));
  try {
    beginAnalystRun(db, caseId, new CountingClient() as never, { policy: policyOf() });
    assert.fail('мало бути відхилено');
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /опис/i);
    assert.ok(/\d/.test(m), 'у поясненні мають бути числа');
    assert.match(m, /етап|розділ|уточн/i, 'має бути названа змістовна наступна дія');
  }
});

test('3. K10. За контракту часткового оновлення великий опис запуск НЕ блокує', () => {
  const db = freshDb();
  // Опис, завеликий для ПОВНОЇ відповіді, але в межах ліміту на обсяг входу: часткове оновлення знімає стелю
  // виходу, а не ліміт входу — джерела й опис не скорочуються, тому CX_MAX_INPUT_CHARS лишається чинним.
  const caseId = caseWithContent(db, heavyContent(400));
  const client = new CountingClient();
  // Той самий зміст, на якому повний контракт зупиняється до оплати.
  assert.throws(() => beginAnalystRun(db, caseId, client as never, { policy: policyOf() }), (e: { code?: string }) => e.code === 'OUTPUT_TOO_LARGE');
  const ctx = beginAnalystRun(db, caseId, client as never, { policy: policyOf(), contract: 'delta' });
  assert.ok(ctx.runId, 'запуск за частковим оновленням дозволено');
  const checks = JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', ctx.runId)!.checks_json) as
    { size: { contract: string; content_chars: number; answer_floor_tokens: number | null } };
  assert.equal(checks.size.contract, 'delta');
  assert.ok(checks.size.content_chars > 0, 'розмір опису видно в журналі');
  assert.equal(checks.size.answer_floor_tokens, null, 'нижньої межі відповіді для часткового оновлення немає');
});

test('3. Пояснення відмови називає часткове оновлення як перший змістовний вихід', () => {
  const db = freshDb();
  const caseId = caseWithContent(db, heavyContent(600));
  try {
    beginAnalystRun(db, caseId, new CountingClient() as never, { policy: policyOf() });
    assert.fail('мало бути відхилено');
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /часткового оновлення|CX_OUTPUT_CONTRACT/, 'має бути названо часткове оновлення');
    assert.ok(m.indexOf('CX_OUTPUT_CONTRACT') < m.indexOf('CX_MAX_OUTPUT_TOKENS'), 'підняття стелі згадується ПІСЛЯ змістовних дій');
    assert.match(m, /оцінка/, 'оцінку названо оцінкою, а не гарантованою межею');
  }
});

test('3. Контроль: звичайний за обсягом кейс проходить і модель викликається', async () => {
  const db = freshDb();
  const caseId = caseWithContent(db, heavyContent(5));
  const client = new ScriptedDemoClient((i) => structuredClone(i.head_content));
  const r = await runAnalyst(db, caseId, client);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
});

test('3. Перевірка стосується справжніх клієнтів: підставний (demo) працює без неї', async () => {
  const db = freshDb();
  const caseId = caseWithContent(db, heavyContent(600));
  const client = new ScriptedDemoClient((i) => structuredClone(i.head_content));
  const r = await runAnalyst(db, caseId, client);
  assert.equal(r.ok, true, 'деморежим не обмежується стелею справжньої моделі');
});

test('3. Оцінку обсягу видно в журналі успішного запуску', async () => {
  const db = freshDb();
  const caseId = caseWithContent(db, heavyContent(5));
  const client = new ScriptedDemoClient((i) => structuredClone(i.head_content));
  const r = await runAnalyst(db, caseId, client);
  assert.ok(r.ok);
  const row = one<{ checks_json: string }>(db, 'SELECT checks_json FROM run WHERE id = ?', r.runId)!;
  const checks = JSON.parse(row.checks_json) as { size?: { contract: string; content_chars: number; answer_floor_tokens: number | null; prompt_chars: number } };
  assert.ok(checks.size, 'розмір має бути записаний');
  assert.equal(checks.size!.contract, 'full');
  assert.ok(checks.size!.content_chars > 0 && checks.size!.answer_floor_tokens! > 0 && checks.size!.prompt_chars > 0);
});

// ───────── 4. Захист не послаблено ─────────

test('4. Те, що конфлікти не надсилаються моделі, не дає агентові стерти правки аналітикині', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  const v = insertVersion(db, {
    caseId: c.id, content, createdBy: 'analyst', actorName: human.name, parentId: head.id, covered: [], owned: ['summary'],
  });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, c.id);
  addSource(db, human, c.id, { kind: 'clarification', title: 'Уточнення', content: 'Текст', origin: 'synthetic' });

  const client = new ScriptedDemoClient((i) => ({ ...structuredClone(i.head_content), summary: 'АГЕНТ ПЕРЕПИСАВ СУТЬ' }));
  const r = await runAnalyst(db, c.id, client);
  assert.ok(r.ok);
  const after = versionContent(headVersion(db, c.id));
  assert.notEqual(after.summary, 'АГЕНТ ПЕРЕПИСАВ СУТЬ', 'правку аналітикині збережено');
  assert.ok(after.conflicts.length > 0, 'конфлікт записано програмою');
});
