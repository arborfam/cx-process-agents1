/**
 * Окремий ПРОЦЕС ОС для перевірки справжнього перезапуску (3b-2). Режими:
 *   restore <db> <case>  — «старт застосунку»: recoverStuckRuns + відновлення перевірки з БД. Клієнта моделі в процесі НЕМАЄ,
 *                          мережу заблоковано: будь-який виклик fetch зафіксується й зламає результат.
 *   hang <db> <case>     — починає запуск перевірки; клієнт друкує CALLED і не відповідає (процес вбиває батьківський тест).
 */
import { openDb } from '../src/db.ts';
import { recoverStuckRuns } from '../src/runs.ts';
import { beginBpmnReview, executeBpmnReview, getCaseReview } from '../src/review-runs.ts';
import { human, } from './helpers.ts';
import { FakeReviewClient, reviewer } from './review-helpers.ts';

const [mode, dbPath, caseId] = process.argv.slice(2) as [string, string, string];
let fetchCalls = 0;
globalThis.fetch = (() => { fetchCalls++; throw new Error('мережа заблокована в тесті'); }) as typeof fetch;

const db = openDb(dbPath);
if (mode === 'restore') {
  const recovered = recoverStuckRuns(db);
  const r = getCaseReview(db, caseId);
  process.stdout.write(JSON.stringify({
    pid: process.pid, recovered, state: r.state, gateOk: r.gate?.ok ?? null, gateCode: r.gate && !r.gate.ok ? r.gate.code : null,
    findings: r.findings?.length ?? null, reasons: r.reasons ?? null, fetchCalls,
  }) + '\n');
  db.close();
} else if (mode === 'hang') {
  const client = new FakeReviewClient([() => { process.stdout.write('CALLED\n'); return new Promise(() => undefined); }]);
  const rv = reviewer(client);
  const start = beginBpmnReview(db, human, caseId, rv);
  if (start.kind !== 'started') throw new Error('очікувався запуск');
  void executeBpmnReview(db, start.ctx, rv);
  setInterval(() => undefined, 1000);
} else {
  throw new Error('невідомий режим');
}
