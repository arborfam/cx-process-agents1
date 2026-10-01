/**
 * Повний шлях через HTTP (3b-3…3b-7): прямі запити, повторні кліки, доступ до файлів на сервері.
 * «Агент 2» — ПІДСТАВНИЙ клієнт у тестовому середовищі; у продукті такого клієнта немає (tests/bpmn-isolation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, type DB } from '../src/db.ts';
import { sha256 } from '../src/hash.ts';
import { sessionToken } from '../src/server.ts';
import {
  acceptDraft, approve, headVersion, returnToResearch, saveAnalystVersion, submitForApproval,
} from '../src/domain.ts';
import { buildArtifact } from '../src/bpmn-artifacts.ts';
import { ACCESS_CODE, approvedCase, freshDb, human, startTestServer } from './helpers.ts';
import { FakeReviewClient, finding, okStep, policyOf, reviewer, type Step } from './review-helpers.ts';

const EXPL = 'Опис однозначний: інших випадків тут немає (синтетичне пояснення тесту).';
const cookie = `cx_session=${sessionToken(ACCESS_CODE)}`;

/** Сервер із підставним «агентом 2» і погодженим кейсом. */
async function server(db: DB, steps: Step[] = [okStep([])]) {
  const { c } = approvedCase(db);
  const client = new FakeReviewClient(steps);
  const s = await startTestServer(db, { reviewer: reviewer(client, policyOf()) });
  return { s, caseId: c.id, client };
}

/**
 * Чекає, поки фоновий запуск перевірки завершиться (маршрут відповідає 202 одразу).
 * Запас часу навмисно великий: повний набір тестів виконується паралельно, і короткий ліміт дав би
 * нестабільний тест під навантаженням, а не справжню знахідку.
 */
async function waitReview(s: Awaited<ReturnType<typeof startTestServer>>, caseId: string, want: string[]): Promise<any> {
  const deadline = Date.now() + 30_000;
  let last = '';
  while (Date.now() < deadline) {
    const r = await s.call('GET', `/api/cases/${caseId}/bpmn/review`);
    last = r.body.state;
    if (want.includes(last)) return r.body;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error(`перевірка не дійшла до стану ${want.join('/')}; залишилась у «${last}»`);
}

const raw = (s: Awaited<ReturnType<typeof startTestServer>>, path: string, opts: { auth?: boolean } = {}) =>
  fetch(s.base + path, { headers: { 'x-requested-with': 'cx', ...(opts.auth === false ? {} : { cookie }) } });

// ───────── 1. Повний успішний шлях ─────────

test('HTTP: погоджений пакет → перевірка без блокерів → побудова → перегляд → завантаження обох файлів', async () => {
  const db = freshDb();
  const { s, caseId, client } = await server(db);
  try {
    assert.equal((await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {})).status, 202);
    const rev = await waitReview(s, caseId, ['clear']);
    assert.equal(rev.generation_gate.ok, true);

    const before = (await s.call('GET', `/api/cases/${caseId}/bpmn/artifact`)).body;
    assert.equal(before.artifact, null);
    assert.equal(before.can_build, true);

    const built = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(built.status, 201);
    assert.equal(built.body.artifact.status, 'ok');
    assert.equal(built.body.reused, false);
    assert.equal(client.calls, 1, 'побудова моделі не кликала');

    const view = (await s.call('GET', `/api/cases/${caseId}/bpmn/artifact`)).body;
    assert.equal(view.artifact.current, true);
    assert.equal(view.artifact.label, null);
    assert.ok(view.artifact.process_name.length > 0, 'назва процесу показана');
    assert.ok(view.artifact.map.length > 0, 'відповідність кроків елементам показана');
    assert.deepEqual(view.artifact.downloads, { bpmn: true, drawio: true });

    for (const kind of ['bpmn', 'drawio']) {
      const res = await raw(s, `/api/cases/${caseId}/bpmn/file/${kind}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`\\.${kind}"$`));
      const text = await res.text();
      assert.equal(sha256(text), res.headers.get('x-content-sha256'));
      assert.ok(text.length > 100);
    }
  } finally { await s.close(); }
});

// ───────── 2. Блокер → рішення → побудова ─────────

test('HTTP: смисловий блокер → очікування → мотивоване відхилення → побудова без нового виклику моделі', async () => {
  const db = freshDb();
  const { s, caseId, client } = await server(db, [okStep([finding()])]);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    const rev = await waitReview(s, caseId, ['awaiting_analyst']);
    assert.equal(rev.generation_gate.ok, false);
    assert.equal(rev.generation_gate.code, 'BLOCKING_FINDINGS');
    assert.equal(rev.findings_view.length, 1);
    const v = rev.findings_view[0];
    assert.ok(v.blocking && v.can_reject && v.resolution === null);

    assert.equal((await s.call('GET', `/api/cases/${caseId}/bpmn/artifact`)).body.can_build, false);
    const refused = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'BLOCKING_FINDINGS');

    // Пояснення обов'язкове.
    const noExpl = await s.call('POST', `/api/cases/${caseId}/bpmn/findings/reject`, { review_id: rev.review_id, finding_key: v.key, explanation: 'ок' });
    assert.equal(noExpl.status, 400);
    assert.equal(noExpl.body.error.code, 'EXPLANATION_REQUIRED');

    const ok = await s.call('POST', `/api/cases/${caseId}/bpmn/findings/reject`, { review_id: rev.review_id, finding_key: v.key, explanation: EXPL });
    assert.equal(ok.status, 201);

    const after = (await s.call('GET', `/api/cases/${caseId}/bpmn/review`)).body;
    assert.equal(after.generation_gate.ok, true);
    assert.equal(after.findings_view[0].resolution.explanation, EXPL, 'рішення видно поруч зі знахідкою');

    const built = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(built.status, 201);
    assert.equal(built.body.artifact.status, 'ok');
    assert.equal(client.calls, 1, 'після рішення модель не викликалась');
  } finally { await s.close(); }
});

test('HTTP: відхилення з чужим ID перевірки та вигаданим ключем знахідки не записується', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db, [okStep([finding()])]);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    const rev = await waitReview(s, caseId, ['awaiting_analyst']);
    const bad1 = await s.call('POST', `/api/cases/${caseId}/bpmn/findings/reject`, { review_id: 'rev_000000000000', finding_key: rev.findings_view[0].key, explanation: EXPL });
    assert.equal(bad1.body.error.code, 'REVIEW_MISMATCH');
    const bad2 = await s.call('POST', `/api/cases/${caseId}/bpmn/findings/reject`, { review_id: rev.review_id, finding_key: 'f'.repeat(64), explanation: EXPL });
    assert.equal(bad2.body.error.code, 'NOT_FOUND');
    assert.equal(all(db, 'SELECT id FROM finding_resolution').length, 0);
  } finally { await s.close(); }
});

// ───────── 3. Непідтримувана нотація ─────────

test('HTTP: кандидат на непідтримувану нотацію не відхиляється й схему не відкриває', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db, [okStep([finding({ code: 'UNSUPPORTED_CANDIDATE' })])]);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    const rev = await waitReview(s, caseId, ['awaiting_analyst']);
    const v = rev.findings_view[0];
    assert.equal(v.can_reject, false);
    assert.match(v.reject_blocked_reason, /не можна/);
    const r = await s.call('POST', `/api/cases/${caseId}/bpmn/findings/reject`, { review_id: rev.review_id, finding_key: v.key, explanation: EXPL });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CANNOT_REJECT');
    const b = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(b.body.error.code, 'UNSUPPORTED_CANDIDATE');
    assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0);
  } finally { await s.close(); }
});

// ───────── 4. Повторні кліки й ігнорування тіла запиту ─────────

test('HTTP: повторний POST build повертає той самий артефакт (200, reused) і не створює другого', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    await waitReview(s, caseId, ['clear']);
    const a = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    const b = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.reused, true);
    assert.equal(b.body.artifact.id, a.body.artifact.id);
    assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 1);
  } finally { await s.close(); }
});

test('HTTP: тіло запиту на побудову ігнорується — підробити результат, стан чи пакет через нього неможливо', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db, [okStep([finding()])]);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, { findings: [], outcome: 'clear' });
    const rev = await waitReview(s, caseId, ['awaiting_analyst']);
    assert.equal(rev.findings_view.length, 1, 'порожні знахідки з тіла не прийнято');
    const forced = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {
      findings: [], gate: { ok: true }, status: 'ok', bpmn: '<bpmn:definitions/>', approved: true, review_id: rev.review_id,
    });
    assert.equal(forced.status, 409);
    assert.equal(forced.body.error.code, 'BLOCKING_FINDINGS');
    assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0);
  } finally { await s.close(); }
});

// ───────── 5. Доступ: сервер, а не приховані кнопки ─────────

test('HTTP: без входу й без заголовка захисту дії та файли недоступні', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    await waitReview(s, caseId, ['clear']);
    await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});

    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`, { auth: false })).status, 401);
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/artifact`, { auth: false })).status, 401);
    assert.equal((await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {}, { auth: false })).status, 401);
    // Без заголовка захисту від підробки запитів POST не проходить.
    const noHeader = await fetch(`${s.base}/api/cases/${caseId}/bpmn/build`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
  } finally { await s.close(); }
});

test('HTTP: прямий запит файлу для кейсу без схеми — 404; для чужого виду файлу — 404 маршруту', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db);
  try {
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`)).status, 404);
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/png`)).status, 404);
  } finally { await s.close(); }
});

// ───────── 6. Застарівання ─────────

test('HTTP: після уточнення опису стара схема лишається в історії з позначкою, але як чинна не видається й не завантажується', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    await waitReview(s, caseId, ['clear']);
    await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`)).status, 200);

    // Уточнення опису: нова версія, погодження скасоване.
    returnToResearch(db, human, caseId, 'уточнення (тест)');
    const v = saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { summary: 'Уточнено (синтетично).' } });
    acceptDraft(db, human, caseId, v.id);

    const view = (await s.call('GET', `/api/cases/${caseId}/bpmn/artifact`)).body;
    assert.equal(view.artifact.current, false);
    assert.match(view.artifact.label, /^Застаріла — побудована за версією /);
    assert.deepEqual(view.artifact.downloads, { bpmn: false, drawio: false });
    assert.equal(view.history.length, 1, 'історія лишається видимою');
    assert.equal(view.can_build, false);

    const res = await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'ARTIFACT_STALE');

    // Нове погодження тієї ж (уточненої) версії не робить стару схему чинною і вимагає нової перевірки.
    submitForApproval(db, human, caseId);
    approve(db, human, caseId, { versionId: v.id, checklistConfirmed: true });
    const after = (await s.call('GET', `/api/cases/${caseId}/bpmn/artifact`)).body;
    assert.equal(after.artifact.current, false);
    assert.equal(after.can_build, false);
    assert.equal(after.build_block.code, 'REVIEW_STALE');
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`)).status, 409);
  } finally { await s.close(); }
});

// ───────── 7. Збої ─────────

test('HTTP: збій моделі не відкриває генерацію; у відповіді є конкретна наступна дія', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db, [okStep([finding({ quote: 'цитати немає в описі' })])]);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    const rev = await waitReview(s, caseId, ['failed']);
    assert.equal(rev.generation_gate.ok, false);
    const b = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'REVIEW_FAILED');
    assert.match(b.body.error.message, /перевірк/i);
    assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0);
  } finally { await s.close(); }
});

test('HTTP: без підключеної моделі перевірка не запускається й не імітується, схема не будується', async () => {
  const db = freshDb();
  const { c } = approvedCase(db);
  const s = await startTestServer(db); // reviewer не задано — деморежим
  try {
    const r = await s.call('POST', `/api/cases/${c.id}/bpmn/review`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'AI_UNAVAILABLE');
    const b = await s.call('POST', `/api/cases/${c.id}/bpmn/build`, {});
    assert.equal(b.body.error.code, 'NO_REVIEW');
    assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0);
  } finally { await s.close(); }
});

// ───────── 8. Повтор після технічної помилки й недовірені рішення (D75) ─────────

test('HTTP: невдалу побудову можна повторити тією самою дією — без нового виклику моделі; успішний результат і далі не перегенеровується', async () => {
  const db = freshDb();
  const { s, caseId, client } = await server(db);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    await waitReview(s, caseId, ['clear']);

    // Невдалу спробу моделюємо на доменному рівні (у продукту немає входу для пошкодження) — далі працюємо через HTTP.
    const bad = await buildArtifact(db, human, caseId, undefined, { tamperBpmn: (x) => x.replace(/<bpmn:task /, '<bpmn:task name="ЗІПСОВАНО" ') });
    assert.equal(bad.artifact.status, 'verification_failed');
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`)).status, 409);

    const retry = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(retry.status, 201, 'повтор має створити новий результат, а не повернути невдалий');
    assert.equal(retry.body.reused, false);
    assert.equal(retry.body.artifact.status, 'ok');
    assert.equal((await raw(s, `/api/cases/${caseId}/bpmn/file/bpmn`)).status, 200);

    const again = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(again.body.reused, true, 'повний успішний результат не перегенеровується');
    assert.equal(client.calls, 1, 'жодного додаткового виклику моделі');
    const rows = all(db, 'SELECT status FROM bpmn_artifact WHERE case_id = ? ORDER BY rowid', caseId) as { status: string }[];
    assert.deepEqual(rows.map((r) => r.status), ['verification_failed', 'ok'], 'невдала спроба лишається в історії');
  } finally { await s.close(); }
});

test('HTTP: запис рішення, якому не довіряємо, блокування не знімає й показується з причиною', async () => {
  const db = freshDb();
  const { s, caseId } = await server(db, [okStep([finding()])]);
  try {
    await s.call('POST', `/api/cases/${caseId}/bpmn/review`, {});
    const rev = await waitReview(s, caseId, ['awaiting_analyst']);
    const key = rev.findings_view[0].key;

    // Пряме втручання в базу (у продукті такого входу немає).
    const r0 = one<Record<string, any>>(db, 'SELECT * FROM bpmn_review WHERE id = ?', rev.review_id)!;
    db.prepare(`INSERT INTO finding_resolution (id, case_id, review_id, run_id, approval_id, version_id, content_hash,
        finding_key, finding_json, decision, explanation, decided_by, decided_at, record_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('fres_http_forged', caseId, rev.review_id, r0.run_id, r0.approval_id, r0.version_id, r0.content_hash,
        key, '{}', 'rejected', '', 'хтось', '2026-01-01T00:00:00.000Z', 'ЗІПСОВАНИЙ-ХЕШ');

    const after = (await s.call('GET', `/api/cases/${caseId}/bpmn/review`)).body;
    assert.equal(after.generation_gate.ok, false, 'підроблений запис не має відкривати шлюз');
    assert.equal(after.findings_view[0].resolution, null, 'він не показується як рішення людини');
    assert.equal(after.invalid_resolutions.length, 1);
    assert.match(after.invalid_resolutions[0].reasons.join(' '), /сума|поясн/i);
    const b = await s.call('POST', `/api/cases/${caseId}/bpmn/build`, {});
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'BLOCKING_FINDINGS');
    assert.equal(all(db, 'SELECT id FROM bpmn_artifact').length, 0);

    // Людина не може «перекрити» пошкоджений запис — отримує зрозуміле пояснення, а не помилку бази.
    const rj = await s.call('POST', `/api/cases/${caseId}/bpmn/findings/reject`, { review_id: rev.review_id, finding_key: key, explanation: EXPL });
    assert.equal(rj.status, 409);
    assert.equal(rj.body.error.code, 'RESOLUTION_DAMAGED');
  } finally { await s.close(); }
});
