/**
 * Зріз 3a, доопрацювання за незалежною перевіркою: стиль `.drawio` визначає, ЧИ ВИДНО елементи й напрямок стрілок.
 * Зміст і геометрія можуть бути правильними, а зображення — ні. Перевіряється повна відповідність стилю еталону
 * (а не перелік заборонених рядків), службові атрибути клітинок і діаграми, маршрут і підписи стрілок.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readBpmn } from '../src/bpmn/read.ts';
import { verifyDrawio } from '../src/bpmn/drawio.ts';
import { verifyBpmn } from '../src/bpmn/verify.ts';
import { generateBpmn } from '../src/bpmn/generate.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import { allFixtures, generateOk, mutate, pkgOf } from './bpmn-helpers.ts';
import { fixtureToPackage } from '../src/bpmn/fixture.ts';

type Base = { pkg: ApprovedPackage; bpmn: string; drawio: string; model: NonNullable<ReturnType<typeof readBpmn>['model']> };
let p02: Base, p06: Base, p07: Base;

async function base(id: string): Promise<Base> {
  const pkg = pkgOf(id);
  const r = await generateOk(pkg);
  return { pkg, bpmn: r.bpmn, drawio: r.drawio.xml!, model: readBpmn(r.bpmn).model! };
}
before(async () => { [p02, p06, p07] = [await base('p02-branch'), await base('p06-same-target'), await base('p07-large')]; });

const check = (b: Base, xml: string) => verifyDrawio(xml, b.pkg, b.model);
const codes = (b: Base, xml: string): string[] => check(b, xml).map((i) => i.code);

// ───────────── редагування конкретної клітинки ─────────────
const cellRe = (id: string): RegExp => new RegExp(`(<mxCell id="${id}"[^>]*? style=")([^"]*)(")`);
const poolRe = /(<object [^>]*id="Participant_1">\s*<mxCell style=")([^"]*)(")/;
const reOf = (id: string): RegExp => (id === 'Participant_1' ? poolRe : cellRe(id));
const styleAdd = (xml: string, id: string, kv: string): string => xml.replace(reOf(id), (_m, a: string, st: string, c: string) => `${a}${st}${kv};${c}`);
const styleSet = (xml: string, id: string, key: string, val: string): string => xml.replace(reOf(id), (_m, a: string, st: string, c: string) => `${a}${st.replace(new RegExp(`(^|;)${key}=[^;]*`), `$1${key}=${val}`)}${c}`);
const styleDel = (xml: string, id: string, key: string): string => xml.replace(reOf(id), (_m, a: string, st: string, c: string) => `${a}${st.replace(new RegExp(`(^|;)${key}=[^;]*;?`), '$1')}${c}`);

test('контроль: непошкоджені експорти не дають жодного зауваження (немає хибних спрацювань на всіх коректних пакетах)', async () => {
  for (const fx of allFixtures().filter((f) => f.expect.status === 'ok')) {
    const b = await base(fx.id);
    assert.deepEqual(check(b, b.drawio), [], fx.id);
  }
});

// ───────────── два випадки з незалежної перевірки ─────────────

test('випадок 1: заміна ВСІХ `endArrow=blockThin;` на `endArrow=none;` (зникають наконечники) — виявляється для кожної стрілки', () => {
  for (const b of [p02, p06, p07]) {
    const xml = mutate(b.drawio, (x) => x.replaceAll('endArrow=blockThin;', 'endArrow=none;'), 'прибрати наконечники');
    const issues = check(b, xml);
    const arrows = issues.filter((i) => i.code === 'DRAWIO_ARROW_STYLE');
    assert.equal(arrows.length, b.model.flows.length, 'зауваження на кожну стрілку');
    assert.deepEqual(new Set(arrows.flatMap((i) => i.refs)), new Set(b.model.flows.map((f) => f.id)));
    assert.ok(arrows[0]!.message.includes('endArrow') && /напрям/.test(arrows[0]!.message), arrows[0]!.message);
  }
});

test('випадок 2: заміна `shape=mxgraph.bpmn.task2;` на `…;opacity=0;textOpacity=0;` (задачі й підписи прозорі) — виявляється для кожної задачі', () => {
  for (const b of [p02, p06, p07]) {
    const xml = mutate(b.drawio, (x) => x.replaceAll('shape=mxgraph.bpmn.task2;', 'shape=mxgraph.bpmn.task2;opacity=0;textOpacity=0;'), 'прозорі задачі');
    const issues = check(b, xml);
    const hidden = issues.filter((i) => i.code === 'DRAWIO_STYLE_HIDDEN');
    const tasks = [...b.model.nodes.values()].filter((n) => n.tag === 'task').map((n) => n.id);
    assert.deepEqual(new Set(hidden.flatMap((i) => i.refs)), new Set(tasks), 'кожна прозора задача названа');
    assert.ok(hidden.some((i) => i.message.includes('opacity')) && hidden.some((i) => i.message.includes('textOpacity')));
    assert.ok(hidden.every((i) => /невидим|прозор/.test(i.message)));
  }
});

// ───────────── споріднені налаштування (не лише два буквальні рядки) ─────────────

type Mut = { name: string; expect: string; run: (b: Base) => string };
const T = 'Task_S3', L = 'Lane_1', E = 'Flow_S2_1', G = 'Gateway_S2', S = 'StartEvent_1', X = 'End_S4_1';
const MUTS: Mut[] = [
  // — прозорість і колір: задача —
  { name: 'задача: opacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'opacity=0') },
  { name: 'задача: opacity=5 (майже прозора)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'opacity=5') },
  { name: 'задача: textOpacity=0 (текст зник)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'textOpacity=0') },
  { name: 'задача: fillOpacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'fillOpacity=0') },
  { name: 'задача: strokeOpacity=0 (контур зник)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'strokeOpacity=0') },
  { name: 'задача: fontColor=#ffffff (білий на білому)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'fontColor=#ffffff') },
  { name: 'задача: fontColor=none', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'fontColor=none') },
  { name: 'задача: strokeColor=none', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'strokeColor=none') },
  { name: 'задача: strokeColor=#ffffff', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'strokeColor=#ffffff') },
  { name: 'задача: strokeWidth=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'strokeWidth=0') },
  { name: 'задача: fillColor=#000000 (чорний фон під чорним текстом)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'fillColor=#000000') },
  { name: 'задача: fontSize=1', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleSet(b.drawio, T, 'fontSize', '1') },
  { name: 'задача: fontSize=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleSet(b.drawio, T, 'fontSize', '0') },
  { name: 'задача: noLabel=1', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'noLabel=1') },
  { name: 'задача: підпис винесено (labelPosition=left)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'labelPosition=left') },
  { name: 'задача: підпис під блоком (verticalLabelPosition=bottom)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'verticalLabelPosition=bottom') },
  { name: 'задача: підпис без переносу (whiteSpace видалено)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleDel(b.drawio, T, 'whiteSpace') },
  { name: 'задача: overflow=hidden', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'overflow=hidden') },
  { name: 'задача: rotation=90', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'rotation=90') },
  { name: 'задача: flipH=1', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, T, 'flipH=1') },
  { name: 'задача: html=1 (підпис стає розміткою)', expect: 'DRAWIO_STYLE_MISMATCH', run: (b) => styleSet(b.drawio, T, 'html', '1') },
  { name: 'задача: інша форма', expect: 'DRAWIO_STYLE_MISMATCH', run: (b) => styleSet(b.drawio, T, 'shape', 'mxgraph.bpmn.shape') },
  { name: 'задача: параметр записано двічі (діє останній)', expect: 'DRAWIO_STYLE_MISMATCH', run: (b) => styleAdd(b.drawio, T, 'fontSize=12;fontSize=1') },
  { name: 'задача: невідомий параметр', expect: 'DRAWIO_STYLE_MISMATCH', run: (b) => styleAdd(b.drawio, T, 'customFlag=1') },
  // — доріжка, пул, події, шлюз —
  { name: 'доріжка: textOpacity=0 (назва ролі зникла)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, L, 'textOpacity=0') },
  { name: 'доріжка: fontColor=#ffffff', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, L, 'fontColor=#ffffff') },
  { name: 'доріжка: opacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, L, 'opacity=0') },
  { name: 'доріжка: swimlaneFillColor=#000000 (чорне тло)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleSet(b.drawio, L, 'swimlaneFillColor', '#000000') },
  { name: 'пул: textOpacity=0 (назва пулу зникла)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, 'Participant_1', 'textOpacity=0') },
  { name: 'початкова подія: textOpacity=0 (тригер зник)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, S, 'textOpacity=0') },
  { name: 'початкова подія: opacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, S, 'opacity=0') },
  { name: 'кінцева подія: opacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, X, 'opacity=0') },
  { name: 'шлюз: opacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, G, 'opacity=0') },
  { name: 'шлюз: strokeColor=none', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, G, 'strokeColor=none') },
  // — стрілки —
  { name: 'стрілка: endArrow=none (одна)', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleSet(b.drawio, E, 'endArrow', 'none') },
  { name: 'стрілка: інший наконечник (classic)', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleSet(b.drawio, E, 'endArrow', 'classic') },
  { name: 'стрілка: наконечник на початку (startArrow=block) — напрямок читається навпаки', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'startArrow=block') },
  { name: 'стрілка: endFill=0 (порожній наконечник)', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleSet(b.drawio, E, 'endFill', '0') },
  { name: 'стрілка: endSize=0', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'endSize=0') },
  { name: 'стрілка: strokeColor=none', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'strokeColor=none') },
  { name: 'стрілка: strokeColor=#ffffff', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'strokeColor=#ffffff') },
  { name: 'стрілка: opacity=0', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'opacity=0') },
  { name: 'стрілка: strokeOpacity=0', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'strokeOpacity=0') },
  { name: 'стрілка: strokeWidth=0', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'strokeWidth=0') },
  { name: 'стрілка: пунктир (виглядає як потік повідомлень чи асоціація)', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'dashed=1') },
  { name: 'стрілка: інше маршрутизування (edgeStyle)', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'edgeStyle=orthogonalEdgeStyle') },
  { name: 'стрілка: curved=1', expect: 'DRAWIO_ARROW_STYLE', run: (b) => styleAdd(b.drawio, E, 'curved=1') },
  { name: 'стрілка: fontColor=#ffffff (підпис умови невидимий)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, E, 'fontColor=#ffffff') },
  { name: 'стрілка: fontSize=0 (підпис умови зник)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleSet(b.drawio, E, 'fontSize', '0') },
  { name: 'стрілка: noLabel=1', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, E, 'noLabel=1') },
  { name: 'стрілка: textOpacity=0', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleAdd(b.drawio, E, 'textOpacity=0') },
  { name: 'стрілка: підпис без фону (labelBackgroundColor=none)', expect: 'DRAWIO_STYLE_HIDDEN', run: (b) => styleSet(b.drawio, E, 'labelBackgroundColor', 'none') },
  { name: 'стрілка: змінено точку виходу', expect: 'DRAWIO_EDGE_PORT', run: (b) => styleSet(b.drawio, E, 'exitX', '0.3') },
  { name: 'стрілка: змінено точку входу', expect: 'DRAWIO_EDGE_PORT', run: (b) => styleSet(b.drawio, E, 'entryY', '0.9') },
  { name: 'стрілка: точки виходу видалено', expect: 'DRAWIO_EDGE_PORT', run: (b) => styleDel(styleDel(b.drawio, E, 'exitX'), E, 'exitY') },
  // — службові атрибути клітинок і діаграми —
  { name: 'клітинка задачі: visible="0"', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace(`<mxCell id="${T}"`, `<mxCell id="${T}" visible="0"`) },
  { name: 'лінія: visible="0"', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace(`<mxCell id="${E}"`, `<mxCell id="${E}" visible="0"`) },
  { name: 'шар 1 (весь вміст): visible="0"', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" visible="0" />') },
  { name: 'шар 1: style="opacity=0"', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" style="opacity=0" />') },
  { name: 'клітинка 0 має стиль', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace('<mxCell id="0" />', '<mxCell id="0" style="opacity=0" />') },
  { name: 'задача: connectable="0" / collapsed (службові параметри)', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace(`<mxCell id="${T}"`, `<mxCell id="${T}" collapsed="1"`) },
  { name: 'пул: сторонній атрибут обгортки', expect: 'DRAWIO_CELL_ATTR', run: (b) => b.drawio.replace('<object label=', '<object tooltip="приховано" label=') },
  { name: 'діаграма: тло background="#000000"', expect: 'DRAWIO_MODEL_ATTR', run: (b) => b.drawio.replace('<mxGraphModel ', '<mxGraphModel background="#000000" ') },
  { name: 'діаграма: змінено page', expect: 'DRAWIO_MODEL_ATTR', run: (b) => b.drawio.replace('page="0"', 'page="1"') },
  { name: 'геометрія: сторонній параметр (alternateBounds)', expect: 'DRAWIO_GEOMETRY_ATTR', run: (b) => b.drawio.replace(new RegExp(`(<mxCell id="${T}"[^>]*><mxGeometry )`), '$1alternateBounds="1" ') },
  // — маршрут і підписи стрілок —
  { name: 'лінія: маршрут змінено (проміжну точку зсунуто)', expect: 'DRAWIO_GEOMETRY', run: (b) => b.drawio.replace(/(<mxCell id="Flow_S1_1"[^>]*>[\s\S]*?<mxPoint x=")[\d.]+(")/, '$1123$2') },
  { name: 'підпис умови відсунуто далеко від стрілки', expect: 'DRAWIO_GEOMETRY', run: (b) => b.drawio.replace(/(<mxCell id="Flow_S2_1"[^>]*>[\s\S]*?<mxPoint x=")[-\d.]+(" y="[-\d.]+" as="offset")/, '$15000$2') },
];

for (const m of MUTS) {
  test(`.drawio, споріднене налаштування: ${m.name}`, () => {
    const xml = mutate(p02.drawio, () => m.run(p02), m.name);
    const found = check(p02, xml);
    assert.ok(found.some((i) => i.code === m.expect), `очікувався ${m.expect}; отримано: ${found.map((i) => i.code).join(', ') || '(порожньо — пропущено!)'}`);
    assert.ok(found.every((i) => i.severity === 'error'));
    assert.ok(found.every((i) => i.message.length > 25), 'пояснення має бути конкретним');
  });
}

test('.drawio: той самий набір пошкоджень виявляється й на пакеті з двома умовами в одну ціль та на великому процесі', () => {
  for (const b of [p06, p07]) {
    for (const [name, fn] of [
      ['прозорі задачі', (x: string) => x.replaceAll('taskMarker=abstract;', 'taskMarker=abstract;opacity=0;')],
      ['без наконечників', (x: string) => x.replaceAll('endFill=1;', 'endFill=0;endArrow=none;')],
      ['сховано шар', (x: string) => x.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" visible="0" />')],
    ] as const) {
      const xml = mutate(b.drawio, fn, name);
      assert.ok(check(b, xml).some((i) => i.severity === 'error'), name);
    }
  }
});

// ───────────── пошкоджений експорт не видається, .bpmn лишається доступним ─────────────

test('пошкоджений .drawio не видається користувачеві, а коректний .bpmn лишається чинним і незмінним', async () => {
  const clean = await generateOk(pkgOf('p02-branch'));
  const tampers: [string, (x: string) => string][] = [
    ['без наконечників', (x) => x.replaceAll('endArrow=blockThin;', 'endArrow=none;')],
    ['прозорі задачі й підписи', (x) => x.replaceAll('shape=mxgraph.bpmn.task2;', 'shape=mxgraph.bpmn.task2;opacity=0;textOpacity=0;')],
    ['схований шар', (x) => x.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" visible="0" />')],
    ['білий текст', (x) => x.replaceAll('fontSize=12;', 'fontSize=12;fontColor=#ffffff;')],
    ['чорне тло', (x) => x.replace('<mxGraphModel ', '<mxGraphModel background="#000000" ')],
  ];
  for (const [name, fn] of tampers) {
    const r = await generateBpmn(pkgOf('p02-branch'), { tamperDrawio: (x) => mutate(x, fn, name) });
    assert.equal(r.status, 'ok', name);
    if (r.status !== 'ok') continue;
    // .bpmn: той самий байт у байт, проходить зворотну перевірку
    assert.equal(r.bpmn, clean.bpmn, `${name}: .bpmn не має змінитись`);
    assert.deepEqual(verifyBpmn(r.bpmn, pkgOf('p02-branch')).report.errors, []);
    assert.equal(r.verification.ok, true);
    // .drawio: не видано, причини названо
    assert.equal(r.drawio.status, 'failed', name);
    assert.equal(r.drawio.xml, null, `${name}: пошкоджений експорт не має потрапити до результату`);
    assert.ok(r.drawio.issues.length > 0 && r.drawio.issues.every((i) => i.severity === 'error'));
    assert.ok(r.map.every((row) => row.drawio_cell_id === null), 'карта не посилається на клітинки .drawio, якого не видано');
    assert.ok(!JSON.stringify(r).includes('opacity=0') && !JSON.stringify(r).includes('endArrow=none'), 'пошкоджений текст ніде не повертається');
  }
});

test('усі видані експорти проходять сувору звірку; видача завжди супроводжується чистою звіркою', async () => {
  for (const fx of allFixtures().filter((f) => f.expect.status === 'ok')) {
    const r = await generateOk(fixtureToPackage(fx));
    assert.equal(r.drawio.status, 'ok');
    assert.deepEqual(verifyDrawio(r.drawio.xml!, fixtureToPackage(fx), readBpmn(r.bpmn).model!), [], fx.id);
  }
});

test('еталон закріплено: кожна стрілка має наконечник у кінці, жодних параметрів прозорості, шрифт читабельний', () => {
  const edges = [...p02.drawio.matchAll(/<mxCell id="Flow_[^"]*"[^>]*style="([^"]*)"/g)].map((m) => m[1]!);
  assert.equal(edges.length, p02.model.flows.length);
  for (const st of edges) {
    assert.ok(st.includes('endArrow=blockThin;') && st.includes('endFill=1;'));
    assert.ok(!/startArrow|dashed|curved|edgeStyle/.test(st));
  }
  assert.ok(!/opacity|Opacity|visible=|noLabel|fontColor|strokeColor/i.test(p02.drawio), 'в еталонному експорті немає параметрів, що сховали б елемент');
  for (const m of p02.drawio.matchAll(/style="([^"]*)"/g)) {
    const fs = /fontSize=(\d+)/.exec(m[1]!);
    assert.ok(fs && Number(fs[1]) >= 11, `шрифт ${fs?.[1]}`);
  }
});
