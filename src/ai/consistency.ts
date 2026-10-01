import { canonical } from '../hash.ts';
import { UNKNOWN, type Content, type LinkKindT } from '../schema.ts';
import type { Violation } from './verify.ts';

/**
 * Самоузгодженість ВИХОДУ агента 1 (зріз T0, D68). Відхиляє те, що агент зробив суперечливим САМ, і лишає допустимою незавершеність:
 * невідоме, невизначений напрямок із питанням, невідому альтернативу, непідтверджену послідовність, порожній початок.
 * Перевіряються лише НОВІ або ЗМІНЕНІ агентом елементи: стара історія й правки аналітика не карають.
 * Це детерміновані правила (без моделі); вони не оцінюють змістову правильність висновків.
 */

/** Довша назва дії піде підписом на схему й не читається; деталі мають бути в полі «деталі». */
export const MAX_ACTION_CHARS = 160;
const QREF = /\bQ\d+\b/;
const kindOf = (a: { kind?: LinkKindT }): LinkKindT => a.kind ?? 'direction';

export function selfConsistency(base: Content, out: Content): { violations: Violation[]; warnings: string[] } {
  const v: Violation[] = [];
  const warnings: string[] = [];
  const baseStep = new Map(base.steps.map((s) => [s.id, canonical(s)]));
  const baseQ = new Map(base.questions.map((q) => [q.id, canonical(q)]));
  const changedStep = new Set(out.steps.filter((s) => baseStep.get(s.id) !== canonical(s)).map((s) => s.id));
  const stepById = new Map(out.steps.map((s) => [s.id, s]));

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
      if (!step) { v.push({ code: 'LINK_BROKEN', path, message: 'питання прив’язане до кроку, якого немає' }); continue; }
      if (kind === 'step_detail') continue;
      const tr = step.next.find((n) => n.condition === a.condition);
      if (!tr) { v.push({ code: 'LINK_BROKEN', path, message: `питання прив’язане до переходу з умовою «${a.condition}», якого в кроці немає` }); continue; }
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

  // 7. Нові кроки, недосяжні від початку, заданого аналітикинею (початок агент не обирає), — попередження, а не відмова: чернетка може бути незавершеною.
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
