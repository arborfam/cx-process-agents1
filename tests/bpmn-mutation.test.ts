/**
 * Зріз 3a: навмисні пошкодження ГОТОВОГО файлу. Кожне пошкодження має бути виявлене зворотним читанням.
 * Тест, у якому пошкодження не виявлене, — це провал перевірки, а не прикладу.
 * Кожна мутація перевіряється на те, що вона справді змінила файл (helpers.mutate).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBpmn } from '../src/bpmn/verify.ts';
import { readBpmn } from '../src/bpmn/read.ts';
import { verifyDrawio } from '../src/bpmn/drawio.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import { generateOk, mutate, pkgOf, replaceOnce } from './bpmn-helpers.ts';

const codesOf = (xml: string, pkg: ApprovedPackage): string[] => {
  const r = verifyBpmn(xml, pkg).report;
  return [...r.errors, ...r.warnings.filter(() => false)].map((i) => i.code);
};

/** Блок елемента (від відкриваючого тега до закриваючого або самозакритого) за тегом і ID. */
const block = (tag: string, attrs: string): RegExp => new RegExp(`[ \\t]*<${tag} ${attrs}[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)\\n?`);
const removeTask = (x: string, id: string): string => replaceOnce(x, block('bpmn:task', `id="${id}"`), '', `видалити ${id}`);
const removeFlow = (x: string, id: string): string => {
  let out = replaceOnce(x, new RegExp(`[ \\t]*<bpmn:sequenceFlow id="${id}"[^>]*/>\\n?`), '', `видалити ${id}`);
  out = out.replace(new RegExp(`[ \\t]*<bpmn:(incoming|outgoing)>${id}</bpmn:\\1>\\n?`, 'g'), '');
  return out;
};
const removeShape = (x: string, id: string): string => replaceOnce(x, block('bpmndi:BPMNShape', `id="BPMNShape_${id}"`), '', `видалити фігуру ${id}`);
const removeEdge = (x: string, id: string): string => replaceOnce(x, block('bpmndi:BPMNEdge', `id="BPMNEdge_${id}"`), '', `видалити лінію ${id}`);

let loop: { xml: string; pkg: ApprovedPackage };
let branch: { xml: string; pkg: ApprovedPackage; drawio: string };
let same: { xml: string; pkg: ApprovedPackage; drawio: string };

before(async () => {
  const l = pkgOf('p03-loop');
  loop = { pkg: l, xml: (await generateOk(l)).bpmn };
  const b = pkgOf('p02-branch');
  const rb = await generateOk(b);
  branch = { pkg: b, xml: rb.bpmn, drawio: rb.drawio.xml! };
  const s = pkgOf('p06-same-target');
  const rs = await generateOk(s);
  same = { pkg: s, xml: rs.bpmn, drawio: rs.drawio.xml! };
});

test('контроль: непошкоджені файли проходять перевірку без помилок і попереджень', () => {
  for (const { xml, pkg } of [loop, branch, same]) {
    const r = verifyBpmn(xml, pkg).report;
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  }
});

type Case = { name: string; expect: string[]; run: () => string };
const CASES: Case[] = [
  // ── склад кроків ──
  { name: 'доданий крок (зайва задача)', expect: ['TASK_EXTRA'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:task id="Task_X" name="Повідомити керівника" />\n    <bpmn:sequenceFlow id="Flow_start"'), 'додати задачу') },
  { name: 'втрачений крок', expect: ['TASK_MISSING'], run: () => removeTask(loop.xml, 'Task_S3') },
  { name: 'змінена дія', expect: ['TASK_NAME_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name="Готує проєкт листа"'), 'змінити дію') },
  { name: 'дія втратила частину тексту (як при мовчазній втраті лапок)', expect: ['TASK_NAME_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name=""'), 'порожня назва') },
  { name: 'змінена умова', expect: ['CONDITION_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('name="текст затверджено"', 'name="так"'), 'змінити умову') },
  { name: 'умова втрачена (підпис лінії порожній)', expect: ['CONDITION_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace(' name="потрібне доопрацювання"', ''), 'прибрати підпис') },
  { name: 'неправильна доріжка', expect: ['TASK_WRONG_LANE'], run: () => {
    let x = replaceOnce(loop.xml, /[ \t]*<bpmn:flowNodeRef>Task_S2<\/bpmn:flowNodeRef>\n?/, '', 'прибрати з доріжки');
    return replaceOnce(x, /(<bpmn:lane id="Lane_0"[^>]*>\n)/, '$1        <bpmn:flowNodeRef>Task_S2</bpmn:flowNodeRef>\n', 'додати в чужу');
  } },
  { name: 'технічний елемент у чужій доріжці', expect: ['TECH_WRONG_LANE'], run: () => {
    let x = replaceOnce(loop.xml, /[ \t]*<bpmn:flowNodeRef>Gateway_S2<\/bpmn:flowNodeRef>\n?/, '', 'прибрати шлюз');
    return replaceOnce(x, /(<bpmn:lane id="Lane_0"[^>]*>\n)/, '$1        <bpmn:flowNodeRef>Gateway_S2</bpmn:flowNodeRef>\n', 'шлюз у чужу');
  } },
  // ── переходи й цикли ──
  { name: 'втрачений перехід', expect: ['TRANSITION_MISSING'], run: () => removeFlow(loop.xml, 'Flow_S3_1') },
  { name: 'втрачене повернення (цикл S2 → S1)', expect: ['LOOP_LOST'], run: () => removeFlow(loop.xml, 'Flow_S2_2') },
  { name: 'зайвий перехід', expect: ['TRANSITION_EXTRA'], run: () => mutate(loop.xml, (x) => x
    .replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:sequenceFlow id="Flow_extra" sourceRef="Task_S4" targetRef="Task_S1" />\n    <bpmn:sequenceFlow id="Flow_start"')
    .replace(/(<bpmn:task id="Task_S4"[^>]*>\n)/, '$1      <bpmn:outgoing>Flow_extra</bpmn:outgoing>\n')
    .replace(/(<bpmn:task id="Task_S1"[^>]*>\n)/, '$1      <bpmn:incoming>Flow_extra</bpmn:incoming>\n'), 'додати перехід') },
  { name: 'неявне паралельне розгалуження (дві лінії з задачі без шлюзу)', expect: ['IMPLICIT_SPLIT'], run: () => mutate(loop.xml, (x) => x
    .replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:sequenceFlow id="Flow_par" sourceRef="Task_S1" targetRef="Task_S4" />\n    <bpmn:sequenceFlow id="Flow_start"')
    .replace(/(<bpmn:task id="Task_S1"[^>]*>\n)/, '$1      <bpmn:outgoing>Flow_par</bpmn:outgoing>\n')
    .replace(/(<bpmn:task id="Task_S4"[^>]*>\n)/, '$1      <bpmn:incoming>Flow_par</bpmn:incoming>\n'), 'додати другу лінію') },
  { name: 'глухий кут (втрачено вихід у кінець)', expect: ['NO_PATH_TO_END', 'TRANSITION_MISSING'], run: () => removeFlow(loop.xml, 'Flow_S4_1') },
  { name: 'початок веде не в початковий крок', expect: ['START_WRONG_ENTRY'], run: () => mutate(loop.xml, (x) => x.replace('id="Flow_start" sourceRef="StartEvent_1" targetRef="Task_S1"', 'id="Flow_start" sourceRef="StartEvent_1" targetRef="Task_S2"'), 'змінити початок') },
  { name: 'назва початкової події змінена', expect: ['START_NAME_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('name="Потрібно повідомити клієнтів про зміну тарифів"', 'name="Інший тригер"'), 'змінити тригер') },
  { name: 'друга початкова подія', expect: ['START_COUNT'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:startEvent id="Start_2" />\n    <bpmn:sequenceFlow id="Flow_start"'), 'друга початкова') },
  // ── ролі ──
  { name: 'зайва доріжка (нова роль «Система»)', expect: ['LANE_EXTRA'], run: () => mutate(loop.xml, (x) => x.replace('</bpmn:laneSet>', '  <bpmn:lane id="Lane_9" name="Система" />\n    </bpmn:laneSet>'), 'додати доріжку') },
  { name: 'доріжку перейменовано', expect: ['LANE_MISSING', 'LANE_EXTRA'], run: () => mutate(loop.xml, (x) => x.replace('name="Юрист"', 'name="Юрисконсульт"'), 'перейменувати роль') },
  { name: 'зникла доріжка ролі', expect: ['LANE_MISSING'], run: () => replaceOnce(loop.xml, /[ \t]*<bpmn:lane id="Lane_2"[^>]*>[\s\S]*?<\/bpmn:lane>\n?/, '', 'прибрати доріжку') },
  { name: 'назву пулу змінено', expect: ['POOL_NAME_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('name="Підготовка повідомлення про зміну тарифів"', 'name="Інший процес"'), 'змінити пул') },
  // ── зайва нотація ──
  { name: 'зайвий таймер усередині кінцевої події', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace(/(<bpmn:endEvent id="End_S4_1"[^>]*>\n)/, '$1      <bpmn:timerEventDefinition id="T1" />\n'), 'таймер') },
  { name: 'зайвий проміжний таймер як окрема подія', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:intermediateCatchEvent id="Timer_1" name="1 день"><bpmn:timerEventDefinition id="T2" /></bpmn:intermediateCatchEvent>\n    <bpmn:sequenceFlow id="Flow_start"'), 'проміжний таймер') },
  { name: 'ексклюзивний шлюз замінено на паралельний', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:exclusiveGateway id="Gateway_S2"', '<bpmn:parallelGateway id="Gateway_S2"').replace(/(<bpmn:parallelGateway id="Gateway_S2"[\s\S]*?)<\/bpmn:exclusiveGateway>/, '$1</bpmn:parallelGateway>'), 'паралельний') },
  { name: 'задачу замінено на userTask (іконка «людина», якої немає в описі)', expect: ['UNSUPPORTED_ELEMENT', 'TASK_MISSING'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:task id="Task_S1"', '<bpmn:userTask id="Task_S1"').replace(/(<bpmn:userTask id="Task_S1"[\s\S]*?)<\/bpmn:task>/, '$1</bpmn:userTask>'), 'userTask') },
  { name: 'додано текстову примітку', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:textAnnotation id="Ann_1"><bpmn:text>примітка</bpmn:text></bpmn:textAnnotation>\n    <bpmn:sequenceFlow id="Flow_start"'), 'примітка') },
  { name: 'додано підпроцес', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:sequenceFlow id="Flow_start"', '<bpmn:subProcess id="Sub_1" name="Підпроцес" />\n    <bpmn:sequenceFlow id="Flow_start"'), 'підпроцес') },
  { name: 'додано другий учасник (пул)', expect: ['STRUCTURE'], run: () => mutate(loop.xml, (x) => x.replace('</bpmn:collaboration>', '  <bpmn:participant id="Participant_2" name="Інший" processRef="Process_1" />\n  </bpmn:collaboration>'), 'другий пул') },
  { name: 'документація з текстом на технічному елементі', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace(/(<bpmn:exclusiveGateway id="Gateway_S2"[^>]*>\n)/, '$1      <bpmn:documentation>вважається завершеним через 5 днів</bpmn:documentation>\n'), 'документація') },
  { name: 'назва на шлюзі (технічний елемент із власним текстом)', expect: ['GATEWAY_NAMED'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:exclusiveGateway id="Gateway_S2"', '<bpmn:exclusiveGateway id="Gateway_S2" name="Перевірка"'), 'назва шлюзу') },
  { name: 'назва на кінцевій події', expect: ['END_NAMED'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:endEvent id="End_S4_1"', '<bpmn:endEvent id="End_S4_1" name="Завершено"'), 'назва кінця') },
  { name: 'сторонній атрибут (шлюз за замовчуванням)', expect: ['UNSUPPORTED_ATTRIBUTE'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:exclusiveGateway id="Gateway_S2"', '<bpmn:exclusiveGateway id="Gateway_S2" default="Flow_S2_1"'), 'default') },
  { name: '[TO DEFINE] у назві', expect: ['TO_DEFINE_IN_FILE'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name="Готує проєкт [TO DEFINE: кому?]"'), 'TO DEFINE') },
  // ── зіпсований файл ──
  { name: 'зіпсований XML: сира лапка в назві (оригінальний ланцюг мовчки губив назву)', expect: ['XML_MALFORMED'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name="Готує "проєкт" повідомлення"'), 'сира лапка') },
  { name: 'зіпсований XML: сире «<» у значенні', expect: ['XML_MALFORMED'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name="a < b"'), 'сире <') },
  { name: 'зіпсований XML: незакритий тег', expect: ['XML_MALFORMED'], run: () => mutate(loop.xml, (x) => x.replace('</bpmn:process>', ''), 'незакритий') },
  { name: 'зіпсований XML: недозволений керівний символ', expect: ['XML_MALFORMED'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name="Готує\u000b проєкт"'), 'U+000B') },
  // Сира табуляція замість пробілу за правилами XML — той самий текст, тож це не пошкодження. Реальний захист — відхилення
  // табуляції на вході (tests/bpmn-input.test.ts): лейаутер записує її «сирою», і після читання вона стала б пробілом.
  { name: 'невідома сутність у назві', expect: ['XML_MALFORMED'], run: () => mutate(loop.xml, (x) => x.replace('name="Готує проєкт повідомлення"', 'name="Готує &nbsp; проєкт"'), 'сутність') },
  { name: 'повторний ID елемента (затирання кроку)', expect: ['DUPLICATE_ID'], run: () => mutate(loop.xml, (x) => x.replace('<bpmn:task id="Task_S4"', '<bpmn:task id="Task_S1"'), 'дубль ID') },
  { name: 'не BPMN: інший кореневий елемент', expect: ['NOT_BPMN'], run: () => mutate(loop.xml, (x) => x.replace(/bpmn:definitions/g, 'bpmn:foo'), 'корінь') },
  // ── версія й хеш ──
  { name: 'хеш версії змінено', expect: ['BINDING_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace(/contentHash="[0-9a-f]{64}"/, `contentHash="${'0'.repeat(64)}"`), 'хеш') },
  { name: 'ID версії змінено (схема на застарілій версії)', expect: ['BINDING_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('versionId="TEST-P03-V1"', 'versionId="TEST-P03-V0"'), 'версія') },
  { name: 'позначку походження змінено', expect: ['BINDING_MISMATCH'], run: () => mutate(loop.xml, (x) => x.replace('origin="test-fixture"', 'origin="product"'), 'походження') },
  { name: 'прив’язки до версії немає', expect: ['BINDING_MISSING'], run: () => replaceOnce(loop.xml, /[ \t]*<bpmn:extensionElements>[\s\S]*?<\/bpmn:extensionElements>\n?/, '', 'прибрати прив’язку') },
  // ── геометрія ──
  { name: 'відсутня геометрія задачі', expect: ['GEOMETRY_MISSING'], run: () => removeShape(loop.xml, 'Task_S2') },
  { name: 'відсутня геометрія кінцевої події', expect: ['GEOMETRY_MISSING'], run: () => removeShape(loop.xml, 'End_S4_1') },
  { name: 'відсутня лінія переходу', expect: ['GEOMETRY_MISSING'], run: () => removeEdge(loop.xml, 'Flow_S2_1') },
  { name: 'відсутня геометрія доріжки', expect: ['GEOMETRY_MISSING'], run: () => removeShape(loop.xml, 'Lane_1') },
  { name: 'відсутня геометрія пулу', expect: ['GEOMETRY_MISSING'], run: () => removeShape(loop.xml, 'Participant_1') },
  { name: 'нульовий розмір блока', expect: ['GEOMETRY_INVALID'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Task_S1">\s*<dc:Bounds x="[\d.]+" y="[\d.]+" width=")[\d.]+(")/, '$10$2'), 'нульова ширина') },
  { name: 'нечислова координата', expect: ['GEOMETRY_INVALID'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Task_S1">\s*<dc:Bounds x=")[\d.]+(")/, '$1abc$2'), 'нечислова') },
  { name: 'накладання блоків', expect: ['SHAPE_OVERLAP'], run: () => {
    const m = /bpmnElement="Task_S1">\s*<dc:Bounds x="([\d.]+)" y="([\d.]+)"/.exec(loop.xml)!;
    return mutate(loop.xml, (x) => x.replace(/(bpmnElement="Task_S2">\s*<dc:Bounds x=")[\d.]+(" y=")[\d.]+(")/, `$1${m[1]}$2${m[2]}$3`), 'накласти');
  } },
  { name: 'блок поза своєю доріжкою', expect: ['SHAPE_OUTSIDE_LANE'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Task_S1">\s*<dc:Bounds x="[\d.]+" y=")[\d.]+(")/, '$19000$2'), 'винести') },
  { name: 'доріжка поза пулом', expect: ['LANE_OUTSIDE_POOL'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Lane_1"[^>]*>\s*<dc:Bounds x=")[\d.]+(")/, '$1-500$2'), 'винести доріжку') },
  { name: 'назва не вміщується в блок (обрізана)', expect: ['LABEL_TRUNCATED'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Task_S3">\s*<dc:Bounds x="[\d.]+" y="[\d.]+" width=")[\d.]+(" height=")[\d.]+(")/, '$130$220$3'), 'стиснути') },
  { name: 'стрілка відірвана від блока', expect: ['EDGE_DETACHED'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Flow_start">\s*<di:waypoint x=")[\d.]+(")/, '$1999$2'), 'відірвати') },
  { name: 'стрілка вироджена (нульова довжина)', expect: ['EDGE_TOO_SHORT'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Flow_start">\s*<di:waypoint x="([\d.]+)" y="([\d.]+)" \/>\s*<di:waypoint x=")[\d.]+(" y=")[\d.]+(")/, '$1$2$4$3$5'), 'нульова довжина') },
  { name: 'лінія з однією точкою', expect: ['GEOMETRY_INVALID'], run: () => mutate(loop.xml, (x) => x.replace(/(bpmnElement="Flow_start">\s*<di:waypoint [^>]*\/>)\s*<di:waypoint [^>]*\/>/, '$1'), 'одна точка') },
  { name: 'геометрія посилається на неіснуючий елемент', expect: ['DI_DANGLING'], run: () => mutate(loop.xml, (x) => x.replace('bpmnElement="Task_S4"', 'bpmnElement="Task_S44"'), 'висяча') },
  { name: 'дві фігури для одного елемента', expect: ['DI_DUPLICATE'], run: () => mutate(loop.xml, (x) => x.replace(/(<bpmndi:BPMNShape id="BPMNShape_Task_S4" bpmnElement="Task_S4">\s*<dc:Bounds [^>]*\/>)/, '$1\n<dc:Bounds x="1" y="1" width="100" height="80" />'), 'дубль фігури') },
  { name: 'нерозпізнана нотація в геометрії', expect: ['UNSUPPORTED_ELEMENT'], run: () => mutate(loop.xml, (x) => x.replace('</bpmndi:BPMNPlane>', '<bpmndi:BPMNShape id="Extra" bpmnElement="Ann_1"><dc:Bounds x="0" y="0" width="10" height="10" /><foo:bar xmlns:foo="urn:foo" /></bpmndi:BPMNShape></bpmndi:BPMNPlane>'), 'сторонній елемент у DI') },
];

for (const c of CASES) {
  test(`пошкодження виявляється: ${c.name}`, () => {
    const xml = c.run();
    assert.notEqual(xml, loop.xml);
    const codes = codesOf(xml, loop.pkg);
    for (const e of c.expect) assert.ok(codes.includes(e), `очікувався код ${e}; отримано: ${codes.join(', ') || '(чисто!)'}`);
    assert.equal(verifyBpmn(xml, loop.pkg).report.ok, false, 'перевірка мала відхилити файл');
  });
}

test('пошкодження виявляється: лінії, що повністю збігаються (одну стрілку не видно)', () => {
  const edge = /<bpmndi:BPMNEdge id="BPMNEdge_Flow_S2_([12])" bpmnElement="Flow_S2_\1">\s*(<di:waypoint [^>]*\/>\s*)+/;
  void edge;
  // у пакеті p06 дві лінії S2→S3 розведено; зробимо їх однаковими
  const get = (id: string): string => new RegExp(`bpmnElement="${id}">((?:\\s*<di:waypoint [^>]*/>)+)`).exec(same.xml)![1]!;
  const a = get('Flow_S2_1'), b = get('Flow_S2_2');
  assert.notEqual(a, b, 'контроль: у справжньому файлі лінії розведено');
  const xml = mutate(same.xml, (x) => x.replace(b, a), 'зробити лінії однаковими');
  assert.ok(codesOf(xml, same.pkg).includes('EDGE_HIDDEN'));
});

test('схема, побудована для іншого пакета, відхиляється (версія/хеш/зміст)', async () => {
  const other = pkgOf('p02-branch');
  const codes = codesOf(loop.xml, other);
  assert.ok(codes.includes('BINDING_MISMATCH'));
  assert.ok(codes.includes('TASK_EXTRA') || codes.includes('TASK_MISSING'));
});

test('файл на застарілій версії: той самий зміст, інший хеш — відхиляється', () => {
  const stale = { ...loop.pkg, contentHash: 'f'.repeat(64) };
  assert.ok(codesOf(loop.xml, stale).includes('BINDING_MISMATCH'));
  const newer = { ...loop.pkg, versionId: 'TEST-P03-V2' };
  assert.ok(codesOf(loop.xml, newer).includes('BINDING_MISMATCH'));
});

test('змінений погоджений зміст (інша дія/умова/роль/початок) — готовий файл більше не відповідає пакету', () => {
  const p1 = JSON.parse(JSON.stringify(loop.pkg)) as ApprovedPackage;
  p1.content.steps[0]!.action = 'Інша дія';
  assert.ok(codesOf(loop.xml, p1).includes('TASK_NAME_MISMATCH'));
  const p2 = JSON.parse(JSON.stringify(loop.pkg)) as ApprovedPackage;
  p2.content.steps[1]!.next[0]!.condition = 'інша умова';
  assert.ok(codesOf(loop.xml, p2).includes('CONDITION_MISMATCH'));
  const p3 = JSON.parse(JSON.stringify(loop.pkg)) as ApprovedPackage;
  p3.content.steps[0]!.role = 'Редактор';
  assert.ok(codesOf(loop.xml, p3).includes('TASK_WRONG_LANE'));
  const p4 = JSON.parse(JSON.stringify(loop.pkg)) as ApprovedPackage;
  p4.content.entry_step_id = 'S2';
  assert.ok(codesOf(loop.xml, p4).includes('START_WRONG_ENTRY'));
});

test('читач не залежить від генератора: розбирає файл, створений іншим способом (зокрема з іншими префіксами просторів імен)', () => {
  const renamed = loop.xml.replace(/xmlns:bpmn=/, 'xmlns:b=').replace(/<(\/?)bpmn:/g, '<$1b:');
  const r = readBpmn(renamed);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  assert.equal(r.model!.nodes.size, readBpmn(loop.xml).model!.nodes.size);
  // і звірка за таким файлом дає той самий (чистий) результат
  assert.deepEqual(verifyBpmn(renamed, loop.pkg).report.errors, []);
});

// ───────────────────────── .drawio: власна зворотна звірка ─────────────────────────

const dioCases: { name: string; expect: string[]; base: 'branch' | 'same'; run: (x: string) => string }[] = [
  { name: 'втрачена задача (крок)', expect: ['DRAWIO_CELL_MISSING', 'DRAWIO_STEP_MISSING'], base: 'branch', run: (x) => replaceOnce(x, /[ \t]*<mxCell id="Task_S3"[^>]*>[\s\S]*?<\/mxCell>\n?/, '', 'видалити задачу') },
  { name: 'втрачена стрілка', expect: ['DRAWIO_CELL_MISSING', 'DRAWIO_EDGE_COUNT', 'DRAWIO_TRANSITION_MISSING'], base: 'branch', run: (x) => replaceOnce(x, /[ \t]*<mxCell id="Flow_S1_1"[^>]*>[\s\S]*?<\/mxCell>\n?/, '', 'видалити стрілку') },
  { name: 'змінена дія', expect: ['DRAWIO_LABEL_MISMATCH'], base: 'branch', run: (x) => x.replace('value="Повідомляє клієнта про відмову та її причини"', 'value="Інша дія"') },
  { name: 'змінена умова на стрілці', expect: ['DRAWIO_LABEL_MISMATCH', 'DRAWIO_TRANSITION_MISSING', 'DRAWIO_TRANSITION_EXTRA'], base: 'branch', run: (x) => x.replace('value="підстав недостатньо"', 'value="ні"') },
  { name: 'неправильна доріжка', expect: ['DRAWIO_WRONG_LANE'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Task_S3"[^>]*parent=")Lane_1(")/, '$1Lane_0$2') },
  { name: 'повторний ID клітинки', expect: ['DRAWIO_DUPLICATE_ID'], base: 'branch', run: (x) => x.replace('<mxCell id="Task_S4"', '<mxCell id="Task_S3"') },
  { name: 'відсутня геометрія блока', expect: ['DRAWIO_GEOMETRY'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Task_S3"[^>]*>)<mxGeometry[^>]*\/>/, '$1') },
  { name: 'геометрія не збігається зі схемою', expect: ['DRAWIO_GEOMETRY'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Task_S3"[^>]*><mxGeometry x=")[\d.]+(")/, '$1777$2') },
  { name: 'зайва клітинка', expect: ['DRAWIO_CELL_EXTRA'], base: 'branch', run: (x) => x.replace('</root>', '<mxCell id="Zайва" value="Повідомити керівника" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry" /></mxCell></root>') },
  { name: 'зайва нотація: маркер «людина» на задачі', expect: ['DRAWIO_UNSUPPORTED_STYLE'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Task_S3"[^>]*style="[^"]*)taskMarker=abstract/, '$1taskMarker=user') },
  { name: 'зайва нотація: паралельний шлюз', expect: ['DRAWIO_UNSUPPORTED_STYLE'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Gateway_S2"[^>]*style="[^"]*)gwType=exclusive/, '$1gwType=parallel') },
  { name: 'зайва нотація: таймер у початковій події', expect: ['DRAWIO_UNSUPPORTED_STYLE'], base: 'branch', run: (x) => x.replace(/(<mxCell id="StartEvent_1"[^>]*style="[^"]*)symbol=general/, '$1symbol=timer') },
  { name: 'стрілку перенаправлено на іншу ціль', expect: ['DRAWIO_EDGE_MISMATCH', 'DRAWIO_TRANSITION_MISSING', 'DRAWIO_TRANSITION_EXTRA'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Flow_S1_1"[^>]*target=")Task_S2(")/, '$1Task_S4$2') },
  { name: 'стрілка без джерела', expect: ['DRAWIO_EDGE_DETACHED'], base: 'branch', run: (x) => x.replace(/(<mxCell id="Flow_S1_1"[^>]*) source="[^"]*"/, '$1') },
  { name: 'прив’язку до версії видалено', expect: ['DRAWIO_BINDING_MISMATCH'], base: 'branch', run: (x) => x.replace(/ cx_version_id="[^"]*"/, '') },
  { name: 'інший хеш версії', expect: ['DRAWIO_BINDING_MISMATCH'], base: 'branch', run: (x) => x.replace(/cx_content_hash="[0-9a-f]{64}"/, `cx_content_hash="${'1'.repeat(64)}"`) },
  { name: 'зіпсований XML', expect: ['DRAWIO_XML_MALFORMED'], base: 'branch', run: (x) => x.replace('value="Оператор"', 'value="Оператор" value="Інший"') },
  { name: 'стиснена діаграма (вміст перевірити не можна)', expect: ['DRAWIO_STRUCTURE'], base: 'branch', run: (x) => x.replace(/<mxGraphModel[\s\S]*<\/mxGraphModel>/, 'eJzLSM3JyQcABiwCFQ==') },
  { name: 'оригінальний дефект: на одну стрілку менше при двох умовах в одну ціль', expect: ['DRAWIO_CELL_MISSING', 'DRAWIO_EDGE_COUNT', 'DRAWIO_TRANSITION_MISSING'], base: 'same', run: (x) => replaceOnce(x, /[ \t]*<mxCell id="Flow_S2_2"[^>]*>[\s\S]*?<\/mxCell>\n?/, '', 'видалити одну з двох стрілок') },
  { name: 'підпис однієї з двох умов в одну ціль втрачено', expect: ['DRAWIO_LABEL_MISMATCH', 'DRAWIO_TRANSITION_MISSING'], base: 'same', run: (x) => x.replace('value="погоджено умовно"', 'value=""') },
];

for (const c of dioCases) {
  test(`.drawio: пошкодження виявляється: ${c.name}`, () => {
    const b = c.base === 'branch' ? branch : same;
    const xml = mutate(b.drawio, c.run, c.name);
    const model = readBpmn(b.xml).model!;
    const issues = verifyDrawio(xml, b.pkg, model);
    const codes = issues.map((i) => i.code);
    for (const e of c.expect) assert.ok(codes.includes(e), `очікувався ${e}; отримано: ${codes.join(', ') || '(чисто!)'}`);
    assert.ok(issues.some((i) => i.severity === 'error'));
  });
}

test('.drawio: контроль — непошкоджений експорт проходить власну звірку без жодного зауваження', () => {
  for (const b of [branch, same]) assert.deepEqual(verifyDrawio(b.drawio, b.pkg, readBpmn(b.xml).model!), []);
});

// ───────────────────────── гарантія: пошкоджений результат не видається ─────────────────────────

test('якщо готовий .bpmn пошкоджено до видачі — статус verification_failed, файлу немає', async () => {
  const { generateBpmn } = await import('../src/bpmn/generate.ts');
  for (const [name, tamper] of [
    ['втрачено крок', (x: string) => removeTask(x, 'Task_S3')],
    ['змінено умову', (x: string) => x.replace('name="текст затверджено"', 'name="так"')],
    ['втрачено геометрію', (x: string) => removeShape(x, 'Task_S2')],
    ['зіпсовано XML', (x: string) => x.replace('</bpmn:process>', '')],
  ] as const) {
    const r = await generateBpmn(loop.pkg, { tamperBpmn: (x) => mutate(x, tamper, name) });
    assert.equal(r.status, 'verification_failed', name);
    if (r.status === 'verification_failed') {
      assert.equal(r.stage, 'bpmn');
      assert.ok(r.issues.length > 0);
    }
    assert.equal('bpmn' in r, false, `${name}: пошкоджений файл не має потрапити до результату`);
  }
});

test('якщо пошкоджено лише експорт .drawio — .bpmn лишається чинним, а експорт позначено невдалим і не видається', async () => {
  const { generateBpmn } = await import('../src/bpmn/generate.ts');
  const r = await generateBpmn(loop.pkg, { tamperDrawio: (x) => mutate(x, (s) => s.replace(/[ \t]*<mxCell id="Flow_S1_1"[^>]*>[\s\S]*?<\/mxCell>\n?/, ''), 'видалити стрілку') });
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.verification.ok, true);
  assert.equal(r.drawio.status, 'failed');
  assert.equal(r.drawio.xml, null, 'невдалий експорт не видається');
  assert.ok(r.drawio.issues.some((i) => i.code === 'DRAWIO_CELL_MISSING'));
  assert.ok(r.map.every((m) => m.drawio_cell_id === null), 'у карті немає посилань на клітинки .drawio, якого не видано');
});
