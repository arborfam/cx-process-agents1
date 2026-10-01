import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { all, one } from '../src/db.ts';
import { sha256 } from '../src/hash.ts';
import {
  acceptDraft, approve, bpmnGuard, buildCard, currentApproval, getCase, headVersion, listSources, saveAnalystVersion, submissionBlockers,
  submitForApproval, versionContent,
} from '../src/domain.ts';
import { runAnalyst, ScriptedDemoClient } from '../src/runs.ts';
import { UNKNOWN, type Content } from '../src/schema.ts';
import {
  addExplicitClarification, advanceScenario, createScenarioCase, loadScenario, scenarioInfo, stageSources, TOTAL_STAGES, type Variant,
} from '../src/scenarios.ts';
import { evaluate, CHECKS, type EvalCtx } from '../evals/cx-preparation/criteria.ts';
import { renderCriteriaMd } from '../evals/cx-preparation/render.ts';
import { freshDb, human } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const ORIGINAL_SHA = '9c22fa19168d' as const;
const fingerprints = (JSON.parse(readFileSync(join(ROOT, 'evals/cx-preparation/hidden-fingerprints.json'), 'utf8')) as { fingerprints: string[] }).fingerprints;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
const hasFingerprint = (text: string) => fingerprints.filter((f) => norm(text).includes(norm(f)));

// ─────────── джерела ───────────
test('Оригінал пакета не змінено; джерела SRC-01…07 — дослівні фрагменти з вказаним походженням; решта позначена як вигадана', () => {
  const sc = loadScenario();
  assert.ok(sc.originalSha256.startsWith(ORIGINAL_SHA), 'SHA-256 оригіналу збігається із зафіксованим при отриманні файлу');
  const original = readFileSync(join(ROOT, 'scenarios/cx-preparation/original/CX_ASIS_discovery_inputs_draft1.md'), 'utf8');
  assert.equal(sha256(original), sc.originalSha256);
  assert.deepEqual(sc.sources.map((s) => s.id), ['SRC-00', 'SRC-01', 'SRC-02', 'SRC-03', 'SRC-04', 'SRC-05', 'SRC-06', 'SRC-07', 'SRC-08p', 'SRC-08n', 'SRC-09']);
  for (const s of sc.sources) {
    assert.equal(s.origin, 'synthetic', s.id);
    const fromOriginal = /^SRC-0[1-7]$/.test(s.id);
    if (fromOriginal) {
      assert.ok(original.includes(s.text.trimEnd()), `${s.id} — суцільний фрагмент оригіналу`);
      assert.match(s.provenance, /рядки \d+–\d+/);
      const [a, b] = (s as unknown as { lines: [number, number] }).lines;
      assert.equal(original.split('\n').slice(a - 1, b).join('\n').trim() + '\n', s.text, `${s.id}: діапазон рядків відповідає тексту`);
    } else {
      assert.ok(!original.includes(s.text.trim()), `${s.id} не з оригіналу`);
    }
  }
  for (const id of ['SRC-08p', 'SRC-08n', 'SRC-09']) assert.match(sc.sources.find((s) => s.id === id)!.text, /Вигадано для тесту/);
  assert.match(sc.sources.find((s) => s.id === 'SRC-00')!.text, /не висновок/);
  // етапи
  const st = (v: Variant, n: number) => stageSources(v, n, sc).map((s) => s.id);
  assert.deepEqual(st('positive', 1), ['SRC-00', 'SRC-01', 'SRC-02']);
  assert.deepEqual(st('positive', 2), ['SRC-03']);
  assert.deepEqual(st('positive', 3), ['SRC-04']);
  assert.deepEqual(st('positive', 4), ['SRC-05', 'SRC-06', 'SRC-07']);
  assert.deepEqual(st('positive', 5), ['SRC-08p']);
  assert.deepEqual(st('negative', 5), ['SRC-08n']);
  assert.ok(![1, 2, 3, 4, 5].some((n) => st('negative', n).includes('SRC-09')), 'приховане уточнення не входить в етапи');
});

test('Приховане уточнення: SRC-08n не містить відповіді; SRC-08p містить; відбитки відповідають SRC-09', () => {
  const sc = loadScenario();
  const text = (id: string) => sc.sources.find((s) => s.id === id)!.text;
  assert.equal(hasFingerprint(text('SRC-08n')).length, 0);
  assert.equal(hasFingerprint(text('SRC-08p')).length, fingerprints.length, 'контроль: у позитивному сценарії відповідь є');
  assert.equal(hasFingerprint(text('SRC-09')).length, fingerprints.length);
  for (const id of ['SRC-00', 'SRC-01', 'SRC-02', 'SRC-03', 'SRC-04', 'SRC-05', 'SRC-06', 'SRC-07']) assert.equal(hasFingerprint(text(id)).length, 0, id);
  assert.match(text('SRC-08n'), /Підтвердження запуску/);
  assert.ok(!/Перенесення або вилучення/.test(text('SRC-08n')));
});

// ─────────── поетапне подання та ізоляція ───────────
function coverAll(db: ReturnType<typeof freshDb>, caseId: string) {
  saveAnalystVersion(db, human, caseId, { baseVersionId: headVersion(db, caseId).id, fields: { summary: `оновлено ${Date.now()}${Math.random()}` }, coverAllSources: true });
}

test('Етапи подаються по черзі; наступний — лише після опрацювання попереднього; ref стабільні; два сценарії ізольовані', () => {
  const db = freshDb();
  const pos = createScenarioCase(db, human, 'positive', 'demo');
  const neg = createScenarioCase(db, human, 'negative', 'demo');
  assert.notEqual(pos.id, neg.id);
  assert.equal(pos.scenario_id, 'cx-preparation:positive');
  assert.equal(listSources(db, pos.id).length, 0);

  const first = advanceScenario(db, human, pos.id);
  assert.deepEqual(first.added.sort(), ['SRC-00', 'SRC-01', 'SRC-02']);
  assert.deepEqual(listSources(db, pos.id).map((s) => s.ref).sort(), ['SRC-00', 'SRC-01', 'SRC-02']);
  assert.equal(listSources(db, neg.id).length, 0, 'у іншому кейсі джерел не з’явилось');
  assert.ok(listSources(db, pos.id).every((s) => s.origin === 'synthetic' && s.required === 1 && s.title.startsWith(s.ref!)));

  assert.throws(() => advanceScenario(db, human, pos.id), (e: any) => e.code === 'PREVIOUS_STAGE_UNPROCESSED' && /SRC-01/.test(e.message));
  assert.equal(scenarioInfo(db, getCase(db, pos.id))!.can_advance, false);
  coverAll(db, pos.id);
  assert.equal(scenarioInfo(db, getCase(db, pos.id))!.can_advance, true);

  for (let i = 2; i <= TOTAL_STAGES; i++) { advanceScenario(db, human, pos.id); coverAll(db, pos.id); }
  assert.equal(getCase(db, pos.id).scenario_stage, TOTAL_STAGES);
  assert.throws(() => advanceScenario(db, human, pos.id), (e: any) => e.code === 'SCENARIO_DONE');
  assert.equal(listSources(db, pos.id).length, 9);
  assert.equal(getCase(db, neg.id).scenario_stage, 0, 'другий сценарій не просунувся');
  assert.equal(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', neg.id).length, 1, 'історія іншого кейсу незмінна');
  // агент (людина) — лише людина просуває етапи
  assert.throws(() => advanceScenario(db, { kind: 'agent', name: 'analyst-agent' }, neg.id));
});

test('На кожному запуску агент бачить лише додані джерела; майбутні етапи й критерії до нього не потрапляють', async () => {
  const db = freshDb();
  const neg = createScenarioCase(db, human, 'negative', 'demo');
  const seenRefs: string[][] = [];
  const dumps: string[] = [];
  const client = new ScriptedDemoClient((input) => {
    seenRefs.push(input.sources.map((s) => s.id).sort());
    dumps.push(JSON.stringify(input));
    return input.head_content;
  });
  for (let stage = 1; stage <= TOTAL_STAGES; stage++) {
    advanceScenario(db, human, neg.id);
    assert.ok((await runAnalyst(db, neg.id, client)).ok);
  }
  assert.deepEqual(seenRefs, [
    ['SRC-00', 'SRC-01', 'SRC-02'],
    ['SRC-00', 'SRC-01', 'SRC-02', 'SRC-03'],
    ['SRC-00', 'SRC-01', 'SRC-02', 'SRC-03', 'SRC-04'],
    ['SRC-00', 'SRC-01', 'SRC-02', 'SRC-03', 'SRC-04', 'SRC-05', 'SRC-06', 'SRC-07'],
    ['SRC-00', 'SRC-01', 'SRC-02', 'SRC-03', 'SRC-04', 'SRC-05', 'SRC-06', 'SRC-07', 'SRC-08n'],
  ]);
  // перший запуск не містить тексту розмов майбутніх етапів
  assert.ok(!dumps[0]!.includes('Growth'), 'етап 1 не містить матеріалів Growth');
  assert.ok(!dumps[0]!.includes('handover'));
  // жодних відбитків прихованої відповіді в жодному вході агента, і критерії не потрапили
  for (const d of dumps) {
    assert.equal(hasFingerprint(d).length, 0);
    assert.ok(!/criteria|hidden-fingerprints|E5N|F4-2/.test(d), 'критерії оцінки не в контексті');
    assert.ok(!/сценарі[йю] [АБ]|negative|positive|cx-preparation/i.test(d), 'агент не бачить, який це сценарій');
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, out); } else out.push(p);
  }
  return out;
}

test('Витоку прихованої відповіді в негативному кейсі немає: джерела, версії, резюме, журнал; промпти й код не містять відбитків', async () => {
  const db = freshDb();
  const neg = createScenarioCase(db, human, 'negative', 'demo');
  for (let stage = 1; stage <= TOTAL_STAGES; stage++) {
    advanceScenario(db, human, neg.id);
    await runAnalyst(db, neg.id, new ScriptedDemoClient((i) => ({ ...i.head_content, summary: `Етап ${stage}: дані для аналізу ще неповні.` })));
  }
  const dump = JSON.stringify({
    sources: all(db, 'SELECT * FROM source WHERE case_id = ?', neg.id),
    versions: all(db, 'SELECT * FROM as_is_version WHERE case_id = ?', neg.id),
    runs: all(db, 'SELECT * FROM run WHERE case_id = ?', neg.id),
    audit: all(db, 'SELECT * FROM audit_log WHERE case_id = ?', neg.id),
    card: { ...buildCard(db, neg.id, 'demo'), scenario: scenarioInfo(db, getCase(db, neg.id)) },
  });
  assert.deepEqual(hasFingerprint(dump), [], 'у негативному кейсі до явного уточнення відбитків немає');
  assert.ok(!listSources(db, neg.id).some((s) => s.ref === 'SRC-09'));
  // контроль чутливості: у позитивному кейсі ті самі відбитки знаходяться
  const pos = createScenarioCase(db, human, 'positive', 'demo');
  for (let stage = 1; stage <= TOTAL_STAGES; stage++) { advanceScenario(db, human, pos.id); coverAll(db, pos.id); }
  assert.ok(hasFingerprint(JSON.stringify(all(db, 'SELECT * FROM source WHERE case_id = ?', pos.id))).length > 0);
  // інструкція агента, код і документи для моделі не містять відбитків
  const files = [...walk(join(ROOT, 'src')), join(ROOT, 'prompts/analyst.md'), ...walk(join(ROOT, 'public'))];
  for (const f of files) assert.deepEqual(hasFingerprint(readFileSync(f, 'utf8')), [], f);
  // коротке резюме на картці не розкриває відповіді
  assert.deepEqual(hasFingerprint(buildCard(db, neg.id, 'demo').head.content.summary), []);
  // сценарна панель не віддає текст прихованого джерела
  assert.deepEqual(hasFingerprint(JSON.stringify(scenarioInfo(db, getCase(db, neg.id)))), []);
});

test('src/ не читає evals/ і не імпортує критеріїв; критерії відповідають документу', () => {
  for (const f of walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'public')))) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!/evals\/|criteria\.ts|hidden-fingerprints/.test(t), `${f} не повинен посилатись на критерії`);
  }
  const md = readFileSync(join(ROOT, 'evals/cx-preparation/criteria.md'), 'utf8');
  assert.equal(md, renderCriteriaMd(), 'criteria.md застарів: node --import tsx scripts/build-criteria-md.ts');
  for (const c of CHECKS) assert.ok(md.includes(`| ${c.id} |`), c.id);
  assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length, 'ID критеріїв унікальні');
  for (const stage of [1, 2, 3, 4, 5]) {
    const kinds = new Set(CHECKS.filter((c) => c.stage === stage).map((c) => c.kind));
    for (const k of ['expected', 'forbidden', 'allowed_unknown', 'human'] as const) assert.ok(kinds.has(k), `етап ${stage}: немає записів виду ${k}`);
  }
});

// ─────────── явне уточнення та блокування ───────────
function content(base: Content, f: (c: Content) => void): Content { const c = structuredClone(base); f(c); return c; }

/** Синтетичний «опис» для перевірки програмної логіки блокувань (НЕ відповідь AI). */
function negativeDraft(ids: Record<string, string>, resolved: boolean): (base: Content) => Content {
  return (base) => content(base, (c) => {
    c.summary = 'Чернетка підготовки CX до зміни.';
    c.business_context = 'Зміни надходять до CX із різних каналів, інколи пізно.';
    c.boundaries = { trigger: 'CX дізнається про майбутню зміну', input: 'Інформація про зміну', completion: 'Статтю оновлено й повідомлення опубліковане', result: 'Агенти отримали повідомлення' };
    c.roles = ['Відповідальна за підготовку в CX'];
    c.entry_step_id = 'S1';
    c.steps = [
      { id: 'S1', role: 'Відповідальна за підготовку в CX', action: 'Готує повідомлення агентам', entry_condition: '', input_artifact: '', result: 'Повідомлення готове', next: [{ to: 'S2', condition: 'запуск відбувається' }, { to: resolved ? 'S3' : UNKNOWN, condition: 'запуск перенесено або вилучено' }], source_ids: [ids['SRC-01']!] },
      { id: 'S2', role: 'Відповідальна за підготовку в CX', action: 'Публікує повідомлення', entry_condition: '', input_artifact: '', result: 'Повідомлення опубліковане', next: [{ to: 'END', condition: '' }], source_ids: [ids['SRC-01']!] },
      ...(resolved ? [{ id: 'S3', role: 'Відповідальна за підготовку в CX', action: 'Публікує коротке виправлення або припиняє підготовку', entry_condition: '', input_artifact: '', result: 'Агентів не введено в оману', next: [{ to: 'END', condition: '' }], source_ids: [ids['SRC-09']!] }] : []),
    ];
    c.problems = [{ id: 'P1', symptom: 'Пізні повідомлення', cause: '', impact: 'Агенти можуть відповісти неправильно (оцінка, метрик немає)', impact_is_estimate: true }];
    c.questions = [
      { id: 'Q1', text: 'Що робить CX, коли повідомлення підготовлене, а запуск перенесено або вилучено?', critical: true, impact: 'Визначає гілку переходу S1 і завершення процесу', addressee: 'Відповідальна в CX', status: resolved ? 'closed' : 'open', answer: resolved ? 'За явним уточненням SRC-09.' : '', closed_by_source_id: resolved ? ids['SRC-09']! : null, origin: 'agent', criticality_note: '', affects_transitions: [{ step_id: 'S1', condition: 'запуск перенесено або вилучено' }] },
    ];
  });
}

test('Негативний сценарій: невизначена гілка блокує погодження й BPMN; явне уточнення → нова версія, що потребує прийняття й погодження', async () => {
  const db = freshDb();
  const neg = createScenarioCase(db, human, 'negative', 'demo');
  const refMap = () => Object.fromEntries(listSources(db, neg.id).map((s) => [s.ref!, s.id]));
  assert.throws(() => addExplicitClarification(db, human, neg.id), (e: any) => e.code === 'TOO_EARLY');

  for (let stage = 1; stage <= TOTAL_STAGES; stage++) {
    advanceScenario(db, human, neg.id);
    const draft = negativeDraft({ ...refMap(), 'SRC-09': 'none' }, false);
    assert.ok((await runAnalyst(db, neg.id, new ScriptedDemoClient((i) => {
      // «модель» у тесті — підставна: перекладаємо зміст у внутрішні ID самостійно
      return draft(structuredClone(versionContent(headVersion(db, neg.id))));
    }))).ok);
  }
  // Етап 5: питання про гілку відкрите → блокування (логіка програми)
  const v5 = headVersion(db, neg.id);
  acceptDraft(db, human, neg.id, v5.id);
  const blockers = submissionBlockers(db, neg.id).filter((b) => b.severity === 'critical').map((b) => b.code);
  assert.ok(blockers.includes('CRITICAL_QUESTION') && blockers.includes('UNRESOLVED_TRANSITION'), blockers.join());
  assert.throws(() => submitForApproval(db, human, neg.id), (e: any) => e.code === 'GUARD_FAILED');
  assert.equal(bpmnGuard(db, neg.id).ok, false);
  assert.deepEqual(hasFingerprint(JSON.stringify(versionContent(v5))), []);

  // Явне уточнення: нове джерело → кейс лишається у дослідженні, нове джерело не враховано, потрібен новий огляд
  const before = all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', neg.id).length;
  const info = scenarioInfo(db, getCase(db, neg.id))!;
  assert.equal(info.clarification?.available, true);
  assert.deepEqual(addExplicitClarification(db, human, neg.id), { added: 'SRC-09' });
  assert.throws(() => addExplicitClarification(db, human, neg.id), (e: any) => e.code === 'ALREADY_ADDED');
  assert.equal(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', neg.id).length, before, 'уточнення саме по собі не змінює версій');
  assert.ok(submissionBlockers(db, neg.id).some((b) => b.code === 'UNCOVERED_SOURCE' && b.severity === 'critical'));
  assert.equal(scenarioInfo(db, getCase(db, neg.id))!.clarification?.added, true);

  // Агент (підставний) закриває питання за новим джерелом → нова версія; прийнята/погоджена вона не є
  const res = await runAnalyst(db, neg.id, new ScriptedDemoClient(() => negativeDraft(refMap(), true)(versionContent(headVersion(db, neg.id)))));
  assert.ok(res.ok, res.ok ? '' : (res as { error: string }).error);
  const v6 = headVersion(db, neg.id);
  assert.notEqual(v6.id, v5.id);
  assert.equal(all(db, 'SELECT id FROM as_is_version WHERE case_id = ?', neg.id).length, before + 1, 'старі версії збережено, додано нову');
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM version_acceptance WHERE version_id = ?', v6.id)!.n, 0, 'нова версія не прийнята');
  assert.throws(() => submitForApproval(db, human, neg.id), (e: any) => e.code === 'GUARD_FAILED', 'без прийняття людиною передача на погодження неможлива');
  assert.equal(bpmnGuard(db, neg.id).ok, false, 'BPMN без погодження недоступний');
  assert.deepEqual(submissionBlockers(db, neg.id).filter((b) => b.severity === 'critical').map((b) => b.code), ['NOT_ACCEPTED']);
  acceptDraft(db, human, neg.id, v6.id);
  submitForApproval(db, human, neg.id);
  approve(db, human, neg.id, { versionId: v6.id, checklistConfirmed: true });
  // D62: назву процесу задає людина, агент її не заповнює; без неї дозвіл BPMN не надається і назву кейсу не підставлено
  assert.equal(versionContent(v6).process_name, undefined, 'агент не вигадав назву процесу');
  assert.deepEqual(bpmnGuard(db, neg.id).reasons.map((r) => r.code), ['PROCESS_NAME_MISSING']);
  // явне уточнення людиною → нова версія → прийняття → погодження → лише тоді дозвіл
  const v7 = saveAnalystVersion(db, human, neg.id, { baseVersionId: v6.id, fields: { process_name: 'Підготовка CX до продуктових змін' } });
  assert.equal(currentApproval(db, neg.id), undefined, 'погодження v6 втратило чинність (вона лишається в історії)');
  acceptDraft(db, human, neg.id, v7.id);
  submitForApproval(db, human, neg.id);
  approve(db, human, neg.id, { versionId: v7.id, checklistConfirmed: true });
  assert.equal(bpmnGuard(db, neg.id).ok, true, 'після прийняття й погодження людиною дозвіл є');
});

test('Явне уточнення доступне лише в негативному сценарії', () => {
  const db = freshDb();
  const pos = createScenarioCase(db, human, 'positive', 'demo');
  assert.throws(() => addExplicitClarification(db, human, pos.id), (e: any) => e.code === 'NOT_APPLICABLE');
  const plain = all<{ id: string }>(db, 'SELECT id FROM "case"')[0]!;
  assert.throws(() => advanceScenario(db, human, plain.id + 'x'));
});

// ─────────── перевіряльник критеріїв: хороші й погані синтетичні відповіді ───────────
// Це перевірка САМОГО перевіряльника, а не якості AI.
const src = (ref: string, text: string) => ({ id: ref, ref, text });
const base = (): Content => ({
  summary: '', business_context: '', boundaries: { trigger: '', input: '', completion: '', result: '' }, roles: [], steps: [], problems: [], claims: [], hypotheses: [], questions: [], conflicts: [],
});
const ctx = (stage: number, variant: Variant, c: Content, extra: Partial<EvalCtx> = {}): EvalCtx => {
  const sc = loadScenario();
  const sources = Array.from({ length: stage }, (_, i) => stageSources(variant, i + 1, sc)).flat().map((s) => src(s.id, s.text));
  return { stage, variant, content: c, sources, hiddenFingerprints: fingerprints, ...extra };
};
const result = (r: ReturnType<typeof evaluate>, id: string) => r.find((x) => x.id === id)!;
const claim = (id: string, text: string, type: Content['claims'][number]['type'], source_id: string | null, scope = '') => ({ id, text, type, source_id, quote: '', scope });

test('Перевіряльник, етап 1: хороша відповідь проходить очікувані; погана (єдиний канал як AS-IS, вигаданий SLA, підтвердження агентом) — ловиться', () => {
  const good = base();
  good.business_context = 'Інформація про зміни надходить до CX з різних каналів, інколи дуже близько до запуску або вже після нього, тому агенти підтримки не встигають підготуватися. Навчальна межа: підготовка матеріалів CX до великої продуктової зміни (задано аналітиком).';
  good.claims = [
    claim('C1', 'Замовник пропонує єдиний канал, категорії змін і строки попередження', 'improvement_proposal', 'SRC-02', 'Пропозиція замовника, не погоджена з командами'),
    claim('C2', 'Межа задана аналітиком: підготовка матеріалів CX до великої продуктової зміни', 'source_fact', 'SRC-00', 'Рамка від аналітика, не висновок із джерел'),
  ];
  good.questions = [{ id: 'Q1', text: 'Чи мають усі зміни проходити однаковий шлях?', critical: false, impact: 'Межі процесу', addressee: 'Замовник', status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '' }];
  const r = evaluate(ctx(1, 'positive', good));
  for (const id of ['E1-1', 'E1-2', 'E1-3', 'E1-4', 'F1-1', 'F1-2', 'G1', 'G2', 'G3', 'G4', 'G6']) assert.equal(result(r, id).pass, true, `${id}: ${result(r, id).detail}`);
  assert.equal(result(r, 'H1-1').pass, null, 'людські пункти не оцінюються програмою');

  const evil = structuredClone(good);
  evil.claims.push(claim('C3', 'Усі зміни проходять через єдиний канал, SLA 30 хвилин', 'source_fact', 'SRC-01'));
  evil.claims[0]!.type = 'source_fact';
  evil.claims.push(claim('C4', 'Підтверджено', 'analyst_confirmed', 'SRC-01'));
  evil.steps = [{ id: 'S1', role: 'Агент', action: 'Читає єдиний канал', entry_condition: '', input_artifact: '', result: 'х', next: [], source_ids: [] }];
  evil.claims.push(claim('C5', 'Покращення 95 %', 'source_fact', 'SRC-77'));
  const rb = evaluate(ctx(1, 'positive', evil));
  for (const id of ['E1-3', 'F1-1', 'F1-2', 'G1', 'G2', 'G3', 'G4', 'G6']) assert.equal(result(rb, id).pass, false, `${id} має виявити дефект`);
});

test('Перевіряльник, етап 2–3: узагальнення публікації як прочитання й орієнтовної дати як підтвердженої виявляються', () => {
  const bad = base();
  bad.summary = 'Опублікований допис — агенти готові; запуск відбувається для всіх користувачів.';
  bad.claims = [claim('C1', 'Підтверджена дата Growth: запуск відбудеться для всіх користувачів', 'source_fact', 'SRC-04'), claim('C2', 'Канал новин є єдиним офіційним каналом', 'source_fact', 'SRC-03')];
  const r2 = evaluate(ctx(2, 'positive', bad));
  assert.equal(result(r2, 'F2-1').pass, false);
  assert.equal(result(r2, 'F2-2').pass, false);
  const r3 = evaluate(ctx(3, 'positive', bad));
  assert.equal(result(r3, 'F3-1').pass, false);
  const clean = base();
  clean.claims = [claim('C1', 'Орієнтовна дата Growth приблизна', 'source_fact', 'SRC-04', 'за словами Growth')];
  assert.equal(result(evaluate(ctx(3, 'positive', clean)), 'F3-1').pass, true);
});

test('Перевіряльник, етап 5 негативний: вигадана дія при перенесенні — дефект; відкрите критичне питання — очікувано; після уточнення — інакше', () => {
  const invented = base();
  invented.steps = [{ id: 'S1', role: 'CX', action: 'Публікує коротке виправлення і повертає статтю до попередньої редакції', entry_condition: '', input_artifact: '', result: 'х', next: [{ to: 'END', condition: '' }], source_ids: ['SRC-03'] }];
  const ri = evaluate(ctx(5, 'negative', invented));
  assert.equal(result(ri, 'F5N-1').pass, false);
  assert.equal(result(ri, 'G5').pass, false, 'відбиток прихованої відповіді виявлено');
  assert.equal(result(ri, 'E5N-1').pass, false);

  const honest = base();
  honest.questions = [{ id: 'Q1', text: 'Що робить CX, коли повідомлення підготовлене, а запуск перенесено чи вилучено?', critical: true, impact: 'Невідома гілка', addressee: 'CX', status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '' }];
  const rh = evaluate(ctx(5, 'negative', honest));
  assert.equal(result(rh, 'E5N-1').pass, true);
  assert.equal(result(rh, 'E5N-2').pass, true);
  assert.equal(result(rh, 'F5N-1').pass, true);
  assert.equal(result(rh, 'G5').pass, true);
  // після уточнення питання має бути закрите
  assert.equal(result(evaluate(ctx(5, 'negative', honest, { afterClarification: true })), 'E5N-3').pass, false);
});

test('Перевіряльник, етап 5 позитивний: початок/завершення, гілки уточнення й явний початковий крок', () => {
  const good = base();
  good.boundaries = { trigger: 'Відповідальна в CX дізнається про майбутню клієнтопомітну зміну', input: 'інформація', completion: 'Статтю оновлено й повідомлення опубліковане', result: 'повідомлення' };
  good.entry_step_id = 'S1';
  good.steps = [{ id: 'S1', role: 'CX', action: 'Готує повідомлення', entry_condition: '', input_artifact: '', result: 'х', next: [{ to: 'END', condition: '' }], source_ids: ['SRC-08p'] }];
  good.claims = [
    claim('C1', 'За неповних матеріалів готує повідомлення з відомим, позначає невідоме й повторно запитує овнера', 'source_fact', 'SRC-08p'),
    claim('C2', 'Орієнтовна дата не є підтвердженням: потрібна підтверджена дата запуску', 'source_fact', 'SRC-08p'),
    claim('C3', 'При перенесенні опубліковане повідомлення виправляють коротким виправленням, статтю повертають до попередньої редакції; якщо не опубліковано — припиняє підготовку й зберігає матеріали', 'source_fact', 'SRC-08p'),
  ];
  const r = evaluate(ctx(5, 'positive', good));
  for (const id of ['E5P-1', 'E5P-2', 'E5P-3', 'E5P-4', 'E5P-5', 'E5P-6']) assert.equal(result(r, id).pass, true, `${id}: ${result(r, id).detail}`);
  const unresolved = structuredClone(good);
  unresolved.entry_step_id = null;
  unresolved.steps[0]!.next = [{ to: UNKNOWN, condition: 'запуск перенесено' }];
  const ru = evaluate(ctx(5, 'positive', unresolved));
  assert.equal(result(ru, 'E5P-5').pass, false);
  assert.equal(result(ru, 'E5P-6').pass, false);
});

test('Критерії: у регулярних виразах немає \\w (воно не розпізнає кирилицю) — лише \\p{L}', () => {
  const t = readFileSync(join(ROOT, 'evals/cx-preparation/criteria.ts'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  assert.deepEqual(t.filter((l) => l.includes('\\w')), []);
});
