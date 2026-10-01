/** Прибирає з тексту все, що схоже на ключ доступу. Застосовується до кожної помилки, журналу й відповіді API. */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
  /(ANTHROPIC_API_KEY\s*[=:]\s*)\S+/gi,
];

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join('[ключ приховано]');
  }
  for (const p of PATTERNS) out = out.replace(p, (m, g1?: string) => (typeof g1 === 'string' && m.startsWith(g1) ? g1 : '') + '[ключ приховано]');
  return out;
}
