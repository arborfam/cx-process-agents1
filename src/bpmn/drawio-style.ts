/**
 * Еталонні стилі клітинок `.drawio` і сувора перевірка стилю.
 *
 * Навіщо: стиль визначає, ЧИ ВИДНО елемент і ЯК він виглядає (прозорість, колір тексту, наконечник стрілки, розмір шрифту…).
 * Зміст і геометрія можуть бути правильними, а зображення — вже ні (приклад: `opacity=0;textOpacity=0` робить усі задачі
 * невидимими, `endArrow=none` прибирає напрямок стрілок). Тому перевіряється НЕ перелік заборонених рядків, а повна відповідність
 * стилю клітинки еталону: зайвий, відсутній чи змінений параметр — помилка. Параметри, що впливають на видимість і напрямок,
 * мають окремі коди з окремим поясненням.
 */
import type { Issue } from './types.ts';

export type CellKind = 'pool' | 'lane' | 'task' | 'startEvent' | 'endEvent' | 'exclusiveGateway' | 'edge';

export const POOL_STYLE = 'swimlane;html=0;childLayout=stackLayout;horizontal=0;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;collapsible=0;swimlaneFillColor=#ffffff;whiteSpace=wrap;fontStyle=0;fontSize=12;';
export const LANE_STYLE = 'swimlane;html=0;startSize=30;horizontal=0;collapsible=0;swimlaneLine=1;swimlaneFillColor=#ffffff;fillColor=none;whiteSpace=wrap;fontStyle=0;fontSize=12;';
export const EVENT_BASE = 'points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],[0.855,0.855,0],[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];shape=mxgraph.bpmn.event;html=0;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;fontSize=12;';
/**
 * Підпис події переноситься в колонку ШИРИНОЮ З РАМКИ ПІДПИСУ `.bpmn` (`labelWidth`, D86). Раніше ширину задавали
 * від'ємними відступами (`spacingLeft/-Right=-32`) — колонка завжди виходила ≈100 px, і довгий тригер ставав
 * вузьким стовпчиком на пів схеми. Тепер обидва формати показують підпис однаково, а звірка `.drawio` порівнює
 * `labelWidth` саме з рамкою в `.bpmn`: розбіжність — помилка експорту.
 */
export const START_STYLE = EVENT_BASE + 'whiteSpace=wrap;outline=standard;symbol=general;';
export const END_STYLE = EVENT_BASE + 'outline=end;symbol=general;';
export const GATEWAY_STYLE = 'points=[[0.25,0.25,0],[0.5,0,0],[0.75,0.25,0],[1,0.5,0],[0.75,0.75,0],[0.5,1,0],[0.25,0.75,0],[0,0.5,0]];shape=mxgraph.bpmn.gateway2;html=0;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=rhombusPerimeter;outlineConnect=0;outline=none;symbol=none;gwType=exclusive;fontSize=12;';
// нейтральна задача: маркер «abstract» (без іконки «людина», бо тип виконавця в AS-IS не заданий)
export const TASK_STYLE = 'shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=0;container=0;expand=0;collapsible=0;taskMarker=abstract;fontSize=12;';

/** Спільна частина стилю ліній; точки виходу і входу (exitX, exitY, entryX, entryY) додаються окремо й звіряються з геометрією .bpmn. */
export const EDGE_STYLE_FIXED = 'html=0;rounded=0;endArrow=blockThin;endFill=1;fontSize=11;labelBackgroundColor=#ffffff;exitDx=0;exitDy=0;exitPerimeter=0;entryDx=0;entryDy=0;entryPerimeter=0;';

/** Атрибути mxGraphModel еталонного експорту (будь-які інші, наприклад `background`, — відхилення). */
export const GRAPH_MODEL_ATTRS: Record<string, string> = {
  dx: '1000', dy: '700', grid: '1', gridSize: '10', guides: '1', tooltips: '1', connect: '1', arrows: '1', fold: '1', page: '0', pageScale: '1', math: '0', shadow: '0',
};

/**
 * Еталонний стиль клітинки. `labelWidth` (ширина рамки зовнішнього підпису події) додається лише там, де в
 * `.bpmn` справді є рамка підпису: він задає ширину колонки переносу в draw.io (D86).
 */
export function vertexStyleOf(kind: Exclude<CellKind, 'edge'>, opts: { labelWidth?: number } = {}): string {
  const label = opts.labelWidth !== undefined ? `labelWidth=${Math.round(opts.labelWidth)};` : '';
  switch (kind) {
    case 'pool': return POOL_STYLE;
    case 'lane': return LANE_STYLE;
    case 'task': return TASK_STYLE;
    case 'startEvent': return START_STYLE + label;
    case 'endEvent': return END_STYLE + label;
    case 'exclusiveGateway': return GATEWAY_STYLE;
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

// Параметри, що впливають на ВИДИМІСТЬ елемента чи тексту.
const VISIBILITY_KEYS: readonly string[] = [
  'opacity', 'textOpacity', 'fillOpacity', 'strokeOpacity', 'swimlaneFillColor', 'fillColor', 'strokeColor', 'fontColor', 'gradientColor',
  'noLabel', 'visible', 'strokeWidth', 'fontSize', 'fontFamily', 'fontStyle', 'labelBackgroundColor', 'labelBorderColor', 'labelPosition',
  'verticalLabelPosition', 'verticalAlign', 'align', 'labelWidth', 'overflow', 'whiteSpace', 'spacing', 'spacingLeft', 'spacingRight',
  'spacingTop', 'spacingBottom', 'rotation', 'flipH', 'flipV', 'shadow', 'glass', 'sketch', 'textDirection', 'imageAspect', 'aspect',
];
// Параметри, що впливають на ВИГЛЯД і НАПРЯМОК стрілки.
const ARROW_KEYS: readonly string[] = [
  'endArrow', 'startArrow', 'endFill', 'startFill', 'endSize', 'startSize', 'edgeStyle', 'curved', 'dashed', 'dashPattern', 'jumpStyle',
  'jumpSize', 'flowAnimation', 'sourcePerimeterSpacing', 'targetPerimeterSpacing', 'perimeterSpacing', 'rounded', 'arcSize', 'elbow', 'orthogonalLoop',
  'jettySize', 'noEdgeStyle', 'bendable', 'endWidth', 'startWidth', 'strokeColor', 'strokeWidth', 'opacity', 'strokeOpacity',
];

const arrowText = (k: string, got: string | undefined, want: string | undefined): string =>
  `параметр стилю «${k}» ${got === undefined ? 'відсутній' : `= «${got}»`} (очікується ${want === undefined ? 'відсутність параметра' : `«${want}»`}): це змінює вигляд чи напрямок стрілки`;
const hideText = (k: string, got: string | undefined, want: string | undefined): string =>
  `параметр стилю «${k}» ${got === undefined ? 'відсутній' : `= «${got}»`} (очікується ${want === undefined ? 'відсутність параметра' : `«${want}»`}): це може зробити елемент чи його текст невидимим, прозорим або нечитабельним`;

export interface StyleCheckInput {
  cellId: string;
  /** Дружня назва для повідомлень. */
  label: string;
  kind: CellKind;
  style: string;
  /** Для ліній: очікувані точки виходу/входу (частки 0…1) із геометрії .bpmn. */
  ports?: { exitX: number; exitY: number; entryX: number; entryY: number };
  /** Для подій із зовнішнім підписом: ширина рамки підпису з `.bpmn` (px). */
  labelWidth?: number;
}

/** Повна звірка стилю клітинки з еталоном. Повертає помилки (порожньо = стиль відповідає еталону). */
export function checkCellStyle(input: StyleCheckInput): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, message: string): void => { out.push({ code, severity: 'error', message: `Клітинка ${input.label}: ${message}.`, refs: [input.cellId] }); };
  const got = parseStyle(input.style);
  const baseStyle = input.kind === 'edge' ? EDGE_STYLE_FIXED : vertexStyleOf(input.kind, input.labelWidth !== undefined ? { labelWidth: input.labelWidth } : {});
  const want = parseStyle(baseStyle).map;
  for (const d of got.duplicates) err('DRAWIO_STYLE_MISMATCH', `параметр стилю «${d}» записано двічі (який діє — залежить від програми)`);
  const classify = (k: string, g: string | undefined, w: string | undefined): void => {
    if (input.kind === 'edge' && ARROW_KEYS.includes(k)) err('DRAWIO_ARROW_STYLE', arrowText(k, g, w));
    else if (VISIBILITY_KEYS.includes(k)) err('DRAWIO_STYLE_HIDDEN', hideText(k, g, w));
    else err('DRAWIO_STYLE_MISMATCH', `параметр стилю «${k}» ${g === undefined ? 'відсутній' : `= «${g}»`} (очікується ${w === undefined ? 'відсутність параметра' : `«${w}»`}): стиль відрізняється від еталонного`);
  };
  const ports: Record<string, number> = input.ports ?? {};
  const portKeys = ['exitX', 'exitY', 'entryX', 'entryY'];
  for (const [k, w] of want) {
    const g = got.map.get(k);
    if (g !== w) classify(k, g, w);
  }
  for (const [k, g] of got.map) {
    if (want.has(k)) continue;
    if (input.kind === 'edge' && portKeys.includes(k)) continue;
    classify(k, g, undefined);
  }
  if (input.kind === 'edge') {
    for (const k of portKeys) {
      const raw = got.map.get(k);
      const exp = ports[k];
      const v = raw === undefined ? NaN : Number(raw);
      if (exp === undefined) { if (raw !== undefined) err('DRAWIO_EDGE_PORT', `точку ${k} задано, хоча геометрії .bpmn для лінії немає`); continue; }
      if (!Number.isFinite(v) || Math.abs(v - exp) > 0.002) err('DRAWIO_EDGE_PORT', `точка ${k} = «${raw ?? '—'}», а за геометрією .bpmn має бути ${exp}: стрілка почнеться чи закінчиться не там, де в схемі`);
    }
  }
  return out;
}
