/**
 * Підкроки 3b-4, 3b-6, 3b-7: побудова схеми після смислової перевірки, збереження артефакту, актуальність і збої.
 * Усе — на ПІДСТАВНОМУ клієнті агента 2 (`tests/review-helpers.ts`): справжніх викликів моделі й мережі немає,
 * тож ці тести доводять логіку програми, а не якість AI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, type DB } from '../src/db.ts';
import { sha256 } from '../src/hash.ts';
import {
  acceptDraft, addNotationRequirement, addSource, approve, currentApproval, decideNotationRequirement, getCase, headVersion,
  returnToResearch, saveAnalystVersion, submitForApproval, versionContent,
} from '../src/domain.ts';
import { getCaseReview, runBpmnReviewForCase } from '../src/review-runs.ts';
import { buildArtifact, buildPreflight, getCaseArtifact, listCaseArtifacts, readArtifactFile, artifactHash } from '../src/bpmn-artifacts.ts';
import { agent, approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, failStep, finding, okStep, policyOf, reviewer, type Step } from './review-helpers.ts';

const artRow = (db: DB, id: string) => one<Record<string, any>>(db, 'SELECT * FROM bpmn_artifact WHERE id = ?', id)!;
const artCount = (db: DB, caseId: string) => all(db, 'SELECT id FROM bpmn_artifact WHERE case_id = ?', caseId).length;
const snapshot = (db: DB, caseId: string) => JSON.stringify([getCase(db, caseId).state, currentApproval(db, caseId), all(db, 'SELECT id, content_hash FROM as_is_version WHERE case_id = ?', caseId)]);

async function reviewed(db: DB, caseId: string, steps: Step[] = [okStep([])]) {
  const client = new FakeReviewClient(steps);
  const r = await runBpmnReviewForCase(db, human, caseId, reviewer(client, policyOf()));
  return { client, r };
}

/** Погоджений кейс + завершена перевірка без блокерів. */
async function readyToBuild(db: DB = freshDb()) {
  const { c, a } = approvedCase(db);
  const { client } = await reviewed(db, c.id);
  return { db, caseId: c.id, approval: a, client };
}

// ───────── A. Повний шлях: перевірка → побудова → файли ─────────

test('A. Після перевірки без блокерів схема будується: артефакт прив’язаний до версії, хеша, погодження, запуску й запису перевірки', async () => {
  const db = freshDb();
  const { caseId, approval, client } = await readyToBuild(db);
  const review = getCaseReview(db, caseId);
  const before = snapshot(db, caseId);

  const out = await buildArtifact(db, human, caseId);
  assert.equal(out.reused, false);
  assert.equal(out.artifact.status, 'ok');
  assert.equal(client.calls, 1, 'побудова не звертається до моделі');

  const row = artRow(db, out.artifact.row.id);
  assert.deepEqual([row.case_id, row.version_id, row.approval_id, row.review_id, row.run_id],
    [caseId, approval.version_id, approval.id, review.reviewId, review.runId]);
  assert.equal(row.content_hash, approval.content_hash);
  assert.equal(row.process_name, versionContent(headVersion(db, caseId)).process_name);
  assert.equal(row.bpmn_sha256, sha256(row.bpmn_xml));
  assert.equal(row.drawio_sha256, sha256(row.drawio_xml));
  assert.equal(row.drawio_status, 'ok');
  assert.ok(out.artifact.map.length > 0, 'карта «крок ↔ елемент» не порожня');
  assert.equal(snapshot(db, caseId), before, 'стан кейсу, погодження й версії не змінено');
});

test('A. Карта «крок ↔ елемент» покриває всі кроки погодженого опису і вказує елементи саме цього файлу', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const out = await buildArtifact(db, human, caseId);
  const steps = versionContent(headVersion(db, caseId)).steps.map((s) => s.id).sort();
  assert.deepEqual(out.artifact.map.map((m) => m.step_id).sort(), steps);
  for (const r of out.artifact.map) assert.ok(out.artifact.row.bpmn_xml!.includes(r.bpmn_task_id), `елемента ${r.bpmn_task_id} немає у файлі`);
});

test('A. Файли віддаються лише після серверних перевірок; хеш збігається з вмістом', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  await buildArtifact(db, human, caseId);
  for (const kind of ['bpmn', 'drawio'] as const) {
    const f = readArtifactFile(db, caseId, kind);
    assert.equal(sha256(f.xml), f.sha256);
    assert.match(f.filename, kind === 'bpmn' ? /\.bpmn$/ : /\.drawio$/);
  }
  assert.match(readArtifactFile(db, caseId, 'bpmn').xml, /<\?xml|<bpmn/);
});

test('A. Запис артефакту незмінний: база відхиляє зміну й видалення', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const out = await buildArtifact(db, human, caseId);
  assert.throws(() => db.exec(`UPDATE bpmn_artifact SET status = 'blocked' WHERE id = '${out.artifact.row.id}'`), /незмінна/);
  assert.throws(() => db.exec(`DELETE FROM bpmn_artifact WHERE id = '${out.artifact.row.id}'`), /незмінна/);
});

test('A. Побудова — дія людини: агент її виконати не може', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  await assert.rejects(() => buildArtifact(db, agent, caseId), (e: any) => e.code === 'FORBIDDEN_ACTOR' || e.status === 403);
  assert.equal(artCount(db, caseId), 0);
});

// ───────── H. Повторні кліки й повторені запити ─────────

test('H. Повторний клік «Побудувати» не створює другого артефакту й не перегенеровує', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const first = await buildArtifact(db, human, caseId);
  const second = await buildArtifact(db, human, caseId);
  assert.equal(second.reused, true);
  assert.equal(second.artifact.row.id, first.artifact.row.id);
  assert.equal(artCount(db, caseId), 1);
});

test('H. Два одночасні запити побудови дають один артефакт', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const [a, b] = await Promise.all([buildArtifact(db, human, caseId), buildArtifact(db, human, caseId)]);
  assert.equal(artCount(db, caseId), 1);
  assert.equal(a.artifact.row.id, b.artifact.row.id);
  assert.ok(a.reused || b.reused, 'один із запитів має повернути наявний артефакт');
});

// ───────── E. Критична прогалина й непідтримувана нотація ─────────

test('E. Підтверджена вимога до нотації: перевірка unsupported без виклику моделі, схема не будується, погодження лишається чинним', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  // Вимогу додає людина — це нова версія, тож її треба прийняти й погодити заново.
  const v = addNotationRequirement(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, kind: 'parallel_branches', stepId: 'S1', detail: 'Дві дії справді одночасні (синтетичний приклад).' });
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  const before = snapshot(db, c.id);

  const client = new FakeReviewClient([okStep([])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok && r.outcome === 'unsupported');
  assert.equal(client.calls, 0, 'модель не викликалась');

  const pre = buildPreflight(db, c.id);
  assert.ok(!pre.ok && pre.code === 'UNSUPPORTED', JSON.stringify(pre).slice(0, 200));
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: any) => e.code === 'UNSUPPORTED');
  assert.equal(artCount(db, c.id), 0);
  assert.equal(snapshot(db, c.id), before, 'погодження й версії не змінено');
});

test('E. Структурна прогалина потоку блокує ще до смислової перевірки: схеми немає', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  // Єдиний перехід з умовою — те саме правило, що й у генераторі; з’являється як нова непогоджена версія.
  const content = versionContent(headVersion(db, c.id));
  const v = saveAnalystVersion(db, human, c.id, {
    baseVersionId: headVersion(db, c.id).id,
    fields: { steps_text: `S1 | ${content.steps[0]!.role} | ${content.steps[0]!.action} | ${content.steps[0]!.result} | S2 (лише одна умова)\nS2 | ${content.steps[1]!.role} | ${content.steps[1]!.action} | ${content.steps[1]!.result} | END` },
  });
  acceptDraft(db, human, c.id, v.id);
  const pre = buildPreflight(db, c.id);
  assert.ok(!pre.ok && pre.code === 'GUARD_FAILED');
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED');
  assert.equal(artCount(db, c.id), 0);
});

// ───────── D. Уточнення AS-IS → нова версія → нове погодження ─────────

test('D. Уточнення опису після побудови: артефакт стає застарілим, як чинний не видається, історія лишається', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const built = await buildArtifact(db, human, caseId);
  assert.ok(built.artifact.downloads.bpmn);

  // Аналітикиня повертає кейс до дослідження й уточнює опис → нова версія, погодження скасоване.
  returnToResearch(db, human, caseId, 'уточнення опису (тест)');
  const v = saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { summary: 'Уточнений опис (синтетичний).' } });
  acceptDraft(db, human, caseId, v.id);

  const cur = getCaseArtifact(db, caseId)!;
  assert.ok(cur.staleReasons.length > 0, 'артефакт має стати застарілим');
  assert.match(cur.label!, /^Застаріла — побудована за версією /);
  assert.deepEqual(cur.downloads, { bpmn: false, drawio: false });
  assert.throws(() => readArtifactFile(db, caseId, 'bpmn'), (e: any) => e.code === 'ARTIFACT_STALE');
  assert.equal(listCaseArtifacts(db, caseId).length, 1, 'історія не стирається');

  const pre = buildPreflight(db, caseId);
  assert.ok(!pre.ok, 'без нового погодження побудови немає');
  assert.match(JSON.stringify(pre), /GUARD_FAILED|NOT_APPROVED|NO_APPROVAL/);
});

test('D. Для нової погодженої версії стара перевірка не приймається: потрібна нова перевірка, а стара схема не стає чинною', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  await buildArtifact(db, human, caseId);

  returnToResearch(db, human, caseId, 'уточнення опису (тест)');
  const v = saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { summary: 'Інший опис (синтетичний).' } });
  acceptDraft(db, human, caseId, v.id);
  submitForApproval(db, human, caseId);
  approve(db, human, caseId, { versionId: v.id, checklistConfirmed: true });

  const r = getCaseReview(db, caseId);
  assert.equal(r.state, 'stale', JSON.stringify(r.reasons));
  const pre = buildPreflight(db, caseId);
  assert.ok(!pre.ok && pre.code === 'REVIEW_STALE');
  assert.throws(() => readArtifactFile(db, caseId, 'bpmn'), (e: any) => e.code === 'ARTIFACT_STALE');
  assert.equal(getCaseArtifact(db, caseId)!.downloads.bpmn, false);
});

test('D. Нове джерело після побудови робить артефакт застарілим і закриває завантаження', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const built = await buildArtifact(db, human, caseId);
  assert.ok(built.artifact.downloads.bpmn, 'до появи джерела файл був доступний');
  addSource(db, human, caseId, { kind: 'clarification', title: 'Нове уточнення (синтетичне)', content: 'Новий текст.', origin: 'synthetic' });
  const cur = getCaseArtifact(db, caseId)!;
  // Додавання джерела повертає кейс до дослідження й скасовує погодження — артефакт перестає бути чинним.
  assert.ok(cur.staleReasons.length > 0, 'артефакт має стати застарілим');
  assert.match(cur.label!, /^Застаріла — побудована за версією /);
  assert.deepEqual(cur.downloads, { bpmn: false, drawio: false });
  assert.throws(() => readArtifactFile(db, caseId, 'bpmn'), (e: any) => e.code === 'ARTIFACT_STALE');
  assert.equal(listCaseArtifacts(db, caseId).length, 1, 'історія не стирається');
});

// ───────── F. Збої моделі ─────────

test('F. Збій моделі: запуск помилковий, схема не будується, режиму «без перевірки» немає', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const before = snapshot(db, c.id);
  const { client, r } = await reviewed(db, c.id, [failStep('transient'), failStep('transient')]);
  assert.equal(r.ok, false);
  assert.equal(client.calls, 2, 'одна автоматична повторна спроба');
  const pre = buildPreflight(db, c.id);
  assert.ok(!pre.ok && pre.code === 'REVIEW_FAILED', JSON.stringify(pre).slice(0, 200));
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: any) => e.code === 'REVIEW_FAILED');
  assert.equal(artCount(db, c.id), 0);
  assert.equal(snapshot(db, c.id), before);
});

test('F. Некоректна відповідь (вигадана цитата) не відкриває генерацію', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const bad = okStep([finding({ quote: 'цього в погодженому описі немає' })]);
  const { r } = await reviewed(db, c.id, [bad, bad]);
  assert.equal(r.ok, false);
  const pre = buildPreflight(db, c.id);
  assert.ok(!pre.ok && pre.code === 'REVIEW_FAILED');
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: any) => e.code === 'REVIEW_FAILED');
  assert.equal(artCount(db, c.id), 0);
});

test('F. Перевірку виконав деморежим — шлюз закритий, схема не будується (D32)', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([])], 'demo');
  const r = await runBpmnReviewForCase(db, human, c.id, { client, instruction: (await import('../src/ai/prompt.ts')).loadBpmnInstruction() });
  assert.ok(r.ok);
  const review = getCaseReview(db, c.id);
  assert.ok(review.gate && !review.gate.ok && review.gate.code === 'REVIEW_DEMO_MODE', JSON.stringify(review.gate));
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: any) => e.code === 'REVIEW_DEMO_MODE');
  assert.equal(artCount(db, c.id), 0);
});

test('F. Смислової перевірки не було: побудова відмовляє з конкретною наступною дією', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const pre = buildPreflight(db, c.id);
  assert.ok(!pre.ok && pre.code === 'NO_REVIEW');
  assert.match(pre.message, /перевірк/i);
  await assert.rejects(() => buildArtifact(db, human, c.id), (e: any) => e.code === 'NO_REVIEW');
});

// ───────── G. Пошкоджений результат ─────────

test('G. Пошкоджений .bpmn: файл не видається, стан «перевірка файлу не пройшла», погодження не змінено', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const before = snapshot(db, caseId);
  const out = await buildArtifact(db, human, caseId, undefined, { tamperBpmn: (xml) => xml.replace(/<bpmn:(userTask|task) /, "<bpmn:$1 name=\"ЗІПСОВАНО\" ") });
  assert.equal(out.artifact.status, 'verification_failed');
  assert.equal(out.artifact.row.bpmn_xml, null);
  assert.deepEqual(out.artifact.downloads, { bpmn: false, drawio: false });
  assert.throws(() => readArtifactFile(db, caseId, 'bpmn'), (e: any) => e.code === 'FILE_NOT_AVAILABLE');
  assert.ok((out.artifact.detail.issues ?? []).length > 0, 'пояснення має бути');
  assert.equal(snapshot(db, caseId), before);
});

test('G. Пошкоджений лише .drawio: .bpmn лишається чинним і завантажується, помилка експорту пояснюється окремо', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const out = await buildArtifact(db, human, caseId, undefined, { tamperDrawio: (xml) => xml.replace(/endArrow=block/g, 'endArrow=none') });
  assert.equal(out.artifact.status, 'ok');
  assert.equal(out.artifact.row.drawio_status, 'failed');
  assert.equal(out.artifact.row.drawio_xml, null);
  assert.deepEqual(out.artifact.downloads, { bpmn: true, drawio: false });
  assert.ok(readArtifactFile(db, caseId, 'bpmn').xml.length > 0);
  assert.throws(() => readArtifactFile(db, caseId, 'drawio'), (e: any) => e.code === 'FILE_NOT_AVAILABLE');
  assert.ok((out.artifact.detail.drawioIssues ?? []).length > 0, 'причина збою експорту має бути видимою');
});

test('G. Підмінений запис артефакту: файл не видається, причина названа', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const out = await buildArtifact(db, human, caseId);
  // Пряма підміна в базі (обхід тригера незмінності неможливий, тому вимикаємо його лише в тесті).
  db.exec('DROP TRIGGER bpmn_artifact_no_update');
  db.exec(`UPDATE bpmn_artifact SET bpmn_xml = '<bpmn:definitions/>' WHERE id = '${out.artifact.row.id}'`);
  const v = getCaseArtifact(db, caseId)!;
  assert.equal(v.trusted, false);
  assert.ok(v.untrustedReasons.some((r) => /Хеш файлу \.bpmn/.test(r)), v.untrustedReasons.join(' | '));
  assert.throws(() => readArtifactFile(db, caseId, 'bpmn'), (e: any) => e.code === 'ARTIFACT_UNTRUSTED');
});

test('G. Підмінений хеш запису виявляється', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const out = await buildArtifact(db, human, caseId);
  db.exec('DROP TRIGGER bpmn_artifact_no_update');
  db.exec(`UPDATE bpmn_artifact SET process_name = 'Інша назва' WHERE id = '${out.artifact.row.id}'`);
  const v = getCaseArtifact(db, caseId)!;
  assert.equal(v.trusted, false);
  assert.ok(v.untrustedReasons.some((r) => /Хеш запису артефакту/.test(r)));
});

test('G. Хеш запису рахується з усіх полів: зміна будь-якого з них ламає перевірку', async () => {
  const db = freshDb();
  const { caseId } = await readyToBuild(db);
  const out = await buildArtifact(db, human, caseId);
  const { record_hash, ...rest } = artRow(db, out.artifact.row.id) as any;
  assert.equal(artifactHash(rest), record_hash);
  for (const k of ['status', 'version_id', 'approval_id', 'review_id', 'content_hash', 'process_name', 'bpmn_sha256', 'drawio_status']) {
    assert.notEqual(artifactHash({ ...rest, [k]: 'ЗМІНЕНО' }), record_hash, `поле ${k} не входить у хеш запису`);
  }
});
