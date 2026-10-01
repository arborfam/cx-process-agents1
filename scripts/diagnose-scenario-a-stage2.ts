/**
 * Відтворення діагностики сценарію А, етап 2 (01.10.2026): стан зі скриншота власниці й механізм часткового прийняття пропозицій.
 * ВСІ дані тут вигадані за описом скриншота; бази користувача скрипт не читає й не змінює. Запуск:
 *   node --import tsx scripts/diagnose-scenario-a-stage2.ts
 * Результат і пояснення — docs/diagnosis-scenario-a-stage2.md. Це діагностика поточної поведінки, а не тест правильності.
 */
import { freshDb, human } from '../tests/helpers.ts';
import { createCase, headVersion, insertVersion, decideStepProposal, versionContent, flowIssues, transitionIssues } from '../src/domain.ts';
import { emptyContent, UNKNOWN, type Content } from '../src/schema.ts';
import { analyzePackage } from '../src/bpmn/validate.ts';

const T = (id: string, role: string, action: string, result: string, next: { to: string; condition: string }[]) =>
  ({ id, role, action, entry_condition: '', input_artifact: '', result, next, source_ids: [] as string[] });
const Q = (id: string, text: string, step: string, cond: string, crit = true) => ({
  id, text, critical: crit, impact: '', addressee: '', status: 'open' as const, answer: '', closed_by_source_id: null, origin: 'agent' as const,
  criticality_note: '', affects_transitions: [{ step_id: step, condition: cond }] });

// ─── 1. Стан ПІСЛЯ прийняття SP2, як на скриншоті (за описом; тексти скорочено) ───
const c1 = emptyContent();
c1.process_name = 'Підготовка CX (синтетичний кейс)';
c1.entry_step_id = 'S3';
const cS1 = 'CX отримує інформацію про зміну (строки до запуску різні)';
const cS4 = 'Отримано опис зміни і матеріали (інший результат не описано, див. Q11)';
const cS5 = 'Опис спрощено, питання продумано (фактичний порядок див. Q13)';
c1.steps = [
  T('S1', 'Команди-джерела', 'Повідомляють CX про майбутню зміну', 'CX отримує інформацію', [{ to: 'S4', condition: cS1 }]),
  T('S3', 'Відповідальна за підготовку агентів', 'Дізнається про майбутню зміну одним із кількох шляхів', 'Знайдено інформацію про зміну', [{ to: 'S4', condition: 'Знайдено інформацію про зміну' }]),
  T('S4', 'Відповідальна за підготовку агентів', 'Пише овнеру', 'Отримано опис і матеріали', [{ to: 'S5', condition: cS4 }]),
  T('S5', 'Відповідальна за підготовку агентів', 'Перекладає опис простішою мовою', 'Спрощений опис', [{ to: 'S6', condition: cS5 }]),
  T('S6', 'Відповідальна за підготовку агентів', 'Створює або оновлює статтю', 'Стаття створена', [{ to: 'S7', condition: 'Стаття створена або оновлена' }]),
  T('S7', 'Відповідальна за підготовку агентів', 'Публікує повідомлення агентам', 'Опубліковано', [
    { to: 'S8', condition: 'Агенти ставлять питання після запуску зміни' },
    { to: UNKNOWN, condition: 'Питань немає; чи завершується процес — невідомо (Q12)' }]),
  T('S8', 'Відповідальна за підготовку агентів', 'Відповідає на питання агентів', 'Агент отримав відповідь', [{ to: UNKNOWN, condition: 'Невідомо, коли завершується робота з питаннями (Q12)' }]),
];
c1.questions = [
  Q('Q7', 'Що відбувається з переходом S1 → ... ?', 'S1', cS1),
  Q('Q11', 'Який інший результат може мати запит до овнера?', 'S4', cS4),
  Q('Q13', 'Який фактичний порядок S5/S6/S7?', 'S5', cS5),
  Q('Q12', 'Чи входить робота з питаннями агентів у процес?', 'S7', 'Питань немає; чи завершується процес — невідомо (Q12)'),
];
c1.questions[3]!.affects_transitions!.push({ step_id: 'S8', condition: 'Невідомо, коли завершується робота з питаннями (Q12)' });
console.log('=== 1. Стан зі скриншота ===');
console.log('transitionIssues:', transitionIssues(c1).map((i) => i.code + (i.ref ? '(' + i.ref + ')' : '')).join(', '));
console.log('flowIssues:', flowIssues(c1).map((i) => i.code + '(' + i.ref + ')').join(', '));
// Якби питання Q7/Q11/Q13 закрили «як є» (відповідь без зміни переходів), що скаже генератор 3a?
const closed = structuredClone(c1);
for (const q of closed.questions) if (['Q7', 'Q11', 'Q13'].includes(q.id)) q.status = 'closed';
closed.entry_step_id = 'S3';
const gen = analyzePackage({ versionId: 'TEST', contentHash: 'a'.repeat(64), content: closed, origin: 'test-fixture' });
console.log('генератор 3a після закриття Q7/Q11/Q13 (лише K1):', gen.blocking.filter((f) => f.class === 'K1').map((f) => f.code + '(' + f.refs.join(',') + ')').join(', '));

// ─── 2. Часткове прийняття залежних пропозицій ───
function scenario(label: string, accept: ('SP1' | 'SP2')[]) {
  const db = freshDb();
  const c = createCase(db, human, 'Репродукція', 'demo');
  const base = emptyContent();
  base.entry_step_id = 'S3';
  base.steps = [
    T('S1', 'Команди-джерела', 'Повідомляють CX', 'CX отримує', [{ to: 'S2', condition: '' }]),
    T('S2', 'CX', 'Готує агентів до зміни (загальний крок)', 'Агенти готові', [{ to: 'END', condition: '' }]),
    T('S3', 'CX', 'Дізнається про зміну', 'Знайдено', [{ to: 'S4', condition: '' }]),
    T('S4', 'CX', 'Пише овнеру', 'Отримано', [{ to: 'END', condition: '' }]),
  ];
  base.step_proposals = [
    { id: 'SP1', action: 'replace', step_id: 'S1', replacement_step_id: 'S3', reason: 'r', evidence_source_id: '', evidence_quote: '', status: 'proposed', decided_by: '', decision_note: '' },
    { id: 'SP2', action: 'replace', step_id: 'S2', replacement_step_id: 'S4', reason: 'r', evidence_source_id: '', evidence_quote: '', status: 'proposed', decided_by: '', decision_note: '' },
  ];
  insertVersion(db, { caseId: c.id, content: base, createdBy: 'agent', actorName: 'a', parentId: headVersion(db, c.id).id, covered: [], owned: [], note: 'x' });
  db.exec(`UPDATE "case" SET head_version_id = (SELECT id FROM as_is_version WHERE case_id = '${c.id}' ORDER BY number DESC LIMIT 1) WHERE id = '${c.id}'`);
  for (const id of accept) decideStepProposal(db, human, c.id, { baseVersionId: headVersion(db, c.id).id, proposalId: id, decision: 'accept' });
  const v = versionContent(headVersion(db, c.id));
  console.log(`${label}: кроки=[${v.steps.map((s) => s.id).join(',')}] проблеми потоку: ${flowIssues(v).map((i) => i.code + '(' + i.ref + ')').join(', ') || 'немає'}`);
}
console.log('\n=== 2. Залежні пропозиції SP1 (S1→S3) і SP2 (S2→S4) ===');
scenario('прийнято лише SP2 ', ['SP2']);
scenario('прийнято лише SP1 ', ['SP1']);
scenario('прийнято SP1, потім SP2', ['SP1', 'SP2']);
scenario('прийнято SP2, потім SP1', ['SP2', 'SP1']);
