/**
 * РОБОЧА КОПІЯ кроку розкладки власниці (оригінал — reference/bpmn-pipeline/original/layout_step.mjs,
 * він НЕ змінюється). Логіка не змінена; див. pipeline/DIFFERENCES.md.
 *
 * BPMN без координат → BPMN із координатами (bpmn-auto-layout).
 */
import { readFileSync, writeFileSync } from 'fs';
import { layoutProcess } from 'bpmn-auto-layout';
const [,, inp, out] = process.argv;
const r = await layoutProcess(readFileSync(inp, 'utf8'));
writeFileSync(out, typeof r === 'string' ? r : r.xml);
if (r.warnings?.length) console.log('WARNINGS:', JSON.stringify(r.warnings));
