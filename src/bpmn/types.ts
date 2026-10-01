/**
 * Типи зрізу 3a: вхідний пакет, знахідки, результат генерації.
 * Усе, що створює й перевіряє схему, — звичайний код. Моделі тут немає (тест це перевіряє).
 */
import type { Content, NotationKindT } from '../schema.ts';

/** Походження пакета. `test-fixture` — підготовлений вручну синтетичний пакет, створений без AI. */
export type PackageOrigin = 'product' | 'test-fixture';

/**
 * Вид нотації, якої генератор v1 не підтримує (D21). Джерело правди — підтверджені вимоги `content.notation_requirements`
 * (D61): вони у змісті версії, під хешем і погодженням; окремого входу «позначки» в генератора немає.
 */
export type UnsupportedKind = NotationKindT;

/** Погоджений пакет — єдиний вхід генератора. Усе інше береться з нього дослівно. */
export interface ApprovedPackage {
  /** ID погодженої версії AS-IS. */
  versionId: string;
  /** SHA-256 змісту версії (хеш погодженої версії). */
  contentHash: string;
  /** Зміст версії. Назва пулу — `content.process_name` (D62), вимоги до нотації — `content.notation_requirements` (D61). */
  content: Content;
  origin: PackageOrigin;
}

/**
 * Напис на єдиному пулі (v1: пул = процес) — лише назва процесу зі змісту версії. Назви кейсу тут немає й бути не може.
 * Порожній рядок означає «не зазначено» (генератор тоді відмовляє, див. PROCESS_NAME_MISSING).
 */
export const poolNameOf = (p: Pick<ApprovedPackage, 'content'>): string => p.content.process_name ?? '';

/** Клас знахідки: що саме і чому. */
export type FindingClass =
  | 'K1'            // невизначеність, що заважає побудувати коректний потік (D28) — блокує
  | 'INVALID_INPUT' // справді некоректний вхід (повторні ID, хибні посилання, недозволені символи)
  | 'UNSUPPORTED'   // потрібна нотація поза підтримуваним переліком (D21)
  | 'K2';           // некритичне відоме обмеження — не блокує

export interface Finding {
  code: string;
  class: FindingClass;
  message: string;
  /** ID кроків або інших елементів, яких стосується знахідка. */
  refs: string[];
}

export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  refs: string[];
}

/** Один рядок карти «крок AS-IS ↔ елемент схеми». */
export interface StepMapRow {
  step_id: string;
  role: string;
  action: string;
  bpmn_task_id: string;
  lane_id: string;
  gateway_id: string | null;
  drawio_cell_id: string | null;
  outgoing: { condition: string; to: string; flow_id: string; target_element_id: string }[];
}

export interface DrawioExport {
  status: 'ok' | 'failed';
  xml: string | null;
  issues: Issue[];
}

export interface VerifyReport {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export interface Binding {
  versionId: string;
  contentHash: string;
  origin: string;
  generator: string;
}

export type GenerationResult =
  | {
    status: 'ok';
    bpmn: string;
    drawio: DrawioExport;
    map: StepMapRow[];
    binding: Binding;
    /** Відомі некритичні обмеження (K2) і поля, яких на схемі немає. Показуються поруч зі схемою. */
    knownLimits: Finding[];
    verification: VerifyReport;
    /** Попередження лейаутера (передаються як є). Непорожній список = «потребує уваги». */
    layoutWarnings: string[];
    layoutScale: { x: number; y: number };
  }
  | { status: 'blocked'; findings: Finding[]; warnings: Finding[] }
  | { status: 'unsupported'; findings: Finding[]; explanation: string; warnings: Finding[] }
  | { status: 'verification_failed'; stage: 'layout' | 'bpmn'; issues: Issue[]; layoutWarnings: string[] };
