/**
 * Окремий ПРОЦЕС ОС для перевірки справжнього перезапуску (3b-2). Режими:
 *   restore <db> <case>  — «старт застосунку»: recoverStuckRuns + відновлення перевірки з БД. Клієнта моделі в процесі НЕМАЄ,
 *                          мережу заблоковано: будь-який виклик fetch зафіксується й зламає результат.
 *   hang <db> <case>     — починає запуск перевірки; клієнт друкує CALLED і не відповідає (процес вбиває батьківський тест).
 *   decide-and-build <db> <case> <пояснення>
 *                        — «старт застосунку» після перезапуску: відновлює перевірку з бази, відхиляє всі знахідки,
 *                          які можна відхилити, і будує схему. Клієнта моделі немає, мережа заблокована (3b-3/3b-4).
 */
import { openDb } from '../src/db.ts';
import { recoverStuckRuns } from '../src/runs.ts';
import { beginBpmnReview, executeBpmnReview, getCaseReview, rejectFinding } from '../src/review-runs.ts';
import { buildArtifact } from '../src/bpmn-artifacts.ts';
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
} else if (mode === 'decide-and-build') {
  const explanation = process.argv[5] ?? '';
  recoverStuckRuns(db);
  const before = getCaseReview(db, caseId);
  let rejected = 0;
  for (const v of before.findingsView ?? []) {
    if (!v.can_reject || v.resolution) continue;
    rejectFinding(db, human, caseId, { reviewId: before.reviewId!, findingKey: v.key, explanation });
    rejected++;
  }
  const after = getCaseReview(db, caseId);
  let artifactStatus: string | null = null;
  let downloadsBpmn: boolean | null = null;
  let error: string | null = null;
  try {
    const out = await buildArtifact(db, human, caseId);
    artifactStatus = out.artifact.status;
    downloadsBpmn = out.artifact.downloads.bpmn;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  process.stdout.write(JSON.stringify({
    pid: process.pid, stateBefore: before.state, rejected, gateOkAfter: after.gate?.ok ?? null,
    artifactStatus, downloadsBpmn, error, fetchCalls,
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
