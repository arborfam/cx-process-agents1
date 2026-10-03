/**
 * Побудова, збереження й видача схеми — підкроки 3b-4, 3b-6, 3b-7; архітектура CSV-пайплайна з D87.
 *
 * ШЛЯХ ПОБУДОВИ ОДИН: погоджений AS-IS → таблиця CSV від агента 2 → програмна перевірка таблиці проти
 * погодженого опису → скрипти пайплайна (`pipeline/`) → зворотна перевірка обох файлів → збереження.
 * Свого генератора схем тут немає й бути не може: програма таблицю лише перевіряє (тест `no-csv-generator`).
 * Якщо збереженої таблиці немає (перевірка виконана за старим контрактом), побудова чесно зупиняється —
 * «запасного» шляху, який намалював би схему без агента, не існує.
 *
 * ЦЕ ЄДИНИЙ МОДУЛЬ ПОЗА `src/bpmn/` І `src/pipeline/`, ЯКОМУ ДОЗВОЛЕНО ЗАПУСКАТИ ПОБУДОВУ.
 * Інваріант охороняє `tests/bpmn-isolation.test.ts`: сервер, доменний шар і запуски побудову не імпортують, а цей
 * модуль обов'язково викликає `generationGate` перед запуском скриптів.
 *
 * Що перевіряється ПЕРЕД побудовою (і ще раз у транзакції перед збереженням):
 *  1. серверний дозвіл `bpmnGuard` (стан кейсу, чинне погодження, найновіша версія, хеш, джерела, критичні питання,
 *     потік, нотація, назва процесу);
 *  2. відновлена з довіреного запису смислова перевірка (`getCaseReview`) — без нового виклику моделі;
 *  3. шлюз `generationGate` із набором знахідок, відхилених аналітикинею (D31); `UNSUPPORTED_CANDIDATE` не відхиляється (D21);
 *  4. актуальність (`staleReasons`) — та сама версія, хеш і погодження.
 * Моделі тут немає й бути не може: артефакт будується зі змісту погодженої версії дослівно.
 */
import { all, one, run, tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import { audit, bpmnGuard, currentApproval, getCase, getVersion, requireHuman, versionContent, type Actor } from './domain.ts';
import { canonical, sha256 } from './hash.ts';
import { findingKey } from './ai/bpmn-review.ts';
import { getCaseReview, staleReasons, type CaseReview } from './review-runs.ts';
import type { InstructionInfo } from './ai/types.ts';
import { packageFromApproval } from './bpmn/approved.ts';
import { analyzePackage, unsupportedExplanation } from './bpmn/validate.ts';
import type { ApprovedPackage, Finding, Issue, StepMapRow } from './bpmn/types.ts';
import { START_ID, checkCsv, type CsvPlan } from './csv/check.ts';
import { runPipeline, type PipelineLogStep } from './pipeline/run.ts';
import { GENERATOR_NAME, pipelineVersion } from './pipeline/scripts.ts';
import { verifyBpmnAgainstPackage } from './pipeline/verify.ts';
import { verifyBpmn } from './bpmn/verify.ts';
import { verifyDrawioAgainstBpmn } from './pipeline/verify-drawio.ts';
import { startLabelState, triggerShortProposal, type StartLabelProposal, type StartLabelState } from './start-label.ts';

/** Шов для тестів: пошкодження готового файлу перед його зворотною перевіркою (доводить, що пошкоджений файл не видається). */
export interface GenerateFaultInjection {
  tamperBpmn?: (xml: string) => string;
  tamperDrawio?: (xml: string) => string;
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

export type ArtifactStatus = 'ok' | 'blocked' | 'unsupported' | 'verification_failed';

export interface ArtifactRow {
  id: string; case_id: string; review_id: string; run_id: string; approval_id: string; version_id: string;
  content_hash: string; process_name: string; status: ArtifactStatus;
  bpmn_xml: string | null; bpmn_sha256: string | null;
  drawio_status: 'ok' | 'failed' | 'none'; drawio_xml: string | null; drawio_sha256: string | null;
  map_json: string; detail_json: string; generator: string; created_by: string; created_at: string; record_hash: string;
}

/** Подробиці результату, що зберігаються поруч із файлами (пояснення для людини, а не дані схеми). */
export interface ArtifactDetail {
  explanation?: string;
  findings?: Finding[];
  knownLimits?: Finding[];
  issues?: Issue[];
  stage?: string;
  drawioIssues?: Issue[];
  layoutWarnings?: string[];
  verificationWarnings?: Issue[];
  /** Прийнята таблиця агента 2, якою побудовано ці файли (D87): повторна технічна побудова бере саме її. */
  csv?: string;
  csv_sha256?: string;
  /** Версія скриптів пайплайна й хеші кожного кроку — видно, чим саме побудовано файл. */
  pipeline_version?: string;
  pipeline_scripts?: Record<string, string>;
  pipeline_log?: PipelineLogStep[];
  /** Повний текст тригера, якщо на схемі стоїть погоджений короткий підпис (D88). */
  start_label?: string;
  start_full_trigger?: string;
}

const FIELDS = ['id', 'case_id', 'review_id', 'run_id', 'approval_id', 'version_id', 'content_hash', 'process_name', 'status',
  'bpmn_xml', 'bpmn_sha256', 'drawio_status', 'drawio_xml', 'drawio_sha256', 'map_json', 'detail_json', 'generator',
  'created_by', 'created_at'] as const;

/** Хеш цілісності запису артефакту: контроль цілісності, не підпис (та сама межа, що для запису перевірки). */
export function artifactHash(r: Omit<ArtifactRow, 'record_hash'>): string {
  const o: Record<string, unknown> = {};
  for (const k of FIELDS) o[k] = r[k];
  return sha256(canonical(o));
}

// ───────────────────────── читання й актуальність ─────────────────────────

export interface ArtifactView {
  row: ArtifactRow;
  status: ArtifactStatus;
  /** Чому цей артефакт більше не чинний. Порожній список = чинний. */
  staleReasons: string[];
  /** Чи запис цілий і узгоджений (хеш запису, хеші файлів, прив'язка). */
  trusted: boolean;
  untrustedReasons: string[];
  map: StepMapRow[];
  detail: ArtifactDetail;
  /** Позначка для історії (D65). */
  label: string | null;
  /** Які файли можна віддати: лише ті, чия власна перевірка пройшла і хеш збігається. */
  downloads: { bpmn: boolean; drawio: boolean };
}

function checkArtifact(row: ArtifactRow): string[] {
  const bad: string[] = [];
  const { record_hash, ...rest } = row;
  if (artifactHash(rest) !== record_hash) bad.push('Хеш запису артефакту не збігається зі змістом: запис змінено.');
  if (row.status === 'ok') {
    if (!row.bpmn_xml || !row.bpmn_sha256) bad.push('Запис має стан «готово», але файлу .bpmn у ньому немає.');
    else if (sha256(row.bpmn_xml) !== row.bpmn_sha256) bad.push('Хеш файлу .bpmn не збігається з його вмістом.');
  } else if (row.bpmn_xml !== null) {
    bad.push('Запис не має стану «готово», але містить файл .bpmn.');
  }
  if (row.drawio_status === 'ok') {
    if (!row.drawio_xml || !row.drawio_sha256) bad.push('Експорт .drawio позначено успішним, але файлу немає.');
    else if (sha256(row.drawio_xml) !== row.drawio_sha256) bad.push('Хеш файлу .drawio не збігається з його вмістом.');
  } else if (row.drawio_xml !== null) {
    bad.push('Експорт .drawio не позначено успішним, але файл присутній.');
  }
  return bad;
}

/**
 * Повний успішний результат: є перевірений `.bpmn` І перевірений `.drawio`. Лише такий артефакт використовується
 * ПОВТОРНО без перегенерації. Невдала побудова (`verification_failed`, `blocked`, `unsupported`) і частковий успіх
 * (`.bpmn` є, `.drawio` не пройшов власної звірки) повторною спробою МАЮТЬ перебудовуватись: інакше технічна помилка
 * «залипала» б і виправити її можна було лише новим — платним — запуском смислової перевірки (дефект D75).
 */
const isComplete = (row: ArtifactRow): boolean => row.status === 'ok' && row.drawio_status === 'ok';

/**
 * Відбиток НАСЛІДКУ побудови: що саме вийшло. Потрібен, щоб повторні спроби з тим самим результатом
 * не плодили однакових записів в історії (генератор детермінований, тож однаковий вхід дає однаковий відбиток).
 */
const outcomeKey = (r: Pick<ArtifactRow, 'status' | 'bpmn_sha256' | 'drawio_status' | 'drawio_sha256' | 'map_json' | 'detail_json'>): string =>
  canonical([r.status, r.bpmn_sha256, r.drawio_status, r.drawio_sha256, r.map_json, r.detail_json]);

function viewOf(db: DB, row: ArtifactRow): ArtifactView {
  const untrustedReasons = checkArtifact(row);
  const stale = untrustedReasons.length > 0 ? [] : staleReasons(db, row.case_id, row.approval_id, row.version_id, row.content_hash);
  const trusted = untrustedReasons.length === 0;
  const current = trusted && stale.length === 0;
  const version = (() => { try { return getVersion(db, row.version_id).number; } catch { return null; } })();
  return {
    row, status: row.status, staleReasons: stale, trusted, untrustedReasons,
    map: JSON.parse(row.map_json) as StepMapRow[],
    detail: JSON.parse(row.detail_json) as ArtifactDetail,
    label: current ? null : `Застаріла — побудована за версією ${version ?? '—'}`,
    downloads: {
      bpmn: current && row.status === 'ok' && !!row.bpmn_xml,
      drawio: current && row.status === 'ok' && row.drawio_status === 'ok' && !!row.drawio_xml,
    },
  };
}

/** Найновіший артефакт кейсу (будь-якого стану). Актуальність і довіру повідомляє `ArtifactView`. */
export function getCaseArtifact(db: DB, caseId: string): ArtifactView | null {
  const row = one<ArtifactRow>(db, 'SELECT * FROM bpmn_artifact WHERE case_id = ? ORDER BY rowid DESC LIMIT 1', caseId);
  return row ? viewOf(db, row) : null;
}

/** Уся історія артефактів кейсу, найновіші перші: застарілі лишаються видимими з позначкою (D65). */
export function listCaseArtifacts(db: DB, caseId: string): ArtifactView[] {
  return all<ArtifactRow>(db, 'SELECT * FROM bpmn_artifact WHERE case_id = ? ORDER BY rowid DESC', caseId).map((r) => viewOf(db, r));
}

export function getArtifactById(db: DB, caseId: string, artifactId: string): ArtifactView | null {
  const row = one<ArtifactRow>(db, 'SELECT * FROM bpmn_artifact WHERE id = ? AND case_id = ?', artifactId, caseId);
  return row ? viewOf(db, row) : null;
}

/**
 * Віддача файлу: перевірка на сервері, а не приховування кнопки. Файл видається лише якщо запис цілий,
 * артефакт чинний, власна перевірка саме цього файлу пройшла і його хеш збігається з вмістом.
 */
export function readArtifactFile(db: DB, caseId: string, kind: 'bpmn' | 'drawio', artifactId?: string): { xml: string; filename: string; sha256: string } {
  const v = artifactId ? getArtifactById(db, caseId, artifactId) : getCaseArtifact(db, caseId);
  if (!v) throw new DomainError('NOT_FOUND', 'Для цього кейсу схему ще не будували.', 404);
  if (!v.trusted) throw new DomainError('ARTIFACT_UNTRUSTED', `Запис схеми не цілий, файл не видається: ${v.untrustedReasons.join(' ')} Побудуйте схему заново.`, 409);
  if (v.staleReasons.length > 0) {
    throw new DomainError('ARTIFACT_STALE',
      `Ця схема застаріла (${v.label}) і як чинний результат не видається: ${v.staleReasons.join(' ')} Погодьте поточну версію, виконайте смислову перевірку й побудуйте схему заново.`, 409);
  }
  if (!v.downloads[kind]) {
    throw new DomainError('FILE_NOT_AVAILABLE', kind === 'drawio'
      ? 'Перевірений файл .drawio для цієї схемы недоступний: його власна звірка не пройшла або експорт не створювався. Файл .bpmn це не скасовує.'
      : 'Перевірений файл .bpmn недоступний: побудова не завершилась успішно.', 409);
  }
  const xml = (kind === 'bpmn' ? v.row.bpmn_xml : v.row.drawio_xml)!;
  const hash = (kind === 'bpmn' ? v.row.bpmn_sha256 : v.row.drawio_sha256)!;
  if (sha256(xml) !== hash) throw new DomainError('ARTIFACT_UNTRUSTED', 'Хеш файлу не збігається з його вмістом: файл не видається.', 409);
  return { xml, filename: `${v.row.case_id}-v${(() => { try { return getVersion(db, v.row.version_id).number; } catch { return 0; } })()}.${kind === 'bpmn' ? 'bpmn' : 'drawio'}`, sha256: hash };
}

/**
 * Віддача ТАБЛИЦІ, якою побудовано схему. Та сама межа, що й для файлів: запис має бути цілим і чинним.
 * Таблиця віддається й тоді, коли побудова не завершилась успішно: вона потрібна, щоб зрозуміти чому.
 */
export function readArtifactCsv(db: DB, caseId: string, artifactId?: string): { csv: string; filename: string; sha256: string } {
  const v = artifactId ? getArtifactById(db, caseId, artifactId) : getCaseArtifact(db, caseId);
  if (!v) throw new DomainError('NOT_FOUND', 'Для цього кейсу схему ще не будували.', 404);
  if (!v.trusted) throw new DomainError('ARTIFACT_UNTRUSTED', `Запис схеми не цілий, таблиця не видається: ${v.untrustedReasons.join(' ')}`, 409);
  const csv = v.detail.csv;
  if (!csv) throw new DomainError('FILE_NOT_AVAILABLE', 'У цьому записі таблиці немає (його створено до переходу на побудову з таблиці).', 409);
  const n = (() => { try { return getVersion(db, v.row.version_id).number; } catch { return 0; } })();
  return { csv, filename: `${caseId}-v${n}.csv`, sha256: sha256(csv) };
}

// ───────────────────────── побудова ─────────────────────────

/** Усе, що потрібно для побудови: пакет, погоджений підпис події, прийнята таблиця та її розбір. */
export interface PipelineBuildInput {
  pkg: ApprovedPackage;
  /** Підпис початкової події, погоджений людиною (D88), або сам тригер. */
  startLabel: Pick<StartLabelState, 'label'>;
  /** Прийнята таблиця агента 2 дослівно. */
  csv: string;
  /** Розбір таблиці після звірки з погодженим описом. */
  plan: CsvPlan;
}

export interface BuildReady extends PipelineBuildInput {
  ok: true;
  review: CaseReview;
  reviewId: string;
  runId: string;
  approvalId: string;
  startLabel: StartLabelState;
}
export type BuildBlocked = { ok: false; code: string; message: string; reasons?: string[] };

/**
 * Усі перевірки перед побудовою, без побічних дій. Викликається двічі: до генерації й ще раз у транзакції
 * перед збереженням (щоб версія, погодження чи рішення, змінені під час генерації, не дали чинного результату).
 */
export function buildPreflight(db: DB, caseId: string, instruction?: InstructionInfo): BuildReady | BuildBlocked {
  getCase(db, caseId);
  const g = bpmnGuard(db, caseId, { ignoreActiveRun: true });
  if (!g.ok) {
    return { ok: false, code: 'GUARD_FAILED', message: 'Серверний дозвіл на побудову не надано.', reasons: g.reasons.map((r) => `${r.code}: ${r.message}`) };
  }
  const review = getCaseReview(db, caseId, instruction);
  if (review.state === 'none') return { ok: false, code: 'NO_REVIEW', message: 'Смислової перевірки ще не було. Спершу запустіть перевірку для BPMN.' };
  if (review.state === 'running') return { ok: false, code: 'REVIEW_RUNNING', message: 'Смислова перевірка виконується. Дочекайтеся завершення.' };
  if (review.state === 'failed') return { ok: false, code: 'REVIEW_FAILED', message: `Смислова перевірка завершилась помилкою: ${review.error ?? 'причина невідома'}. Схема не будується; запустіть перевірку знову.` };
  if (review.state === 'untrusted') return { ok: false, code: 'REVIEW_UNTRUSTED', message: `Запису перевірки не довіряємо: ${(review.reasons ?? []).join(' ')} Потрібна нова перевірка.`, reasons: review.reasons };
  if (review.state === 'stale') return { ok: false, code: 'REVIEW_STALE', message: `Перевірка застаріла: ${(review.reasons ?? []).join(' ')} Потрібна нова перевірка для поточної погодженої версії.`, reasons: review.reasons };
  if (review.state === 'unsupported') {
    return { ok: false, code: 'UNSUPPORTED', message: 'Підтверджено вимогу до нотації, якої інструмент не будує (D21). Схема не створюється й не спрощується; погодження AS-IS лишається чинним.' };
  }
  if (!review.gate?.ok) {
    const gate = review.gate as { code: string; message: string } | undefined;
    return { ok: false, code: gate?.code ?? 'GATE_CLOSED', message: gate?.message ?? 'Шлюз до генерації закрито.' };
  }
  const approval = currentApproval(db, caseId)!;
  const version = getVersion(db, approval.version_id);
  const stale = staleReasons(db, caseId, approval.id, version.id, version.content_hash);
  if (stale.length > 0) return { ok: false, code: 'STALE', message: `Погоджена версія змінилась: ${stale.join(' ')}`, reasons: stale };
  // Пакет читається з бази за погодженням (той самий шлях, що й у 3a): нічого з запиту не береться.
  const pkg = packageFromApproval(db, caseId);
  if (pkg.versionId !== version.id || pkg.contentHash !== version.content_hash) {
    return { ok: false, code: 'STALE', message: 'Пакет не збігається з погодженою версією: побудова скасована.' };
  }

  // Підпис початкової події: або сам тригер, або ПОГОДЖЕНИЙ людиною короткий підпис (D88). Мовчки не скорочуємо.
  const startLabel = startLabelState(db, caseId, version.id, version.content_hash, pkg.content.boundaries.trigger, triggerShortProposal(pkg.content));
  if (startLabel.needsDecision) {
    return { ok: false, code: 'START_LABEL_REQUIRED', message: startLabel.message! };
  }

  // Таблиця CSV — із прийнятої відповіді агента 2. Своєї таблиці програма не складає (D87).
  const response = (review.review?.response ?? null) as { csv?: unknown } | null;
  const csv = typeof response?.csv === 'string' ? response.csv : null;
  if (csv === null) {
    return {
      ok: false, code: 'CSV_MISSING',
      message: 'У збереженій смисловій перевірці немає таблиці процесу (CSV). Схему будують лише з таблиці агента 2 за чинним контрактом; старий результат, отриманий до цього контракту, як таблицю не використовується й не добудовується програмою. Потрібна нова смислова перевірка за чинною інструкцією.',
    };
  }
  const check = checkCsv(csv, pkg, { startLabel: startLabel.label, startDocumentation: startLabel.documentation });
  if (!check.ok) {
    return {
      ok: false, code: 'CSV_INVALID',
      message: 'Таблиця агента 2 не описує погоджений процес: побудову зупинено, таблицю програма не виправляє.',
      reasons: check.issues.map((i) => `${i.code}: ${i.message}`),
    };
  }
  return { ok: true, review, pkg, reviewId: review.reviewId!, runId: review.runId!, approvalId: approval.id, startLabel, csv, plan: check.plan };
}

/**
 * Технічні обмеження генератора для поточного погодженого пакета — БЕЗ моделі, без файлів, лише читання (D86).
 *
 * Навіщо: смислова перевірка платна, а частину обмежень (задовгий підпис, непідтримувана нотація, порушення
 * структури) програма бачить сама. Користувач має побачити їх ДО оплати, а не після неї.
 * Нічого не змінює й нічого не дозволяє: це той самий розбір, який виконується на початку побудови.
 */
export interface TechnicalLimits {
  /** Чи вдалося розібрати пакет (потрібне чинне погодження; інакше причина в `reason`). */
  available: boolean;
  reason: string | null;
  /** Непідтримувана нотація й задовгі підписи: схему не буде побудовано, доки це лишається в описі. */
  unsupported: Finding[];
  /** Порушення, через які побудова неможлива (структура потоку, порожні обов'язкові поля). */
  blocking: Finding[];
  /** Відомі обмеження, які побудову не зупиняють (показуються як застереження). */
  known_limits: Finding[];
  /** Стан підпису початкової події: чи потрібне окреме рішення про короткий підпис (D88). */
  start_label: { label: string; needs_decision: boolean; message: string | null; trigger_chars: number; max_chars: number; proposal: StartLabelProposal | null } | null;
}

export function technicalLimits(db: DB, caseId: string): TechnicalLimits {
  getCase(db, caseId);
  const none = (reason: string): TechnicalLimits => ({ available: false, reason, unsupported: [], blocking: [], known_limits: [], start_label: null });
  const g = bpmnGuard(db, caseId, { ignoreActiveRun: true });
  if (!g.ok) return none(`Серверний дозвіл на побудову ще не надано: ${g.reasons.map((r) => r.message).join(' ')}`);
  let pkg: ApprovedPackage;
  try {
    pkg = packageFromApproval(db, caseId);
  } catch (e) {
    return none(e instanceof Error ? e.message : 'Пакет не вдалося зібрати.');
  }
  const sl = startLabelState(db, caseId, pkg.versionId, pkg.contentHash, pkg.content.boundaries.trigger, triggerShortProposal(pkg.content));
  const a = analyzePackage(pkg, { startLabel: sl.label });
  return {
    available: true, reason: null, unsupported: a.unsupported, blocking: a.blocking, known_limits: a.knownLimits,
    start_label: { label: sl.label, needs_decision: sl.needsDecision, message: sl.message, trigger_chars: sl.trigger.length, max_chars: sl.maxChars, proposal: sl.proposal },
  };
}

/**
 * Результат побудови через пайплайн власниці. Формат той самий, що був у генератора: статус і пояснення,
 * а не «файл або нічого». Файли з'являються лише після зворотної звірки обох форматів із погодженим описом.
 */
export type PipelineBuildResult =
  | {
    status: 'ok'; bpmn: string; drawio: { status: 'ok' | 'failed'; xml: string | null; issues: Issue[] };
    map: StepMapRow[]; knownLimits: Finding[];
    /** Результат зворотної звірки: файл видається лише коли `ok` і помилок немає. */
    verification: { ok: boolean; errors: Issue[]; warnings: Issue[] };
    layoutWarnings: string[];
    /** Прив'язка результату до погодженої версії й до версії скриптів. */
    binding: { versionId: string; contentHash: string; origin: string; generator: string };
    pipelineVersion: string; scripts: Record<string, string>; log: PipelineLogStep[];
  }
  | { status: 'blocked'; findings: Finding[]; warnings: Finding[] }
  | { status: 'unsupported'; findings: Finding[]; explanation: string; warnings: Finding[] }
  | { status: 'verification_failed'; stage: string; issues: Issue[]; layoutWarnings: string[]; pipelineVersion: string; log: PipelineLogStep[] };

/**
 * Погоджений пакет + прийнята таблиця → файли. Тут немає жодного рядка, який «домальовує» схему:
 * вся геометрія й розмітка походять зі скриптів `pipeline/`, а програма лише перевіряє результат.
 */
export async function buildThroughPipeline(pre: PipelineBuildInput, fault: GenerateFaultInjection = {}): Promise<PipelineBuildResult> {
  const analysis = analyzePackage(pre.pkg, { startLabel: pre.startLabel.label });
  if (analysis.blocking.length > 0) {
    return { status: 'blocked', findings: [...analysis.blocking, ...analysis.unsupported], warnings: analysis.knownLimits };
  }
  if (analysis.unsupported.length > 0) {
    return { status: 'unsupported', findings: analysis.unsupported, explanation: unsupportedExplanation(analysis.unsupported, pre.pkg), warnings: analysis.knownLimits };
  }
  const run = runPipeline({
    csv: pre.csv,
    poolName: pre.plan.poolName,
    lanes: pre.plan.lanes,
    documentation: pre.plan.startDocumentation ? { [START_ID]: pre.plan.startDocumentation } : {},
    binding: { versionId: pre.pkg.versionId, contentHash: pre.pkg.contentHash, origin: pre.pkg.origin, generator: `${GENERATOR_NAME}@${pipelineVersion()}` },
  });
  if (!run.ok) {
    return {
      status: 'verification_failed', stage: run.stage, layoutWarnings: [], pipelineVersion: pipelineVersion(), log: run.log,
      issues: [{ code: 'PIPELINE_FAILED', severity: 'error', message: run.message, refs: [] }],
    };
  }
  const bpmn = fault.tamperBpmn ? fault.tamperBpmn(run.bpmn) : run.bpmn;
  // ДВІ незалежні зворотні перевірки готового файлу:
  //  1. `verifyBpmn` — строга перевірка зрізу 3a: структура, підписи, переходи, геометрія, карта;
  //  2. `verifyBpmnAgainstPackage` — перевірка того, що з'явилось із цією архітектурою: доріжки лише для
  //     ролей із діями, погоджений короткий підпис події й повний текст тригера в деталях.
  // Файл видається, лише якщо пройшли ОБИДВІ.
  const strict = verifyBpmn(bpmn, pre.pkg, { startLabel: pre.startLabel.label, lanes: pre.plan.lanes });
  const v = verifyBpmnAgainstPackage(bpmn, pre.pkg, pre.plan);
  const errors = [...strict.report.errors, ...v.issues];
  if (errors.length > 0 || !v.model || !strict.model) {
    return { status: 'verification_failed', stage: 'bpmn', issues: errors, layoutWarnings: run.warnings, pipelineVersion: run.pipelineVersion, log: run.log };
  }
  const drawioXml = fault.tamperDrawio ? fault.tamperDrawio(run.drawio) : run.drawio;
  const drawioIssues = verifyDrawioAgainstBpmn(drawioXml, v.model, pre.plan.startDocumentation, { versionId: pre.pkg.versionId, contentHash: pre.pkg.contentHash });
  const drawioOk = drawioIssues.length === 0;
  for (const row of v.map) row.drawio_cell_id = drawioOk ? row.bpmn_task_id : null;
  return {
    status: 'ok', bpmn,
    drawio: { status: drawioOk ? 'ok' : 'failed', xml: drawioOk ? drawioXml : null, issues: drawioIssues },
    map: v.map, knownLimits: analysis.knownLimits,
    verification: { ok: true, errors: [], warnings: [...strict.report.warnings, ...v.warnings] },
    layoutWarnings: run.warnings,
    binding: { versionId: pre.pkg.versionId, contentHash: pre.pkg.contentHash, origin: pre.pkg.origin, generator: `${GENERATOR_NAME}@${run.pipelineVersion}` },
    pipelineVersion: run.pipelineVersion, scripts: run.scripts, log: run.log,
  };
}

export interface BuildOutcome {
  artifact: ArtifactView;
  /** true, якщо повернуто вже наявний артефакт без повторної генерації (повторний клік або повтор запиту). */
  reused: boolean;
}

/**
 * Побудова схеми для погодженого пакета. Повторний клік і повторений HTTP-запит другого результату не створюють:
 *  • ПОВНИЙ успішний артефакт (є перевірені `.bpmn` і `.drawio`) повертається як є, без перегенерації;
 *  • після технічної помилки (`verification_failed`, `blocked`) чи невдалого експорту `.drawio` побудова
 *    виконується ЗАНОВО на тій самій збереженій смисловій перевірці — нового виклику моделі не відбувається,
 *    а невдала спроба лишається в історії;
 *  • якщо повтор дав точно той самий наслідок, нового запису в історії не з'являється.
 * Усі перевірки (дозвіл, довірена перевірка, шлюз, актуальність) виконуються заново й повтором не обходяться.
 */
export async function buildArtifact(db: DB, actor: Actor, caseId: string, instruction?: InstructionInfo, fault: GenerateFaultInjection = {}): Promise<BuildOutcome> {
  requireHuman(actor, 'побудова схеми BPMN');
  const pre = buildPreflight(db, caseId, instruction);
  if (!pre.ok) throw new DomainError(pre.code, pre.message, 409, pre.reasons ? { reasons: pre.reasons } : undefined);

  // Повторно використовуємо лише ПОВНИЙ успішний результат. Після технічної помилки (зокрема невдалого .drawio)
  // побудова виконується заново — на тій самій збереженій смисловій перевірці, без нового виклику моделі.
  const existing = one<ArtifactRow>(db,
    'SELECT * FROM bpmn_artifact WHERE case_id = ? AND review_id = ? AND version_id = ? AND content_hash = ? ORDER BY rowid DESC LIMIT 1',
    caseId, pre.reviewId, pre.pkg.versionId, pre.pkg.contentHash);
  if (existing && isComplete(existing)) {
    const v = viewOf(db, existing);
    if (v.trusted && v.staleReasons.length === 0) return { artifact: v, reused: true };
  }

  const result = await buildThroughPipeline(pre, fault);

  // Другий раз — усередині транзакції: усе, що могло змінитися під час генерації, закриває шлях до чинного результату.
  return tx(db, () => {
    const again = buildPreflight(db, caseId, instruction);
    if (!again.ok) throw new DomainError(again.code, `Поки будувалася схема, стан кейсу змінився: ${again.message} Результат не збережено.`, 409, again.reasons ? { reasons: again.reasons } : undefined);
    if (again.reviewId !== pre.reviewId || again.pkg.versionId !== pre.pkg.versionId || again.pkg.contentHash !== pre.pkg.contentHash) {
      throw new DomainError('STALE', 'Поки будувалася схема, з’явилась інша погоджена версія або нова перевірка. Результат не збережено.', 409);
    }
    const dup = one<ArtifactRow>(db,
      'SELECT * FROM bpmn_artifact WHERE case_id = ? AND review_id = ? AND version_id = ? AND content_hash = ? ORDER BY rowid DESC LIMIT 1',
      caseId, pre.reviewId, pre.pkg.versionId, pre.pkg.contentHash);
    const dupView = dup ? viewOf(db, dup) : null;
    const dupUsable = !!dupView && dupView.trusted && dupView.staleReasons.length === 0;
    // Паралельний запит міг уже зберегти ПОВНИЙ успішний результат — другого такого не створюємо.
    if (dup && dupUsable && isComplete(dup)) return { artifact: dupView!, reused: true };

    const base = {
      id: newId('art'), case_id: caseId, review_id: pre.reviewId, run_id: pre.runId, approval_id: pre.approvalId,
      version_id: pre.pkg.versionId, content_hash: pre.pkg.contentHash, process_name: pre.pkg.content.process_name ?? '',
      generator: `${GENERATOR_NAME}@${pipelineVersion()}`, created_by: actor.name, created_at: new Date().toISOString(),
    };
    let row: Omit<ArtifactRow, 'record_hash'>;
    if (result.status === 'ok') {
      // Пошкоджений .drawio не скасовує чинного .bpmn (D60): файл експорту просто не зберігається.
      const drawioOk = result.drawio.status === 'ok' && !!result.drawio.xml;
      row = {
        ...base, status: 'ok', bpmn_xml: result.bpmn, bpmn_sha256: sha256(result.bpmn),
        drawio_status: drawioOk ? 'ok' : 'failed',
        drawio_xml: drawioOk ? result.drawio.xml : null,
        drawio_sha256: drawioOk ? sha256(result.drawio.xml!) : null,
        map_json: JSON.stringify(result.map),
        detail_json: JSON.stringify({
          knownLimits: result.knownLimits, layoutWarnings: result.layoutWarnings,
          verificationWarnings: result.verification.warnings, drawioIssues: drawioOk ? [] : result.drawio.issues,
          csv: pre.csv, csv_sha256: sha256(pre.csv),
          pipeline_version: result.pipelineVersion, pipeline_scripts: result.scripts, pipeline_log: result.log,
          start_label: pre.startLabel.label, start_full_trigger: pre.startLabel.documentation ?? undefined,
        } satisfies ArtifactDetail),
      };
    } else if (result.status === 'unsupported') {
      row = { ...base, status: 'unsupported', bpmn_xml: null, bpmn_sha256: null, drawio_status: 'none', drawio_xml: null, drawio_sha256: null,
        map_json: '[]', detail_json: JSON.stringify({ explanation: result.explanation, findings: result.findings, knownLimits: result.warnings } satisfies ArtifactDetail) };
    } else if (result.status === 'blocked') {
      row = { ...base, status: 'blocked', bpmn_xml: null, bpmn_sha256: null, drawio_status: 'none', drawio_xml: null, drawio_sha256: null,
        map_json: '[]', detail_json: JSON.stringify({ findings: result.findings, knownLimits: result.warnings } satisfies ArtifactDetail) };
    } else {
      row = { ...base, status: 'verification_failed', bpmn_xml: null, bpmn_sha256: null, drawio_status: 'none', drawio_xml: null, drawio_sha256: null,
        map_json: '[]', detail_json: JSON.stringify({
          stage: result.stage, issues: result.issues, layoutWarnings: result.layoutWarnings,
          csv: pre.csv, csv_sha256: sha256(pre.csv), pipeline_version: result.pipelineVersion, pipeline_log: result.log,
        } satisfies ArtifactDetail) };
    }
    // Повтор із тим самим наслідком (наприклад, та сама технічна помилка) нового запису в історії не створює.
    if (dup && dupUsable && outcomeKey(dup) === outcomeKey(row)) return { artifact: dupView!, reused: true };
    run(db,
      `INSERT INTO bpmn_artifact (id, case_id, review_id, run_id, approval_id, version_id, content_hash, process_name, status,
         bpmn_xml, bpmn_sha256, drawio_status, drawio_xml, drawio_sha256, map_json, detail_json, generator, created_by, created_at, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.case_id, row.review_id, row.run_id, row.approval_id, row.version_id, row.content_hash, row.process_name, row.status,
      row.bpmn_xml, row.bpmn_sha256, row.drawio_status, row.drawio_xml, row.drawio_sha256, row.map_json, row.detail_json,
      row.generator, row.created_by, row.created_at, artifactHash(row));
    audit(db, caseId, actor, 'bpmn_artifact_built', {
      artifact_id: row.id, review_id: row.review_id, version_id: row.version_id, status: row.status, drawio: row.drawio_status,
      resolutions: (pre.review.resolutions ?? []).length,
    });
    const saved = one<ArtifactRow>(db, 'SELECT * FROM bpmn_artifact WHERE id = ?', row.id)!;
    return { artifact: viewOf(db, saved), reused: false };
  });
}

/** Ключі знахідок, відхилених аналітикинею для поточного запису перевірки (для звіту й інтерфейсу). */
export const resolvedKeysOf = (review: CaseReview): Set<string> => new Set((review.resolutions ?? []).map((r) => r.finding_key));
export { findingKey };
