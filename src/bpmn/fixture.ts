/**
 * Тестовий пакет у стислому читабельному форматі (JSON), підготовлений ВРУЧНУ, без AI.
 * Перетворюється на повний «погоджений пакет» (ApprovedPackage) із позначкою походження `test-fixture`.
 * Хеш тестового пакета = SHA-256 канонічного змісту (джерел немає, тож це не хеш справжньої версії).
 */
import { canonical, sha256 } from '../hash.ts';
import { emptyContent, type Content, type NotationKindT } from '../schema.ts';
import type { ApprovedPackage } from './types.ts';

export interface FixtureStep {
  id: string;
  role: string;
  action: string;
  next: { to: string; condition: string }[];
}

export interface Fixture {
  /** Службові поля, що пояснюють призначення пакета людині. */
  id: string;
  title: string;
  created_without_ai: true;
  synthetic: true;
  what_it_tests: string;
  /** Очікуваний результат ЗАДАНИЙ ДО запуску (acceptance: очікування встановлюються заздалегідь). */
  expect: { status: 'ok' | 'blocked' | 'unsupported'; codes?: string[] };
  version_id: string;
  /** Назва процесу (D62): напис на пулі; входить у зміст версії й хеш. */
  process_name: string;
  trigger: string;
  roles: string[];
  entry_step_id: string | null;
  steps: FixtureStep[];
  /** Необов'язково: відомі некритичні обмеження (K2) і критичні питання (K1). */
  open_questions?: { id: string; text: string; critical: boolean; affects?: { step_id: string; condition: string }[] }[];
  hypotheses?: { id: string; text: string }[];
  estimates?: string[];
  /** Вимоги до нотації (D61); за замовчуванням — підтверджені людиною (origin «analyst»). */
  notation_requirements?: { step_id: string; kind: NotationKindT; detail: string; status?: 'proposed' | 'confirmed' | 'rejected'; origin?: 'analyst' | 'agent'; evidence_quote?: string }[];
}

export function fixtureToContent(fx: Fixture): Content {
  const c = emptyContent();
  c.summary = `${fx.title} (синтетичний тестовий пакет, створений без AI)`;
  c.business_context = 'Синтетичний приклад для перевірки генератора схем. Не стосується жодного реального процесу.';
  c.boundaries = { trigger: fx.trigger, input: 'Тестовий вхід', completion: 'Тестове завершення', result: 'Тестовий результат' };
  c.roles = [...fx.roles];
  c.entry_step_id = fx.entry_step_id;
  if (fx.process_name.trim() !== '') c.process_name = fx.process_name;
  if (fx.notation_requirements?.length) {
    c.notation_requirements = fx.notation_requirements.map((r, i) => {
      const status = r.status ?? 'confirmed';
      return {
        id: `N${i + 1}`, kind: r.kind, step_id: r.step_id, detail: r.detail, origin: r.origin ?? 'analyst', status,
        evidence_source_id: '', evidence_quote: r.evidence_quote ?? '', decided_by: status === 'proposed' ? '' : 'тестовий пакет (вручну)', decision_note: '',
      };
    });
  }
  c.steps = fx.steps.map((s) => ({
    id: s.id, role: s.role, action: s.action, entry_condition: '', input_artifact: '',
    result: `Результат кроку ${s.id} (тестовий)`, next: s.next.map((n) => ({ to: n.to, condition: n.condition })), source_ids: [],
  }));
  c.problems = (fx.estimates ?? []).map((id) => ({ id, symptom: 'Тестовий симптом', cause: '', impact: 'Оцінка, а не виміряна метрика (тест)', impact_is_estimate: true }));
  c.questions = (fx.open_questions ?? []).map((q) => ({
    id: q.id, text: q.text, critical: q.critical, impact: '', addressee: '', status: 'open' as const, answer: '',
    closed_by_source_id: null, origin: 'analyst' as const, criticality_note: '',
    ...(q.affects ? { affects_transitions: q.affects } : {}),
  }));
  c.hypotheses = (fx.hypotheses ?? []).map((h) => ({
    id: h.id, author: 'analyst' as const, text: h.text, status: 'open' as const, evidence_for: [], evidence_against: [], check_method: '', history: [],
  }));
  return c;
}

export function fixtureToPackage(fx: Fixture): ApprovedPackage {
  const content = fixtureToContent(fx);
  const pkg: ApprovedPackage = {
    versionId: fx.version_id,
    contentHash: sha256(canonical({ content, covered: [] })),
    content,
    origin: 'test-fixture',
  };
  return pkg;
}
