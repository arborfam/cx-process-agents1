/**
 * Зріз 3a: перевірка входу генератора.
 *  • справді некоректні входи й невизначеність потоку (K1) — відхиляються з конкретним поясненням;
 *  • коректні підтримувані входи (лапки, спецсимволи, кілька різних умов в одну ціль) — зберігаються без втрат;
 *  • непідтримувана нотація — `unsupported`, без файлу.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { UNKNOWN } from '../src/schema.ts';
import type { ApprovedPackage } from '../src/bpmn/types.ts';
import type { NotationKindT, NotationRequirementT } from '../src/schema.ts';
import { clonePkg, generateOk, pkgOf } from './bpmn-helpers.ts';

const base = (): ApprovedPackage => clonePkg(pkgOf('p02-branch'));

async function expectBlocked(p: ApprovedPackage, code: string, mention?: string): Promise<void> {
  const r = await generateBpmn(p);
  assert.equal(r.status, 'blocked', `очікувався blocked (${code}), отримано ${r.status}`);
  if (r.status !== 'blocked') return;
  const f = r.findings.find((x) => x.code === code);
  assert.ok(f, `немає знахідки ${code}; є: ${r.findings.map((x) => x.code).join(', ')}`);
  assert.ok(f!.message.length > 20, 'пояснення має бути конкретним');
  if (mention) assert.ok(f!.message.includes(mention), `пояснення «${f!.message}» не називає «${mention}»`);
  assert.equal('bpmn' in r, false);
}

const step = (p: ApprovedPackage, id: string) => p.content.steps.find((s) => s.id === id)!;

/** Вимога до нотації для тестів: за замовчуванням підтверджена людиною. */
const req = (id: string, kind: NotationKindT, stepId: string, detail: string, status: 'proposed' | 'confirmed' | 'rejected' = 'confirmed'): NotationRequirementT => ({
  id, kind, step_id: stepId, detail, origin: status === 'proposed' ? 'agent' : 'analyst', status,
  evidence_source_id: '', evidence_quote: '', decided_by: status === 'proposed' ? '' : 'Аналітикиня', decision_note: '',
});

const NEGATIVE: { name: string; code: string; mention?: string; mutate: (p: ApprovedPackage) => void }[] = [
  { name: 'повторний ID кроку', code: 'DUPLICATE_STEP_ID', mention: 'S3', mutate: (p) => { p.content.steps.push({ ...step(p, 'S3') }); } },
  { name: 'перехід на неіснуючий крок', code: 'STEP_BAD_NEXT', mention: 'S99', mutate: (p) => { step(p, 'S1').next = [{ to: 'S99', condition: '' }]; } },
  { name: 'недосяжний крок (крок без входу)', code: 'STEP_UNREACHABLE', mention: 'S7', mutate: (p) => { p.content.steps.push({ ...step(p, 'S6'), id: 'S7', action: 'Крок без вхідного переходу', next: [{ to: 'END', condition: '' }] }); } },
  { name: 'замкнений цикл без виходу', code: 'STEP_NO_EXIT', mention: 'S6', mutate: (p) => { step(p, 'S6').next = [{ to: 'S3', condition: '' }]; step(p, 'S3').next = [{ to: 'S6', condition: '' }]; step(p, 'S4').next = [{ to: 'S3', condition: '' }]; step(p, 'S5').next = [{ to: 'S3', condition: 'повернення погоджено' }, { to: 'S4', condition: 'у поверненні відмовлено' }]; } },
  { name: 'початковий крок не задано', code: 'ENTRY_MISSING', mutate: (p) => { p.content.entry_step_id = null; } },
  { name: 'початковий крок не задано (поля немає зовсім)', code: 'ENTRY_MISSING', mutate: (p) => { delete (p.content as { entry_step_id?: unknown }).entry_step_id; } },
  { name: 'початковий крок вказує на неіснуючий', code: 'ENTRY_BAD_REF', mention: 'S42', mutate: (p) => { p.content.entry_step_id = 'S42'; } },
  { name: 'перехід «невідомо»', code: 'UNKNOWN_TRANSITION', mention: 'S2', mutate: (p) => { step(p, 'S2').next[1]!.to = UNKNOWN; } },
  { name: '[TO DEFINE] у дії', code: 'TO_DEFINE', mention: 'S1', mutate: (p) => { step(p, 'S1').action = 'Приймає заявку [TO DEFINE: хто саме?]'; } },
  { name: 'керівний символ U+000B у дії', code: 'INVALID_TEXT', mention: 'U+000B', mutate: (p) => { step(p, 'S1').action = 'Приймає\u000bзаявку'; } },
  { name: 'керівний символ U+0000 в умові', code: 'INVALID_TEXT', mention: 'U+0000', mutate: (p) => { step(p, 'S2').next[0]!.condition = 'підстави\u0000підтверджено'; } },
  { name: 'табуляція в назві ролі', code: 'INVALID_TEXT', mention: 'табуляції', mutate: (p) => { p.content.roles[0] = 'Опера\tтор'; step(p, 'S1').role = 'Опера\tтор'; step(p, 'S4').role = 'Опера\tтор'; step(p, 'S6').role = 'Опера\tтор'; } },
  { name: 'повернення каретки в назві пулу', code: 'INVALID_TEXT', mention: 'каретки', mutate: (p) => { p.content.process_name = 'Пул\rз переносом'; } },
  { name: 'зарезервований ID кроку END', code: 'RESERVED_STEP_ID', mutate: (p) => { step(p, 'S6').id = 'END'; step(p, 'S3').next = [{ to: 'END', condition: '' }]; } },
  { name: 'ID кроку з недозволеними символами', code: 'BAD_STEP_ID', mutate: (p) => { step(p, 'S4').id = 'S 4"<'; step(p, 'S2').next[1]!.to = 'S 4"<'; step(p, 'S5').next[1]!.to = 'S 4"<'; } },
  { name: 'порожня дія', code: 'EMPTY_TEXT', mention: 'S1', mutate: (p) => { step(p, 'S1').action = '   '; } },
  { name: 'роль кроку відсутня у списку ролей', code: 'STEP_UNKNOWN_ROLE', mention: 'S1', mutate: (p) => { step(p, 'S1').role = 'Невідома роль'; } },
  { name: 'повторна роль', code: 'DUPLICATE_ROLE', mutate: (p) => { p.content.roles.push('Оператор'); } },
  { name: 'немає ролей', code: 'NO_ROLES', mutate: (p) => { p.content.roles = []; } },
  { name: 'немає кроків', code: 'NO_STEPS', mutate: (p) => { p.content.steps = []; } },
  { name: 'крок без переходів (глухий кут)', code: 'STEP_NO_NEXT', mention: 'S6', mutate: (p) => { step(p, 'S6').next = []; } },
  { name: 'єдина умовна гілка без «інакше»', code: 'SINGLE_CONDITIONAL_BRANCH', mention: 'S6', mutate: (p) => { step(p, 'S6').next = [{ to: 'END', condition: 'якщо клієнт відповів' }]; } },
  { name: 'розгалуження з порожньою умовою', code: 'STEP_NO_CONDITION', mention: 'S2', mutate: (p) => { step(p, 'S2').next[2]!.condition = ''; } },
  { name: 'однаковий перехід двічі', code: 'DUPLICATE_TRANSITION', mutate: (p) => { step(p, 'S2').next.push({ ...step(p, 'S2').next[0]! }); } },
  { name: 'та сама умова веде в різні цілі', code: 'AMBIGUOUS_CONDITION', mutate: (p) => { step(p, 'S2').next[1]!.condition = step(p, 'S2').next[0]!.condition; } },
  { name: 'відкрите критичне питання', code: 'CRITICAL_QUESTION', mention: 'Q1', mutate: (p) => { p.content.questions.push({ id: 'Q1', text: 'Чи є ліміт?', critical: true, impact: '', addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '' }); } },
  { name: 'відкрита пропозиція вилучення кроку', code: 'PENDING_STEP_PROPOSAL', mention: 'S6', mutate: (p) => { p.content.step_proposals = [{ id: 'SP1', action: 'remove', step_id: 'S6', replacement_step_id: '', reason: 'дублює S3', evidence_source_id: 'SRC', evidence_quote: 'q', status: 'proposed', decided_by: '', decision_note: '' }]; } },
  { name: 'хеш версії відсутній', code: 'INVALID_BINDING', mutate: (p) => { p.contentHash = ''; } },
  { name: 'ID версії відсутній', code: 'INVALID_BINDING', mutate: (p) => { p.versionId = ''; } },
  { name: 'питання про перехід відкрите, а перехід поданий як встановлений (суперечність)', code: 'CONTRADICTION', mention: 'Q9', mutate: (p) => { p.content.questions.push({ id: 'Q9', text: 'Що буде далі?', critical: false, impact: '', addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '', affects_transitions: [{ step_id: 'S2', condition: 'підстав недостатньо' }] }); } },
];

for (const n of NEGATIVE) {
  test(`вхід відхиляється: ${n.name}`, async () => {
    const p = base();
    n.mutate(p);
    await expectBlocked(p, n.code, n.mention);
  });
}

test('відхилення входу не потребує ані моделі, ані бази, ані файлів: результат — лише пояснення', async () => {
  const p = base();
  p.content.entry_step_id = null;
  const r = await generateBpmn(p);
  assert.equal(r.status, 'blocked');
  assert.deepEqual(Object.keys(r).sort(), ['findings', 'status', 'warnings']);
});

test('КОРЕКТНІ входи зберігаються без втрат: лапки та спецсимволи у дії, ролі, умові, назві пулу, тригері', async () => {
  const p = base();
  const q = '«ялинки» "подвійні" \'одинарні\' & < > a<b && c>d <b>x</b> 100% ✅ №1';
  p.content.process_name = `Пул ${q}`;
  p.content.boundaries.trigger = `Тригер ${q}`;
  p.content.roles = p.content.roles.map((r) => `${r} ${q}`);
  for (const s of p.content.steps) {
    s.role = `${s.role} ${q}`;
    s.action = `${s.action} ${q}`;
    s.next.forEach((n, i) => { if (n.condition) n.condition = `${n.condition} ${q} #${i}`; });
  }
  const r = await generateOk(p);
  assert.deepEqual(r.verification.errors, []);
  assert.equal(r.drawio.status, 'ok');
  assert.ok(r.bpmn.includes('&quot;') && r.bpmn.includes('&lt;') && r.bpmn.includes('&amp;') || r.bpmn.includes('&#34;'), 'лапки та службові символи екрановано');
});

test('КОРЕКТНИЙ вхід: кілька різних умов в одну ціль — усі переходи й підписи збережено', async () => {
  const p = base();
  // S2 → S3 за двома різними умовами й до END за двома різними умовами
  step(p, 'S2').next = [
    { to: 'S3', condition: 'погоджено' }, { to: 'S3', condition: 'погоджено умовно' },
    { to: 'S4', condition: 'відхилено' },
    { to: 'END', condition: 'клієнт відмовився' }, { to: 'END', condition: 'термін минув' },
  ];
  step(p, 'S5').next = [{ to: 'S3', condition: 'повернення погоджено' }, { to: 'S4', condition: 'у поверненні відмовлено' }];
  step(p, 'S1').next = [{ to: 'S2', condition: '' }, ];
  // S5 тепер недосяжний — додаємо вхід
  step(p, 'S2').next.push({ to: 'S5', condition: 'потрібен керівник' });
  const r = await generateOk(p);
  const row = r.map.find((m) => m.step_id === 'S2')!;
  assert.equal(row.outgoing.length, 6);
  assert.deepEqual(row.outgoing.filter((o) => o.to === 'S3').map((o) => o.condition).sort(), ['погоджено', 'погоджено умовно']);
  assert.equal(new Set(row.outgoing.map((o) => o.flow_id)).size, 6, 'ID переходів унікальні');
  assert.equal(r.drawio.status, 'ok');
});

test('K2 (відкрите некритичне питання, гіпотеза, оцінка) не блокує побудову', async () => {
  const p = base();
  p.content.questions.push({ id: 'Q2', text: 'Чи потрібен окремий ліміт?', critical: false, impact: '', addressee: '', status: 'open', answer: '', closed_by_source_id: null, origin: 'analyst', criticality_note: '' });
  p.content.hypotheses.push({ id: 'H1', author: 'analyst', text: 'Причина в графіку', status: 'open', evidence_for: [], evidence_against: [], check_method: '', history: [] });
  const r = await generateOk(p);
  assert.ok(r.knownLimits.some((l) => l.code === 'OPEN_QUESTION'));
  assert.ok(r.knownLimits.some((l) => l.code === 'OPEN_HYPOTHESIS'));
});

// ───────────── непідтримувана нотація (D21) ─────────────

test('unsupported: паралельні гілки й таймер → пояснення з кроками, без файлу, без «наближеної» схеми', async () => {
  const p = pkgOf('u01-unsupported-parallel-timer');
  const r = await generateBpmn(p);
  assert.equal(r.status, 'unsupported');
  if (r.status !== 'unsupported') return;
  assert.equal('bpmn' in r, false);
  assert.equal('drawio' in r, false);
  const codes = r.findings.map((f) => f.code).sort();
  assert.deepEqual(codes, ['UNSUPPORTED_PARALLEL_BRANCHES', 'UNSUPPORTED_TIMER']);
  assert.deepEqual(r.findings.flatMap((f) => f.refs).sort(), ['S2', 'S4']);
  // пояснення: які кроки, який елемент, що без відображення, що погодження не змінено, які є варіанти
  for (const needle of ['S2', 'S4', 'parallelGateway', 'timerEvent', 'не підтримує', 'не змінено', 'Варіанти', 'TEST-U01-V1']) {
    assert.ok(r.explanation.includes(needle), `у поясненні немає «${needle}»:\n${r.explanation}`);
  }
  assert.match(r.explanation, /не спрощено/);
});

test('unsupported: надто довгий підпис — відмова з поясненням, текст не скорочується', async () => {
  const p = base();
  step(p, 'S1').action = 'д'.repeat(601);
  const r = await generateBpmn(p);
  assert.equal(r.status, 'unsupported');
  if (r.status === 'unsupported') assert.ok(r.findings.some((f) => f.code === 'LABEL_TOO_LONG' && f.refs.includes('S1')));
  // межа: 600 символів ще підтримується й виводиться повністю
  step(p, 'S1').action = 'д'.repeat(600);
  const ok = await generateOk(p);
  assert.ok(ok.bpmn.includes('д'.repeat(600)));
});

test('unsupported: позначка на неіснуючий крок — відхилений вхід; усі види нотації мають конкретне пояснення', async () => {
  const p = base();
  p.content.notation_requirements = [req('N1', 'timer', 'S99', '')];
  await expectBlocked(p, 'NOTATION_BAD_STEP', 'S99');
  const kinds = ['parallel_branches', 'timer', 'message', 'subprocess', 'boundary_event', 'data_object', 'multiple_entry', 'other'] as const;
  for (const kind of kinds) {
    const q = base();
    q.content.notation_requirements = [req('N1', kind, 'S1', 'тест')];
    const r = await generateBpmn(q);
    assert.equal(r.status, 'unsupported', kind);
    if (r.status === 'unsupported') assert.ok(r.findings[0]!.message.includes('S1') && r.explanation.includes('Варіанти'));
  }
});

test('якщо є і K1, і непідтримувана нотація — показано обидва, статус blocked', async () => {
  const p = pkgOf('u01-unsupported-parallel-timer');
  p.content.entry_step_id = null;
  const r = await generateBpmn(p);
  assert.equal(r.status, 'blocked');
  if (r.status === 'blocked') {
    assert.ok(r.findings.some((f) => f.code === 'ENTRY_MISSING'));
    assert.ok(r.findings.some((f) => f.code === 'UNSUPPORTED_TIMER'));
  }
});

test('чому табуляція відхиляється на вході: лейаутер записує її «сирою», а XML-розбір перетворює на пробіл (тихо змінює текст)', async () => {
  const { buildSemantic } = await import('../src/bpmn/build.ts');
  const { layoutProcess } = await import('bpmn-auto-layout');
  const { parseXml, walk, attr } = await import('../src/bpmn/xml.ts');
  const p = base();
  step(p, 'S1').action = 'Перший\tдругий';
  const laid = await layoutProcess(buildSemantic(p).xml); // повз перевірку входу — лише щоб показати поведінку бібліотеки
  assert.ok(laid.xml.includes('Перший\tдругий'), 'лейаутер записав сиру табуляцію в значення атрибута');
  let name = '';
  walk(parseXml(laid.xml), (e) => { if (attr(e, 'id') === 'Task_S1') name = attr(e, 'name')!; });
  assert.equal(name, 'Перший другий', 'розбір за правилами XML замінив табуляцію пробілом');
  assert.equal((await generateBpmn(p)).status, 'blocked', 'тому генератор відхиляє такий текст заздалегідь');
});

// ───────────── D61: вимоги до нотації у змісті версії ─────────────

test('D61: ПІДТВЕРДЖЕНА вимога зі змісту версії дає unsupported без виклику моделі; пояснення містить опис і цитату', async () => {
  const p = base();
  p.content.notation_requirements = [{ ...req('N1', 'parallel_branches', 'S2', 'оцінка й перевірка виконуються одночасно'), evidence_source_id: 'src', evidence_quote: 'Одночасно перевіряють і оцінюють' }];
  const r = await generateBpmn(p);
  assert.equal(r.status, 'unsupported');
  if (r.status !== 'unsupported') return;
  assert.equal('bpmn' in r, false);
  assert.ok(r.findings[0]!.message.includes('S2') && r.findings[0]!.message.includes('оцінка й перевірка виконуються одночасно'));
  assert.ok(r.findings[0]!.message.includes('Одночасно перевіряють і оцінюють'), 'цитата джерела в поясненні');
  assert.ok(r.explanation.includes('не змінено'), 'погодження AS-IS лишається чинним');
});

test('D61: НЕпідтверджена пропозиція агента не стає встановленим фактом, але й не ігнорується: блокує до рішення людини', async () => {
  const p = base();
  p.content.notation_requirements = [req('N1', 'timer', 'S2', 'очікування три дні', 'proposed')];
  await expectBlocked(p, 'PENDING_NOTATION_PROPOSAL', 'N1');
  const r = await generateBpmn(p);
  assert.equal(r.status, 'blocked', 'не unsupported: вимога ще не встановлена');
});

test('D61: відхилена пропозиція ігнорується (схема будується); немає поля чи порожній список = «не зазначено», а не «особливостей немає»', async () => {
  const p = base();
  p.content.notation_requirements = [req('N1', 'timer', 'S2', 'очікування', 'rejected')];
  const ok = await generateOk(p);
  assert.ok(ok.map.length > 0);
  const q = base();
  q.content.notation_requirements = [];
  assert.equal((await generateBpmn(q)).status, 'ok');
  // «не зазначено» ніде не перетворюється на твердження «особливостей немає»: у відомих обмеженнях схеми немає такого запевнення
  assert.ok(!ok.knownLimits.some((l) => /особливостей немає|нотац.* не потрібн/i.test(l.message)));
  assert.ok(ok.knownLimits.some((l) => l.code === 'FIELDS_NOT_ON_DIAGRAM'));
});

test('D61: вимоги можна задати лише через зміст версії — окремого входу «позначки» в генератора немає', () => {
  const p = base() as unknown as Record<string, unknown>;
  assert.equal('unsupportedMarks' in p, false);
});

// ───────────── D62: назва процесу = напис на пулі; назви кейсу немає ─────────────

test('D62: немає назви процесу — побудови немає, потрібне явне уточнення (нова версія й погодження), без підстановки', async () => {
  for (const name of [undefined, '', '   ']) {
    const p = base();
    if (name === undefined) delete p.content.process_name; else p.content.process_name = name;
    const r = await generateBpmn(p);
    assert.equal(r.status, 'blocked', JSON.stringify(name));
    if (r.status !== 'blocked') continue;
    const f = r.findings.find((x) => x.code === 'PROCESS_NAME_MISSING')!;
    assert.ok(f, 'є знахідка PROCESS_NAME_MISSING');
    assert.ok(/не підставляємо/.test(f.message) && /нову версію/.test(f.message) && /погодити/.test(f.message), f.message);
    assert.equal('bpmn' in r, false);
  }
});

test('D62: напис на пулі — рівно назва процесу зі змісту (дослівно, зі спецсимволами), у .bpmn і .drawio; зміна назви ламає звірку', async () => {
  const p = base();
  p.content.process_name = 'Процес «Повернення» & <тест> "лапки"';
  const r = await generateOk(p);
  const { readBpmn } = await import('../src/bpmn/read.ts');
  assert.equal(readBpmn(r.bpmn).model!.participant!.name, p.content.process_name);
  const { verifyBpmn } = await import('../src/bpmn/verify.ts');
  const other = base();
  other.content.process_name = 'Інша назва процесу';
  assert.ok(verifyBpmn(r.bpmn, other).report.errors.some((e) => e.code === 'POOL_NAME_MISMATCH'));
});
