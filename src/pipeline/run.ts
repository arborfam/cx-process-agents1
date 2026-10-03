/**
 * Запуск ланцюга власниці: таблиця → .bpmn → розкладка → підписи → .drawio.
 *
 * Правила виконання:
 *  • скрипти запускаються СПИСКОМ аргументів (`spawn` без оболонки). Жоден текст — ні з опису, ні з
 *    відповіді моделі — не стає командою оболонки; таблиця передається файлом, а не аргументом;
 *  • кожен запуск має власну тимчасову теку (`mkdtemp`), яка видаляється навіть після помилки:
 *    паралельні запуски не бачать файлів одне одного (на відміну від `/tmp/_sem.bpmn` в `run_pipeline.sh`);
 *  • ненульовий код виходу, порожній вихідний файл чи перевищення часу — помилка з текстом stderr,
 *    а не «мовчазний успіх»;
 *  • Windows: інтерпретатор Python береться з `CX_PYTHON`, інакше пробуються `python3` і `python`;
 *    Node — той самий, що виконує застосунок. Bash не потрібен.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PIPELINE_STEPS, pipelineVersion, scriptHashes, scriptPath } from './scripts.ts';

export interface PipelineInput {
  csv: string;
  poolName: string;
  /** Порядок доріжок — ролі погодженого опису, що мають дії. */
  lanes: string[];
  /** Повний текст для деталей елемента (ID рядка таблиці → текст), напр. повний тригер. */
  documentation?: Record<string, string>;
  /** Прив'язка файлу до погодженої версії: вона записується всередину .bpmn. */
  binding?: { versionId: string; contentHash: string; origin: string; generator: string };
}

export interface PipelineLogStep { step: string; code: number; stdout: string; stderr: string; ms: number }

export type PipelineResult =
  | { ok: true; bpmn: string; drawio: string; log: PipelineLogStep[]; warnings: string[]; pipelineVersion: string; scripts: Record<string, string> }
  | { ok: false; stage: string; message: string; log: PipelineLogStep[] };

/** Таймаут одного кроку (мс). Схема на кілька десятків кроків виконується частки секунди. */
export const STEP_TIMEOUT_MS = 60_000;

function pythonCandidates(): string[] {
  const fromEnv = process.env.CX_PYTHON;
  return fromEnv ? [fromEnv] : ['python3', 'python'];
}

let pythonCache: string | null | undefined;
export function findPython(): string | null {
  if (pythonCache !== undefined) return pythonCache;
  for (const cmd of pythonCandidates()) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0) { pythonCache = cmd; return cmd; }
  }
  pythonCache = null;
  return null;
}

export function runPipeline(input: PipelineInput): PipelineResult {
  const log: PipelineLogStep[] = [];
  const python = findPython();
  if (!python) {
    return { ok: false, stage: 'python', message: 'Python не знайдено. Пайплайн побудови схеми виконують скрипти Python; встановіть Python 3 або вкажіть шлях у змінній середовища CX_PYTHON.', log };
  }
  const dir = mkdtempSync(join(tmpdir(), 'cx-pipeline-'));
  try {
    const f = (name: string): string => join(dir, name);
    writeFileSync(f('in.csv'), input.csv, 'utf8');
    writeFileSync(f('lanes.txt'), input.lanes.join('\n') + '\n', 'utf8');
    writeFileSync(f('docs.json'), JSON.stringify(input.documentation ?? {}), 'utf8');
    writeFileSync(f('binding.json'), JSON.stringify(input.binding ?? {}), 'utf8');

    const argv: Record<string, string[]> = {
      'table_to_bpmn.py': [f('in.csv'), f('sem.bpmn'), input.poolName, '--lane-order', f('lanes.txt'), '--docs', f('docs.json'), '--binding', f('binding.json')],
      'layout_step.mjs': [f('sem.bpmn'), f('laid.bpmn')],
      'fix_labels.py': [f('laid.bpmn'), f('fixed.bpmn')],
      'bpmn_di_to_drawio.py': [f('fixed.bpmn'), f('out.drawio')],
    };
    const outputs: Record<string, string> = {
      'table_to_bpmn.py': f('sem.bpmn'), 'layout_step.mjs': f('laid.bpmn'),
      'fix_labels.py': f('fixed.bpmn'), 'bpmn_di_to_drawio.py': f('out.drawio'),
    };

    for (const step of PIPELINE_STEPS) {
      const cmd = step.runner === 'python' ? python : process.execPath;
      const t0 = Date.now();
      const r = spawnSync(cmd, [scriptPath(step.name), ...argv[step.name]!], {
        encoding: 'utf8', timeout: STEP_TIMEOUT_MS, shell: false, cwd: dir, windowsHide: true,
      });
      const entry: PipelineLogStep = {
        step: step.name, code: r.status ?? -1, ms: Date.now() - t0,
        stdout: (r.stdout ?? '').slice(0, 2000), stderr: (r.stderr ?? '').slice(0, 4000),
      };
      log.push(entry);
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return { ok: false, stage: step.name, message: `Крок «${step.title}» не завершився за ${STEP_TIMEOUT_MS / 1000} с і зупинений.`, log };
      }
      if (r.status !== 0) {
        return { ok: false, stage: step.name, message: `Крок «${step.title}» завершився помилкою (код ${r.status ?? '—'}): ${entry.stderr.trim() || 'повідомлення немає'}`, log };
      }
      let produced = '';
      try { produced = readFileSync(outputs[step.name]!, 'utf8'); } catch { produced = ''; }
      if (produced.trim() === '') {
        return { ok: false, stage: step.name, message: `Крок «${step.title}» завершився успішно, але файлу не створив. Результат не приймається.`, log };
      }
    }

    const warnings: string[] = [];
    for (const entry of log) {
      if (entry.step === 'fix_labels.py') {
        try {
          const report = JSON.parse(entry.stdout.trim()) as { warnings?: string[] };
          warnings.push(...(report.warnings ?? []));
        } catch { warnings.push('Крок розміщення підписів не повернув звіту — попередження невідомі.'); }
      }
      if (/WARNINGS:/.test(entry.stdout)) warnings.push(entry.stdout.slice(entry.stdout.indexOf('WARNINGS:')).trim().slice(0, 500));
    }
    return {
      ok: true,
      bpmn: readFileSync(f('fixed.bpmn'), 'utf8'),
      drawio: readFileSync(f('out.drawio'), 'utf8'),
      log, warnings, pipelineVersion: pipelineVersion(), scripts: scriptHashes(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
