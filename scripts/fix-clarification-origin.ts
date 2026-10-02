/**
 * Виправлення помилково позначеного походження УТОЧНЕНЬ (D77).
 *
 * Навіщо: до виправлення застосунок визначав походження уточнення за типом кейсу, тому в навчальному сценарії
 * синтетичні відповіді зберігались як «реальні дані» — і запуск моделі блокувався захистом D18.
 *
 * Що робить: показує, які саме уточнення буде перекласифіковано (назва, питання, дата, початок тексту), і лише
 * після явного підтвердження позначає їх як синтетичні. Текст уточнень, їхні зв'язки, версії AS-IS, хеші й
 * погодження не змінюються; сам рядок джерела не переписується — виправлення зберігається окремим незмінним записом.
 *
 * Чого НЕ робить: не чіпає звичайні джерела (інтерв'ю, документи, запити), не перекласифіковує в бік «реальні»,
 * не створює нових версій, не викликає модель.
 *
 * Запуск (PowerShell, у папці проєкту):
 *   node --import tsx scripts\\fix-clarification-origin.ts --case <ID_кейсу>                        (лише показати)
 *   node --import tsx scripts\\fix-clarification-origin.ts --case <ID_кейсу> --questions Q1,Q2,Q3   (показати обрані)
 *   node --import tsx scripts\\fix-clarification-origin.ts --case <ID_кейсу> --questions Q1,Q2,Q3 --apply --confirm <код> --reason "..."
 *
 * Код підтвердження друкує саме цей скрипт у режимі показу. Він прив'язаний до точного набору уточнень:
 * якщо набір змінився, старий код не підійде.
 */
import { openDb } from '../src/db.ts';
import { applyOriginCorrection, getCase, listSources, previewOriginCorrection } from '../src/domain.ts';
import type { Actor } from '../src/domain.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const dbPath = flag('db') ?? 'data/cx.sqlite';
const caseId = flag('case');
const questions = (flag('questions') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const human: Actor = { kind: 'human', name: 'Аналітикиня' };

if (!caseId) {
  console.error('Вкажіть кейс: --case <ID_кейсу>. ID видно у списку кейсів (scripts/export-case.ts --list).');
  process.exit(2);
}

const db = openDb(dbPath);
try {
  const c = getCase(db, caseId);
  const preview = previewOriginCorrection(db, caseId, questions.length ? { questionIds: questions } : {});

  console.log(`Кейс: ${c.title}`);
  console.log(`ID: ${caseId}\n`);

  const realAll = listSources(db, caseId).filter((s) => s.origin === 'real');
  console.log(`Джерел із позначкою «реальні дані» в кейсі: ${realAll.length}`);
  for (const s of realAll) {
    const inPreview = preview.sources.some((p) => p.source_id === s.id);
    console.log(`  ${inPreview ? '→ БУДЕ ВИПРАВЛЕНО' : '  лишається «реальні»'} · ${s.kind} · ${s.title}`);
  }

  if (preview.sources.length === 0) {
    console.log('\nВиправляти нічого: серед названих немає уточнень із позначкою «реальні дані».');
    if (questions.length) console.log(`(шукали питання: ${questions.join(', ')})`);
    process.exit(0);
  }

  console.log(`\nБуде перекласифіковано (реальні → синтетичні): ${preview.sources.length}`);
  for (const s of preview.sources) {
    console.log(`\n  Питання: ${s.question_id ?? '(не визначено)'}`);
    console.log(`  Джерело: ${s.source_id}`);
    console.log(`  Назва:   ${s.title}`);
    console.log(`  Додано:  ${s.added_at}`);
    console.log(`  Текст:   ${s.content_preview}`);
  }

  if (!has('apply')) {
    console.log('\n─────────────────────────────────────────────');
    console.log('Це лише показ. Нічого не змінено.');
    console.log('Якщо перелік правильний, виконайте:');
    console.log(`\n  node --import tsx scripts\\fix-clarification-origin.ts --case ${caseId}${questions.length ? ` --questions ${questions.join(',')}` : ''} --apply --confirm ${preview.confirm_token} --reason "синтетичні уточнення навчального сценарію"\n`);
    process.exit(0);
  }

  const reason = flag('reason') ?? '';
  const confirm = flag('confirm') ?? '';
  const r = applyOriginCorrection(db, human, caseId, {
    questionIds: questions.length ? questions : undefined, confirmToken: confirm, reason,
  });
  console.log(`\nВиправлено: ${r.corrected.length}`);
  for (const x of r.corrected) console.log(`  ${x.question_id ?? '—'} · ${x.title}`);
  console.log('\nТекст уточнень, їхні зв’язки, версії AS-IS і погодження не змінені. Виправлення записано в журнал.');
  console.log('Тепер відкрийте кейс у застосунку й перевірте вкладку «Джерела»: у виправлених буде позначка.');
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`\nНе виконано${err.code ? ` (${err.code})` : ''}: ${err.message ?? String(e)}`);
  process.exit(1);
} finally {
  db.close();
}
