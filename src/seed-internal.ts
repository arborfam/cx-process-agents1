import { run, type DB } from './db.ts';

/** Лише для створення демо-кейсу: переносить вказівник на поточну версію. */
export function setHeadForSeed(db: DB, caseId: string, versionId: string): void {
  run(db, 'UPDATE "case" SET head_version_id = ? WHERE id = ?', versionId, caseId);
}
