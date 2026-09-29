/**
 * Шість обов'язкових перевірок з docs/acceptance.md (перший програмний зріз).
 * Усі дані синтетичні; жодного виклику моделі. Клієнт агента — підставний (mode=demo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import {
  acceptDraft, addSource, addSourceFromFile, approve, bpmnGuard, currentApproval, getCase, headVersion, isAccepted,
  saveAnalystVersion, submissionBlockers, submitForApproval, verifyVersionIntegrity, versionContent,
} from '../src/domain.ts';
import { runAnalyst, ScriptedDemoClient, TransientModelError, startAnalystRun, completeAnalystRun } from '../src/runs.ts';
import { agent, approvedCase, COMPLETE_FIELDS, draftReadyCase, freshDb, human, pendingCase, startTestServer } from './helpers.ts';

// ─────────── 1. Прямий запит до backend без погодження ───────────
test('1. Прямий запит до backend на запуск BPMN без погодження відхиляється', async () => {
  const db = freshDb();
  const srv = await startTestServer(db);
  try {
    // кейс у різних станах без чинного погодження
    const created = await srv.call('POST', '/api/cases', { title: 'Кейс без погодження' });
    assert.equal(created.status, 201);
    const id = created.body.case.id as string;

    // a) стан «Дослідження»
    let r = await srv.call('POST', `/api/cases/${id}/bpmn/start`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'GUARD_FAILED');
    assert.ok(r.body.error.details.reasons.some((x: { code: string }) => x.code === 'NOT_APPROVED_STATE'));
    assert.ok(r.body.error.details.reasons.some((x: { code: string }) => x.code === 'NO_APPROVAL'));

    // b) підроблене тіло запиту («погоджено», чужа версія) сервер ігнорує
    r = await srv.call('POST', `/api/cases/${id}/bpmn/start`, { approved: true, version_id: 'fake', state: 'approved' });
    assert.equal(r.status, 409);

    // c) «На погодженні» — ще не погоджено
    const { c } = pendingCase(db);
    r = await srv.call('POST', `/api/cases/${c.id}/bpmn/start`, {});
    assert.equal(r.status, 409);

    // d) без входу людини — 401 (навіть без бази змін)
    r = await srv.call('POST', `/api/cases/${id}/bpmn/start`, {}, { auth: false });
    assert.equal(r.status, 401);

    // жодного запуску BPMN не створено
    assert.equal(all(db, `SELECT id FROM run WHERE agent = 'bpmn'`).length, 0);

    // e) після справжнього погодження запит проходить
    const { c: ok } = approvedCase(db);
    r = await srv.call('POST', `/api/cases/${ok.id}/bpmn/start`, {});
    assert.equal(r.status, 202);
    assert.equal(r.body.permitted, true);
    assert.equal(all(db, `SELECT id FROM run WHERE agent = 'bpmn'`).length, 1);
  } finally {
    await srv.close();
  }
});

// ─────────── 2. Погодження старої версії ───────────
test('2. Погодження старої (не поточної) версії відхиляється', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db); // v — версія 2
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  // аналітик вносить правку → кейс повертається в дослідження, з’являється версія 3
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { summary: 'Оновлена суть' } });
  assert.equal(getCase(db, c.id).state, 'research');
  assert.notEqual(v3.id, v.id);

  // спроба погодити стару версію v у стані «Дослідження»
  assert.throws(() => approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true }), (e: any) => e.code === 'BAD_STATE');

  // навіть коли кейс знову «На погодженні», стару версію погодити не можна
  acceptDraft(db, human, c.id, v3.id);
  submitForApproval(db, human, c.id);
  assert.throws(() => approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true }), (e: any) => e.code === 'VERSION_STALE');
  assert.equal(currentApproval(db, c.id), undefined, 'жодного погодження не записано');
  assert.equal(all(db, 'SELECT id FROM approval').length, 0);

  // поточну версію погодити можна
  const a = approve(db, human, c.id, { versionId: v3.id, checklistConfirmed: true });
  assert.equal(a.version_id, v3.id);
  assert.equal(a.content_hash, headVersion(db, c.id).content_hash);
});

// ─────────── 3. Нове джерело після погодження ───────────
test('3. Нове джерело після погодження: погодження втрачає чинність, історія збережена, BPMN заблоковано', async () => {
  const db = freshDb();
  const { c, v, a } = approvedCase(db);
  assert.equal(bpmnGuard(db, c.id).ok, true);

  addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю 2 (синтетичне)', content: 'Нова інформація про виняток.', origin: 'synthetic' });

  assert.equal(getCase(db, c.id).state, 'research');
  assert.equal(currentApproval(db, c.id), undefined, 'чинного погодження немає');
  const old = one<{ id: string }>(db, 'SELECT id FROM approval WHERE id = ?', a.id);
  assert.ok(old, 'запис про погодження НЕ видалено');
  const rev = one<{ reason: string }>(db, 'SELECT reason FROM approval_revocation WHERE approval_id = ?', a.id);
  assert.equal(rev?.reason, 'new_source');
  assert.ok(getCase(db, c.id).head_version_id === v.id && verifyVersionIntegrity(db, v.id), 'стара версія лишилась незмінною');

  const g = bpmnGuard(db, c.id);
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some((r) => r.code === 'NOT_APPROVED_STATE'));

  // старе погодження не «переноситься»: спроба передати на погодження заблокована непоєднаним джерелом
  // (версію v уже було прийнято, але нове джерело в ній не враховано)
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED' &&
    (e.details.blockers as { code: string }[]).some((b) => b.code === 'UNCOVERED_SOURCE'));

  // після враження джерела в НОВІЙ версії потрібне НОВЕ погодження
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: {}, coverAllSources: true });
  acceptDraft(db, human, c.id, v3.id);
  submitForApproval(db, human, c.id);
  assert.throws(() => approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true }), (e: any) => e.code === 'VERSION_STALE');
  const a2 = approve(db, human, c.id, { versionId: v3.id, checklistConfirmed: true });
  assert.notEqual(a2.id, a.id);
  assert.equal(all(db, 'SELECT id FROM approval').length, 2, 'обидва погодження в історії');
});

// ─────────── 4. Результат запуску на застарілому стані ───────────
test('4. Результат запуску на застарілому стані не замінює актуальну версію', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const { runId } = startAnalystRun(db, c.id, new ScriptedDemoClient(() => null));

  // поки «агент працює», аналітикиня редагує
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { summary: 'Правка аналітикині під час запуску' } });

  const out = { ...versionContent(v), summary: 'Інша суть від агента' };
  const proposal = completeAnalystRun(db, runId, out);

  assert.equal(proposal.kind, 'proposal', 'результат збережено лише як пропозицію');
  assert.equal(getCase(db, c.id).head_version_id, v3.id, 'поточна версія не змінилася');
  assert.equal(versionContent(headVersion(db, c.id)).summary, 'Правка аналітикині під час запуску');
  assert.equal(proposal.parent_id, v3.id);
  // навіть як пропозиція, правку аналітикині не перезаписано
  assert.equal(versionContent(proposal).summary, 'Правка аналітикині під час запуску');
  assert.equal(versionContent(proposal).conflicts.length, 1);
  const r = one<{ technical_state: string; output_version_id: string }>(db, 'SELECT technical_state, output_version_id FROM run WHERE id = ?', runId);
  assert.equal(r?.technical_state, 'done');
  assert.equal(r?.output_version_id, proposal.id);
});

test('4б. Результат запуску, завершеного коли кейс уже погоджено іншою версією, не стає головою', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const { runId } = startAnalystRun(db, c.id, new ScriptedDemoClient(() => null));
  acceptDraft(db, human, c.id, v.id);
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { summary: 'Нова суть' } });
  acceptDraft(db, human, c.id, v3.id);
  submitForApproval(db, human, c.id);
  const ap = approve(db, human, c.id, { versionId: v3.id, checklistConfirmed: true });
  completeAnalystRun(db, runId, versionContent(v));
  assert.equal(getCase(db, c.id).state, 'approved', 'стан не змінився');
  assert.equal(currentApproval(db, c.id)?.id, ap.id, 'погодження лишилося чинним');
  assert.equal(getCase(db, c.id).head_version_id, v3.id);
});

// ─────────── 5. Збереження правок ───────────
test('5. Правки аналітика зберігаються при новому запуску; конфлікт показано, історія незмінна', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const base = versionContent(v);

  // аналітикиня правила крок S1 і суть
  const editedSteps = COMPLETE_FIELDS.steps_text!.replace('Приймає запит', 'Реєструє запит клієнта (правка аналітикині)');
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { steps_text: editedSteps, summary: 'Суть від аналітикині' } });
  const before = JSON.stringify(all(db, 'SELECT id, content_hash FROM as_is_version ORDER BY number'));

  // агент повертає: інший S1, іншу суть, і додає новий S3
  const agentOut = structuredClone(versionContent(v3));
  agentOut.summary = 'Суть від агента';
  agentOut.steps[0]!.action = 'Приймає запит (варіант агента)';
  agentOut.steps.push({ id: 'S3', role: 'Оператор', action: 'Нотифікує клієнта', entry_condition: '', input_artifact: '', result: 'Клієнта повідомлено', next: [{ to: 'END', condition: '' }], source_ids: [] });
  // Спроба агента непомітно переприв'язати перехід у кроці, який написала аналітикиня (S2), теж має стати конфліктом.
  agentOut.steps[1]!.next = [{ to: 'S3', condition: '' }];

  const client = new ScriptedDemoClient((input) => {
    // агент бачить правки аналітикині у вході
    assert.match(JSON.stringify(input.head_content), /правка аналітикині/);
    return agentOut;
  });
  const res = await runAnalyst(db, c.id, client);
  assert.ok(res.ok);
  const head = headVersion(db, c.id);
  const content = versionContent(head);

  assert.equal(content.summary, 'Суть від аналітикині', 'правку суті збережено');
  assert.match(content.steps[0]!.action, /правка аналітикині/, 'правку кроку S1 збережено');
  assert.ok(content.steps.some((s) => s.id === 'S3'), 'нове від агента, що не суперечить правкам, прийнято');
  const keys = content.conflicts.map((x) => x.key).sort();
  assert.deepEqual(keys, ['step:S1', 'step:S2', 'summary']);
  assert.deepEqual(content.steps[1]!.next, [{ to: 'END', condition: '' }], 'перехід S2 лишився таким, як у аналітикині');
  const conflictS1 = content.conflicts.find((x) => x.key === 'step:S1')!;
  assert.match(conflictS1.proposed, /варіант агента/, 'показано обидва варіанти');
  assert.match(conflictS1.kept, /правка аналітикині/);

  // історія: усі попередні версії незмінні
  const after = all<{ id: string; content_hash: string }>(db, 'SELECT id, content_hash FROM as_is_version ORDER BY number');
  assert.equal(JSON.stringify(after.slice(0, 3)), before);
  assert.equal(after.length, 4);
  assert.ok(after.every((x) => verifyVersionIntegrity(db, x.id)));
  assert.equal(head.created_by, 'agent');
  assert.equal(head.mode, 'demo');
  assert.equal(one<{ mode: string; model: string }>(db, 'SELECT mode, model FROM run WHERE id = ?', res.runId)?.mode, 'demo');
});

// ─────────── 6. Помилка читання / моделі без втрати прийнятої версії ───────────
test('6а. Помилка моделі: прийнята версія, погодження й стан не змінюються', async () => {
  const db = freshDb();
  const { c, v, a } = approvedCase(db);
  const snapshot = () => JSON.stringify({
    state: getCase(db, c.id).state, head: getCase(db, c.id).head_version_id,
    versions: all(db, 'SELECT id, content_hash FROM as_is_version'),
    approval: currentApproval(db, c.id)?.id,
  });
  const before = snapshot();

  // збій, що не лікується (модель недоступна) — без повторів
  const failing = new ScriptedDemoClient(() => { throw new Error('модель недоступна'); });
  const r1 = await runAnalyst(db, c.id, failing);
  assert.equal(r1.ok, false);
  assert.equal(snapshot(), before);
  assert.equal(one<{ technical_state: string }>(db, 'SELECT technical_state FROM run WHERE id = ?', r1.runId)?.technical_state, 'error');

  // тимчасовий збій: одна повторна спроба, далі успіх
  let calls = 0;
  const flaky = new ScriptedDemoClient(() => { calls++; if (calls === 1) throw new TransientModelError('мережа'); return versionContent(v); });
  const r2 = await runAnalyst(db, c.id, flaky);
  assert.equal(calls, 2);
  assert.ok(r2.ok);

  // два тимчасові збої поспіль → помилка, без нескінченних повторів
  let calls3 = 0;
  const down = new ScriptedDemoClient(() => { calls3++; throw new TransientModelError('мережа'); });
  const r3 = await runAnalyst(db, c.id, down);
  assert.equal(calls3, 2);
  assert.equal(r3.ok, false);

  // тайм-аут
  const slow = new ScriptedDemoClient(() => new Promise(() => {}));
  const r4 = await runAnalyst(db, c.id, slow, { timeoutMs: 30, maxAttempts: 1 });
  assert.equal(r4.ok, false);
  assert.match((r4 as { error: string }).error, /тайм-аут/);
  assert.ok(a, 'погодження існує');
});

test('6б. Відповідь агента не за схемою (спроба записати «погоджено») відхиляється; стан не змінюється', async () => {
  const db = freshDb();
  const { c, v, a } = approvedCase(db);
  const evil = { ...versionContent(v), approval: { approved: true }, status: 'approved' };
  const r = await runAnalyst(db, c.id, new ScriptedDemoClient(() => evil));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /схемі/);
  assert.equal(getCase(db, c.id).state, 'approved');
  assert.equal(currentApproval(db, c.id)?.id, a.id);
  assert.equal(getCase(db, c.id).head_version_id, v.id);
});

test('6в. Помилка читання файлу: джерело позначено error, не вважається опрацьованим, погодження заблоковано', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  const bad = addSourceFromFile(db, human, c.id, { name: 'протокол.docx', bytes: new Uint8Array([0x50, 0x4b, 3, 4]), kind: 'document', required: true, origin: 'synthetic' });
  assert.equal(bad.read_status, 'error');
  assert.ok(bad.read_error);
  const badBytes = addSourceFromFile(db, human, c.id, { name: 'биті.txt', bytes: new Uint8Array([0xff, 0xfe, 0xfa]), kind: 'transcript', required: false, origin: 'synthetic' });
  assert.equal(badBytes.read_status, 'error');

  const blockers = submissionBlockers(db, c.id);
  const unread = blockers.filter((b) => b.code === 'UNREAD_SOURCE');
  assert.equal(unread.length, 2);
  assert.equal(unread.find((b) => b.ref === bad.id)?.severity, 'critical', 'обов’язковий непрочитаний блокує');
  assert.equal(unread.find((b) => b.ref === badBytes.id)?.severity, 'warning');
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED');

  // «врахувати всі матеріали» не позначає непрочитане опрацьованим
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { summary: 'Суть після спроби врахувати матеріали' }, coverAllSources: true }).id;
  const covered = JSON.parse(versionRow(db, v3).covered_json) as string[];
  assert.ok(!covered.includes(bad.id) && !covered.includes(badBytes.id));
  assert.ok(submissionBlockers(db, c.id).some((b) => b.code === 'UNREAD_SOURCE' && b.severity === 'critical'));

  // агент теж не позначає непрочитане опрацьованим
  const res = await runAnalyst(db, c.id, new ScriptedDemoClient((i) => {
    assert.ok(!i.sources.some((s) => s.id === bad.id), 'непрочитане джерело не передається агенту');
    return versionContent(headVersion(db, c.id));
  }));
  assert.ok(res.ok);
  assert.ok(!(JSON.parse(headVersion(db, c.id).covered_json) as string[]).includes(bad.id));
  assert.ok(isAccepted(db, v.id), 'раніше прийнята версія збереглася');
});

function versionRow(db: ReturnType<typeof freshDb>, id: string) {
  return one<{ covered_json: string }>(db, 'SELECT covered_json FROM as_is_version WHERE id = ?', id)!;
}

void agent;
