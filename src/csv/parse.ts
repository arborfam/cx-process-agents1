/**
 * Розбір CSV-таблиці процесу за RFC 4180 (кома-роздільник, поля в лапках, подвоєна лапка всередині).
 *
 * Навіщо власний розбір, а не split(','): у погодженому описі трапляються коми, лапки, переноси рядка
 * й кирилиця. Розбиття за комою зсунуло б колонки й «загубило» частину тексту мовчки. Тут натомість
 * або коректний розбір, або явна помилка з номером рядка.
 */

export const CSV_HEADER = ['id', 'label', 'type', 'role', 'next', 'yes', 'no', 'assoc'] as const;
export type CsvColumn = (typeof CSV_HEADER)[number];

export interface CsvRow extends Record<CsvColumn, string> {
  /** Номер рядка у файлі (1 — заголовок). Для повідомлень людині. */
  line: number;
}

export interface CsvIssue { code: string; message: string; refs: string[] }

export type ParseResult = { ok: true; rows: CsvRow[] } | { ok: false; issues: CsvIssue[] };

interface RawRow { fields: string[]; line: number }

/** Поділ тексту на рядки й поля за RFC 4180. Повертає null і причину, якщо лапки не закриті. */
function tokenize(text: string): { rows: RawRow[] } | { error: CsvIssue } {
  const rows: RawRow[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let startLine = 1;
  let inQuotes = false;
  let quotedField = false;
  let i = 0;
  const pushField = (): void => { fields.push(field); field = ''; quotedField = false; };
  const pushRow = (): void => { fields.push(field); rows.push({ fields, line: startLine }); fields = []; field = ''; quotedField = false; startLine = line; };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field !== '') {
        return { error: { code: 'CSV_QUOTE_IN_FIELD', refs: [], message: `Рядок ${line}: лапка всередині поля, яке не взято в лапки. Поле з лапками, комами чи переносом рядка має бути повністю в лапках, а кожна лапка всередині — подвоєна.` } };
      }
      inQuotes = true; quotedField = true; i += 1; continue;
    }
    if (ch === ',') { pushField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { line += 1; pushRow(); i += 1; continue; }
    if (quotedField && field !== '' && !inQuotes) {
      // текст після закритої лапки в тому ж полі
      return { error: { code: 'CSV_TEXT_AFTER_QUOTE', refs: [], message: `Рядок ${line}: після закритих лапок у полі йде ще текст — поле розібрати однозначно неможливо.` } };
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) return { error: { code: 'CSV_UNTERMINATED_QUOTE', refs: [], message: `Лапки, відкриті у рядку ${startLine}, не закриті до кінця файлу: таблицю розібрати неможливо.` } };
  if (field !== '' || fields.length > 0) pushRow();
  return { rows };
}

export function parseCsv(text: string): ParseResult {
  const clean = text.replace(/^﻿/, '');
  if (clean.trim() === '') return { ok: false, issues: [{ code: 'CSV_EMPTY', message: 'Таблиця порожня.', refs: [] }] };
  const t = tokenize(clean);
  if ('error' in t) return { ok: false, issues: [t.error] };
  const raw = t.rows.filter((r) => !(r.fields.length === 1 && r.fields[0]!.trim() === ''));
  if (raw.length === 0) return { ok: false, issues: [{ code: 'CSV_EMPTY', message: 'Таблиця порожня.', refs: [] }] };
  const head = raw[0]!.fields.map((f) => f.trim());
  if (head.length !== CSV_HEADER.length || head.some((h, k) => h !== CSV_HEADER[k])) {
    return { ok: false, issues: [{ code: 'CSV_BAD_HEADER', refs: [], message: `Перший рядок має бути точно «${CSV_HEADER.join(',')}», отримано «${head.join(',')}».` }] };
  }
  const issues: CsvIssue[] = [];
  const rows: CsvRow[] = [];
  for (const r of raw.slice(1)) {
    if (r.fields.length !== CSV_HEADER.length) {
      issues.push({ code: 'CSV_BAD_COLUMNS', refs: [], message: `Рядок ${r.line}: ${r.fields.length} колонок замість ${CSV_HEADER.length}. Кожен рядок має всі 8 позицій (порожні — просто пропущені між комами).` });
      continue;
    }
    const row = { line: r.line } as CsvRow;
    CSV_HEADER.forEach((c, k) => { row[c] = r.fields[k]!; });
    rows.push(row);
  }
  if (issues.length > 0) return { ok: false, issues };
  if (rows.length === 0) return { ok: false, issues: [{ code: 'CSV_NO_ROWS', message: 'У таблиці лише заголовок, жодного рядка процесу.', refs: [] }] };
  return { ok: true, rows };
}

/** Запис поля назад у CSV (для показу людині й для файлу, який віддається у скрипти). */
export const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
export const csvLine = (values: readonly string[]): string => values.map(csvCell).join(',');
