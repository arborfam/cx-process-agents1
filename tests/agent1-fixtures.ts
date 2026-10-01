/**
 * Мінімальні синтетичні приклади для тестів агента 1 (узгодженість чернетки, пропозиції, прив'язка питань).
 * Це вигаданий загальний процес «обробка запиту»: без ідентифікаторів реальних кейсів і без метаданих запусків.
 * Структура навмисно повторює класи помилок, знайдені на першому справжньому прогоні: застарілий «скелет» кроків + детальний ланцюжок,
 * початок, поставлений поруч зі скелетом, і пара залежних пропозицій заміни.
 */
import type { DB } from '../src/db.ts';
import { acceptDraft, approve, createCase, headVersion, insertVersion, previewAccept, submitForApproval, versionContent, type VersionRow } from '../src/domain.ts';
import { emptyContent, UNKNOWN, type Content } from '../src/schema.ts';
import { human } from './helpers.ts';

export const T = (id: string, role: string, action: string, result: string, next: { to: string; condition?: string }[]) => ({
  id, role, action, entry_condition: '', input_artifact: '', result, next: next.map((n) => ({ to: n.to, condition: n.condition ?? '' })), source_ids: [] as string[],
});

export type LinkKindT = 'direction' | 'unconfirmed_sequence' | 'exception' | 'step_detail';

export const Q = (id: string, text: string, links: { step: string; condition: string; kind?: LinkKindT }[], opts: { critical?: boolean; status?: 'open' | 'closed' } = {}) => ({
  id, text, critical: opts.critical ?? false, impact: 'вплив (синтетичний)', addressee: '', status: opts.status ?? 'open' as const,
  answer: opts.status === 'closed' ? 'відповідь' : '', closed_by_source_id: null, origin: 'agent' as const, criticality_note: '',
  ...(links.length ? { affects_transitions: links.map((l) => ({ step_id: l.step, condition: l.condition, ...(l.kind ? { kind: l.kind } : {}) })) } : {}),
});

export const P = (id: string, step: string, replacement: string, status: 'proposed' | 'accepted' | 'rejected' = 'proposed') => ({
  id, action: 'replace' as const, step_id: step, replacement_step_id: replacement, reason: 'пояснення (синтетичне)', evidence_source_id: '', evidence_quote: '',
  status, decided_by: '', decision_note: '',
});

/** Загальна заготовка змісту: межі, ролі, назва процесу. */
export function baseContent(): Content {
  const c = emptyContent();
  c.summary = 'Синтетичний опис обробки запиту.';
  c.business_context = 'Вигаданий процес для тестів.';
  c.boundaries = { trigger: 'Надходить запит', input: 'Запит', completion: 'Відповідь надіслано', result: 'Відповідь' };
  c.roles = ['Замовник', 'Виконавець'];
  c.process_name = 'Обробка запиту (синтетичний процес)';
  return c;
}

/**
 * Стан «після другого запуску агента»: старий скелет K1 → K2, детальний ланцюжок K3 → K4 → K5 → K6, початок = K3 (поставлено поруч із
 * скелетом), дві залежні пропозиції заміни: R1 (K1 → K3) і R2 (K2 → K4). Прийняти лише одну з них означає лишити недосяжний крок.
 */
export function skeletonPlusChain(): Content {
  const c = baseContent();
  c.entry_step_id = 'K3';
  c.steps = [
    T('K1', 'Замовник', 'Надсилає запит', 'Запит надіслано', [{ to: 'K2' }]),
    T('K2', 'Виконавець', 'Готує відповідь (загальний крок)', 'Відповідь готова', [{ to: 'END' }]),
    T('K3', 'Виконавець', 'Реєструє запит', 'Запит зареєстровано', [{ to: 'K4' }]),
    T('K4', 'Виконавець', 'Уточняє деталі у замовника', 'Деталі отримано', [{ to: 'K5' }]),
    T('K5', 'Виконавець', 'Складає відповідь', 'Відповідь складено', [{ to: 'K6' }]),
    T('K6', 'Виконавець', 'Надсилає відповідь', 'Відповідь надіслано', [{ to: 'END' }]),
  ];
  c.step_proposals = [P('R1', 'K1', 'K3'), P('R2', 'K2', 'K4')];
  return c;
}

/** Створює кейс і кладе зміст як голову (версія від агента), повертає кейс і версію. */
export function caseWith(db: DB, content: Content, createdBy: 'agent' | 'analyst' = 'agent'): { caseId: string; version: VersionRow } {
  const c = createCase(db, human, 'Синтетичний кейс', 'demo');
  const v = insertVersion(db, { caseId: c.id, content, createdBy, actorName: createdBy === 'agent' ? 'analyst-agent' : 'Аналітикиня', parentId: headVersion(db, c.id).id, covered: [], owned: [], note: 'синтетична версія' });
  db.exec(`UPDATE "case" SET head_version_id = '${v.id}' WHERE id = '${c.id}'`);
  return { caseId: c.id, version: v };
}

export const headContent = (db: DB, caseId: string): Content => versionContent(headVersion(db, caseId));
export { UNKNOWN };

/** Кейс, чию версію (зміст має бути структурно повним) прийнято, передано й погоджено людиною. */
export function approvedWith(db: DB, content: Content): { caseId: string; version: VersionRow } {
  const { caseId, version } = caseWith(db, content, 'analyst');
  acceptDraft(db, human, caseId, version.id);
  submitForApproval(db, human, caseId);
  approve(db, human, caseId, { versionId: version.id, checklistConfirmed: true });
  return { caseId, version };
}

/** Хеш показу наслідків для точного набору пропозицій на поточній версії (те, що людина бачить у картці перед рішенням). */
export function pvHash(db: DB, caseId: string, ids: string[]): string {
  return previewAccept(headContent(db, caseId), ids, { caseId, versionId: headVersion(db, caseId).id }).hash;
}
