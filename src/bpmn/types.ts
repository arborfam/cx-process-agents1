/**
 * Типи зрізу 3a: вхідний пакет, знахідки, результат генерації.
 * Усе, що створює й перевіряє схему, — звичайний код. Моделі тут немає (тест це перевіряє).
 */
import type { Content } from '../schema.ts';

/** Походження пакета. `test-fixture` — підготовлений вручну синтетичний пакет, створений без AI. */
export type PackageOrigin = 'product' | 'test-fixture';

/**
 * Позначка «для цього кроку потрібна нотація, якої генератор не підтримує» (D21).
 * У змісті версії AS-IS таких полів поки немає: у 3a їх задають лише тестові пакети вручну.
 * Автоматично їх виявляє лише агент 2 (зріз 3b) — наближено, без гарантії.
 */
export type UnsupportedKind =
  | 'parallel_branches' | 'timer' | 'message' | 'subprocess' | 'boundary_event' | 'data_object' | 'multiple_entry' | 'other';

export interface UnsupportedMark {
  step_id: string;
  kind: UnsupportedKind;
  detail: string;
}

/** Погоджений пакет — єдиний вхід генератора. Усе інше береться з нього дослівно. */
export interface ApprovedPackage {
  /** ID погодженої версії AS-IS. */
  versionId: string;
  /** SHA-256 змісту версії (хеш погодженої версії). */
  contentHash: string;
  /** Назва пулу (назва кейсу). Не частина змісту AS-IS; береться з запису кейсу й не входить у хеш версії. */
  poolName: string;
  content: Content;
  origin: PackageOrigin;
  unsupportedMarks?: UnsupportedMark[];
}

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
