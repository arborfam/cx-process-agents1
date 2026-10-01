/**
 * Зріз 3a × версії й погодження: схема прив'язана до конкретної незмінної погодженої версії (ID + хеш);
 * K2 не блокує, K1 блокує; unsupported не чіпає погодження. Генератор лише читає базу.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all } from '../src/db.ts';
import { acceptDraft, addQuestion, addSource, approve, bpmnGuard, currentApproval, getCase, headVersion, saveAnalystVersion, submitForApproval, versionContent, verifyVersionIntegrity, getVersion } from '../src/domain.ts';
import { DomainError } from '../src/errors.ts';
import { packageFromApproval } from '../src/bpmn/approved.ts';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { verifyBpmn } from '../src/bpmn/verify.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import { approvedCase, COMPLETE_FIELDS, draftReadyCase, freshDb, human, pendingCase } from './helpers.ts';
import { generateOk } from './bpmn-helpers.ts';

const snapshot = (db: ReturnType<typeof freshDb>): string => JSON.stringify({
  cases: all(db, 'SELECT * FROM "case" ORDER BY id'),
  versions: all(db, 'SELECT * FROM as_is_version ORDER BY id'),
  approvals: all(db, 'SELECT * FROM approval ORDER BY id'),
  revocations: all(db, 'SELECT * FROM approval_revocation ORDER BY approval_id'),
  audit: all(db, 'SELECT COUNT(*) AS n FROM audit_log'),
});

test('схема з погодженої версії прив’язана до її ID і хеша; файл і база не розходяться', async () => {
  const db = freshDb();
  const { c, v, a } = approvedCase(db);
  const pkg = packageFromApproval(db, c.id);
  assert.equal(pkg.versionId, v.id);
  assert.equal(pkg.versionId, a.version_id);
  assert.equal(pkg.contentHash, a.content_hash);
  assert.equal(pkg.origin, 'product');
  assert.equal(pkg.poolName, getCase(db, c.id).title);
  const r = await generateOk(pkg);
  assert.equal(r.binding.versionId, v.id);
  assert.match(r.bpmn, new RegExp(`versionId="${v.id}"`));
  assert.match(r.bpmn, new RegExp(`contentHash="${a.content_hash}"`));
  assert.match(r.drawio.xml!, new RegExp(`cx_content_hash="${a.content_hash}"`));
  assert.equal(verifyVersionIntegrity(db, v.id), true);
  // зміст схеми дослівно збігається із записаною версією
  assert.deepEqual(r.map.map((m) => m.action), versionContent(getVersion(db, v.id)).steps.map((s) => s.action));
});

test('генерація лише читає базу: версії, погодження, стан і журнал не змінюються', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const before = snapshot(db);
  await generateOk(packageFromApproval(db, c.id));
  assert.equal(snapshot(db), before);
});

test('після правки AS-IS погодження скасовано: пакет не будується, а старий файл не відповідає новій версії', async () => {
  const db = freshDb();
  const { c, v } = approvedCase(db);
  const oldPkg = packageFromApproval(db, c.id);
  const oldFile = (await generateOk(oldPkg)).bpmn;
  // правка → нова версія, стан повертається до «Дослідження»
  const v2 = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: { ...COMPLETE_FIELDS, steps_text: COMPLETE_FIELDS.steps_text!.replace('Приймає запит', 'Приймає заявку') }, coverAllSources: true });
  assert.notEqual(v2.id, v.id);
  assert.equal(currentApproval(db, c.id), undefined, 'погодження скасовано');
  assert.throws(() => packageFromApproval(db, c.id), (e: unknown) => e instanceof DomainError && e.code === 'GUARD_FAILED');
  assert.equal(bpmnGuard(db, c.id).ok, false);
  // файл, створений на старій версії, не збігається з новою: ні за версією, ні за хешем, ні за змістом
  const newer: ApprovedPackage = { versionId: v2.id, contentHash: v2.content_hash, poolName: oldPkg.poolName, content: versionContent(v2), origin: 'product' };
  const codes = verifyBpmn(oldFile, newer).report.errors.map((e) => e.code);
  assert.ok(codes.includes('BINDING_MISMATCH'));
  assert.ok(codes.includes('TASK_NAME_MISMATCH'));
  // а на старій версії файл і далі чинний (стара версія не змінюється)
  assert.equal(verifyBpmn(oldFile, oldPkg).report.ok, true);
});

test('нове джерело після погодження: схему не будуємо (серверний дозвіл не надано)', () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  addSource(db, human, c.id, { kind: 'clarification', title: 'Нове уточнення (синтетичне)', content: 'Додатковий факт.', origin: 'synthetic' });
  assert.throws(() => packageFromApproval(db, c.id), (e: unknown) => e instanceof DomainError && e.code === 'GUARD_FAILED');
});

test('до погодження пакет не будується (чернетка і «на погодженні»)', () => {
  const db = freshDb();
  const { c } = draftReadyCase(db);
  assert.throws(() => packageFromApproval(db, c.id), (e: unknown) => e instanceof DomainError && e.code === 'GUARD_FAILED');
  const db2 = freshDb();
  const p = pendingCase(db2);
  assert.throws(() => packageFromApproval(db2, p.c.id), (e: unknown) => e instanceof DomainError && e.code === 'GUARD_FAILED');
});

test('D28: відкрите некритичне питання не блокує ні погодження, ні побудову; воно показане як відоме обмеження', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const v2 = addQuestion(db, human, c.id, { baseVersionId: v.id, text: 'Чи є окремий порядок для великих клієнтів?', critical: false, impact: 'не стосується потоку' });
  acceptDraft(db, human, c.id, v2.id);
  submitForApproval(db, human, c.id);
  const a = approve(db, human, c.id, { versionId: v2.id, checklistConfirmed: true });
  assert.ok(a.id);
  const r = await generateOk(packageFromApproval(db, c.id));
  assert.ok(r.knownLimits.some((l) => l.code === 'OPEN_QUESTION' && l.message.includes('великих клієнтів')));
});

test('D28: невизначений перехід блокує погодження, а в обхід (примусово записаний пакет) — і побудову', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const v2 = addQuestion(db, human, c.id, { baseVersionId: v.id, text: 'Що після S2?', critical: false, impact: 'завершення', affects: [{ step_id: 'S2', condition: '' }] });
  acceptDraft(db, human, c.id, v2.id);
  assert.throws(() => submitForApproval(db, human, c.id), (e: unknown) => e instanceof DomainError);
  // навіть якщо пакет складено повз доменний шар, генератор сам відмовляє (другий рубіж)
  const pkg: ApprovedPackage = { versionId: v2.id, contentHash: v2.content_hash, poolName: 'Тест', content: versionContent(v2), origin: 'product' };
  const r = await generateBpmn(pkg);
  assert.equal(r.status, 'blocked');
  if (r.status === 'blocked') assert.ok(r.findings.some((f) => f.code === 'UNKNOWN_TRANSITION'));
});

test('D21: unsupported не змінює погоджений AS-IS, його хеш і погодження; кейс лишається «погоджено»', async () => {
  const db = freshDb();
  const { c, v, a } = approvedCase(db);
  const before = snapshot(db);
  const pkg = packageFromApproval(db, c.id, { unsupportedMarks: [{ step_id: 'S2', kind: 'timer', detail: 'очікування три дні' }, { step_id: 'S1', kind: 'parallel_branches', detail: 'паралельно' }] });
  const r = await generateBpmn(pkg);
  assert.equal(r.status, 'unsupported');
  if (r.status === 'unsupported') {
    assert.ok(r.explanation.includes('S1') && r.explanation.includes('S2'));
    assert.ok(r.explanation.includes(v.id), 'пояснення називає версію, яку не змінено');
  }
  assert.equal(snapshot(db), before, 'жодного запису в базі');
  assert.equal(currentApproval(db, c.id)!.id, a.id);
  assert.equal(getCase(db, c.id).state, 'approved');
  assert.equal(verifyVersionIntegrity(db, v.id), true);
  assert.equal(bpmnGuard(db, c.id).ok, true, 'серверний дозвіл лишається чинним: це обмеження інструмента, а не помилка опису');
});
