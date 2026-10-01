import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx, type DB } from './db.ts';
import { DomainError } from './errors.ts';
import { sha256 } from './hash.ts';
import {
  addSource, audit, createCase, getCase, headVersion, listSources, requireHuman, type Actor, type CaseRow, type SourceRow,
} from './domain.ts';

/**
 * Навчальний сценарій «Підготовка CX до продуктових змін». Джерела подаються поетапно; на кожному
 * запуску агент бачить лише додані джерела. Критерії оцінки лежать окремо від застосунку й сюди не підключаються.
 * Приховане уточнення негативного сценарію (SRC-09) подається лише явною дією аналітика.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios', 'cx-preparation');

export type Variant = 'positive' | 'negative';
export const SCENARIO_ID = 'cx-preparation';
export const TOTAL_STAGES = 5;

interface ManifestEntry {
  id: string; title: string; kind: SourceRow['kind']; origin: 'synthetic'; stage: number | null;
  variant: 'both' | Variant; provenance: string; file: string; sha256: string;
}
interface Manifest { original: { file: string; sha256: string }; sources: ManifestEntry[] }

export interface ScenarioSource extends ManifestEntry { text: string }

/** Читає маніфест і перевіряє, що жоден файл не змінено після розбиття (SHA-256). */
export function loadScenario(root = ROOT): { sources: ScenarioSource[]; originalSha256: string } {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Manifest;
  const original = readFileSync(join(root, manifest.original.file), 'utf8');
  if (sha256(original) !== manifest.original.sha256) throw new Error('Оригінал пакета змінено: SHA-256 не збігається з маніфестом.');
  const sources = manifest.sources.map((e) => {
    const text = readFileSync(join(root, e.file), 'utf8');
    if (sha256(text) !== e.sha256) throw new Error(`Джерело ${e.id} змінено після розбиття (SHA-256 не збігається).`);
    return { ...e, text };
  });
  return { sources, originalSha256: manifest.original.sha256 };
}

const variantOf = (c: CaseRow): Variant => {
  const m = /^cx-preparation:(positive|negative)$/.exec(c.scenario_id ?? '');
  if (!m) throw new DomainError('NOT_SCENARIO', 'Цей кейс не належить навчальному сценарію', 409);
  return m[1] as Variant;
};

export function stageSources(variant: Variant, stage: number, sc = loadScenario()): ScenarioSource[] {
  return sc.sources.filter((s) => s.stage === stage && (s.variant === 'both' || s.variant === variant));
}

const TITLES: Record<Variant, string> = {
  positive: 'Підготовка CX до продуктових змін — навчальний сценарій А (синтетичні джерела)',
  negative: 'Підготовка CX до продуктових змін — навчальний сценарій Б (синтетичні джерела)',
};

/** Створює окремий кейс сценарію (історія, версії й погодження не пов’язані з іншим сценарієм). Джерел ще немає. */
export function createScenarioCase(db: DB, actor: Actor, variant: Variant, mode: string): CaseRow {
  requireHuman(actor, 'створення сценарного кейсу');
  if (variant !== 'positive' && variant !== 'negative') throw new DomainError('VALIDATION', 'Варіант сценарію: positive або negative', 400);
  return createCase(db, actor, TITLES[variant], mode, { scenarioId: `${SCENARIO_ID}:${variant}` });
}

function coveredAll(db: DB, caseId: string): { ok: boolean; missing: SourceRow[] } {
  const head = headVersion(db, caseId);
  const covered = new Set(JSON.parse(head.covered_json) as string[]);
  const missing = listSources(db, caseId).filter((s) => s.read_status === 'ok' && !covered.has(s.id));
  return { ok: missing.length === 0, missing };
}

/** Додає матеріали наступного етапу. Попередні матеріали мають бути опрацьовані поточною версією. */
export function advanceScenario(db: DB, actor: Actor, caseId: string): { stage: number; added: string[] } {
  requireHuman(actor, 'додавання матеріалів етапу');
  return tx(db, () => {
    const c = getCase(db, caseId);
    const variant = variantOf(c);
    if (c.scenario_stage >= TOTAL_STAGES) throw new DomainError('SCENARIO_DONE', 'Усі етапи сценарію вже додано', 409);
    if (c.scenario_stage > 0) {
      const cov = coveredAll(db, caseId);
      if (!cov.ok) {
        throw new DomainError('PREVIOUS_STAGE_UNPROCESSED',
          `Спершу опрацюйте матеріали етапу ${c.scenario_stage}: запустіть аналіз або врахуйте їх у версії (не враховано: ${cov.missing.map((s) => s.ref ?? s.title).join(', ')}).`, 409);
      }
    }
    const stage = c.scenario_stage + 1;
    const added: string[] = [];
    for (const s of stageSources(variant, stage)) {
      addSource(db, actor, caseId, { kind: s.kind, title: `${s.id} · ${s.title}`, content: s.text, origin: 'synthetic', required: true, ref: s.id });
      added.push(s.id);
    }
    if (added.length === 0) throw new DomainError('SCENARIO_EMPTY', `Для етапу ${stage} немає матеріалів`, 500);
    db.prepare('UPDATE "case" SET scenario_stage = ? WHERE id = ?').run(stage, caseId);
    audit(db, caseId, actor, 'scenario_stage_added', { stage, sources: added });
    return { stage, added };
  });
}

/**
 * Явне уточнення негативного сценарію: аналітик свідомо подає відповідь, якої раніше не було.
 * Створюється нове джерело (нова незмінна версія джерел), агент або аналітик опрацьовують його,
 * результат — нова версія, яку треба перевірити й погодити заново.
 */
export function addExplicitClarification(db: DB, actor: Actor, caseId: string): { added: string } {
  requireHuman(actor, 'подання явного уточнення');
  return tx(db, () => {
    const c = getCase(db, caseId);
    if (variantOf(c) !== 'negative') throw new DomainError('NOT_APPLICABLE', 'Явне уточнення є лише в негативному сценарії', 409);
    if (c.scenario_stage < TOTAL_STAGES) throw new DomainError('TOO_EARLY', 'Явне уточнення можна подати після всіх п’яти етапів', 409);
    if (listSources(db, caseId).some((s) => s.ref === 'SRC-09')) throw new DomainError('ALREADY_ADDED', 'Явне уточнення вже подано', 409);
    const s = loadScenario().sources.find((x) => x.id === 'SRC-09');
    if (!s) throw new DomainError('SCENARIO_EMPTY', 'Немає тексту явного уточнення', 500);
    addSource(db, actor, caseId, { kind: s.kind, title: `${s.id} · ${s.title}`, content: s.text, origin: 'synthetic', required: true, ref: s.id });
    audit(db, caseId, actor, 'scenario_explicit_clarification', { source: s.id });
    return { added: s.id };
  });
}

/** Опис стану сценарію для картки. Текст прихованого уточнення тут не розкривається. */
export function scenarioInfo(db: DB, c: CaseRow) {
  if (!c.scenario_id) return null;
  const variant = variantOf(c);
  const sc = loadScenario();
  const next = c.scenario_stage < TOTAL_STAGES ? stageSources(variant, c.scenario_stage + 1, sc) : [];
  let blocked: string | null = null;
  if (next.length && c.scenario_stage > 0) {
    const cov = coveredAll(db, c.id);
    if (!cov.ok) blocked = `Спершу опрацюйте матеріали етапу ${c.scenario_stage}: запустіть аналіз або врахуйте їх у версії.`;
  }
  const hasClar = listSources(db, c.id).some((s) => s.ref === 'SRC-09');
  return {
    id: c.scenario_id, variant, stage: c.scenario_stage, total: TOTAL_STAGES,
    next_stage: next.length ? c.scenario_stage + 1 : null,
    next_sources: next.map((s) => ({ ref: s.id, title: s.title })),
    can_advance: next.length > 0 && !blocked, blocked_reason: next.length ? blocked : null,
    clarification: variant === 'negative' && c.scenario_stage >= TOTAL_STAGES
      ? { available: !hasClar, added: hasClar } : null,
  };
}
