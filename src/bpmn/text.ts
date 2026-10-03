/**
 * Допустимість і розмір тексту підписів.
 * Підписи (дії, ролі, умови) переносяться дослівно — тому недопустимий текст відхиляється, а не «виправляється».
 */
import { isXmlChar } from './xml.ts';

/**
 * Межі довжини підпису. Вони РІЗНІ, бо різні місця схеми мають різні можливості показати текст (D86):
 *  • `MAX_LABEL_CHARS` — підписи, які живуть усередині фігури або заголовка: дія задачі, назва ролі (доріжка),
 *    назва процесу (пул), умова переходу. Там висота обмежена самою фігурою чи заголовком;
 *  • `MAX_EVENT_LABEL_CHARS` — ЗОВНІШНІЙ підпис початкової/кінцевої події (тригер процесу). Він стоїть під
 *    подією окремою рамкою, яку генератор розширює під текст: переноси за словами, рамка рахується з реальної
 *    ширини тексту, доріжка збільшується, щоб підпис не наклався. Тому межа тут вища — і вона підтверджена
 *    фактичним виглядом (`tests/bpmn-long-label.test.ts`, знімок у переглядачі), а не просто піднятою константою.
 */
export const MAX_LABEL_CHARS = 600;
/**
 * Межа ЗОВНІШНЬОГО підпису події (тригер процесу). Вона НИЖЧА за межу підписів усередині фігур навмисно:
 * зовнішній підпис стоїть окремою рамкою поряд зі схемою, і довгий текст там або розповзається вшир,
 * або стає стовпчиком, який зменшує масштаб усієї схеми (так і сталося на тригері 715 символів).
 * Довший тригер не скорочується мовчки: потрібен ПОГОДЖЕНИЙ людиною короткий підпис (D88), а повний
 * текст лишається в описі, у деталях події обох файлів і поряд зі схемою в переглядачі.
 */
export const MAX_EVENT_LABEL_CHARS = 240;

/**
 * Чому текст не можна записати у схему дослівно (або null, якщо можна).
 * Перенос рядка (\n) дозволений: у .bpmn він зберігається символьним посиланням.
 * Табуляція й повернення каретки відхиляються: лейаутер записує їх «сирими», а XML-розбір замінює їх пробілом.
 */
export function textProblem(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x9) return 'містить символ табуляції (його не можна зберегти в схемі дослівно)';
    if (cp === 0xd) return 'містить символ повернення каретки (його не можна зберегти в схемі дослівно)';
    if (cp === 0xa) continue;
    if (!isXmlChar(cp) || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      return `містить керівний символ U+${cp.toString(16).toUpperCase().padStart(4, '0')}, який не можна записати в XML`;
    }
  }
  // самотні сурогати (ламаний Unicode) `for…of` віддає як окремий символ — їх isXmlChar уже відхилив
  return null;
}

export const TO_DEFINE_RE = /\[\s*TO\s+DEFINE/i;

// ───────────────────────── оцінка розміру тексту (консервативна) ─────────────────────────

const FONT_PX = 12;
const NARROW_PUNCT: readonly string[] = [...'.,:;!\'|()[]{}«»"`ʼ’‘“”-–—/\\'];
const WIDE_LOWER: readonly string[] = [...'шщюыжфмwmШ'];
const WIDE_UPPER: readonly string[] = [...'ШЩЮЖФМЫWM'];

/**
 * Орієнтовна ширина символу (px) для шрифту 12px. Калібровано вимірюванням у Chromium: для Arial/Liberation Sans оцінка
 * завищена приблизно на 15 %, для запасного DejaVu Sans (Linux без Arial) — збігається. Запас навмисний:
 * підпис, що вміщується за цією оцінкою, вміститься в будь-якому з цих шрифтів.
 */
export function charWidth(ch: string): number {
  if (ch === ' ') return 3.6;
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x2e80 || (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf)) return FONT_PX * 1.05;
  if (/[0-9]/.test(ch)) return 7.6;
  if (WIDE_UPPER.includes(ch)) return 12;
  if (WIDE_LOWER.includes(ch)) return 10.4;
  if (NARROW_PUNCT.includes(ch)) return 4;
  if (ch !== ch.toLowerCase() && ch === ch.toUpperCase() && /\p{L}/u.test(ch)) return 9.2;
  return 7.2;
}

export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Жадібний перенос за словами; надто довге слово розбивається за символами. */
export function wrapLines(text: string, widthPx: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let cur = '';
    let curW = 0;
    const push = (): void => { lines.push(cur); cur = ''; curW = 0; };
    if (words.length === 0) { lines.push(''); continue; }
    for (const word of words) {
      const ww = textWidth(word);
      const sep = cur ? charWidth(' ') : 0;
      if (cur && curW + sep + ww <= widthPx) { cur += ' ' + word; curW += sep + ww; continue; }
      if (cur) push();
      if (ww <= widthPx) { cur = word; curW = ww; continue; }
      for (const ch of word) {
        const cw = charWidth(ch);
        if (curW + cw > widthPx && cur) push();
        cur += ch;
        curW += cw;
      }
    }
    if (cur) push();
  }
  return lines;
}

export const LINE_HEIGHT = 14.4;

export interface TaskBox { width: number; height: number }

/** Висота, потрібна тексту всередині блоку заданої ширини (поля 10px з боків, 8px згори й знизу). */
export function neededTaskHeight(text: string, boxWidth: number): number {
  const lines = wrapLines(text, Math.max(20, boxWidth - 20)).length;
  return Math.ceil(lines * LINE_HEIGHT + 16);
}

/** Відношення справжньої ширини тексту в Arial до нашої оцінки (виміряно 0,82–0,86). Для м'якої перевірки зовнішніх підписів. */
export const ARIAL_FACTOR = 0.86;


// ───────────────────────── рамка зовнішнього підпису події ─────────────────────────

/** Поля всередині рамки підпису (px) і відступ від самої події. */
export const EVENT_LABEL_PAD = 4;
export const EVENT_LABEL_GAP = 6;
/** Ширини рамки підпису події: від звичайної вузької колонки до широкої для довгого тригера. */
const EVENT_LABEL_WIDTHS = [140, 180, 220, 260, 300];

/**
 * Рамка зовнішнього підпису події під текст: обирається найвужча ширина, за якої підпис не стає «стовпчиком»
 * (більше ніж `maxLines` рядків), і висота рахується з реального переносу. Якщо навіть найширша колонка не
 * прибирає висоту — беремо її й віддаємо потрібну висоту: текст НЕ обрізається, рамка просто вища.
 * `availableWidth` обмежує ширину місцем, яке є на схемі (щоб підпис не наліз на сусідній блок).
 */
export function eventLabelBox(text: string, availableWidth = Infinity, maxLines = 6): { w: number; h: number } {
  const widths = EVENT_LABEL_WIDTHS.filter((w) => w <= availableWidth);
  const usable = widths.length ? widths : [Math.max(60, Math.min(EVENT_LABEL_WIDTHS[0]!, Math.floor(availableWidth)))];
  const heightFor = (w: number): number => wrapLines(text, Math.max(20, w - 2 * EVENT_LABEL_PAD)).length * LINE_HEIGHT + 2 * EVENT_LABEL_PAD;
  for (const w of usable) {
    const h = heightFor(w);
    if (h <= maxLines * LINE_HEIGHT + 2 * EVENT_LABEL_PAD) return { w, h: Math.ceil(h) };
  }
  const w = usable[usable.length - 1]!;
  return { w, h: Math.ceil(heightFor(w)) };
}
