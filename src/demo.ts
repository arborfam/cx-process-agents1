import { all, tx, type DB } from './db.ts';
import { audit, createCase, insertVersion, addSource, headVersion, type Actor } from './domain.ts';
import { emptyContent, type Content } from './schema.ts';
import { setHeadForSeed } from './seed-internal.ts';

/**
 * Демонстраційний кейс. УСІ дані синтетичні (вигадані). Питання, гіпотеза й твердження
 * задані сценарієм і позначені origin='demo_script': це НЕ результат аналізу AI.
 */
const SEED_ACTOR: Actor = { kind: 'human', name: 'Демо-сценарій' };

export const DEMO_TITLE = 'ДЕМО: Зміна умов обслуговування (синтетичний приклад)';

const REQUEST_TEXT =
  'Синтетичний запит замовника: компанія «Приклад» хоче зрозуміти, як фактично обробляються запити клієнтів на зміну умов обслуговування, ' +
  'бо частина клієнтів скаржиться на тривале очікування відповіді. Потрібен опис фактичного процесу AS-IS перед будь-якими змінами.';

const TRANSCRIPT_TEXT = [
  'Синтетичне інтерв’ю 1. Співрозмовниця: менеджерка з роботи з клієнтами.',
  '',
  'Коли клієнт пише про зміну умов, я створюю заявку в CRM. Далі перевіряю, чи вона повна. Якщо не вистачає документів, повертаю заявку клієнту на доповнення.',
  'Повну заявку я передаю оператору back-office. Оператор дивиться, чи зміна стандартна. Стандартні зміни він вносить у систему сам.',
  'Якщо потрібен виняток, оператор передає заявку керівнику відділу. Керівник вирішує: погодити чи відхилити.',
  'Після погодження оператор вносить зміну. Що буває після відхилення, я точно не знаю, бо з цього моменту заявка вже не в мене.',
  'Замовник каже, що було б добре мати єдиний канал для всіх запитів, але зараз запити приходять і поштою, і через форму.',
  'Наказ про новий порядок опублікували в інтранеті ще в березні.',
].join('\n');

function demoContent(reqId: string, trId: string): Content {
  const c = emptyContent();
  c.summary =
    'Клієнт подає запит на зміну умов; менеджерка створює й перевіряє заявку, оператор вносить стандартну зміну або передає виняток керівнику відділу. ' +
    'Що відбувається після відхилення винятку, поки невідомо.';
  c.business_context = 'Клієнти скаржаться на тривале очікування. Замовнику потрібен опис фактичного процесу до будь-яких змін (синтетичний приклад).';
  c.boundaries = {
    trigger: 'Клієнт повідомляє про бажання змінити умови обслуговування',
    input: 'Запит клієнта (пошта або форма)',
    completion: 'Зміну внесено в систему АБО заявку відхилено (наслідки відхилення не з’ясовано)',
    result: 'Оновлені умови обслуговування клієнта',
  };
  c.roles = ['Менеджерка з клієнтами', 'Оператор back-office', 'Керівник відділу'];
  c.steps = [
    { id: 'S1', role: 'Менеджерка з клієнтами', action: 'Створює заявку в CRM за запитом клієнта', entry_condition: 'Клієнт повідомив про зміну умов', input_artifact: 'Запит клієнта', result: 'Заявка в CRM', next: [{ to: 'S2', condition: '' }], source_ids: [trId] },
    { id: 'S2', role: 'Менеджерка з клієнтами', action: 'Перевіряє повноту заявки', entry_condition: '', input_artifact: 'Заявка в CRM', result: 'Заявка перевірена', next: [{ to: 'S3', condition: 'заявка повна' }, { to: 'S1', condition: 'не вистачає документів (повернення клієнту на доповнення)' }], source_ids: [trId] },
    { id: 'S3', role: 'Оператор back-office', action: 'Оцінює, чи зміна стандартна', entry_condition: '', input_artifact: 'Повна заявка', result: 'Визначено тип зміни', next: [{ to: 'S4', condition: 'зміна стандартна' }, { to: 'S5', condition: 'потрібен виняток' }], source_ids: [trId] },
    { id: 'S4', role: 'Оператор back-office', action: 'Вносить зміну в систему', entry_condition: '', input_artifact: '', result: 'Умови оновлено', next: [{ to: 'END', condition: '' }], source_ids: [trId] },
    { id: 'S5', role: 'Керівник відділу', action: 'Вирішує, погодити чи відхилити виняток', entry_condition: 'Оператор передав заявку', input_artifact: '', result: 'Рішення щодо винятку', next: [{ to: 'S4', condition: 'погоджено' }, { to: 'END', condition: 'відхилено' }], source_ids: [trId] },
  ];
  c.problems = [
    { id: 'P1', symptom: 'Клієнти скаржаться на тривале очікування', cause: '', impact: 'Невдоволення клієнтів; тривалість не виміряно (метрик немає)', impact_is_estimate: true },
  ];
  c.claims = [
    { id: 'C1', text: 'Менеджерка перевіряє повноту заявки й за нестачі документів повертає її клієнту', type: 'source_fact', source_id: trId, quote: 'Якщо не вистачає документів, повертаю заявку клієнту на доповнення.', scope: 'Зі слів менеджерки, власна ділянка роботи' },
    { id: 'C2', text: 'Замовник пропонує єдиний канал для запитів — це пропозиція, а не чинне правило', type: 'improvement_proposal', source_id: trId, quote: 'було б добре мати єдиний канал для всіх запитів', scope: 'Побажання замовника; TO-BE, не AS-IS' },
    { id: 'C3', text: 'Наказ опубліковано в інтранеті. Це не доводить, що його прочитали чи виконують', type: 'source_fact', source_id: trId, quote: 'Наказ про новий порядок опублікували в інтранеті ще в березні.', scope: 'Публікація ≠ ознайомлення ≠ розуміння' },
    { id: 'C4', text: 'Що відбувається після відхилення винятку — невідомо', type: 'unknown', source_id: trId, quote: 'Що буває після відхилення, я точно не знаю', scope: 'Джерело не знає цієї ділянки' },
  ];
  c.hypotheses = [
    { id: 'H1', author: 'analyst', text: 'Затримки виникають головно на кроці розгляду винятків', status: 'open', evidence_for: [], evidence_against: [], check_method: 'Запитати оператора й керівника про типовий час розгляду; побачити приклад заявки', history: [] },
  ];
  c.questions = [
    { id: 'Q1', text: 'Що відбувається із заявкою після відхилення винятку: хто й як повідомляє клієнта, чи завершується на цьому процес?', critical: true, impact: 'Без цього неможливо коректно описати завершення процесу й гілку «відхилено»', addressee: 'Керівник відділу або оператор back-office', status: 'open', answer: '', closed_by_source_id: null, origin: 'demo_script', criticality_note: '' },
    { id: 'Q2', text: 'Який приблизний час очікування клієнта на кожному кроці?', critical: false, impact: 'Допоможе оцінити вплив проблеми P1', addressee: 'Оператор back-office', status: 'open', answer: '', closed_by_source_id: null, origin: 'demo_script', criticality_note: '' },
  ];
  return c;
}

/** Створює демо-кейс, якщо його ще немає. Повертає ID. Питання тут задані сценарієм, а не виявлені AI. */
export function seedDemoCase(db: DB, mode: string): string {
  return tx(db, () => {
    const existing = all<{ id: string }>(db, 'SELECT id FROM "case" WHERE is_demo_script = 1 ORDER BY created_at LIMIT 1');
    if (existing[0]) return existing[0].id;
    const c = createCase(db, SEED_ACTOR, DEMO_TITLE, mode, { demoScript: true });
    const req = addSource(db, SEED_ACTOR, c.id, { kind: 'request', title: 'Запит замовника (синтетичний)', content: REQUEST_TEXT, origin: 'demo_script', required: true });
    const tr = addSource(db, SEED_ACTOR, c.id, { kind: 'transcript', title: 'Інтерв’ю 1 — менеджерка (синтетичне)', content: TRANSCRIPT_TEXT, origin: 'demo_script', required: true });
    const head = headVersion(db, c.id);
    const v = insertVersion(db, {
      caseId: c.id, content: demoContent(req.id, tr.id), createdBy: 'demo_script', actorName: 'Демо-сценарій',
      parentId: head.id, covered: [req.id, tr.id], owned: [],
      note: 'Версія заготовлена сценарієм демо (не результат AI). Питання Q1 і Q2 задані сценарієм.',
    });
    setHeadForSeed(db, c.id, v.id);
    audit(db, c.id, SEED_ACTOR, 'demo_case_seeded', { version_id: v.id });
    return c.id;
  });
}
