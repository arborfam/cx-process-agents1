import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.ts';
import {
  acceptDraft, addSource, approve, createCase, headVersion, saveAnalystVersion, submitForApproval,
  type Actor, type EditFields,
} from '../src/domain.ts';

export const human: Actor = { kind: 'human', name: 'Аналітикиня' };
export const agent: Actor = { kind: 'agent', name: 'analyst-agent' };

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cx-test-')), 'cx.sqlite');
}

export function freshDb(): DB {
  return openDb(tempDbPath());
}

/** Повний, структурно коректний синтетичний опис (для тестів логіки, не для оцінки AI). */
export const COMPLETE_FIELDS: EditFields = {
  summary: 'Синтетичний процес зміни умов: менеджер приймає запит, оператор вносить зміну.',
  business_context: 'Навчальний синтетичний приклад.',
  boundaries: { trigger: 'Запит клієнта', input: 'Заявка', completion: 'Умови оновлено', result: 'Оновлений договір' },
  roles_text: 'Менеджер\nОператор',
  steps_text: [
    'S1 | Менеджер | Приймає запит | Заявка в CRM | S2',
    'S2 | Оператор | Вносить зміну | Умови оновлено | END',
  ].join('\n'),
  problems_text: 'P1 | Довге очікування | Клієнти чекають довше очікуваного (оцінка, метрик немає)',
};

export function newCase(db: DB, title = 'Тестовий кейс') {
  return createCase(db, human, title, 'demo');
}

/** Кейс із одним синтетичним джерелом і повною робочою версією (ще не прийнятою). */
export function draftReadyCase(db: DB) {
  const c = newCase(db);
  addSource(db, human, c.id, { kind: 'transcript', title: 'Інтерв’ю 1 (синтетичне)', content: 'Менеджер приймає запит. Оператор вносить зміну.', origin: 'synthetic' });
  const v = saveAnalystVersion(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, fields: COMPLETE_FIELDS, coverAllSources: true });
  return { c, v };
}

export function pendingCase(db: DB) {
  const { c, v } = draftReadyCase(db);
  acceptDraft(db, human, c.id, v.id);
  submitForApproval(db, human, c.id);
  return { c, v };
}

export function approvedCase(db: DB) {
  const { c, v } = pendingCase(db);
  const a = approve(db, human, c.id, { versionId: v.id, checklistConfirmed: true });
  return { c, v, a };
}

import type { AddressInfo } from 'node:net';
import { createApp, sessionToken } from '../src/server.ts';

export const ACCESS_CODE = 'test-code';

export async function startTestServer(db: DB) {
  const server = createApp({ db, mode: 'demo', accessCode: ACCESS_CODE });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `cx_session=${sessionToken(ACCESS_CODE)}`;
  async function call(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'cx',
        ...(opts.auth === false ? {} : { cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }
  return { base, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
