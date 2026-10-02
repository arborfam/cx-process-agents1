import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { all, one, openDb } from '../src/db.ts';
import { createApp, sessionToken } from '../src/server.ts';
import { ScriptedDemoClient } from '../src/runs.ts';
import { loadInstruction } from '../src/ai/prompt.ts';
import { headVersion, versionContent } from '../src/domain.ts';
import { freshDb, tempDbPath, ACCESS_CODE } from './helpers.ts';
import type { AnalystClient } from '../src/ai/types.ts';

async function start(db = freshDb(), analyst?: Parameters<typeof createApp>[0]['analyst']) {
  const server = createApp({ db, mode: 'demo', accessCode: ACCESS_CODE, analyst });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `cx_session=${sessionToken(ACCESS_CODE)}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'cx', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const wait = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('очікування вичерпано'); await new Promise((r) => setTimeout(r, 10)); } };

test('API: без підключеної моделі аналіз недоступний з поясненням; на демо мовчки не перемикається; ключа в конфігурації немає', async () => {
  const s = await start();
  try {
    const cfg = await s.call('GET', '/api/config');
    assert.equal(cfg.body.ai.available, false);
    assert.match(cfg.body.ai.reason, /деморежим/);
    assert.ok(!/key|ключ=/i.test(JSON.stringify(cfg.body).replace(/ключ і модель/g, '')), 'конфіг не містить значень ключа');
    const c = (await s.call('POST', '/api/cases', { title: 'К' })).body.case;
    const r = await s.call('POST', `/api/cases/${c.id}/analyze`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'AI_UNAVAILABLE');
    assert.equal(all(s.db, 'SELECT id FROM run').length, 0, 'жодного запуску не створено');
    assert.equal((await s.call('GET', `/api/cases/${c.id}`)).body.ai.available, false);
  } finally { await s.close(); }
});

test('API: сценарії — створення, етапи, блокування наступного етапу, приховане уточнення; картка не розкриває текст', async () => {
  const ai = { client: new ScriptedDemoClient((i) => i.head_content), instruction: loadInstruction() };
  const s = await start(freshDb(), ai);
  try {
    assert.equal((await s.call('GET', '/api/scenarios')).body.scenarios[0].stages, 5);
    assert.equal((await s.call('POST', '/api/scenarios/cx-preparation', { variant: 'x' })).status, 400);
    const neg = (await s.call('POST', '/api/scenarios/cx-preparation', { variant: 'negative' })).body.case;
    let card = (await s.call('GET', `/api/cases/${neg.id}`)).body;
    assert.equal(card.scenario.stage, 0);
    assert.equal(card.scenario.next_stage, 1);
    assert.deepEqual(card.scenario.next_sources.map((x: any) => x.ref), ['SRC-00', 'SRC-01', 'SRC-02']);
    assert.equal((await s.call('POST', `/api/cases/${neg.id}/scenario/next`, {})).status, 201);
    const blocked = await s.call('POST', `/api/cases/${neg.id}/scenario/next`, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'PREVIOUS_STAGE_UNPROCESSED');
    assert.equal((await s.call('POST', `/api/cases/${neg.id}/scenario/clarify`, {})).body.error.code, 'TOO_EARLY');
    card = (await s.call('GET', `/api/cases/${neg.id}`)).body;
    assert.equal(card.sources.length, 3);
    assert.ok(card.sources.every((x: any) => /^SRC-0\d$/.test(x.ref)));
  } finally { await s.close(); }
});

test('API: запуск аналізу асинхронний (202); результат з’являється після завершення; повторний запуск під час роботи — 409; журнал заповнено', async () => {
  const db = freshDb();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const client = new ScriptedDemoClient(async (i) => { await gate; return { ...i.head_content, summary: 'Результат підставного клієнта (не AI)' }; });
  const s = await start(db, { client, instruction: loadInstruction() });
  try {
    const c = (await s.call('POST', '/api/cases', { title: 'К' })).body.case;
    await s.call('POST', `/api/cases/${c.id}/sources`, { kind: 'transcript', title: 'Т', content: 'Текст', origin: 'synthetic' });
    const before = headVersion(db, c.id).id;
    const r = await s.call('POST', `/api/cases/${c.id}/analyze`, {});
    assert.equal(r.status, 202);
    assert.ok(r.body.run_id);
    const again = await s.call('POST', `/api/cases/${c.id}/analyze`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'RUN_ACTIVE');
    assert.equal(headVersion(db, c.id).id, before, 'поки запуск триває, поточна версія не змінюється');
    let card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.equal(card.runs[0].technical_state, 'running');
    release();
    await wait(() => one<{ technical_state: string }>(db, 'SELECT technical_state FROM run WHERE id = ?', r.body.run_id)!.technical_state !== 'running');
    card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.equal(card.runs[0].technical_state, 'done');
    assert.equal(card.head.content.summary, 'Результат підставного клієнта (не AI)');
    assert.equal(card.head.created_by, 'agent');
    assert.equal(card.runs[0].instruction_version, 'analyst-v0.8');
    assert.equal(card.runs[0].mode, 'demo');
    assert.match(card.runs[0].model, /не AI/);
  } finally { release(); await s.close(); }
});

test('API: помилка моделі під час аналізу не змінює версію; причину видно в журналі запуску; аналіз у стані «погоджено» не запускається', async () => {
  const db = freshDb();
  const bad: AnalystClient = { mode: 'demo', model: 'demo-script (не AI)', analyze: async () => { throw new Error('модель недоступна sk-ant-api03-ABCDEFGHIJKLMNOP'); } };
  const s = await start(db, { client: bad, instruction: loadInstruction() });
  try {
    const c = (await s.call('POST', '/api/cases', { title: 'К' })).body.case;
    const head = headVersion(db, c.id).id;
    const r = await s.call('POST', `/api/cases/${c.id}/analyze`, {});
    await wait(() => one<{ technical_state: string }>(db, 'SELECT technical_state FROM run WHERE id = ?', r.body.run_id)!.technical_state === 'error');
    const card = (await s.call('GET', `/api/cases/${c.id}`)).body;
    assert.equal(card.runs[0].technical_state, 'error');
    assert.match(card.runs[0].error, /недоступна/);
    assert.ok(!JSON.stringify(card).includes('ABCDEFGHIJKLMNOP'), 'ключ у відповіді API відредаговано');
    assert.equal(headVersion(db, c.id).id, head);
    assert.deepEqual(versionContent(headVersion(db, c.id)).steps, []);
    // стан, відмінний від «дослідження»
    db.prepare(`UPDATE "case" SET state = 'approved' WHERE id = ?`).run(c.id);
    const refused = await s.call('POST', `/api/cases/${c.id}/analyze`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'BAD_STATE');
  } finally { await s.close(); }
});

test('Міграція: стара база без нових колонок відкривається, дані й тригери незмінності збережено', () => {
  const path = tempDbPath();
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE "case" (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, head_version_id TEXT, mode TEXT NOT NULL, is_demo_script INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE source (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, author TEXT NOT NULL, origin TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0, read_status TEXT NOT NULL, read_error TEXT, added_at TEXT NOT NULL);
    CREATE TABLE run (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, agent TEXT NOT NULL, instruction_version TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, base_version_id TEXT, input_approval_id TEXT, input_source_ids_json TEXT NOT NULL DEFAULT '[]', technical_state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT, output_version_id TEXT, checks_json TEXT NOT NULL DEFAULT '{}', note TEXT NOT NULL DEFAULT '');
    INSERT INTO "case" VALUES ('case_old','Старий кейс','research',NULL,'demo',0,'2026-09-30T00:00:00Z');
    INSERT INTO source VALUES ('src_old','case_old',1,'transcript','Старе','текст','h','Аналітикиня','synthetic',0,'ok',NULL,'2026-09-30T00:00:00Z');
    INSERT INTO run VALUES ('run_old','case_old','analyst','analyst-v0.1','demo','demo-script (не AI)',NULL,NULL,'[]','done','2026-09-30T00:00:00Z',NULL,NULL,NULL,'{}','');
  `);
  old.close();
  const db = openDb(path);
  assert.equal(one<{ title: string; scenario_stage: number; scenario_id: string | null }>(db, 'SELECT * FROM "case"')!.title, 'Старий кейс');
  assert.equal(one<{ scenario_stage: number }>(db, 'SELECT scenario_stage FROM "case"')!.scenario_stage, 0);
  assert.equal(one<{ ref: string | null }>(db, 'SELECT ref FROM source')!.ref, null);
  const r = one<{ attempts: number; usage_json: string; cost_usd: number | null; instruction_version: string }>(db, 'SELECT * FROM run')!;
  assert.equal(r.attempts, 1); assert.equal(r.usage_json, '{}'); assert.equal(r.cost_usd, null); assert.equal(r.instruction_version, 'analyst-v0.1');
  assert.throws(() => db.exec(`UPDATE source SET title = 'x'`), /незмінна/);
  assert.throws(() => db.exec(`DELETE FROM source`), /незмінна/);
  db.close();
  openDb(path).close(); // повторне відкриття (міграція ідемпотентна)
});
