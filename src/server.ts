import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.ts';
import { DEMO_BANNER, type ModelConfig } from './config.ts';
import { DomainError } from './errors.ts';
import { sha256 } from './hash.ts';
import {
  acceptDraft, addQuestion, addSource, addSourceFromFile, answerQuestion, approve, buildCard, createCase, getCase,
  listCases, listSources, requestBpmnStart, returnToResearch, saveAnalystVersion, setQuestionCritical, submitForApproval,
  type Actor, type EditFields,
} from './domain.ts';
import { seedDemoCase } from './demo.ts';
import { redact } from './ai/redact.ts';
import { beginAnalystRun, executeAnalystRun, type RunOptions } from './runs.ts';
import { budgetLeftUsd, spentUsd, unknownCostRuns, type ModelPolicy } from './ai/budget.ts';
import type { AnalystClient, InstructionInfo } from './ai/types.ts';
import { addExplicitClarification, advanceScenario, createScenarioCase, scenarioInfo, TOTAL_STAGES } from './scenarios.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export interface ServerOptions {
  db: DB;
  mode: 'demo' | 'real';
  /** Код доступу людини. Той, хто його знає, — «людина» (може погоджувати). Агенти його не мають. */
  accessCode: string;
  /** Підключення моделі. Немає — аналіз недоступний (з поясненням), на демо мовчки не перемикаємось. */
  analyst?: { client: AnalystClient; policy?: ModelPolicy; instruction?: InstructionInfo };
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

function pickAffects(raw: unknown): { step_id: string; condition: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new DomainError('VALIDATION', 'affects має бути списком', 400);
  return raw.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return { step_id: str(o.step_id, 'affects.step_id'), condition: str(o.condition, 'affects.condition', false) };
  });
}

function pickFields(raw: unknown): EditFields {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('VALIDATION', 'fields має бути об’єктом', 400);
  const r = raw as Record<string, unknown>;
  const out: EditFields = {};
  for (const k of ['summary', 'business_context', 'roles_text', 'steps_text', 'problems_text'] as const) {
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

export function createApp(opts: ServerOptions): Server {
  const { db, mode } = opts;
  const token = sessionToken(opts.accessCode);
  const human: Actor = { kind: 'human', name: 'Аналітикиня' };

  function aiState() {
    const a = opts.analyst;
    if (!a) {
      return {
        available: false, kind: 'none',
        reason: mode === 'demo'
          ? 'Застосунок працює в деморежимі: справжню модель не підключено. Щоб увімкнути, налаштуйте ключ і модель (docs/model-setup.md) та запустіть у режимі real.'
          : 'Модель не підключено.',
      };
    }
    const p = a.policy;
    return {
      available: true, kind: a.client.mode === 'real' ? 'real' : 'scripted_demo', reason: null,
      model: a.client.model, effort: opts.modelInfo?.effort ?? null,
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
          const origin = b.origin === 'real' || b.origin === 'synthetic' ? b.origin : 'synthetic';
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
          const v = answerQuestion(db, human, caseId, {
            baseVersionId: str(b.base_version_id, 'base_version_id'), questionId: str(b.question_id, 'question_id'), answer: str(b.answer, 'answer'),
          });
          return json(res, 201, { version_id: v.id });
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
          const ro: RunOptions = { policy: opts.analyst.policy, instruction: opts.analyst.instruction };
          const ctx = beginAnalystRun(db, caseId, opts.analyst.client, ro);
          void executeAnalystRun(db, ctx, opts.analyst.client, ro).catch((e) => console.error('Помилка фонового запуску:', e instanceof Error ? e.message : 'невідома'));
          return json(res, 202, { run_id: ctx.runId, note: 'Аналіз запущено. Поточну версію не буде змінено, доки результат не пройде перевірки.' });
        }
        case 'bpmn/start': {
          // Тіло запиту свідомо ігнорується: вхід агента 2 сервер бере з бази за чинним погодженням.
          const r = requestBpmnStart(db, human, caseId, mode);
          return json(res, 202, { permitted: true, run_id: r.runId, version_id: r.versionId, approval_id: r.approvalId,
            note: 'Дозвіл підтверджено сервером. Побудову BPMN реалізовано не буде до зрізу 3.' });
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
