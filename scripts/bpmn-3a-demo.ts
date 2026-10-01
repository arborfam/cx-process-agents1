/**
 * Зріз 3a: створює з тестових пакетів (tests/bpmn-fixtures/*.json) схеми .bpmn і .drawio, карти «крок ↔ елемент»,
 * HTML-переглядачі з водяним знаком bpmn.io та знімки. Жодних викликів моделі й мережі; усе створено без AI.
 *
 * Запуск:  node --import tsx scripts/bpmn-3a-demo.ts [--out docs/bpmn-3a] [--no-screenshots]
 * Для знімків .drawio потрібен локальний переглядач draw.io: змінна DRAWIO_VIEWER_DIR (тека з viewer-static.min.js,
 * shapes/bpmn/mxBpmnShape2.js, stencils/bpmn.xml). Без неї знімки .drawio пропускаються (про це буде повідомлено).
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { fixtureToPackage, type Fixture } from '../src/bpmn/fixture.ts';
import type { GenerationResult } from '../src/bpmn/types.ts';
import { buildViewerHtml } from './lib/viewer.ts';

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'docs/bpmn-3a';
const shots = !args.includes('--no-screenshots');
const FIX = 'tests/bpmn-fixtures';
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Row { fx: Fixture; result: GenerationResult; bpmnPng?: string; drawioPng?: string }

async function main(): Promise<void> {
  for (const sub of ['packages', 'schemes', 'results']) {
    rmSync(join(outDir, sub), { recursive: true, force: true });
    mkdirSync(join(outDir, sub), { recursive: true });
  }
  // знімки: прибираємо лише власні файли *.png; тека defects/ (знімки навмисно пошкоджених файлів) лишається
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  for (const f of readdirSync(join(outDir, 'screenshots'))) if (f.endsWith('.png')) rmSync(join(outDir, 'screenshots', f));
  const rows: Row[] = [];
  for (const f of readdirSync(FIX).filter((x) => x.endsWith('.json')).sort()) {
    const fx = JSON.parse(readFileSync(join(FIX, f), 'utf8')) as Fixture;
    copyFileSync(join(FIX, f), join(outDir, 'packages', f));
    const result = await generateBpmn(fixtureToPackage(fx));
    rows.push({ fx, result });
    if (result.status === 'ok') {
      writeFileSync(join(outDir, 'schemes', `${fx.id}.bpmn`), result.bpmn);
      if (result.drawio.xml) writeFileSync(join(outDir, 'schemes', `${fx.id}.drawio`), result.drawio.xml);
      writeFileSync(join(outDir, 'schemes', `${fx.id}.map.json`), JSON.stringify({ created_without_ai: true, package: fx.id, map: result.map }, null, 2) + '\n');
      writeFileSync(join(outDir, 'schemes', `${fx.id}.html`), buildViewerHtml({
        title: `${fx.id}: ${fx.title}`,
        description: `Пакет «${fx.id}» підготовлено вручну (синтетичний), схему створено програмою без участі AI і перевірено зворотним читанням. Що перевіряє цей пакет: ${fx.what_it_tests}`,
        bpmn: result.bpmn, map: result.map, knownLimits: result.knownLimits,
        versionId: fx.version_id, contentHash: result.binding.contentHash,
        files: { bpmn: `${fx.id}.bpmn`, ...(result.drawio.xml ? { drawio: `${fx.id}.drawio` } : {}), map: `${fx.id}.map.json` },
        verification: { errors: result.verification.errors.length, warnings: result.verification.warnings.length, drawio: result.drawio.status === 'ok' ? 'звірка пройдена' : 'НЕ видано' },
      }));
    } else {
      writeFileSync(join(outDir, 'results', `${fx.id}.result.json`), JSON.stringify({ created_without_ai: true, package: fx.id, ...result }, null, 2) + '\n');
    }
    console.log(`${fx.id.padEnd(34)} очікувалось ${fx.expect.status.padEnd(11)} отримано ${result.status}`);
  }

  if (shots) await screenshots(rows);
  writeFileSync(join(outDir, 'index.html'), indexHtml(rows));
  console.log(`Готово: ${outDir}/index.html`);
}

async function screenshots(rows: Row[]): Promise<void> {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const viewerDir = process.env.DRAWIO_VIEWER_DIR;
  let server: ReturnType<typeof spawn> | null = null;
  let port = 0;
  if (viewerDir && existsSync(join(viewerDir, 'viewer-static.min.js'))) {
    port = 8800 + Math.floor(Math.random() * 150);
    server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: viewerDir, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
  } else {
    console.log('DRAWIO_VIEWER_DIR не задано: знімки .drawio пропущено (вигляд у draw.io НЕ перевірено).');
  }
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    for (const row of rows) {
      if (row.result.status !== 'ok') continue;
      const id = row.fx.id;
      // ── .bpmn у bpmn-js (з водяним знаком) ──
      const page = await ctx.newPage();
      await page.goto('file://' + join(process.cwd(), outDir, 'schemes', `${id}.html`));
      await page.evaluate(() => (window as unknown as { __ready: Promise<unknown> }).__ready);
      const size = await page.evaluate(() => {
        const v = (window as unknown as { __viewer: { get(n: string): { viewbox(): { inner: { width: number; height: number } } } } }).__viewer;
        const inner = v.get('canvas').viewbox().inner;
        return { w: Math.ceil(inner.width), h: Math.ceil(inner.height) };
      });
      const W = Math.max(900, size.w + 160), H = Math.max(420, size.h + 160);
      await page.setViewportSize({ width: W + 60, height: 900 });
      await page.evaluate(({ W, H }) => {
        const c = document.getElementById('canvas')!;
        c.style.height = `${H}px`;
        c.style.width = `${W}px`;
        const v = (window as unknown as { __viewer: { get(n: string): { resized(): void; zoom(a: number | string, b?: string): void } } }).__viewer;
        v.get('canvas').resized();
        v.get('canvas').zoom('fit-viewport', 'auto');
      }, { W, H });
      await page.waitForTimeout(300);
      row.bpmnPng = `${id}-bpmn.png`;
      await page.locator('#canvas-wrap').screenshot({ path: join(outDir, 'screenshots', row.bpmnPng) });
      if (id === 'p02-branch') await page.screenshot({ path: join(outDir, 'screenshots', `${id}-viewer-full-page.png`), fullPage: true });
      await page.close();

      // ── .drawio у переглядачі draw.io ──
      if (server && row.result.drawio.xml) {
        const dpage = await ctx.newPage();
        const cfg = JSON.stringify({ highlight: '#0000ff', nav: false, resize: false, toolbar: '', lightbox: false, xml: row.result.drawio.xml });
        writeFileSync(join(viewerDir!, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"><script>window.PROXY_URL='';window.STYLE_PATH='styles';window.SHAPES_PATH='shapes';window.STENCIL_PATH='stencils';</script></head><body style="margin:0;background:#fff"><div class="mxgraph" style="position:relative;overflow:auto;" data-mxgraph="${esc(cfg)}"></div><script src="viewer-static.min.js"></script></body></html>`);
        await dpage.goto(`http://127.0.0.1:${port}/page.html`);
        await dpage.waitForSelector('.mxgraph svg', { timeout: 20000 });
        await dpage.waitForTimeout(1200);
        const box = await dpage.evaluate(() => { const r = document.querySelector('.mxgraph svg')!.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; });
        await dpage.setViewportSize({ width: Math.max(800, box.w + 40), height: Math.max(400, box.h + 40) });
        await dpage.waitForTimeout(300);
        row.drawioPng = `${id}-drawio.png`;
        await dpage.screenshot({ path: join(outDir, 'screenshots', row.drawioPng), clip: { x: 0, y: 0, width: box.w + 24, height: box.h + 24 } });
        await dpage.close();
      }
    }
  } finally {
    await browser.close();
    server?.kill();
    if (viewerDir) rmSync(join(viewerDir, 'page.html'), { force: true });
  }
}

function indexHtml(rows: Row[]): string {
  const tr = rows.map(({ fx, result, bpmnPng, drawioPng }) => {
    const ok = result.status === fx.expect.status;
    const links = result.status === 'ok'
      ? `<a href="schemes/${fx.id}.html">переглядач</a> · <a href="schemes/${fx.id}.bpmn">.bpmn</a> · <a href="schemes/${fx.id}.drawio">.drawio</a> · <a href="schemes/${fx.id}.map.json">карта</a>${bpmnPng ? ` · <a href="screenshots/${bpmnPng}">знімок bpmn</a>` : ''}${drawioPng ? ` · <a href="screenshots/${drawioPng}">знімок drawio</a>` : ''}`
      : `<a href="results/${fx.id}.result.json">пояснення відмови</a>`;
    return `<tr><td><b>${esc(fx.id)}</b><br>${esc(fx.title)}</td><td>${esc(fx.what_it_tests)}</td><td>${esc(fx.expect.status)}</td><td style="background:${ok ? '#dafbe1' : '#ffebe9'}">${esc(result.status)}</td><td><a href="packages/${fx.id}.json">пакет (вхід)</a><br>${links}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Зріз 3a: тестові схеми</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:20px;color:#1b1f23}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f6f8fa}.nonai{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:8px 12px;margin:8px 0}</style></head><body>
<h1>Зріз 3a: тестові схеми</h1>
<div class="nonai"><b>Усе тут створено без AI.</b> Вхідні пакети підготовлено вручну (синтетичні), схеми створено програмою без викликів моделі й перевірено зворотним читанням. Це перевірка генератора, а не якості аналізу.</div>
<p>Колонка «очікувалось» записана в пакеті ДО запуску; «отримано» — фактичний результат. Збіг підсвічено зеленим.</p>
<table><thead><tr><th>Пакет</th><th>Що перевіряє</th><th>Очікувалось</th><th>Отримано</th><th>Файли</th></tr></thead><tbody>
${tr}
</tbody></table></body></html>
`;
}

await main();
