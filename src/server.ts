import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.ts';
import { DEMO_BANNER, type ModelConfig } from './config.ts';
import { DomainError } from './errors.ts';
import { sha256 } from './hash.ts';
import {
  acceptDraft, addQuestion, addNotationRequirement, decideNotationRequirement, removeNotationRequirement, decideStepProposal, decideStepProposals, relinkQuestion, unlinkQuestionFromMissingStep, addSource, addSourceFromFile, answerQuestion, approve, buildCard, createCase, getCase,
  listCases, listSources, previewOriginCorrection, applyOriginCorrection, requestBpmnStart, returnToResearch, saveAnalystVersion, setQuestionCritical, submitForApproval,
  type Actor, type EditFields,
} from './domain.ts';
import { LinkKind, type LinkKindT } from './schema.ts';
import { seedDemoCase } from './demo.ts';
import { redact } from './ai/redact.ts';
import { beginAnalystRun, executeAnalystRun, type RunOptions } from './runs.ts';
import { budgetLeftUsd, spentUsd, unknownCostRuns, type ModelPolicy } from './ai/budget.ts';
import type { AnalystClient, InstructionInfo, OutputContract } from './ai/types.ts';
import { beginBpmnReview, executeBpmnReview, getCaseReview, rejectFinding, type Reviewer } from './review-runs.ts';
import { buildArtifact, buildPreflight, getCaseArtifact, listCaseArtifacts, readArtifactCsv, readArtifactFile, technicalLimits, type ArtifactView } from './bpmn-artifacts.ts';
import { confirmStartLabel, previewStartLabel } from './start-label.ts';
import { addExplicitClarification, advanceScenario, createScenarioCase, scenarioInfo, TOTAL_STAGES } from './scenarios.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.svg': 'image/svg+xml',
};

export interface ServerOptions {
  db: DB;
  mode: 'demo' | 'real';
  /** Код доступу людини. Той, хто його знає, — «людина» (може погоджувати). Агенти його не мають. */
  accessCode: string;
  /** Підключення моделі. Немає — аналіз недоступний (з поясненням), на демо мовчки не перемикаємось. */
  analyst?: { client: AnalystClient; policy?: ModelPolicy; instruction?: InstructionInfo; contract?: OutputContract };
  /** Клієнт смислової перевірки агента 2 (лише справжній; у деморежимі його немає й перевірка не імітується). Підставного клієнта задають лише тести. */
  reviewer?: Reviewer;
  /** Параметри моделі для показу (без ключа). */
  modelInfo?: Pick<ModelConfig, 'model' | 'effort' | 'budgetTotalUsd' | 'budgetPerRunUsd'>;
}

export function sessionToken(accessCode: string): string {
  return sha256('cx-session:' + accessCode);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const ch of req) {
    size += (ch as Buffer).length;
    if (size > 5_000_000) throw new DomainError('VALIDATION', 'Запит завеликий', 413);
    chunks.push(ch as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new DomainError('VALIDATION', 'Тіло запиту має бути JSON-об’єктом', 400);
  }
}

const str = (v: unknown, name: string, required = true): string => {
  if (typeof v === 'string') return v;
  if (v === undefined && !required) return '';
  throw new DomainError('VALIDATION', `Поле «${name}» має бути текстом`, 400);
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function pickAffects(raw: unknown): { step_id: string; condition: string; kind?: LinkKindT }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new DomainError('VALIDATION', 'affects має бути списком', 400);
  return raw.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const kind = o.kind === undefined ? undefined : LinkKind.safeParse(o.kind);
    if (kind && !kind.success) throw new DomainError('VALIDATION', 'affects.kind має бути direction, unconfirmed_sequence, exception або step_detail', 400);
    return { step_id: str(o.step_id, 'affects.step_id'), condition: str(o.condition, 'affects.condition', false), ...(kind?.success ? { kind: kind.data } : {}) };
  });
}

function pickFields(raw: unknown): EditFields {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('VALIDATION', 'fields має бути об’єктом', 400);
  const r = raw as Record<string, unknown>;
  const out: EditFields = {};
  for (const k of ['summary', 'business_context', 'roles_text', 'steps_text', 'problems_text', 'process_name'] as const) {
    if (r[k] !== undefined) out[k] = str(r[k], k);
  }
  if (r.entry_step_id !== undefined) {
    if (r.entry_step_id !== null && typeof r.entry_step_id !== 'string') throw new DomainError('VALIDATION', 'entry_step_id має бути текстом або null', 400);
    out.entry_step_id = r.entry_step_id as string | null;
  }
  if (r.boundaries !== undefined) {
    const bd = r.boundaries as Record<string, unknown>;
    out.boundaries = {};
    for (const k of ['trigger', 'input', 'completion', 'result'] as const) {
      if (bd[k] !== undefined) out.boundaries[k] = str(bd[k], `boundaries.${k}`);
    }
  }
  return out;
}

/** URL запиту (для читання параметрів): той самий розбір, що й у маршрутизаторі. */
const url0 = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://localhost');

/**
 * Артефакт для інтерфейсу: метадані, карта «крок ↔ елемент», стан файлів і позначка застарілої схеми.
 * XML тут не передається: переглядач і завантаження беруть файл окремим маршрутом, де працюють серверні перевірки.
 */
function artifactJson(v: ArtifactView) {
  return {
    id: v.row.id, status: v.status, process_name: v.row.process_name, version_id: v.row.version_id,
    review_id: v.row.review_id, run_id: v.row.run_id, approval_id: v.row.approval_id, content_hash: v.row.content_hash,
    created_at: v.row.created_at, created_by: v.row.created_by, generator: v.row.generator,
    drawio_status: v.row.drawio_status, bpmn_sha256: v.row.bpmn_sha256, drawio_sha256: v.row.drawio_sha256,
    current: v.trusted && v.staleReasons.length === 0, label: v.label, trusted: v.trusted,
    untrusted_reasons: v.untrustedReasons, stale_reasons: v.staleReasons,
    downloads: v.downloads, map: v.map,
    // Таблиця й журнал кроків у картку не вкладаються (вони великі): таблиця — окремим файлом,
    // а тут лишається те, що потрібно людині для розуміння: хеш таблиці, версія скриптів, підпис події.
    detail: { ...v.detail, csv: undefined, pipeline_log: undefined },
    has_csv: typeof v.detail.csv === 'string',
    pipeline_version: v.detail.pipeline_version ?? null,
  };
}

/** Чи можна зараз будувати схему — без побічних дій (та сама функція, що й у самій побудові). */
function buildPreflightState(db: DB, caseId: string, instruction?: InstructionInfo) {
  const p = buildPreflight(db, caseId, instruction);
  return p.ok ? { ok: true as const } : { ok: false as const, code: p.code, message: p.message, reasons: p.reasons };
}

export function createApp(opts: ServerOptions): Server {
  const { db, mode } = opts;
  const token = sessionToken(opts.accessCode);
  const human: Actor = { kind: 'human', name: 'Аналітикиня' };

  /**
   * Доступність агента 2 (смислова перевірка) — окремо від агента 1: це різні агенти з різними клієнтами.
   * Деморежим перевірку не імітує (D32), тому без клієнта дія недоступна з поясненням, а не з підставною відповіддю.
   */
  function reviewerState() {
    const r = opts.reviewer;
    if (!r) {
      return {
        available: false, model: null,
        reason: mode === 'demo'
          ? 'Смислову перевірку опису виконує модель, а вона не підключена (деморежим). Демо-відповіді для цієї перевірки не вигадуються: без моделі схема не будується.'
          : 'Клієнт смислової перевірки не налаштовано.',
      };
    }
    return { available: true, model: r.client.model, reason: null };
  }

  function aiState() {
    const a = opts.analyst;
    if (!a) {
      return {
        available: false, kind: 'none',
        reason: mode === 'demo'
          ? 'Застосунок працює в деморежимі: справжню модель не підключено. Щоб увімкнути, налаштуйте ключ і модель (docs/model-setup.md) та запустіть у режимі real.'
          : 'Модель не підключено.',
        review: reviewerState(),
      };
    }
    const p = a.policy;
    return {
      available: true, kind: a.client.mode === 'real' ? 'real' : 'scripted_demo', reason: null,
      review: reviewerState(),
      model: a.client.model, effort: opts.modelInfo?.effort ?? null, output_contract: a.contract ?? 'full',
      budget: p ? { total_usd: p.budgetTotalUsd, spent_usd: spentUsd(db), left_usd: budgetLeftUsd(db, p), unknown_cost_runs: unknownCostRuns(db), per_run_usd: p.budgetPerRunUsd, pricing_verified_at: p.pricingVerifiedAt } : null,
    };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    // Людиною вважається лише той, хто має сесійний cookie (отримується за кодом доступу).
    if (readCookie(req, 'cx_session') !== token) {
      json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Потрібен вхід: відкрийте посилання з кодом доступу з консолі запуску.' } });
      return;
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'cx') {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Відсутній заголовок захисту від підробки запитів' } });
      return;
    }
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/config') return json(res, 200, { mode, banner: mode === 'demo' ? DEMO_BANNER : null, ai: aiState() });
    if (method === 'GET' && path === '/api/scenarios') {
      return json(res, 200, { scenarios: [{ id: 'cx-preparation', title: 'Підготовка CX до продуктових змін', stages: TOTAL_STAGES, variants: ['positive', 'negative'] }] });
    }
    if (method === 'POST' && path === '/api/scenarios/cx-preparation') {
      const b = await readBody(req);
      const variant = b.variant === 'negative' ? 'negative' : b.variant === 'positive' ? 'positive' : null;
      if (!variant) throw new DomainError('VALIDATION', 'variant має бути positive або negative', 400);
      return json(res, 201, { case: createScenarioCase(db, human, variant, mode) });
    }
    if (method === 'GET' && path === '/api/cases') return json(res, 200, { cases: listCases(db) });
    if (method === 'POST' && path === '/api/cases') {
      const b = await readBody(req);
      return json(res, 201, { case: createCase(db, human, str(b.title, 'title'), mode) });
    }
    if (method === 'POST' && path === '/api/demo/seed') return json(res, 201, { case_id: seedDemoCase(db, mode) });

    if ((m = /^\/api\/cases\/([\w-]+)$/.exec(path)) && method === 'GET') {
      const card = buildCard(db, m[1]!, mode);
      return json(res, 200, { ...card, scenario: scenarioInfo(db, getCase(db, m[1]!)), ai: aiState() });
    }

    // Стан смислової перевірки відновлюється з довіреного серверного запису; вхідних даних від браузера немає.
    if ((m = /^\/api\/cases\/([\w-]+)\/bpmn\/review$/.exec(path)) && method === 'GET') {
      getCase(db, m[1]!);
      const r = getCaseReview(db, m[1]!, opts.reviewer?.instruction);
      // Технічні обмеження генератора — ДО платної перевірки: той самий розбір, що й на початку побудови,
      // виконується без моделі й без файлів (D86). Користувач бачить їх одразу, а не після оплати.
      const tech = technicalLimits(db, m[1]!);
      return json(res, 200, {
        state: r.state, run_id: r.runId ?? null, review_id: r.reviewId ?? null, created_at: r.createdAt ?? null,
        technical_limits: tech,
        findings: r.findings ?? [], warnings: r.warnings ?? [], requirements: r.requirements ?? [], reasons: r.reasons ?? [], error: r.error ?? null,
        // Знахідки з ключем, рішенням людини, тим, чи їх можна відхилити (D31; припущення про непідтримувану
        // нотацію — теж, за рішенням D84), і тим, де в пакеті знайдено цитату (довідка, D85).
        findings_view: (r.findingsView ?? []).map((v) => ({
          key: v.key, finding: v.finding, blocking: v.blocking, can_reject: v.can_reject,
          reject_blocked_reason: v.reject_blocked_reason, quote_from_step: v.quote_from_step, quote_locations: v.quote_locations,
          resolution: v.resolution ? { explanation: v.resolution.explanation, decided_by: v.resolution.decided_by, decided_at: v.resolution.decided_at } : null,
        })),
        earlier_resolutions: (r.earlierResolutions ?? []).map((x) => ({ explanation: x.explanation, decided_by: x.decided_by, decided_at: x.decided_at })),
        // Записи рішень, яким не довіряємо: блокування вони не знімають, причина названа.
        invalid_resolutions: (r.invalidResolutions ?? []).map((x) => ({ id: x.id, decided_at: x.decided_at, reasons: x.reasons })),
        generation_gate: r.gate ? (r.gate.ok ? { ok: true } : { ok: false, code: r.gate.code, message: r.gate.message }) : { ok: false, code: 'NO_COMPLETED_REVIEW', message: 'Немає завершеної й довіреної смислової перевірки.' },
      });
    }

    // Схема: метадані чинного артефакту + історія. Жодних даних від браузера; усі перевірки — на сервері.
    if ((m = /^\/api\/cases\/([\w-]+)\/bpmn\/artifact$/.exec(path)) && method === 'GET') {
      getCase(db, m[1]!);
      const cur = getCaseArtifact(db, m[1]!);
      const pre = buildPreflightState(db, m[1]!, opts.reviewer?.instruction);
      return json(res, 200, {
        artifact: cur ? artifactJson(cur) : null,
        history: listCaseArtifacts(db, m[1]!).map(artifactJson),
        can_build: pre.ok, build_block: pre.ok ? null : { code: pre.code, message: pre.message, reasons: pre.reasons ?? [] },
      });
    }

    // Файл віддається лише після серверних перевірок (цілісність запису, актуальність, власна перевірка файлу, хеш).
    if ((m = /^\/api\/cases\/([\w-]+)\/bpmn\/file\/(bpmn|drawio)$/.exec(path)) && method === 'GET') {
      getCase(db, m[1]!);
      const artifactId = url0(req).searchParams.get('artifact_id') ?? undefined;
      const f = readArtifactFile(db, m[1]!, m[2]! as 'bpmn' | 'drawio', artifactId);
      res.writeHead(200, {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${f.filename}"`,
        'x-content-sha256': f.sha256, 'cache-control': 'no-store',
      });
      res.end(f.xml);
      return;
    }

    // Таблиця, якою побудовано схему: той самий серверний контроль, що й для файлів схеми.
    if ((m = /^\/api\/cases\/([\w-]+)\/bpmn\/file\/csv$/.exec(path)) && method === 'GET') {
      getCase(db, m[1]!);
      const artifactId = url0(req).searchParams.get('artifact_id') ?? undefined;
      const f = readArtifactCsv(db, m[1]!, artifactId);
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${f.filename}"`,
        'x-content-sha256': f.sha256, 'cache-control': 'no-store',
      });
      res.end(f.csv);
      return;
    }

    if ((m = /^\/api\/cases\/([\w-]+)\/sources\/([\w-]+)$/.exec(path)) && method === 'GET') {
      const s = listSources(db, m[1]!).find((x) => x.id === m![2]);
      if (!s) throw new DomainError('NOT_FOUND', 'Джерело не знайдено', 404);
      return json(res, 200, { source: { id: s.id, title: s.title, kind: s.kind, content: s.content, read_status: s.read_status, read_error: s.read_error } });
    }

    if ((m = /^\/api\/cases\/([\w-]+)\/([\w/-]+)$/.exec(path)) && method === 'POST') {
      const caseId = m[1]!;
      const action = m[2]!;
      getCase(db, caseId);
      const b = await readBody(req);
      switch (action) {
        case 'sources': {
          // Походження вказується явно: мовчазна підстановка «синтетичне» могла б відправити моделі справжні дані.
          if (b.origin !== 'real' && b.origin !== 'synthetic') {
            throw new DomainError('VALIDATION', 'Вкажіть походження джерела: «синтетичне» або «реальні дані» (реальні дані моделі не надсилаються, D18).', 400);
          }
          const origin = b.origin;
          const kind = str(b.kind, 'kind') as 'request' | 'transcript' | 'document' | 'analyst_note' | 'clarification';
          const s = addSource(db, human, caseId, { kind, title: str(b.title, 'title'), content: str(b.content, 'content'), origin, required: b.required === true });
          return json(res, 201, { source_id: s.id });
        }
        case 'sources/file': {
          const origin = b.origin === 'real' || b.origin === 'synthetic' ? b.origin : 'synthetic';
          const bytes = Buffer.from(str(b.content_base64, 'content_base64'), 'base64');
          const s = addSourceFromFile(db, human, caseId, {
            name: str(b.name, 'name'), bytes, kind: str(b.kind, 'kind') as 'transcript', required: b.required === true, origin,
          });
          return json(res, 201, { source_id: s.id, read_status: s.read_status, read_error: s.read_error });
        }
        case 'versions': {
          const v = saveAnalystVersion(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'),
            fields: pickFields(b.fields),
            coverAllSources: b.cover_all_sources === true,
          });
          return json(res, 201, { version_id: v.id, number: v.number });
        }
        case 'questions': {
          const v = addQuestion(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), text: str(b.text, 'text'),
            critical: b.critical === true, impact: str(b.impact, 'impact', false), addressee: str(b.addressee, 'addressee', false),
            affects: pickAffects(b.affects),
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'questions/answer': {
          // Походження задає людина явно: ні тип кейсу, ні текст відповіді його не визначають (D77).
          const v = answerQuestion(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), questionId: str(b.question_id, 'question_id'),
            answer: str(b.answer, 'answer'), origin: b.origin as 'real' | 'synthetic',
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'sources/origin/preview': {
          // Лише показує, що буде перекласифіковано. Нічого не змінює.
          const p = previewOriginCorrection(db, caseId, {
            questionIds: Array.isArray(b.question_ids) ? (b.question_ids as unknown[]).map((x) => String(x)) : undefined,
            sourceIds: Array.isArray(b.source_ids) ? (b.source_ids as unknown[]).map((x) => String(x)) : undefined,
          });
          return json(res, 200, p);
        }
        case 'sources/origin/correct': {
          const r = applyOriginCorrection(db, human, caseId, {
            questionIds: Array.isArray(b.question_ids) ? (b.question_ids as unknown[]).map((x) => String(x)) : undefined,
            sourceIds: Array.isArray(b.source_ids) ? (b.source_ids as unknown[]).map((x) => String(x)) : undefined,
            confirmToken: str(b.confirm_token, 'confirm_token'), reason: str(b.reason, 'reason'),
          });
          return json(res, 201, { ...r, note: 'Текст уточнень, їхні зв’язки й історія версій не змінені; змінено лише позначку походження.' });
        }
        case 'questions/criticality': {
          const v = setQuestionCritical(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), questionId: str(b.question_id, 'question_id'),
            critical: b.critical === true, note: str(b.note, 'note'),
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'accept-draft':
          acceptDraft(db, human, caseId, str(b.version_id, 'version_id'));
          return json(res, 200, { ok: true });
        case 'submit':
          submitForApproval(db, human, caseId);
          return json(res, 200, { ok: true });
        case 'approve': {
          const a = approve(db, human, caseId, { versionId: str(b.version_id, 'version_id'), checklistConfirmed: b.checklist_confirmed === true, note: str(b.note, 'note', false) });
          return json(res, 201, { approval_id: a.id });
        }
        case 'return':
          returnToResearch(db, human, caseId, str(b.reason, 'reason'));
          return json(res, 200, { ok: true });
        case 'step-proposals/decide': {
          // Пов'язані пропозиції приймаються ОДНИМ явним рішенням: proposal_ids (лише accept). Інші пропозиції автоматично не чіпаються.
          const decision = b.decision === 'accept' ? 'accept' : b.decision === 'reject' ? 'reject' : (() => { throw new DomainError('VALIDATION', 'decision має бути accept або reject', 400); })();
          const previewHash = b.preview_hash === undefined ? undefined : str(b.preview_hash, 'preview_hash');
          if (Array.isArray(b.proposal_ids)) {
            if (decision !== 'accept') throw new DomainError('VALIDATION', 'Кілька пропозицій можна лише прийняти разом; відхиляйте по одній', 400);
            const v = decideStepProposals(db, human, caseId, {
              baseVersionId: str(b.base_version_id, 'base_version_id'), proposalIds: b.proposal_ids.map((x, i) => str(x, `proposal_ids[${i}]`)),
              note: str(b.note, 'note', false), previewHash, acknowledge: b.acknowledge === true,
            });
            return json(res, 201, { version_id: v.id });
          }
          const v = decideStepProposal(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), proposalId: str(b.proposal_id, 'proposal_id'), decision,
            note: str(b.note, 'note', false), previewHash, acknowledge: b.acknowledge === true,
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'questions/relink': {
          const v = relinkQuestion(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), questionId: str(b.question_id, 'question_id'), stepId: str(b.step_id, 'step_id'),
            condition: str(b.condition, 'condition', false), toKind: str(b.to_kind, 'to_kind') as LinkKindT, note: str(b.note, 'note'),
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'questions/unlink': {
          // Явне рішення людини: зняти прив'язку питання до кроку, якого в описі немає (D82).
          // Пояснення обов'язкове; для чинного кроку дія недоступна — це перевіряє домен.
          const v = unlinkQuestionFromMissingStep(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), questionId: str(b.question_id, 'question_id'),
            stepId: str(b.step_id, 'step_id'), condition: str(b.condition, 'condition', false), note: str(b.note, 'note'),
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'notation/add': {
          const v = addNotationRequirement(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), kind: str(b.kind, 'kind'), stepId: str(b.step_id, 'step_id'),
            detail: str(b.detail, 'detail'), evidenceSourceId: str(b.evidence_source_id, 'evidence_source_id', false), evidenceQuote: str(b.evidence_quote, 'evidence_quote', false),
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'notation/decide': {
          const v = decideNotationRequirement(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), requirementId: str(b.requirement_id, 'requirement_id'),
            decision: b.decision === 'confirm' ? 'confirm' : b.decision === 'reject' ? 'reject' : (() => { throw new DomainError('VALIDATION', 'decision має бути confirm або reject', 400); })(),
            note: str(b.note, 'note', false),
          });
          return json(res, 201, { version_id: v.id });
        }
        case 'notation/remove': {
          const v = removeNotationRequirement(db, human, caseId, { baseVersionId: str(b.base_version_id, 'base_version_id'), requirementId: str(b.requirement_id, 'requirement_id') });
          return json(res, 201, { version_id: v.id });
        }
        case 'scenario/next': {
          const r = advanceScenario(db, human, caseId);
          return json(res, 201, r);
        }
        case 'scenario/clarify': {
          const r = addExplicitClarification(db, human, caseId);
          return json(res, 201, r);
        }
        case 'analyze': {
          if (!opts.analyst) {
            throw new DomainError('AI_UNAVAILABLE', aiState().reason ?? 'Аналіз моделлю недоступний', 409);
          }
          if (getCase(db, caseId).state !== 'research') {
            throw new DomainError('BAD_STATE', 'Аналіз запускається лише на стадії «Дослідження». Спершу поверніть кейс на доопрацювання.', 409);
          }
          const ro: RunOptions = { policy: opts.analyst.policy, instruction: opts.analyst.instruction, contract: opts.analyst.contract };
          const ctx = beginAnalystRun(db, caseId, opts.analyst.client, ro);
          void executeAnalystRun(db, ctx, opts.analyst.client, ro).catch((e) => console.error('Помилка фонового запуску:', e instanceof Error ? e.message : 'невідома'));
          return json(res, 202, { run_id: ctx.runId, note: 'Аналіз запущено. Поточну версію не буде змінено, доки результат не пройде перевірки.' });
        }
        case 'start-label/preview': {
          // Що саме зміниться: показуємо повний тригер, запропонований підпис і наслідки — ДО рішення.
          return json(res, 200, { preview: previewStartLabel(db, caseId, str(b.label, 'label', false)) });
        }
        case 'start-label/confirm': {
          // Явне рішення людини про ПОДАННЯ (D88). Погоджений опис не змінюється: повний тригер лишається як є.
          const row = confirmStartLabel(db, human, caseId, { label: str(b.label, 'label'), reason: str(b.reason, 'reason') });
          return json(res, 201, {
            start_label_id: row.id, label: row.label,
            note: 'Підпис погоджено для цієї версії. Повний тригер не змінено: він лишається в описі й у деталях початкової події обох файлів.',
          });
        }
        case 'bpmn/start': {
          // Тіло запиту свідомо ігнорується: вхід агента 2 сервер бере з бази за чинним погодженням.
          const r = requestBpmnStart(db, human, caseId, mode);
          return json(res, 202, { permitted: true, run_id: r.runId, version_id: r.versionId, approval_id: r.approvalId,
            note: 'Дозвіл підтверджено сервером. Побудова виконується окремою дією після смислової перевірки (вкладка «Схема»).' });
        }
        case 'bpmn/findings/reject': {
          // Рішення людини: лише ключ знахідки й пояснення. Самої знахідки, висновку чи стану від браузера не приймаємо.
          const r = rejectFinding(db, human, caseId, {
            reviewId: str(b.review_id, 'review_id'), findingKey: str(b.finding_key, 'finding_key'), explanation: str(b.explanation, 'explanation'),
          });
          return json(res, 201, { resolution_id: r.id, note: 'Рішення записано незмінно. Програмні перевірки воно не скасовує: їх буде виконано заново при побудові.' });
        }
        case 'bpmn/build': {
          // Тіло свідомо ігнорується. Побудова ідемпотентна: повторний клік повертає той самий артефакт.
          const out = await buildArtifact(db, human, caseId, opts.reviewer?.instruction);
          return json(res, out.reused ? 200 : 201, { artifact: artifactJson(out.artifact), reused: out.reused });
        }
        case 'bpmn/review': {
          // Тіло свідомо ігнорується: ні знахідок, ні висновку, ні стану від браузера не приймаємо. Пакет бере сервер із бази.
          const start = beginBpmnReview(db, human, caseId, opts.reviewer);
          if (start.kind === 'unsupported') {
            return json(res, 200, { state: 'unsupported', run_id: start.runId, review_id: start.reviewId, explanation: start.explanation, note: 'Модель не викликалась. Погодження AS-IS лишається чинним.' });
          }
          void executeBpmnReview(db, start.ctx, opts.reviewer!).catch((e) => console.error('Помилка фонового запуску перевірки:', e instanceof Error ? e.message : 'невідома'));
          return json(res, 202, { run_id: start.ctx.runId, note: 'Смислову перевірку запущено. Схему не будується: це лише перевірка однозначності опису.' });
        }
        default:
      }
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Невідомий запит' } });
  }

  async function handleStatic(res: ServerResponse, path: string): Promise<void> {
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) return json(res, 404, { error: { code: 'NOT_FOUND', message: '' } });
    const ext = full.slice(full.lastIndexOf('.'));
    if (!MIME[ext]) return json(res, 404, { error: { code: 'NOT_FOUND', message: '' } });
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[ext]!, 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      json(res, 404, { error: { code: 'NOT_FOUND', message: '' } });
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    void (async () => {
      try {
        if (path === '/login') {
          if (url.searchParams.get('code') === opts.accessCode) {
            res.writeHead(302, { 'set-cookie': `cx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: '/' });
            res.end();
          } else {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Невірний код доступу. Використайте посилання, яке надрукувала команда запуску.');
          }
          return;
        }
        if (path.startsWith('/api/')) return await handleApi(req, res, path);
        await handleStatic(res, path);
      } catch (e) {
        if (e instanceof DomainError) {
          json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
        } else if (e instanceof Error && e.name === 'ZodError') {
          json(res, 400, { error: { code: 'VALIDATION', message: 'Некоректні дані: ' + e.message.slice(0, 300) } });
        } else {
          console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
          json(res, 500, { error: { code: 'INTERNAL', message: 'Внутрішня помилка. Дані не змінено.' } });
        }
      }
    })();
  });
}
