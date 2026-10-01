// Формує evals/cx-preparation/criteria.md із criteria.ts, щоб документ і програмні перевірки не розходились.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCriteriaMd } from '../evals/cx-preparation/render.ts';

const out = join(import.meta.dirname, '..', 'evals', 'cx-preparation', 'criteria.md');
writeFileSync(out, renderCriteriaMd());
console.log('OK:', out);
