/**
 * Обсяг відповіді агента 1: повне повернення проти часткового оновлення (D80).
 *
 * Навіщо: показати на великому СИНТЕТИЧНОМУ пакеті, скільком символам дорівнює відповідь за кожного контракту.
 * Нічого не запускає й не змінює: ні бази, ні моделі, ні кейсів. Платних викликів не робить.
 *
 * Запуск (PowerShell, у папці проєкту):
 *   node --import tsx scripts\\delta-size.ts
 *   node --import tsx scripts\\delta-size.ts --chars 65000      (підігнати розмір опису під свій кейс)
 *
 * Числа в токенах — ОЦІНКА (≈ 2,5 символа на токен, виміряно на двох справжніх прогонах, D78), а не
 * гарантована межа: токенізація залежить від тексту. Вартість — за ціною виходу з config/model-pricing.json.
 */
import { applyDelta, DELTA_CONTRACT } from '../src/ai/delta.ts';
import { CHARS_PER_OUTPUT_TOKEN } from '../src/ai/budget.ts';
import { loadPricing } from '../src/config.ts';
import { emptyContent, type Content } from '../src/schema.ts';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const targetChars = Number(flag('chars') ?? 65_000);
const model = flag('model') ?? 'claude-opus-5-5';
const outPrice = loadPricing().models[model]?.output ?? 20;

/** Синтетичний накопичений опис приблизно заданого розміру (структура — як у справжньому кейсі). */
function big(chars: number): Content {
  const c = emptyContent();
  c.summary = 'Синтетичний накопичений опис процесу: що відомо, що ні, що найважливіше уточнити.';
  c.business_context = 'Вигаданий процес для вимірювання обсягу відповіді.';
  c.roles = ['Менеджер', 'Оператор', 'Керівник'];
  c.entry_step_id = 'S1';
  for (let i = 1; i <= 12; i++) {
    c.steps.push({
      id: `S${i}`, role: i % 2 ? 'Менеджер' : 'Оператор', action: `Виконує дію номер ${i}`, entry_condition: '',
      input_artifact: 'Заявка', result: `Результат кроку ${i}`, next: [{ to: i < 12 ? `S${i + 1}` : 'END', condition: '' }],
      source_ids: ['SRC-01'], details: `Деталі кроку ${i}: канали, приклади й виключення, які не йдуть у підпис на схемі.`,
    });
  }
  let i = 0;
  while (JSON.stringify(c).length < chars) {
    i++;
    c.claims.push({
      id: `C${i}`, text: `Твердження ${i}: співрозмовник описує свою ділянку роботи й те, як він передає результат далі.`,
      type: 'source_fact', source_id: 'SRC-01', quote: 'Менеджер приймає запит', scope: 'Слова менеджера про свою ділянку; спостереження, а не оцінка.',
    });
    if (i % 8 === 0) {
      c.questions.push({
        id: `Q${i / 8}`, text: `Питання ${i / 8}: що саме відбувається з заявкою на цьому етапі?`, critical: i % 24 === 0,
        impact: 'Уточнить зміст кроку', addressee: 'Оператор', status: 'open', answer: '', closed_by_source_id: null,
        origin: 'agent', criticality_note: '',
      });
    }
  }
  return c;
}

const base = big(targetChars);
const full = JSON.stringify(base).length;
const rows: [string, number][] = [];

for (const n of [1, 3, 10]) {
  const delta: Record<string, unknown> = {
    contract: DELTA_CONTRACT, base_version: 'ver_приклад',
    claims: Array.from({ length: n }, (_, k) => ({
      ...base.claims[k * 3]!, text: `Твердження ${k * 3 + 1} уточнено за новим джерелом: співрозмовник назвав умову переходу.`,
    })),
    questions: [{ id: 'Q900', text: 'Хто перевіряє результат?', critical: false, impact: 'Уточнить роль', addressee: 'Оператор', status: 'open', answer: '', closed_by_source_id: null, origin: 'agent', criticality_note: '' }],
  };
  const applied = applyDelta(base, delta);
  if (!applied.ok) throw new Error(`контрольний приклад не склався: ${applied.violations.map((v) => v.code).join(', ')}`);
  const word = n === 1 ? 'зміна' : n < 5 ? 'зміни' : 'змін';
  rows.push([`часткове оновлення: ${n} ${word} + 1 нове питання`, JSON.stringify(delta).length]);
}

const tok = (chars: number) => Math.ceil(chars / CHARS_PER_OUTPUT_TOKEN);
const usd = (chars: number) => ((tok(chars) * outPrice) / 1e6).toFixed(4);

console.log(`\nСинтетичний пакет: ${base.steps.length} кроків, ${base.claims.length} тверджень, ${base.questions.length} питань.`);
console.log(`Ціна виходу для ${model}: $${outPrice} за млн токенів (config/model-pricing.json).\n`);
console.log('Відповідь агента                                        символів   ≈ токенів   ≈ $ за вихід   частка');
console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');
for (const [label, chars] of [['повне повернення (контракт «повна версія»)', full] as [string, number], ...rows]) {
  console.log(`${label.padEnd(52)} ${String(chars).padStart(9)} ${String(tok(chars)).padStart(11)} ${('$' + usd(chars)).padStart(14)} ${((chars / full) * 100).toFixed(1).padStart(7)} %`);
}
console.log('\nМіркування моделі тут не враховані: вони ділять ту саму стелю `max_tokens`, але окремого лічильника');
console.log('API не повертає, тому їхня частка — припущення, а не вимір. Повний опис після злиття не змінюється:');
console.log(`у відповіді менше символів, а збережена версія лишається повною (${full} симв.).`);
