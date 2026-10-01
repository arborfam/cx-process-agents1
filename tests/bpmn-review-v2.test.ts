/**
 * Два дефекти, відтворені незалежною перевіркою (Codex) після 3b-3…3b-7 — D75:
 *  1. Повторна побудова після технічної помилки була неможлива: `buildArtifact` повертав наявний артефакт
 *     незалежно від статусу, тож невдала побудова «залипала» (`reused=true`) і виправити її можна було
 *     лише новим платним запуском перевірки. Те саме для невдалого експорту `.drawio`.
 *  2. Збережені рішення аналітикині бралися зі сховища без перевірки: запис, вписаний у базу напряму
 *     з хибними `content_hash`/`record_hash`, порожнім поясненням і `finding_json='{}'`, відкривав шлюз.
 * Усе — на ПІДСТАВНОМУ клієнті агента 2: якість AI цим не перевіряється.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb, type DB } from '../src/db.ts';
import { canonical, sha256 } from '../src/hash.ts';
import { findingKey } from '../src/ai/bpmn-review.ts';
import {
  acceptDraft, addNotationRequirement, approve, currentApproval, headVersion, returnToResearch, saveAnalystVersion, submitForApproval,
} from '../src/domain.ts';
import { checkResolution, getCaseReview, rejectFinding, resolutionHash, runBpmnReviewForCase, type ResolutionRow } from '../src/review-runs.ts';
import { buildArtifact, buildPreflight, getCaseArtifact, listCaseArtifacts, readArtifactFile } from '../src/bpmn-artifacts.ts';
import { approvedCase, freshDb, human, tempDbPath } from './helpers.ts';
import { FakeReviewClient, finding, okStep, policyOf, reviewer, type Step } from './review-helpers.ts';

const EXPL = 'Опис однозначний: інших випадків тут немає (синтетичне пояснення тесту).';
const arts = (db: DB, caseId: string) => all<Record<string, any>>(db, 'SELECT * FROM bpmn_artifact WHERE case_id = ? ORDER BY rowid', caseId);

/** Погоджений кейс + завершена перевірка. Повертає ще й клієнта, щоб рахувати виклики «моделі». */
async function reviewed(db: DB, steps: Step[] = [okStep([])]) {
  const { c } = approvedCase(db);
  const client = new FakeReviewClient(steps);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok, JSON.stringify(r));
  return { caseId: c.id, client, reviewId: (r as { reviewId: string }).reviewId };
}

// ═════════ Дефект 1: повторна побудова після технічної помилки ═════════

const BREAK_BPMN = { tamperBpmn: (xml: string) => xml.replace(/<bpmn:task /, '<bpmn:task name="ЗІПСОВАНО" ') };
const BREAK_DRAWIO = { tamperDrawio: (xml: string) => xml.replace(/endArrow=block/g, 'endArrow=none') };

test('1. Після verification_failed повторна побудова виконується заново й дає чинну схему — без нового виклику моделі', async () => {
  const db = freshDb();
  const { caseId, client } = await reviewed(db);

  const bad = await buildArtifact(db, human, caseId, undefined, BREAK_BPMN);
  assert.equal(bad.artifact.status, 'verification_failed');
  assert.equal(bad.reused, false);

  const good = await buildArtifact(db, human, caseId);
  assert.equal(good.reused, false, 'повторна побудова не має повертати невдалий артефакт');
  assert.equal(good.artifact.status, 'ok');
  assert.ok(good.artifact.downloads.bpmn);
  assert.equal(client.calls, 1, 'повтор не звертається до моделі');

  // Невдала спроба лишається в історії.
  const rows = arts(db, caseId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.status), ['verification_failed', 'ok']);
  assert.equal(getCaseArtifact(db, caseId)!.row.id, good.artifact.row.id, 'чинним стає успішний результат');
});

test('1. Після невдалого .drawio повторна побудова повторює експорт і зберігає той самий перевірений .bpmn', async () => {
  const db = freshDb();
  const { caseId, client } = await reviewed(db);

  const partial = await buildArtifact(db, human, caseId, undefined, BREAK_DRAWIO);
  assert.equal(partial.artifact.status, 'ok');
  assert.equal(partial.artifact.row.drawio_status, 'failed');
  assert.deepEqual(partial.artifact.downloads, { bpmn: true, drawio: false });
  const bpmnHashBefore = partial.artifact.row.bpmn_sha256!;

  const full = await buildArtifact(db, human, caseId);
  assert.equal(full.reused, false, 'експорт .drawio має бути повторено');
  assert.equal(full.artifact.row.drawio_status, 'ok');
  assert.deepEqual(full.artifact.downloads, { bpmn: true, drawio: true });
  assert.equal(full.artifact.row.bpmn_sha256, bpmnHashBefore, 'чинний .bpmn і його хеш не змінились');
  assert.equal(client.calls, 1, 'повтор не звертається до моделі');
  assert.equal(arts(db, caseId).length, 2, 'невдала спроба лишається в історії');
  assert.equal(readArtifactFile(db, caseId, 'drawio').sha256, full.artifact.row.drawio_sha256);
});

test('1. Успішний повний результат і далі використовується повторно (повторний клік не перегенеровує)', async () => {
  const db = freshDb();
  const { caseId } = await reviewed(db);
  const first = await buildArtifact(db, human, caseId);
  const second = await buildArtifact(db, human, caseId);
  assert.equal(second.reused, true);
  assert.equal(second.artifact.row.id, first.artifact.row.id);
  assert.equal(arts(db, caseId).length, 1);
});

test('1. Паралельні запити після невдалої спроби не плодять дублікатів успішного результату', async () => {
  const db = freshDb();
  const { caseId, client } = await reviewed(db);
  await buildArtifact(db, human, caseId, undefined, BREAK_BPMN);
  const [a, b] = await Promise.all([buildArtifact(db, human, caseId), buildArtifact(db, human, caseId)]);
  const ok = arts(db, caseId).filter((r) => r.status === 'ok');
  assert.equal(ok.length, 1, 'успішний результат має бути один');
  assert.equal(a.artifact.row.id, b.artifact.row.id);
  assert.ok(a.reused || b.reused);
  assert.equal(client.calls, 1);
});

test('1. Повтор не обходить блокувальних зауважень', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([finding()])]);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  rejectFinding(db, human, caseId, { reviewId, findingKey: key, explanation: EXPL });
  const bad = await buildArtifact(db, human, caseId, undefined, BREAK_BPMN);
  assert.equal(bad.artifact.status, 'verification_failed');
  // Друге зауваження з'являється лише з новим запуском перевірки; тут перевіряємо, що повтор не минає шлюзу,
  // якщо рішення зникло б. Моделюємо це видаленням рішення (лише в тесті, з вимкненим тригером).
  db.exec('DROP TRIGGER finding_resolution_no_delete');
  db.exec(`DELETE FROM finding_resolution WHERE case_id = '${caseId}'`);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
  assert.equal(arts(db, caseId).filter((r) => r.status === 'ok').length, 0);
});

test('1. Повтор не обходить unsupported і застарілої версії', async () => {
  // (а) unsupported: підтверджена вимога до нотації
  const dbU = freshDb();
  const { c } = approvedCase(dbU);
  const v = addNotationRequirement(dbU, human, c.id, { baseVersionId: headVersion(dbU, c.id).id, kind: 'parallel_branches', stepId: 'S1', detail: 'Дії справді одночасні (синтетично).' });
  acceptDraft(dbU, human, c.id, v.id);
  submitForApproval(dbU, human, c.id);
  approve(dbU, human, c.id, { versionId: v.id, checklistConfirmed: true });
  const clientU = new FakeReviewClient([okStep([])]);
  await runBpmnReviewForCase(dbU, human, c.id, reviewer(clientU, policyOf()));
  await assert.rejects(() => buildArtifact(dbU, human, c.id), (e: any) => e.code === 'UNSUPPORTED');
  await assert.rejects(() => buildArtifact(dbU, human, c.id), (e: any) => e.code === 'UNSUPPORTED');
  assert.equal(arts(dbU, c.id).length, 0);

  // (б) застарівання після невдалої спроби
  const db = freshDb();
  const { caseId } = await reviewed(db);
  await buildArtifact(db, human, caseId, undefined, BREAK_BPMN);
  returnToResearch(db, human, caseId, 'уточнення (тест)');
  const nv = saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { summary: 'Уточнено (синтетично).' } });
  acceptDraft(db, human, caseId, nv.id);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => ['GUARD_FAILED', 'REVIEW_STALE', 'STALE'].includes(e.code));
  assert.equal(arts(db, caseId).filter((r) => r.status === 'ok').length, 0);
});

test('1. Невдалий артефакт не видається як файл і не стає чинним результатом', async () => {
  const db = freshDb();
  const { caseId } = await reviewed(db);
  await buildArtifact(db, human, caseId, undefined, BREAK_BPMN);
  assert.throws(() => readArtifactFile(db, caseId, 'bpmn'), (e: any) => e.code === 'FILE_NOT_AVAILABLE');
  await buildArtifact(db, human, caseId);
  assert.equal(readArtifactFile(db, caseId, 'bpmn').xml.length > 0, true);
  assert.equal(listCaseArtifacts(db, caseId).length, 2, 'історія зберігає обидві спроби');
});

// ═════════ Дефект 2: перевірка збереженого рішення аналітикині ═════════

/** Вписує рішення прямо в базу (обхід дії людини), з можливістю перерахувати контрольну суму. */
function forgeResolution(db: DB, caseId: string, reviewId: string, over: Partial<ResolutionRow>, recomputeHash: boolean): string {
  const rev = one<Record<string, any>>(db, 'SELECT * FROM bpmn_review WHERE id = ?', reviewId)!;
  const row: Omit<ResolutionRow, 'record_hash'> = {
    id: `fres_${Math.random().toString(16).slice(2, 14)}`, case_id: caseId, review_id: reviewId, run_id: rev.run_id,
    approval_id: rev.approval_id, version_id: rev.version_id, content_hash: rev.content_hash,
    finding_key: '', finding_json: '{}', decision: 'rejected', explanation: '', decided_by: 'хтось',
    decided_at: '2026-01-01T00:00:00.000Z', ...over,
  } as Omit<ResolutionRow, 'record_hash'>;
  const hash = recomputeHash ? resolutionHash(row) : 'ЗІПСОВАНИЙ-ХЕШ';
  db.prepare(`INSERT INTO finding_resolution (id, case_id, review_id, run_id, approval_id, version_id, content_hash,
      finding_key, finding_json, decision, explanation, decided_by, decided_at, record_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.case_id, row.review_id, row.run_id, row.approval_id, row.version_id, row.content_hash,
      row.finding_key, row.finding_json, row.decision, row.explanation, row.decided_by, row.decided_at, hash);
  return row.id;
}

test('2. Запис із хибним хешем, порожнім поясненням і підміненим змістом блокування не знімає', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([finding()])]);
  const key = getCaseReview(db, caseId).findingsView![0]!.key;
  assert.equal(getCaseReview(db, caseId).gate!.ok, false);

  forgeResolution(db, caseId, reviewId, { finding_key: key, content_hash: 'ХИБНИЙ-ХЕШ', finding_json: '{}', explanation: '' }, false);

  const r = getCaseReview(db, caseId);
  assert.equal(r.gate!.ok, false, 'підроблене рішення не має відкривати шлюз');
  assert.equal(r.gate!.code, 'BLOCKING_FINDINGS');
  assert.equal(buildPreflight(db, caseId).ok, false);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
  // Причина недовіри має бути названа зрозуміло.
  assert.ok((r.invalidResolutions ?? []).length === 1, 'некоректний запис має бути показаний');
  const reasons = (r.invalidResolutions ?? [])[0]!.reasons.join(' ');
  assert.match(reasons, /хеш|цілісн/i);
  assert.equal(r.findingsView![0]!.resolution, null, 'підроблене рішення не показується як чинне');
});

test('2. Хибна прив’язка з ПЕРЕРАХОВАНОЮ контрольною сумою теж не знімає блокування', async () => {
  // Частину прив'язок (кейс, запуск, погодження, версія) не дає підробити сама база — зовнішні ключі.
  // Це сильніший захист, ніж перевірка в коді, і його теж фіксуємо.
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([finding()])]);
  const view = getCaseReview(db, caseId).findingsView![0]!;
  const good = { finding_key: view.key, finding_json: JSON.stringify(view.finding), explanation: EXPL, decided_by: 'Аналітикиня' };
  for (const [what, over] of [
    ['запуск', { run_id: 'run_000000000000' }],
    ['погодження', { approval_id: 'appr_000000000000' }],
    ['версія', { version_id: 'ver_000000000000' }],
    ['кейс', { case_id: 'case_000000000000' }],
  ] as [string, Partial<ResolutionRow>][]) {
    assert.throws(() => forgeResolution(db, caseId, reviewId, { ...good, ...over }, true),
      /FOREIGN KEY/, `прив'язка «${what}»: база мала відхилити запис`);
  }

  // Хеш пакета зовнішнім ключем не захищений — його має впіймати перевірка в коді.
  forgeResolution(db, caseId, reviewId, { ...good, content_hash: 'ІНШИЙ-ХЕШ' }, true);
  const r = getCaseReview(db, caseId);
  assert.equal(r.gate!.ok, false, 'рішення з чужим хешем пакета не має відкривати шлюз');
  assert.equal((r.resolutions ?? []).length, 0);
  assert.match((r.invalidResolutions ?? []).map((x) => x.reasons.join(' ')).join(' '), /Хеш пакета/);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
});

test('2. Перевірка прив’язки працює й для тих полів, які база не дає підробити (пряма перевірка checkResolution)', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([finding()])]);
  const review = getCaseReview(db, caseId);
  const view = review.findingsView![0]!;
  const rev = one<Record<string, any>>(db, 'SELECT * FROM bpmn_review WHERE id = ?', reviewId)!;
  const base: Omit<ResolutionRow, 'record_hash'> = {
    id: 'fres_direct', case_id: caseId, review_id: reviewId, run_id: rev.run_id, approval_id: rev.approval_id,
    version_id: rev.version_id, content_hash: rev.content_hash, finding_key: view.key,
    finding_json: JSON.stringify(view.finding), decision: 'rejected', explanation: EXPL,
    decided_by: 'Аналітикиня', decided_at: '2026-01-01T00:00:00.000Z',
  };
  const withHash = (o: Omit<ResolutionRow, 'record_hash'>): ResolutionRow => ({ ...o, record_hash: resolutionHash(o) });
  // Контроль: коректний запис проходить.
  assert.deepEqual(checkResolution(withHash(base), rev as any, review.findings!), []);
  for (const [what, over, re] of [
    ['кейс', { case_id: 'case_000000000000' }, /іншому кейсу/],
    ['перевірка', { review_id: 'rev_000000000000' }, /іншій перевірці/],
    ['запуск', { run_id: 'run_000000000000' }, /Запуск у рішенні/],
    ['погодження', { approval_id: 'appr_000000000000' }, /Погодження в рішенні/],
    ['версія', { version_id: 'ver_000000000000' }, /Версія в рішенні/],
    ['хеш пакета', { content_hash: 'ІНШИЙ' }, /Хеш пакета/],
  ] as [string, Partial<ResolutionRow>, RegExp][]) {
    const reasons = checkResolution(withHash({ ...base, ...over }), rev as any, review.findings!);
    assert.ok(reasons.some((x) => re.test(x)), `прив'язка «${what}»: очікували причину ${re}, отримали: ${reasons.join(' | ')}`);
  }
  // Контрольна сума теж перевіряється окремо від прив'язки.
  assert.ok(checkResolution({ ...base, record_hash: 'ХИБНИЙ' }, rev as any, review.findings!).some((x) => /Контрольна сума/.test(x)));
});

test('2. Запис із правильним хешем, але чужою копією знахідки чи чужим ключем не рахується', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([finding()])]);
  const view = getCaseReview(db, caseId).findingsView![0]!;

  // (а) ключ правильний, але збережена копія знахідки — інша
  forgeResolution(db, caseId, reviewId, {
    finding_key: view.key, finding_json: JSON.stringify({ ...view.finding, question: 'Зовсім інше питання?' }), explanation: EXPL,
  }, true);
  assert.equal(getCaseReview(db, caseId).gate!.ok, false, 'копія знахідки має збігатися з ключем');

  // (б) ключ, якого серед знахідок немає
  const db2 = freshDb();
  const s2 = await reviewed(db2, [okStep([finding()])]);
  forgeResolution(db2, s2.caseId, s2.reviewId, { finding_key: 'f'.repeat(64), finding_json: JSON.stringify(view.finding), explanation: EXPL }, true);
  assert.equal(getCaseReview(db2, s2.caseId).gate!.ok, false);
});

test('2. Запис із порожнім чи надто коротким поясненням не рахується, навіть із правильним хешем', async () => {
  for (const expl of ['', '   ', 'коротко']) {
    const db = freshDb();
    const s = await reviewed(db, [okStep([finding()])]);
    const v = getCaseReview(db, s.caseId).findingsView![0]!;
    forgeResolution(db, s.caseId, s.reviewId, { finding_key: v.key, finding_json: JSON.stringify(v.finding), explanation: expl }, true);
    const r = getCaseReview(db, s.caseId);
    assert.equal(r.gate!.ok, false, `пояснення «${expl}» не мало прийматись`);
    assert.match((r.invalidResolutions ?? []).map((x) => x.reasons.join(' ')).join(' '), /поясн/i);
  }
});

test('2. Рішення для зауваження, яке відхиляти не можна, не рахується (informational і UNSUPPORTED_CANDIDATE)', async () => {
  // informational: шлюз і так відкритий, але рішення не має показуватись як чинне
  const dbI = freshDb();
  const sI = await reviewed(dbI, [okStep([finding({ class: 'informational' })])]);
  const vI = getCaseReview(dbI, sI.caseId).findingsView![0]!;
  forgeResolution(dbI, sI.caseId, sI.reviewId, { finding_key: vI.key, finding_json: JSON.stringify(vI.finding), explanation: EXPL }, true);
  const rI = getCaseReview(dbI, sI.caseId);
  assert.equal(rI.findingsView![0]!.resolution, null, 'рішення щодо незаблокованого зауваження не є чинним');
  assert.ok((rI.invalidResolutions ?? []).length === 1);

  // UNSUPPORTED_CANDIDATE: шлюз лишається закритим
  const dbU = freshDb();
  const sU = await reviewed(dbU, [okStep([finding({ code: 'UNSUPPORTED_CANDIDATE' })])]);
  const vU = getCaseReview(dbU, sU.caseId).findingsView![0]!;
  forgeResolution(dbU, sU.caseId, sU.reviewId, { finding_key: vU.key, finding_json: JSON.stringify(vU.finding), explanation: EXPL }, true);
  const rU = getCaseReview(dbU, sU.caseId);
  assert.equal(rU.gate!.ok, false);
  assert.equal(rU.gate!.code, 'UNSUPPORTED_CANDIDATE');
  assert.equal(rU.findingsView![0]!.resolution, null);
});

test('2. Справжнє рішення людини лишається чинним і після перезапуску — без звернення до моделі', async () => {
  const dbPath = tempDbPath();
  const db = openDb(dbPath);
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([okStep([finding()])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok);
  const reviewId = (r as { reviewId: string }).reviewId;
  const key = getCaseReview(db, c.id).findingsView![0]!.key;
  const res = rejectFinding(db, human, c.id, { reviewId, findingKey: key, explanation: EXPL });
  assert.equal(getCaseReview(db, c.id).gate!.ok, true);
  db.close();

  // «Перезапуск»: нове з'єднання з тією самою базою, клієнта моделі немає.
  const db2 = openDb(dbPath);
  const after = getCaseReview(db2, c.id);
  assert.equal(after.gate!.ok, true, 'коректне рішення має працювати після перезапуску');
  assert.deepEqual(after.invalidResolutions ?? [], []);
  assert.equal(after.findingsView![0]!.resolution?.explanation, EXPL);
  const built = await buildArtifact(db2, human, c.id);
  assert.equal(built.artifact.status, 'ok');
  assert.equal(client.calls, 1, 'моделі після перезапуску не кликали');
  // Контроль: сам запис цілий і його хеш збігається.
  const row = one<ResolutionRow>(db2, 'SELECT * FROM finding_resolution WHERE id = ?', res.id)!;
  const { record_hash, ...rest } = row;
  assert.equal(resolutionHash(rest), record_hash);
  assert.equal(canonical(JSON.parse(row.finding_json)), canonical(getCaseReview(db2, c.id).findings![0]!));
  assert.equal(row.finding_key, findingKey(JSON.parse(row.finding_json)));
  db2.close();
});

test('2. Серед кількох рішень чинні рахуються, а підроблені — ні', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([
    finding({ question: 'Перше питання?' }),
    finding({ question: 'Друге питання?', step_ids: ['S1'], quote: 'Приймає запит' }),
  ])]);
  const views = getCaseReview(db, caseId).findingsView!;
  // Перше — справжнє рішення людини; друге — підробка з правильним хешем, але порожнім поясненням.
  rejectFinding(db, human, caseId, { reviewId, findingKey: views[0]!.key, explanation: EXPL });
  forgeResolution(db, caseId, reviewId, { finding_key: views[1]!.key, finding_json: JSON.stringify(views[1]!.finding), explanation: '' }, true);

  const r = getCaseReview(db, caseId);
  assert.equal(r.gate!.ok, false, 'одного справжнього рішення не досить');
  assert.equal((r.resolutions ?? []).length, 1, 'чинним лишається лише справжнє рішення');
  assert.equal((r.invalidResolutions ?? []).length, 1);
  assert.equal(r.findingsView![0]!.resolution?.explanation, EXPL);
  assert.equal(r.findingsView![1]!.resolution, null);
  await assert.rejects(() => buildArtifact(db, human, caseId), (e: any) => e.code === 'BLOCKING_FINDINGS');
});

test('2. Пошкоджений запис займає слот рішення: людина отримує зрозуміле пояснення, а не помилку бази', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([finding()])]);
  const view = getCaseReview(db, caseId).findingsView![0]!;
  forgeResolution(db, caseId, reviewId, { finding_key: view.key, finding_json: JSON.stringify(view.finding), explanation: '' }, true);
  assert.throws(() => rejectFinding(db, human, caseId, { reviewId, findingKey: view.key, explanation: EXPL }),
    (e: any) => e.code === 'RESOLUTION_DAMAGED' && /перевірку заново/.test(e.message));
  assert.equal(getCaseReview(db, caseId).gate!.ok, false);
});

test('2. Два справжні рішення щодо різних зауважень відкривають шлюз', async () => {
  const db = freshDb();
  const { caseId, reviewId } = await reviewed(db, [okStep([
    finding({ question: 'Перше питання?' }),
    finding({ question: 'Друге питання?', step_ids: ['S1'], quote: 'Приймає запит' }),
  ])]);
  const views = getCaseReview(db, caseId).findingsView!;
  rejectFinding(db, human, caseId, { reviewId, findingKey: views[0]!.key, explanation: EXPL });
  assert.equal(getCaseReview(db, caseId).gate!.ok, false);
  rejectFinding(db, human, caseId, { reviewId, findingKey: views[1]!.key, explanation: EXPL + ' друге.' });
  const r = getCaseReview(db, caseId);
  assert.equal(r.gate!.ok, true);
  assert.deepEqual(r.invalidResolutions ?? [], []);
  const built = await buildArtifact(db, human, caseId);
  assert.equal(built.artifact.status, 'ok');
});
