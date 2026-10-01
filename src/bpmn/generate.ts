/**
 * Оркестратор зрізу 3a: погоджений пакет → перевірка входу → побудова → розкладка → зворотна перевірка → експорт.
 *
 * Гарантії:
 *  • файл видається лише після того, як зворотна перевірка його готового вигляду пройшла без помилок;
 *  • жодних викликів моделі, мережі чи спільних файлів; усе в пам'яті; без глобального стану;
 *  • статус `unsupported` і `blocked` НІКОЛИ не змінюють погодження чи версію (генератор не має доступу до бази).
 */
import { analyzePackage, unsupportedExplanation } from './validate.ts';
import { buildSemantic } from './build.ts';
import { layoutAndScale } from './layout.ts';
import { verifyBpmn } from './verify.ts';
import { exportDrawio } from './drawio.ts';
import { GENERATOR_NAME } from './ids.ts';
import type { ApprovedPackage, GenerationResult } from './types.ts';

/**
 * Шов для тестів: впровадження збою між етапами, щоб довести, що пошкоджений результат не видається.
 * Продуктовий код ці параметри не передає.
 */
export interface GenerateFaultInjection {
  /** Пошкоджує .bpmn після розкладки, до зворотної перевірки. */
  tamperBpmn?: (xml: string) => string;
  /** Пошкоджує .drawio після експорту, до його власної звірки. */
  tamperDrawio?: (xml: string) => string;
}

export async function generateBpmn(pkg: ApprovedPackage, fault: GenerateFaultInjection = {}): Promise<GenerationResult> {
  const analysis = analyzePackage(pkg);
  if (analysis.blocking.length > 0) {
    return { status: 'blocked', findings: [...analysis.blocking, ...analysis.unsupported], warnings: analysis.knownLimits };
  }
  if (analysis.unsupported.length > 0) {
    return { status: 'unsupported', findings: analysis.unsupported, explanation: unsupportedExplanation(analysis.unsupported, pkg), warnings: analysis.knownLimits };
  }

  const semantic = buildSemantic(pkg);
  const laid = await layoutAndScale(semantic.xml, pkg);
  if (!laid.ok) return { status: 'verification_failed', stage: 'layout', issues: laid.issues, layoutWarnings: laid.warnings };

  const finalXml = fault.tamperBpmn ? fault.tamperBpmn(laid.xml) : laid.xml;
  const { report, model, map } = verifyBpmn(finalXml, pkg);
  if (!report.ok || !model) return { status: 'verification_failed', stage: 'bpmn', issues: report.errors, layoutWarnings: laid.warnings };

  const drawio = exportDrawio(model, pkg, map, fault.tamperDrawio);
  for (const row of map) {
    row.drawio_cell_id = drawio.status === 'ok' ? row.bpmn_task_id : null;
  }
  return {
    status: 'ok',
    bpmn: finalXml,
    drawio,
    map,
    binding: { versionId: pkg.versionId, contentHash: pkg.contentHash, origin: pkg.origin, generator: GENERATOR_NAME },
    knownLimits: analysis.knownLimits,
    verification: report,
    layoutWarnings: laid.warnings,
    layoutScale: laid.scale,
  };
}
