/**
 * ЕТАЛОННИЙ КОНТРАКТ ЕКСПОРТУ `.drawio` і сувора перевірка стилю (повертає повноту D60 на новому шляху).
 *
 * Навіщо перелік ДОЗВОЛЕНОГО, а не перелік забороненого: зміст і геометрія можуть бути правильними, а
 * зображення — вже ні. `visible="0"` на шарі ховає всю схему; `shape=ellipse` замість `mxgraph.bpmn.task2`
 * робить із задач кола; `opacity=0` на лініях прибирає всі стрілки. Перелік «трьох поганих параметрів»
 * такі випадки не ловить принципово — тому тут порівнюється **повна відповідність** стилю клітинки еталону:
 * зайвий, відсутній чи змінений параметр — помилка. Параметри, що впливають на видимість і напрямок стрілки,
 * мають окремі коди з окремим поясненням.
 *
 * Еталон — це рівно те, що пише `pipeline/bpmn_di_to_drawio.py`. Щоб два описи не розійшлися,
 * `tests/pipeline-drawio.test.ts` звіряє ці константи з константами самого скрипта.
 */
import type { Issue } from '../bpmn/types.ts';

export const EVENT_BASE = 'points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],[0.855,0.855,0],[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;whiteSpace=wrap;';
export const GW_BASE = 'points=[[0.25,0.25,0],[0.5,0,0],[0.75,0.25,0],[1,0.5,0],[0.75,0.75,0],[0.5,1,0],[0.25,0.75,0],[0,0.5,0]];shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=rhombusPerimeter;outlineConnect=0;';
export const TASK_BASE = 'shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=1;container=0;expand=0;collapsible=0;taskMarker=';
export const POOL_STYLE = 'swimlane;html=1;childLayout=stackLayout;horizontal=0;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;collapsible=0;swimlaneFillColor=#ffffff;whiteSpace=wrap;fontStyle=0;';
export const LANE_STYLE = 'swimlane;html=1;startSize=30;horizontal=0;collapsible=0;swimlaneLine=1;swimlaneFillColor=#ffffff;fillColor=none;whiteSpace=wrap;fontStyle=0;';
export const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=blockThin;endFill=1;fontSize=11;labelBackgroundColor=#ffffff;whiteSpace=wrap;';

/** Маркер задачі за типом елемента BPMN. Інший маркер = інша нотація на екрані. */
export const TASK_MARKER: Record<string, string> = {
  task: 'abstract', userTask: 'user', manualTask: 'manual', serviceTask: 'service',
  scriptTask: 'script', businessRuleTask: 'businessRule', sendTask: 'send', receiveTask: 'receive',
};
/** Вид шлюзу за типом елемента BPMN. */
export const GW_TYPE: Record<string, string> = {
  exclusiveGateway: 'exclusive', parallelGateway: 'parallel', inclusiveGateway: 'inclusive',
  complexGateway: 'complex', eventBasedGateway: 'exclusive',
};

/** Атрибути `<mxGraphModel>` еталонного експорту. Будь-який інший (наприклад `background`) — відхилення. */
export const GRAPH_MODEL_ATTRS: Record<string, string> = {
  dx: '1000', dy: '700', grid: '1', gridSize: '10', guides: '1', tooltips: '1',
  connect: '1', arrows: '1', fold: '1', page: '0', pageScale: '1', math: '0', shadow: '0',
};

export type CellKind = 'pool' | 'lane' | 'task' | 'startEvent' | 'endEvent' | 'exclusiveGateway' | 'edge';

export interface StyleOptions {
  /** Ширина рамки зовнішнього підпису з `.bpmn` (px). Додається лише там, де рамка справді є. */
  labelWidth?: number;
  /** Тег елемента BPMN — для маркера задачі та виду шлюзу. */
  tag?: string;
}

/** Еталонний стиль клітинки — рівно те, що має написати конвертер. */
export function expectedStyle(kind: CellKind, opts: StyleOptions = {}): string {
  const label = opts.labelWidth !== undefined ? `labelWidth=${Math.round(opts.labelWidth)};` : '';
  switch (kind) {
    case 'pool': return POOL_STYLE;
    case 'lane': return LANE_STYLE;
    case 'task': return TASK_BASE + (TASK_MARKER[opts.tag ?? 'task'] ?? 'abstract') + ';';
    case 'exclusiveGateway': return GW_BASE + `outline=none;symbol=none;gwType=${GW_TYPE[opts.tag ?? 'exclusiveGateway'] ?? 'exclusive'};` + label;
    case 'startEvent': return EVENT_BASE + 'outline=standard;symbol=general;' + label;
    case 'endEvent': return EVENT_BASE + 'outline=end;symbol=general;' + label;
    case 'edge': return EDGE_STYLE + label;
  }
}

export function parseStyle(style: string): { map: Map<string, string>; duplicates: string[] } {
  const map = new Map<string, string>();
  const duplicates: string[] = [];
  for (const part of style.split(';')) {
    if (part === '') continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    if (map.has(k)) duplicates.push(k);
    map.set(k, v);
  }
  return { map, duplicates };
}

/** Параметри, якими елемент або його текст можна зробити невидимим чи нечитабельним. */
const VISIBILITY_KEYS: readonly string[] = [
  'opacity', 'textOpacity', 'fillOpacity', 'strokeOpacity', 'swimlaneFillColor', 'fillColor', 'strokeColor',
  'fontColor', 'gradientColor', 'noLabel', 'visible', 'strokeWidth', 'fontSize', 'fontFamily', 'fontStyle',
  'labelBackgroundColor', 'labelBorderColor', 'labelPosition', 'verticalLabelPosition', 'verticalAlign',
  'align', 'labelWidth', 'overflow', 'whiteSpace', 'spacing', 'spacingLeft', 'spacingRight', 'spacingTop',
  'spacingBottom', 'rotation', 'flipH', 'flipV', 'shadow', 'glass', 'sketch', 'textDirection', 'imageAspect',
  'aspect', 'html', 'startSize', 'horizontal', 'collapsible', 'swimlaneLine', 'childLayout',
];
/** Параметри, що визначають, ЩО САМЕ намальовано: фігура, маркер задачі, вид шлюзу, символ події. */
const SHAPE_KEYS: readonly string[] = ['shape', 'taskMarker', 'gwType', 'symbol', 'outline', 'rectStyle', 'isLoopSub', 'perimeter', 'points', 'size'];
/** Параметри, що визначають вигляд і напрямок стрілки. */
const ARROW_KEYS: readonly string[] = [
  'endArrow', 'startArrow', 'endFill', 'startFill', 'endSize', 'startSize', 'edgeStyle', 'curved', 'dashed',
  'dashPattern', 'jumpStyle', 'jumpSize', 'flowAnimation', 'perimeterSpacing', 'rounded', 'arcSize', 'elbow',
  'orthogonalLoop', 'jettySize', 'noEdgeStyle', 'bendable', 'endWidth', 'startWidth',
];

const q = (v: string | undefined): string => (v === undefined ? 'відсутній' : `«${v}»`);

/**
 * Повна звірка стилю клітинки з еталоном. Повертає помилки (порожньо = стиль відповідає еталону).
 * Коди: `DRAWIO_STYLE_HIDDEN` — можна приховати елемент чи текст; `DRAWIO_UNSUPPORTED_STYLE` — намальовано
 * не те, що в схемі; `DRAWIO_ARROW` — змінено вигляд чи напрямок стрілки; `DRAWIO_STYLE_MISMATCH` — решта.
 */
export function checkCellStyle(cellId: string, label: string, kind: CellKind, style: string, opts: StyleOptions = {}): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, message: string): void => { out.push({ code, severity: 'error', message: `Клітинка ${label}: ${message}.`, refs: [cellId] }); };
  const got = parseStyle(style);
  const want = parseStyle(expectedStyle(kind, opts)).map;
  for (const d of got.duplicates) err('DRAWIO_STYLE_MISMATCH', `параметр стилю «${d}» записано двічі (який діє — залежить від програми)`);
  const classify = (k: string, g: string | undefined, w: string | undefined): void => {
    const tail = `${q(g)} (очікується ${w === undefined ? 'відсутність параметра' : `«${w}»`})`;
    if (SHAPE_KEYS.includes(k)) err('DRAWIO_UNSUPPORTED_STYLE', `параметр стилю «${k}» ${tail}: на екрані буде намальовано не те, що у схемі`);
    else if (kind === 'edge' && ARROW_KEYS.includes(k)) err('DRAWIO_ARROW', `параметр стилю «${k}» ${tail}: це змінює вигляд або напрямок стрілки`);
    else if (VISIBILITY_KEYS.includes(k)) err('DRAWIO_STYLE_HIDDEN', `параметр стилю «${k}» ${tail}: це може зробити елемент чи його текст невидимим або нечитабельним`);
    else err('DRAWIO_STYLE_MISMATCH', `параметр стилю «${k}» ${tail}: стиль відрізняється від еталонного`);
  };
  for (const [k, w] of want) if (got.map.get(k) !== w) classify(k, got.map.get(k), w);
  for (const [k, g] of got.map) if (!want.has(k)) classify(k, g, undefined);
  return out;
}
