/**
 * Пошук цитати в тексті джерела. Дослівний збіг — найкращий; допускається збіг після
 * нормалізації пробілів, лапок, апострофів і тире (модель часто «чистить» їх) та цитата
 * з пропуском «…» між фрагментами (kind 'elided' — потребує уваги людини). Усе інше — «не знайдено».
 */
export type QuoteMatch = { kind: 'exact'; index: number } | { kind: 'normalized'; index: null } | { kind: 'elided'; index: null } | { kind: 'not_found'; index: null };

export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findQuote(text: string, quote: string): QuoteMatch {
  if (!quote.trim()) return { kind: 'not_found', index: null };
  const idx = text.indexOf(quote);
  if (idx >= 0) return { kind: 'exact', index: idx };
  const nt = normalizeText(text);
  const hasEllipsis = /…|\.{3}/.test(quote);
  // Усі непорожні частини мають знайтися в тексті в тому самому порядку; довжина частини не є підставою її відкинути:
  // інакше вигаданий початок цитати («НЕ БУЛО … Повідомлення опубліковано.») проходив би перевірку.
  const parts = quote.split(/…|\.{3}/).map(normalizeText).filter((p) => p.length > 0);
  if (parts.length === 0) return { kind: 'not_found', index: null };
  let from = 0;
  for (const p of parts) {
    const at = nt.indexOf(p, from);
    if (at < 0) return { kind: 'not_found', index: null };
    from = at + p.length;
  }
  return hasEllipsis ? { kind: 'elided', index: null } : { kind: 'normalized', index: null };
}
