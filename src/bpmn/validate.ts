/**
 * Перевірка входу генератора (технічний план §1а, D21, D27, D28).
 * Це другий рубіж: доменний шар уже блокує погодження таких версій, але генератор не довіряє нікому
 * і сам відмовляє з конкретним поясненням замість того, щоб мовчки губити частину процесу.
 *
 *  • K1 / INVALID_INPUT — блокують побудову (невизначеність потоку; некоректний вхід);
 *  • UNSUPPORTED — потрібна нотація поза підтримуваним переліком (D21): схему не будуємо й не спрощуємо;
 *  • K2 — відомі некритичні обмеження: лише фіксуються й показуються, побудову не блокують.
 */
import { UNKNOWN, type Content, type Step } from '../schema.ts';
import { notationIssues, transitionIssues, unknownTransitions } from '../domain.ts';
import { MAX_STEP_ID, STEP_ID_RE } from './ids.ts';
import { MAX_LABEL_CHARS, TO_DEFINE_RE, textProblem } from './text.ts';
import { poolNameOf, type ApprovedPackage, type Finding, type UnsupportedKind } from './types.ts';

const clip = (t: string, n = 40): string => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
const stepRef = (s: Pick<Step, 'id' | 'action'>): string => `${s.id} («${clip(s.action)}»)`;

const KIND_LABEL: Record<UnsupportedKind, { title: string; element: string }> = {
  parallel_branches: { title: 'паралельні гілки', element: 'паралельний шлюз (parallelGateway)' },
  timer: { title: 'таймер / очікування за часом', element: 'проміжна подія-таймер (timerEvent)' },
  message: { title: 'повідомлення між учасниками', element: 'подія повідомлення та потік повідомлень (messageEvent / messageFlow)' },
  subprocess: { title: 'підпроцес', element: 'підпроцес (subProcess)' },
  boundary_event: { title: 'гранична подія', element: 'гранична подія (boundaryEvent)' },
  data_object: { title: 'артефакт даних', element: 'об’єкт чи сховище даних (dataObject / dataStore)' },
  multiple_entry: { title: 'кілька точок входу', element: 'кілька початкових подій' },
  other: { title: 'інша непідтримувана нотація', element: 'елемент BPMN поза переліком v1' },
};

export interface Analysis {
  blocking: Finding[];
  unsupported: Finding[];
  /** K2: відомі обмеження, що не блокують. */
  knownLimits: Finding[];
}

export function analyzePackage(pkg: ApprovedPackage): Analysis {
  const blocking: Finding[] = [];
  const unsupported: Finding[] = [];
  const knownLimits: Finding[] = [];
  const bad = (code: string, message: string, refs: string[] = [], cls: Finding['class'] = 'INVALID_INPUT'): void => {
    blocking.push({ code, class: cls, message, refs });
  };
  const k1 = (code: string, message: string, refs: string[] = []): void => bad(code, message, refs, 'K1');

  // ── прив'язка до версії ──
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(pkg.versionId)) {
    bad('INVALID_BINDING', `ID версії «${clip(String(pkg.versionId), 60)}» некоректний: схема має бути прив’язана до конкретної погодженої версії.`);
  }
  if (!/^[0-9a-f]{64}$/.test(pkg.contentHash)) {
    bad('INVALID_BINDING', 'Хеш погодженої версії відсутній або має неправильний формат (очікується SHA-256, 64 шістнадцяткові символи).');
  }

  const c: Content = pkg.content;
  const steps = c.steps;

  // ── тексти ──
  const checkLabel = (value: string, where: string, refs: string[], allowEmpty = true): void => {
    const p = textProblem(value);
    if (p) bad('INVALID_TEXT', `${where} ${p}. Виправте текст у погодженому описі — схема переносить текст дослівно.`, refs);
    if (!allowEmpty && value.trim() === '') bad('EMPTY_TEXT', `${where} порожній.`, refs);
    if (TO_DEFINE_RE.test(value)) {
      k1('TO_DEFINE', `${where} містить «[TO DEFINE …]» — невизначене місце не може потрапити на схему.`, refs);
    }
    if (value.length > MAX_LABEL_CHARS) {
      unsupported.push({
        code: 'LABEL_TOO_LONG', class: 'UNSUPPORTED', refs,
        message: `${where} має ${value.length} символів (межа розбірливого підпису — ${MAX_LABEL_CHARS}). Підпис не буде скорочено: це обмеження генератора, а не помилка опису.`,
      });
    }
  };
  // назва процесу = напис на єдиному пулі (D62); назву кейсу не підставляємо ніколи
  const poolName = poolNameOf(pkg);
  if (!poolName.trim()) {
    k1('PROCESS_NAME_MISSING', 'Назву процесу в погодженій версії не зазначено: вона потрібна для напису на пулі. Назву кейсу в схему не підставляємо. Потрібне явне уточнення: вкажіть назву процесу — буде створено нову версію, яку треба прийняти й погодити.');
  } else {
    checkLabel(poolName, 'Назва процесу (напис на пулі)', []);
  }
  checkLabel(c.boundaries.trigger, 'Тригер процесу (назва початкової події)', []);
  if (c.boundaries.trigger.trim() === '') {
    knownLimits.push({ code: 'START_UNNAMED', class: 'K2', refs: [], message: 'Тригер процесу порожній: початкова подія на схемі буде без назви.' });
  }

  // ── ролі ──
  if (c.roles.length === 0) bad('NO_ROLES', 'У погодженому описі немає жодної ролі: нема з чого побудувати доріжки.');
  const roleCount = new Map<string, number>();
  for (const r of c.roles) {
    checkLabel(r, `Роль «${clip(r)}»`, [], false);
    roleCount.set(r, (roleCount.get(r) ?? 0) + 1);
  }
  for (const [r, n] of roleCount) {
    if (n > 1) bad('DUPLICATE_ROLE', `Роль «${clip(r)}» зазначено ${n} рази: на кожну роль має бути одна доріжка.`);
  }

  // ── кроки ──
  if (steps.length === 0) bad('NO_STEPS', 'У погодженому описі немає жодного кроку.');
  const byId = new Map<string, Step>();
  const seenIds = new Set<string>();
  for (const s of steps) {
    if (s.id.length > MAX_STEP_ID || !STEP_ID_RE.test(s.id)) {
      bad('BAD_STEP_ID', `ID кроку «${clip(s.id)}» не можна використати в ID елемента схеми: дозволені лише латинські літери, цифри, «_» і «-», починати треба з літери.`, [s.id]);
    }
    if (s.id === 'END' || s.id === UNKNOWN) {
      bad('RESERVED_STEP_ID', `ID кроку «${s.id}» зарезервований (означає завершення чи «невідомо»): перейменуйте крок.`, [s.id]);
    }
    if (seenIds.has(s.id)) {
      bad('DUPLICATE_STEP_ID', `ID кроку ${s.id} повторюється: пізніший крок затер би попередній. Кроки мають мати унікальні ID.`, [s.id]);
    }
    seenIds.add(s.id);
    byId.set(s.id, s);
  }
  for (const s of steps) {
    const refs = [s.id];
    checkLabel(s.action, `Дія кроку ${s.id}`, refs, false);
    checkLabel(s.role, `Роль кроку ${s.id}`, refs, false);
    if (s.role.trim() !== '' && c.roles.length > 0 && !c.roles.includes(s.role)) {
      bad('STEP_UNKNOWN_ROLE', `Крок ${stepRef(s)}: роль «${clip(s.role)}» відсутня у списку ролей — крок не потрапить у жодну доріжку.`, refs);
    }
    if (s.next.length === 0) bad('STEP_NO_NEXT', `Крок ${stepRef(s)}: не вказано наступного кроку чи завершення (END) — глухий кут.`, refs);
    for (const nx of s.next) {
      checkLabel(nx.condition, `Умова переходу кроку ${s.id}`, refs);
      if (nx.to === UNKNOWN) continue; // окреме правило нижче
      if (nx.to !== 'END' && !byId.has(nx.to)) {
        bad('STEP_BAD_NEXT', `Крок ${stepRef(s)}: перехід до неіснуючого кроку «${clip(nx.to)}».`, refs);
      }
    }
    if (s.next.length > 1) {
      const empty = s.next.filter((nx) => nx.condition.trim() === '');
      if (empty.length) {
        k1('STEP_NO_CONDITION', `Крок ${stepRef(s)}: ${s.next.length} переходи, але ${empty.length} без умови — невідомо, коли який виконується (послідовно, паралельно чи взаємовиключно).`, refs);
      }
      const seen = new Map<string, string>();
      for (const nx of s.next) {
        if (nx.condition.trim() === '') continue;
        const prev = seen.get(nx.condition);
        if (prev !== undefined) {
          if (prev === nx.to) {
            bad('DUPLICATE_TRANSITION', `Крок ${stepRef(s)}: однаковий перехід «${clip(nx.condition)}» → ${nx.to} записано двічі.`, refs);
          } else {
            k1('AMBIGUOUS_CONDITION', `Крок ${stepRef(s)}: умова «${clip(nx.condition)}» веде і до ${prev}, і до ${nx.to} — гілки неможливо розрізнити (умови мають бути взаємовиключними).`, refs);
          }
        }
        seen.set(nx.condition, nx.to);
      }
    } else if (s.next.length === 1 && s.next[0]!.condition.trim() !== '' && s.next[0]!.to !== UNKNOWN) {
      k1('SINGLE_CONDITIONAL_BRANCH', `Крок ${stepRef(s)}: єдиний перехід має умову «${clip(s.next[0]!.condition)}», а що буде в іншому випадку — не сказано. Це неоднозначність: схему не будуємо, потрібне уточнення опису.`, refs);
    }
  }

  // ── невизначені переходи, відкриті питання, пропозиції (K1; D20, D28) ──
  const unknownSteps = new Set<string>();
  for (const u of unknownTransitions(c)) {
    unknownSteps.add(u.step_id);
    const q = u.questions.length ? ` Питання: ${u.questions.map((x) => `${x.id} (${x.status === 'open' ? 'відкрите' : 'закрите'})`).join(', ')}.` : ' Питання про цей перехід немає.';
    k1('UNKNOWN_TRANSITION', `Крок ${u.step_id}: перехід ${u.condition ? `«${clip(u.condition)}»` : '(без умови)'} позначено «невідомо» — продовження процесу не з’ясовано, схему не будуємо.${q}`, [u.step_id]);
  }
  for (const s of steps) {
    if (!unknownSteps.has(s.id) && s.next.some((nx) => nx.to === UNKNOWN)) {
      k1('UNKNOWN_TRANSITION', `Крок ${s.id}: перехід позначено «невідомо» — схему не будуємо.`, [s.id]);
    }
  }
  for (const issue of transitionIssues(c)) {
    if (issue.code === 'CONTRADICTION' || issue.code === 'QUESTION_LINK_BROKEN') k1(issue.code, issue.message, issue.ref ? [issue.ref] : []);
  }
  for (const q of c.questions) {
    if (q.status === 'open' && q.critical) k1('CRITICAL_QUESTION', `Відкрите критичне питання ${q.id}: ${clip(q.text, 120)}`, [q.id]);
  }
  for (const p of c.step_proposals ?? []) {
    if (p.status === 'proposed') {
      k1('PENDING_STEP_PROPOSAL', `Пропозиція ${p.id} щодо кроку ${p.step_id} чекає на рішення аналітика: склад кроків може змінитися.`, [p.step_id]);
    }
  }

  // ── початок, досяжність, вихід (D27) — власна перевірка, без довіри до доменного шару ──
  const entry = c.entry_step_id ?? null;
  if (steps.length > 0) {
    if (!entry) {
      k1('ENTRY_MISSING', 'Початковий крок (entry_step_id) не визначено. Система не вибирає його за порядком рядків чи за «кроком без входу».');
    } else if (!byId.has(entry)) {
      k1('ENTRY_BAD_REF', `Початковий крок «${clip(entry)}» не існує серед кроків.`, [entry]);
    } else {
      const adj = new Map<string, string[]>();
      const hasEnd = new Set<string>();
      for (const s of steps) {
        const to: string[] = [];
        for (const nx of s.next) {
          if (nx.to === 'END') hasEnd.add(s.id);
          else if (byId.has(nx.to)) to.push(nx.to);
        }
        adj.set(s.id, to);
      }
      const reach = new Set<string>([entry]);
      const queue = [entry];
      while (queue.length) {
        const x = queue.shift()!;
        for (const t of adj.get(x) ?? []) if (!reach.has(t)) { reach.add(t); queue.push(t); }
      }
      const unreachable = steps.filter((s) => !reach.has(s.id));
      if (unreachable.length) {
        k1('STEP_UNREACHABLE', `Недосяжні від початкового кроку ${entry}: ${unreachable.map(stepRef).join(', ')}. Крок без вхідного переходу не стає початком — це помилка чи неповнота опису.`, unreachable.map((s) => s.id));
      }
      const rev = new Map<string, string[]>();
      for (const [from, tos] of adj) for (const t of tos) rev.set(t, [...(rev.get(t) ?? []), from]);
      const canExit = new Set<string>(hasEnd);
      const q2 = [...hasEnd];
      while (q2.length) {
        const x = q2.shift()!;
        for (const p of rev.get(x) ?? []) if (!canExit.has(p)) { canExit.add(p); q2.push(p); }
      }
      const stuck = steps.filter((s) => reach.has(s.id) && !canExit.has(s.id) && s.next.length > 0 && !s.next.some((nx) => nx.to === UNKNOWN));
      if (stuck.length) {
        k1('STEP_NO_EXIT', `Замкнений цикл або шлях без виходу до завершення (END): ${stuck.map(stepRef).join(', ')}.`, stuck.map((s) => s.id));
      }
    }
  }

  // ── непідтримувана нотація (D21, D61): лише ПІДТВЕРДЖЕНІ людиною вимоги зі змісту версії ──
  // Непідтверджена пропозиція агента не є встановленим фактом, але блокує (потрібне рішення); відхилена — ігнорується.
  for (const i of notationIssues(c)) {
    if (i.code === 'PENDING_NOTATION_PROPOSAL') k1(i.code, i.message, i.ref ? [i.ref] : []);
    else bad(i.code, i.message, i.ref ? [i.ref] : []);
  }
  const confirmed = (c.notation_requirements ?? []).filter((r) => r.status === 'confirmed' && byId.has(r.step_id));
  const byKind = new Map<UnsupportedKind, string[]>();
  for (const r of confirmed) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.step_id]);
  for (const [kind, ids] of byKind) {
    const info = KIND_LABEL[kind];
    const detail = confirmed.filter((r) => r.kind === kind).map((r) => `${r.step_id}: ${r.detail.trim()}${r.evidence_quote.trim() ? ` (джерело: «${clip(r.evidence_quote.trim(), 100)}»)` : ''}`).join('; ');
    unsupported.push({
      code: `UNSUPPORTED_${kind.toUpperCase()}`, class: 'UNSUPPORTED', refs: ids,
      message: `Потрібна нотація «${info.title}» — ${info.element}. Кроки: ${ids.map((id) => (byId.get(id) ? stepRef(byId.get(id)!) : id)).join(', ')}.${detail ? ` Що в описі: ${detail}.` : ''} Цю нотацію генератор v1 не підтримує.`,
    });
  }

  // ── K2: відомі некритичні обмеження ──
  for (const q of c.questions) {
    if (q.status === 'open' && !q.critical) {
      knownLimits.push({ code: 'OPEN_QUESTION', class: 'K2', refs: [q.id], message: `Відкрите некритичне питання ${q.id}: ${clip(q.text, 160)}` });
    }
  }
  for (const h of c.hypotheses) {
    if (h.status === 'open') knownLimits.push({ code: 'OPEN_HYPOTHESIS', class: 'K2', refs: [h.id], message: `Відкрита гіпотеза ${h.id}: ${clip(h.text, 160)}` });
  }
  for (const p of c.problems) {
    if (p.impact_is_estimate) knownLimits.push({ code: 'ESTIMATE', class: 'K2', refs: [p.id], message: `Проблема ${p.id}: вплив — оцінка, а не виміряна метрика.` });
  }
  if (c.conflicts.length) {
    knownLimits.push({ code: 'CONFLICTS', class: 'K2', refs: [], message: `Є конфлікти між правками (${c.conflicts.length}); на потік вони не впливають.` });
  }
  const unusedRoles = c.roles.filter((r) => !steps.some((s) => s.role === r));
  for (const r of unusedRoles) {
    knownLimits.push({ code: 'ROLE_WITHOUT_STEPS', class: 'K2', refs: [], message: `Роль «${clip(r)}» не має жодного кроку: доріжка створена, але порожня.` });
  }
  knownLimits.push({
    code: 'FIELDS_NOT_ON_DIAGRAM', class: 'K2', refs: [],
    message: 'Поля кроку «результат», «умова входу», «вхідний артефакт», «джерела» на схемі не показуються: вони лишаються в погодженому описі й у карті «крок ↔ елемент».',
  });

  return { blocking, unsupported, knownLimits };
}

/** Пояснення обмеження для статусу `unsupported` (D21): що лишилося без відображення і які є варіанти. */
export function unsupportedExplanation(findings: Finding[], pkg: ApprovedPackage): string {
  const stepIds = [...new Set(findings.flatMap((f) => f.refs))];
  return [
    'Побудову схеми зупинено: погоджений опис потребує нотації, яку генератор цієї версії не підтримує. Схему не створено, процес не спрощено й не замінено «найближчим» елементом.',
    ...findings.map((f) => `• ${f.message}`),
    `Без відображення лишилися вимоги кроків: ${stepIds.join(', ') || '—'}. Погоджений AS-IS (версія ${pkg.versionId}) не змінено, його погодження чинне.`,
    'Варіанти для аналітика: (1) залишити це текстовою приміткою до кроку в описі; (2) попросити розширити підтримку генератора; (3) свідомо спростити опис і погодити нову версію.',
  ].join('\n');
}
