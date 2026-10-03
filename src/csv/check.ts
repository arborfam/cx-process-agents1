/**
 * Перевірка CSV-таблиці проти КОНКРЕТНОГО погодженого опису AS-IS (D87).
 *
 * Це межа між моделлю й продуктом: таблицю складає агент 2, але жоден її рядок не потрапляє у скрипти,
 * доки програма не впевнилась, що таблиця описує САМЕ погоджений процес. Модель не може спростити процес,
 * «домалювати» крок, прибрати гілку чи змінити роль, щоб таблиця пройшла перевірку: будь-яка розбіжність —
 * помилка з назвою кроку, а не мовчазне виправлення.
 *
 * Програма таблицю НЕ складає (прихованого запасного генератора немає — `tests/no-csv-generator.test.ts`).
 * Тут лише перевірка й розбір уже готової таблиці.
 */
import { UNKNOWN, type Content, type Step } from '../schema.ts';
import { ID, MAX_STEP_ID, STEP_ID_RE } from '../bpmn/ids.ts';
import { TO_DEFINE_RE, textProblem } from '../bpmn/text.ts';
import type { ApprovedPackage } from '../bpmn/types.ts';
import { CSV_HEADER, parseCsv, type CsvIssue, type CsvRow } from './parse.ts';

/** Дозволені типи рядків у v1. Решта словника таблиці (timer, msg, and, sub, data, db…) — нотація,
 *  якої цей шлях не будує: вона має проходити через явні вимоги до нотації (D61), а не через таблицю. */
export const ALLOWED_TYPES = ['start', 'end', 'task', 'xor'] as const;
export type CsvType = (typeof ALLOWED_TYPES)[number];

/**
 * ID рядків таблиці — це ВОДНОЧАС ID елементів схеми (скрипт `table_to_bpmn.py` робочої копії бере ID як є,
 * якщо він припустимий як XML-ID). Тому вони збігаються з контрактом ID (`src/bpmn/ids.ts`): крок S4 — це
 * `Task_S4` і в таблиці, і в `.bpmn`, і в `.drawio`. Завдяки цьому карта «крок ↔ елемент» не вигадується,
 * а читається з самого файлу, а зворотна звірка працює поелементно.
 */
export const START_ID: string = ID.start;
export const taskId = (stepId: string): string => ID.task(stepId);
export const gatewayId = (stepId: string): string => ID.gateway(stepId);
export const endId = (stepId: string, k: number): string => ID.end(stepId, k);
/**
 * Роздільник гілок у колонці next. Символ «>» у тексті умови ДОЗВОЛЕНИЙ («сума > 1000 грн»): ціль відділяється
 * ОСТАННІМ «>» у гілці — так само робить скрипт `table_to_bpmn.py` (`rsplit('>', 1)`). А от «|» у тексті умови
 * неможливий: за ним розділяються самі гілки, і жодного способу це розрізнити формат не має.
 */
export const BRANCH_SEPARATORS = ['|'] as const;

export interface CsvEdge { from: string; to: string; condition: string }

export interface CsvPlan {
  rows: CsvRow[];
  byId: Map<string, CsvRow>;
  /** Рядок задачі для кожного кроку AS-IS. */
  stepRow: Map<string, CsvRow>;
  /** Переходи, як вони записані в таблиці (після згортання рядків-шлюзів). */
  edges: CsvEdge[];
  /** Ролі, що справді мають дії (саме для них будуть доріжки). */
  lanes: string[];
  startLabel: string;
  /** Повний текст тригера — зберігається в деталях події, навіть якщо підпис коротший. */
  startDocumentation: string | null;
  poolName: string;
}

export type CsvCheck =
  | { ok: true; plan: CsvPlan; warnings: string[] }
  | { ok: false; issues: CsvIssue[] };

const clip = (t: string, n = 60): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** Очікувані переходи погодженого опису: те саме правило, що й у зворотній звірці файлів. */
export function expectedEdges(c: Content): CsvEdge[] {
  return c.steps.flatMap((s) => s.next.map((n, i) => ({
    from: taskId(s.id),
    to: n.to === 'END' ? endId(s.id, i + 1) : taskId(n.to),
    condition: s.next.length >= 2 ? n.condition : '',
  })));
}

const edgeKey = (e: CsvEdge): string => JSON.stringify([e.from, e.to, e.condition]);

export interface CheckOptions {
  /** Підпис початкової події: погоджений короткий підпис або тригер процесу. Задає програма, не модель. */
  startLabel: string;
  /** Повний текст тригера, якщо підпис короткий (зберігається в деталях події). */
  startDocumentation?: string | null;
}

export function checkCsv(text: string, pkg: ApprovedPackage, opts: CheckOptions): CsvCheck {
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const rows = parsed.rows;
  const issues: CsvIssue[] = [];
  const warnings: string[] = [];
  const bad = (code: string, message: string, refs: string[] = []): void => { issues.push({ code, message, refs }); };
  const c = pkg.content;
  const steps = new Map<string, Step>(c.steps.map((s) => [s.id, s]));

  // ── 1. ID рядків ──
  const byId = new Map<string, CsvRow>();
  for (const r of rows) {
    const id = r.id.trim();
    if (id !== r.id) bad('CSV_ID_SPACES', `Рядок ${r.line}: ID «${clip(r.id)}» має пробіли на краях.`, [id]);
    if (id === '') { bad('CSV_ID_EMPTY', `Рядок ${r.line}: порожній ID.`); continue; }
    if (id.length > MAX_STEP_ID + 12 || !STEP_ID_RE.test(id)) {
      bad('CSV_BAD_ID', `Рядок ${r.line}: ID «${clip(id)}» не можна використати як ID елемента схеми (латинські літери, цифри, «_», «-», починати з літери).`, [id]);
      continue;
    }
    if (byId.has(id)) { bad('CSV_DUPLICATE_ID', `ID «${id}» зустрічається двічі (рядки ${byId.get(id)!.line} і ${r.line}).`, [id]); continue; }
    byId.set(id, r);
  }

  // ── 2. типи й текст ──
  for (const r of rows) {
    if (!(ALLOWED_TYPES as readonly string[]).includes(r.type.trim())) {
      bad('CSV_TYPE_NOT_ALLOWED', `Рядок ${r.line} («${clip(r.id)}»): тип «${clip(r.type)}» у цьому шляху не дозволений. Дозволені: ${ALLOWED_TYPES.join(', ')}. Інша нотація потребує явної вимоги до нотації в погодженому описі (D61), а не рядка в таблиці.`, [r.id.trim()]);
    }
    const p = textProblem(r.label);
    if (p) bad('CSV_BAD_TEXT', `Рядок ${r.line} («${clip(r.id)}»): підпис ${p}.`, [r.id.trim()]);
    if (TO_DEFINE_RE.test(r.label)) {
      bad('CSV_TO_DEFINE', `Рядок ${r.line} («${clip(r.id)}»): підпис містить «[TO DEFINE …]». Невизначене місце на схему не потрапляє — потрібне уточнення погодженого опису, а не позначка в таблиці.`, [r.id.trim()]);
    }
    if (r.assoc.trim() !== '') {
      bad('CSV_ASSOC_NOT_ALLOWED', `Рядок ${r.line} («${clip(r.id)}»): колонка assoc у цьому шляху не використовується (анотацій і об'єктів даних v1 не будує).`, [r.id.trim()]);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // ── 3. початкова подія ──
  const startRows = rows.filter((r) => r.type.trim() === 'start');
  if (startRows.length !== 1) {
    bad('CSV_START_COUNT', `Початкова подія має бути рівно одна (знайдено ${startRows.length}).`);
  } else {
    const s = startRows[0]!;
    if (s.id.trim() !== START_ID) bad('CSV_START_ID', `Початкова подія має ID «${START_ID}», а не «${clip(s.id)}».`, [s.id.trim()]);
    if (s.label !== opts.startLabel) {
      bad('CSV_START_LABEL', `Підпис початкової події не збігається з погодженим: очікується «${clip(opts.startLabel, 80)}», у таблиці «${clip(s.label, 80)}». Підпис задає погоджений опис (або погоджений короткий підпис), а не модель.`, [START_ID]);
    }
    if (s.role.trim() !== '') bad('CSV_EVENT_ROLE', `Початкова подія: колонка role має бути порожня (доріжка успадковується від першого кроку).`, [START_ID]);
    const entry = c.entry_step_id ? taskId(c.entry_step_id) : '';
    if (s.next.trim() !== entry) {
      bad('CSV_START_NEXT', `Початкова подія веде до «${clip(s.next)}», а початковий крок погодженого опису — «${clip(entry)}».`, [START_ID]);
    }
    if (s.yes.trim() !== '' || s.no.trim() !== '') bad('CSV_START_BRANCH', 'Початкова подія не має гілок yes/no.', [START_ID]);
  }

  // ── 4. рядки кроків ──
  const stepRow = new Map<string, CsvRow>();
  for (const s of c.steps) {
    const r = byId.get(taskId(s.id));
    if (!r) { bad('CSV_STEP_MISSING', `Крок ${s.id} («${clip(s.action)}») погодженого опису відсутній у таблиці (очікується рядок «${taskId(s.id)}»).`, [s.id]); continue; }
    if (r.type.trim() !== 'task') bad('CSV_STEP_TYPE', `Крок ${s.id}: у таблиці тип «${clip(r.type)}», очікується «task».`, [s.id]);
    if (r.label !== s.action) {
      bad('CSV_STEP_LABEL', `Крок ${s.id}: підпис у таблиці «${clip(r.label, 80)}» не збігається з дією погодженого опису «${clip(s.action, 80)}». Текст переноситься дослівно.`, [s.id]);
    }
    if (r.role !== s.role) {
      bad('CSV_STEP_ROLE', `Крок ${s.id}: роль у таблиці «${clip(r.role)}» не збігається з роллю погодженого опису «${clip(s.role)}».`, [s.id]);
    }
    stepRow.set(s.id, r);
  }

  // ── 5. переходи кроків і рядки-шлюзи ──
  const expectedGateways = new Set<string>();
  const expectedEnds = new Set<string>();
  for (const s of c.steps) {
    const r = stepRow.get(s.id);
    if (!r) continue;
    for (const n of s.next) if (n.to === UNKNOWN) bad('CSV_UNKNOWN_TARGET', `Крок ${s.id}: у погодженому описі є перехід «невідомо» — схема не будується.`, [s.id]);
    s.next.forEach((n, i) => { if (n.to === 'END') expectedEnds.add(endId(s.id, i + 1)); });
    if (r.yes.trim() !== '' || r.no.trim() !== '') {
      bad('CSV_STEP_YESNO', `Крок ${s.id}: гілки записуються підписаними у рядку-шлюзі, колонки yes/no для задач не використовуються.`, [s.id]);
    }
    if (s.next.length === 1) {
      const want = s.next[0]!.to === 'END' ? endId(s.id, 1) : taskId(s.next[0]!.to);
      if (r.next.trim() !== want) bad('CSV_STEP_NEXT', `Крок ${s.id}: next = «${clip(r.next)}», очікується «${want}».`, [s.id]);
    } else if (s.next.length >= 2) {
      const g = gatewayId(s.id);
      expectedGateways.add(g);
      if (r.next.trim() !== g) bad('CSV_STEP_NEXT', `Крок ${s.id}: має ${s.next.length} переходи, тому next має вести на рядок-шлюз «${g}», а не «${clip(r.next)}».`, [s.id]);
      const gr = byId.get(g);
      if (!gr) { bad('CSV_GATEWAY_MISSING', `Для кроку ${s.id} бракує рядка-шлюзу «${g}».`, [s.id]); continue; }
      if (gr.type.trim() !== 'xor') bad('CSV_GATEWAY_TYPE', `Рядок «${g}»: тип «${clip(gr.type)}», очікується «xor».`, [s.id]);
      if (gr.label.trim() !== '') bad('CSV_GATEWAY_LABEL', `Рядок-шлюз «${g}» має бути без підпису: умови стоять на гілках.`, [s.id]);
      if (gr.role.trim() !== '') bad('CSV_EVENT_ROLE', `Рядок-шлюз «${g}»: колонка role має бути порожня (доріжка успадковується від кроку).`, [s.id]);
      if (gr.yes.trim() !== '' || gr.no.trim() !== '') bad('CSV_GATEWAY_YESNO', `Рядок-шлюз «${g}»: усі гілки записуються підписаними в next, колонки yes/no не використовуються.`, [s.id]);
      const want = s.next.map((n, i) => `${n.condition}>${n.to === 'END' ? endId(s.id, i + 1) : taskId(n.to)}`).join('|');
      for (const n of s.next) {
        for (const sep of BRANCH_SEPARATORS) {
          if (n.condition.includes(sep)) {
            bad('CSV_CONDITION_SEPARATOR', `Крок ${s.id}: умова «${clip(n.condition)}» містить символ «${sep}», яким у таблиці розділяються гілки. Схему з такою умовою побудувати не можна — потрібно змінити текст умови в описі й погодити нову версію.`, [s.id]);
          }
        }
      }
      if (gr.next !== want) {
        bad('CSV_GATEWAY_BRANCHES', `Рядок-шлюз «${g}»: гілки «${clip(gr.next, 120)}» не збігаються з переходами кроку ${s.id} погодженого опису «${clip(want, 120)}».`, [s.id]);
      }
    }
  }

  // ── 6. кінцеві події ──
  for (const id of expectedEnds) {
    const r = byId.get(id);
    if (!r) { bad('CSV_END_MISSING', `Бракує рядка кінцевої події «${id}».`, [id]); continue; }
    if (r.type.trim() !== 'end') bad('CSV_END_TYPE', `Рядок «${id}»: тип «${clip(r.type)}», очікується «end».`, [id]);
    if (r.label.trim() !== '') bad('CSV_END_LABEL', `Кінцева подія «${id}» має бути без підпису: у погодженому описі назв завершень немає.`, [id]);
    if (r.role.trim() !== '') bad('CSV_EVENT_ROLE', `Кінцева подія «${id}»: колонка role має бути порожня.`, [id]);
    if (`${r.next}${r.yes}${r.no}`.trim() !== '') bad('CSV_END_NEXT', `Кінцева подія «${id}» не має переходів.`, [id]);
  }

  // ── 7. зайві рядки ──
  const allowed = new Set<string>([START_ID, ...[...steps.keys()].map(taskId), ...expectedGateways, ...expectedEnds]);
  for (const r of rows) {
    const id = r.id.trim();
    if (!allowed.has(id)) {
      bad('CSV_EXTRA_ROW', `Рядок ${r.line}: «${clip(id)}» (${clip(r.type)}) у погодженому описі не має відповідника. Додавати елементи, яких немає в описі, не можна.`, [id]);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // ── 8. посилання, досяжність і звірка переходів ──
  const edges: CsvEdge[] = [];
  const refTargets: string[] = [];
  for (const r of rows) {
    const id = r.id.trim();
    const type = r.type.trim();
    const collect = (raw: string, cond: string): void => {
      for (const t of raw.split('|').map((x) => x.trim()).filter(Boolean)) {
        refTargets.push(t);
        if (type === 'xor') continue; // гілки шлюзу згортаються нижче
        edges.push({ from: id, to: t, condition: cond });
      }
    };
    if (type === 'xor') {
      for (const br of r.next.split('|').map((x) => x.trim()).filter(Boolean)) {
        const k = br.lastIndexOf('>');
        if (k < 0) { bad('CSV_BRANCH_FORMAT', `Рядок-шлюз «${id}»: гілка «${clip(br)}» без «умова>ціль».`, [id]); continue; }
        const target = br.slice(k + 1).trim();
        refTargets.push(target);
        edges.push({ from: id, to: target, condition: br.slice(0, k).trim() });
      }
    } else {
      collect(r.next, '');
      collect(r.yes, 'Так');
      collect(r.no, 'Ні');
    }
  }
  for (const t of new Set(refTargets)) {
    if (!byId.has(t)) bad('CSV_BAD_REFERENCE', `Посилання на неіснуючий рядок «${clip(t)}».`, [t]);
  }
  if (issues.length > 0) return { ok: false, issues };

  // досяжність від початкової події
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>([START_ID]);
  const queue = [START_ID];
  while (queue.length) {
    const x = queue.shift()!;
    for (const t of out.get(x) ?? []) if (!seen.has(t)) { seen.add(t); queue.push(t); }
  }
  for (const r of rows) {
    const id = r.id.trim();
    if (!seen.has(id)) bad('CSV_UNREACHABLE', `Рядок «${id}» недосяжний від початкової події.`, [id]);
    if (r.type.trim() !== 'end' && (out.get(id) ?? []).length === 0) bad('CSV_DEAD_END', `Рядок «${id}» нікуди не веде.`, [id]);
  }

  // згортання шлюзів: крок → крок/кінець, з умовою — і порівняння з погодженим описом
  const collapsed: CsvEdge[] = [];
  for (const e of edges) {
    if (e.from === START_ID) continue;
    // Виходи самого шлюзу враховуються при згортанні переходу «крок → шлюз», а не окремо.
    if (byId.get(e.from)?.type.trim() === 'xor') continue;
    const target = byId.get(e.to);
    if (target?.type.trim() === 'xor') {
      for (const g of edges.filter((x) => x.from === e.to)) collapsed.push({ from: e.from, to: g.to, condition: g.condition });
    } else {
      collapsed.push(e);
    }
  }
  const exp = expectedEdges(c);
  const count = (list: CsvEdge[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of list) m.set(edgeKey(e), (m.get(edgeKey(e)) ?? 0) + 1);
    return m;
  };
  const got = count(collapsed), want = count(exp);
  for (const [k, n] of want) {
    if ((got.get(k) ?? 0) < n) {
      const e = JSON.parse(k) as [string, string, string];
      bad('CSV_EDGE_MISSING', `У таблиці немає переходу кроку ${e[0]} → ${e[1]}${e[2] ? ` за умовою «${clip(e[2])}»` : ''}, який є в погодженому описі.`, [e[0]]);
    }
  }
  for (const [k, n] of got) {
    if ((want.get(k) ?? 0) < n) {
      const e = JSON.parse(k) as [string, string, string];
      bad('CSV_EDGE_EXTRA', `У таблиці є перехід кроку ${e[0]} → ${e[1]}${e[2] ? ` за умовою «${clip(e[2])}»` : ''}, якого немає в погодженому описі.`, [e[0]]);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // ── 9. доріжки: лише ролі, що мають дії (склад ролей погодженого опису не змінюється) ──
  const lanes = c.roles.filter((r) => c.steps.some((s) => s.role === r));
  for (const r of c.roles) {
    if (!lanes.includes(r)) warnings.push(`Роль «${clip(r)}» не має жодного кроку — доріжки для неї на схемі не буде (у погодженому описі роль лишається).`);
  }

  return {
    ok: true,
    warnings,
    plan: {
      rows, byId, stepRow, edges: collapsed, lanes,
      startLabel: opts.startLabel,
      startDocumentation: opts.startDocumentation ?? null,
      poolName: c.process_name ?? '',
    },
  };
}
