/**
 * Запуск агента 2 (смислова перевірка) і довіре збереження її результату — зріз 3b-2.
 *
 * ЩО ЦЕ Й НЕ Є.
 *  • Це керування запуском: серверний дозвіл → пакет із бази → (підтверджена нотація → unsupported БЕЗ моделі) → бюджет →
 *    виклик клієнта → незмінний запис результату в `bpmn_review`.
 *  • Це НЕ генерація схеми: генератор (`src/bpmn/`) звідси не викликається й не імпортується (тест `bpmn-isolation`).
 *    Блокувальні знахідки лишають запуск «в очікуванні» — рішень аналітика (3b-3) ще немає, обходу немає.
 *  • Довіра до результату — це серверний запис у базі + повторна програмна перевірка збереженої відповіді (`reissueReview`),
 *    а не пам'ять процесу (`WeakSet` у `generationGate` лише додатковий запобіжник). Від браузера результат перевірки не приймається:
 *    жоден маршрут не має на вході знахідок, висновку чи стану.
 *  • Після перезапуску незавершений запуск стає помилкою (`recoverStuckRuns`), платно його ніхто не повторює; завершена перевірка
 *    відновлюється читанням запису БЕЗ виклику моделі.
 */
import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import {
  audit, bpmnGuard, currentApproval, getVersion, headVersion, listSources, requireHuman, verifyVersionIntegrity, versionContent,
  type Actor,
} from './domain.ts';
import { canonical, sha256 } from './hash.ts';
import { NOTATION_KIND_LABEL, type Content } from './schema.ts';
import { actualCostUsd, preflight, reserveRetry, type ModelPolicy } from './ai/budget.ts';
import {
  buildReviewMessage, findingKey, generationGate, contentFingerprint, reissueReview, reviewJsonSchema, reviewOutcome, runBpmnReview,
  type AttemptCost, type BpmnReviewClient, type GateResult, type ReviewFinding, type ReviewPackage, type ReviewResult,
} from './ai/bpmn-review.ts';
import { loadBpmnInstruction } from './ai/prompt.ts';
import type { InstructionInfo, Usage } from './ai/types.ts';
import { redact } from './ai/redact.ts';
import { ZERO, addUsage, failRun, writeMeta, type RunMeta } from './runs.ts';
import type { Violation } from './ai/verify.ts';

const SYSTEM_ACTOR: Actor = { kind: 'agent', name: 'bpmn-review-agent' };

/** Запас на список порушень у повторному запиті (резерв під повтор рахується з ним). */
const RETRY_FEEDBACK_MARGIN_CHARS = 4000;

let reviewSchemaCache: number | null = null;
/** Розмір JSON-схеми відповіді агента 2 — для оцінки вартості (бюджет спільний, схеми різні). */
export function reviewSchemaChars(): number {
  if (reviewSchemaCache === null) reviewSchemaCache = JSON.stringify(reviewJsonSchema()).length;
  return reviewSchemaCache;
}

export interface Reviewer {
  client: BpmnReviewClient;
  /** Обов'язкова для справжнього клієнта: ліміти й ціни (спільні з агентом 1). */
  policy?: ModelPolicy;
  instruction: InstructionInfo;
  timeoutMs?: number;
}

export type ReviewOutcome = 'clear' | 'awaiting_analyst' | 'unsupported' | 'stale';

export interface UnsupportedRequirement { id: string; kind: string; label: string; step_id: string; detail: string; evidence_quote: string }

/** Підтверджені вимоги до нотації (D61): вони означають unsupported без моделі. */
export function confirmedRequirements(content: Content): UnsupportedRequirement[] {
  return (content.notation_requirements ?? [])
    .filter((r) => r.status === 'confirmed')
    .map((r) => ({ id: r.id, kind: r.kind, label: NOTATION_KIND_LABEL[r.kind], step_id: r.step_id, detail: r.detail, evidence_quote: r.evidence_quote }));
}

export function unsupportedExplanation(reqs: UnsupportedRequirement[]): string {
  const lines = reqs.map((r) => `• ${r.label} (крок ${r.step_id}): ${r.detail}${r.evidence_quote ? ` — цитата джерела: «${r.evidence_quote}»` : ''}`);
  return `Підтверджено вимогу до нотації, якої інструмент v1 не будує (D21). Схему не будуємо й не спрощуємо; погодження AS-IS лишається чинним.\n${lines.join('\n')}`;
}

// ───────────────────────── запис результату ─────────────────────────

const RECORD_FIELDS = [
  'id', 'run_id', 'case_id', 'outcome', 'version_id', 'approval_id', 'content_hash', 'content_fingerprint', 'instruction_version',
  'instruction_hash', 'client_mode', 'client_model', 'response_json', 'findings_json', 'warnings_json', 'attempts_json', 'detail_json', 'created_at',
] as const;

interface RecordRow {
  id: string; run_id: string; case_id: string; outcome: ReviewOutcome; version_id: string; approval_id: string; content_hash: string;
  content_fingerprint: string; instruction_version: string; instruction_hash: string; client_mode: string; client_model: string;
  response_json: string | null; findings_json: string; warnings_json: string; attempts_json: string; detail_json: string; created_at: string;
  record_hash: string;
}

/** Хеш цілісності запису: будь-яка зміна поля без перерахунку хеша виявляється. Це контроль цілісності, не підпис (див. docs/slice-3b-plan.md). */
export function recordHash(r: Omit<RecordRow, 'record_hash'>): string {
  const o: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) o[k] = r[k];
  return sha256(canonical(o));
}

function insertRecord(db: DB, r: Omit<RecordRow, 'record_hash'>): void {
  run(db,
    `INSERT INTO bpmn_review (id, run_id, case_id, outcome, version_id, approval_id, content_hash, content_fingerprint, instruction_version,
       instruction_hash, client_mode, client_model, response_json, findings_json, warnings_json, attempts_json, detail_json, created_at, record_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    r.id, r.run_id, r.case_id, r.outcome, r.version_id, r.approval_id, r.content_hash, r.content_fingerprint, r.instruction_version,
    r.instruction_hash, r.client_mode, r.client_model, r.response_json, r.findings_json, r.warnings_json, r.attempts_json, r.detail_json, r.created_at, recordHash(r));
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

// ───────────────────────── актуальність ─────────────────────────

/** Причини, чому результат для (погодження, версія, хеш) уже не чинний. Порожній список = чинний. */
export function staleReasons(db: DB, caseId: string, approvalId: string, versionId: string, contentHash: string): string[] {
  const reasons: string[] = [];
  const cur = currentApproval(db, caseId);
  if (!cur) reasons.push('Погодження скасовано або відсутнє.');
  else if (cur.id !== approvalId) reasons.push('З’явилося нове погодження: погоджена версія змінилась.');
  else if (cur.version_id !== versionId || cur.content_hash !== contentHash) reasons.push('Погоджена версія чи її хеш не збігаються з тими, для яких виконано перевірку.');
  if (headVersion(db, caseId).id !== versionId) reasons.push('З’явилася новіша версія AS-IS.');
  // Серверний дозвіл (джерела, питання, потік, хеш…) — без урахування активного запуску.
  for (const r of bpmnGuard(db, caseId, { ignoreActiveRun: true }).reasons) reasons.push(`${r.code}: ${r.message}`);
  return [...new Set(reasons)];
}

// ───────────────────────── початок запуску ─────────────────────────

export interface ReviewCtx {
  runId: string;
  caseId: string;
  approvalId: string;
  pkg: ReviewPackage;
  startedMs: number;
  /** Резерв першої спроби (найгірша оцінка); 0 для не-справжніх клієнтів. */
  reservedUsd: number;
}

export type ReviewStart =
  | { kind: 'unsupported'; runId: string; reviewId: string; explanation: string }
  | { kind: 'started'; ctx: ReviewCtx };

const REFUSAL_CODES = ['INPUT_TOO_LARGE', 'RUN_LIMIT_CASE', 'RUN_LIMIT_DAY', 'BUDGET_PER_RUN', 'BUDGET_TOTAL', 'REAL_DATA_BLOCKED', 'AI_UNAVAILABLE', 'GUARD_FAILED'];

/**
 * Перевіряє серверний дозвіл (чинне погодження, версія, хеш, програмні блокери), завантажує пакет З БАЗИ і:
 *  • якщо є підтверджена непідтримувана нотація — одразу фіксує `unsupported` (модель не потрібна й не викликається);
 *  • інакше резервує бюджет і створює запуск. Без налаштованого клієнта смислову перевірку не імітуємо (D32).
 * Усе — в одній транзакції: перевірка й резервування атомарні.
 */
export function beginBpmnReview(db: DB, actor: Actor, caseId: string, reviewer?: Reviewer): ReviewStart {
  requireHuman(actor, 'запуск смислової перевірки BPMN');
  try {
    return tx(db, () => {
      const g = bpmnGuard(db, caseId);
      if (!g.ok) throw new DomainError('GUARD_FAILED', 'Запуск смислової перевірки заблоковано сервером.', 409, { reasons: g.reasons });
      const approval = currentApproval(db, caseId)!;
      const version = getVersion(db, approval.version_id);
      const content = versionContent(version);
      const pkg: ReviewPackage = { versionId: version.id, contentHash: version.content_hash, content };
      const instruction = reviewer?.instruction ?? loadBpmnInstruction();
      const startedAt = new Date().toISOString();
      const fp = contentFingerprint(content);

      const reqs = confirmedRequirements(content);
      if (reqs.length > 0) {
        const runId = newId('run');
        run(db,
          `INSERT INTO run (id, case_id, agent, instruction_version, instruction_hash, mode, model, base_version_id, input_approval_id,
             input_source_ids_json, technical_state, started_at, finished_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          runId, caseId, 'bpmn', instruction.version, instruction.hash, 'none', 'немає (модель не викликалась)', version.id, approval.id,
          version.covered_json, 'done', startedAt, startedAt, 'unsupported: підтверджена вимога до нотації; модель не викликалась');
        const reviewId = newId('rev');
        insertRecord(db, {
          id: reviewId, run_id: runId, case_id: caseId, outcome: 'unsupported', version_id: version.id, approval_id: approval.id,
          content_hash: version.content_hash, content_fingerprint: fp, instruction_version: instruction.version, instruction_hash: instruction.hash,
          client_mode: 'none', client_model: 'немає (модель не викликалась)', response_json: null, findings_json: '[]', warnings_json: '[]',
          attempts_json: JSON.stringify({ attempts: 0, usage: [], failedAttempts: [], attemptCosts: [] }),
          detail_json: JSON.stringify({ requirements: reqs }), created_at: startedAt,
        });
        run(db, `UPDATE run SET checks_json = ? WHERE id = ?`, JSON.stringify({ review_id: reviewId, outcome: 'unsupported' }), runId);
        audit(db, caseId, actor, 'bpmn_review_unsupported', { run_id: runId, review_id: reviewId, requirements: reqs.map((r) => r.id) });
        return { kind: 'unsupported' as const, runId, reviewId, explanation: unsupportedExplanation(reqs) };
      }

      if (!reviewer) {
        throw new DomainError('AI_UNAVAILABLE',
          'Смислову перевірку виконує модель. Застосунок працює без підключеної моделі (деморежим), а демо-відповіді для цієї перевірки не вигадуються: запуск не виконано.', 409);
      }
      let reservedUsd = 0;
      if (reviewer.client.mode === 'real') {
        if (listSources(db, caseId).some((s) => s.read_status === 'ok' && s.origin === 'real')) {
          throw new DomainError('REAL_DATA_BLOCKED',
            'У кейсі є джерела з позначкою «реальні дані». У цьому прототипі вони й похідні від них дані не надсилаються постачальнику моделі (D18). Запуск не виконано.', 409);
        }
        if (!reviewer.policy) throw new DomainError('AI_UNAVAILABLE', 'Для справжньої моделі не задано ліміти й ціни; запуск не виконано.', 409);
        const chars = instruction.text.length + buildReviewMessage({ instruction, pkg }).length;
        reservedUsd = preflight(db, caseId, reviewer.policy, chars, new Date(), reviewSchemaChars()).worstCaseUsd;
      }
      const runId = newId('run');
      run(db,
        `INSERT INTO run (id, case_id, agent, instruction_version, instruction_hash, mode, model, base_version_id, input_approval_id,
           input_source_ids_json, technical_state, started_at, reserved_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId, caseId, 'bpmn', instruction.version, instruction.hash, reviewer.client.mode, reviewer.client.model, version.id, approval.id,
        version.covered_json, 'running', startedAt, reservedUsd);
      audit(db, caseId, actor, 'bpmn_review_started', { run_id: runId, approval_id: approval.id, version_id: version.id, mode: reviewer.client.mode, model: reviewer.client.model });
      return { kind: 'started' as const, ctx: { runId, caseId, approvalId: approval.id, pkg, startedMs: Date.now(), reservedUsd } };
    });
  } catch (e) {
    if (e instanceof DomainError && REFUSAL_CODES.includes(e.code)) audit(db, caseId, SYSTEM_ACTOR, 'bpmn_review_refused', { code: e.code });
    throw e;
  }
}

// ───────────────────────── виконання ─────────────────────────

export type ReviewRunResult =
  | { ok: true; runId: string; reviewId: string; outcome: ReviewOutcome }
  | { ok: false; runId: string; error: string };

const sumUsage = (u: readonly Usage[]): Usage => u.reduce<Usage>((a, x) => addUsage(a, x), { ...ZERO });

/**
 * Виклик клієнта (з бюджетом на кожну спробу) → програмна перевірка відповіді → незмінний запис. Збій у будь-якому місці:
 * запуск `error`, запису результату немає, стан кейсу, версії й погодження не змінюються (D32).
 */
export async function executeBpmnReview(db: DB, ctx: ReviewCtx, reviewer: Reviewer): Promise<ReviewRunResult> {
  const { client, policy, instruction } = reviewer;
  const real = client.mode === 'real' && !!policy;
  const reserves: number[] = [ctx.reservedUsd];
  const retryChars = instruction.text.length + buildReviewMessage({ instruction, pkg: ctx.pkg }).length + RETRY_FEEDBACK_MARGIN_CHARS;
  const split = (costs: readonly AttemptCost[]): { known: number; unknown: number } => {
    let known = 0;
    let unknown = 0;
    for (const c of costs) {
      if (c.billing === 'known' && c.usage) known += actualCostUsd(policy!, c.usage);
      else if (c.billing === 'unknown') unknown += reserves[c.attempt - 1] ?? 0;
    }
    return { known, unknown };
  };
  const metaOf = (usage: readonly Usage[], attempts: number, costs: readonly AttemptCost[]): RunMeta => {
    const s = real ? split(costs) : null;
    return { usage: sumUsage(usage), attempts, durationMs: Date.now() - ctx.startedMs, cost: s ? { knownUsd: s.known, unknownReserveUsd: s.unknown } : undefined };
  };

  let result: ReviewResult;
  try {
    result = await runBpmnReview(client, instruction, ctx.pkg, {
      timeoutMs: reviewer.timeoutMs ?? policy?.timeoutMs,
      maxAttempts: 2,
      beforeAttempt: (attempt, costs) => {
        if (!real || attempt === 1) return;
        const s = split(costs);
        // Резерв повтору атомарний і враховує спільний бюджет обох агентів, ліміт на запуск (з повтором) і невідому вартість першої спроби.
        reserves[attempt - 1] = reserveRetry(db, ctx.runId, policy!, retryChars, s.known, s.unknown, reviewSchemaChars());
      },
    });
  } catch (e) {
    // runBpmnReview не має кидати; якщо кинув — вважаємо вартість невідомою й резерв не звільняємо.
    const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 500);
    failRun(db, ctx.runId, `Збій смислової перевірки: ${msg}`, real ? { attempts: 1, durationMs: Date.now() - ctx.startedMs, cost: { knownUsd: 0, unknownReserveUsd: ctx.reservedUsd } } : undefined);
    return { ok: false, runId: ctx.runId, error: msg };
  }

  const meta = metaOf(result.usage, result.attempts, result.attemptCosts);
  if (result.status === 'failed') {
    failRun(db, ctx.runId, result.message, meta, [...result.violations] as Violation[]);
    audit(db, ctx.caseId, SYSTEM_ACTOR, 'bpmn_review_failed', { run_id: ctx.runId, kind: result.kind });
    return { ok: false, runId: ctx.runId, error: result.message };
  }

  try {
    return tx(db, () => {
      const state = one<{ technical_state: string }>(db, 'SELECT technical_state FROM run WHERE id = ?', ctx.runId)?.technical_state;
      if (state !== 'running') throw new DomainError('BAD_STATE', 'Запуск уже не виконується: результат не зберігається.', 409);
      const stale = staleReasons(db, ctx.caseId, ctx.approvalId, ctx.pkg.versionId, ctx.pkg.contentHash);
      const outcome: ReviewOutcome = stale.length > 0 ? 'stale' : reviewOutcome(result.findings);
      const reviewId = newId('rev');
      const createdAt = new Date().toISOString();
      insertRecord(db, {
        id: reviewId, run_id: ctx.runId, case_id: ctx.caseId, outcome, version_id: ctx.pkg.versionId, approval_id: ctx.approvalId,
        content_hash: ctx.pkg.contentHash, content_fingerprint: result.binding.contentFingerprint,
        instruction_version: result.binding.instructionVersion, instruction_hash: result.binding.instructionHash,
        client_mode: result.binding.clientMode, client_model: result.binding.clientModel,
        response_json: JSON.stringify(result.response), findings_json: JSON.stringify(result.findings), warnings_json: JSON.stringify(result.warnings),
        attempts_json: JSON.stringify({ attempts: result.attempts, usage: result.usage, failedAttempts: result.failedAttempts, attemptCosts: result.attemptCosts }),
        detail_json: JSON.stringify(stale.length > 0 ? { stale_reasons: stale } : {}), created_at: createdAt,
      });
      run(db, `UPDATE run SET technical_state = 'done', finished_at = ?, checks_json = ? WHERE id = ?`, createdAt, JSON.stringify({ review_id: reviewId, outcome }), ctx.runId);
      writeMeta(db, ctx.runId, meta);
      audit(db, ctx.caseId, SYSTEM_ACTOR, outcome === 'stale' ? 'bpmn_review_saved_stale' : 'bpmn_review_completed', { run_id: ctx.runId, review_id: reviewId, outcome, findings: result.findings.length });
      return { ok: true as const, runId: ctx.runId, reviewId, outcome };
    });
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 500);
    failRun(db, ctx.runId, `Не вдалося зберегти результат перевірки: ${msg}`, meta);
    return { ok: false, runId: ctx.runId, error: msg };
  }
}

/** Повний цикл (початок + виконання) для тестів і синхронних сценаріїв. */
export async function runBpmnReviewForCase(db: DB, actor: Actor, caseId: string, reviewer?: Reviewer): Promise<ReviewRunResult | { ok: true; runId: string; reviewId: string; outcome: 'unsupported'; explanation: string }> {
  const start = beginBpmnReview(db, actor, caseId, reviewer);
  if (start.kind === 'unsupported') return { ok: true, runId: start.runId, reviewId: start.reviewId, outcome: 'unsupported', explanation: start.explanation };
  return executeBpmnReview(db, start.ctx, reviewer!);
}

// ───────────────────────── відновлення з довіреного запису ─────────────────────────

export type ReviewState = 'none' | 'running' | 'failed' | 'unsupported' | 'awaiting_analyst' | 'clear' | 'stale' | 'untrusted';

export interface CaseReview {
  state: ReviewState;
  runId?: string;
  reviewId?: string;
  createdAt?: string;
  /** Відновлений (повторно перевірений кодом) результат: лише для `clear` і `awaiting_analyst`. */
  review?: Extract<ReviewResult, { status: 'completed' }>;
  /** Рішення шлюзу до генерації. Генерація можлива лише коли `gate.ok`. */
  gate?: GateResult;
  findings?: readonly ReviewFinding[];
  /** Знахідки з ключем, рішенням людини (якщо є) і тим, чи вони блокують далі. */
  findingsView?: FindingView[];
  warnings?: readonly string[];
  requirements?: UnsupportedRequirement[];
  /** Рішення аналітикині щодо знахідок саме цього запису перевірки. */
  resolutions?: ResolutionRow[];
  /** Рішення з попередніх записів перевірки того ж кейсу — лише контекст (D31), на шлюз не впливають. */
  earlierResolutions?: ResolutionRow[];
  /** Чому результат застарів або запису не довіряємо. */
  reasons?: string[];
  error?: string;
}

type Trusted = { ok: true; row: RecordRow } | { ok: false; reasons: string[] };

/** Перевіряє цілісність запису й узгодженість із запуском, погодженням і версією. Нічого не викликає й не змінює. */
function checkRecord(db: DB, row: RecordRow): Trusted {
  const bad: string[] = [];
  const { record_hash, ...rest } = row;
  if (recordHash(rest) !== record_hash) bad.push('Хеш запису не збігається зі змістом: запис змінено.');
  const runRow = one<{ case_id: string; agent: string; technical_state: string; mode: string; model: string; instruction_version: string; instruction_hash: string | null; input_approval_id: string | null; base_version_id: string | null }>(
    db, 'SELECT case_id, agent, technical_state, mode, model, instruction_version, instruction_hash, input_approval_id, base_version_id FROM run WHERE id = ?', row.run_id);
  if (!runRow) bad.push('Запуску, до якого належить запис, немає в журналі.');
  else {
    if (runRow.agent !== 'bpmn' || runRow.case_id !== row.case_id) bad.push('Запуск належить іншому агентові чи кейсу.');
    if (runRow.mode !== row.client_mode || runRow.model !== row.client_model) bad.push('Режим чи модель у записі не збігаються з журналом запуску.');
    if (runRow.instruction_version !== row.instruction_version || runRow.instruction_hash !== row.instruction_hash) bad.push('Інструкція в записі не збігається з журналом запуску.');
    if (runRow.input_approval_id !== row.approval_id || runRow.base_version_id !== row.version_id) bad.push('Погодження чи версія в записі не збігаються з журналом запуску.');
  }
  const appr = one<{ case_id: string; version_id: string; content_hash: string }>(db, 'SELECT case_id, version_id, content_hash FROM approval WHERE id = ?', row.approval_id);
  if (!appr || appr.case_id !== row.case_id || appr.version_id !== row.version_id || appr.content_hash !== row.content_hash) bad.push('Погодження в записі не існує або не збігається з версією й хешем.');
  try {
    const v = getVersion(db, row.version_id);
    if (v.case_id !== row.case_id || v.content_hash !== row.content_hash) bad.push('Хеш версії в записі не збігається з версією в базі.');
    if (!verifyVersionIntegrity(db, row.version_id)) bad.push('Цілісність версії порушена (хеш не відповідає змісту).');
    if (contentFingerprint(versionContent(v)) !== row.content_fingerprint) bad.push('Відбиток змісту не збігається зі змістом версії.');
  } catch {
    bad.push('Версії, до якої належить запис, немає.');
  }
  return bad.length > 0 ? { ok: false, reasons: bad } : { ok: true, row };
}

/**
 * Поточний стан смислової перевірки для кейсу, відновлений із ДОВІРЕНОГО серверного запису. Без виклику моделі й без вхідних даних
 * від користувача. Завершена перевірка проходить: перевірку цілісності запису → узгодженість із запуском/погодженням/версією →
 * актуальність → повторну програмну перевірку збереженої відповіді (`reissueReview`) → шлюз `generationGate`.
 */
export function getCaseReview(db: DB, caseId: string, instruction: InstructionInfo = loadBpmnInstruction()): CaseReview {
  const last = one<{ id: string; technical_state: string; error: string | null }>(
    db, `SELECT id, technical_state, error FROM run WHERE case_id = ? AND agent = 'bpmn' AND technical_state <> 'not_implemented' ORDER BY started_at DESC, rowid DESC LIMIT 1`, caseId);
  if (!last) return { state: 'none' };
  if (last.technical_state === 'running' || last.technical_state === 'queued') return { state: 'running', runId: last.id };
  if (last.technical_state === 'error') return { state: 'failed', runId: last.id, error: last.error ?? undefined };

  const row = one<RecordRow>(db, 'SELECT * FROM bpmn_review WHERE run_id = ?', last.id);
  const untrusted = (reasons: string[]): CaseReview => ({ state: 'untrusted', runId: last.id, reviewId: row?.id, reasons });
  if (!row || row.case_id !== caseId) return untrusted(['Запуск завершено, але запису результату немає.']);
  const t = checkRecord(db, row);
  if (!t.ok) return untrusted(t.reasons);

  const base = { runId: last.id, reviewId: row.id, createdAt: row.created_at };
  const stale = row.outcome === 'stale'
    ? (JSON.parse(row.detail_json) as { stale_reasons?: string[] }).stale_reasons ?? ['Результат збережено як застарілий.']
    : staleReasons(db, caseId, row.approval_id, row.version_id, row.content_hash);
  if (stale.length > 0) return { state: 'stale', ...base, reasons: stale };

  const version = getVersion(db, row.version_id);
  const pkg: ReviewPackage = { versionId: version.id, contentHash: version.content_hash, content: versionContent(version) };

  if (row.outcome === 'unsupported') {
    const reqs = confirmedRequirements(pkg.content);
    const stored = (JSON.parse(row.detail_json) as { requirements?: UnsupportedRequirement[] }).requirements ?? [];
    if (reqs.length === 0 || row.response_json !== null || row.client_mode !== 'none' || canonical(reqs) !== canonical(stored)) {
      return untrusted(['Запис unsupported не відповідає підтвердженим вимогам погодженої версії.']);
    }
    return { state: 'unsupported', ...base, requirements: reqs };
  }

  if (row.response_json === null) return untrusted(['У записі немає збереженої відповіді моделі.']);
  const att = JSON.parse(row.attempts_json) as { attempts: number; usage: Usage[]; failedAttempts: never[]; attemptCosts: AttemptCost[] };
  const restored = reissueReview({
    binding: {
      versionId: row.version_id, contentHash: row.content_hash, contentFingerprint: row.content_fingerprint, clientMode: row.client_mode as 'demo' | 'real',
      clientModel: row.client_model, instructionVersion: row.instruction_version, instructionHash: row.instruction_hash,
    },
    response: JSON.parse(row.response_json), attempts: att.attempts, usage: att.usage, failedAttempts: att.failedAttempts, attemptCosts: att.attemptCosts,
  }, pkg);
  if (!restored.ok) return untrusted([restored.reason]);
  const r = restored.result;
  if (canonical(r.findings) !== canonical(JSON.parse(row.findings_json)) || canonical(r.warnings) !== canonical(JSON.parse(row.warnings_json))) {
    return untrusted(['Знахідки в записі не збігаються з повторною перевіркою збереженої відповіді.']);
  }
  if (reviewOutcome(r.findings) !== row.outcome) return untrusted(['Висновок у записі не відповідає знахідкам.']);
  // Рішення читаються з незмінних записів сервера (не від браузера) і звіряються з відновленими знахідками.
  const mine = listResolutions(db, caseId).filter((x) => x.review_id === row.id);
  const resolved = new Set(mine.map((x) => x.finding_key));
  return {
    state: row.outcome as 'clear' | 'awaiting_analyst', ...base, review: r,
    gate: generationGate(r, pkg, instruction, resolved),
    findings: r.findings, findingsView: findingsView(r.findings, mine), warnings: r.warnings,
    resolutions: mine, earlierResolutions: listResolutions(db, caseId).filter((x) => x.review_id !== row.id),
  };
}

// ───────────────────────── рішення аналітикині щодо знахідок (3b-3, D31) ─────────────────────────

export interface ResolutionRow {
  id: string; case_id: string; review_id: string; run_id: string; approval_id: string; version_id: string;
  content_hash: string; finding_key: string; finding_json: string; decision: 'rejected'; explanation: string;
  decided_by: string; decided_at: string; record_hash: string;
}

const RESOLUTION_FIELDS = ['id', 'case_id', 'review_id', 'run_id', 'approval_id', 'version_id', 'content_hash',
  'finding_key', 'finding_json', 'decision', 'explanation', 'decided_by', 'decided_at'] as const;

/** Хеш цілісності рішення: контроль цілісності, не підпис (та сама межа, що й для запису перевірки). */
export function resolutionHash(r: Omit<ResolutionRow, 'record_hash'>): string {
  const o: Record<string, unknown> = {};
  for (const k of RESOLUTION_FIELDS) o[k] = r[k];
  return sha256(canonical(o));
}

export interface FindingView {
  key: string;
  finding: ReviewFinding;
  /** Чи ця знахідка сама по собі закриває шлюз, доки її не вирішено. */
  blocking: boolean;
  /** Чи її взагалі можна відхилити: `UNSUPPORTED_CANDIDATE` — ніколи (D21). */
  can_reject: boolean;
  resolution: ResolutionRow | null;
  /** Чому відхилити не можна (коли `can_reject` = false). */
  reject_blocked_reason: string | null;
}

export function findingsView(findings: readonly ReviewFinding[], resolutions: readonly ResolutionRow[]): FindingView[] {
  const byKey = new Map(resolutions.map((r) => [r.finding_key, r]));
  return findings.map((f) => {
    const unsupported = f.code === 'UNSUPPORTED_CANDIDATE';
    const key = findingKey(f);
    return {
      key, finding: f, blocking: unsupported || f.class === 'blocks_flow', can_reject: !unsupported && f.class === 'blocks_flow',
      resolution: byKey.get(key) ?? null,
      reject_blocked_reason: unsupported
        ? 'Кандидата на непідтримувану нотацію відхилити не можна (D21): схема не спрощується. Потрібне рішення щодо вимоги до нотації або зміна опису.'
        : f.class === 'blocks_flow' ? null : 'Зауваження не блокує потік: рішення не потрібне.',
    };
  });
}

export function listResolutions(db: DB, caseId: string): ResolutionRow[] {
  return all<ResolutionRow>(db, 'SELECT * FROM finding_resolution WHERE case_id = ? ORDER BY rowid', caseId);
}

export const MIN_EXPLANATION_CHARS = 10;

/**
 * Відхилення знахідки `blocks_flow` аналітикинею з обов'язковим поясненням (D31). Незмінний запис, прив'язаний до
 * конкретної знахідки (її ключ), запису перевірки, запуску, погодження, версії й хеша пакета.
 *
 * Чого ця дія НЕ робить: не змінює AS-IS, не скасовує погодження, не чіпає знахідку й не відкриває генерацію сама.
 * Шлюз і всі програмні перевірки виконуються заново при побудові (`buildArtifact`). `UNSUPPORTED_CANDIDATE` і
 * `informational` відхилити не можна. «Уточнити AS-IS» рішенням тут не є: це звичайна нова версія AS-IS.
 */
export function rejectFinding(db: DB, actor: Actor, caseId: string, args: { reviewId: string; findingKey: string; explanation: string }): ResolutionRow {
  requireHuman(actor, 'рішення щодо зауваження смислової перевірки');
  const explanation = args.explanation.trim();
  if (explanation.length < MIN_EXPLANATION_CHARS) {
    throw new DomainError('EXPLANATION_REQUIRED',
      `Щоб відхилити зауваження, потрібне пояснення (не менше ${MIN_EXPLANATION_CHARS} символів): чому ви вважаєте опис однозначним. Воно зберігається в історії й у звіті.`, 400);
  }
  if (explanation.length > 2000) throw new DomainError('VALIDATION', 'Пояснення задовге (максимум 2000 символів).', 400);
  return tx(db, () => {
    const r = getCaseReview(db, caseId);
    if (r.state !== 'awaiting_analyst') {
      throw new DomainError('BAD_STATE', 'Рішення приймаються лише тоді, коли перевірка завершена й чекає на вас. Поточний стан інший — відкрийте вкладку «Схема» й подивіться, що потрібно зробити.', 409);
    }
    if (r.reviewId !== args.reviewId) {
      throw new DomainError('REVIEW_MISMATCH', 'Рішення стосується іншої (не поточної) перевірки. Оновіть сторінку: показані зауваження могли змінитися.', 409);
    }
    const view = (r.findingsView ?? []).find((v) => v.key === args.findingKey);
    if (!view) throw new DomainError('NOT_FOUND', 'Такого зауваження в поточній перевірці немає. Оновіть сторінку.', 404);
    if (!view.can_reject) throw new DomainError('CANNOT_REJECT', view.reject_blocked_reason ?? 'Це зауваження відхилити не можна.', 409);
    if (view.resolution) throw new DomainError('ALREADY_DECIDED', 'Щодо цього зауваження рішення вже записано: змінити його не можна (запис незмінний).', 409);

    const rev = one<{ run_id: string; approval_id: string; version_id: string; content_hash: string }>(
      db, 'SELECT run_id, approval_id, version_id, content_hash FROM bpmn_review WHERE id = ?', args.reviewId)!;
    const row: Omit<ResolutionRow, 'record_hash'> = {
      id: newId('fres'), case_id: caseId, review_id: args.reviewId, run_id: rev.run_id, approval_id: rev.approval_id,
      version_id: rev.version_id, content_hash: rev.content_hash, finding_key: args.findingKey,
      finding_json: JSON.stringify(view.finding), decision: 'rejected', explanation,
      decided_by: actor.name, decided_at: new Date().toISOString(),
    };
    run(db,
      `INSERT INTO finding_resolution (id, case_id, review_id, run_id, approval_id, version_id, content_hash, finding_key,
         finding_json, decision, explanation, decided_by, decided_at, record_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.case_id, row.review_id, row.run_id, row.approval_id, row.version_id, row.content_hash, row.finding_key,
      row.finding_json, row.decision, row.explanation, row.decided_by, row.decided_at, resolutionHash(row));
    audit(db, caseId, actor, 'bpmn_finding_rejected', { review_id: args.reviewId, finding_key: args.findingKey, code: view.finding.code, explanation_chars: explanation.length });
    return { ...row, record_hash: resolutionHash(row) };
  });
}

/** Короткий перелік завершених запусків перевірки (для журналу/інтерфейсу). */
export function listBpmnReviews(db: DB, caseId: string): { id: string; run_id: string; outcome: ReviewOutcome; created_at: string }[] {
  return all(db, 'SELECT id, run_id, outcome, created_at FROM bpmn_review WHERE case_id = ? ORDER BY rowid', caseId);
}
