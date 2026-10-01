/** Детермінований генератор різних синтетичних процесів для перевірки ізоляції запусків (без AI). */
import { canonical, sha256 } from '../src/hash.ts';
import { emptyContent } from '../src/schema.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';

function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Процес №i: назви ролей, дій, умов, тригера й пулу містять унікальну мітку «П<i>», щоб змішування було видно. */
export function makeProcess(i: number): ApprovedPackage {
  const r = rng(i + 1);
  const c = emptyContent();
  const nRoles = 2 + Math.floor(r() * 3);
  const nSteps = 4 + Math.floor(r() * 6);
  c.roles = Array.from({ length: nRoles }, (_, k) => `Роль ${k + 1} процесу П${i}`);
  c.boundaries = { trigger: `Тригер процесу П${i}`, input: 'вхід', completion: 'завершення', result: 'результат' };
  c.entry_step_id = `S${1 + Math.floor(r() * 1)}`;
  c.steps = Array.from({ length: nSteps }, (_, k) => {
    const id = `S${k + 1}`;
    const next: { to: string; condition: string }[] = [];
    if (k === nSteps - 1) next.push({ to: 'END', condition: '' });
    else if (r() < 0.45) {
      next.push({ to: `S${k + 2}`, condition: `умова А кроку ${id} процесу П${i}` });
      const back = r() < 0.5 && k > 0 ? `S${1 + Math.floor(r() * k)}` : `S${Math.min(nSteps, k + 3)}`;
      next.push({ to: back, condition: `умова Б кроку ${id} процесу П${i}` });
    } else next.push({ to: `S${k + 2}`, condition: '' });
    return {
      id, role: c.roles[Math.floor(r() * nRoles)]!, action: `Дія ${id} процесу П${i}: ${'слово '.repeat(1 + Math.floor(r() * 8)).trim()}`,
      entry_condition: '', input_artifact: '', result: `р${id}`, next, source_ids: [],
    };
  });
  // роль кожного кроку має існувати — гарантовано; кожна роль без кроків дозволена
  c.process_name = `Пул П${i}`;
  return { versionId: `PAR-${i}`, contentHash: sha256(canonical({ content: c, i })), content: c, origin: 'test-fixture' };
}
