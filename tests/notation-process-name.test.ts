/**
 * D61 (явні вимоги до нотації) і D62 (назва процесу = напис на пулі) — підготовчий крок до 3b.
 * Перевіряється: збереження старих версій і погоджень (зокрема золотий хеш, обчислений ДО змін), редагування людиною,
 * захист підтверджених даних від агента, відсутність обходу блокувань (домен, API, генератор), видимість при погодженні.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, run } from '../src/db.ts';
import {
  acceptDraft, addNotationRequirement, addSource, approve, bpmnGuard, buildCard, computeVersionHash, createCase, currentApproval, decideNotationRequirement,
  diffVersions, getCase, getVersion, headVersion, insertVersion, protectAnalystEdits, removeNotationRequirement, saveAnalystVersion, submissionBlockers,
  submitForApproval, verifyVersionIntegrity, versionContent,
} from '../src/domain.ts';
import { ContentSchema, emptyContent, type Content, type NotationRequirementT } from '../src/schema.ts';
import { runAnalyst, ScriptedDemoClient } from '../src/runs.ts';
import { verifyAgentOutput } from '../src/ai/verify.ts';
import { loadInstruction } from '../src/ai/prompt.ts';
import { packageFromApproval } from '../src/bpmn/approved.ts';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { approvedCase, COMPLETE_FIELDS, draftReadyCase, freshDb, human, startTestServer, newCase } from './helpers.ts';
import type { AnalystInput } from '../src/ai/types.ts';

const agentActor = { kind: 'agent' as const, name: 'analyst-agent' };

// ───────────────────────── старі версії й погодження ─────────────────────────

const LEGACY_JSON = '{"summary":"Старий запис (до появи назви процесу й вимог до нотації)","business_context":"Синтетичний","boundaries":{"trigger":"Запит клієнта","input":"Заявка","completion":"Умови оновлено","result":"Оновлений договір"},"roles":["Менеджер","Оператор"],"entry_step_id":"S1","steps":[{"id":"S1","role":"Менеджер","action":"Приймає запит","entry_condition":"","input_artifact":"","result":"Заявка","next":[{"to":"S2","condition":""}],"source_ids":[]},{"id":"S2","role":"Оператор","action":"Вносить зміну","entry_condition":"","input_artifact":"","result":"Умови оновлено","next":[{"to":"END","condition":""}],"source_ids":[]}],"problems":[],"claims":[],"hypotheses":[],"questions":[],"conflicts":[]}';
/** Хеш цього змісту з джерелом `src_golden` (якого немає в базі → «MISSING»), обчислений СТАРИМ кодом до додавання нових полів. */
const LEGACY_HASH = 'f1b1c1dd8d50232342a6dd145dd942da16aedeaca8c061309da9b2ab7c496f18';

test('старі версії: зміст без нових полів читається, записується й хешується так само, як до змін (золотий хеш зі старого коду)', () => {
  // схема не додає нових ключів до старого змісту
  assert.equal(JSON.stringify(ContentSchema.parse(JSON.parse(LEGACY_JSON))), LEGACY_JSON);
  const db = freshDb();
  assert.equal(computeVersionHash(db, LEGACY_JSON, ['src_golden']), LEGACY_HASH);
  const c = newCase(db);
  const v = insertVersion(db, { caseId: c.id, content: JSON.parse(LEGACY_JSON) as Content, createdBy: 'analyst', actorName: 'Аналітикиня', parentId: headVersion(db, c.id).id, covered: ['src_golden'], owned: [], note: 'старий запис' });
  assert.equal(v.content_json, LEGACY_JSON, 'у збереженому змісті немає ні process_name, ні notation_requirements');
  assert.equal(v.content_hash, LEGACY_HASH);
  assert.equal(verifyVersionIntegrity(db, v.id), true);
  const content = versionContent(v);
  assert.equal(content.process_name, undefined);
  assert.equal(content.notation_requirements, undefined);
});

test('старі версії: правка, що не стосується нових полів, не додає їх; «порожньо» і «немає поля» — одне й те саме (без хибних змін)', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const legacy = structuredClone(versionContent(v));
  delete legacy.process_name;
  const l = insertVersion(db, { caseId: c.id, content: legacy, createdBy: 'analyst', actorName: 'А', parentId: v.id, covered: JSON.parse(v.covered_json), owned: [], note: 'легасі' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', l.id, c.id);
  let other = saveAnalystVersion(db, human, c.id, { baseVersionId: l.id, fields: { summary: 'Інша правка' } });
  const keys = Object.keys(JSON.parse(other.content_json) as object);
  assert.ok(!keys.includes('process_name') && !keys.includes('notation_requirements'), 'нові поля не з’явилися мовчки');
  // форма редагування завжди надсилає process_name (порожній, якщо назви немає): це не повинно мовчки дописати поле в старий запис
  const viaForm = saveAnalystVersion(db, human, c.id, { baseVersionId: other.id, fields: { summary: 'Правка через форму', process_name: '' } });
  assert.ok(!Object.keys(JSON.parse(viaForm.content_json) as object).includes('process_name'), 'порожня назва з форми не створює поле у старому записі');
  other = viaForm;
  // порожній запис назви в старому записі — не зміна
  assert.throws(() => saveAnalystVersion(db, human, c.id, { baseVersionId: other.id, fields: { process_name: '   ' } }), (e: any) => e.code === 'NO_CHANGES');
  assert.deepEqual(diffVersions(versionContent(l), versionContent(other), [], [], () => '').filter((x) => x.label === 'Назва процесу' || x.label === 'Нотація'), []);
});

test('старий ПОГОДЖЕНИЙ запис без назви процесу: версія й погодження не переписуються; дозвіл BPMN — лише після явного уточнення з новою версією й погодженням', () => {
  const db = freshDb();
  const { c, leg, approvalId: aid } = legacyApproved(db);
  const a = { id: aid };
  const before = JSON.stringify([one(db, 'SELECT * FROM as_is_version WHERE id = ?', leg.id), one(db, 'SELECT * FROM approval WHERE id = ?', a.id)]);

  // 1) пояснення без підстановки назви кейсу
  const g = bpmnGuard(db, c.id);
  assert.equal(g.ok, false);
  const reason = g.reasons.find((r) => r.code === 'PROCESS_NAME_MISSING')!;
  assert.ok(reason);
  assert.match(reason.message, /не можна/);
  assert.match(reason.message, /нову версію/);
  assert.throws(() => packageFromApproval(db, c.id), (e: any) => e.code === 'GUARD_FAILED' && e.details.reasons.some((r: any) => r.code === 'PROCESS_NAME_MISSING'));
  const card = buildCard(db, c.id, 'demo');
  assert.equal(card.next_action.key, 'clarify_process_name');
  assert.equal(card.process_name.defined, false);

  // 2) версія й погодження не змінились від самої перевірки
  assert.equal(JSON.stringify([one(db, 'SELECT * FROM as_is_version WHERE id = ?', leg.id), one(db, 'SELECT * FROM approval WHERE id = ?', a.id)]), before);

  // 3) явне уточнення людиною: нова версія, погодження старої скасоване (лишається в історії)
  const fixed = saveAnalystVersion(db, human, c.id, { baseVersionId: leg.id, fields: { process_name: 'Зміна умов договору' } });
  assert.equal(fixed.number, leg.number + 1);
  assert.equal(getCase(db, c.id).state, 'research');
  assert.equal(currentApproval(db, c.id), undefined);
  assert.equal(all<{ reason: string }>(db, 'SELECT reason FROM approval_revocation WHERE approval_id = ?', a.id)[0]!.reason, 'content_changed');
  assert.equal(JSON.stringify(one(db, 'SELECT * FROM as_is_version WHERE id = ?', leg.id)), JSON.stringify(JSON.parse(before)[0]), 'стара версія незмінна');
  assert.equal(verifyVersionIntegrity(db, leg.id), true);
  assert.equal(bpmnGuard(db, c.id).ok, false, 'до нового погодження дозволу немає');
  acceptDraft(db, human, c.id, fixed.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: fixed.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, c.id).ok, true);
});

// ───────────────────────── D62: назва процесу ─────────────────────────

test('D62: назва процесу входить у зміст і хеш; зміна створює нову версію; той самий текст — без нової версії; пробіли обрізаються', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  assert.equal(versionContent(v).process_name, COMPLETE_FIELDS.process_name);
  const v2 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { process_name: '  Нова назва процесу  ' } });
  assert.equal(versionContent(v2).process_name, 'Нова назва процесу');
  assert.notEqual(v2.content_hash, v.content_hash, 'назва під хешем');
  assert.equal(v2.number, v.number + 1);
  assert.throws(() => saveAnalystVersion(db, human, c.id, { baseVersionId: v2.id, fields: { process_name: 'Нова назва процесу' } }), (e: any) => e.code === 'NO_CHANGES');
  assert.throws(() => saveAnalystVersion(db, human, c.id, { baseVersionId: v2.id, fields: { process_name: 'я'.repeat(301) } }), (e: any) => e.code === 'VALIDATION');
  // явне зняття назви записує порожній рядок («не зазначено») — це зміна
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v2.id, fields: { process_name: '' } });
  assert.equal(versionContent(v3).process_name, '');
  assert.equal(buildCard(db, c.id, 'demo').process_name.defined, false);
  const diff = diffVersions(versionContent(v2), versionContent(v3), [], [], () => '');
  assert.ok(diff.some((x) => x.label === 'Назва процесу' && /Нова назва процесу/.test(x.text)));
});

test('D62: назва кейсу — окрема мітка: вона ніколи не стає назвою процесу (ні в змісті, ні в пакеті, ні в схемі)', async () => {
  const db = freshDb();
  const c = createCase(db, human, 'ВНУТРІШНЯ МІТКА КЕЙСУ', 'demo');
  addSource(db, human, c.id, { kind: 'request', title: 'Запит', content: 'Текст', origin: 'synthetic' });
  const fields = { ...COMPLETE_FIELDS };
  delete fields.process_name;
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields, coverAllSources: true });
  assert.equal(versionContent(v).process_name, undefined);
  assert.ok(!v.content_json.includes('ВНУТРІШНЯ МІТКА КЕЙСУ'));
  // назви немає — це попередження, а не блокер передачі на погодження (вимога: «перед побудовою»)
  const w = submissionBlockers(db, c.id).find((b) => b.code === 'PROCESS_NAME_MISSING')!;
  assert.equal(w.severity, 'warning');
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, c.id).ok, false);
  // навіть якщо пакет скласти повз доменний шар, генератор відмовляє і назви кейсу в результаті немає
  const r = await generateBpmn({ versionId: v.id, contentHash: v.content_hash, content: versionContent(v), origin: 'product' });
  assert.equal(r.status, 'blocked');
  assert.ok(!JSON.stringify(r).includes('ВНУТРІШНЯ МІТКА КЕЙСУ'));
});

test('D62: назва процесу видима аналітику в картці (суть, редактор) і під час погодження; зміна після погодження скасовує погодження', () => {
  const db = freshDb();
  const { c, v } = approvedCase(db);
  const card = buildCard(db, c.id, 'demo');
  assert.deepEqual(card.process_name, { value: COMPLETE_FIELDS.process_name, defined: true });
  assert.equal(card.editable.process_name, COMPLETE_FIELDS.process_name);
  // на сторінці є поле й показ у «Суті», описі й діалозі погодження (клієнтський код)
  const appJs = require_app();
  for (const needle of ['card.process_name', 'process-name-input', 'approve-facts', 'Назва процесу (напис на схемі)']) assert.ok(appJs.includes(needle), `app.js: немає «${needle}»`);
  const v2 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id, fields: { process_name: 'Інша назва' } });
  assert.equal(currentApproval(db, c.id), undefined);
  assert.equal(getCase(db, c.id).state, 'research');
  assert.equal(bpmnGuard(db, c.id).ok, false);
  assert.equal(v2.number, v.number + 1);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function require_app(): string { return readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8'); }

// ───────────────────────── D61: вимоги до нотації (людина) ─────────────────────────

test('D61: людина додає вимогу — одразу підтверджена, у новій версії під хешем; погодження скасовується; поле «не зазначено» ≠ «особливостей немає»', () => {
  const db = freshDb();
  const { c, v } = approvedCase(db);
  assert.equal(versionContent(v).notation_requirements, undefined, 'за замовчуванням «не зазначено»');
  assert.equal(buildCard(db, c.id, 'demo').notation_requirements.length, 0);
  const v2 = addNotationRequirement(db, human, c.id, { baseVersionId: v.id, kind: 'parallel_branches', stepId: 'S2', detail: 'дві дії виконуються одночасно' });
  const r = versionContent(v2).notation_requirements![0]!;
  assert.deepEqual([r.id, r.kind, r.step_id, r.origin, r.status, r.decided_by], ['N1', 'parallel_branches', 'S2', 'analyst', 'confirmed', 'Аналітикиня']);
  assert.notEqual(v2.content_hash, v.content_hash, 'вимога під хешем');
  assert.equal(currentApproval(db, c.id), undefined, 'зміна змісту скасовує погодження');
  assert.equal(verifyVersionIntegrity(db, v.id), true, 'попередня версія незмінна');
  assert.ok(diffVersions(versionContent(v), versionContent(v2), [], [], () => '').some((x) => x.label === 'Нотація' && /одночасно/.test(x.text)));
});

test('D61: перевірки введення вимоги (вид, пояснення, крок, дублікат, джерело) і лише для людини', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const base = { baseVersionId: v.id, kind: 'timer', stepId: 'S1', detail: 'три дні' };
  assert.throws(() => addNotationRequirement(db, agentActor, c.id, base), (e: any) => e.code === 'FORBIDDEN');
  assert.throws(() => addNotationRequirement(db, human, c.id, { ...base, kind: 'магія' }), (e: any) => e.code === 'VALIDATION');
  assert.throws(() => addNotationRequirement(db, human, c.id, { ...base, detail: '  ' }), (e: any) => e.code === 'VALIDATION');
  assert.throws(() => addNotationRequirement(db, human, c.id, { ...base, stepId: 'S99' }), (e: any) => e.code === 'VALIDATION');
  assert.throws(() => addNotationRequirement(db, human, c.id, { ...base, evidenceQuote: 'щось' }), (e: any) => e.code === 'VALIDATION', 'цитата без джерела');
  assert.throws(() => addNotationRequirement(db, human, c.id, { ...base, evidenceSourceId: 'src_чужий' }), (e: any) => e.code === 'VALIDATION');
  const ok = addNotationRequirement(db, human, c.id, base);
  assert.throws(() => addNotationRequirement(db, human, c.id, { ...base, baseVersionId: ok.id }), (e: any) => e.code === 'DUPLICATE_REQUIREMENT');
  assert.throws(() => addNotationRequirement(db, human, c.id, base), (e: any) => e.code === 'VERSION_CONFLICT', 'стара основа');
  // інший вид для того самого кроку — окрема вимога
  const second = addNotationRequirement(db, human, c.id, { ...base, baseVersionId: ok.id, kind: 'message' });
  assert.deepEqual(versionContent(second).notation_requirements!.map((x) => x.id), ['N1', 'N2']);
});

test('D61: людина може прибрати вимогу (нова версія, стара з вимогою лишається в історії) і підтвердити/відхилити пропозицію', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const v1 = addNotationRequirement(db, human, c.id, { baseVersionId: v.id, kind: 'timer', stepId: 'S1', detail: 'три дні' });
  const v2 = removeNotationRequirement(db, human, c.id, { baseVersionId: v1.id, requirementId: 'N1' });
  assert.equal(versionContent(v2).notation_requirements, undefined);
  assert.equal(versionContent(getVersion(db, v1.id)).notation_requirements!.length, 1, 'історія збережена');
  assert.throws(() => removeNotationRequirement(db, human, c.id, { baseVersionId: v2.id, requirementId: 'N1' }), (e: any) => e.code === 'NOT_FOUND');
  assert.throws(() => removeNotationRequirement(db, agentActor, c.id, { baseVersionId: v2.id, requirementId: 'N1' }), (e: any) => e.code === 'FORBIDDEN');
  assert.throws(() => decideNotationRequirement(db, human, c.id, { baseVersionId: v2.id, requirementId: 'N1', decision: 'confirm' }), (e: any) => e.code === 'NOT_FOUND');
});

// ───────────────────────── D61: агент пропонує, людина вирішує ─────────────────────────

const SRC_QUOTE = 'Оператор вносить зміну';

function proposal(i: AnalystInput, over: Partial<NotationRequirementT> = {}): NotationRequirementT {
  return { id: 'N1', kind: 'timer', step_id: 'S2', detail: 'зміна вноситься після очікування', origin: 'agent', status: 'proposed', evidence_source_id: i.sources[0]!.id, evidence_quote: SRC_QUOTE, decided_by: '', decision_note: '', ...over };
}

async function agentRun(db: ReturnType<typeof freshDb>, caseId: string, edit: (c: Content, i: AnalystInput) => void) {
  const client = new ScriptedDemoClient((i) => { const c = structuredClone(i.head_content) as Content; edit(c, i); return c; });
  return runAnalyst(db, caseId, client, { instruction: loadInstruction(), maxAttempts: 1 });
}

test('D61: пропозиція агента зберігається як «proposed» з цитатою, НЕ стає фактом, блокує передачу й погодження; unsupported від неї не виникає', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  const res = await agentRun(db, c.id, (cc, i) => { cc.notation_requirements = [proposal(i)]; });
  assert.ok(res.ok, res.ok ? '' : res.error);
  const head = headVersion(db, c.id);
  const r = versionContent(head).notation_requirements![0]!;
  assert.deepEqual([r.origin, r.status, r.decided_by, r.decision_note], ['agent', 'proposed', '', '']);
  assert.ok(r.evidence_quote === SRC_QUOTE && r.evidence_source_id.length > 0);
  // не встановлений факт: блокує, але не unsupported
  assert.ok(submissionBlockers(db, c.id).some((b) => b.code === 'PENDING_NOTATION_PROPOSAL' && b.severity === 'critical'));
  const card = buildCard(db, c.id, 'demo');
  assert.ok(card.gaps.some((g) => g.code === 'PENDING_NOTATION_PROPOSAL'), 'видно як критична прогалина');
  assert.equal(card.notation_requirements[0]!.evidence_check, 'quote_found');
  acceptDraft(db, human, c.id, head.id);
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED' && e.details.blockers.some((b: any) => b.code === 'PENDING_NOTATION_PROPOSAL'));
  const pkg = { versionId: head.id, contentHash: head.content_hash, content: versionContent(head), origin: 'product' as const };
  const gen = await generateBpmn(pkg);
  assert.equal(gen.status, 'blocked', 'не unsupported: вимога ще не встановлена');
});

test('D61: людина підтверджує пропозицію → встановлена вимога → генератор дає unsupported БЕЗ моделі, погодження AS-IS лишається чинним', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  assert.ok((await agentRun(db, c.id, (cc, i) => { cc.notation_requirements = [proposal(i, { kind: 'parallel_branches' })]; })).ok);
  let head = headVersion(db, c.id);
  const decided = decideNotationRequirement(db, human, c.id, { baseVersionId: head.id, requirementId: 'N1', decision: 'confirm', note: 'так, у джерелі саме це' });
  const r = versionContent(decided).notation_requirements![0]!;
  assert.deepEqual([r.status, r.origin, r.decided_by, r.decision_note], ['confirmed', 'agent', 'Аналітикиня', 'так, у джерелі саме це']);
  assert.throws(() => decideNotationRequirement(db, human, c.id, { baseVersionId: decided.id, requirementId: 'N1', decision: 'reject' }), (e: any) => e.code === 'REQUIREMENT_NOT_PENDING');
  acceptDraft(db, human, c.id, decided.id);
  submitForApproval(db, human, c.id);
  const a = approve(db, human, c.id, { versionId: decided.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, c.id).ok, true, 'дозвіл є: це обмеження інструмента, а не помилка опису (D21)');
  const before = JSON.stringify([one(db, 'SELECT * FROM approval WHERE id = ?', a.id), all(db, 'SELECT id, content_hash FROM as_is_version')]);
  const gen = await generateBpmn(packageFromApproval(db, c.id));
  assert.equal(gen.status, 'unsupported');
  if (gen.status === 'unsupported') {
    assert.deepEqual(gen.findings.map((f) => f.code), ['UNSUPPORTED_PARALLEL_BRANCHES']);
    assert.ok(gen.findings[0]!.message.includes(SRC_QUOTE), 'у поясненні — цитата з джерела');
    assert.equal('bpmn' in gen, false);
  }
  assert.equal(JSON.stringify([one(db, 'SELECT * FROM approval WHERE id = ?', a.id), all(db, 'SELECT id, content_hash FROM as_is_version')]), before, 'погодження й версії не змінились');
  assert.equal(currentApproval(db, c.id)!.id, a.id);
  assert.equal(getCase(db, c.id).state, 'approved');
  head = headVersion(db, c.id);
  assert.equal(verifyVersionIntegrity(db, head.id), true);
});

test('D61: відхилена пропозиція не блокує й не дає unsupported; повтор того самого доказу відхиляється перевіркою відповіді агента', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  assert.ok((await agentRun(db, c.id, (cc, i) => { cc.notation_requirements = [proposal(i)]; })).ok);
  const rej = decideNotationRequirement(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, requirementId: 'N1', decision: 'reject' });
  assert.equal(versionContent(rej).notation_requirements![0]!.status, 'rejected');
  assert.ok(!submissionBlockers(db, c.id).some((b) => b.code === 'PENDING_NOTATION_PROPOSAL'));
  // повтор без нового доказу — порушення; з новою цитатою — дозволено
  const again = await agentRun(db, c.id, (cc, i) => { cc.notation_requirements = [...(cc.notation_requirements ?? []), proposal(i, { id: 'N2' })]; });
  assert.equal(again.ok, false);
  assert.ok(!again.ok && /REPEAT_WITHOUT_NEW_EVIDENCE/.test(again.error + JSON.stringify(one(db, 'SELECT violations_json FROM run ORDER BY started_at DESC LIMIT 1')) ));
  const fresh = await agentRun(db, c.id, (cc, i) => { cc.notation_requirements = [...(cc.notation_requirements ?? []), proposal(i, { id: 'N2', evidence_quote: 'Менеджер приймає запит' })]; });
  assert.ok(fresh.ok, fresh.ok ? '' : fresh.error);
});

// ───────────────────────── D61: агент не змінює й не підтверджує ─────────────────────────

function verifyCtx(base: Content, sourceText = 'Менеджер приймає запит. Оператор вносить зміну.') {
  return { base, sources: [{ id: 'SRC-01', text: sourceText }], fromModel: (c: Content) => c };
}
function baseContent(): Content {
  const c = emptyContent();
  c.steps = [{ id: 'S1', role: 'Менеджер', action: 'Приймає запит', entry_condition: '', input_artifact: '', result: 'Заявка', next: [{ to: 'S2', condition: '' }], source_ids: ['SRC-01'] },
    { id: 'S2', role: 'Оператор', action: 'Вносить зміну', entry_condition: '', input_artifact: '', result: 'Готово', next: [{ to: 'END', condition: '' }], source_ids: ['SRC-01'] }];
  c.roles = ['Менеджер', 'Оператор'];
  return c;
}
const req = (over: Partial<NotationRequirementT> = {}): NotationRequirementT => ({
  id: 'N1', kind: 'timer', step_id: 'S2', detail: 'очікування', origin: 'agent', status: 'proposed', evidence_source_id: 'SRC-01', evidence_quote: SRC_QUOTE, decided_by: '', decision_note: '', ...over,
});
const codes = (r: ReturnType<typeof verifyAgentOutput>): string[] => (r.ok ? [] : r.violations.map((x) => x.code));

test('D61 перевірка відповіді агента: коректна пропозиція проходить; рішення, відсутні докази, вигадана цитата, хибний крок, дублікати — порушення', () => {
  const b = baseContent();
  const ok = verifyAgentOutput({ ...b, notation_requirements: [req()] }, verifyCtx(b));
  assert.equal(ok.ok, true);
  const bad = (r: NotationRequirementT[], extra?: Content) => codes(verifyAgentOutput({ ...(extra ?? b), notation_requirements: r }, verifyCtx(extra ?? b)));
  assert.ok(bad([req({ status: 'confirmed' })]).includes('AGENT_CANNOT_DECIDE'), 'агент не підтверджує');
  assert.ok(bad([req({ status: 'rejected' })]).includes('AGENT_CANNOT_DECIDE'));
  assert.ok(bad([req({ decided_by: 'Аналітикиня' })]).includes('AGENT_CANNOT_DECIDE'), 'не підписується іменем людини');
  assert.ok(bad([req({ decision_note: 'ок' })]).includes('AGENT_CANNOT_DECIDE'));
  assert.ok(bad([req({ evidence_quote: '', evidence_source_id: '' })]).includes('NOTATION_NO_EVIDENCE'));
  assert.ok(bad([req({ evidence_quote: 'цього в джерелі немає' })]).includes('QUOTE_NOT_FOUND'), 'вигадана цитата');
  assert.ok(bad([req({ evidence_source_id: 'SRC-77' })]).includes('UNKNOWN_SOURCE'));
  assert.ok(bad([req({ step_id: 'S99' })]).includes('NOTATION_BAD_STEP'));
  assert.ok(bad([req({ detail: ' ' })]).includes('NOTATION_NO_DETAIL'));
  assert.ok(bad([req(), req({ id: 'N2' })]).includes('DUPLICATE_REQUIREMENT'), 'одна вимога на пару крок+вид');
  assert.ok(bad([req(), req()]).includes('DUPLICATE_ID'));
  // вид за межами переліку відхиляє схема
  assert.ok(codes(verifyAgentOutput({ ...b, notation_requirements: [{ ...req(), kind: 'магія' }] }, verifyCtx(b))).includes('SCHEMA'));
  // нова вимога, що збігається з підтвердженою наявною, — дублікат
  const withConfirmed = { ...b, notation_requirements: [req({ origin: 'analyst', status: 'confirmed', decided_by: 'Аналітикиня' })] };
  assert.ok(bad([withConfirmed.notation_requirements[0]!, req({ id: 'N2' })], withConfirmed).includes('DUPLICATE_REQUIREMENT'));
});

test('D61 захист: агент не може змінити, підтвердити чи видалити наявну вимогу; нові пропозиції нормалізуються до «proposed»; усе записується як конфлікт', () => {
  const base = { ...baseContent(), notation_requirements: [req({ id: 'N1', origin: 'analyst', status: 'confirmed', decided_by: 'Аналітикиня', decision_note: 'ок' }), req({ id: 'N2', kind: 'message', status: 'proposed' })] };
  // зміна підтвердженої, підтвердження пропозиції, спроба «підписати» нову, видалення
  const out = structuredClone(base);
  out.notation_requirements![0]!.detail = 'агент переписав';
  out.notation_requirements![1]!.status = 'confirmed';
  out.notation_requirements!.push(req({ id: 'N3', kind: 'subprocess', status: 'confirmed', decided_by: 'Аналітикиня', origin: 'analyst' }));
  const r1 = protectAnalystEdits(base, out, new Set(), new Set());
  assert.equal(r1.content.notation_requirements![0]!.detail, 'очікування', 'підтверджена вимога збережена');
  assert.equal(r1.content.notation_requirements![1]!.status, 'proposed', 'пропозиція не підтверджена агентом');
  const n3 = r1.content.notation_requirements!.find((x) => x.id === 'N3')!;
  assert.deepEqual([n3.origin, n3.status, n3.decided_by], ['agent', 'proposed', ''], 'нова нормалізована до пропозиції агента');
  assert.ok(r1.conflicts.filter((c) => c.key.startsWith('notation:')).length >= 3);
  const out2 = structuredClone(base);
  delete (out2 as Content).notation_requirements;
  const r2 = protectAnalystEdits(base, out2, new Set(), new Set());
  assert.deepEqual(r2.content.notation_requirements!.map((x) => x.id), ['N1', 'N2'], 'видалення відновлено');
  assert.ok(r2.conflicts.some((c) => c.key === 'notation:N1' && /прибрати/.test(c.note)));
});

test('D61 захист наскрізь (запуск агента): підтверджену вимогу, назву процесу агент змінити не може; запис про конфлікт лишається', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const v1 = addNotationRequirement(db, human, c.id, { baseVersionId: v.id, kind: 'subprocess', stepId: 'S1', detail: 'окремий підпроцес' });
  acceptDraft(db, human, c.id, v1.id);
  const res = await agentRun(db, c.id, (cc) => {
    cc.process_name = 'Агентова назва';
    cc.notation_requirements![0]!.kind = 'timer';
    cc.notation_requirements![0]!.detail = 'агент переписав';
  });
  assert.ok(res.ok, res.ok ? '' : res.error);
  const head = versionContent(headVersion(db, c.id));
  assert.equal(head.process_name, COMPLETE_FIELDS.process_name, 'назву процесу задає лише людина');
  const n = head.notation_requirements![0]!;
  assert.deepEqual([n.kind, n.detail, n.status, n.origin], ['subprocess', 'окремий підпроцес', 'confirmed', 'analyst']);
  assert.ok(head.conflicts.some((x) => x.key === 'process_name'));
  assert.ok(head.conflicts.some((x) => x.key === 'notation:N1'));
  // сама спроба змінити назву — попередження перевірки відповіді (видно в журналі запуску)
  const checks = JSON.parse(one<{ checks_json: string }>(db, 'SELECT checks_json FROM run ORDER BY started_at DESC LIMIT 1')!.checks_json) as { warnings: string[] };
  assert.ok(checks.warnings.some((w) => /назву процесу/.test(w)));
});

test('D61: агент не може підтвердити пропозицію через запуск (рішення «confirmed» → відповідь відхилено, нічого не збережено)', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  const before = headVersion(db, c.id).id;
  const res = await agentRun(db, c.id, (cc, i) => { cc.notation_requirements = [proposal(i, { status: 'confirmed', decided_by: 'Аналітикиня' })]; });
  assert.equal(res.ok, false);
  assert.equal(headVersion(db, c.id).id, before, 'версія не змінилась');
  assert.equal(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', c.id).length, 2);
});

test('D61: інструкція агента v0.8 містить правила пропозиції (цитата, лише proposed, «не зазначено»), заборону чіпати назву процесу, без службових приміток', () => {
  const i = loadInstruction();
  assert.equal(i.version, 'analyst-v0.9');
  for (const needle of ['notation_requirements', 'status: "proposed"', 'Ніколи не став `confirmed`', 'не зазначено', 'process_name', 'назву кейсу не вживай']) {
    assert.ok(i.text.includes(needle), `інструкція не містить «${needle}»`);
  }
  assert.ok(!i.text.includes('Службові примітки'));
});

// ───────────────────────── блокування без обходу ─────────────────────────

function forceApproved(db: ReturnType<typeof freshDb>, caseId: string, versionId: string): string {
  const v = one<{ content_hash: string }>(db, 'SELECT content_hash FROM as_is_version WHERE id = ?', versionId)!;
  run(db, 'UPDATE "case" SET state = ? WHERE id = ?', 'approved', caseId);
  const id = 'appr_forced_' + Math.random().toString(36).slice(2, 8);
  run(db, 'INSERT INTO approval (id, case_id, version_id, content_hash, approver, note, created_at) VALUES (?,?,?,?,?,?,?)',
    id, caseId, versionId, v.content_hash, 'test', '', new Date().toISOString());
  return id;
}

/** «Старий» погоджений запис: версія без назви процесу й вимог (як до D61/D62) і чинне погодження на неї. */
function legacyApproved(db: ReturnType<typeof freshDb>) {
  const { c, v } = draftReadyCase(db);
  const content = structuredClone(versionContent(v));
  delete content.process_name;
  const leg = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: 'А', parentId: v.id, covered: JSON.parse(v.covered_json), owned: [], note: 'імітація старого запису' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', leg.id, c.id);
  acceptDraft(db, human, c.id, leg.id);
  const approvalId = forceApproved(db, c.id, leg.id);
  return { c, leg, approvalId };
}

test('D61 без обходу: непідтверджена пропозиція блокує передачу, погодження і серверний дозвіл BPMN (захист у глибину)', async () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const content = versionContent(v);
  content.notation_requirements = [req({ evidence_source_id: '' })];
  const v2 = insertVersion(db, { caseId: c.id, content, createdBy: 'agent', actorName: 'agent', parentId: v.id, covered: JSON.parse(v.covered_json), owned: [], note: 'пропозиція' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v2.id, c.id);
  acceptDraft(db, human, c.id, v2.id);
  // 1) передача
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED');
  // 2) погодження (обхід: кейс примусово «На погодженні»)
  run(db, 'UPDATE "case" SET state = ? WHERE id = ?', 'pending_approval', c.id);
  assert.throws(() => approve(db, human, c.id, { versionId: v2.id, checklistConfirmed: true }), (e: any) => e.code === 'GUARD_FAILED' && e.details.blockers.some((b: any) => b.code === 'PENDING_NOTATION_PROPOSAL'));
  assert.equal(currentApproval(db, c.id), undefined);
  // 3) серверний дозвіл (обхід: погодження записано напряму)
  forceApproved(db, c.id, v2.id);
  const g = bpmnGuard(db, c.id);
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some((r) => r.code === 'PENDING_NOTATION_PROPOSAL'));
  assert.throws(() => packageFromApproval(db, c.id), (e: any) => e.code === 'GUARD_FAILED');
});

test('D61 без обходу: вимога до неіснуючого кроку (наприклад, крок вилучено) блокує погодження й дозвіл; відхилена — ні', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const content = versionContent(v);
  content.notation_requirements = [req({ id: 'N1', origin: 'analyst', status: 'confirmed', decided_by: 'А', step_id: 'S77', evidence_source_id: '', evidence_quote: '' })];
  const v2 = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: 'А', parentId: v.id, covered: JSON.parse(v.covered_json), owned: [], note: 'x' });
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v2.id, c.id);
  acceptDraft(db, human, c.id, v2.id);
  assert.throws(() => submitForApproval(db, human, c.id), (e: any) => e.code === 'GUARD_FAILED' && e.details.blockers.some((b: any) => b.code === 'NOTATION_BAD_STEP'));
  forceApproved(db, c.id, v2.id);
  assert.ok(bpmnGuard(db, c.id).reasons.some((r) => r.code === 'NOTATION_BAD_STEP'));
  const db2 = freshDb();
  const d2 = draftReadyCase(db2);
  const cc = versionContent(d2.v);
  cc.notation_requirements = [req({ id: 'N1', status: 'rejected', step_id: 'S77' })];
  const w = insertVersion(db2, { caseId: d2.c.id, content: cc, createdBy: 'analyst', actorName: 'А', parentId: d2.v.id, covered: JSON.parse(d2.v.covered_json), owned: [], note: 'x' });
  run(db2, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', w.id, d2.c.id);
  assert.ok(!submissionBlockers(db2, d2.c.id).some((b) => b.code === 'NOTATION_BAD_STEP'));
});

test('D61/D62 без обходу через API: усі дії лише для людини з сесією та захистом від підробки; агент не має маршруту рішень; старі версії перевіряються 409', async () => {
  const db = freshDb();
  const s = await startTestServer(db);
  try {
    const c = (await s.call('POST', '/api/cases', { title: 'Мітка кейсу' })).body.case;
    await s.call('POST', `/api/cases/${c.id}/sources`, { kind: 'request', title: 'Запит', content: 'Оператор вносить зміну', origin: 'synthetic' });
    let card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    const v1 = await s.call('POST', `/api/cases/${c.id}/versions`, { base_version_id: card.head.id, cover_all_sources: true, fields: { ...COMPLETE_FIELDS, process_name: '  Процес з API  ' } });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.deepEqual(card.process_name, { value: 'Процес з API', defined: true });
    assert.equal(card.case.title, 'Мітка кейсу', 'назва кейсу окремо');
    const paths = ['notation/add', 'notation/decide', 'notation/remove'];
    for (const p of paths) {
      assert.equal((await s.call('POST', `/api/cases/${c.id}/${p}`, {}, { auth: false })).status, 401, `${p}: без сесії`);
    }
    const noHeader = await fetch(`${s.base}/api/cases/${c.id}/notation/add`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `cx_session=${(await import('../src/server.ts')).sessionToken('test-code')}` }, body: '{}' });
    assert.equal(noHeader.status, 403, 'без захисту від підробки запитів');
    const add = await s.call('POST', `/api/cases/${c.id}/notation/add`, { base_version_id: card.head.id, kind: 'timer', step_id: 'S2', detail: 'три дні' });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal((await s.call('POST', `/api/cases/${c.id}/notation/add`, { base_version_id: card.head.id, kind: 'timer', step_id: 'S2', detail: 'три дні' })).body.error.code, 'VERSION_CONFLICT');
    card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.equal(card.notation_requirements[0].status, 'confirmed');
    assert.equal(card.notation_requirements[0].kind_label, 'таймер / очікування за часом');
    assert.equal((await s.call('POST', `/api/cases/${c.id}/notation/add`, { base_version_id: card.head.id, kind: 'x', step_id: 'S2', detail: 'д' })).status, 400);
    assert.equal((await s.call('POST', `/api/cases/${c.id}/notation/decide`, { base_version_id: card.head.id, requirement_id: 'N1', decision: 'maybe' })).status, 400);
    assert.equal((await s.call('POST', `/api/cases/${c.id}/notation/decide`, { base_version_id: card.head.id, requirement_id: 'N1', decision: 'reject' })).body.error.code, 'REQUIREMENT_NOT_PENDING');
    assert.equal((await s.call('POST', `/api/cases/${c.id}/notation/remove`, { base_version_id: card.head.id, requirement_id: 'N1' })).status, 201);
    // у джерелі коду сервера агент не має маршруту рішення: рішення лише через сесію людини
    const serverSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
    assert.ok(/notation\/decide[\s\S]{0,200}decideNotationRequirement\(db, human,/.test(serverSrc), 'рішення виконується від імені людини');
  } finally { await s.close(); }
});

test('D62: старі версії — за API: картка старого запису показує «не зазначено», дозвіл BPMN заблоковано з поясненням', async () => {
  const db = freshDb();
  const { c } = legacyApproved(db);
  const s = await startTestServer(db);
  try {
    const card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.equal(card.process_name.defined, false);
    assert.equal(card.next_action.key, 'clarify_process_name');
    const start = await s.call('POST', `/api/cases/${c.id}/bpmn/start`, {});
    assert.equal(start.status, 409);
    assert.ok(start.body.error.details.reasons.some((r: any) => r.code === 'PROCESS_NAME_MISSING'));
  } finally { await s.close(); }
});
