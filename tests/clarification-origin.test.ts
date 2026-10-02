/**
 * Блокер, знайдений під час наскрізного прогону (D77): походження уточнення визначалося за ТИПОМ КЕЙСУ
 * (`is_demo_script ? 'synthetic' : 'real'`). Навчальний сценарій зі справжньою моделлю демо-скриптом не є,
 * тож синтетичні відповіді аналітикині ставали `real` — і запуск AI відхилявся захистом D18.
 *
 * Тут перевіряється: явний вибір походження (без здогадів за типом кейсу чи текстом відповіді),
 * збереження блокування справжніх реальних даних і виправлення вже помилково позначених уточнень.
 * Усе — на синтетичних даних і підставних клієнтах; платних викликів немає.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, type DB } from '../src/db.ts';
import {
  addSource, answerQuestion, applyOriginCorrection, headVersion, insertVersion, listSources, previewOriginCorrection,
  versionContent, type SourceRow,
} from '../src/domain.ts';
import type { Content } from '../src/schema.ts';
import { createScenarioCase } from '../src/scenarios.ts';
import { ScriptedDemoClient, runAnalyst } from '../src/runs.ts';
import { agent, freshDb, human, newCase, startTestServer } from './helpers.ts';

/** Кладе зміст як голову версії (у продукті так робить редагування; тут — коротко, щоб підготувати стан). */
function putHead(db: DB, caseId: string, content: Content) {
  const v = insertVersion(db, { caseId, content, createdBy: 'analyst', actorName: human.name, parentId: headVersion(db, caseId).id, covered: [], owned: [] });
  db.prepare('UPDATE "case" SET head_version_id = ? WHERE id = ?').run(v.id, caseId);
  return v;
}

const ANSWER = 'За словами замовника, процес завершується після публікації повідомлення (синтетичне уточнення).';

/** Кейс навчального сценарію (НЕ demo_script) з одним відкритим питанням — як у справжньому прогоні. */
function scenarioCaseWithQuestion(db: DB) {
  const c = createScenarioCase(db, human, 'positive', 'real');
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  content.questions = [{
    id: 'Q1', text: 'Чим завершується процес?', critical: true, impact: 'Визначить кінцевий крок', addressee: 'Замовник',
    status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '',
  }];
  const v = putHead(db, c.id, content);
  return { caseId: c.id, versionId: v.id };
}

const srcOf = (db: DB, caseId: string, title: RegExp): SourceRow =>
  listSources(db, caseId).find((s) => title.test(s.title))!;

/** Чи дозволяє захист D18 запустити агента 1 (підставний клієнт із режимом `real`). */
async function aiBlocked(db: DB, caseId: string): Promise<boolean> {
  const client = new (class {
    readonly mode = 'real' as const;
    readonly model = 'ПІДСТАВНИЙ-КЛІЄНТ (тест, не модель)';
    async analyze() { return { output: versionContent(headVersion(db, caseId)) }; }
  })();
  try {
    await runAnalyst(db, caseId, client as never, { policy: undefined });
    return false;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'REAL_DATA_BLOCKED') return true;
    if (code === 'AI_UNAVAILABLE') return false; // дійшло далі за перевірку джерел — отже D18 не блокує
    throw e;
  }
}

// ───────── 1. Явний вибір походження ─────────

test('1. Уточнення в навчальному сценарії з позначкою «синтетичне» не блокує запуск AI', async () => {
  const db = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db);
  answerQuestion(db, human, caseId, { baseVersionId: versionId, questionId: 'Q1', answer: ANSWER, origin: 'synthetic' });
  assert.equal(srcOf(db, caseId, /Уточнення до Q1/).origin, 'synthetic');
  assert.equal(await aiBlocked(db, caseId), false, 'синтетичне уточнення не має блокувати запуск');
});

test('1. Уточнення з позначкою «реальні дані» запуск AI блокує (захист D18 збережено)', async () => {
  const db = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db);
  answerQuestion(db, human, caseId, { baseVersionId: versionId, questionId: 'Q1', answer: ANSWER, origin: 'real' });
  assert.equal(srcOf(db, caseId, /Уточнення до Q1/).origin, 'real');
  assert.equal(await aiBlocked(db, caseId), true, 'реальні дані мають блокувати запуск');
});

test('1. Походження обов’язкове: без нього й з невідомим значенням уточнення не створюється', () => {
  const db = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db);
  const before = listSources(db, caseId).length;
  const versionsBefore = all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', caseId).length;
  for (const bad of [undefined, '', 'demo_script', 'SYNTHETIC', 'так']) {
    assert.throws(
      () => answerQuestion(db, human, caseId, { baseVersionId: versionId, questionId: 'Q1', answer: ANSWER, origin: bad as never }),
      (e: { code?: string }) => e.code === 'VALIDATION',
      `походження «${String(bad)}» мало бути відхилене`);
  }
  assert.equal(listSources(db, caseId).length, before, 'джерела не створено');
  assert.equal(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', caseId).length, versionsBefore, 'версії не створено');
});

test('1. Походження НЕ визначається за типом кейсу', () => {
  // демо-кейс + явно «реальні» → лишається real
  const db1 = freshDb();
  const demo = newCase(db1, 'Демо-кейс');
  db1.exec(`UPDATE "case" SET is_demo_script = 1 WHERE id = '${demo.id}'`);
  const h1 = headVersion(db1, demo.id);
  const c1 = versionContent(h1);
  c1.questions = [{ id: 'Q1', text: 'Питання?', critical: false, impact: '', addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '' }];
  const v1 = putHead(db1, demo.id, c1);
  answerQuestion(db1, human, demo.id, { baseVersionId: v1.id, questionId: 'Q1', answer: ANSWER, origin: 'real' });
  assert.equal(srcOf(db1, demo.id, /Уточнення до Q1/).origin, 'real', 'тип кейсу не має перебивати явний вибір');

  // звичайний (не демо) кейс + явно «синтетичні» → synthetic
  const db2 = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db2);
  answerQuestion(db2, human, caseId, { baseVersionId: versionId, questionId: 'Q1', answer: ANSWER, origin: 'synthetic' });
  assert.equal(srcOf(db2, caseId, /Уточнення до Q1/).origin, 'synthetic');
});

test('1. Походження НЕ визначається за текстом відповіді', () => {
  const db = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db);
  answerQuestion(db, human, caseId, {
    baseVersionId: versionId, questionId: 'Q1',
    answer: 'Це синтетичне навчальне уточнення, вигадане для сценарію.', origin: 'real',
  });
  assert.equal(srcOf(db, caseId, /Уточнення до Q1/).origin, 'real', 'слова «синтетичне» в тексті нічого не вирішують');
});

test('1. Уточнення — дія людини: агент його не створює', () => {
  const db = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db);
  assert.throws(() => answerQuestion(db, agent, caseId, { baseVersionId: versionId, questionId: 'Q1', answer: ANSWER, origin: 'synthetic' }),
    (e: { code?: string; status?: number }) => e.code === 'FORBIDDEN_ACTOR' || e.status === 403);
  assert.equal(listSources(db, caseId).some((s) => /Уточнення/.test(s.title)), false);
});

// ───────── 2. Виправлення помилково позначених уточнень ─────────

/** Кейс із трьома помилково позначеними уточненнями й одним справді реальним джерелом. */
function caseWithMislabelled(db: DB) {
  const c = createScenarioCase(db, human, 'positive', 'real');
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  content.questions = ['Q1', 'Q2', 'Q3'].map((id) => ({
    id, text: `Питання ${id}?`, critical: false, impact: '', addressee: '', status: 'open' as const,
    answer: '', closed_by_source_id: null, origin: 'agent' as const, criticality_note: '',
  }));
  let v = putHead(db, c.id, content);
  for (const id of ['Q1', 'Q2', 'Q3']) {
    v = answerQuestion(db, human, c.id, { baseVersionId: v.id, questionId: id, answer: `Уточнення до ${id} (синтетичне).`, origin: 'real' });
  }
  // Справді реальне джерело — його чіпати не можна.
  const realSrc = addSource(db, human, c.id, { kind: 'transcript', title: 'Справжнє інтерв’ю', content: 'Реальні дані клієнта.', origin: 'real' });
  return { caseId: c.id, realSrcId: realSrc.id };
}

test('2. Попередній перегляд показує лише помилково позначені уточнення названих питань', () => {
  const db = freshDb();
  const { caseId, realSrcId } = caseWithMislabelled(db);
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1', 'Q3'] });
  assert.equal(p.sources.length, 2);
  assert.deepEqual(p.sources.map((s) => s.question_id).sort(), ['Q1', 'Q3']);
  for (const s of p.sources) {
    assert.equal(s.from_origin, 'real');
    assert.equal(s.to_origin, 'synthetic');
    assert.ok(s.title.length > 0 && s.content_preview.length > 0, 'видно, що саме буде перекласифіковано');
  }
  assert.ok(!p.sources.some((s) => s.source_id === realSrcId), 'справжнє реальне джерело в перегляд не потрапляє');
  assert.ok(p.confirm_token.length >= 16, 'перегляд дає підтвердження');
});

test('2. Без підтвердження (і з чужим підтвердженням) нічого не змінюється', () => {
  const db = freshDb();
  const { caseId } = caseWithMislabelled(db);
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  for (const bad of ['', 'ЧУЖЕ-ПІДТВЕРДЖЕННЯ', p.confirm_token.slice(0, -1)]) {
    assert.throws(() => applyOriginCorrection(db, human, caseId, { questionIds: ['Q1'], confirmToken: bad, reason: 'синтетичний сценарій' }),
      (e: { code?: string }) => e.code === 'CONFIRM_REQUIRED');
  }
  assert.equal(listSources(db, caseId).filter((s) => s.origin === 'real').length, 4, 'нічого не змінено');
});

test('2. Підтвердження прив’язане до конкретного набору: для іншого набору не діє', () => {
  const db = freshDb();
  const { caseId } = caseWithMislabelled(db);
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  assert.throws(() => applyOriginCorrection(db, human, caseId, { questionIds: ['Q1', 'Q2'], confirmToken: p.confirm_token, reason: 'синтетичний сценарій' }),
    (e: { code?: string }) => e.code === 'CONFIRM_REQUIRED');
  assert.equal(listSources(db, caseId).filter((s) => s.origin === 'real').length, 4);
});

test('2. Виправлення: походження стає синтетичним, текст, зв’язки й історія версій не змінюються', async () => {
  const db = freshDb();
  const { caseId, realSrcId } = caseWithMislabelled(db);
  const before = {
    sources: listSources(db, caseId).map((s: SourceRow) => ({ id: s.id, content: s.content, hash: s.content_hash, title: s.title, kind: s.kind, seq: s.seq })),
    versions: all<{ id: string; content_hash: string }>(db, 'SELECT id, content_hash FROM as_is_version WHERE case_id = ? ORDER BY number', caseId),
    head: headVersion(db, caseId).id,
    questions: versionContent(headVersion(db, caseId)).questions.map((q) => [q.id, q.status, q.answer, q.closed_by_source_id]),
  };
  assert.equal(await aiBlocked(db, caseId), true, 'до виправлення запуск блокувався');

  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1', 'Q2', 'Q3'] });
  const r = applyOriginCorrection(db, human, caseId, { questionIds: ['Q1', 'Q2', 'Q3'], confirmToken: p.confirm_token, reason: 'синтетичні уточнення навчального сценарію' });
  assert.equal(r.corrected.length, 3);

  // Походження виправлено лише в уточненнях; справжнє реальне джерело лишилось real і далі блокує.
  const after = listSources(db, caseId);
  for (const s of after.filter((x: SourceRow) => /Уточнення/.test(x.title))) assert.equal(s.origin, 'synthetic');
  assert.equal(after.find((s) => s.id === realSrcId)!.origin, 'real');
  assert.equal(await aiBlocked(db, caseId), true, 'справжнє реальне джерело й далі блокує');

  // Текст, зв'язки й історія версій недоторкані.
  assert.deepEqual(after.map((s) => ({ id: s.id, content: s.content, hash: s.content_hash, title: s.title, kind: s.kind, seq: s.seq })), before.sources);
  assert.deepEqual(all<{ id: string; content_hash: string }>(db, 'SELECT id, content_hash FROM as_is_version WHERE case_id = ? ORDER BY number', caseId), before.versions);
  assert.equal(headVersion(db, caseId).id, before.head, 'нової версії не створено');
  assert.deepEqual(versionContent(headVersion(db, caseId)).questions.map((q) => [q.id, q.status, q.answer, q.closed_by_source_id]), before.questions);
});

test('2. Після виправлення всіх реальних джерел запуск AI більше не блокується', async () => {
  const db = freshDb();
  const c = createScenarioCase(db, human, 'positive', 'real');
  const head = headVersion(db, c.id);
  const content = versionContent(head);
  content.questions = [{ id: 'Q1', text: 'Питання?', critical: false, impact: '', addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '' }];
  const v = putHead(db, c.id, content);
  answerQuestion(db, human, c.id, { baseVersionId: v.id, questionId: 'Q1', answer: ANSWER, origin: 'real' });
  assert.equal(await aiBlocked(db, c.id), true);

  const p = previewOriginCorrection(db, c.id, { questionIds: ['Q1'] });
  applyOriginCorrection(db, human, c.id, { questionIds: ['Q1'], confirmToken: p.confirm_token, reason: 'синтетичне уточнення' });
  assert.equal(await aiBlocked(db, c.id), false, 'після виправлення запуск має бути дозволений');
});

test('2. Виправлення записується в аудит і зберігається незмінно; сам запис джерела не переписується', () => {
  const db = freshDb();
  const { caseId } = caseWithMislabelled(db);
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  const r = applyOriginCorrection(db, human, caseId, { questionIds: ['Q1'], confirmToken: p.confirm_token, reason: 'синтетичне уточнення сценарію' });

  const audit = all<{ action: string; actor: string; details_json: string }>(db, 'SELECT action, actor, details_json FROM audit_log WHERE case_id = ? ORDER BY id DESC LIMIT 1', caseId)[0]!;
  assert.equal(audit.action, 'source_origin_corrected');
  assert.equal(audit.actor, `human:${human.name}`, 'у журналі видно, що це дія людини');
  const d = JSON.parse(audit.details_json) as { source_ids: string[]; from: string; to: string; reason: string };
  assert.deepEqual(d.source_ids, r.corrected.map((x: { source_id: string }) => x.source_id));
  assert.deepEqual([d.from, d.to], ['real', 'synthetic']);
  assert.match(d.reason, /синтетичне/);

  // Рядок у таблиці джерел лишається незмінним: виправлення живе окремим незмінним записом.
  const raw = one<{ origin: string }>(db, 'SELECT origin FROM source WHERE id = ?', r.corrected[0]!.source_id)!;
  assert.equal(raw.origin, 'real', 'оригінальний запис джерела не переписується');
  const corr = all<{ id: string }>(db, 'SELECT id FROM source_origin_correction WHERE case_id = ?', caseId);
  assert.equal(corr.length, 1);
  assert.throws(() => db.exec(`UPDATE source_origin_correction SET to_origin = 'real' WHERE id = '${corr[0]!.id}'`), /незмінна/);
  assert.throws(() => db.exec(`DELETE FROM source_origin_correction WHERE id = '${corr[0]!.id}'`), /незмінна/);
});

test('2. Виправляти можна лише уточнення й лише в бік «синтетичні»; інші джерела не чіпаються', () => {
  const db = freshDb();
  const { caseId, realSrcId } = caseWithMislabelled(db);
  // Справжнє інтерв'ю не можна виправити цим шляхом: воно не уточнення й не має питання.
  assert.throws(() => applyOriginCorrection(db, human, caseId, { sourceIds: [realSrcId], confirmToken: 'будь-що', reason: 'спроба' }),
    (e: { code?: string }) => e.code === 'CONFIRM_REQUIRED' || e.code === 'NOT_CORRECTABLE');
  assert.equal(listSources(db, caseId).find((s) => s.id === realSrcId)!.origin, 'real');

  // Уже синтетичне джерело в перегляд не потрапляє (назад у «реальні» цей шлях не веде).
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  applyOriginCorrection(db, human, caseId, { questionIds: ['Q1'], confirmToken: p.confirm_token, reason: 'синтетичне уточнення' });
  const again = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  assert.equal(again.sources.length, 0, 'повторно виправляти нічого');
});

test('2. Виправлення — дія людини: агент його виконати не може', () => {
  const db = freshDb();
  const { caseId } = caseWithMislabelled(db);
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  assert.throws(() => applyOriginCorrection(db, agent, caseId, { questionIds: ['Q1'], confirmToken: p.confirm_token, reason: 'спроба' }),
    (e: { code?: string; status?: number }) => e.code === 'FORBIDDEN_ACTOR' || e.status === 403);
  assert.equal(listSources(db, caseId).filter((s) => s.origin === 'real').length, 4);
});

test('2. Виправлення потребує пояснення', () => {
  const db = freshDb();
  const { caseId } = caseWithMislabelled(db);
  const p = previewOriginCorrection(db, caseId, { questionIds: ['Q1'] });
  assert.throws(() => applyOriginCorrection(db, human, caseId, { questionIds: ['Q1'], confirmToken: p.confirm_token, reason: '  ' }),
    (e: { code?: string }) => e.code === 'VALIDATION');
  assert.equal(listSources(db, caseId).filter((s) => s.origin === 'real').length, 4);
});

// ───────── 3. HTTP: явний вибір і виправлення через API ─────────

test('3. HTTP: уточнення без походження не створюється; із синтетичним — створюється', async () => {
  const db = freshDb();
  const { caseId, versionId } = scenarioCaseWithQuestion(db);
  const s = await startTestServer(db);
  try {
    for (const bad of [undefined, 'demo_script', '']) {
      const r = await s.call('POST', `/api/cases/${caseId}/questions/answer`,
        { base_version_id: versionId, question_id: 'Q1', answer: ANSWER, ...(bad === undefined ? {} : { origin: bad }) });
      assert.equal(r.status, 400, `походження «${String(bad)}» мало бути відхилене`);
      assert.equal(r.body.error.code, 'VALIDATION');
    }
    assert.equal(listSources(db, caseId).some((x: SourceRow) => /Уточнення/.test(x.title)), false);

    const ok = await s.call('POST', `/api/cases/${caseId}/questions/answer`,
      { base_version_id: versionId, question_id: 'Q1', answer: ANSWER, origin: 'synthetic' });
    assert.equal(ok.status, 201);
    assert.equal(srcOf(db, caseId, /Уточнення до Q1/).origin, 'synthetic');
  } finally { await s.close(); }
});

test('3. HTTP: додавання джерела теж вимагає явного походження', async () => {
  const db = freshDb();
  const { caseId } = scenarioCaseWithQuestion(db);
  const s = await startTestServer(db);
  try {
    const r = await s.call('POST', `/api/cases/${caseId}/sources`, { kind: 'transcript', title: 'Т', content: 'Текст' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
  } finally { await s.close(); }
});

test('3. HTTP: показ не змінює нічого, виправлення вимагає підтвердження саме цього набору', async () => {
  const db = freshDb();
  const { caseId, realSrcId } = caseWithMislabelled(db);
  const s = await startTestServer(db);
  try {
    const p = await s.call('POST', `/api/cases/${caseId}/sources/origin/preview`, { question_ids: ['Q1', 'Q2'] });
    assert.equal(p.status, 200);
    assert.equal(p.body.sources.length, 2);
    assert.equal(listSources(db, caseId).filter((x: SourceRow) => x.origin === 'real').length, 4, 'показ нічого не змінює');

    const bad = await s.call('POST', `/api/cases/${caseId}/sources/origin/correct`,
      { question_ids: ['Q1', 'Q2'], confirm_token: 'ЧУЖЕ', reason: 'спроба' });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, 'CONFIRM_REQUIRED');

    const ok = await s.call('POST', `/api/cases/${caseId}/sources/origin/correct`,
      { question_ids: ['Q1', 'Q2'], confirm_token: p.body.confirm_token, reason: 'синтетичні уточнення сценарію' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.corrected.length, 2);

    const card = (await s.call('GET', `/api/cases/${caseId}`)).body as { sources: { id: string; origin: string; origin_corrected: boolean }[] };
    const corrected = card.sources.filter((x) => x.origin_corrected);
    assert.equal(corrected.length, 2, 'у картці видно, що походження виправлено');
    assert.ok(corrected.every((x) => x.origin === 'synthetic'));
    assert.equal(card.sources.find((x) => x.id === realSrcId)!.origin, 'real', 'справжнє джерело не чіпали');
  } finally { await s.close(); }
});
