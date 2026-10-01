import type { Content } from '../schema.ts';

/** Замінює ідентифікатори джерел у змісті. Невідомі ID лишаються як є (їх відхилить перевірка). */
export function mapSourceIds(content: Content, f: (id: string) => string): Content {
  const c = structuredClone(content);
  for (const s of c.steps) s.source_ids = s.source_ids.map(f);
  for (const cl of c.claims) if (cl.source_id) cl.source_id = f(cl.source_id);
  for (const q of c.questions) if (q.closed_by_source_id) q.closed_by_source_id = f(q.closed_by_source_id);
  return c;
}

export interface SourceRef { id: string; ref: string | null }

export function idMaps(sources: SourceRef[]) {
  const idToRef = new Map(sources.map((s) => [s.id, s.ref ?? s.id]));
  const refToId = new Map(sources.map((s) => [s.ref ?? s.id, s.id]));
  return {
    toModel: (c: Content) => mapSourceIds(c, (id) => idToRef.get(id) ?? id),
    fromModel: (c: Content) => mapSourceIds(c, (ref) => refToId.get(ref) ?? ref),
    label: (id: string) => idToRef.get(id) ?? id,
  };
}
