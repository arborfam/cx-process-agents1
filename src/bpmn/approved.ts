/**
 * Побудова пакета з погодженої версії в базі (лише читання).
 *
 * УВАГА: ця функція навмисно НЕ підключена до сервера, API чи інтерфейсу. У зрізі 3a схеми будуються лише з тестових пакетів.
 * Коли з'явиться агент 2 (зріз 3b), продуктовий шлях буде вимагати завершеної смислової перевірки перед викликом генератора;
 * обходу цієї перевірки не створюється (тест `bpmn-isolation` стежить, щоб server/runs не імпортували цей модуль).
 *
 * Вимоги до версії — ті самі, що й у серверного дозволу BPMN (`bpmnGuard`): погоджена найновіша версія, хеш збігається
 * зі змістом, немає нових джерел, відкритих критичних питань, невизначених переходів і порушень потоку.
 */
import type { DB } from '../db.ts';
import { DomainError } from '../errors.ts';
import { bpmnGuard, currentApproval, getCase, getVersion, versionContent } from '../domain.ts';
import type { ApprovedPackage, UnsupportedMark } from './types.ts';

export function packageFromApproval(db: DB, caseId: string, opts: { unsupportedMarks?: UnsupportedMark[] } = {}): ApprovedPackage {
  const guard = bpmnGuard(db, caseId);
  if (!guard.ok) {
    throw new DomainError('GUARD_FAILED', 'Серверний дозвіл BPMN не надано: пакет не будується.', 409, { reasons: guard.reasons });
  }
  const approval = currentApproval(db, caseId)!;
  const version = getVersion(db, approval.version_id);
  const pkg: ApprovedPackage = {
    versionId: version.id,
    contentHash: version.content_hash,
    poolName: getCase(db, caseId).title,
    content: versionContent(version),
    origin: 'product',
  };
  if (opts.unsupportedMarks?.length) pkg.unsupportedMarks = opts.unsupportedMarks;
  return pkg;
}
