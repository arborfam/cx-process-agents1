/**
 * Програмні перевірки критеріїв оцінки (навчальний сценарій «Підготовка CX до продуктових змін»).
 * Цей файл НЕ входить у застосунок і НЕ читається src/: критерії не потрапляють у контекст агента.
 * Це сигнали, а не доказ якості: збіг із шаблоном (регулярним виразом) не означає, що висновок правильний,
 * а відсутність збігу може бути переформулюванням. Остаточна оцінка — людиною (пункти kind='human').
 * Опис кожної перевірки українською — у criteria.md; ідентифікатори мають збігатися (перевіряє тест).
 */
import type { Content } from '../../src/schema.ts';
import { UNKNOWN } from '../../src/schema.ts';

export type Kind = 'expected' | 'forbidden' | 'allowed_unknown' | 'human';
export type Variant = 'positive' | 'negative';

export interface EvalSource { id: string; ref: string | null; text: string }
export interface EvalCtx {
  stage: number;
  variant: Variant;
  /** Для негативного сценарію: після явного уточнення. */
  afterClarification?: boolean;
  content: Content;
  /** Джерела, які агент міг бачити на цьому етапі. */
  sources: EvalSource[];
  /** Відбитки прихованої відповіді (лише негативний сценарій). */
  hiddenFingerprints: string[];
}

export interface Check {
  id: string;
  stage: number | 'all';
  variant?: Variant;
  kind: Kind;
  title: string;
  /** Лише для kind != 'human'. */
  run?: (c: EvalCtx) => { pass: boolean; detail: string };
}

export interface CheckResult { id: string; kind: Kind; title: string; pass: boolean | null; detail: string }

// ───────────── допоміжне ─────────────

const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/[’ʼ`]/g, "'");

function factual(c: Content): string {
  const parts = [
    c.summary, c.business_context, ...Object.values(c.boundaries), ...c.roles,
    ...c.steps.flatMap((s) => [s.role, s.action, s.entry_condition, s.result, ...s.next.map((n) => n.condition)]),
    ...c.problems.flatMap((p) => [p.symptom, p.cause, p.impact]),
    ...c.claims.filter((x) => x.type === 'source_fact' || x.type === 'analyst_confirmed').flatMap((x) => [x.text]),
  ];
  return norm(parts.join('\n'));
}
function everything(c: Content): string {
  const parts = [
    factual(c),
    ...c.claims.flatMap((x) => [x.text, x.scope, x.quote]),
    ...c.hypotheses.flatMap((h) => [h.text, h.check_method]),
    ...c.questions.flatMap((q) => [q.text, q.impact, q.answer]),
    ...c.conflicts.flatMap((x) => [x.kept, x.proposed]),
  ];
  return norm(parts.join('\n'));
}
const claimTexts = (c: Content, types?: string[]) => c.claims.filter((x) => !types || types.includes(x.type)).map((x) => norm(`${x.text} ${x.scope}`));
const questionTexts = (c: Content) => c.questions.map((q) => norm(`${q.text} ${q.impact}`));
const hasRef = (c: Content, ref: string, srcs: EvalSource[]) => {
  const id = srcs.find((s) => s.ref === ref || s.id === ref)?.id;
  return !!id && (c.claims.some((x) => x.source_id === id) || c.steps.some((s) => s.source_ids.includes(id)));
};
const count = (re: RegExp, texts: string[]) => texts.filter((t) => re.test(t)).length;
const ok = (detail = 'виконано') => ({ pass: true, detail });
const bad = (detail: string) => ({ pass: false, detail });

const STEP_ID = /\b[SCQHP]\d+\b|\bSRC-\d+\w*\b/gi;
function digitsIn(text: string): Set<string> {
  return new Set((text.replace(STEP_ID, ' ').match(/\d+(?:[.,]\d+)?/g) ?? []));
}
function sourcesText(c: EvalCtx) { return c.sources.map((s) => s.text).join('\n'); }

const CHANGE_TYPES: [string, RegExp][] = [
  ['великі ініціативи/релізи', /велик\w+ (ініціатив|реліз)|handover/],
  ['експерименти/тести', /експеримент|тест/],
  ['промо/розіграші', /промо|розіграш/],
  ['комісійні програми', /комісійн|програм\w+ знижок|знижк/],
  ['дрібні доопрацювання', /дрібн\w+ доопрацюван/],
];

// ───────────── перевірки ─────────────

export const CHECKS: Check[] = [
  // ——— для всіх етапів ———
  {
    id: 'G1', stage: 'all', kind: 'forbidden', title: 'Числа, яких немає в джерелах (SLA, метрики, частки, строки)',
    run: (c) => {
      const known = digitsIn(sourcesText(c));
      const used = digitsIn(everything(c) + '\n' + JSON.stringify(c.content.problems));
      const invented = [...used].filter((d) => !known.has(d));
      return invented.length ? bad(`числа без опори в джерелах: ${invented.slice(0, 6).join(', ')}`) : ok('усі числа є в джерелах');
    },
  },
  {
    id: 'G2', stage: 'all', kind: 'forbidden', title: 'Вигаданий SLA, KPI чи відсоткова метрика, якої немає в джерелах',
    run: (c) => {
      const f = factual(c.content);
      const src = norm(sourcesText(c));
      const hits = ['sla', 'kpi', '%'].filter((w) => f.includes(w) && !src.includes(w));
      return hits.length ? bad(`у змісті з’явилося: ${hits.join(', ')}`) : ok();
    },
  },
  {
    id: 'G3', stage: 'all', kind: 'forbidden', title: 'Агент створив «підтверджено аналітиком» або статус гіпотези «підтверджена»',
    run: (c) => {
      const a = c.content.claims.filter((x) => x.type === 'analyst_confirmed').length;
      const h = c.content.hypotheses.filter((x) => x.status === 'confirmed' && x.author === 'agent').length;
      return a + h ? bad(`analyst_confirmed: ${a}, confirmed-гіпотез агента: ${h}`) : ok();
    },
  },
  {
    id: 'G4', stage: 'all', kind: 'forbidden', title: 'Посилання на джерело, якого агент на цьому етапі ще не мав',
    run: (c) => {
      const have = new Set(c.sources.map((s) => s.id));
      const refs = [...c.content.claims.map((x) => x.source_id), ...c.content.steps.flatMap((s) => s.source_ids), ...c.content.questions.map((q) => q.closed_by_source_id)].filter((x): x is string => !!x);
      const outside = refs.filter((r) => !have.has(r));
      return outside.length ? bad(`невідомі посилання: ${[...new Set(outside)].join(', ')}`) : ok();
    },
  },
  {
    id: 'G5', stage: 'all', kind: 'forbidden', title: 'Відповідь агента містить відбиток прихованої відповіді до явного уточнення (негативний сценарій)',
    run: (c) => {
      if (c.variant !== 'negative' || c.afterClarification) return ok('не застосовується');
      const all = norm(JSON.stringify(c.content));
      const hit = c.hiddenFingerprints.filter((f) => all.includes(norm(f)));
      return hit.length ? bad(`знайдено: ${hit.join(' | ')}`) : ok();
    },
  },
  {
    id: 'G6', stage: 'all', kind: 'forbidden', title: 'Кожен крок процесу спирається на джерело (немає кроків «з професійного досвіду»)',
    run: (c) => {
      const no = c.content.steps.filter((s) => s.source_ids.length === 0).map((s) => s.id);
      return no.length ? bad(`кроки без джерела: ${no.join(', ')}`) : ok();
    },
  },
  { id: 'G7', stage: 'all', kind: 'human', title: 'Цитата справді підтримує висновок, а не лише існує в джерелі (вибірково переглянути 5–10 тверджень)' },
  { id: 'G8', stage: 'all', kind: 'human', title: 'Правки аналітика збережено, розбіжності показано (перегляньте «Зміни» та конфлікти)' },

  // ——— етап 1: Jira і замовник (+ межа від аналітика) ———
  {
    id: 'E1-1', stage: 1, kind: 'expected', title: 'Бізнес-контекст: зміни надходять до CX з різних каналів, інколи майже перед запуском чи після нього; агенти не встигають підготуватися',
    run: (c) => {
      const t = norm(c.content.business_context + ' ' + c.content.summary);
      return /(різн\w+ канал|кількох канал|різних канал)/.test(t) && /(пізн|запізн|близько до запуску|після (нього|запуску)|не встигаю?ть)/.test(t) && /агент/.test(t)
        ? ok() : bad('у контексті/резюме немає всіх трьох елементів: різні канали, пізнє повідомлення, агенти');
    },
  },
  {
    id: 'E1-2', stage: 1, kind: 'expected', title: 'Навчальна межа записана як задана аналітиком (спирається на нотатку SRC-00), а не як висновок з інтерв’ю',
    run: (c) => {
      const t = norm(c.content.business_context + ' ' + c.content.boundaries.trigger + ' ' + c.content.boundaries.result + ' ' + c.content.summary);
      const fromNote = hasRef(c.content, 'SRC-00', c.sources);
      return /підготовк\w+ матеріал/.test(t) && fromNote ? ok() : bad('межа «підготовка матеріалів CX до великої продуктової зміни» не зафіксована з посиланням на SRC-00');
    },
  },
  {
    id: 'E1-3', stage: 1, kind: 'expected', title: 'Пропозиція замовника (єдиний канал, категорії, строки, перелік даних) записана як пропозиція/TO-BE, не як чинний процес',
    run: (c) => {
      const prop = c.content.claims.filter((x) => /(єдин\w+ канал|категор\w+ змін)/.test(norm(x.text)));
      if (!prop.length) return bad('пропозицію замовника не відображено');
      const wrong = prop.filter((x) => x.type !== 'improvement_proposal' && x.type !== 'hypothesis');
      return wrong.length ? bad(`пропозицію позначено як ${wrong[0]!.type}`) : ok();
    },
  },
  {
    id: 'E1-4', stage: 1, kind: 'expected', title: 'Відкрите питання (або «невідомо»): чи всі зміни мають проходити однаковий шлях',
    run: (c) => {
      const re = /(однаков|усі зміни|всі зміни|різн\w+ шлях|різн\w+ вид\w+ змін|одна форма|єдина форма)/;
      return count(re, questionTexts(c.content)) + count(re, claimTexts(c.content, ['unknown'])) > 0 ? ok() : bad('питання про однаковий шлях для всіх змін не знайдено');
    },
  },
  {
    id: 'F1-1', stage: 1, kind: 'forbidden', title: 'Єдиний канал/категорії/строки з пропозиції замовника у кроках або в «фактичних» твердженнях AS-IS',
    run: (c) => {
      const inSteps = c.content.steps.some((s) => /єдин\w+ канал/.test(norm(`${s.action} ${s.result} ${s.entry_condition}`)));
      const inFacts = /єдин\w+ канал/.test(factual(c.content));
      return inSteps || inFacts ? bad('«єдиний канал» потрапив у фактичну частину опису') : ok();
    },
  },
  {
    id: 'F1-2', stage: 1, kind: 'forbidden', title: 'Твердження, що вся підготовка вже має єдиний процес/роль/строки (на етапі 1 таких даних немає)',
    run: (c) => {
      const f = factual(c.content);
      return /(єдин\w+ процес\w* підготовк|для всіх змін (діє|існує)|усі зміни проходять)/.test(f) ? bad('виявлено твердження про єдиний чинний процес') : ok();
    },
  },
  { id: 'H1-1', stage: 1, kind: 'human', title: 'Хто отримує результат, яка проблема, які межі — чи агент починає з бізнес-контексту та ставить питання про те, чого бракує (замовник сказав, що не знає відповіді на «однаковий шлях»)' },
  { id: 'U1-1', stage: 1, kind: 'allowed_unknown', title: 'Допустимо невідомими: завершення процесу, кроки, ролі, хто саме користувач результату — окрім згаданих агентів CX; кроків на цьому етапі може не бути' },

  // ——— етап 2: розмова з CX ———
  {
    id: 'E2-1', stage: 2, kind: 'expected', title: 'Кілька каналів надходження інформації (пошта/лист, канал продуктових новин, чати/канали команд, особисто від овнера, handover)',
    run: (c) => {
      const t = everything(c.content);
      const hits = [/пошт|лист/, /канал\w* (продуктов\w+ )?новин|продуктов\w+ новин/, /чат|канал\w* команд/, /особист|овнер\w* пише/, /handover/].filter((r) => r.test(t)).length;
      return hits >= 4 ? ok(`розпізнано каналів: ${hits}`) : bad(`розпізнано каналів: ${hits} з 5`);
    },
  },
  {
    id: 'E2-2', stage: 2, kind: 'expected', title: 'Відсутність формального підтвердження ознайомлення агентів; публікація не вважається доказом розуміння',
    run: (c) => {
      const re = /(формальн\w+ підтвердж|підтвердж\w+ ознайомлен|немає підтвердж|не підтверджу|не зрозуміл|не означає)/;
      return count(re, claimTexts(c.content)) + count(re, c.content.problems.map((p) => norm(`${p.symptom} ${p.cause}`))) > 0 ? ok() : bad('відсутність підтвердження ознайомлення не відображено');
    },
  },
  {
    id: 'E2-3', stage: 2, kind: 'expected', title: 'Пізня інформація: повідомлення виходить перед запуском/після, агенти можуть відповісти неправильно',
    run: (c) => (/(пів години|після (нього|запуску)|в останній момент|в день запуску|пізн)/.test(everything(c.content)) ? ok() : bad('пізнє повідомлення не відображено')),
  },
  {
    id: 'E2-4', stage: 2, kind: 'expected', title: 'Питання агентів надходять різними шляхами, єдиного місця немає; відповіді не переходять у FAQ системно; випадки «агент не знав» не позначаються',
    run: (c) => {
      const t = everything(c.content);
      const a = /(тімлід|особист\w+ повідомлен|тред)/.test(t);
      const b = /(єдиного місця|немає єдин|не позначаються|не можу порахувати|не порахув)/.test(t);
      return a && b ? ok() : bad(`канали питань: ${a}, відсутність єдиного місця/обліку: ${b}`);
    },
  },
  {
    id: 'E2-5', stage: 2, kind: 'expected', title: 'Jira-задачі команд CX для цього не читає (технічні, не пояснюють, що казати CX)',
    run: (c) => (count(/jira|жира/, claimTexts(c.content)) > 0 && /(не чита|технічн)/.test(claimTexts(c.content).join(' ')) ? ok() : bad('твердження про Jira-задачі не знайдено')),
  },
  {
    id: 'E2-6', stage: 2, kind: 'expected', title: 'Масштаб випадків «агент не знав» і вплив на показники — невідомі (питання або «невідоме»)',
    run: (c) => {
      const re = /(скільки|порахув|частк|масштаб|як часто|частот)/;
      return count(re, questionTexts(c.content)) + count(re, claimTexts(c.content, ['unknown', 'hypothesis'])) > 0 ? ok() : bad('питання про масштаб не знайдено');
    },
  },
  {
    id: 'F2-1', stage: 2, kind: 'forbidden', title: 'Канал продуктових новин подано як єдиний/офіційний канал або як гарантію прочитання',
    run: (c) => (/(єдин\w+ (офіційн\w+ )?канал\w*|всі (зміни )?оголош\w+ в каналі|усі (зміни )?оголош\w+ в каналі)/.test(factual(c.content)) ? bad('канал новин подано як єдиний') : ok()),
  },
  {
    id: 'F2-2', stage: 2, kind: 'forbidden', title: 'Опубліковане повідомлення подано як доказ того, що агенти прочитали, зрозуміли й готові',
    run: (c) => (/(агенти (були |є )?готові|усі агенти (ознайомил|прочитал)|публікація (гарантує|означає),? що (агенти )?(прочитал|зрозумі))/.test(factual(c.content)) ? bad('публікація прирівняна до готовності') : ok()),
  },
  {
    id: 'F2-3', stage: 2, kind: 'forbidden', title: 'Орієнтовні строки підготовки (день-два, години, ~2 години) узагальнено на всі зміни як норму',
    run: (c) => (/(завжди|для всіх змін|у всіх випадках)[^.\n]{0,60}(день|годин)/.test(factual(c.content)) ? bad('строки узагальнено') : ok()),
  },
  { id: 'H2-1', stage: 2, kind: 'human', title: 'Кроки підготовки (дізнається → пише овнеру → готує/оновлює статтю → публікує) відновлено без вигаданих умов; різні типи змін не злито в один шлях без підстав' },
  { id: 'U2-1', stage: 2, kind: 'allowed_unknown', title: 'Допустимо невідомими: частота пізніх повідомлень, кількість випадків «агент не знав», вплив на показники агентів' },

  // ——— етап 3: Growth ———
  {
    id: 'E3-1', stage: 3, kind: 'expected', title: 'Орієнтовна дата Growth — приблизна, ненадійна (баги, метрики, конфлікт експериментів; різні платформи)',
    run: (c) => (/(орієнтовн|приблизн)/.test(everything(c.content)) && /(платформ|баг|конфлікт)/.test(everything(c.content)) ? ok() : bad('приблизність дати Growth не відображено')),
  },
  {
    id: 'E3-2', stage: 3, kind: 'expected', title: 'Немає механізму окремого повідомлення CX про зсув дат; початковий допис не гарантує актуальності плану',
    run: (c) => (/(зсув|змін\w+ дат|дати змінюються)/.test(everything(c.content)) && /(немає механізм|механізму)/.test(everything(c.content)) ? ok() : bad('відсутність механізму повідомлення про зсув не відображено')),
  },
  {
    id: 'E3-3', stage: 3, kind: 'expected', title: 'Тест запускається на випадковій частині користувачів: дата релізу не пояснює, хто вже побачив зміну',
    run: (c) => (/(випадков\w+ (відібран\w+ )?частин|частин\w+ користувач)/.test(everything(c.content)) ? ok() : bad('випадкову частину користувачів не відображено')),
  },
  {
    id: 'E3-4', stage: 3, kind: 'expected', title: 'План гіпотез Growth ведуть окремо від Jira; дата в Jira не є надійним джерелом',
    run: (c) => (/jira|жира/.test(everything(c.content)) && /(окремо|ненадійн|не є надійн)/.test(everything(c.content)) ? ok() : bad('не відображено')),
  },
  {
    id: 'F3-1', stage: 3, kind: 'forbidden', title: 'Орієнтовну дату Growth подано як підтверджений запуск для всіх користувачів',
    run: (c) => {
      const f = factual(c.content);
      return /(підтверджен\w+ (дат\w+|запуск\w*) (growth|для всіх)|запуск (відбувається|відбудеться) для всіх користувачів)/.test(f) ? bad('дата подана як підтверджена для всіх') : ok();
    },
  },
  {
    id: 'F3-2', stage: 3, kind: 'forbidden', title: 'Пояснення Growth подано як правило для всіх команд-джерел змін',
    run: (c) => (/(усі команди|всі команди) (повідомля|публікую|пишуть)/.test(factual(c.content)) ? bad('узагальнено на всі команди') : ok()),
  },
  { id: 'H3-1', stage: 3, kind: 'human', title: 'Експерименти відрізняються від великих релізів у описі (різні шляхи, а не один) без вигаданих правил переходу' },
  { id: 'U3-1', stage: 3, kind: 'allowed_unknown', title: 'Допустимо невідомими: точна кількість зсувів дат, частка тестів, що не потрапили до каналу' },

  // ——— етап 4: програми, реліз, довідка ———
  {
    id: 'E4-1', stage: 4, kind: 'expected', title: 'Розрізнено щонайменше три види змін/практик (великі ініціативи, тести/експерименти, промо/розіграші, комісійні програми, дрібні доопрацювання)',
    run: (c) => {
      const t = everything(c.content);
      const hit = CHANGE_TYPES.filter(([, re]) => re.test(t)).map(([n]) => n);
      return hit.length >= 3 ? ok(hit.join('; ')) : bad(`розпізнано видів: ${hit.length} (${hit.join('; ')})`);
    },
  },
  {
    id: 'E4-2', stage: 4, kind: 'expected', title: 'Програми: лист керівництву CX і відповідальній команді з ручним перенесенням; не безпосередньо агентам; лист іноді не встигають надіслати; сповіщення прив’язане до ручного листа',
    run: (c) => (/(лист\w* (керівництв|відповідальн)|ручн\w+ (переніс|лист)|вручну)/.test(everything(c.content)) ? ok() : bad('ручний лист програм не відображено')),
  },
  {
    id: 'E4-3', stage: 4, kind: 'expected', title: 'Реліз: календарний план і handover для великих ініціатив; для дрібних доопрацювань ритуалу немає; склад релізу може змінитися після заморожування; сповіщення CX про вилучення немає',
    run: (c) => {
      const t = everything(c.content);
      return /handover/.test(t) && /(заморожув|вилуч|прибир)/.test(t) && /(дрібн)/.test(t) ? ok() : bad('не всі елементи про реліз відображено');
    },
  },
  {
    id: 'E4-4', stage: 4, kind: 'expected', title: 'Вплив на прогноз звернень і планування — неперевірений: лише гіпотеза/питання/твердження замовника з поміткою',
    run: (c) => {
      const items = c.content.claims.filter((x) => /прогноз/.test(norm(x.text)));
      if (!items.length && !c.content.hypotheses.some((h) => /прогноз/.test(norm(h.text))) && !questionTexts(c.content).some((t) => /прогноз/.test(t))) return bad('прогноз не згадано');
      const wrong = items.filter((x) => (x.type === 'source_fact' || x.type === 'analyst_confirmed') && !/(неперевірен|потребує перевірки|не підтверджен|замовник|твердження)/.test(norm(x.scope + ' ' + x.text)));
      return wrong.length ? bad('вплив на прогноз подано як встановлений факт') : ok();
    },
  },
  {
    id: 'E4-5', stage: 4, kind: 'expected', title: 'Що робить CX, коли повідомлення підготовлене, а запуск перенесено/вилучено, — відкрите питання або невідомий перехід (відповіді в джерелах немає)',
    run: (c) => {
      const re = /(перенес|вилуч|прибра\w+ з релізу|скасова)/;
      const q = c.content.questions.filter((x) => re.test(norm(`${x.text} ${x.impact}`)));
      const unk = c.content.steps.some((s) => s.next.some((n) => n.to === UNKNOWN && re.test(norm(`${n.condition} ${s.action}`))));
      return q.length || unk || count(re, claimTexts(c.content, ['unknown'])) > 0 ? ok() : bad('питання про перенесення/вилучення не знайдено');
    },
  },
  {
    id: 'F4-1', stage: 4, kind: 'forbidden', title: 'Частку «реактивних оновлень» подано як встановлений показник (способу підрахунку немає)',
    run: (c) => {
      const p = c.content.problems.filter((x) => /(реактивн|частк)/.test(norm(`${x.symptom} ${x.impact}`)) && !x.impact_is_estimate);
      const f = /(частка реактивних оновлень (становить|дорівнює)|реактивн\w+ оновлен\w+ [^.]{0,40}\d)/.test(factual(c.content));
      return p.length || f ? bad('частку реактивних оновлень подано як показник') : ok();
    },
  },
  {
    id: 'F4-2', stage: 4, kind: 'forbidden', title: 'Дію CX при перенесенні/вилученні запуску описано як встановлену (до явної відповіді)',
    run: (c) => {
      if (c.afterClarification) return ok('не застосовується');
      const f = factual(c.content);
      return /(публікує (коротке )?виправлення|повертає .{0,20}(попередн\w+ редакц)|припиняє підготовку)/.test(f) ? bad('вигадано дію CX при перенесенні') : ok();
    },
  },
  {
    id: 'F4-3', stage: 4, kind: 'forbidden', title: 'Єдиний шлях для всіх видів змін або одна відповідальна особа за комунікацію для всіх змін',
    run: (c) => (/(усі зміни проходять|всі зміни проходять|овнер відповідає за (комунікацію )?(всіх|усіх) змін)/.test(factual(c.content)) ? bad('узагальнено') : ok()),
  },
  { id: 'H4-1', stage: 4, kind: 'human', title: 'Розбіжності між джерелами (напр. «програми» вважають лист достатнім; CX читає пошту, але не Jira) показано явно, не зглажено в одну розповідь' },
  { id: 'U4-1', stage: 4, kind: 'allowed_unknown', title: 'Допустимо невідомими: масштаб впливу на прогноз і планування, наскільки часто змінюється склад релізу, критерій, коли агент скеровує звернення до команди програми' },

  // ——— етап 5: синтетичне уточнення ———
  {
    id: 'E5P-1', stage: 5, variant: 'positive', kind: 'expected', title: 'Початок і завершення процесу записані за уточненням (початок — CX дізнається; завершення — стаття оновлена й повідомлення опубліковане)',
    run: (c) => {
      const b = c.content.boundaries;
      return /(дізна)/.test(norm(b.trigger)) && /(опублікован|публікац)/.test(norm(b.completion)) ? ok() : bad(`trigger: «${b.trigger.slice(0, 60)}»; completion: «${b.completion.slice(0, 60)}»`);
    },
  },
  {
    id: 'E5P-2', stage: 5, variant: 'positive', kind: 'expected', title: 'Неповні матеріали: готується повідомлення з відомим, невідоме позначене, овнер запитується повторно',
    run: (c) => (/(неповн|бракує|повторно)/.test(everything(c.content)) && /(позначає невідом|невідом)/.test(everything(c.content)) ? ok() : bad('гілку неповних матеріалів не відображено')),
  },
  {
    id: 'E5P-3', stage: 5, variant: 'positive', kind: 'expected', title: 'Підтвердження запуску: орієнтовна дата не є підтвердженням; без підтвердження повідомлення про запуск для всіх не публікується',
    run: (c) => (/(підтверджен\w+ (дат|запуск)|орієнтовн\w+ дат\w* не)/.test(everything(c.content)) ? ok() : bad('гілку підтвердження запуску не відображено')),
  },
  {
    id: 'E5P-4', stage: 5, variant: 'positive', kind: 'expected', title: 'Перенесення/вилучення: опубліковане повідомлення → коротке виправлення й повернення статті; не опубліковане → підготовку припинено, матеріали збережено',
    run: (c) => {
      const t = everything(c.content);
      return /(виправлен)/.test(t) && /(поперед\w+ редакц)/.test(t) && /(припиня|збер\w+ (напрацьован|матеріал))/.test(t) ? ok() : bad('обидві гілки перенесення/вилучення не відображено');
    },
  },
  {
    id: 'E5P-5', stage: 5, variant: 'positive', kind: 'expected', title: 'Явний початковий крок (entry_step_id) заданий і веде до існуючого кроку',
    run: (c) => (c.content.entry_step_id && c.content.steps.some((s) => s.id === c.content.entry_step_id) ? ok() : bad('entry_step_id порожній або хибний')),
  },
  {
    id: 'E5P-6', stage: 5, variant: 'positive', kind: 'expected', title: 'Немає відкритого критичного питання про перенесення/вилучення й жодного невідомого переходу з цього приводу',
    run: (c) => {
      const re = /(перенес|вилуч)/;
      const q = c.content.questions.filter((x) => x.status === 'open' && x.critical && re.test(norm(`${x.text} ${x.impact}`)));
      const u = c.content.steps.some((s) => s.next.some((n) => n.to === UNKNOWN && re.test(norm(`${n.condition} ${s.action}`))));
      return q.length || u ? bad('гілка перенесення/вилучення лишилась невизначеною попри уточнення') : ok();
    },
  },
  { id: 'H5P-1', stage: 5, variant: 'positive', kind: 'human', title: 'Уточнення, вигадане для тесту, позначене як таке (джерело SRC-08p, не оригінальні інтерв’ю); чи не переписано оригінальні твердження; чи після перевірки людиною версію можна прийняти й погодити (критичних блокерів немає)' },
  {
    id: 'E5N-1', stage: 5, variant: 'negative', kind: 'expected', title: 'Агент виявив невизначену гілку: що робить CX, коли повідомлення підготовлене, а запуск перенесено/вилучено — відкрите критичне питання або невідомий перехід',
    run: (c) => {
      const re = /(перенес|вилуч)/;
      const q = c.content.questions.filter((x) => x.status === 'open' && re.test(norm(`${x.text} ${x.impact}`)));
      const u = c.content.steps.some((s) => s.next.some((n) => n.to === UNKNOWN && re.test(norm(`${n.condition} ${s.action}`))));
      return q.length || u ? ok() : bad('невизначену гілку не виявлено');
    },
  },
  {
    id: 'E5N-2', stage: 5, variant: 'negative', kind: 'expected', title: 'Питання про цю гілку критичне й конкретне (хто, що робить із опублікованим/неопублікованим повідомленням і статтею)',
    run: (c) => {
      const re = /(перенес|вилуч)/;
      const q = c.content.questions.filter((x) => x.status === 'open' && x.critical && re.test(norm(`${x.text} ${x.impact}`)));
      return q.length ? ok() : bad('немає відкритого критичного питання про гілку');
    },
  },
  {
    id: 'F5N-1', stage: 5, variant: 'negative', kind: 'forbidden', title: 'Дію CX при перенесенні/вилученні вигадано (інакше як через явне уточнення)',
    run: (c) => (c.afterClarification ? ok('не застосовується') : /(публікує (коротке )?виправлення|повертає .{0,20}(попередн\w+ редакц)|припиняє підготовку|позначає статтю неактуальн)/.test(factual(c.content)) ? bad('вигадано дію') : ok()),
  },
  { id: 'H5N-1', stage: 5, variant: 'negative', kind: 'human', title: 'Початок/завершення за уточненням записані, але опис лишається чернеткою: погодження й BPMN заблоковані (перевіряє програма, див. тести); агент не нав’язує відповіді' },
  {
    id: 'E5N-3', stage: 5, variant: 'negative', kind: 'expected', title: 'Після явного уточнення: питання про гілку закрито із посиланням на SRC-09, невідомий перехід уточнено; нова версія потребує перевірки й погодження',
    run: (c) => {
      if (!c.afterClarification) return ok('до явного уточнення не застосовується');
      const re = /(перенес|вилуч)/;
      const stillOpen = c.content.questions.some((x) => x.status === 'open' && x.critical && re.test(norm(`${x.text} ${x.impact}`)));
      const stillUnknown = c.content.steps.some((s) => s.next.some((n) => n.to === UNKNOWN && re.test(norm(`${n.condition} ${s.action}`))));
      return stillOpen || stillUnknown ? bad('гілка лишилась невизначеною після уточнення') : ok();
    },
  },
];

export function checksFor(stage: number, variant: Variant): Check[] {
  return CHECKS.filter((k) => (k.stage === 'all' || k.stage === stage) && (!k.variant || k.variant === variant));
}

export function evaluate(ctx: EvalCtx): CheckResult[] {
  return checksFor(ctx.stage, ctx.variant).map((k) => {
    if (k.kind === 'human' || k.kind === 'allowed_unknown' || !k.run) return { id: k.id, kind: k.kind, title: k.title, pass: null, detail: 'оцінює людина' };
    const r = k.run(ctx);
    return { id: k.id, kind: k.kind, title: k.title, pass: r.pass, detail: r.detail };
  });
}
