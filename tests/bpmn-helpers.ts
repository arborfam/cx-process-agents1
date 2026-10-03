import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fixtureToPackage, type Fixture } from '../src/bpmn/fixture.ts';
import { buildThroughPipeline, type GenerateFaultInjection, type PipelineBuildResult } from '../src/bpmn-artifacts.ts';
import { checkCsv, type CsvPlan } from '../src/csv/check.ts';
import { MAX_EVENT_LABEL_CHARS } from '../src/bpmn/text.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import { scriptedCsv } from './csv-fixture.ts';

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

/**
 * Побудова пакета ПРОДУКТОВИМ шляхом (D87): сценарна таблиця → програмна перевірка таблиці → скрипти
 * пайплайна → зворотна звірка обох файлів. Таблицю тут складає тест (`scriptedCsv`), бо в продукті її
 * складає агент 2; програма своєї таблиці не має.
 *
 * `startLabel`: якщо тригер довший за межу розбірливого підпису події, тест грає роль людини, яка
 * погодила короткий підпис (D88) — інакше побудова чесно зупиняється, як і в продукті.
 */
export function pipelineInput(p: ApprovedPackage, startLabel?: string): { pkg: ApprovedPackage; startLabel: { label: string }; csv: string; plan: CsvPlan } {
  const trigger = p.content.boundaries.trigger;
  const label = startLabel ?? (trigger.length > MAX_EVENT_LABEL_CHARS ? trigger.slice(0, 80) : trigger);
  const documentation = label === trigger ? null : trigger;
  const csv = scriptedCsv(p.content, label);
  const check = checkCsv(csv, p, { startLabel: label, startDocumentation: documentation });
  const plan = check.ok ? check.plan : ({ rows: [], byId: new Map(), stepRow: new Map(), edges: [], lanes: [], startLabel: label, startDocumentation: documentation, poolName: p.content.process_name ?? '' } as CsvPlan);
  return { pkg: p, startLabel: { label }, csv, plan };
}

/** Той самий вхід, що й у продукті, але без бази: пакет + сценарна таблиця. */
export async function generateViaPipeline(p: ApprovedPackage, fault: GenerateFaultInjection = {}, startLabel?: string): Promise<PipelineBuildResult> {
  return buildThroughPipeline(pipelineInput(p, startLabel), fault);
}

export async function generateOk(p: ApprovedPackage, startLabel?: string): Promise<Extract<PipelineBuildResult, { status: 'ok' }>> {
  const r = await generateViaPipeline(p, {}, startLabel);
  assert.equal(r.status, 'ok', r.status === 'ok' ? '' : JSON.stringify(r).slice(0, 800));
  return r as Extract<PipelineBuildResult, { status: 'ok' }>;
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
