/**
 * Побудова пакета з погодженої версії в базі (лише читання).
 *
 * УВАГА: ця функція навмисно НЕ підключена до сервера, API чи інтерфейсу. У зрізі 3a схеми будуються лише з тестових пакетів.
 * Коли з'явиться агент 2 (зріз 3b), продуктовий шлях буде вимагати завершеної смислової перевірки перед викликом генератора;
 * обходу цієї перевірки не створюється (тест `bpmn-isolation` стежить, щоб server/runs не імпортували цей модуль).
 *
 * Вимоги до версії — ті самі, що й у серверного дозволу BPMN (`bpmnGuard`): погоджена найновіша версія, хеш збігається
 * зі змістом, немає нових джерел, відкритих критичних питань, невизначених переходів і порушень потоку, пропозицій
 * щодо нотації без рішення, а також є НАЗВА ПРОЦЕСУ (D62): без неї дозвіл не надається й пакет не будується —
 * назву кейсу замість неї не підставляємо. Вимоги до нотації (D61) беруться зі змісту версії, а не з окремого входу.
 */
import type { DB } from '../db.ts';
import { DomainError } from '../errors.ts';
import { bpmnGuard, currentApproval, getVersion, versionContent } from '../domain.ts';
import type { ApprovedPackage } from './types.ts';

export function packageFromApproval(db: DB, caseId: string): ApprovedPackage {
  const guard = bpmnGuard(db, caseId);
  if (!guard.ok) {
    throw new DomainError('GUARD_FAILED', 'Серверний дозвіл BPMN не надано: пакет не будується.', 409, { reasons: guard.reasons });
  }
  const approval = currentApproval(db, caseId)!;
  const version = getVersion(db, approval.version_id);
  return { versionId: version.id, contentHash: version.content_hash, content: versionContent(version), origin: 'product' };
}
