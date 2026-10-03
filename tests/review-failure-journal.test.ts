/**
 * Невдалий запуск агента 2 має лишати по собі ПРИЧИНУ, а не порожній слід.
 *
 * Передісторія: в експорті реального невдалого запуску `checks` було порожнє — з журналу неможливо було
 * зрозуміти, чим завершилась кожна спроба. Тепер зберігаються: повідомлення, порушення останньої спроби
 * й журнал КОЖНОЇ спроби. Сирих відповідей моделі для невдалих запусків не зберігаємо (окреме обмеження власниці).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import { getCaseReview, runBpmnReviewForCase } from '../src/review-runs.ts';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, policyOf, reviewer } from './review-helpers.ts';
import { startTestServer } from './helpers.ts';
import type { BpmnReviewInput } from '../src/ai/bpmn-review.ts';

/** Відповідь із таблицею за СТАРИМ контрактом ID — те, що сталося в платному запуску. */
const OLD_CONTRACT_CSV = [
  'id,label,type,role,next,yes,no,assoc',
  'START,Запит клієнта,start,,S1,,,',
  'S1,Приймає запит,task,Менеджер,S2,,,',
  'S2,Вносить зміну,task,Оператор,END_S2_1,,,',
  'END_S2_1,,end,,,,,',
].join('\n') + '\n';

const badStep = () => (_input: BpmnReviewInput) => ({ output: { findings: [], csv: OLD_CONTRACT_CSV }, usage: { input_tokens: 3000, output_tokens: 800 } });

async function failedRun() {
  const db = freshDb();
  const { c } = approvedCase(db);
  const client = new FakeReviewClient([badStep()]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.equal(r.ok, false, 'такий запуск має завершитись помилкою');
  return { db, caseId: c.id, runId: (r as { runId: string }).runId, client };
}

test('1. Невдалий запуск зберігає журнал КОЖНОЇ спроби з її порушеннями', async () => {
  const { db, runId, client } = await failedRun();
  assert.equal(client.calls, 2, 'дві спроби (друга — після повернення порушень)');
  const row = one<{ checks_json: string; violations_json: string; error: string; technical_state: string }>(
    db, 'SELECT checks_json, violations_json, error, technical_state FROM run WHERE id = ?', runId)!;
  assert.equal(row.technical_state, 'error');
  const checks = JSON.parse(row.checks_json) as { failed_attempts?: { attempt: number; kind: string; violations: { code: string }[] }[] };
  assert.ok(checks.failed_attempts && checks.failed_attempts.length === 2, `журнал має обидві спроби: ${row.checks_json.slice(0, 300)}`);
  for (const a of checks.failed_attempts!) {
    assert.ok(a.violations.length > 0, `спроба ${a.attempt} має порушення`);
    assert.ok(a.violations.some((v) => v.code === 'CSV_START_ID'), `спроба ${a.attempt}: видно справжню причину`);
  }
  const violations = JSON.parse(row.violations_json) as { code: string; message: string }[];
  assert.ok(violations.some((v) => v.code === 'CSV_START_ID'), 'порушення останньої спроби збережені');
  assert.match(violations.find((v) => v.code === 'CSV_START_ID')!.message, /StartEvent_1/);
});

test('2. Сирої відповіді моделі для невдалого запуску не зберігаємо', async () => {
  const { db, runId } = await failedRun();
  assert.equal(all(db, 'SELECT id FROM bpmn_review WHERE run_id = ?', runId).length, 0, 'запису перевірки немає — отже, немає й поля з відповіддю');
  const row = one<{ checks_json: string; violations_json: string }>(db, 'SELECT checks_json, violations_json FROM run WHERE id = ?', runId)!;
  for (const raw of [row.checks_json, row.violations_json]) {
    // Сама таблиця з відповіді моделі не зберігається: ні цілком, ні рядком заголовка, ні підписами з неї.
    assert.ok(!raw.includes('id,label,type,role'), 'таблиця з відповіді моделі в журнал не записується');
    assert.ok(!raw.includes('Запит клієнта'), 'підписів з відповіді моделі в журналі немає');
    // Межа свідома: у поясненні лишаються короткі ID рядків, які прислала модель («START», «END_S2_1»), —
    // без них неможливо сказати, ЩО саме не так. Це не «сира відповідь», а причина відмови.
  }
  assert.ok(row.violations_json.includes('«START»'), 'ID рядка з відповіді названо — інакше причина незрозуміла');
  // Назви кроків у повідомленнях («Приймає запит») походять із ПОГОДЖЕНОГО ОПИСУ, а не з відповіді моделі.
  assert.ok(row.violations_json.includes('Приймає запит'), 'крок опису названо, щоб було видно, чого бракує');
});

test('3. Стан кейсу показує справжню причину, порушення й журнал — і це не «undefined»', async () => {
  const { db, caseId } = await failedRun();
  const r = getCaseReview(db, caseId);
  assert.equal(r.state, 'failed');
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'причина — рядок, а не об’єкт');
  assert.ok((r.violations ?? []).some((v) => v.code === 'CSV_START_ID'), 'порушення доступні');
  assert.equal((r.failedAttempts ?? []).length, 2, 'журнал спроб доступний');
});

test('4. HTTP: стан перевірки віддає причину, порушення й журнал спроб', async () => {
  const { db, caseId } = await failedRun();
  const srv = await startTestServer(db);
  try {
    const res = await srv.call('GET', `/api/cases/${caseId}/bpmn/review`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'failed');
    assert.equal(typeof res.body.error, 'string', 'error у відповіді API — рядок');
    assert.ok(res.body.violations.some((v: { code: string }) => v.code === 'CSV_START_ID'));
    assert.equal(res.body.failed_attempts.length, 2);
    // Технічні обмеження лишаються видимими навіть після невдалого запуску.
    assert.equal(res.body.technical_limits.available, true);
  } finally {
    await srv.close();
  }
});

test('5. Після невдалого запуску роботу можна відновити: нова перевірка з коректною таблицею проходить', async () => {
  const { db, caseId } = await failedRun();
  const { okStep } = await import('./review-helpers.ts');
  const good = new FakeReviewClient([okStep([])]);
  const again = await runBpmnReviewForCase(db, human, caseId, reviewer(good, policyOf()));
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(getCaseReview(db, caseId).state, 'clear');
  assert.ok(getCaseReview(db, caseId).gate!.ok, 'шлюз відкрито');
});
