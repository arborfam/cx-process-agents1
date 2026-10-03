/**
 * Інструкція агента 2 і валідатор таблиці мають описувати ОДИН контракт ID.
 *
 * Передісторія: контракт ID у валідаторі змінився (`StartEvent_1`, `Task_<крок>`, `Gateway_<крок>`,
 * `End_<крок>_<N>`), а текст інструкції лишився зі старим (`START`, `<крок>`, `G_<крок>`, `END_<крок>_<N>`).
 * Модель виконала інструкцію дослівно — і відповідь не пройшла перевірку; це коштувало реального запуску.
 * Тому приклад беремо **з самого файлу інструкції**, а не з тестового хелпера: хелпер складено за правилами
 * валідатора, тож таку суперечність він принципово не ловить.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCsv, endId, gatewayId, taskId, START_ID } from '../src/csv/check.ts';
import { fixtureToPackage, type Fixture } from '../src/bpmn/fixture.ts';
import { buildThroughPipeline } from '../src/bpmn-artifacts.ts';
import { readBpmn } from '../src/bpmn/read.ts';

const PROMPT = readFileSync(join(import.meta.dirname, '..', 'prompts', 'bpmn.md'), 'utf8');

/** CSV-приклад із самої інструкції: перший блок коду, що починається заголовком таблиці. */
function exampleCsv(): string {
  const m = /```\n(id,label,type,role,next,yes,no,assoc\n[\s\S]*?)```/.exec(PROMPT);
  assert.ok(m, 'у інструкції немає прикладу таблиці — контракт нічим перевірити');
  return m![1]!;
}

/**
 * Синтетичний AS-IS, який ТОЧНО відповідає опису прикладу в інструкції
 * («S1 Зареєструвати звернення / Оператор → S2; S2 Перевірити дані / Аналітик → дані повні → S3,
 * дані неповні → S1; S3 Закрити звернення / Аналітик → завершення»).
 */
const fixture: Fixture = {
  id: 'instruction-example', title: 'Приклад з інструкції агента 2', created_without_ai: true, synthetic: true,
  what_it_tests: 'Приклад таблиці в інструкції має проходити перевірку валідатора.',
  expect: { status: 'ok' }, version_id: 'TEST-INSTR-V1', process_name: 'Обробка звернення (синтетичний процес)',
  trigger: 'Клієнт звернувся', roles: ['Оператор', 'Аналітик'], entry_step_id: 'S1',
  steps: [
    { id: 'S1', role: 'Оператор', action: 'Зареєструвати звернення', next: [{ to: 'S2', condition: '' }] },
    { id: 'S2', role: 'Аналітик', action: 'Перевірити дані', next: [{ to: 'S3', condition: 'дані повні' }, { to: 'S1', condition: 'дані неповні' }] },
    { id: 'S3', role: 'Аналітик', action: 'Закрити звернення', next: [{ to: 'END', condition: '' }] },
  ],
};

test('1. Приклад таблиці з інструкції проходить перевірку валідатора', () => {
  const pkg = fixtureToPackage(fixture);
  const r = checkCsv(exampleCsv(), pkg, { startLabel: 'Клієнт звернувся', startDocumentation: null });
  assert.ok(r.ok, `приклад з інструкції не проходить перевірку:\n${r.ok ? '' : r.issues.map((i) => `${i.code}: ${i.message}`).join('\n')}`);
});

test('2. Правила, приклад і самоперевірка в інструкції називають ті самі ID, що й валідатор', () => {
  const section = PROMPT.slice(PROMPT.indexOf('## Таблиця процесу (CSV)'), PROMPT.indexOf('## Заборонено'));
  // Чинний контракт ID — із самого валідатора, а не переписаний у тесті.
  for (const id of [START_ID, taskId('<ID кроку>'), gatewayId('<ID кроку>'), endId('<ID кроку>', 1).replace('_1', '_<N>')]) {
    assert.ok(section.includes(id), `в інструкції немає ID «${id}» із чинного контракту`);
  }
  // Старих ID у тексті лишитися не повинно: саме вони й дали розбіжність.
  for (const stale of ['`START`', '`G_<ID кроку>`', '`END_<ID кроку>_<N>`', '`G_<ID>`', '`END_<ID>_<N>`']) {
    assert.ok(!section.includes(stale), `в інструкції лишився застарілий ID ${stale}`);
  }
});

test('3. Приклад JSON-відповіді в інструкції містить таблицю за чинним контрактом', () => {
  const m = /```json\n([\s\S]*?)```/.exec(PROMPT);
  assert.ok(m, 'у інструкції немає прикладу JSON-відповіді');
  const json = m![1]!;
  assert.ok(json.includes('"csv"'), 'приклад відповіді має містити поле csv');
  assert.ok(json.includes('id,label,type,role,next,yes,no,assoc'), 'заголовок таблиці в прикладі');
  assert.ok(json.includes(START_ID), `приклад JSON має показувати ID початкової події «${START_ID}»`);
  assert.ok(!/\bSTART\b,/.test(json), 'у прикладі JSON лишився застарілий ID START');
});

test('4. Усі цілі переходів у прикладі інструкції існують як рядки того ж прикладу', () => {
  const rows = exampleCsv().trim().split('\n').slice(1).map((l) => l.split(','));
  const ids = new Set(rows.map((r) => r[0]!));
  for (const r of rows) {
    const next = r[4] ?? '';
    const targets = next.includes('>')
      ? next.split('|').map((b) => b.slice(b.lastIndexOf('>') + 1).trim()).filter(Boolean)
      : next.split('|').map((t) => t.trim()).filter(Boolean);
    for (const t of targets) assert.ok(ids.has(t), `ціль «${t}» рядка «${r[0]}» не існує в прикладі`);
  }
  assert.ok(ids.has(START_ID), 'у прикладі має бути початкова подія чинного контракту');
  assert.ok([...ids].some((x) => x.startsWith('Gateway_')), 'у прикладі має бути рядок-шлюз чинного контракту');
  assert.ok([...ids].some((x) => x.startsWith('End_')), 'у прикладі має бути завершення чинного контракту');
});

test('5. Повний шлях на таблиці З ІНСТРУКЦІЇ: перевірка → скрипти → перевірені .bpmn і .drawio', async () => {
  const pkg = fixtureToPackage(fixture);
  const csv = exampleCsv();
  const check = checkCsv(csv, pkg, { startLabel: 'Клієнт звернувся', startDocumentation: null });
  assert.ok(check.ok, 'таблиця з інструкції має проходити перевірку');
  const r = await buildThroughPipeline({ pkg, startLabel: { label: 'Клієнт звернувся' }, csv, plan: check.plan });
  assert.equal(r.status, 'ok', r.status === 'ok' ? '' : JSON.stringify(r).slice(0, 600));
  assert.ok(r.status === 'ok');
  assert.equal(r.drawio.status, 'ok', JSON.stringify(r.drawio.issues).slice(0, 400));
  // Зміст: усі кроки опису на місці, з дослівними підписами й ролями.
  const m = readBpmn(r.bpmn).model!;
  for (const s of fixture.steps) {
    assert.equal(m.nodes.get(taskId(s.id))!.name, s.action, `дія ${s.id}`);
  }
  assert.deepEqual(m.lanes.map((l) => l.name), ['Оператор', 'Аналітик']);
  assert.equal(r.map.length, fixture.steps.length, 'карта «крок ↔ елемент» повна');
  assert.ok(r.bpmn.includes('Gateway_S2') && r.bpmn.includes('End_S3_1'), 'шлюз і завершення на місці');
});
