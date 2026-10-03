/**
 * Походження завантаженого файла (D98).
 *
 * Мовчазне «synthetic» за замовчуванням позначило б реальні дані як навчальні й відкрило б їх для
 * надсилання моделі (D18). Тому походження вимагається явно, а збережене значення має дорівнювати
 * переданому — не назві файлу, не розширенню, не режиму роботи.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, sessionToken } from '../src/server.ts';
import { freshDb, ACCESS_CODE } from './helpers.ts';
import { listSources } from '../src/domain.ts';

async function start() {
  const db = freshDb();
  const server = createApp({ db, mode: 'demo', accessCode: ACCESS_CODE });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `cx_session=${sessionToken(ACCESS_CODE)}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-requested-with': 'cx', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');

test('API: походження файла обов’язкове і зберігається саме вибране значення', async () => {
  const s = await start();
  try {
    const c = (await s.call('POST', '/api/cases', { title: 'Кейс' })).body.case;
    const url = `/api/cases/${c.id}/sources/file`;

    // 1. Без походження — відмова, джерела не створено.
    const silent = await s.call('POST', url, { name: 'a.txt', kind: 'document', content_base64: b64('текст') });
    assert.equal(silent.status, 400);
    assert.equal(silent.body.error.code, 'VALIDATION');
    assert.match(silent.body.error.message, /походження/);
    assert.equal(listSources(s.db, c.id).length, 0, 'за відмови джерело не створюється');

    // 2. Хибне значення теж відмова, а не тихе «synthetic».
    const bad = await s.call('POST', url, { name: 'a.txt', kind: 'document', content_base64: b64('текст'), origin: 'прошите' });
    assert.equal(bad.status, 400);
    assert.equal(listSources(s.db, c.id).length, 0);

    // 3. Вибір «реальні дані» зберігається як real, навіть коли назва файлу натякає на синтетику.
    const real = await s.call('POST', url, { name: 'synthetic-example.txt', kind: 'document', content_base64: b64('текст'), origin: 'real' });
    assert.equal(real.status, 201);
    // 4. Вибір «синтетичний» зберігається як synthetic, навіть коли назва натякає на реальні дані.
    const syn = await s.call('POST', url, { name: 'real-client-interview.txt', kind: 'document', content_base64: b64('текст'), origin: 'synthetic' });
    assert.equal(syn.status, 201);

    const byRef = new Map(listSources(s.db, c.id).map((x) => [x.title, x.origin]));
    assert.equal(byRef.get('synthetic-example.txt'), 'real', 'назва файлу не визначає походження');
    assert.equal(byRef.get('real-client-interview.txt'), 'synthetic', 'назва файлу не визначає походження');
  } finally { await s.close(); }
});
