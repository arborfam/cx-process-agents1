/**
 * Перевірка таблиці процесу проти погодженого опису (D87, вимога 2).
 *
 * Головне, що тут доводиться: **модель не може змінити погоджений процес, щоб таблиця пройшла перевірку.**
 * Кожен спосіб «підправити» процес — інша дія, інша роль, прибраний крок, додана гілка, інший підпис
 * початкової події, зайвий елемент — має зупиняти побудову з назвою кроку, а не мовчки проходити.
 *
 * Окремо перевіряється читання CSV: кирилиця, лапки, коми й переноси рядка всередині полів, а також
 * службові розділювачі гілок.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsv, endId, gatewayId, taskId, START_ID } from '../src/csv/check.ts';
import { parseCsv, csvLine } from '../src/csv/parse.ts';
import { clonePkg, pkgOf } from './bpmn-helpers.ts';
import { scriptedCsv } from './csv-fixture.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';

const pkg = (id = 'p02-branch'): ApprovedPackage => pkgOf(id);
const run = (csv: string, p: ApprovedPackage = pkg(), label?: string) =>
  checkCsv(csv, p, { startLabel: label ?? p.content.boundaries.trigger, startDocumentation: null });
const codes = (csv: string, p: ApprovedPackage = pkg(), label?: string): string[] => {
  const r = run(csv, p, label);
  return r.ok ? [] : r.issues.map((i) => i.code);
};
/** Таблиця кейсу з однією заміною тексту (саме так модель «підправила б» процес). */
const edited = (from: string, to: string, p: ApprovedPackage = pkg()): string => {
  const csv = scriptedCsv(p.content);
  assert.ok(csv.includes(from), `контроль: «${from}» у таблиці немає — тест некоректний`);
  return csv.replace(from, to);
};

// ───────────── 1. Контроль: правильна таблиця проходить ─────────────

test('1. Таблиця, що точно відповідає погодженому опису, приймається', () => {
  for (const id of ['p01-sequence', 'p02-branch', 'p03-loop', 'p04-entry-not-first', 'p06-same-target', 'p07-large']) {
    const p = pkg(id);
    const r = run(scriptedCsv(p.content), p);
    assert.ok(r.ok, `${id}: ${r.ok ? '' : JSON.stringify(r.issues).slice(0, 300)}`);
    assert.deepEqual(r.plan.lanes, p.content.roles.filter((x) => p.content.steps.some((s) => s.role === x)));
  }
});

// ───────────── 2. Модель не може змінити погоджений процес ─────────────

test('2. Змінена дія кроку — відмова з назвою кроку', () => {
  assert.deepEqual(codes(edited('Оцінює підстави для повернення коштів', 'Швидко оцінює підстави')), ['CSV_STEP_LABEL']);
});

test('2. Змінена роль кроку — відмова', () => {
  const p = pkg();
  const role = p.content.steps[0]!.role;
  assert.deepEqual(codes(edited(`,task,${role},`, `,task,Інша роль,`, p), p), ['CSV_STEP_ROLE']);
});

test('2. Прибраний крок — відмова', () => {
  const p = pkg();
  const csv = scriptedCsv(p.content).split('\n').filter((l) => !l.startsWith(`${taskId('S3')},`)).join('\n');
  const c = codes(csv, p);
  assert.ok(c.includes('CSV_STEP_MISSING'), c.join(','));
});

test('2. Доданий крок, якого немає в описі — відмова', () => {
  const p = pkg();
  const csv = scriptedCsv(p.content).trimEnd() + '\n' + csvLine(['Task_S99', 'Повідомити керівника', 'task', p.content.roles[0]!, 'Task_S3', '', '', '']) + '\n';
  const c = codes(csv, p);
  assert.ok(c.includes('CSV_EXTRA_ROW'), c.join(','));
});

test('2. Змінена умова гілки — відмова (перехід не збігається з описом)', () => {
  const c = codes(edited('підстав недостатньо>', 'підстав мало>'));
  assert.ok(c.includes('CSV_GATEWAY_BRANCHES'), c.join(','));
});

test('2. Прибрана гілка — відмова', () => {
  const p = pkg();
  const g = gatewayId('S2');
  const csv = scriptedCsv(p.content).split('\n').map((l) => (l.startsWith(`${g},`) ? l.replace(/\|[^|,"]*>[^|,"]*(?=["|,])/, '') : l)).join('\n');
  const c = codes(csv, p);
  assert.ok(c.includes('CSV_GATEWAY_BRANCHES'), c.join(','));
});

test('2. Перенаправлений перехід — відмова', () => {
  const c = codes(edited('підстави підтверджено>Task_S3', 'підстави підтверджено>Task_S4'));
  assert.ok(c.includes('CSV_GATEWAY_BRANCHES'), c.join(','));
});

test('2. Інший підпис початкової події — відмова (підпис задає погоджений опис, а не модель)', () => {
  const p = pkg();
  const c = codes(edited(`${START_ID},${p.content.boundaries.trigger},start`, `${START_ID},Процес почався,start`, p), p);
  assert.ok(c.includes('CSV_START_LABEL'), c.join(','));
});

test('2. Інший початковий крок — відмова', () => {
  const p = pkg();
  const entry = taskId(p.content.entry_step_id!);
  const c = codes(edited(`start,,${entry},`, `start,,${taskId('S3')},`, p), p);
  assert.ok(c.includes('CSV_START_NEXT'), c.join(','));
});

test('2. Нотація поза переліком (таймер, паралельний шлюз, анотація) — відмова', () => {
  const p = pkg();
  for (const [type, code] of [['timer', 'CSV_TYPE_NOT_ALLOWED'], ['and', 'CSV_TYPE_NOT_ALLOWED'], ['note', 'CSV_TYPE_NOT_ALLOWED']] as const) {
    const csv = scriptedCsv(p.content).trimEnd() + '\n' + csvLine(['X1', 'щось', type, '', '', '', '', '']) + '\n';
    assert.ok(codes(csv, p).includes(code), `${type}`);
  }
});

test('2. Позначка [TO DEFINE] у підписі — відмова (невизначене місце на схему не потрапляє)', () => {
  const c = codes(edited('Оцінює підстави для повернення коштів', '[TO DEFINE: хто саме оцінює]'));
  assert.ok(c.includes('CSV_TO_DEFINE') || c.includes('CSV_STEP_LABEL'), c.join(','));
});

test('2. Роль у події чи шлюзі — відмова (доріжка успадковується від кроку)', () => {
  const p = pkg();
  const g = gatewayId('S2');
  const csv = scriptedCsv(p.content).replace(`${g},,xor,,`, `${g},,xor,Інша роль,`);
  assert.ok(codes(csv, p).includes('CSV_EVENT_ROLE'));
});

// ───────────── 3. Формат і читання полів ─────────────

test('3. Заголовок має бути точним', () => {
  assert.deepEqual(codes('id,label,type,role,next,yes,no\nX,,start,,,,,\n'), ['CSV_BAD_HEADER']);
  assert.deepEqual(codes('ID,label,type,role,next,yes,no,assoc\n'), ['CSV_BAD_HEADER']);
});

test('3. Кирилиця, лапки, коми й перенос рядка всередині полів читаються правильно', () => {
  const p = pkg('p05-special-text');
  const csv = scriptedCsv(p.content);
  const parsed = parseCsv(csv);
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.issues));
  const byId = new Map(parsed.rows.map((r) => [r.id, r]));
  for (const s of p.content.steps) {
    assert.equal(byId.get(taskId(s.id))!.label, s.action, `дія ${s.id} прочитана дослівно`);
    assert.equal(byId.get(taskId(s.id))!.role, s.role, `роль ${s.id} прочитана дослівно`);
  }
  assert.ok([...byId.values()].some((r) => r.label.includes('\n')), 'контроль: у кейсі справді є перенос рядка в полі');
  assert.ok([...byId.values()].some((r) => r.label.includes('"')), 'контроль: у кейсі справді є лапки в полі');
  assert.ok(run(csv, p).ok, 'і вся таблиця приймається');
});

test('3. Незакриті лапки й зайва колонка — явна помилка з номером рядка, а не зсув колонок', () => {
  assert.deepEqual(codes('id,label,type,role,next,yes,no,assoc\nA,"не закрито,start,,B,,,\n'), ['CSV_UNTERMINATED_QUOTE']);
  assert.deepEqual(codes('id,label,type,role,next,yes,no,assoc\nA,x,start,,B,,,,\n'), ['CSV_BAD_COLUMNS']);
});

test('3. Символ «>» в умові допустимий (ціль відділяє останній «>»), «|» — ні', () => {
  const p = clonePkg(pkg());
  const s2 = p.content.steps.find((s) => s.id === 'S2')!;
  s2.next[0]!.condition = 'сума > 1000 грн';
  assert.ok(run(scriptedCsv(p.content), p).ok, 'умова з «>» проходить');
  s2.next[0]!.condition = 'сума | 1000 грн';
  assert.ok(codes(scriptedCsv(p.content), p).includes('CSV_CONDITION_SEPARATOR'));
});

test('3. Посилання на неіснуючий рядок і недосяжний рядок — відмова', () => {
  const p = pkg('p01-sequence');
  assert.ok(codes(edited(',Task_S2,,,', ',Task_НЕМА,,,', p), p).some((c) => c === 'CSV_STEP_NEXT' || c === 'CSV_BAD_REFERENCE'));
});

// ───────────── 4. Межі перевірки ─────────────

test('4. Повідомлення називає крок, а не просто «помилка»', () => {
  const r = run(edited('Оцінює підстави для повернення коштів', 'Інша дія'));
  assert.ok(!r.ok);
  assert.match(r.ok ? '' : r.issues[0]!.message, /Крок S2/);
  assert.match(r.ok ? '' : r.issues[0]!.message, /Інша дія/);
});

test('4. Роль без жодного кроку — застереження, а не помилка (склад ролей опису не змінюється)', () => {
  const p = pkg('p08-known-limits');
  const r = run(scriptedCsv(p.content), p);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => /Архіваріус/.test(w)), r.warnings.join('; '));
  assert.ok(!r.plan.lanes.includes('Архіваріус'));
});

test('4. Невідомий перехід у погодженому описі — таблиця не рятує', () => {
  const p = pkg('b01-unknown-transition');
  const c = codes(scriptedCsv(p.content), p);
  assert.ok(c.includes('CSV_UNKNOWN_TARGET') || c.length > 0, c.join(','));
});

test('4. Кінцеві події: кожному переходу в END — свій рядок', () => {
  const p = pkg('p02-branch');
  const csv = scriptedCsv(p.content).split('\n').filter((l) => !l.startsWith(`${endId('S4', 1)},`)).join('\n');
  const c = codes(csv, p);
  assert.ok(c.includes('CSV_END_MISSING') || c.includes('CSV_BAD_REFERENCE'), c.join(','));
});
