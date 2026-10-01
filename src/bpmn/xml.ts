/**
 * Строгий XML-розбір і серіалізація для перевірки схем (зріз 3a).
 *
 * Навіщо власний розбір: лейаутер і конвертер оригінального ланцюга читають зіпсований XML
 * «поблажливо» й мовчки гублять назви (docs/bpmn-pipeline-assessment.md). Тут будь-яка
 * невідповідність стандарту XML 1.0 — помилка, а не мовчазна «поправка».
 *
 * Підтримується лише потрібна підмножина: елементи, атрибути, текст, коментарі, CDATA,
 * простори імен. DOCTYPE, власні сутності й інструкції обробки (крім XML-декларації) заборонені.
 */

export class XmlError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = 'XmlError';
  }
}

export interface XmlAttr {
  /** Повне ім'я, як у файлі (з префіксом). */
  name: string;
  value: string;
  /** Простір імен атрибута (порожньо для атрибутів без префікса). */
  ns: string;
  local: string;
}

export interface XmlElement {
  /** Повне ім'я, як у файлі. */
  name: string;
  ns: string;
  local: string;
  attrs: XmlAttr[];
  children: (XmlElement | string)[];
  parent: XmlElement | null;
}

export const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const NAME_RE = /^[\p{L}_][\p{L}\p{N}_.-]*(?::[\p{L}_][\p{L}\p{N}_.-]*)?$/u;

/** Чи дозволений символ у XML 1.0 (Char). Без табуляції/переносу в атрибутах це перевіряється окремо. */
export function isXmlChar(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);
}

export function parseXml(source: string): XmlElement {
  if (source.length > MAX_BYTES) throw new XmlError('Файл завеликий для перевірки.', 0);
  let pos = 0;
  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const n = src.length;

  const fail = (msg: string, at = pos): never => { throw new XmlError(`${msg} (позиція ${at})`, at); };

  // усі символи мають бути дозволеними
  for (let i = 0; i < n;) {
    const cp = src.codePointAt(i)!;
    if (!isXmlChar(cp)) fail(`Недозволений символ U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, i);
    i += cp > 0xffff ? 2 : 1;
  }

  const skipWs = (): void => { while (pos < n && /[ \t\r\n]/.test(src[pos]!)) pos++; };

  const decodeEntities = (raw: string, at: number): string => {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch !== '&') {
        out += ch;
        continue;
      }
      const semi = raw.indexOf(';', i);
      if (semi < 0) fail('Символ «&» без «;» — не закрита сутність', at + i);
      const ent = raw.slice(i + 1, semi);
      if (ent === 'amp') out += '&';
      else if (ent === 'lt') out += '<';
      else if (ent === 'gt') out += '>';
      else if (ent === 'quot') out += '"';
      else if (ent === 'apos') out += "'";
      else if (/^#[0-9]+$/.test(ent) || /^#x[0-9a-fA-F]+$/.test(ent)) {
        const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!isXmlChar(cp)) fail(`Числова сутність &${ent}; вказує на недозволений символ`, at + i);
        // посилання на символ у значенні атрибута НЕ нормалізується (на відміну від «сирих» \t \n \r)
        out += String.fromCodePoint(cp);
      } else fail(`Невідома сутність &${ent};`, at + i);
      i = semi;
    }
    return out;
  };

  /** Нормалізація «сирих» пробільних символів у значенні атрибута (XML 1.0 §3.3.3) — виконується ДО розкриття сутностей. */
  const normalizeAttrRaw = (raw: string): string => raw.replace(/\r\n/g, '\n').replace(/[\t\r\n]/g, ' ');

  // XML-декларація (лише на самому початку)
  if (src.startsWith('<?xml')) {
    const end = src.indexOf('?>');
    if (end < 0) fail('Не закрита XML-декларація', 0);
    const decl = src.slice(0, end + 2);
    if (!/^<\?xml\s+version\s*=\s*["']1\.0["'](\s+encoding\s*=\s*["'][A-Za-z0-9._-]+["'])?(\s+standalone\s*=\s*["'](yes|no)["'])?\s*\?>$/.test(decl)) {
      fail('Некоректна XML-декларація', 0);
    }
    pos = end + 2;
  }

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const nsStack: Map<string, string>[] = [new Map([['xml', XML_NS]])];

  const resolve = (qname: string, isAttr: boolean): { ns: string; local: string } => {
    const idx = qname.indexOf(':');
    if (idx < 0) {
      if (isAttr) return { ns: '', local: qname };
      return { ns: nsStack[nsStack.length - 1]!.get('') ?? '', local: qname };
    }
    const prefix = qname.slice(0, idx);
    const uri = nsStack[nsStack.length - 1]!.get(prefix);
    if (uri === undefined) fail(`Префікс простору імен «${prefix}» не оголошено`);
    return { ns: uri!, local: qname.slice(idx + 1) };
  };

  const addText = (text: string): void => {
    if (text === '') return;
    const top = stack[stack.length - 1];
    if (!top) {
      if (text.trim() !== '') fail('Текст поза кореневим елементом');
      return;
    }
    const last = top.children[top.children.length - 1];
    if (typeof last === 'string') top.children[top.children.length - 1] = last + text;
    else top.children.push(text);
  };

  while (pos < n) {
    if (src[pos] !== '<') {
      const next = src.indexOf('<', pos);
      const end = next < 0 ? n : next;
      const raw = src.slice(pos, end);
      if (raw.includes(']]>')) fail('Послідовність «]]>» у тексті заборонена');
      addText(decodeEntities(raw.replace(/\r\n?/g, '\n'), pos));
      pos = end;
      continue;
    }
    if (src.startsWith('<!--', pos)) {
      const end = src.indexOf('-->', pos + 4);
      if (end < 0) fail('Не закритий коментар');
      if (src.slice(pos + 4, end).includes('--')) fail('Послідовність «--» усередині коментаря заборонена');
      pos = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', pos)) {
      const end = src.indexOf(']]>', pos + 9);
      if (end < 0) fail('Не закритий CDATA');
      if (!stack.length) fail('CDATA поза кореневим елементом');
      addText(src.slice(pos + 9, end).replace(/\r\n?/g, '\n'));
      pos = end + 3;
      continue;
    }
    if (src.startsWith('<!', pos)) fail('DOCTYPE та оголошення заборонені');
    if (src.startsWith('<?', pos)) fail('Інструкції обробки заборонені');
    if (src.startsWith('</', pos)) {
      const end = src.indexOf('>', pos);
      if (end < 0) fail('Не закритий кінцевий тег');
      const name = src.slice(pos + 2, end).trim();
      const top = stack.pop();
      if (!top) fail(`Зайвий кінцевий тег </${name}>`);
      if (top!.name !== name) fail(`Кінцевий тег </${name}> не відповідає початковому <${top!.name}>`);
      nsStack.pop();
      pos = end + 1;
      continue;
    }
    // початковий тег
    const tagStart = pos;
    pos++;
    const nameMatch = /^[^\s/>=<"']+/.exec(src.slice(pos, pos + 300));
    if (!nameMatch) fail('Порожнє ім’я елемента');
    const qname = nameMatch![0];
    if (!NAME_RE.test(qname)) fail(`Некоректне ім’я елемента «${qname}»`);
    pos += qname.length;
    const rawAttrs: { name: string; value: string }[] = [];
    let selfClose = false;
    for (;;) {
      const before = pos;
      skipWs();
      if (pos >= n) fail('Не закритий початковий тег', tagStart);
      if (src[pos] === '>') { pos++; break; }
      if (src.startsWith('/>', pos)) { pos += 2; selfClose = true; break; }
      if (pos === before) fail('Між атрибутами потрібен пробіл');
      const am = /^[^\s/>=<"']+/.exec(src.slice(pos, pos + 300));
      if (!am) fail('Очікувалось ім’я атрибута');
      const aname = am![0];
      if (!NAME_RE.test(aname)) fail(`Некоректне ім’я атрибута «${aname}»`);
      pos += aname.length;
      skipWs();
      if (src[pos] !== '=') fail(`Атрибут «${aname}» без значення`);
      pos++;
      skipWs();
      const quote = src[pos];
      if (quote !== '"' && quote !== "'") fail(`Значення атрибута «${aname}» має бути в лапках`);
      const close = src.indexOf(quote!, pos + 1);
      if (close < 0) fail(`Не закрите значення атрибута «${aname}»`);
      const rawValue = src.slice(pos + 1, close);
      if (rawValue.includes('<')) fail(`Символ «<» у значенні атрибута «${aname}» заборонений`);
      if (rawAttrs.some((a) => a.name === aname)) fail(`Атрибут «${aname}» повторюється`);
      rawAttrs.push({ name: aname, value: decodeEntities(normalizeAttrRaw(rawValue), pos + 1) });
      pos = close + 1;
    }

    // простори імен: спершу оголошення
    const scope = new Map(nsStack[nsStack.length - 1]!);
    for (const a of rawAttrs) {
      if (a.name === 'xmlns') scope.set('', a.value);
      else if (a.name.startsWith('xmlns:')) scope.set(a.name.slice(6), a.value);
    }
    nsStack.push(scope);
    const { ns, local } = resolve(qname, false);
    const attrs: XmlAttr[] = rawAttrs.map((a) => {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        return { name: a.name, value: a.value, ns: XMLNS, local: a.name === 'xmlns' ? 'xmlns' : a.name.slice(6) };
      }
      const r = resolve(a.name, true);
      return { name: a.name, value: a.value, ns: r.ns, local: r.local };
    });
    // дублікати за розкритим іменем (різні префікси → той самий простір імен)
    const seen = new Set<string>();
    for (const a of attrs) {
      const key = `${a.ns}|${a.local}`;
      if (seen.has(key)) fail(`Атрибут «${a.name}» повторюється (той самий простір імен)`);
      seen.add(key);
    }
    const el: XmlElement = { name: qname, ns, local, attrs, children: [], parent: stack[stack.length - 1] ?? null };
    if (stack.length === 0) {
      if (root) fail('Другий кореневий елемент');
      root = el;
    } else {
      stack[stack.length - 1]!.children.push(el);
    }
    if (selfClose) nsStack.pop();
    else {
      stack.push(el);
      if (stack.length > MAX_DEPTH) fail('Забагато рівнів вкладеності');
    }
  }
  if (stack.length) fail(`Не закритий елемент <${stack[stack.length - 1]!.name}>`, n);
  if (!root) fail('Немає кореневого елемента', 0);
  return root!;
}

// ───────────────────────── допоміжне для читачів ─────────────────────────

export function attr(el: XmlElement, local: string, ns = ''): string | undefined {
  return el.attrs.find((a) => a.local === local && a.ns === ns)?.value;
}

export function elementChildren(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string');
}

export function childText(el: XmlElement): string {
  return el.children.filter((c): c is string => typeof c === 'string').join('');
}

export function walk(el: XmlElement, fn: (e: XmlElement) => void): void {
  fn(el);
  for (const c of elementChildren(el)) walk(c, fn);
}

// ───────────────────────── екранування й серіалізація ─────────────────────────

/** Екранування значення атрибута: усі керівні пробіли — як символьні посилання, щоб розбір їх не «нормалізував». */
export function escapeAttr(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case '\n': out += '&#10;'; break;
      case '\r': out += '&#13;'; break;
      case '\t': out += '&#9;'; break;
      default: out += ch;
    }
  }
  return out;
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function serialize(el: XmlElement, indent = 0, withDecl = true): string {
  const out: string[] = [];
  if (withDecl) out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  const write = (e: XmlElement, depth: number): void => {
    const pad = '  '.repeat(depth);
    const attrs = e.attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
    const kids = e.children;
    if (kids.length === 0) {
      out.push(`${pad}<${e.name}${attrs} />\n`);
      return;
    }
    const onlyText = kids.every((k) => typeof k === 'string');
    if (onlyText) {
      out.push(`${pad}<${e.name}${attrs}>${escapeText(kids.join(''))}</${e.name}>\n`);
      return;
    }
    out.push(`${pad}<${e.name}${attrs}>\n`);
    for (const k of kids) {
      if (typeof k === 'string') {
        if (k.trim() !== '') out.push(`${pad}  ${escapeText(k.trim())}\n`);
      } else write(k, depth + 1);
    }
    out.push(`${pad}</${e.name}>\n`);
  };
  write(el, indent);
  return out.join('');
}
