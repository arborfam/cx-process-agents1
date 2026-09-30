/**
 * Початковий крок, досяжність і вихід до завершення (D27, технічний план §5б).
 * Порушення блокують передачу на погодження, погодження і серверний дозвіл BPMN;
 * пояснення називає конкретні кроки й причину; цикли з виходом дозволені.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, all, one } from '../src/db.ts';
import {
  acceptDraft, addSource, approve, bpmnGuard, buildCard, createCase, currentApproval, flowIssues, getCase, headVersion,
  insertVersion, requestBpmnStart, saveAnalystVersion, submissionBlockers, submitForApproval, verifyVersionIntegrity, versionContent,
  type EditFields,
} from '../src/domain.ts';
import { runAnalyst, ScriptedDemoClient } from '../src/runs.ts';
import { seedDemoCase } from '../src/demo.ts';
import { freshDb, human, startTestServer } from './helpers.ts';

const BASE: EditFields = {
  summary: 'Синтетичний процес', business_context: 'Контекст (синтетичний)',
  boundaries: { trigger: 'Тригер', input: 'Вхід', completion: 'Завершення', result: 'Результат' },
  roles_text: 'Роль', problems_text: 'P1 | Довго | Клієнти чекають (метрик немає)',
};
const step = (id: string, action: string, next: string) => `${id} | Роль | ${action} | результат ${id} | ${next}`;

/** Кейс із заданими кроками; версія прийнята аналітиком, але ще не передана на погодження. */
function build(steps: string[], entry: string | null | undefined) {
  const db = freshDb();
  const c = createCase(db, human, 'Тест потоку', 'demo');
  addSource(db, human, c.id, { kind: 'request', title: 'Запит', content: 'Синтетичний запит', origin: 'synthetic' });
  const fields: EditFields = { ...BASE, steps_text: steps.join('\n') };
  if (entry !== undefined) fields.entry_step_id = entry;
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields, coverAllSources: true });
  acceptDraft(db, human, c.id, v.id);
  return { db, c, v };
}

/** Обхід прикладного шару: примусово ставить стан і запис погодження, щоб перевірити захист у глибину. */
function force(db: ReturnType<typeof freshDb>, caseId: string, versionId: string, state: 'pending_approval' | 'approved') {
  const v = one<{ content_hash: string }>(db, 'SELECT content_hash FROM as_is_version WHERE id = ?', versionId)!;
  run(db, 'UPDATE "case" SET state = ? WHERE id = ?', state, caseId);
  if (state === 'approved') {
    run(db, 'INSERT INTO approval (id, case_id, version_id, content_hash, approver, note, created_at) VALUES (?,?,?,?,?,?,?)',
      'appr_forced_' + Math.random().toString(36).slice(2, 8), caseId, versionId, v.content_hash, 'test', '', new Date().toISOString());
  }
}

/** Перевіряє, що порушення блокує ВСІ три точки: передачу, погодження, дозвіл BPMN. */
function assertBlockedEverywhere(steps: string[], entry: string | null, code: string, mustMention: RegExp[]) {
  const { db, c, v } = build(steps, entry);
  const issues = submissionBlockers(db, c.id).filter((b) => b.code === code);
  assert.equal(issues.length, 1, `очікувано блокер ${code}: ` + submissionBlockers(db, c.id).map((b) => b.code).join());
  assert.equal(issues[0]!.severity, 'critical');
  for (const re of mustMention) assert.match(issues[0]!.message, re, issues[0]!.message);

  // 1) передача на погодження
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED' && e.details.blockers.some((b: any) => b.code === code));
  assert.equal(getCase(db, c.id).state, 'research');
  // 2) саме погодження (обхід: кейс примусово «На погодженні»)
  force(db, c.id, v.id, 'pending_approval');
  assert.throws(() => approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true }), (e: any) => e.code === 'GUARD_FAILED' && e.details.blockers.some((b: any) => b.code === code));
  assert.equal(currentApproval(db, c.id), undefined, 'погодження не записано');
  // 3) серверний дозвіл BPMN (обхід: погодження записано напряму)
  force(db, c.id, v.id, 'approved');
  const g = bpmnGuard(db, c.id);
  assert.equal(g.ok, false);
  const reason = g.reasons.find((r) => r.code === code);
  assert.ok(reason, 'у причинах відмови: ' + g.reasons.map((r) => r.code).join());
  for (const re of mustMention) assert.match(reason!.message, re);
  assert.throws(() => requestBpmnStart(db, human, c.id, 'demo'), (e: any) => e.code === 'GUARD_FAILED');
  assert.equal(all(db, `SELECT id FROM run WHERE agent = 'bpmn'`).length, 0, 'запуск BPMN не створено');
  return { db, c, v };
}

// ───────── два негативні приклади з незалежної перевірки ─────────

test('Негативний А: S1 → S2 → END, а окремий S3 → END недосяжний від початку — блокує передачу, погодження і BPMN', () => {
  assertBlockedEverywhere(
    [step('S1', 'Крок один', 'S2'), step('S2', 'Крок два', 'END'), step('S3', 'Крок три (окремий)', 'END')],
    'S1', 'STEP_UNREACHABLE', [/S3/, /недосяжн/i, /S1/],
  );
});

test('Негативний Б: S1 → S2 → S1 — замкнений цикл без шляху до завершення — блокує передачу, погодження і BPMN', () => {
  assertBlockedEverywhere(
    [step('S1', 'Крок один', 'S2'), step('S2', 'Крок два', 'S1')],
    'S1', 'STEP_NO_EXIT', [/S1 → S2 → S1/, /цикл/i, /завершенн/i],
  );
});

test('Позитивний: цикл З виходом дозволений (S1 → S2 ↔ S1, S2 → S3 → END) і проходить усі три точки', () => {
  const { db, c, v } = build(
    [step('S1', 'Прийняти заявку', 'S2'), step('S2', 'Перевірити повноту', 'S3 (заявка повна); S1 (неповна — повернути на доповнення)'), step('S3', 'Обробити', 'END')],
    'S1');
  assert.deepEqual(submissionBlockers(db, c.id).filter((b) => b.severity === 'critical' && b.code !== 'NOT_ACCEPTED').map((b) => b.code), []);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, c.id).ok, true);
  requestBpmnStart(db, human, c.id, 'demo');
});

test('Кілька кроків у групі: пояснення називає всі проблемні кроки та їхній зміст', () => {
  const { db, c } = build(
    [step('S1', 'Початок', 'END'), step('S2', 'Осиротілий А', 'S3'), step('S3', 'Осиротілий Б', 'END')],
    'S1');
  const m = submissionBlockers(db, c.id).find((b) => b.code === 'STEP_UNREACHABLE')!.message;
  assert.match(m, /S2 \(«Осиротілий А»\)/);
  assert.match(m, /S3 \(«Осиротілий Б»\)/);
  assert.match(m, /S1 \(«Початок»\)/, 'названо й початковий крок');
});

test('Цикл між двома кроками, з якого можна вийти лише через третій, дозволений; довгий цикл без виходу — ні', () => {
  const ok = flowIssues(versionContent(build(
    [step('S1', 'а', 'S2'), step('S2', 'б', 'S3'), step('S3', 'в', 'S1 (ще раз); END (готово)')], 'S1').v));
  assert.deepEqual(ok, []);
  const bad = flowIssues(versionContent(build(
    [step('S1', 'а', 'S2'), step('S2', 'б', 'S3'), step('S3', 'в', 'S1')], 'S1').v));
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /S1 → S2 → S3 → S1/);
});

// ───────── початковий крок: явний, а не за порядком ─────────

test('Початковий крок не виводиться з порядку рядків: без поля — блокер, «перший рядок» не підставляється', () => {
  const { db, c } = build([step('S1', 'а', 'S2'), step('S2', 'б', 'END')], undefined);
  const b = submissionBlockers(db, c.id).find((x) => x.code === 'ENTRY_MISSING');
  assert.ok(b, 'блокер ENTRY_MISSING');
  assert.equal(b!.severity, 'critical');
  assert.equal(versionContent(headVersion(db, c.id)).entry_step_id, undefined, 'систему не вибрала початок сама');
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.details.blockers.some((x: any) => x.code === 'ENTRY_MISSING'));
});

test('Порядок кроків у списку нічого не означає: вказаний початок S2 робить S1 недосяжним, а зворотний порядок рядків проблем не створює', () => {
  // S1 перший у списку, але початок — S2: якби порядок мав значення, S1 був би початком і проблем не було б
  const a = build([step('S1', 'а', 'S2'), step('S2', 'б', 'END')], 'S2');
  assert.ok(submissionBlockers(a.db, a.c.id).some((x) => x.code === 'STEP_UNREACHABLE' && /S1/.test(x.message)));
  // ті самі кроки в зворотному порядку рядків, початок S1 — усе гаразд
  const b = build([step('S2', 'б', 'END'), step('S1', 'а', 'S2')], 'S1');
  assert.deepEqual(flowIssues(versionContent(b.v)), []);
});

test('Початковий крок має існувати: хибне посилання відхиляється при збереженні; видалення кроку дає ENTRY_BAD_REF', () => {
  const { db, c, v } = build([step('S1', 'а', 'S2'), step('S2', 'б', 'END')], 'S1');
  assert.throws(() => saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { entry_step_id: 'S9' } }),
    (e: any) => e.code === 'VALIDATION' && /S9/.test(e.message));
  // крок S1 видаляють, а поле лишається
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { steps_text: step('S2', 'б', 'END') } });
  const b = submissionBlockers(db, c.id).find((x) => x.code === 'ENTRY_BAD_REF')!;
  assert.ok(b);
  assert.match(b.message, /S1/);
  assert.equal(headVersion(db, c.id).id, v3.id);
});

test('Зміна початкового кроку — нова версія, скасовує погодження, видна в оглядi змін; порожнє значення знімає поле', () => {
  const { db, c, v } = build([step('S1', 'Перший', 'S2'), step('S2', 'Другий', 'END')], 'S1');
  submitForApproval(db, human, c.id);
  const ap = approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { entry_step_id: 'S2' } });
  assert.notEqual(v3.id, v.id);
  assert.equal(getCase(db, c.id).state, 'research');
  assert.equal(currentApproval(db, c.id), undefined);
  assert.ok(one(db, 'SELECT 1 AS x FROM approval WHERE id = ?', ap.id), 'запис про погодження лишився в історії');
  const change = buildCard(db, c.id, 'demo').changes.find((x) => x.label === 'Початок');
  assert.ok(change, 'у змінах є «Початок»');
  assert.match(change!.text, /було S1 \(«Перший»\), стало S2 \(«Другий»\)/);
  const v4 = saveAnalystVersion(db, human, c.id, { baseVersionId: v3.id, fields: { entry_step_id: '' } });
  assert.equal(versionContent(v4).entry_step_id, null);
  assert.ok(submissionBlockers(db, c.id).some((x) => x.code === 'ENTRY_MISSING'));
});

test('Агент не може змінити початковий крок, який задала аналітикиня: зберігається її вибір, конфлікт показано', async () => {
  const { db, c, v } = build([step('S1', 'а', 'S2'), step('S2', 'б', 'END')], 'S1');
  const out = structuredClone(versionContent(v));
  out.entry_step_id = 'S2';
  const r = await runAnalyst(db, c.id, new ScriptedDemoClient(() => out));
  assert.ok(r.ok);
  const content = versionContent(headVersion(db, c.id));
  assert.equal(content.entry_step_id, 'S1');
  assert.ok(content.conflicts.some((x) => x.key === 'entry_step_id' && x.proposed === 'S2'));
});

// ───────── старі записи без поля: явне уточнення, без мовчазного вибору ─────────

test('Старий погоджений пакет без початкового кроку: BPMN заблоковано, пакет не переписується, уточнення створює нову версію й потребує нового погодження', () => {
  const { db, c, v } = build([step('S1', 'Перший', 'S2'), step('S2', 'Другий', 'END')], 'S1');
  // імітація «старого» запису: версія зберігалась до появи поля
  const legacyContent = structuredClone(versionContent(v));
  delete legacyContent.entry_step_id;
  const legacy = insertVersion(db, { caseId: c.id, content: legacyContent, createdBy: 'analyst', actorName: 'Аналітикиня', parentId: v.id,
    covered: JSON.parse(v.covered_json), owned: [], note: 'імітація старого запису' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', legacy.id, c.id);
  acceptDraft(db, human, c.id, legacy.id);
  force(db, c.id, legacy.id, 'approved');
  const before = JSON.stringify(one(db, 'SELECT content_json, content_hash FROM as_is_version WHERE id = ?', legacy.id));

  // 1) блокування пояснює причину і не підставляє початок
  const g = bpmnGuard(db, c.id);
  assert.equal(g.ok, false);
  const r = g.reasons.find((x) => x.code === 'ENTRY_MISSING')!;
  assert.match(r.message, /створено до появи цього поля/);
  assert.match(r.message, /не вибирає його за порядком рядків/);
  const card = buildCard(db, c.id, 'demo');
  assert.equal(card.entry.legacy, true);
  assert.equal(card.entry.defined, false);
  assert.equal(card.next_action.key, 'clarify_entry');
  assert.ok(card.gaps.some((x) => x.code === 'ENTRY_MISSING'));

  // 2) інша правка без вибору початку його не встановлює
  const other = saveAnalystVersion(db, human, c.id, { baseVersionId: legacy.id, fields: { summary: 'Інша правка' } });
  assert.equal(versionContent(other).entry_step_id, undefined, 'початок не з’явився мовчки');
  assert.ok(submissionBlockers(db, c.id).some((x) => x.code === 'ENTRY_MISSING'));

  // 3) явне уточнення: нова версія з вибраним початком
  const fixed = saveAnalystVersion(db, human, c.id, { baseVersionId: other.id, fields: { entry_step_id: 'S1' } });
  assert.equal(versionContent(fixed).entry_step_id, 'S1');
  assert.equal(getCase(db, c.id).state, 'research');

  // 4) старий пакет лишився незмінним; його погодження — в історії, скасоване (не видалене)
  assert.equal(JSON.stringify(one(db, 'SELECT content_json, content_hash FROM as_is_version WHERE id = ?', legacy.id)), before);
  assert.ok(verifyVersionIntegrity(db, legacy.id));
  const rev = all<{ reason: string }>(db, 'SELECT reason FROM approval_revocation');
  assert.equal(rev.length, 1);
  assert.equal(rev[0]!.reason, 'content_changed');

  // 5) нова версія проходить обидва рівні лише після нового погодження
  assert.equal(bpmnGuard(db, c.id).ok, false, 'до нового погодження BPMN недозволений');
  acceptDraft(db, human, c.id, fixed.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: fixed.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, c.id).ok, true);
});

test('Демо-кейс із початковим кроком S1: усе працює, початок видно в змісті', () => {
  const db = freshDb();
  const id = seedDemoCase(db, 'demo');
  const card = buildCard(db, id, 'demo');
  assert.equal(card.entry.id, 'S1');
  assert.equal(card.entry.defined, true);
  assert.ok(!card.gaps.some((g) => ['ENTRY_MISSING', 'STEP_UNREACHABLE', 'STEP_NO_EXIT'].includes(g.code)));
});

// ───────── HTTP: прямі запити теж відхиляються ─────────

test('HTTP: прямий запит на BPMN для обох негативних прикладів → 409 із назвами кроків; поле початкового кроку приймається лише як текст', async () => {
  const a = build([step('S1', 'Крок один', 'S2'), step('S2', 'Крок два', 'END'), step('S3', 'Крок три', 'END')], 'S1');
  force(a.db, a.c.id, a.v.id, 'approved');
  const srv = await startTestServer(a.db);
  try {
    const r = await srv.call('POST', `/api/cases/${a.c.id}/bpmn/start`, { entry_step_id: 'S3', approved: true });
    assert.equal(r.status, 409);
    const reason = r.body.error.details.reasons.find((x: any) => x.code === 'STEP_UNREACHABLE');
    assert.ok(reason);
    assert.match(reason.message, /S3/);
    // тіло запиту не може підмінити початок
    const bad = await srv.call('POST', `/api/cases/${a.c.id}/versions`, { base_version_id: headVersion(a.db, a.c.id).id, fields: { entry_step_id: 42 } });
    assert.equal(bad.status, 400);
    const noStep = await srv.call('POST', `/api/cases/${a.c.id}/versions`, { base_version_id: headVersion(a.db, a.c.id).id, fields: { entry_step_id: 'S77' } });
    assert.equal(noStep.status, 400);
  } finally {
    await srv.close();
  }
  const b = build([step('S1', 'Крок один', 'S2'), step('S2', 'Крок два', 'S1')], 'S1');
  force(b.db, b.c.id, b.v.id, 'approved');
  const srv2 = await startTestServer(b.db);
  try {
    const r = await srv2.call('POST', `/api/cases/${b.c.id}/bpmn/start`, {});
    assert.equal(r.status, 409);
    assert.ok(r.body.error.details.reasons.some((x: any) => x.code === 'STEP_NO_EXIT' && /S1 → S2 → S1/.test(x.message)));
  } finally {
    await srv2.close();
  }
});
