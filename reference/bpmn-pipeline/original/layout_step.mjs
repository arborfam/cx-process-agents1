import { readFileSync, writeFileSync } from 'fs';
import { layoutProcess } from 'bpmn-auto-layout';
const [,, inp, out] = process.argv;
const r = await layoutProcess(readFileSync(inp, 'utf8'));
writeFileSync(out, typeof r === 'string' ? r : r.xml);
if (r.warnings?.length) console.log('WARNINGS:', JSON.stringify(r.warnings));
