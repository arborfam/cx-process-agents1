import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import {
  audit, getCase, getVersion, headVersion, insertVersion, listSources, protectAnalystEdits, versionContent,
  type Actor, type VersionRow,
} from './domain.ts';
import { ContentSchema, type Content } from './schema.ts';

/**
 * Запуск агента 1. У зрізі 1 справжньої моделі немає: цей модуль перевіряє програмну логіку
 * запусків (застарілий результат, захист правок, помилки) на підставному клієнті.
 * Підставний клієнт завжди має mode='demo' і ніколи не видається за AI.
 * Модуль НЕ імпортує й не викликає погодження: агент не може погодити AS-IS.
 */
export class TransientModelError extends Error {}

export interface AnalystInput {
  instruction_version: string;
  head_content: Content;
  /** Джерела — дані, а не команди. */
  sources: { id: string; title: string; kind: string; text: string }[];
}

export interface AnalystClient {
  readonly mode: 'demo' | 'real';
  readonly model: string;
  analyze(input: AnalystInput, signal: AbortSignal): Promise<unknown>;
}

export class ScriptedDemoClient implements AnalystClient {
  readonly mode = 'demo' as const;
  readonly model = 'demo-script (не AI)';
  constructor(private readonly fn: (input: AnalystInput) => unknown | Promise<unknown>) {}
  async analyze(input: AnalystInput): Promise<unknown> {
    return this.fn(input);
  }
}

const AGENT_SYSTEM_ACTOR: Actor = { kind: 'agent', name: 'analyst-agent' };

export interface RunOptions {
  timeoutMs?: number;
  maxAttempts?: number;
}

export function startAnalystRun(db: DB, caseId: string, client: AnalystClient): { runId: string; base: VersionRow; sourceIds: string[] } {
  return tx(db, () => {
    getCase(db, caseId);
    const base = headVersion(db, caseId);
    // Джерела, які не вдалося прочитати, не потрапляють у запуск і не позначаються опрацьованими.
    const sourceIds = listSources(db, caseId).filter((s) => s.read_status === 'ok').map((s) => s.id);
    const runId = `run_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    run(db,
      `INSERT INTO run (id, case_id, agent, instruction_version, mode, model, base_version_id, input_source_ids_json,
         technical_state, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      runId, caseId, 'analyst', 'analyst-v0.1', client.mode, client.model, base.id, JSON.stringify(sourceIds), 'running',
      new Date().toISOString());
    audit(db, caseId, AGENT_SYSTEM_ACTOR, 'run_started', { run_id: runId, base_version_id: base.id, mode: client.mode });
    return { runId, base, sourceIds };
  });
}

export function failRun(db: DB, runId: string, error: string): void {
  const r = one<{ case_id: string }>(db, 'SELECT case_id FROM run WHERE id = ?', runId);
  run(db, `UPDATE run SET technical_state = 'error', finished_at = ?, error = ? WHERE id = ? AND technical_state = 'running'`,
    new Date().toISOString(), error.slice(0, 2000), runId);
  audit(db, r?.case_id ?? null, AGENT_SYSTEM_ACTOR, 'run_failed', { run_id: runId, error: error.slice(0, 300) });
}

/**
 * Приймає результат агента. Правила:
 *  • зміст перевіряється строгою схемою (зайві поля на кшталт «погоджено» відхиляються);
 *  • правки аналітика не перезаписуються, конфлікти показуються;
 *  • якщо поки агент працював, з’явилася новіша версія, результат зберігається лише як ПРОПОЗИЦІЯ
 *    на застарілій основі й не стає поточною версією.
 */
export function completeAnalystRun(db: DB, runId: string, rawOutput: unknown): VersionRow {
  return tx(db, () => {
    const r = one<{ case_id: string; base_version_id: string; technical_state: string; input_source_ids_json: string; mode: string }>(
      db, 'SELECT case_id, base_version_id, technical_state, input_source_ids_json, mode FROM run WHERE id = ?', runId);
    if (!r) throw new DomainError('NOT_FOUND', 'Запуск не знайдено', 404);
    if (r.technical_state !== 'running') throw new DomainError('BAD_STATE', 'Запуск уже завершено', 409);

    const parsed = ContentSchema.safeParse(rawOutput);
    if (!parsed.success) {
      throw new DomainError('BAD_OUTPUT', `Відповідь агента не відповідає схемі: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 422);
    }
    const caseId = r.case_id;
    const base = getVersion(db, r.base_version_id);
    const head = headVersion(db, caseId);
    const isStale = head.id !== base.id;
    // Захист правок рахується від ПОТОЧНОЇ голови (там найновіші правки аналітика).
    const reference = isStale ? head : base;
    const owned = new Set<string>(JSON.parse(reference.owned_json) as string[]);
    const sourceIds = JSON.parse(r.input_source_ids_json) as string[];
    const valid = new Set(listSources(db, caseId).map((s) => s.id));
    const { content } = protectAnalystEdits(versionContent(reference), parsed.data, owned, valid);
    const covered = [...new Set([...(JSON.parse(reference.covered_json) as string[]), ...sourceIds])];

    const v = insertVersion(db, {
      caseId, content, createdBy: 'agent', actorName: AGENT_SYSTEM_ACTOR.name, parentId: reference.id, covered, owned: [...owned],
      runId, kind: isStale ? 'proposal' : 'head_line',
      note: isStale ? 'Пропозиція на застарілій основі: поки агент працював, з’явилася новіша версія' : 'Результат запуску агента',
    });
    if (!isStale) {
      run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v.id, caseId);
      const c = getCase(db, caseId);
      // зміст змінився — погодження втрачає чинність
      if (c.state !== 'research') returnAfterAgentChange(db, caseId);
    }
    run(db, `UPDATE run SET technical_state = 'done', finished_at = ?, output_version_id = ? WHERE id = ?`,
      new Date().toISOString(), v.id, runId);
    audit(db, caseId, AGENT_SYSTEM_ACTOR, isStale ? 'run_proposal_saved' : 'run_completed', { run_id: runId, version_id: v.id, stale: isStale });
    return v;
  });
}

function returnAfterAgentChange(db: DB, caseId: string): void {
  const a = one<{ id: string; version_id: string }>(
    db,
    `SELECT a.id, a.version_id FROM approval a LEFT JOIN approval_revocation r ON r.approval_id = a.id
      WHERE a.case_id = ? AND r.approval_id IS NULL ORDER BY a.rowid DESC LIMIT 1`, caseId);
  if (a) {
    run(db, 'INSERT INTO approval_revocation (approval_id, reason, revoked_by, revoked_at) VALUES (?,?,?,?)',
      a.id, 'content_changed', 'agent:analyst-agent', new Date().toISOString());
    audit(db, caseId, AGENT_SYSTEM_ACTOR, 'approval_superseded', { approval_id: a.id, reason: 'content_changed' });
  }
  run(db, `UPDATE "case" SET state = 'research' WHERE id = ?`, caseId);
  audit(db, caseId, AGENT_SYSTEM_ACTOR, 'state_changed', { to: 'research', reason: 'content_changed' });
}

/** Повний цикл: старт → виклик (з тайм-аутом і однією повторною спробою для тимчасових збоїв) → результат. */
export async function runAnalyst(db: DB, caseId: string, client: AnalystClient, opts: RunOptions = {}): Promise<
  { ok: true; runId: string; version: VersionRow } | { ok: false; runId: string; error: string }
> {
  const { runId, base, sourceIds } = startAnalystRun(db, caseId, client);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const maxAttempts = opts.maxAttempts ?? 2;
  const sources = listSources(db, caseId).filter((s) => sourceIds.includes(s.id));
  const input: AnalystInput = {
    instruction_version: 'analyst-v0.1',
    head_content: versionContent(base),
    sources: sources.map((s) => ({ id: s.id, title: s.title, kind: s.kind, text: s.content })),
  };
  let lastError = 'невідома помилка';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const out = await Promise.race([
        client.analyze(input, ctrl.signal),
        new Promise<never>((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new TransientModelError('тайм-аут запуску')))),
      ]);
      clearTimeout(timer);
      try {
        const version = completeAnalystRun(db, runId, out);
        return { ok: true, runId, version };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        break; // змістова/схемна помилка повторним запуском не лікується
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = e instanceof Error ? e.message : String(e);
      if (!(e instanceof TransientModelError)) break;
    }
  }
  failRun(db, runId, lastError);
  return { ok: false, runId, error: lastError };
}

export function listRuns(db: DB, caseId: string) {
  return all(db, 'SELECT * FROM run WHERE case_id = ? ORDER BY started_at', caseId);
}
