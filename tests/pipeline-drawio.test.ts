/**
 * Повнота перевірки ВИГЛЯДУ `.drawio` на новому (Python) шляху — повернення захисту рівня D60.
 *
 * Передісторія: перша версія `verify-drawio.ts` перевіряла лише перелік «поганих» параметрів у вузлах.
 * Незалежна перевірка показала три пошкодження, які проходили як чисті: прихований шар (`visible="0"`),
 * підміна фігури задач (`shape=ellipse`), прозорі лінії (`opacity=0`). Тут вони відтворені дослівно —
 * на тому самому файлі `docs/bpmn-3c/v29-pipeline.drawio`, яким їх знайшли, — і разом із ними споріднені
 * ризики того ж модуля.
 *
 * Межа перевірки тепер — **явний контракт допустимого експорту** (`drawio-style.ts`): дозволено рівно те,
 * що пише конвертер; зайвий, відсутній чи змінений параметр стилю чи атрибут — помилка. Саме тому
 * перелік випадків нижче не вичерпується трьома відомими.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPipelineBpmn } from '../src/pipeline/verify.ts';
import { readDrawio, verifyDrawioAgainstBpmn } from '../src/pipeline/verify-drawio.ts';
import { EDGE_STYLE, EVENT_BASE, expectedStyle, GRAPH_MODEL_ATTRS, GW_BASE, LANE_STYLE, POOL_STYLE, TASK_BASE } from '../src/pipeline/drawio-style.ts';
import { scriptPath } from '../src/pipeline/scripts.ts';
import { generateOk, mutate, pkgOf } from './bpmn-helpers.ts';
import { buildArtifact, readArtifactFile } from '../src/bpmn-artifacts.ts';
import { runBpmnReviewForCase } from '../src/review-runs.ts';
import { approvedCase, freshDb, human } from './helpers.ts';
import { FakeReviewClient, okStep, policyOf, reviewer } from './review-helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const BPMN = readFileSync(join(ROOT, 'docs', 'bpmn-3c', 'v29-pipeline.bpmn'), 'utf8');
const DRAWIO = readFileSync(join(ROOT, 'docs', 'bpmn-3c', 'v29-pipeline.drawio'), 'utf8');
const MODEL = readPipelineBpmn(BPMN).model!;
const TRIGGER = /<bpmn:documentation[^>]*>([\s\S]*?)<\/bpmn:documentation>/.exec(BPMN)![1]!;

const check = (xml: string): ReturnType<typeof verifyDrawioAgainstBpmn> => verifyDrawioAgainstBpmn(xml, MODEL, TRIGGER);
const codes = (xml: string): string[] => check(xml).map((i) => i.code);

test('0. КОНТРОЛЬ: непошкоджений експорт не дає жодного зауваження', () => {
  assert.deepEqual(check(DRAWIO), [], 'еталонний файл має проходити чисто');
  // І контроль самого тесту: входження, на які спираються мутації нижче, у файлі справді є.
  const cells = readDrawio(DRAWIO).cells;
  assert.equal(cells.filter((c) => c.id === '1').length, 1, 'один шар');
  assert.equal([...MODEL.nodes.values()].filter((n) => n.tag === 'task').length, 12, '12 задач');
  assert.equal(MODEL.flows.length, 21, '21 лінія');
});

// ───────────── 1. Три підтверджені регресії (кожна — окремою зміною) ─────────────

test('1. Прихований шар: visible="0" на клітинці шару «1» — схеми не видно взагалі', () => {
  const bad = mutate(DRAWIO, (x) => x.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" visible="0" />'), 'приховати шар');
  const c = codes(bad);
  assert.ok(c.includes('DRAWIO_STYLE_HIDDEN'), `очікувався DRAWIO_STYLE_HIDDEN; отримано: ${c.join(', ') || '(чисто!)'}`);
  assert.match(check(bad)[0]!.message, /шар/i);
});

test('1. Підміна фігури: shape=ellipse замість mxgraph.bpmn.task2 — задачі стають колами', () => {
  const bad = mutate(DRAWIO, (x) => x.replaceAll('shape=mxgraph.bpmn.task2;', 'shape=ellipse;'), 'підмінити фігуру задач');
  const c = codes(bad);
  assert.ok(c.includes('DRAWIO_UNSUPPORTED_STYLE'), `очікувався DRAWIO_UNSUPPORTED_STYLE; отримано: ${c.join(', ') || '(чисто!)'}`);
  assert.equal(c.filter((x) => x === 'DRAWIO_UNSUPPORTED_STYLE').length, 12, 'помічено кожну з 12 задач');
});

test('1. Прозорі лінії: opacity=0 у стилях усіх ліній — стрілок на схемі не видно', () => {
  const bad = mutate(DRAWIO, (x) => x.replaceAll('endArrow=blockThin;', 'opacity=0;endArrow=blockThin;'), 'зробити лінії прозорими');
  const c = codes(bad);
  assert.ok(c.includes('DRAWIO_STYLE_HIDDEN'), `очікувався DRAWIO_STYLE_HIDDEN; отримано: ${c.join(', ') || '(чисто!)'}`);
  assert.equal(c.filter((x) => x === 'DRAWIO_STYLE_HIDDEN').length, 21, 'помічено кожну з 21 лінії');
});

// ───────────── 2. Споріднені ризики того самого модуля ─────────────

const cellRe = (id: string): RegExp => new RegExp(`(<mxCell id="${id}"[^>]*? style=")([^"]*)(")`);
const objRe = (id: string): RegExp => new RegExp(`(<object [^>]*id="${id}"[^>]*>\\s*<mxCell style=")([^"]*)(")`);
const reOf = (id: string): RegExp => (DRAWIO.includes(`<object id="${id}"`) ? objRe(id) : cellRe(id));
const styleAdd = (xml: string, id: string, kv: string): string => xml.replace(reOf(id), (_m, a: string, st: string, c: string) => `${a}${st}${kv};${c}`);
const styleSet = (xml: string, id: string, key: string, val: string): string => xml.replace(reOf(id), (_m, a: string, st: string, c: string) => `${a}${st.replace(new RegExp(`(^|;)${key}=[^;]*`), `$1${key}=${val}`)}${c}`);
const styleDel = (xml: string, id: string, key: string): string => xml.replace(reOf(id), (_m, a: string, st: string, c: string) => `${a}${st.replace(new RegExp(`(^|;)${key}=[^;]*;?`), '$1')}${c}`);

const CASES: { name: string; expect: string; run: (x: string) => string }[] = [
  // видимість шару, пулу, доріжки, вузла
  { name: 'пул прозорий', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => styleAdd(x, 'Participant_1', 'opacity=0') },
  { name: 'доріжку приховано атрибутом', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => x.replace('<mxCell id="Lane_0"', '<mxCell id="Lane_0" visible="0"') },
  { name: 'заливку доріжки змінено на білу на білому', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => styleSet(x, 'Lane_0', 'fillColor', '#ffffff') },
  { name: 'текст задачі зроблено білим', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => styleAdd(x, 'Task_S4', 'fontColor=#ffffff') },
  { name: 'підпис вимкнено (noLabel)', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => styleAdd(x, 'Task_S4', 'noLabel=1') },
  { name: 'шар отримав стиль', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => x.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" style="opacity=0;" />') },
  // форма й маркери
  { name: 'маркер задачі «людина» замість нейтрального', expect: 'DRAWIO_UNSUPPORTED_STYLE', run: (x) => styleSet(x, 'Task_S4', 'taskMarker', 'user') },
  { name: 'шлюз став паралельним', expect: 'DRAWIO_UNSUPPORTED_STYLE', run: (x) => styleSet(x, 'Gateway_S5', 'gwType', 'parallel') },
  { name: 'початкова подія стала таймером', expect: 'DRAWIO_UNSUPPORTED_STYLE', run: (x) => styleSet(x, 'StartEvent_1', 'symbol', 'timer') },
  { name: 'кінцева подія стала проміжною', expect: 'DRAWIO_UNSUPPORTED_STYLE', run: (x) => styleSet(x, 'End_S9_1', 'outline', 'catching') },
  { name: 'фігуру події підмінено', expect: 'DRAWIO_UNSUPPORTED_STYLE', run: (x) => styleSet(x, 'StartEvent_1', 'shape', 'rectangle') },
  { name: 'з пулу прибрано swimlane', expect: 'DRAWIO_STYLE_MISMATCH', run: (x) => x.replace(`style="${POOL_STYLE}"`, `style="${POOL_STYLE.replace('swimlane;', 'rounded=1;')}"`) },
  // текст
  { name: 'дію кроку змінено', expect: 'DRAWIO_LABEL_MISMATCH', run: (x) => x.replace('Переписати опис зміни простішою мовою', 'Інша дія') },
  { name: 'назву доріжки змінено', expect: 'DRAWIO_LABEL_MISMATCH', run: (x) => x.replace('value="Відповідальна за підготовку агентів (CX)"', 'value="Інша роль"') },
  { name: 'напис на пулі змінено', expect: 'DRAWIO_LABEL_MISMATCH', run: (x) => x.replace('Підготовка матеріалів CX до великої продуктової зміни', 'Інший процес') },
  { name: 'підпис умови втрачено', expect: 'DRAWIO_LABEL_MISMATCH', run: (x) => x.replace('value="Нова тема"', 'value=""') },
  { name: 'повний текст тригера з підказки прибрано', expect: 'DRAWIO_START_DOC', run: (x) => x.replace(/ tooltip="[^"]*"/, '') },
  // напрямок і видимість ліній
  { name: 'наконечник стрілки прибрано', expect: 'DRAWIO_ARROW', run: (x) => x.replaceAll('endArrow=blockThin;', 'endArrow=none;') },
  { name: 'заливку наконечника вимкнено', expect: 'DRAWIO_ARROW', run: (x) => x.replaceAll('endFill=1;', 'endFill=0;') },
  { name: 'лінію зроблено пунктирною', expect: 'DRAWIO_ARROW', run: (x) => x.replaceAll('endArrow=blockThin;', 'dashed=1;endArrow=blockThin;') },
  { name: 'колір лінії зроблено білим', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => x.replaceAll('endArrow=blockThin;', 'strokeColor=#ffffff;endArrow=blockThin;') },
  { name: 'лінію перенаправлено на іншу ціль', expect: 'DRAWIO_EDGE_MISMATCH', run: (x) => x.replace('target="Task_S5"', 'target="Task_S6"') },
  { name: 'лінію відірвано від джерела', expect: 'DRAWIO_EDGE_DETACHED', run: (x) => x.replace(/ source="Task_S4"/, '') },
  // геометрія й маршрут
  { name: 'блок зсунуто', expect: 'DRAWIO_GEOMETRY', run: (x) => x.replace(/(<mxCell id="Task_S4"[^>]*><mxGeometry x=")[\d.]+(")/, '$1999$2') },
  { name: 'геометрію блока прибрано', expect: 'DRAWIO_GEOMETRY', run: (x) => x.replace(/(<mxCell id="Task_S4"[^>]*>)<mxGeometry[^>]*\/>/, '$1') },
  { name: 'пул змінив розмір', expect: 'DRAWIO_GEOMETRY', run: (x) => x.replace(/(id="Participant_1"[\s\S]{0,400}?<mxGeometry[^>]*width=")[\d.]+(")/, '$1400$2') },
  { name: 'проміжні точки лінії прибрано', expect: 'DRAWIO_EDGE_ROUTE', run: (x) => x.replace(/<Array as="points">[\s\S]*?<\/Array>/, '') },
  { name: 'проміжну точку зсунуто', expect: 'DRAWIO_EDGE_ROUTE', run: (x) => x.replace(/(<Array as="points"><mxPoint x=")[\d.]+(")/, '$1777$2') },
  { name: 'положення підпису лінії прибрано', expect: 'DRAWIO_LABEL_PLACE', run: (x) => x.replace(/<mxPoint x="-?[\d.]+" y="-?[\d.]+" as="offset" \/>/, '') },
  // структура й зайве
  { name: 'сторінку діаграми перемкнено', expect: 'DRAWIO_STRUCTURE', run: (x) => x.replace('page="0"', 'page="1"') },
  { name: 'у діаграму додано тло', expect: 'DRAWIO_STRUCTURE', run: (x) => x.replace('<mxGraphModel ', '<mxGraphModel background="#ffffff" ') },
  { name: 'клітинку згорнуто', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => x.replace('<mxCell id="Lane_0"', '<mxCell id="Lane_0" collapsed="1"') },
  { name: 'у задачі прибрано vertex="1"', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => x.replace('<mxCell id="Task_S4" value', '<mxCell id="Task_S4" data-x="1" value').replace(/(<mxCell id="Task_S4"[^>]*?) vertex="1"/, '$1') },
  { name: 'у лінії прибрано edge="1"', expect: 'DRAWIO_STYLE_HIDDEN', run: (x) => x.replace(/(<mxCell id="fTask_S4_Task_S5"[^>]*?) edge="1"/, '$1') },
  { name: 'зайва клітинка', expect: 'DRAWIO_CELL_EXTRA', run: (x) => x.replace('</root>', '<mxCell id="Zайве" value="Повідомити керівника" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry" /></mxCell></root>') },
  { name: 'повторний ID клітинки', expect: 'DRAWIO_DUPLICATE_ID', run: (x) => x.replace('<mxCell id="Task_S6"', '<mxCell id="Task_S7"') },
  { name: 'зіпсований XML', expect: 'DRAWIO_XML_MALFORMED', run: (x) => x.replace('value="Нова тема"', 'value="Нова тема" value="Інше"') },
  { name: 'стиснена діаграма', expect: 'DRAWIO_STRUCTURE', run: (x) => x.replace(/<mxGraphModel[\s\S]*<\/mxGraphModel>/, 'eJzLSM3JyQcABiwCFQ==') },
];

for (const c of CASES) {
  test(`2. пошкодження виявляється: ${c.name}`, () => {
    const bad = mutate(DRAWIO, c.run, c.name);
    const got = codes(bad);
    assert.ok(got.includes(c.expect), `очікувався ${c.expect}; отримано: ${got.join(', ') || '(чисто!)'}`);
  });
}

// ───────────── 3. Контракт і реальність конвертера не розходяться ─────────────

test('3. Еталонні стилі збігаються з константами самого конвертера (Python)', () => {
  const py = readFileSync(scriptPath('bpmn_di_to_drawio.py'), 'utf8');
  /** Витягує рядкову константу Python, склеєну з кількох літералів. */
  const constOf = (name: string): string => {
    const m = new RegExp(`^${name} = \\(([\\s\\S]*?)\\)$`, 'm').exec(py);
    assert.ok(m, `константи ${name} у скрипті немає`);
    return [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!).join('');
  };
  assert.equal(constOf('EVENT_BASE'), EVENT_BASE);
  assert.equal(constOf('GW_BASE'), GW_BASE);
  assert.equal(constOf('TASK_BASE'), TASK_BASE);
  assert.equal(constOf('POOL_STYLE'), POOL_STYLE);
  assert.equal(constOf('LANE_STYLE'), LANE_STYLE);
  assert.equal(constOf('EDGE_STYLE'), EDGE_STYLE);
  for (const [k, v] of Object.entries(GRAPH_MODEL_ATTRS)) assert.ok(py.includes(`${k}="${v}"`), `атрибут діаграми ${k}="${v}"`);
});

test('3. Еталонні стилі справді описують кожен вид клітинки', () => {
  const cells = readDrawio(DRAWIO).cells;
  const byId = new Map(cells.map((c) => [c.id, c]));
  assert.equal(byId.get('Participant_1')!.style, expectedStyle('pool'));
  assert.equal(byId.get('Lane_0')!.style, expectedStyle('lane'));
  assert.equal(byId.get('Task_S4')!.style, expectedStyle('task', { tag: 'task' }));
  assert.equal(byId.get('Gateway_S5')!.style, expectedStyle('exclusiveGateway', { tag: 'exclusiveGateway' }));
  const start = MODEL.nodes.get('StartEvent_1')!;
  assert.equal(byId.get('StartEvent_1')!.style, expectedStyle('startEvent', { labelWidth: start.label!.w }));
});

test('3. Перевірка працює не лише на цьому файлі: синтетичні пакети проходять чисто', async () => {
  for (const id of ['p01-sequence', 'p02-branch', 'p03-loop', 'p06-same-target', 'p07-large']) {
    const pkg = pkgOf(id);
    const r = await generateOk(pkg);
    assert.equal(r.drawio.status, 'ok', `${id}: ${JSON.stringify(r.drawio.issues).slice(0, 300)}`);
    const m = readPipelineBpmn(r.bpmn).model!;
    assert.deepEqual(verifyDrawioAgainstBpmn(r.drawio.xml!, m, null, { versionId: pkg.versionId, contentHash: pkg.contentHash }), [], id);
  }
});

// ───────────── 4. Продуктовий наслідок: пошкоджений .drawio не видається ─────────────

test('4. Кожне з трьох пошкоджень у продукті: .drawio не завантажується, .bpmn лишається чинним, модель не викликається', async () => {
  const faults: [string, (x: string) => string][] = [
    ['прихований шар', (x) => x.replace('<mxCell id="1" parent="0" />', '<mxCell id="1" parent="0" visible="0" />')],
    ['задачі як кола', (x) => x.replaceAll('shape=mxgraph.bpmn.task2;', 'shape=ellipse;')],
    ['прозорі лінії', (x) => x.replaceAll('endArrow=blockThin;', 'opacity=0;endArrow=blockThin;')],
  ];
  for (const [name, tamper] of faults) {
    const db = freshDb();
    const { c } = approvedCase(db);
    const client = new FakeReviewClient([okStep([])]);
    await runBpmnReviewForCase(db, human, c.id, reviewer(client, policyOf()));
    const out = await buildArtifact(db, human, c.id, undefined, { tamperDrawio: (x) => tamper(x) });
    assert.equal(out.artifact.status, 'ok', name);
    assert.equal(out.artifact.row.drawio_status, 'failed', `${name}: пошкоджений експорт має бути позначений як невдалий`);
    assert.equal(out.artifact.row.drawio_xml, null, `${name}: пошкоджений файл не зберігається`);
    assert.deepEqual(out.artifact.downloads, { bpmn: true, drawio: false }, name);
    assert.ok(readArtifactFile(db, c.id, 'bpmn').xml.length > 0, `${name}: справний .bpmn лишається доступним`);
    assert.throws(() => readArtifactFile(db, c.id, 'drawio'), (e: { code?: string }) => e.code === 'FILE_NOT_AVAILABLE', name);
    assert.ok((out.artifact.detail.drawioIssues ?? []).length > 0, `${name}: причина названа`);
    assert.equal(client.calls, 1, `${name}: побудова моделі не викликає`);

    // Технічне повторення експорту: без нового виклику моделі, на тій самій збереженій перевірці.
    const again = await buildArtifact(db, human, c.id);
    assert.equal(again.reused, false, `${name}: невдалий експорт має перебудовуватись, а не «залипати»`);
    assert.equal(again.artifact.row.drawio_status, 'ok', `${name}: без пошкодження експорт проходить`);
    assert.deepEqual(again.artifact.downloads, { bpmn: true, drawio: true }, name);
    assert.equal(client.calls, 1, `${name}: повторення експорту теж без виклику моделі`);
  }
});
