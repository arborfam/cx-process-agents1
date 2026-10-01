/**
 * «Невідоме не стає фактом»: перехід, про який є відкрите питання, не може бути поданий як встановлений.
 * Також: змістовний огляд змін, окремі прогалини та статус перевірки чернетки.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/db.ts';
import {
  acceptDraft, addQuestion, answerQuestion, approve, bpmnGuard, buildCard, delta, getCase, headVersion, insertVersion,
  requestBpmnStart, saveAnalystVersion, setQuestionCritical, submissionBlockers, submitForApproval, versionContent,
} from '../src/domain.ts';
import { seedDemoCase } from '../src/demo.ts';
import { runAnalyst, ScriptedDemoClient } from '../src/runs.ts';
import { UNKNOWN } from '../src/schema.ts';
import { parseNext, parseSteps, stepsToText } from '../src/text-format.ts';
import { COMPLETE_FIELDS, draftReadyCase, freshDb, human } from './helpers.ts';

const S5_UNKNOWN = 'S5 | Керівник відділу | Вирішує, погодити чи відхилити виняток | Рішення щодо винятку | S4 (погоджено); ? (відхилено)';
const S5_END = S5_UNKNOWN.replace('? (відхилено)', 'END (відхилено)');

function seeded() {
  const db = freshDb();
  const id = seedDemoCase(db, 'demo');
  return { db, id, card: () => buildCard(db, id, 'demo') };
}

test('Демо: перехід S5 «відхилено» — НЕВІДОМО з посиланням на Q1; не встановлений END', () => {
  const { card } = seeded();
  const c = card();
  const s5 = c.head.content.steps.find((s) => s.id === 'S5')!;
  assert.equal(s5.next.find((n) => n.condition === 'відхилено')!.to, UNKNOWN);
  assert.ok(!c.head.content.steps.some((s) => s.next.some((n) => n.to === 'END' && s.id === 'S5')), 'у S5 немає встановленого END');
  assert.deepEqual(c.unknown_transitions.map((u) => [u.step_id, u.condition, u.question_ids]), [['S5', 'відхилено', ['Q1']]]);
  const codes = c.gaps.map((g) => `${g.code}:${g.ref}`);
  assert.ok(codes.includes('CRITICAL_QUESTION:Q1'), codes.join());
  assert.ok(codes.includes('UNRESOLVED_TRANSITION:S5'), codes.join());
  assert.match(c.gaps.find((g) => g.code === 'UNRESOLVED_TRANSITION')!.message, /Q1/);
  assert.match(c.editable.steps_text, /\? \(відхилено\)/);
});

test('Спроба подати невідоме як факт (S5 → END при відкритому Q1) — суперечність; передача й погодження блокуються', () => {
  const { db, id, card } = seeded();
  const c0 = card();
  const v = saveAnalystVersion(db, human, id, {
    baseVersionId: c0.head.id, fields: { steps_text: c0.editable.steps_text.replace(S5_UNKNOWN, S5_END) }, coverAllSources: true,
  });
  const b = submissionBlockers(db, id);
  const contradiction = b.find((x) => x.code === 'CONTRADICTION');
  assert.ok(contradiction, 'суперечність виявлена: ' + b.map((x) => x.code).join());
  assert.equal(contradiction!.severity, 'critical');
  assert.equal(contradiction!.ref, 'Q1');
  assert.match(contradiction!.message, /S5/);
  assert.match(contradiction!.message, /Невідоме не можна записувати як факт/);
  assert.ok(card().gaps.some((g) => g.code === 'CONTRADICTION'));
  acceptDraft(db, human, id, v.id);
  assert.throws(() => submitForApproval(db, human, id), (e: any) => e.code === 'GUARD_FAILED' && e.details.blockers.some((x: any) => x.code === 'CONTRADICTION'));
  assert.equal(getCase(db, id).state, 'research');
});

test('Зробити Q1 «некритичним» не прибирає прогалину: невизначений перехід усе одно блокує', () => {
  const { db, id, card } = seeded();
  setQuestionCritical(db, human, id, { baseVersionId: card().head.id, questionId: 'Q1', critical: false, note: 'Спроба обійти' });
  const c = card();
  assert.equal(c.critical_open_questions.length, 0);
  assert.ok(c.gaps.some((g) => g.code === 'UNRESOLVED_TRANSITION' && g.ref === 'S5'));
  assert.equal(c.review.checks.find((x) => x.key === 'gaps')!.status, 'fail');
});

test('Агент не може перетворити «невідомо» на встановлений перехід, доки питання відкрите', async () => {
  const { db, id, card } = seeded();
  const base = card().head.content;
  const out = structuredClone(base);
  out.steps.find((s) => s.id === 'S5')!.next.find((n) => n.condition === 'відхилено')!.to = 'END';
  const res = await runAnalyst(db, id, new ScriptedDemoClient(() => out));
  assert.ok(res.ok);
  const content = versionContent(headVersion(db, id));
  assert.equal(content.steps.find((s) => s.id === 'S5')!.next.find((n) => n.condition === 'відхилено')!.to, UNKNOWN);
  const cf = content.conflicts.find((x) => x.key.startsWith('transition:S5'));
  assert.ok(cf, 'конфлікт записано');
  assert.equal(cf!.proposed, 'END');
  assert.equal(cf!.kept, 'невідомо');
});

test('Після уточнення перехід лишається «невідомо», доки крок не оновлено; далі прогалин немає', () => {
  const { db, id, card } = seeded();
  const v3 = answerQuestion(db, human, id, { baseVersionId: card().head.id, questionId: 'Q1', answer: 'Керівник повідомляє клієнта листом.' });
  const b = submissionBlockers(db, id);
  assert.ok(b.some((x) => x.code === 'UNKNOWN_QUESTION_CLOSED' && x.ref === 'S5'));
  assert.ok(!b.some((x) => x.code === 'CRITICAL_QUESTION'));
  assert.ok(card().gaps.some((g) => g.code === 'UNKNOWN_QUESTION_CLOSED'));
  saveAnalystVersion(db, human, id, {
    baseVersionId: v3.id,
    fields: { steps_text: card().editable.steps_text.replace(S5_UNKNOWN, S5_UNKNOWN.replace('? (відхилено)', 'S6 (відхилено)')) +
      '\nS6 | Керівник відділу | Повідомляє клієнта листом | Клієнта поінформовано | END' },
  });
  assert.deepEqual(card().gaps, []);
});

test('Питання про перехід у повному описі робить цей перехід невідомим; хибне посилання відхиляється', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  assert.throws(() => addQuestion(db, human, c.id, { baseVersionId: v.id, text: 'Q?', critical: false, impact: '', affects: [{ step_id: 'S9', condition: '' }] }),
    (e: any) => e.code === 'VALIDATION');
  const v3 = addQuestion(db, human, c.id, { baseVersionId: v.id, text: 'Що буде після S2?', critical: false, impact: 'Завершення', affects: [{ step_id: 'S2', condition: '' }] });
  const s2 = versionContent(v3).steps.find((s) => s.id === 'S2')!;
  assert.equal(s2.next[0]!.to, UNKNOWN, 'END замінено на невідомо');
  assert.ok(submissionBlockers(db, c.id).some((b) => b.code === 'UNRESOLVED_TRANSITION' && b.ref === 'S2'));
});

test('«?» без питання і перехід із порушеним зв’язком — критичні блокери', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const v3 = saveAnalystVersion(db, human, c.id, { baseVersionId: v.id,
    fields: { steps_text: COMPLETE_FIELDS.steps_text!.replace('Умови оновлено | END', 'Умови оновлено | ?') } });
  assert.ok(submissionBlockers(db, c.id).some((b) => b.code === 'UNKNOWN_WITHOUT_QUESTION' && b.ref === 'S2'));
  // із питанням, але змінивши умову переходу, зв’язок губиться
  const s = seeded();
  const cur = s.card();
  saveAnalystVersion(s.db, human, s.id, { baseVersionId: cur.head.id,
    fields: { steps_text: cur.editable.steps_text.replace('? (відхилено)', '? (відхилено керівником)') } });
  const codes = submissionBlockers(s.db, s.id).map((b) => b.code);
  assert.ok(codes.includes('QUESTION_LINK_BROKEN'), codes.join());
  assert.ok(codes.includes('UNKNOWN_WITHOUT_QUESTION'), codes.join());
  void v3;
});

test('Захист у глибину: погоджена версія з невідомим переходом не дає запустити BPMN', () => {
  const db = freshDb();
  const { c, v } = draftReadyCase(db);
  const content = versionContent(v);
  content.steps[1]!.next = [{ to: UNKNOWN, condition: '' }];
  const bad = insertVersion(db, { caseId: c.id, content, createdBy: 'analyst', actorName: 'x', parentId: v.id, covered: JSON.parse(v.covered_json), owned: [] });
  // обхід прикладного шару: пряме записування погодження й стану
  run(db, 'UPDATE "case" SET head_version_id = ?, state = ? WHERE id = ?', bad.id, 'approved', c.id);
  run(db, 'INSERT INTO approval (id, case_id, version_id, content_hash, approver, note, created_at) VALUES (?,?,?,?,?,?,?)',
    'appr_forced', c.id, bad.id, bad.content_hash, 'test', '', new Date().toISOString());
  const g = bpmnGuard(db, c.id);
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some((r) => r.code === 'UNKNOWN_WITHOUT_QUESTION'), JSON.stringify(g.reasons));
  assert.throws(() => requestBpmnStart(db, human, c.id, 'demo'), (e: any) => e.code === 'GUARD_FAILED');
});

// ───────── змістовний огляд змін ─────────
test('Огляд змін показує зміст (було → стало), а не лише назву поля', () => {
  const { db, id, card } = seeded();
  const v3 = answerQuestion(db, human, id, { baseVersionId: card().head.id, questionId: 'Q1', answer: 'Керівник повідомляє клієнта листом.' });
  let texts = card().changes.map((x) => x.text);
  assert.ok(texts.some((t) => t.startsWith('Закрито Q1') && t.includes('Керівник повідомляє клієнта листом.')), texts.join('\n'));
  assert.ok(texts.some((t) => t.startsWith('Враховано нове джерело')));

  saveAnalystVersion(db, human, id, {
    baseVersionId: v3.id,
    fields: {
      summary: card().head.content.summary.replace('поки невідомо', 'керівник повідомляє клієнта листом'),
      steps_text: card().editable.steps_text.replace(S5_UNKNOWN, S5_UNKNOWN.replace('? (відхилено)', 'S6 (відхилено)')) +
        '\nS6 | Керівник відділу | Повідомляє клієнта листом | Клієнта поінформовано | END',
    },
  });
  const items = card().changes;
  texts = items.map((x) => x.text);
  assert.ok(texts.some((t) => t.startsWith('S5:') && t.includes('перехід «відхилено»: НЕВІДОМО (питання Q1) → крок S6')), texts.join('\n'));
  assert.ok(texts.some((t) => t.startsWith('Додано S6 (Керівник відділу)') && t.includes('Повідомляє клієнта листом')));
  const summary = items.find((x) => x.label === 'Суть')!;
  assert.match(summary.text, /було «/);
  assert.match(summary.text, /поки невідомо/);
  assert.match(summary.text, /керівник повідомляє клієнта листом/);
  assert.ok(items.every((x) => x.label && x.text.length > 12), 'жодної голої назви поля');
  assert.ok(!texts.some((t) => /^Змінено (суть|межу)/.test(t)));
});

test('delta: короткий змінений фрагмент із контекстом для довгих текстів; повні значення для коротких', () => {
  assert.equal(delta('a', 'a'), '');
  assert.equal(delta('', 'нове'), 'додано «нове»');
  assert.equal(delta('старе', ''), 'видалено «старе»');
  assert.equal(delta('дія 1', 'дія 2'), 'було «дія 1», стало «дія 2»');
  const long = 'Х '.repeat(60);
  const d = delta(long + 'кінець А', long + 'кінець Б');
  assert.match(d, /було «…/);
  assert.ok(d.length < 160, d);
});

// ───────── окремі прогалини та статус перевірки чернетки ─────────
test('Прогалини й статус чернетки — окремі блоки; готовність з’являється лише після усунення усього', () => {
  const { db, id, card } = seeded();
  const c0 = card();
  assert.ok(c0.gaps.length >= 2);
  assert.ok(c0.gaps.every((g) => g.severity === 'critical'));
  assert.ok(!c0.gaps.some((g) => g.code === 'NOT_ACCEPTED'), 'прийняття — не змістова прогалина');
  const keys = c0.review.checks.map((x) => x.key);
  assert.deepEqual(keys, ['accepted', 'sources', 'reading', 'structure', 'gaps', 'integrity', 'process_name', 'notation', 'conflicts']);
  assert.equal(c0.review.ready, false);
  assert.ok(c0.review.checks.every((x) => ['Пройдено', 'Не пройдено', 'Увага'].includes(x.status_text)), 'статуси мають текстові підписи');
  assert.equal(c0.review.checks.find((x) => x.key === 'gaps')!.status, 'fail');
  assert.equal(c0.review.checks.find((x) => x.key === 'accepted')!.status, 'fail');
  assert.equal(c0.review.checks.find((x) => x.key === 'sources')!.detail, '2 з 2');

  const v3 = answerQuestion(db, human, id, { baseVersionId: c0.head.id, questionId: 'Q1', answer: 'Керівник повідомляє клієнта листом.' });
  const v4 = saveAnalystVersion(db, human, id, { baseVersionId: v3.id,
    fields: { steps_text: card().editable.steps_text.replace(S5_UNKNOWN, S5_UNKNOWN.replace('? (відхилено)', 'S6 (відхилено)')) +
      '\nS6 | Керівник відділу | Повідомляє клієнта листом | Клієнта поінформовано | END' } });
  let c = card();
  assert.deepEqual(c.gaps, []);
  assert.equal(c.review.checks.find((x) => x.key === 'gaps')!.status, 'ok');
  assert.equal(c.review.checks.find((x) => x.key === 'accepted')!.status, 'fail');
  assert.equal(c.review.ready, false, 'ще не прийнято аналітиком');
  acceptDraft(db, human, id, v4.id);
  c = card();
  assert.equal(c.review.ready, true);
  assert.match(c.review.ready_text, /готова/);
  submitForApproval(db, human, id);
  approve(db, human, id, { versionId: v4.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, id).ok, true);
});

test('Текстовий формат: «?» і «невідомо» розбираються як невідомий перехід і повертаються назад як «?»', () => {
  assert.deepEqual(parseNext('? (відхилено)'), [{ to: UNKNOWN, condition: 'відхилено' }]);
  assert.deepEqual(parseNext('невідомо'), [{ to: UNKNOWN, condition: '' }]);
  const steps = parseSteps('S1 | А | дія | рез | S2 (так); ? (ні)\nS2 | А | д | р | END', []);
  assert.equal(steps[0]!.next[1]!.to, UNKNOWN);
  assert.equal(stepsToText(steps).split('\n')[0], 'S1 | А | дія | рез | S2 (так); ? (ні)');
});

test('Прогалини для людини: критичне питання й невизначений перехід — ОДНА прогалина з наслідками для кроків; програмні перевірки лишаються окремо', () => {
  const { db, id, card } = seeded();
  const c = card();
  // програмні перевірки не змінилися: два окремі блокери
  assert.deepEqual(c.gaps.map((g) => g.code).filter((x) => ['CRITICAL_QUESTION', 'UNRESOLVED_TRANSITION'].includes(x)).sort(), ['CRITICAL_QUESTION', 'UNRESOLVED_TRANSITION']);
  // для людини — одна змістовна прогалина
  const items = c.gap_items.filter((g) => g.kind === 'question_with_transitions' || g.kind === 'transition');
  assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.key)));
  const it = items[0]!;
  assert.equal(it.kind, 'question_with_transitions');
  assert.equal(it.question_id, 'Q1');
  assert.match(it.text, /Q1/);
  assert.ok(it.impact.length > 0);
  assert.deepEqual(it.consequences.map((x) => [x.step_id, x.condition]), [['S5', 'відхилено']]);
  assert.match(it.consequences[0]!.text, /невідомо/);
  assert.deepEqual(it.codes.sort(), ['CRITICAL_QUESTION', 'UNRESOLVED_TRANSITION']);

  // якщо питання стало некритичним, невизначений перехід лишається окремою прогалиною
  setQuestionCritical(db, human, id, { baseVersionId: c.head.id, questionId: 'Q1', critical: false, note: 'Спроба обійти' });
  const c2 = card();
  assert.ok(!c2.gap_items.some((g) => g.kind === 'question_with_transitions'));
  const tr = c2.gap_items.find((g) => g.kind === 'transition');
  assert.ok(tr, 'невизначений перехід показано окремо');
  assert.equal(tr!.question_id, 'Q1');
});
