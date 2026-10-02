/**
 * Підкрок 3b-3 (D31): рішення аналітикині щодо зауважень агента 2.
 * Відхилення з обов'язковим поясненням, незмінний запис, прив'язка до запису перевірки, неможливість обійти
 * програмні перевірки й `UNSUPPORTED_CANDIDATE`, продовження без нового виклику моделі, перезапуск процесу.
 * Усе — на ПІДСТАВНОМУ клієнті: якість AI цим не перевіряється.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { all, one, openDb, type DB } from '../src/db.ts';
import { canonical } from '../src/hash.ts';
import { findingKey } from '../src/ai/bpmn-review.ts';
import {
  acceptDraft, approve, currentApproval, getCase, headVersion, returnToResearch, saveAnalystVersion, submitForApproval, versionContent,
} from '../src/domain.ts';
import { getCaseReview, listResolutions, rejectFinding, runBpmnReviewForCase, MIN_EXPLANATION_CHARS } from '../src/review-runs.ts';
import { buildArtifact, buildPreflight } from '../src/bpmn-artifacts.ts';
import { agent, approvedCase, freshDb, human, tempDbPath } from './helpers.ts';
import { FakeReviewClient, finding, okStep, policyOf, reviewer, type Step } from './review-helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const CHILD = join(ROOT, 'tests', 'review-restart-child.ts');
const EXPL = 'Опис однозначний: інших випадків у цьому процесі немає (синтетичне пояснення тесту).';
const snapshot = (db: DB, caseId: string) => JSON.stringify([getCase(db, caseId).state, currentApproval(db, caseId), all(db, 'SELECT id, content_hash FROM as_is_version WHERE case_id = ?', caseId)]);

/** Погоджений кейс + перевірка, що повернула одну блокувальну знахідку. */
async function awaiting(db: DB = freshDb(), steps: Step[] = [okStep([finding()])]) {
  const { c } = approvedCase(db);
  const client = new FakeReviewClient(steps);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok, JSON.stringify(r));
  return { db, caseId: c.id, client, reviewId: (r as { reviewId: string }).reviewId };
}

// ───────── Стан «чекає рішення» ─────────

test('Блокувальна знахідка зупиняє запуск до рішення: шлюз закритий, побудова недоступна, опис не змінено', async () => {
  const { db, caseId } = await awaiting();
  const before = snapshot(db, caseId);
  const r = getCaseReview(db, caseId);
  assert.equal(r.state, 'awaiting_analyst');
  assert.ok(r.gate && !r.gate.ok && r.gate.code === 'BLOCKING_FINDINGS', JSON.stringify(r.gate));
  const pre = buildPreflight(db, caseId);
  assert.ok(!pre.ok && pre.code === 'BLOCKING_FINDINGS');
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
  assert.equal(snapshot(db, caseId), before);
});

test('Картка знахідки показує цитату, кроки, питання й пояснення впливу; варіанти агента в опис не підставляються', async () => {
  const { db, caseId } = await awaiting(freshDb(), [okStep([finding({ options: ['варіант А', 'варіант Б'] })])]);
  const r = getCaseReview(db, caseId);
  const v = r.findingsView![0]!;
  assert.equal(v.blocking, true);
  assert.equal(v.can_reject, true);
  assert.ok(v.finding.quote.length > 0 && v.finding.question.length > 0 && v.finding.step_ids.length > 0);
  // Варіанти лишаються текстом для людини: у змісті версії їх немає.
  const content = JSON.stringify(versionContent(headVersion(db, caseId)));
  for (const o of v.finding.options ?? []) assert.ok(!content.includes(o), `варіант «${o}» потрапив у опис AS-IS`);
});

// ───────── Обов'язкове пояснення, лише людина, незмінність ─────────

test('Відхилення без пояснення (і з надто коротким) не записується', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  for (const bad of ['', '   ', 'коротко']) {
    assert.throws(() => rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: bad }),
      (e: any) => e.code === 'EXPLANATION_REQUIRED', `пояснення «${bad}» мало бути відхилене`);
  }
  assert.equal(listResolutions(db, caseId).length, 0);
  assert.ok(String(MIN_EXPLANATION_CHARS).length > 0);
});

test('Відхиляти може лише людина: агент — ні', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  assert.throws(() => rejectFinding(db, agent, caseId, { reviewId, findingKey: key, explanation: EXPL }),
    (e: any) => e.code === 'FORBIDDEN_ACTOR' || e.status === 403);
  assert.equal(listResolutions(db, caseId).length, 0);
});

test('Рішення — незмінний запис із прив’язкою до знахідки, перевірки, запуску, погодження, версії й хеша', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const view = getCaseReview(db, caseId).findingsView![0]!;
  const res = rejectFinding(db, human, caseId, { reviewId, findingKey: view.key, explanation: EXPL });
  const row = one<Record<string, any>>(db, 'SELECT * FROM finding_resolution WHERE id = ?', res.id)!;
  const rev = one<Record<string, any>>(db, 'SELECT * FROM bpmn_review WHERE id = ?', reviewId)!;
  assert.deepEqual([row.case_id, row.review_id, row.run_id, row.approval_id, row.version_id, row.content_hash, row.decision],
    [caseId, reviewId, rev.run_id, rev.approval_id, rev.version_id, rev.content_hash, 'rejected']);
  assert.equal(row.finding_key, findingKey(view.finding));
  assert.equal(canonical(JSON.parse(row.finding_json)), canonical(view.finding), 'копія знахідки зберігається');
  assert.equal(row.explanation, EXPL);
  assert.equal(row.decided_by, human.name);
  assert.throws(() => db.exec(`UPDATE finding_resolution SET explanation = 'інше' WHERE id = '${res.id}'`), /незмінна/);
  assert.throws(() => db.exec(`DELETE FROM finding_resolution WHERE id = '${res.id}'`), /незмінна/);
});

test('Повторне рішення щодо тієї самої знахідки не приймається', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL });
  assert.throws(() => rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL + ' ще раз' }),
    (e: any) => e.code === 'ALREADY_DECIDED');
  assert.equal(listResolutions(db, caseId).length, 1);
});

test('Вигаданий ключ знахідки й чужий ID перевірки відхиляються', async () => {
  const { db, caseId, reviewId } = await awaiting();
  assert.throws(() => rejectFinding(db, human, caseId, { reviewId, findingKey: 'a'.repeat(64), explanation: EXPL }), (e: any) => e.code === 'NOT_FOUND');
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  assert.throws(() => rejectFinding(db, human, caseId, { reviewId: 'rev_000000000000', findingKey: key, explanation: EXPL }), (e: any) => e.code === 'REVIEW_MISMATCH');
  assert.equal(listResolutions(db, caseId).length, 0);
});

// ───────── Продовження без нового виклику моделі ─────────

test('Після мотивованого відхилення побудова проходить — без нового виклику моделі', async () => {
  const { db, caseId, client, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL });

  const after = getCaseReview(db, caseId);
  assert.ok(after.gate?.ok, JSON.stringify(after.gate));
  assert.equal(after.findingsView![0]!.resolution?.explanation, EXPL, 'рішення видно поруч зі знахідкою');

  const out = await buildArtifact(db, human, caseId);
  assert.equal(out.artifact.status, 'ok');
  assert.equal(client.calls, 1, 'модель після рішення не викликалась');
});

test('Кілька блокувальних знахідок: доки вирішено не всі, шлюз закритий', async () => {
  const { db, caseId, reviewId } = await awaiting(freshDb(), [okStep([
    finding({ question: 'Перше питання?' }),
    finding({ question: 'Друге питання?', step_ids: ['S1'], quote: 'Приймає запит' }),
  ])]);
  const views = getCaseReview(db, caseId).findingsView!;
  assert.equal(views.filter((v) => v.blocking).length, 2);
  rejectFinding(db, human, caseId, { reviewId, findingKey: views[0]!.key, explanation: EXPL });
  const mid = getCaseReview(db, caseId);
  assert.ok(!mid.gate!.ok && mid.gate!.code === 'BLOCKING_FINDINGS', 'одного рішення не досить');
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
  rejectFinding(db, human, caseId, { reviewId, findingKey: views[1]!.key, explanation: EXPL });
  assert.ok(getCaseReview(db, caseId).gate!.ok);
});

test('Зауваження без блокування рішення не потребує й шлюз не закриває', async () => {
  const { db, caseId } = await awaiting(freshDb(), [okStep([finding({ class: 'informational' })])]);
  const r = getCaseReview(db, caseId);
  assert.equal(r.state, 'clear');
  assert.ok(r.gate!.ok);
  const v = r.findingsView![0]!;
  assert.equal(v.blocking, false);
  assert.equal(v.can_reject, false);
  assert.match(v.reject_blocked_reason!, /не блокує/);
});

// ───────── UNSUPPORTED_CANDIDATE відхилити не можна ─────────

// Вимога змінилась за явним рішенням власниці (D84, варіант 1): раніше кандидата відхилити було не можна
// взагалі (D21/D31), тепер — можна мотивованим рішенням людини. Тест переписано під погоджену поведінку;
// захист від ПІДРОБКИ запису збережено повністю.
test('Припущення агента: без рішення блокує, підроблений запис не відкриває, мотивоване рішення відкриває (D84)', async () => {
  const { db, caseId, reviewId } = await awaiting(freshDb(), [okStep([finding({ code: 'UNSUPPORTED_CANDIDATE' })])]);
  const view = getCaseReview(db, caseId).findingsView![0]!;
  assert.equal(view.can_reject, true, 'дія доступна людині');
  assert.ok(!getCaseReview(db, caseId).gate!.ok, 'без рішення побудова закрита');

  // Пряма підробка запису рішення (обхід дії людини) шлюз не відкриває: запис перевіряється перед використанням.
  const rev = one<Record<string, any>>(db, 'SELECT * FROM bpmn_review WHERE id = ?', reviewId)!;
  db.exec(`INSERT INTO finding_resolution (id, case_id, review_id, run_id, approval_id, version_id, content_hash, finding_key,
      finding_json, decision, explanation, decided_by, decided_at, record_hash)
    VALUES ('fres_forged', '${caseId}', '${reviewId}', '${rev.run_id}', '${rev.approval_id}', '${rev.version_id}', '${rev.content_hash}',
      '${view.key}', '{}', 'rejected', 'підробка', 'хтось', '2026-01-01T00:00:00.000Z', 'xx')`);
  const after = getCaseReview(db, caseId);
  assert.ok(!after.gate!.ok && after.gate!.code === 'UNSUPPORTED_CANDIDATE', JSON.stringify(after.gate));
  assert.equal(after.invalidResolutions!.length, 1, 'запису не довіряємо, причину названо');
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'UNSUPPORTED_CANDIDATE');

  // Слот зайнятий пошкодженим записом — чесна відмова, а не мовчазний перезапис (записи незмінні).
  assert.throws(() => rejectFinding(db, human, caseId, { reviewId, findingKey: view.key, explanation: EXPL }),
    (e: any) => e.code === 'RESOLUTION_DAMAGED');
});

test('Мотивоване рішення щодо припущення агента знімає саме це блокування (D84)', async () => {
  const { db, caseId, reviewId } = await awaiting(freshDb(), [okStep([finding({ code: 'UNSUPPORTED_CANDIDATE' })])]);
  const view = getCaseReview(db, caseId).findingsView![0]!;
  assert.throws(() => rejectFinding(db, human, caseId, { reviewId, findingKey: view.key, explanation: ' ' }), (e: any) => e.code === 'EXPLANATION_REQUIRED');
  const res = rejectFinding(db, human, caseId, { reviewId, findingKey: view.key, explanation: EXPL });
  assert.equal(res.decision, 'rejected');
  assert.equal(res.decided_by, human.name);
  const r = getCaseReview(db, caseId);
  assert.ok(r.gate!.ok, JSON.stringify(r.gate));
  assert.equal(r.findingsView![0]!.resolution!.explanation, EXPL);
  // Рішення не редагує AS-IS.
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM as_is_version WHERE case_id = ?', caseId)!.n,
    one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM as_is_version WHERE case_id = ?', caseId)!.n);
});

// ───────── Рішення не обходить програмних перевірок ─────────

test('Після відхилення програмні перевірки діють: нова версія робить перевірку застарілою, схема не будується', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL });
  assert.ok(getCaseReview(db, caseId).gate!.ok);

  returnToResearch(db, human, caseId, 'уточнення (тест)');
  const v = saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { summary: 'Уточнено (синтетично).' } });
  acceptDraft(db, human, caseId, v.id);
  submitForApproval(db, human, caseId);
  approve(db, human, caseId, { versionId: v.id, checklistConfirmed: true });

  const r = getCaseReview(db, caseId);
  assert.equal(r.state, 'stale');
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'REVIEW_STALE');
  assert.equal(all(db, 'SELECT id FROM bpmn_artifact WHERE case_id = ?', caseId).length, 0);
});

test('Підміна хеша версії після відхилення: перевірка перестає бути довіреною, схема не будується', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL });
  db.exec('DROP TRIGGER as_is_version_no_update');
  db.exec(`UPDATE as_is_version SET content_hash = 'підмінено' WHERE id = '${currentApproval(db, caseId)!.version_id}'`);
  const r = getCaseReview(db, caseId);
  assert.ok(['untrusted', 'stale'].includes(r.state), r.state);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => ['REVIEW_UNTRUSTED', 'REVIEW_STALE', 'GUARD_FAILED'].includes(e.code));
});

test('Новий запуск перевірки на тому самому пакеті потребує нових рішень; попередні лишаються контекстом (D31)', async () => {
  const { db, caseId, reviewId } = await awaiting();
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL });
  assert.ok(getCaseReview(db, caseId).gate!.ok);

  // Другий запуск тієї ж перевірки (та сама знахідка) — новий запис перевірки.
  const client2 = new FakeReviewClient([okStep([finding()])]);
  const r2 = await runBpmnReviewForCase(db, human, caseId, reviewer(client2, policyOf()));
  assert.ok(r2.ok);
  const now = getCaseReview(db, caseId);
  assert.notEqual(now.reviewId, reviewId);
  assert.ok(!now.gate!.ok && now.gate!.code === 'BLOCKING_FINDINGS', 'старе рішення на новий запис не переноситься');
  assert.equal((now.resolutions ?? []).length, 0);
  assert.equal((now.earlierResolutions ?? []).length, 1, 'попереднє рішення показується як контекст');
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
});

// ───────── Перезапуск застосунку між перевіркою й рішенням ─────────

test('Перезапуск між перевіркою й рішенням: інший процес ОС відновлює перевірку з бази, приймає рішення й будує схему без виклику моделі', async () => {
  const dbPath = tempDbPath();
  const db = openDb(dbPath);
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([finding()])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok);
  assert.equal(getCaseReview(db, c.id).state, 'awaiting_analyst');
  db.close();

  // Окремий процес: клієнта моделі немає, мережа заблокована (будь-який fetch зафіксується).
  const out = spawnSync(process.execPath, ['--import', 'tsx', CHILD, 'decide-and-build', dbPath, c.id, EXPL],
    { encoding: 'utf8', cwd: ROOT, timeout: 90_000 });
  assert.equal(out.status, 0, out.stderr.slice(0, 1500));
  const res = JSON.parse(out.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)!);
  assert.equal(res.fetchCalls, 0, 'мережу не торкались');
  assert.equal(res.stateBefore, 'awaiting_analyst');
  assert.equal(res.rejected, 1);
  assert.equal(res.gateOkAfter, true);
  assert.equal(res.artifactStatus, 'ok');
  assert.equal(res.downloadsBpmn, true);

  const db2 = openDb(dbPath);
  assert.equal(all(db2, 'SELECT id FROM finding_resolution WHERE case_id = ?', c.id).length, 1);
  assert.equal(all(db2, 'SELECT id FROM bpmn_artifact WHERE case_id = ?', c.id).length, 1);
  // Жодного нового запуску агента 2 після перезапуску.
  assert.equal(all(db2, `SELECT id FROM run WHERE case_id = ? AND agent = 'bpmn' AND technical_state <> 'not_implemented'`, c.id).length, 1);
  db2.close();
});
