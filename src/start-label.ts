/**
 * Погоджений короткий підпис початкової події (D88).
 *
 * Навіщо: тригер процесу буває довгим (у поточному кейсі — 715 символів). Такий текст на схемі або
 * розповзається на пів полотна, або стає вузьким стовпчиком і зменшує масштаб усієї схеми. Але скорочувати
 * погоджений текст програма не має права. Тому коротший підпис — це ОКРЕМЕ явне рішення людини:
 *
 *  • повний тригер лишається у змісті версії (його ніхто не переписує), потрапляє в деталі початкової події
 *    в `.bpmn` (documentation) і в `.drawio` (підказка) і показується поряд зі схемою;
 *  • короткий підпис пише людина — програма його не виводить, не скорочує й не пропонує автоматично;
 *  • рішення прив'язане до конкретної версії та її хеша: для нової версії воно не діє;
 *  • агент цього зробити не може (`requireHuman`).
 */
import { all, one, run, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import { audit, currentApproval, getCase, getVersion, requireHuman, versionContent, type Actor } from './domain.ts';
import { canonical, sha256 } from './hash.ts';
import { MAX_EVENT_LABEL_CHARS } from './bpmn/text.ts';
import { textProblem } from './bpmn/text.ts';

export interface StartLabelRow {
  id: string; case_id: string; version_id: string; content_hash: string;
  label: string; full_trigger_sha256: string; reason: string;
  confirmed_by: string; confirmed_at: string; record_hash: string;
}

const FIELDS = ['id', 'case_id', 'version_id', 'content_hash', 'label', 'full_trigger_sha256', 'reason', 'confirmed_by', 'confirmed_at'] as const;

export function startLabelHash(r: Omit<StartLabelRow, 'record_hash'>): string {
  const o: Record<string, unknown> = {};
  for (const k of FIELDS) o[k] = r[k];
  return sha256(canonical(o));
}

/** Чинне рішення про підпис для конкретної версії: найновіше, ціле, з тим самим текстом тригера. */
export function confirmedStartLabel(db: DB, caseId: string, versionId: string, contentHash: string, trigger: string): StartLabelRow | null {
  const rows = all<StartLabelRow>(db,
    'SELECT * FROM start_label WHERE case_id = ? AND version_id = ? AND content_hash = ? ORDER BY rowid DESC', caseId, versionId, contentHash);
  for (const r of rows) {
    const { record_hash, ...rest } = r;
    if (startLabelHash(rest) !== record_hash) continue;        // запис змінено — не діє
    if (r.full_trigger_sha256 !== sha256(trigger)) continue;    // рішення ухвалювалось для іншого тексту
    return r;
  }
  return null;
}

/**
 * Пропозиція короткого підпису з уже отриманої відповіді агента 1 (D94).
 * Повертається лише тоді, коли її справді можна записати у схему: інакше пропозиції немає
 * і лишається ручне редагування. Текст НЕ скорочується й не виправляється.
 */
export interface StartLabelProposal {
  text: string;
  source: 'agent';
  chars: number;
}

export function triggerShortProposal(content: { boundaries: { trigger: string; trigger_short?: string } }): StartLabelProposal | null {
  const raw = (content.boundaries.trigger_short ?? '').trim();
  if (!raw) return null;
  if (raw === content.boundaries.trigger.trim()) return null;      // це не коротший підпис
  if (raw.length > MAX_EVENT_LABEL_CHARS) return null;             // не вміщається — механічно не ріжемо
  if (textProblem(raw)) return null;                               // у схему дослівно не записати
  return { text: raw, source: 'agent', chars: raw.length };
}

export interface StartLabelState {
  /** Підпис, який піде на схему: погоджений короткий або повний тригер. */
  label: string;
  /** Повний текст тригера, якщо підпис короткий (інакше null — підпис і є повним текстом). */
  documentation: string | null;
  /** Чи потрібне рішення людини, щоб схему взагалі можна було побудувати. */
  needsDecision: boolean;
  message: string | null;
  confirmed: StartLabelRow | null;
  trigger: string;
  /** Межа зовнішнього підпису події — із чинного контракту, а не з інтерфейсу. */
  maxChars: number;
  /** Пропозиція агента з тієї самої відповіді. Сама собою нічого не змінює. */
  proposal: StartLabelProposal | null;
}

/** Стан підпису початкової події для погодженої версії. Нічого не змінює. */
export function startLabelState(
  db: DB, caseId: string, versionId: string, contentHash: string, trigger: string,
  proposal: StartLabelProposal | null = null,
): StartLabelState {
  const base = { maxChars: MAX_EVENT_LABEL_CHARS, proposal };
  const confirmed = confirmedStartLabel(db, caseId, versionId, contentHash, trigger);
  if (confirmed) {
    // Погоджений підпис непомітно не змінюється: пропозиція агента тут нічого не вирішує.
    return {
      ...base, label: confirmed.label, documentation: trigger, needsDecision: false, confirmed, trigger,
      message: `Початкова подія підписана погодженим коротким підписом; повний текст тригера (${trigger.length} симв.) збережено в деталях події й показується поряд зі схемою.`,
    };
  }
  if (trigger.length > MAX_EVENT_LABEL_CHARS) {
    return {
      ...base, label: trigger, documentation: null, needsDecision: true, confirmed: null, trigger,
      message: `Тригер процесу має ${trigger.length} символів — це більше за межу розбірливого підпису події (${MAX_EVENT_LABEL_CHARS}). Текст не скорочується: щоб побудувати схему, погодьте короткий підпис початкової події. Повний текст залишиться в описі й у деталях події.`
        + (proposal ? ` Агент запропонував варіант на ${proposal.chars} симв. — перевірте його й погодьте або напишіть свій.` : ''),
    };
  }
  return { ...base, label: trigger, documentation: null, needsDecision: false, confirmed: null, trigger, message: null };
}

export interface StartLabelPreview {
  trigger: string;
  current_label: string;
  proposed_label: string;
  /** Межа з чинного контракту (`MAX_EVENT_LABEL_CHARS`), а не з інтерфейсу. */
  max_chars: number;
  /** Пропозиція з уже отриманої відповіді агента 1; застосовує її лише людина. */
  agent_proposal: StartLabelProposal | null;
  version_number: number;
  content_hash: string;
  consequences: string[];
}

/** Що саме зміниться. Показується людині ДО підтвердження. */
export function previewStartLabel(db: DB, caseId: string, label: string): StartLabelPreview {
  getCase(db, caseId);
  const approval = currentApproval(db, caseId);
  if (!approval) throw new DomainError('NO_APPROVAL', 'Чинного погодження немає: підпис початкової події погоджують для конкретної погодженої версії.', 409);
  const version = getVersion(db, approval.version_id);
  const content = versionContent(version);
  const trigger = content.boundaries.trigger;
  const state = startLabelState(db, caseId, version.id, version.content_hash, trigger, triggerShortProposal(content));
  return {
    trigger,
    current_label: state.label,
    proposed_label: label,
    max_chars: state.maxChars,
    agent_proposal: state.proposal,
    version_number: version.number,
    content_hash: version.content_hash,
    consequences: [
      'На схемі початкова подія буде підписана коротким текстом, який ви вводите самі.',
      `Повний тригер (${trigger.length} симв.) не змінюється: він лишається в погодженому описі, записується в деталі початкової події у .bpmn і .drawio і показується поряд зі схемою.`,
      `Рішення діє лише для версії ${version.number} і цього хеша змісту; для нової версії його треба ухвалити заново.`,
      'Якщо смислова перевірка вже виконана для іншого підпису, схему доведеться перевіряти заново: таблиця агента містить підпис, який був на момент перевірки.',
    ],
  };
}

export interface ConfirmStartLabelInput { label: string; reason: string }

/** Явне рішення людини. Агент виконати його не може. */
export function confirmStartLabel(db: DB, actor: Actor, caseId: string, input: ConfirmStartLabelInput): StartLabelRow {
  requireHuman(actor, 'погодження короткого підпису початкової події');
  getCase(db, caseId);
  const label = input.label.trim();
  const reason = input.reason.trim();
  if (label === '') throw new DomainError('BAD_INPUT', 'Короткий підпис порожній. Програма його не вигадує: текст пишете ви.', 400);
  if (reason === '') throw new DomainError('EXPLANATION_REQUIRED', 'Потрібне пояснення: чому саме такий підпис і що лишається в повному тексті.', 400);
  if (label.length > MAX_EVENT_LABEL_CHARS) {
    throw new DomainError('LABEL_TOO_LONG', `Короткий підпис має ${label.length} символів, межа — ${MAX_EVENT_LABEL_CHARS}.`, 400);
  }
  const p = textProblem(label);
  if (p) throw new DomainError('BAD_INPUT', `Підпис ${p}.`, 400);
  const approval = currentApproval(db, caseId);
  if (!approval) throw new DomainError('NO_APPROVAL', 'Чинного погодження немає: підпис погоджують для конкретної погодженої версії.', 409);
  const version = getVersion(db, approval.version_id);
  const content = versionContent(version);
  const trigger = content.boundaries.trigger;
  if (trigger.trim() === '') throw new DomainError('BAD_STATE', 'У погодженому описі немає тригера процесу: підписувати нічого.', 409);
  if (label.length >= trigger.length) {
    throw new DomainError('BAD_INPUT', 'Короткий підпис не коротший за повний тригер: окреме рішення тут нічого не дає.', 400);
  }
  const row: Omit<StartLabelRow, 'record_hash'> = {
    id: `slbl_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    case_id: caseId, version_id: version.id, content_hash: version.content_hash,
    label, full_trigger_sha256: sha256(trigger), reason,
    confirmed_by: actor.name, confirmed_at: new Date().toISOString(),
  };
  run(db,
    `INSERT INTO start_label (id, case_id, version_id, content_hash, label, full_trigger_sha256, reason, confirmed_by, confirmed_at, record_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    row.id, row.case_id, row.version_id, row.content_hash, row.label, row.full_trigger_sha256, row.reason,
    row.confirmed_by, row.confirmed_at, startLabelHash(row));
  audit(db, caseId, actor, 'start_label_confirmed', { version_id: version.id, label, trigger_chars: trigger.length, reason });
  return one<StartLabelRow>(db, 'SELECT * FROM start_label WHERE id = ?', row.id)!;
}

/** Усі ухвалені рішення кейсу (історія не переписується). */
export const listStartLabels = (db: DB, caseId: string): StartLabelRow[] =>
  all<StartLabelRow>(db, 'SELECT * FROM start_label WHERE case_id = ? ORDER BY rowid DESC', caseId);
