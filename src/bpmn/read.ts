/**
 * Незалежне читання готового `.bpmn` назад у модель (технічний план §1а).
 *
 * Читач не знає, як файл було створено: він суворо розбирає XML, збирає лише те, що там справді записано, і
 * позначає все, чого немає в переліку дозволеного (зайва нотація). Звірка з пакетом — у verify.ts.
 */
import { attr, elementChildren, parseXml, XmlError, type XmlElement } from './xml.ts';
import { NS } from './ids.ts';
import type { Binding, Issue } from './types.ts';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export interface FlowNode {
  /** Повний текст у деталях елемента (bpmn:documentation): наприклад повний тригер при короткому підписі (D88). */
  documentation?: string;
  id: string;
  tag: 'startEvent' | 'endEvent' | 'task' | 'exclusiveGateway';
  name: string | undefined;
  incoming: string[];
  outgoing: string[];
}
export interface SeqFlow { id: string; name: string | undefined; source: string; target: string }
export interface Lane { id: string; name: string | undefined; refs: string[] }

export interface BpmnModel {
  binding: Binding | null;
  collaborationCount: number;
  processCount: number;
  participant: { id: string; name: string | undefined; processRef: string | undefined } | null;
  processId: string | null;
  lanes: Lane[];
  nodes: Map<string, FlowNode>;
  flows: SeqFlow[];
  /** Геометрія: ключ — ID семантичного елемента. */
  shapes: Map<string, Rect[]>;
  shapeLabels: Map<string, Rect>;
  edges: Map<string, Pt[][]>;
  edgeLabels: Map<string, Rect>;
  /** Усі ID у файлі, із повторами (для перевірки унікальності). */
  allIds: string[];
  /** Усі значення назв (для пошуку «[TO DEFINE]»). */
  allNames: { id: string; name: string }[];
  /** Посилання з DI на елементи (для виявлення «висячих»). */
  diRefs: string[];
  diagramCount: number;
  planeRef: string | null;
}

export interface ReadResult {
  model: BpmnModel | null;
  issues: Issue[];
}

const err = (code: string, message: string, refs: string[] = []): Issue => ({ code, severity: 'error', message, refs });

const MODEL_ALLOWED_ATTRS: readonly string[] = ['id', 'name', 'sourceRef', 'targetRef', 'processRef', 'isExecutable', 'targetNamespace'];

function describe(e: XmlElement): string {
  const id = attr(e, 'id');
  return `<${e.name}>${id ? ` (ID ${id})` : ''}`;
}

export function readBpmn(xml: string): ReadResult {
  const issues: Issue[] = [];
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (e) {
    const msg = e instanceof XmlError ? e.message : String(e);
    return { model: null, issues: [err('XML_MALFORMED', `Файл не є коректним XML: ${msg}. Поблажливий розбір міг би мовчки загубити назви.`)] };
  }
  if (root.ns !== NS.bpmn || root.local !== 'definitions') {
    return { model: null, issues: [err('NOT_BPMN', `Кореневий елемент має бути bpmn:definitions у просторі імен BPMN 2.0, а знайдено ${describe(root)}.`)] };
  }

  const model: BpmnModel = {
    binding: null, collaborationCount: 0, processCount: 0, participant: null, processId: null, lanes: [],
    nodes: new Map(), flows: [], shapes: new Map(), shapeLabels: new Map(), edges: new Map(), edgeLabels: new Map(),
    allIds: [], allNames: [], diRefs: [], diagramCount: 0, planeRef: null,
  };
  const unsupported = (e: XmlElement, why?: string): void => {
    issues.push(err('UNSUPPORTED_ELEMENT', `У файлі є елемент ${describe(e)}${why ? ` (${why})` : ''}, якого немає в підтримуваному переліку v1: такий елемент додає нотацію, відсутню в погодженому описі.`, [attr(e, 'id') ?? e.name]));
  };

  // усі ID і назви
  const collect = (e: XmlElement): void => {
    const id = attr(e, 'id');
    if (id !== undefined) model.allIds.push(id);
    const name = attr(e, 'name');
    if (name !== undefined && e.ns === NS.bpmn) model.allNames.push({ id: id ?? e.name, name });
    elementChildren(e).forEach(collect);
  };
  collect(root);

  // атрибути моделі
  const checkAttrs = (e: XmlElement): void => {
    for (const a of e.attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      if (a.ns !== '') continue; // атрибути інших просторів імен на BPMN-елементах — окрема перевірка нижче
      if (!MODEL_ALLOWED_ATTRS.includes(a.local)) {
        issues.push(err('UNSUPPORTED_ATTRIBUTE', `Елемент ${describe(e)} має атрибут «${a.name}», якого немає в підтримуваному переліку.`, [attr(e, 'id') ?? e.name]));
      }
    }
    for (const a of e.attrs) {
      if (a.ns !== '' && a.ns !== 'http://www.w3.org/2000/xmlns/' && a.ns !== 'http://www.w3.org/XML/1998/namespace') {
        issues.push(err('UNSUPPORTED_ATTRIBUTE', `Елемент ${describe(e)} має атрибут «${a.name}» стороннього простору імен.`, [attr(e, 'id') ?? e.name]));
      }
    }
  };

  const textOf = (e: XmlElement): string => e.children.filter((c): c is string => typeof c === 'string').join('').trim();
  const flowRefList = (e: XmlElement, local: 'incoming' | 'outgoing'): string[] =>
    elementChildren(e).filter((c) => c.ns === NS.bpmn && c.local === local).map(textOf);

  for (const top of elementChildren(root)) {
    if (top.ns === NS.bpmn && top.local === 'collaboration') {
      model.collaborationCount++;
      checkAttrs(top);
      for (const ch of elementChildren(top)) {
        if (ch.ns === NS.bpmn && ch.local === 'participant') {
          checkAttrs(ch);
          if (model.participant) issues.push(err('STRUCTURE', 'У файлі більше одного учасника (пулу): v1 підтримує лише один.', [attr(ch, 'id') ?? '']));
          model.participant = { id: attr(ch, 'id') ?? '', name: attr(ch, 'name'), processRef: attr(ch, 'processRef') };
          if (elementChildren(ch).length) unsupported(elementChildren(ch)[0]!);
        } else unsupported(ch);
      }
    } else if (top.ns === NS.bpmn && top.local === 'process') {
      model.processCount++;
      model.processId = attr(top, 'id') ?? null;
      checkAttrs(top);
      if (attr(top, 'isExecutable') !== undefined && attr(top, 'isExecutable') !== 'false') {
        issues.push(err('UNSUPPORTED_ATTRIBUTE', 'Процес позначено виконуваним (isExecutable): схема AS-IS не є моделлю виконання.', [attr(top, 'id') ?? '']));
      }
      for (const ch of elementChildren(top)) readProcessChild(ch);
    } else if (top.ns === NS.bpmndi && top.local === 'BPMNDiagram') {
      model.diagramCount++;
      readDiagram(top);
    } else {
      unsupported(top);
    }
  }

  function readProcessChild(ch: XmlElement): void {
    if (ch.ns === NS.bpmn && ch.local === 'extensionElements') {
      for (const x of elementChildren(ch)) {
        if (x.ns === NS.cx && x.local === 'asIsBinding') {
          if (model.binding) issues.push(err('BINDING_DUPLICATE', 'Прив’язка до версії записана більше одного разу.'));
          model.binding = {
            versionId: attr(x, 'versionId') ?? '', contentHash: attr(x, 'contentHash') ?? '',
            origin: attr(x, 'origin') ?? '', generator: attr(x, 'generator') ?? '',
          };
        } else unsupported(x, 'сторонній елемент у extensionElements');
      }
      return;
    }
    if (ch.ns === NS.bpmn && ch.local === 'laneSet') {
      for (const lane of elementChildren(ch)) {
        if (lane.ns === NS.bpmn && lane.local === 'lane') {
          checkAttrs(lane);
          const refs: string[] = [];
          for (const x of elementChildren(lane)) {
            if (x.ns === NS.bpmn && x.local === 'flowNodeRef') refs.push(textOf(x));
            else unsupported(x);
          }
          model.lanes.push({ id: attr(lane, 'id') ?? '', name: attr(lane, 'name'), refs });
        } else unsupported(lane);
      }
      return;
    }
    const tag = ch.ns === NS.bpmn ? ch.local : '';
    if (tag === 'startEvent' || tag === 'endEvent' || tag === 'task' || tag === 'exclusiveGateway') {
      checkAttrs(ch);
      // `documentation` — це опис елемента, а не нотація: там зберігається ПОВНИЙ текст (наприклад тригер),
      // коли на схемі стоїть погоджений короткий підпис (D88). На вигляд схеми він не впливає.
      let documentation: string | undefined;
      for (const x of elementChildren(ch)) {
        // Деталі дозволені лише на ПОЧАТКОВІЙ події: там лежить повний текст тригера, коли на схемі
        // стоїть погоджений короткий підпис (D88). На інших елементах це текст, якого на схемі не видно,
        // — отже, зміст, що не потрапив у погоджений опис.
        if (x.ns === NS.bpmn && x.local === 'documentation' && tag === 'startEvent') { documentation = textOf(x); continue; }
        if (!(x.ns === NS.bpmn && (x.local === 'incoming' || x.local === 'outgoing'))) unsupported(x, `усередині ${describe(ch)}`);
      }
      const id = attr(ch, 'id') ?? '';
      if (model.nodes.has(id)) return; // повтор ID відзначить перевірка унікальності
      model.nodes.set(id, { id, tag, name: attr(ch, 'name'), documentation, incoming: flowRefList(ch, 'incoming'), outgoing: flowRefList(ch, 'outgoing') });
      return;
    }
    if (tag === 'sequenceFlow') {
      checkAttrs(ch);
      for (const x of elementChildren(ch)) unsupported(x, `усередині ${describe(ch)}`);
      model.flows.push({ id: attr(ch, 'id') ?? '', name: attr(ch, 'name'), source: attr(ch, 'sourceRef') ?? '', target: attr(ch, 'targetRef') ?? '' });
      return;
    }
    unsupported(ch);
  }

  function num(e: XmlElement, k: string): number {
    const v = attr(e, k);
    return v === undefined || v.trim() === '' ? NaN : Number(v);
  }
  function rectOf(b: XmlElement): Rect {
    return { x: num(b, 'x'), y: num(b, 'y'), w: num(b, 'width'), h: num(b, 'height') };
  }

  function readDiagram(d: XmlElement): void {
    for (const plane of elementChildren(d)) {
      if (!(plane.ns === NS.bpmndi && plane.local === 'BPMNPlane')) { unsupported(plane); continue; }
      model.planeRef = attr(plane, 'bpmnElement') ?? null;
      for (const pe of elementChildren(plane)) {
        const ref = attr(pe, 'bpmnElement') ?? '';
        if (pe.ns === NS.bpmndi && pe.local === 'BPMNShape') {
          model.diRefs.push(ref);
          for (const x of elementChildren(pe)) {
            if (x.ns === NS.dc && x.local === 'Bounds') model.shapes.set(ref, [...(model.shapes.get(ref) ?? []), rectOf(x)]);
            else if (x.ns === NS.bpmndi && x.local === 'BPMNLabel') {
              const lb = elementChildren(x).find((y) => y.ns === NS.dc && y.local === 'Bounds');
              if (lb) model.shapeLabels.set(ref, rectOf(lb));
            } else unsupported(x);
          }
          if (!model.shapes.has(ref)) model.shapes.set(ref, []);
        } else if (pe.ns === NS.bpmndi && pe.local === 'BPMNEdge') {
          model.diRefs.push(ref);
          const pts: Pt[] = [];
          for (const x of elementChildren(pe)) {
            if (x.ns === NS.di && x.local === 'waypoint') pts.push({ x: num(x, 'x'), y: num(x, 'y') });
            else if (x.ns === NS.bpmndi && x.local === 'BPMNLabel') {
              const lb = elementChildren(x).find((y) => y.ns === NS.dc && y.local === 'Bounds');
              if (lb) model.edgeLabels.set(ref, rectOf(lb));
            } else unsupported(x);
          }
          model.edges.set(ref, [...(model.edges.get(ref) ?? []), pts]);
        } else unsupported(pe);
      }
    }
  }

  return { model, issues };
}
