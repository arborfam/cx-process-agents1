import { canonical } from '../hash.ts';
import { UNKNOWN, type Content, type LinkKindT } from '../schema.ts';
import type { Violation } from './verify.ts';

/**
 * Самоузгодженість ВИХОДУ агента 1 (зріз T0, D68; часткове уточнення — D70). Відхиляє те, що агент зробив суперечливим САМ, і лишає допустимою незавершеність:
 * невідоме, невизначений напрямок із питанням, невідому альтернативу, непідтверджену послідовність, порожній початок.
 * Перевіряються лише НОВІ або ЗМІНЕНІ агентом елементи: стара історія й правки аналітика не карають.
 * Це детерміновані правила (без моделі); вони не оцінюють змістову правильність висновків.
 */

/** Довша назва дії піде підписом на схему й не читається; деталі мають бути в полі «деталі». */
export const MAX_ACTION_CHARS = 160;
const QREF = /\bQ\d+\b/;
const kindOf = (a: { kind?: LinkKindT }): LinkKindT => a.kind ?? 'direction';

/**
 * Відпечаток ОПИСУ кроку — лише поля, які людина читає як опис дії. `source_ids` і цілі переходів (`to`)
 * сюди не входять: це службові та структурні поля, і їхня зміна нічого не каже про актуальність опису (D73).
 */
const descriptionOf = (s: { role: string; action: string; entry_condition: string; input_artifact: string; result: string; details?: string; next: { condition: string }[] }): string =>
  canonical([s.role, s.action, s.entry_condition, s.input_artifact, s.result, s.details ?? '', s.next.map((n) => n.condition)]);

export function selfConsistency(base: Content, out: Content): { violations: Violation[]; warnings: string[] } {
  const v: Violation[] = [];
  const warnings: string[] = [];
  const baseStep = new Map(base.steps.map((s) => [s.id, canonical(s)]));
  const baseQ = new Map(base.questions.map((q) => [q.id, canonical(q)]));
  const changedStep = new Set(out.steps.filter((s) => baseStep.get(s.id) !== canonical(s)).map((s) => s.id));
  const stepById = new Map(out.steps.map((s) => [s.id, s]));

  // Чи існував цей зв'язок у ВХІДНІЙ версії (тобто його створила не ця відповідь).
  const baseStepById = new Map(base.steps.map((s) => [s.id, s]));
  const baseQById = new Map(base.questions.map((q) => [q.id, q]));
  const linkInBase = (qid: string, a: { step_id: string; condition: string }): boolean =>
    (baseQById.get(qid)?.affects_transitions ?? []).some((l) => l.step_id === a.step_id && l.condition === a.condition);
  /**
   * Чи був цей зв'язок РОЗІРВАНИЙ уже у вхідній версії: він там був, а переходу (чи кроку) з такою умовою
   * там не було. Тоді це не самосуперечність ЦІЄЇ відповіді, і відхиляти її не можна (той самий принцип,
   * що у D73): програма позначає місце для аналітикині. Прив'язку відкритого питання агент однаково не
   * переносить (`protectAnalystEdits`), тож відмова лишала б агента без жодного дозволеного виходу.
   */
  const linkWasBroken = (qid: string, a: { step_id: string; condition: string }): boolean => {
    if (!linkInBase(qid, a)) return false;
    const bs = baseStepById.get(a.step_id);
    if (!bs) return true;
    return !bs.next.some((n) => n.condition === a.condition);
  };

  // 1–3. Прив'язки питань до потоку й невідомі переходи.
  const openDirection = (stepId: string, cond: string) =>
    out.questions.some((q) => q.status === 'open' && (q.affects_transitions ?? []).some((a) => a.step_id === stepId && a.condition === cond && kindOf(a) === 'direction'));
  for (const q of out.questions) {
    if (q.status !== 'open') continue;
    const qChanged = baseQ.get(q.id) !== canonical(q);
    for (const a of q.affects_transitions ?? []) {
      if (!qChanged && !changedStep.has(a.step_id)) continue;
      const kind = kindOf(a);
      const path = `questions (${q.id}) → крок ${a.step_id}`;
      const step = stepById.get(a.step_id);
      if (!step) {
        if (linkWasBroken(q.id, a)) {
          warnings.push(`Питання ${q.id} прив’язане до кроку ${a.step_id}, якого в опису немає, — так було вже у вхідній версії, не через цю відповідь. ` +
            'Програма прив’язку не змінює: виправити її може аналітикиня явним рішенням.');
          continue;
        }
        v.push({ code: 'LINK_BROKEN', path, message: `питання прив’язане до кроку ${a.step_id}, якого немає в повному результаті` });
        continue;
      }
      if (kind === 'step_detail') continue;
      const tr = step.next.find((n) => n.condition === a.condition);
      if (!tr) {
        // Що саме доступно в кроці — у повідомленні: інакше ні агент у повторній спробі, ні людина не бачать,
        // з чим саме не збіглась умова (умови порівнюються дослівно).
        const available = step.next.length
          ? `У кроці ${a.step_id} зараз такі переходи: ${step.next.map((n) => `«${n.condition}» → ${n.to}`).join('; ')}.`
          : `У кроці ${a.step_id} переходів немає жодного.`;
        if (linkWasBroken(q.id, a)) {
          warnings.push(`Питання ${q.id}: прив’язка до переходу з умовою «${a.condition}» у кроці ${a.step_id} не збігається з жодним переходом — ` +
            `зв’язок був розірваний уже у вхідній версії, не через цю відповідь. ${available} ` +
            'Прив’язку відкритого питання змінює лише аналітикиня явним рішенням; перевірте, чи питання ще стосується цього кроку.');
          continue;
        }
        v.push({ code: 'LINK_BROKEN', path, message:
          `питання прив’язане до переходу з умовою «${a.condition}», якого в кроці немає. ${available} ` +
          'Умова порівнюється дослівно, і порожня умова «» — це конкретний перехід (звичайна послідовність), а не «будь-який перехід». ' +
          'Перевірка виконується на ПОВНОМУ результаті, тому перехід має бути в тому кроці, який ти повертаєш (крок повертається з усіма своїми переходами). ' +
          (linkInBase(q.id, a)
            ? 'Цей зв’язок був у вхідній версії, а умову переходу змінила ця відповідь: поверни умову такою, якою вона була, ' +
              'або додай новий перехід, не прибираючи старого. Прив’язку відкритого питання агент не переносить і не знімає — це рішення аналітикині.'
            : (a.kind === undefined ? 'Вид прив’язки не зазначено, тому його прийнято як «direction». ' : '') +
              'Обери одне: (а) питання про зміст кроку — kind «step_detail», такий зв’язок переходу не потребує, і вигадувати перехід для нього не треба; ' +
              `(б) продовження справді невідоме — поверни крок із переходом «${UNKNOWN}» і прив’яжи питання до нього (kind «direction»); ` +
              '(в) питання про наявний перехід — вкажи його умову дослівно так, як вона записана в кроці.') });
        continue;
      }
      // Уже відомий невизначений перехід, який агент «закрив» без закриття питання, програма сама поверне в «невідомо» (протокол конфлікту) — це не нова самосуперечність.
      const wasUnknown = base.steps.find((x) => x.id === a.step_id)?.next.some((n) => n.condition === a.condition && n.to === UNKNOWN) ?? false;
      if (kind === 'direction' && tr.to !== UNKNOWN && !wasUnknown) {
        v.push({ code: 'LINK_DIRECTION_KNOWN_TARGET', path, message:
          `питання про напрямок, але перехід записано як відомий (→ ${tr.to}). Оберіть одне: (а) перехід справді невідомий — став «${UNKNOWN}»; ` +
          '(б) послідовність відома, але не підтверджена — kind «unconfirmed_sequence»; (в) невідомий лише виняток чи альтернатива — kind «exception»; ' +
          '(г) питання про зміст кроку — kind «step_detail». Не вигадуй напрямку, якого джерела не дають.' });
      } else if ((kind === 'unconfirmed_sequence' || kind === 'exception') && tr.to === UNKNOWN) {
        v.push({ code: 'LINK_KIND_UNKNOWN_TARGET', path, message: `перехід «${UNKNOWN}» пояснює лише питання про напрямок (kind «direction»), а не «${kind}»` });
      }
    }
  }
  for (const s of out.steps) {
    if (!changedStep.has(s.id)) continue;
    for (const n of s.next) {
      if (n.to === UNKNOWN && !openDirection(s.id, n.condition)) {
        v.push({ code: 'UNKNOWN_WITHOUT_DIRECTION_QUESTION', path: `steps (${s.id})`, message: `перехід «${UNKNOWN}» без відкритого питання про напрямок: додай питання з прив’язкою до цього переходу (kind «direction»)` });
      }
    }
    // 4. Умова — лише вибір гілки. Єдиний перехід із умовою (не в «невідомо») генератор відхиляє; результат кроку — у полі result.
    if (s.next.length === 1 && s.next[0]!.condition.trim() !== '' && s.next[0]!.to !== UNKNOWN) {
      v.push({ code: 'SEQUENTIAL_WITH_CONDITION', path: `steps (${s.id})`, message: 'єдиний вихідний перехід має умову. Для звичайної послідовності умову залиш порожньою (результат кроку — у полі result); умова потрібна лише там, де є вибір між гілками' });
    }
    // 5. Невизначеність живе в питаннях і твердженнях, а не в тексті кроку (текст піде на підписи схеми).
    for (const [field, text] of [['action', s.action], ['result', s.result], ['entry_condition', s.entry_condition], ['input_artifact', s.input_artifact], ['details', s.details ?? ''],
      ...s.next.map((n, i) => [`next[${i}].condition`, n.condition] as [string, string])] as [string, string][]) {
      if (QREF.test(text)) v.push({ code: 'UNCERTAINTY_IN_STEP_TEXT', path: `steps (${s.id}).${field}`, message: 'у тексті кроку є посилання на питання («див. Q…»); невизначеність записуй у питанні, а текст кроку лиши лише тим, що сказано в джерелах' });
    }
    // 6. Коротка назва дії; деталі, канали й приклади — окремо.
    if (s.action.length > MAX_ACTION_CHARS) {
      v.push({ code: 'ACTION_TOO_LONG', path: `steps (${s.id}).action`, message: `назва дії довша за ${MAX_ACTION_CHARS} символів (${s.action.length}); скороти її до короткої дії, а канали, приклади й виключення перенеси в поле «details»` });
    }
  }

  // 7. Місця для перевірки людиною після закритого питання (D70, переглянуто в D73).
  //
  // Раніше тут була безумовна ВІДМОВА, якщо об'єкт прив'язаного кроку не змінився. Незалежна перевірка показала,
  // що це міряло не те: підтвердження вже правильного опису відхилялось (хибна відмова з платним повтором),
  // а застарілий текст зі зміненими лише `source_ids` проходив (хибне приймання). Чи правильний опис тепер —
  // питання ЗМІСТУ, і звичайний код його не встановлює: ні незмінність тексту не доводить застарілості,
  // ні зміна тексту не доводить правильності. Тому тут ПОПЕРЕДЖЕННЯ для людини, назване чесно, а не блокування.
  // Вимога оновлювати опис лишається в інструкції агента (п. 12) і в критеріях (B11) — не в коді.
  for (const q of out.questions) {
    if (q.status !== 'closed' || !q.closed_by_source_id) continue;
    const b = base.questions.find((x) => x.id === q.id);
    if (!b || b.status !== 'open') continue; // закрите раніше — не наслідок цього запуску
    const linked = new Set([...(b.affects_transitions ?? []), ...(q.affects_transitions ?? [])].map((a) => a.step_id));
    for (const id of linked) {
      const was = baseStep.get(id);
      if (was === undefined) continue; // крок створено цим же запуском — попереднього опису не було
      const now = stepById.get(id);
      const old = base.steps.find((s) => s.id === id);
      if (!now || !old) continue;
      const changedText = descriptionOf(now) !== descriptionOf(old);
      const changedObject = canonical(now) !== was;
      const observed = changedText
        ? 'опис кроку змінено (програма порівняла лише текст і не перевіряє, чи він тепер правильний)'
        : changedObject
          ? 'змінились лише службові поля (джерела чи зв’язки) — опис кроку той самий; зміна службового поля актуальності опису не доводить'
          : 'опис кроку той самий (це може бути підтвердження вже правильного опису, а може бути застарілий текст)';
      warnings.push(`Питання ${q.id} закрито відповіддю з джерела, і воно стосувалось кроку ${id}: ${observed}. ` +
        'Перевірте, чи опис кроку відповідає відповіді: що вже з’ясовано (зі вказівкою, чиї це слова) і що лишилось невідомим. ' +
        'Якщо з’ясовано лише частину, питання має лишитись відкритим. Відкрита пропозиція вилучити чи замінити крок застарілий опис актуальним не робить.');
    }
  }

  // 8. Застаріла невизначеність (D70): твердження «невідоме» лишилось дослівно тим самим, а пояснення (scope) агент переписав.
  // Це попередження, а не відмова: справді невідоме має зберігатися, але аналітикиня має побачити місце, де частину вже з'ясовано.
  for (const bc of base.claims) {
    if (bc.type !== 'unknown') continue;
    const oc = out.claims.find((x) => x.id === bc.id);
    if (!oc || oc.type !== 'unknown') continue;
    if (oc.text === bc.text && oc.scope !== bc.scope) {
      warnings.push(`Твердження ${bc.id} («невідоме»): агент переписав пояснення, але саме твердження лишив дослівно тим самим. ` +
        'Перевірте, чи частину вже з’ясовано: складене «невідоме» розділяють на з’ясоване (з атрибуцією) і те, що лишилось невідомим.');
    }
  }

  // 9. Нові кроки, недосяжні від початку, заданого аналітикинею (початок агент не обирає), — попередження, а не відмова: чернетка може бути незавершеною.
  const entry = base.entry_step_id ?? null;
  if (entry && stepById.has(entry)) {
    const reach = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length) {
      const x = queue.shift()!;
      for (const n of stepById.get(x)?.next ?? []) if (stepById.has(n.to) && !reach.has(n.to)) { reach.add(n.to); queue.push(n.to); }
    }
    const covered = new Set((out.step_proposals ?? []).filter((p) => p.status === 'proposed').flatMap((p) => [p.step_id]));
    for (const s of out.steps) {
      if (!baseStep.has(s.id) && !reach.has(s.id) && !covered.has(s.id)) {
        warnings.push(`Новий крок ${s.id} недосяжний від початкового кроку ${entry}: чернетка допускає незавершеність, але крок лишиться прогалиною, доки його не з’єднано з потоком.`);
      }
    }
  }
  return { violations: v, warnings };
}
