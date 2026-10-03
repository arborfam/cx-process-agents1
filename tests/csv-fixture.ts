/**
 * СЦЕНАРНА таблиця процесу — підстава замість відповіді агента 2 у тестах.
 *
 * Навмисно лежить у `tests/`, а НЕ в `src/`: у продукті таблицю складає лише агент 2, а програма її
 * перевіряє (D87). Якби ця функція була в `src/`, вона й була б тим самим «прихованим запасним генератором»,
 * якого бути не повинно — це стереже `tests/no-csv-generator.test.ts`.
 *
 * Прогон із цією таблицею доводить, що працює ПРОГРАМА (перевірка, скрипти, звірка файлів).
 * Він нічого не доводить про якість моделі.
 */
import { csvLine } from '../src/csv/parse.ts';
import { START_ID, endId, gatewayId, taskId } from '../src/csv/check.ts';
import type { Content } from '../src/schema.ts';

export function scriptedCsv(content: Content, startLabel?: string): string {
  const rows: string[][] = [['id', 'label', 'type', 'role', 'next', 'yes', 'no', 'assoc']];
  rows.push([START_ID, startLabel ?? content.boundaries.trigger, 'start', '', content.entry_step_id ? taskId(content.entry_step_id) : '', '', '', '']);
  const ends: string[][] = [];
  for (const s of content.steps) {
    const target = (to: string, i: number): string => (to === 'END' ? endId(s.id, i + 1) : taskId(to));
    s.next.forEach((n, i) => { if (n.to === 'END') ends.push([endId(s.id, i + 1), '', 'end', '', '', '', '', '']); });
    if (s.next.length === 1) {
      rows.push([taskId(s.id), s.action, 'task', s.role, target(s.next[0]!.to, 0), '', '', '']);
    } else {
      rows.push([taskId(s.id), s.action, 'task', s.role, gatewayId(s.id), '', '', '']);
      rows.push([gatewayId(s.id), '', 'xor', '', s.next.map((n, i) => `${n.condition}>${target(n.to, i)}`).join('|'), '', '', '']);
    }
  }
  return [...rows, ...ends].map(csvLine).join('\n') + '\n';
}
