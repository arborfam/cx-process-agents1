import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fixtureToPackage, type Fixture } from '../src/bpmn/fixture.ts';
import { generateBpmn } from '../src/bpmn/generate.ts';
import type { ApprovedPackage, GenerationResult } from '../src/bpmn/types.ts';

export const FIXTURE_DIR = join(import.meta.dirname, 'bpmn-fixtures');

export function loadFixture(id: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.json`), 'utf8')) as Fixture;
}

export function allFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture);
}

export const pkgOf = (id: string): ApprovedPackage => fixtureToPackage(loadFixture(id));

/** Глибока копія пакета для безпечного пошкодження в тесті. */
export function clonePkg(p: ApprovedPackage): ApprovedPackage {
  return JSON.parse(JSON.stringify(p)) as ApprovedPackage;
}

export async function generateOk(p: ApprovedPackage): Promise<Extract<GenerationResult, { status: 'ok' }>> {
  const r = await generateBpmn(p);
  assert.equal(r.status, 'ok', r.status === 'ok' ? '' : JSON.stringify(r).slice(0, 800));
  return r as Extract<GenerationResult, { status: 'ok' }>;
}

/**
 * Пошкоджує текст файлу й ГАРАНТУЄ, що пошкодження справді змінило файл
 * (раніше «чисті» результати траплялися через помилково складену мутацію — docs/bpmn-pipeline-assessment.md).
 */
export function mutate(xml: string, fn: (s: string) => string, what: string): string {
  const out = fn(xml);
  assert.notEqual(out, xml, `мутація «${what}» не змінила файл — тест некоректний`);
  return out;
}

/** Замінює рівно один збіг регулярного виразу; якщо збігів немає — тест некоректний. */
export function replaceOnce(xml: string, re: RegExp, repl: string | ((m: string, ...g: string[]) => string), what: string): string {
  assert.ok(re.test(xml), `мутація «${what}»: шаблон не знайдено`);
  re.lastIndex = 0;
  return xml.replace(re, repl as never);
}
