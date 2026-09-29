import { DomainError } from './errors.ts';
import type { Problem, Step } from './schema.ts';

/**
 * Прості текстові формати для форми редагування (аналітикиня не пише JSON).
 *  Крок:      ID | Роль | Дія | Результат | Наступні
 *  Наступні:  «S4 (погоджено); END (відхилено)» — ID кроку або END, умова в дужках
 *  Проблема:  ID | Симптом | Наслідок
 * Рядок без ID (на одне поле менше) отримує новий ID. Поля, яких немає у форматі
 * (умова входу, вхідний артефакт, джерела), беруться з попередньої версії кроку.
 */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function parseNext(text: string): { to: string; condition: string }[] {
  const items = text
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.map((item) => {
    const m = /^([^\s(]+)\s*(?:\((.*)\))?$/.exec(item);
    if (!m) throw new DomainError('VALIDATION', `Не вдалося розібрати перехід: «${item}»`, 400);
    const to = m[1]!.toLowerCase() === 'кінець' ? 'END' : m[1]!;
    return { to, condition: (m[2] ?? '').trim() };
  });
}

function nextToText(next: Step['next']): string {
  return next.map((n) => (n.condition ? `${n.to} (${n.condition})` : n.to)).join('; ');
}

export function stepsToText(steps: Step[]): string {
  return steps.map((s) => [s.id, s.role, s.action, s.result, nextToText(s.next)].join(' | ')).join('\n');
}

export function parseSteps(text: string, previous: Step[]): Step[] {
  const prevById = new Map(previous.map((s) => [s.id, s]));
  const used = new Set<string>();
  const lines = cleanLines(text);
  const parsed: { id: string | null; fields: string[] }[] = lines.map((line, i) => {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length === 5) return { id: parts[0]!, fields: parts.slice(1) };
    if (parts.length === 4) return { id: null, fields: parts };
    throw new DomainError(
      'VALIDATION',
      `Рядок ${i + 1} кроків: потрібно 5 полів «ID | Роль | Дія | Результат | Наступні» (або 4 без ID), знайдено ${parts.length}`,
      400,
    );
  });
  for (const p of parsed) {
    if (p.id !== null) {
      if (!ID_RE.test(p.id)) throw new DomainError('VALIDATION', `Некоректний ID кроку: «${p.id}»`, 400);
      if (used.has(p.id)) throw new DomainError('VALIDATION', `ID кроку повторюється: ${p.id}`, 400);
      used.add(p.id);
    }
  }
  let counter = 1;
  const nextFreeId = (): string => {
    while (used.has(`S${counter}`) || prevById.has(`S${counter}`)) counter++;
    const id = `S${counter}`;
    used.add(id);
    return id;
  };
  return parsed.map((p) => {
    const id = p.id ?? nextFreeId();
    const [role, action, result, next] = p.fields as [string, string, string, string];
    const prev = prevById.get(id);
    return {
      id,
      role,
      action,
      entry_condition: prev?.entry_condition ?? '',
      input_artifact: prev?.input_artifact ?? '',
      result,
      next: parseNext(next),
      source_ids: prev?.source_ids ?? [],
    };
  });
}

export function problemsToText(problems: Problem[]): string {
  return problems.map((p) => [p.id, p.symptom, p.impact].join(' | ')).join('\n');
}

export function parseProblems(text: string, previous: Problem[]): Problem[] {
  const prevById = new Map(previous.map((p) => [p.id, p]));
  const used = new Set<string>();
  let counter = 1;
  return cleanLines(text).map((line, i) => {
    const parts = line.split('|').map((p) => p.trim());
    let id: string;
    let symptom: string;
    let impact: string;
    if (parts.length === 3) {
      [id, symptom, impact] = parts as [string, string, string];
      if (!ID_RE.test(id)) throw new DomainError('VALIDATION', `Некоректний ID проблеми: «${id}»`, 400);
    } else if (parts.length === 2) {
      [symptom, impact] = parts as [string, string];
      while (used.has(`P${counter}`) || prevById.has(`P${counter}`)) counter++;
      id = `P${counter}`;
    } else {
      throw new DomainError('VALIDATION', `Рядок ${i + 1} проблем: потрібно «ID | Симптом | Наслідок»`, 400);
    }
    if (used.has(id)) throw new DomainError('VALIDATION', `ID проблеми повторюється: ${id}`, 400);
    used.add(id);
    const prev = prevById.get(id);
    return { id, symptom, cause: prev?.cause ?? '', impact, impact_is_estimate: prev?.impact_is_estimate ?? false };
  });
}

export function rolesToText(roles: string[]): string {
  return roles.join('\n');
}

export function parseRoles(text: string): string[] {
  return [...new Set(cleanLines(text))];
}
