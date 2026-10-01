/**
 * Будівельник самодостатньої HTML-сторінки для перегляду тестової схеми (зріз 3a).
 *
 * Використовує bpmn-js (NavigatedViewer, 18.30.1). Водяний знак bpmn.io НЕ вилучається й не перекривається
 * (умова ліцензії, D30): полотно займає власний блок, поряд із ним елементів немає.
 * Усе вбудовано в один файл — його можна відкрити подвійним клацанням, без сервера й інтернету.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Finding, StepMapRow } from '../../src/bpmn/types.ts';

const require = createRequire(import.meta.url);
const distDir = join(dirname(require.resolve('bpmn-js/package.json')), 'dist');
const read = (p: string): string => readFileSync(join(distDir, p), 'utf8');

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ViewerInput {
  title: string;
  description: string;
  bpmn: string;
  map: StepMapRow[];
  knownLimits: Finding[];
  versionId: string;
  contentHash: string;
  /** Відносні посилання на файли поруч (для завантаження). */
  files: { bpmn: string; drawio?: string; map?: string };
  verification: { errors: number; warnings: number; drawio: string };
}

export function buildViewerHtml(v: ViewerInput): string {
  const js = read('bpmn-navigated-viewer.production.min.js').replace(/<\/script/gi, '<\\/script');
  const css = read('assets/diagram-js.css') + '\n' + read('assets/bpmn-js.css');
  const xmlJson = JSON.stringify(v.bpmn).replace(/</g, '\\u003c').replace(/<\/script/gi, '<\\/script');
  const rows = v.map.map((r) => {
    const outs = r.outgoing.map((o) => `${o.condition ? `«${esc(o.condition)}» → ` : '→ '}${esc(o.to)}`).join('<br>');
    return `<tr data-el="${esc(r.bpmn_task_id)}" data-gw="${esc(r.gateway_id ?? '')}">
      <td><b>${esc(r.step_id)}</b></td><td>${esc(r.role)}</td><td>${esc(r.action)}</td>
      <td><code>${esc(r.bpmn_task_id)}</code>${r.gateway_id ? `<br><code>${esc(r.gateway_id)}</code> (шлюз)` : ''}</td>
      <td>${outs}</td></tr>`;
  }).join('\n');
  const limits = v.knownLimits.length
    ? `<ul>${v.knownLimits.map((l) => `<li><code>${esc(l.code)}</code> ${esc(l.message)}</li>`).join('')}</ul>`
    : '<p>Немає.</p>';
  const links = [
    `<a href="${esc(v.files.bpmn)}" download>.bpmn (основний результат)</a>`,
    v.files.drawio ? `<a href="${esc(v.files.drawio)}" download>.drawio (експорт)</a>` : '',
    v.files.map ? `<a href="${esc(v.files.map)}" download>карта «крок ↔ елемент» (JSON)</a>` : '',
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.title)}</title>
<style>${css}</style>
<style>
  :root { --fg:#1b1f23; --muted:#57606a; --bg:#fff; --line:#d0d7de; --warn:#fff8c5; --warnb:#d4a72c; --ok:#dafbe1; }
  @media (prefers-color-scheme: dark) { :root:not([data-light]) { } }
  body { margin:0; font:14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--fg); background:var(--bg); }
  header, section { padding: 12px 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 16px 0 6px; }
  .nonai { background:var(--warn); border:1px solid var(--warnb); border-radius:6px; padding:8px 12px; margin:8px 0; }
  .ok { background:var(--ok); border:1px solid #4ac26b; border-radius:6px; padding:8px 12px; margin:8px 0; }
  .meta { color:var(--muted); font-size:12px; word-break:break-all; }
  #canvas-wrap { margin: 0 20px; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  #canvas { height: 560px; }
  table { border-collapse: collapse; width: 100%; } th, td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#f6f8fa; } tr[data-el] { cursor:pointer; } tr.sel { outline:2px solid #0969da; background:#ddf4ff; }
  code { background:#f6f8fa; padding:0 4px; border-radius:3px; font-size:12px; }
  .hl .djs-visual > :nth-child(1) { stroke:#0969da !important; stroke-width:4px !important; }
</style></head>
<body>
<header>
  <h1>${esc(v.title)}</h1>
  <div class="nonai"><b>Тестовий результат, створений без AI.</b> ${esc(v.description)}</div>
  <div class="ok">Технічна перевірка готового файлу: помилок ${v.verification.errors}, попереджень ${v.verification.warnings}; експорт .drawio: ${esc(v.verification.drawio)}.
  Це доводить лише, що схема дослівно збігається з погодженим пакетом. <b>Вона не доводить, що сам опис правильно відображає реальний процес</b> — це перевіряє людина за таблицею нижче.</div>
  <div class="meta">Версія AS-IS: ${esc(v.versionId)} · хеш: ${esc(v.contentHash)}</div>
  <div>${links}</div>
</header>
<div id="canvas-wrap"><div id="canvas"></div></div>
<section>
  <h2>Карта відповідності «крок AS-IS ↔ елемент схеми»</h2>
  <p class="meta">Клацніть рядок, щоб підсвітити елемент на схемі.</p>
  <table><thead><tr><th>Крок</th><th>Роль (доріжка)</th><th>Дія (дослівно)</th><th>Елемент(и) схеми</th><th>Переходи (умова → ціль)</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <h2>Відомі обмеження (не блокують побудову)</h2>${limits}
</section>
<script>${js}</script>
<script>
  const XML = ${xmlJson};
  const viewer = new BpmnJS({ container: '#canvas' });
  window.__ready = viewer.importXML(XML).then((r) => {
    viewer.get('canvas').zoom('fit-viewport', 'auto');
    window.__viewer = viewer;
    return r;
  });
  document.querySelectorAll('tr[data-el]').forEach((tr) => tr.addEventListener('click', () => {
    const canvas = viewer.get('canvas');
    document.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
    document.querySelectorAll('.hl').forEach((x) => canvas.removeMarker(x.getAttribute('data-element-id'), 'hl'));
    tr.classList.add('sel');
    for (const id of [tr.dataset.el, tr.dataset.gw]) if (id) canvas.addMarker(id, 'hl');
  }));
</script>
</body></html>
`;
}
