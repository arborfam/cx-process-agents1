/** Експорт одного кейсу (scripts/export-case.ts): лише читання, без ключів, без реальних даних, без інших кейсів. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, openDb } from '../src/db.ts';
import { addSource, audit } from '../src/domain.ts';
import { runAnalyst } from '../src/runs.ts';
import { approvedCase, draftReadyCase, human, newCase, tempDbPath } from './helpers.ts';
import { runBpmnReviewForCase } from '../src/review-runs.ts';
import { FakeReviewClient, finding, okStep, policyOf, reviewer } from './review-helpers.ts';
import { ModelFailure } from '../src/ai/types.ts';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'export-case.ts');
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: 'sk-ant-api03-ENVSECRETENVSECRET123456' } });
const dump = (path: string) => { const db = openDb(path); const t = ['"case"', 'source', 'as_is_version', 'run', 'audit_log', 'approval'].map((x) => all(db, `SELECT * FROM ${x}`)); db.close(); return JSON.stringify(t); };

function seeded() {
  const path = tempDbPath();
  const db = openDb(path);
  const { c } = draftReadyCase(db);
  const other = newCase(db, 'ІНШИЙ КЕЙС-НЕ-ЕКСПОРТУВАТИ');
  addSource(db, human, other.id, { kind: 'transcript', title: 'Чуже', content: 'ТЕКСТ-ІНШОГО-КЕЙСУ', origin: 'synthetic' });
  audit(db, c.id, human, 'тестова_дія', { note: 'випадково потрапив ключ sk-ant-api03-LEAKLEAKLEAK1234567890' });
  db.close();
  return { path, caseId: c.id, otherId: other.id };
}

test('--list показує кейси з лічильниками й не друкує вмісту джерел', () => {
  const { path, caseId } = seeded();
  const r = run('--list', '--db', path);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(caseId));
  assert.ok(!r.stdout.includes('ТЕКСТ-ІНШОГО-КЕЙСУ'));
});

test('експорт: джерела, версії з авторством, журнал; без ключів (у т.ч. з журналу й змінної середовища), без чужого кейсу; базу не змінено', async () => {
  const { path, caseId } = seeded();
  const db = openDb(path);
  const failing = { mode: 'demo' as const, model: 'тест', analyze: async () => { throw new ModelFailure('bad_request', 'API відхилив запит: sk-ant-api03-RUNLEAKRUNLEAK123456', undefined, 'none'); } };
  await runAnalyst(db, caseId, failing);
  db.close();
  const before = dump(path);
  const out = join(mkdtempSync(join(tmpdir(), 'cx-exp-')), 'e.json');
  const r = run('--case', caseId, '--db', path, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(out, 'utf8');
  const data = JSON.parse(text);
  assert.equal(data.case.id, caseId);
  assert.ok(data.sources.length >= 1 && data.sources[0].content.length > 0);
  assert.ok(data.versions.length >= 2 && data.versions.every((v: any) => v.created_by && v.content && v.content_hash));
  assert.ok(data.runs.length === 1 && data.runs[0].technical_state === 'error' && data.runs[0].instruction_hash !== undefined);
  assert.ok(data.audit.some((a: any) => a.action === 'тестова_дія'));
  for (const secret of ['LEAKLEAK', 'RUNLEAK', 'ENVSECRET', 'sk-ant-api03']) assert.ok(!text.includes(secret), `у файлі є ${secret}`);
  assert.ok(!text.includes('ІНШИЙ КЕЙС') && !text.includes('ТЕКСТ-ІНШОГО-КЕЙСУ'), 'чужий кейс не експортується');
  assert.ok(!/access|код доступу|cookie/i.test(Object.keys(data).join(',')));
  assert.equal(dump(path), before, 'експорт нічого не змінює в базі');
});

test('кейс із «реальними» джерелами не експортується; неіснуючий кейс і відсутня база — зрозуміла відмова без файлу', () => {
  const path = tempDbPath();
  const db = openDb(path);
  const c = newCase(db);
  addSource(db, human, c.id, { kind: 'transcript', title: 'Реальне', content: 'РЕАЛЬНІ ДАНІ', origin: 'real' });
  db.close();
  const dir = mkdtempSync(join(tmpdir(), 'cx-exp-'));
  const out = join(dir, 'real.json');
  let r = run('--case', c.id, '--db', path, '--out', out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /реальні/);
  assert.ok(!existsSync(out));
  r = run('--case', 'case_немає', '--db', path, '--out', join(dir, 'x.json'));
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(dir, 'x.json')));
  r = run('--list', '--db', join(dir, 'нема.sqlite'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Базу не знайдено/);
});


test('експорт смислової перевірки: знахідки, попередження, збережена відповідь і рішення; ключ у відповіді приховано', async () => {
  const path = tempDbPath();
  const db = openDb(path);
  const { c } = approvedCase(db);
  // Відповідь «моделі» з ключем у тексті: він не має потрапити в експорт.
  const client = new FakeReviewClient([okStep([
    finding({ code: 'UNSUPPORTED_CANDIDATE', step_ids: ['S2'], quote: 'Синтетичний процес зміни умов', question: 'Це окремий стан очікування чи звичайна дія? (службове: sk-ant-api03-LEAKINREVIEW123456)', class: 'blocks_flow' }),
  ])]);
  const r = await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
  assert.ok(r.ok, JSON.stringify(r));
  db.close();

  const out = join(mkdtempSync(join(tmpdir(), 'cx-exp-')), 'e.json');
  const res = run('--db', path, '--case', c.id, '--out', out);
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(readFileSync(out, 'utf8')) as {
    bpmn_reviews: { outcome: string; findings: { code: string; quote: string; question: string }[]; warnings: string[]; response: { findings: unknown[] }; attempts: unknown; instruction_version: string }[];
    finding_resolutions: unknown[];
  };
  assert.equal(data.bpmn_reviews.length, 1);
  const rev = data.bpmn_reviews[0]!;
  assert.equal(rev.outcome, 'awaiting_analyst');
  assert.equal(rev.findings.length, 1, 'знахідки є в експорті');
  assert.equal(rev.findings[0]!.code, 'UNSUPPORTED_CANDIDATE');
  assert.equal(rev.findings[0]!.quote, 'Синтетичний процес зміни умов', 'цитата збережена дослівно');
  assert.ok(Array.isArray(rev.warnings) && rev.warnings.some((w) => /не в тексті вказаних кроків/.test(w)), 'попередження перевірки цитат є в експорті');
  assert.ok(rev.response && Array.isArray(rev.response.findings), 'збережена відповідь агента 2 є в експорті');
  assert.ok(rev.attempts, 'журнал спроб є');
  assert.ok(rev.instruction_version.startsWith('bpmn-'), 'видно версію інструкції');
  assert.deepEqual(data.finding_resolutions, [], 'рішень ще немає, але поле є');
  // Ключ не витік — ні в знахідці, ні в збереженій відповіді.
  const text = readFileSync(out, 'utf8');
  assert.ok(!text.includes('sk-ant-api03-LEAKINREVIEW123456'), 'ключ з відповіді моделі приховано');
  assert.ok(text.includes('[ключ приховано]'));
  assert.ok(res.stdout.includes('Смислових перевірок: 1'), res.stdout);
});
