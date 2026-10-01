import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import {
  audit, getCase, getVersion, headVersion, insertVersion, listSources, protectAnalystEdits, versionContent,
  type Actor, type VersionRow,
} from './domain.ts';
import { type Content } from './schema.ts';
import { actualCostUsd, preflight, type ModelPolicy } from './ai/budget.ts';
import { idMaps } from './ai/idmap.ts';
import { buildUserMessage, loadInstruction } from './ai/prompt.ts';
import { redact } from './ai/redact.ts';
import {
  ModelFailure, type AnalystClient, type AnalystInput, type InstructionInfo, type ModelCallResult, type Usage,
} from './ai/types.ts';
import { formatViolations, verifyAgentOutput, type Violation } from './ai/verify.ts';

/**
 * Запуск агента 1. Модуль НЕ імпортує й не викликає погодження: агент не може погодити AS-IS.
 * Підставний клієнт (ScriptedDemoClient) завжди має mode='demo', перевіряє лише програмну логіку
 * і ніколи не видається за AI. Справжній клієнт — src/ai/anthropic-client.ts.
 */
export { ModelFailure, type AnalystClient, type AnalystInput };

/** Тимчасовий збій (мережа тощо): дозволена одна повторна спроба. */
export class TransientModelError extends ModelFailure {
  constructor(message: string) {
    super('transient', message);
  }
}

export class ScriptedDemoClient implements AnalystClient {
  readonly mode = 'demo' as const;
  readonly model = 'demo-script (не AI)';
  constructor(private readonly fn: (input: AnalystInput) => unknown | Promise<unknown>) {}
  async analyze(input: AnalystInput): Promise<ModelCallResult> {
    return { output: await this.fn(input) };
  }
}

const AGENT_SYSTEM_ACTOR: Actor = { kind: 'agent', name: 'analyst-agent' };

export interface RunOptions {
  timeoutMs?: number;
  /** Максимум спроб (за замовчуванням 2: одна автоматична повторна). */
  maxAttempts?: number;
  /** Обов’язкова для справжнього клієнта: ліміти й ціни. */
  policy?: ModelPolicy;
  instruction?: InstructionInfo;
}

export interface RunCtx {
  runId: string;
  caseId: string;
  base: VersionRow;
  sourceIds: string[];
  input: AnalystInput;
  startedMs: number;
}

/** Перевіряє дозволи й ліміти, фіксує запуск. Нічого не надсилає моделі. */
export function beginAnalystRun(db: DB, caseId: string, client: AnalystClient, opts: RunOptions = {}): RunCtx {
  return tx(db, () => {
    const c = getCase(db, caseId);
    if (one(db, `SELECT id FROM run WHERE case_id = ? AND technical_state = 'running'`, caseId)) {
      throw new DomainError('RUN_ACTIVE', 'Для цього кейсу вже виконується аналіз. Дочекайтеся завершення.', 409);
    }
    const base = headVersion(db, caseId);
    const all_ = listSources(db, caseId);
    // Джерела, які не вдалося прочитати, не потрапляють у запуск і не позначаються опрацьованими.
    const readable = all_.filter((s) => s.read_status === 'ok');
    const maps = idMaps(all_.map((s) => ({ id: s.id, ref: s.ref })));
    const instruction = opts.instruction ?? loadInstruction();
    const input: AnalystInput = {
      instruction,
      head_content: maps.toModel(versionContent(base)),
      sources: readable.map((s) => ({ id: maps.label(s.id), title: s.title, kind: s.kind, origin: s.origin, text: s.content })),
    };
    if (client.mode === 'real') {
      if (!opts.policy) throw new DomainError('AI_UNAVAILABLE', 'Для справжньої моделі не задано ліміти й ціни; запуск не виконано.', 409);
      try {
        preflight(db, caseId, opts.policy, instruction.text.length + buildUserMessage(input).length);
      } catch (e) {
        audit(db, caseId, AGENT_SYSTEM_ACTOR, 'run_refused', { code: e instanceof DomainError ? e.code : 'ERROR' });
        throw e;
      }
    }
    const runId = `run_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const sourceIds = readable.map((s) => s.id);
    run(db,
      `INSERT INTO run (id, case_id, agent, instruction_version, instruction_hash, mode, model, base_version_id, input_source_ids_json,
         technical_state, started_at, scenario_stage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      runId, caseId, 'analyst', instruction.version, instruction.hash, client.mode, client.model, base.id, JSON.stringify(sourceIds), 'running',
      new Date().toISOString(), c.scenario_id ? c.scenario_stage : null);
    audit(db, caseId, AGENT_SYSTEM_ACTOR, 'run_started', { run_id: runId, base_version_id: base.id, mode: client.mode, model: client.model, sources: sourceIds.length });
    return { runId, caseId, base, sourceIds, input, startedMs: Date.now() };
  });
}

export function startAnalystRun(db: DB, caseId: string, client: AnalystClient, opts: RunOptions = {}): { runId: string; base: VersionRow; sourceIds: string[] } {
  const c = beginAnalystRun(db, caseId, client, opts);
  return { runId: c.runId, base: c.base, sourceIds: c.sourceIds };
}

export interface RunMeta {
  usage?: Usage;
  attempts?: number;
  costUsd?: number;
  durationMs?: number;
}

function writeMeta(db: DB, runId: string, m: RunMeta): void {
  run(db, `UPDATE run SET usage_json = ?, attempts = ?, cost_usd = ?, duration_ms = ? WHERE id = ?`,
    JSON.stringify(m.usage ?? {}), m.attempts ?? 1, m.costUsd ?? null, m.durationMs ?? null, runId);
}

export function failRun(db: DB, runId: string, error: string, meta: RunMeta = {}, violations: Violation[] = []): void {
  const r = one<{ case_id: string }>(db, 'SELECT case_id FROM run WHERE id = ?', runId);
  const msg = redact(error).slice(0, 2000);
  run(db, `UPDATE run SET technical_state = 'error', finished_at = ?, error = ?, violations_json = ? WHERE id = ? AND technical_state = 'running'`,
    new Date().toISOString(), msg, JSON.stringify(violations), runId);
  writeMeta(db, runId, meta);
  audit(db, r?.case_id ?? null, AGENT_SYSTEM_ACTOR, 'run_failed', { run_id: runId, error: msg.slice(0, 300) });
}

/** Запуски, що лишились у стані running після аварійного завершення застосунку, не можуть завершитись: позначаємо помилкою. */
export function recoverStuckRuns(db: DB): number {
  const stuck = all<{ id: string; case_id: string }>(db, `SELECT id, case_id FROM run WHERE technical_state = 'running'`);
  for (const r of stuck) failRun(db, r.id, 'Запуск перервано перезапуском застосунку. Поточну версію не змінено; запустіть аналіз знову.');
  return stuck.length;
}

/**
 * Приймає результат агента. Правила:
 *  • відповідь перевіряється (src/ai/verify.ts): схема, існування джерел, цитати, ID, «підтвердження» лише людиною;
 *  • правки аналітика не перезаписуються, конфлікти показуються;
 *  • якщо поки агент працював, з’явилася новіша версія, результат зберігається лише як ПРОПОЗИЦІЯ
 *    на застарілій основі й не стає поточною версією;
 *  • «опрацьованими» стають лише джерела, які справді були передані моделі.
 */
export function completeAnalystRun(db: DB, runId: string, rawOutput: unknown): VersionRow {
  return tx(db, () => {
    const r = one<{ case_id: string; base_version_id: string; technical_state: string; input_source_ids_json: string; mode: string }>(
      db, 'SELECT case_id, base_version_id, technical_state, input_source_ids_json, mode FROM run WHERE id = ?', runId);
    if (!r) throw new DomainError('NOT_FOUND', 'Запуск не знайдено', 404);
    if (r.technical_state !== 'running') throw new DomainError('BAD_STATE', 'Запуск уже завершено', 409);

    const caseId = r.case_id;
    const base = getVersion(db, r.base_version_id);
    const sourceIds = JSON.parse(r.input_source_ids_json) as string[];
    const caseSources = listSources(db, caseId);
    const maps = idMaps(caseSources.map((s) => ({ id: s.id, ref: s.ref })));
    const checked = verifyAgentOutput(rawOutput, {
      base: versionContent(base),
      sources: caseSources.filter((s) => sourceIds.includes(s.id)).map((s) => ({ id: s.id, text: s.content })),
      fromModel: maps.fromModel,
    });
    if (!checked.ok) {
      const sch = checked.violations.some((x) => x.code === 'SCHEMA');
      throw new DomainError('BAD_OUTPUT',
        `Відповідь агента ${sch ? 'не відповідає схемі' : 'не пройшла перевірку'}: ${formatViolations(checked.violations).slice(0, 4).join('; ')}`,
        422, { violations: checked.violations });
    }

    const head = headVersion(db, caseId);
    const isStale = head.id !== base.id;
    // Захист правок рахується від ПОТОЧНОЇ голови (там найновіші правки аналітика).
    const reference = isStale ? head : base;
    const owned = new Set<string>(JSON.parse(reference.owned_json) as string[]);
    const valid = new Set(caseSources.map((s) => s.id));
    const { content } = protectAnalystEdits(versionContent(reference), checked.content, owned, valid);
    const covered = [...new Set([...(JSON.parse(reference.covered_json) as string[]), ...sourceIds])];

    const v = insertVersion(db, {
      caseId, content, createdBy: 'agent', actorName: AGENT_SYSTEM_ACTOR.name, parentId: reference.id, covered, owned: [...owned],
      runId, kind: isStale ? 'proposal' : 'head_line', mode: r.mode,
      note: isStale ? 'Пропозиція на застарілій основі: поки агент працював, з’явилася новіша версія' : 'Результат запуску агента',
    });
    if (!isStale) {
      run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', v.id, caseId);
      const c = getCase(db, caseId);
      // зміст змінився — погодження втрачає чинність
      if (c.state !== 'research') returnAfterAgentChange(db, caseId);
    }
    run(db, `UPDATE run SET technical_state = 'done', finished_at = ?, output_version_id = ?, checks_json = ? WHERE id = ?`,
      new Date().toISOString(), v.id, JSON.stringify({ warnings: checked.warnings, stale: isStale }), runId);
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

const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
function addUsage(a: Usage, b?: Usage): Usage {
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

export type RunResult = { ok: true; runId: string; version: VersionRow } | { ok: false; runId: string; error: string };

/**
 * Виконання: виклик (з тайм-аутом) → перевірка → результат. Одна автоматична повторна спроба — лише для
 * тимчасових збоїв і для відповідей, що не пройшли перевірку (з переліком порушень у запиті).
 * Збій у будь-якому місці не змінює поточну версію, погодження й стан.
 */
export async function executeAnalystRun(db: DB, ctx: RunCtx, client: AnalystClient, opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? opts.policy?.timeoutMs ?? 180_000;
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 2, 2));
  let usage: Usage = { ...ZERO };
  let attempts = 0;
  let lastError = 'невідома помилка';
  let lastViolations: Violation[] = [];
  const meta = (): RunMeta => ({
    usage, attempts, durationMs: Date.now() - ctx.startedMs,
    costUsd: client.mode === 'real' && opts.policy ? actualCostUsd(opts.policy, usage) : undefined,
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && client.mode === 'real' && opts.policy) {
      try {
        // перед повтором бюджет перевіряється з урахуванням уже витраченого цим запуском
        const spent = actualCostUsd(opts.policy, usage);
        run(db, `UPDATE run SET cost_usd = ? WHERE id = ?`, spent, ctx.runId);
        const chars = ctx.input.instruction.text.length + buildUserMessage(ctx.input).length;
        preflight(db, ctx.caseId, opts.policy, chars, new Date(), { alreadyUsd: spent });
      } catch (e) {
        lastError = (e instanceof Error ? e.message : String(e)) + ' Повторну спробу не виконано.';
        break;
      }
    }
    attempts = attempt;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let retryNote: string[] | undefined;
    try {
      const out = await Promise.race([
        client.analyze(ctx.input, ctrl.signal),
        new Promise<never>((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new ModelFailure('timeout', 'тайм-аут запуску')))),
      ]);
      clearTimeout(timer);
      usage = addUsage(usage, out.usage);
      try {
        const version = completeAnalystRun(db, ctx.runId, out.output);
        writeMeta(db, ctx.runId, meta());
        return { ok: true, runId: ctx.runId, version };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (e instanceof DomainError && e.code === 'BAD_OUTPUT') {
          lastViolations = ((e.details as { violations?: Violation[] } | undefined)?.violations) ?? [];
          retryNote = formatViolations(lastViolations);
        } else break;
      }
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ModelFailure) {
        usage = addUsage(usage, e.usage);
        lastError = e.message;
        if (!e.retryable) break;
        retryNote = e.kind === 'invalid_json' ? ['Відповідь не була коректним JSON-об’єктом за схемою.'] : undefined;
      } else {
        lastError = redact(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    if (attempt < maxAttempts) ctx.input = { ...ctx.input, retry_feedback: retryNote };
  }
  failRun(db, ctx.runId, lastError, meta(), lastViolations);
  return { ok: false, runId: ctx.runId, error: lastError };
}

/** Повний цикл (початок + виконання); використовується тестами й синхронними сценаріями. */
export async function runAnalyst(db: DB, caseId: string, client: AnalystClient, opts: RunOptions = {}): Promise<RunResult> {
  const ctx = beginAnalystRun(db, caseId, client, opts);
  return executeAnalystRun(db, ctx, client, opts);
}

export function listRuns(db: DB, caseId: string) {
  return all(db, 'SELECT * FROM run WHERE case_id = ? ORDER BY started_at', caseId);
}

export type { Content };
