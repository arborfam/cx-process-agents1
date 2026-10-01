/**
 * Побудова, збереження й видача схеми — підкроки 3b-4, 3b-6, 3b-7.
 *
 * ЦЕ ЄДИНИЙ МОДУЛЬ ПОЗА `src/bpmn/`, ЯКОМУ ДОЗВОЛЕНО ІМПОРТУВАТИ ГЕНЕРАТОР.
 * Інваріант охороняє `tests/bpmn-isolation.test.ts`: сервер, доменний шар і запуски генератор не імпортують, а цей
 * модуль обов'язково викликає `generationGate` перед `generateBpmn`. Іншої гілки до генератора в продукті немає.
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
import { generateBpmn, type GenerateFaultInjection } from './bpmn/generate.ts';
import { GENERATOR_NAME } from './bpmn/ids.ts';
import type { ApprovedPackage, Finding, Issue, StepMapRow } from './bpmn/types.ts';

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

// ───────────────────────── побудова ─────────────────────────

export interface BuildReady {
  ok: true;
  review: CaseReview;
  pkg: ApprovedPackage;
  reviewId: string;
  runId: string;
  approvalId: string;
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
  return { ok: true, review, pkg, reviewId: review.reviewId!, runId: review.runId!, approvalId: approval.id };
}

export interface BuildOutcome {
  artifact: ArtifactView;
  /** true, якщо повернуто вже наявний артефакт без повторної генерації (повторний клік або повтор запиту). */
  reused: boolean;
}

/**
 * Побудова схеми для погодженого пакета. Ідемпотентна: якщо для цього самого запису перевірки, версії й хеша
 * артефакт уже є й він чинний, повертається він (повторний клік чи повторений HTTP-запит не створює другого
 * результату й нічого не перегенеровує). Виклику моделі в цьому шляху немає.
 */
export async function buildArtifact(db: DB, actor: Actor, caseId: string, instruction?: InstructionInfo, fault: GenerateFaultInjection = {}): Promise<BuildOutcome> {
  requireHuman(actor, 'побудова схеми BPMN');
  const pre = buildPreflight(db, caseId, instruction);
  if (!pre.ok) throw new DomainError(pre.code, pre.message, 409, pre.reasons ? { reasons: pre.reasons } : undefined);

  const existing = one<ArtifactRow>(db,
    'SELECT * FROM bpmn_artifact WHERE case_id = ? AND review_id = ? AND version_id = ? AND content_hash = ? ORDER BY rowid DESC LIMIT 1',
    caseId, pre.reviewId, pre.pkg.versionId, pre.pkg.contentHash);
  if (existing) {
    const v = viewOf(db, existing);
    if (v.trusted && v.staleReasons.length === 0) return { artifact: v, reused: true };
  }

  const result = await generateBpmn(pre.pkg, fault);

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
    if (dup) {
      const v = viewOf(db, dup);
      if (v.trusted && v.staleReasons.length === 0) return { artifact: v, reused: true };
    }

    const base = {
      id: newId('art'), case_id: caseId, review_id: pre.reviewId, run_id: pre.runId, approval_id: pre.approvalId,
      version_id: pre.pkg.versionId, content_hash: pre.pkg.contentHash, process_name: pre.pkg.content.process_name ?? '',
      generator: GENERATOR_NAME, created_by: actor.name, created_at: new Date().toISOString(),
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
        map_json: '[]', detail_json: JSON.stringify({ stage: result.stage, issues: result.issues, layoutWarnings: result.layoutWarnings } satisfies ArtifactDetail) };
    }
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
