'use strict';
// Простий інтерфейс без фреймворків. Уся логіка дозволів — на сервері; тут лише показ і введення.
// Дані завжди вставляються через textContent (без innerHTML), щоб текст джерел не міг виконатися як код.

const app = document.getElementById('app');
const state = { config: null, tab: 'context', card: null, caseId: null };

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'checked' || k === 'open' || k === 'hidden') { if (v) n[k] = true; }
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'cx' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* порожня відповідь */ }
  if (!res.ok) {
    const e = data.error || { code: 'HTTP', message: 'Помилка ' + res.status };
    const err = new Error(e.message); err.code = e.code; err.details = e.details; err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ok ? 4000 : 9000);
}

function explain(err) {
  let msg = err.message;
  const d = err.details;
  if (d && d.blockers) msg += '\n• ' + d.blockers.map((b) => b.message).join('\n• ');
  if (d && d.reasons) msg += '\n• ' + d.reasons.map((b) => b.message).join('\n• ');
  return msg;
}

async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, true); return r; }
  catch (e) { if (e.status === 401) showLogin(); else toast(explain(e)); await refresh(); return null; }
}

function showLogin() {
  app.replaceChildren(el('div', { class: 'card' }, el('h1', {}, 'Потрібен вхід'),
    el('p', {}, 'Відкрийте посилання з кодом доступу, яке надрукувала команда запуску (рядок «Відкрийте: http://localhost:…/login?code=…»).')));
}

const KIND_LABEL = { request: 'Запит', transcript: 'Транскрипт', document: 'Документ', analyst_note: 'Нотатка аналітика', clarification: 'Уточнення' };
const ORIGIN_LABEL = { real: 'реальний матеріал', synthetic: 'синтетичний (навчальний)', demo_script: 'задано сценарієм демо' };
const CREATED_BY = { analyst: 'аналітикиня', agent: 'агент', demo_script: 'сценарій демо (не AI)' };
const fmt = (iso) => new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });

// ───────────── список кейсів ─────────────
async function renderList() {
  const { cases } = await api('GET', '/api/cases');
  const title = el('input', { type: 'text', id: 'newtitle', placeholder: 'Назва нового кейсу' });
  app.replaceChildren(
    el('h1', {}, 'Кейси'),
    el('div', { class: 'card' },
      cases.length === 0 ? el('p', { class: 'muted' }, 'Кейсів ще немає. Створіть власний або завантажте демо-кейс.') : null,
      cases.map((c) => el('div', { class: 'case-row' },
        el('div', {}, el('a', { href: '#/case/' + c.id }, c.title), el('div', { class: 'small muted' }, 'Створено ' + fmt(c.created_at))),
        el('div', { class: 'chips' }, el('span', { class: 'chip state' }, c.state_label), c.is_demo_script ? el('span', { class: 'chip demo' }, 'ДЕМО') : null)))),
    el('div', { class: 'card' }, el('h2', {}, 'Навчальні сценарії «Підготовка CX до продуктових змін»'),
      el('p', { class: 'small' }, 'Два окремі кейси із синтетичними джерелами, які подаються поетапно. Сценарій А закінчується синтетичним уточненням, що закриває гілку перенесення/вилучення запуску; у сценарії Б цієї відповіді немає.'),
      el('div', { class: 'actions' },
        el('button', { onclick: () => act(async () => { const r = await api('POST', '/api/scenarios/cx-preparation', { variant: 'positive' }); location.hash = '#/case/' + r.case.id; }) }, 'Створити сценарій А'),
        el('button', { onclick: () => act(async () => { const r = await api('POST', '/api/scenarios/cx-preparation', { variant: 'negative' }); location.hash = '#/case/' + r.case.id; }) }, 'Створити сценарій Б'))),
    el('div', { class: 'card' }, el('h2', {}, 'Новий кейс'), title,
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => act(async () => {
          const r = await api('POST', '/api/cases', { title: title.value }); location.hash = '#/case/' + r.case.id; }) }, 'Створити кейс'),
        el('button', { onclick: () => act(async () => { const r = await api('POST', '/api/demo/seed'); location.hash = '#/case/' + r.case_id; }) },
          'Завантажити демо-кейс (синтетичний)'))));
}

// ───────────── картка кейсу ─────────────
// Порядок блоків: шапка → Суть → Предметний опис AS-IS (вкладки) → Критичні прогалини й наступна дія → Головні зміни → Перевірки готовності.
async function renderCase(id) {
  const card = await api('GET', '/api/cases/' + id);
  if (state.caseId !== id) { state.caseId = id; state.tab = 'context'; }   // при відкритті кейсу першою відкрита «Бізнес-контекст і межі»
  state.card = card;
  const { head, next_action: na } = card;
  const warns = card.blockers.filter((b) => b.severity === 'warning');
  const content = head.content;

  // Шапка: назва, статус, версія, режим
  const header = el('div', { class: 'card' },
    el('a', { href: '#/', class: 'small' }, '← усі кейси'),
    el('h1', {}, card.case.title),
    el('div', { class: 'chips' },
      el('span', { class: 'chip state' }, 'Статус: ' + card.case.state_label),
      el('span', { class: 'chip' }, 'Версія ' + head.number + ' · ' + CREATED_BY[head.created_by] + versionOrigin(card)),
      head.accepted ? el('span', { class: 'chip ok' }, 'Прийнято аналітиком (це ще не погодження)') : el('span', { class: 'chip' }, 'Не прийнято аналітиком'),
      card.approval ? el('span', { class: 'chip ok' }, 'Погоджено: версія ' + (card.versions.find((v) => v.id === card.approval.version_id)?.number ?? '?') + ', ' + fmt(card.approval.created_at)) : null,
      modeChip(card),
      head.integrity_ok ? null : el('span', { class: 'chip', style: 'color:var(--danger)' }, '⚠ Цілісність версії порушена')));

  // 1) Суть
  const essence = el('div', { class: 'card', 'data-block': 'essence' }, el('h2', {}, 'Суть'),
    el('p', {}, content.summary || el('span', { class: 'notset' }, 'Суть процесу ще не сформульовано.')),
    el('p', { class: 'small' }, el('strong', {}, 'Назва процесу (напис на схемі): '),
      card.process_name.defined ? card.process_name.value : el('span', { class: 'notset' }, 'не зазначено — потрібна перед побудовою схеми (назва кейсу в схему не підставляється)')));

  // 2) Предметний опис AS-IS із вкладками (перша — «Бізнес-контекст і межі», друга — «Кроки процесу»)
  const asis = el('div', { class: 'card', id: 'details', 'data-block': 'asis' }, el('h2', {}, 'Опис процесу AS-IS'), el('div', { id: 'tabs' }), el('div', { id: 'panel' }));

  // 3) Критичні прогалини + рекомендована наступна дія
  const gapLine = (g) => {
    const isQ = g.code === 'CRITICAL_QUESTION';
    const q = isQ ? content.questions.find((x) => x.id === g.ref) : null;
    const isTr = ['UNRESOLVED_TRANSITION', 'UNKNOWN_WITHOUT_QUESTION', 'UNKNOWN_QUESTION_CLOSED'].includes(g.code);
    const isEntry = g.code === 'ENTRY_MISSING' || g.code === 'ENTRY_BAD_REF';
    const isFlow = g.code === 'STEP_UNREACHABLE' || g.code === 'STEP_NO_EXIT';
    const qid = g.code === 'CONTRADICTION' || g.code === 'QUESTION_LINK_BROKEN' || g.code === 'SEQUENCE_UNCONFIRMED' ? g.ref : isTr ? (card.unknown_transitions.find((u) => u.step_id === g.ref)?.question_ids[0]) : null;
    const title = isQ ? 'Критичне питання ' : isTr ? 'Невизначений перехід. ' : g.code === 'CONTRADICTION' ? 'Суперечність. ' : g.code === 'SEQUENCE_UNCONFIRMED' ? 'Послідовність не підтверджена. '
      : isEntry ? 'Початковий крок. ' : g.code === 'STEP_UNREACHABLE' ? 'Недосяжні кроки. ' : g.code === 'STEP_NO_EXIT' ? 'Немає виходу до завершення. ' : g.code === 'PENDING_STEP_PROPOSAL' ? 'Пропозиція агента без рішення. ' : g.code === 'PENDING_NOTATION_PROPOSAL' ? 'Пропозиція щодо нотації без рішення. ' : g.code === 'NOTATION_BAD_STEP' ? 'Вимога до нотації без кроку. ' : 'Прогалина. ';
    return el('div', { class: 'blocker' },
      el('strong', {}, title),
      isQ ? `${q ? q.id + ': ' + q.text : g.message}` : g.message,
      isQ && q && q.impact ? el('div', { class: 'small' }, 'Чому важливо: ' + q.impact) : null,
      (isQ || qid) ? el('button', { class: 'link', onclick: () => goToQuestion(isQ ? g.ref : qid) }, 'Перейти до питання ' + (isQ ? g.ref : qid)) : null,
      isTr && !qid ? el('button', { class: 'link', onclick: () => showTab('steps') }, 'Показати крок ' + g.ref) : null,
      isFlow || g.code === 'PENDING_STEP_PROPOSAL' ? el('button', { class: 'link', onclick: () => showTab('steps') }, g.code === 'PENDING_STEP_PROPOSAL' ? 'Перейти до пропозиції' : 'Показати кроки процесу') : null,
      g.code === 'PENDING_NOTATION_PROPOSAL' || g.code === 'NOTATION_BAD_STEP' ? el('button', { class: 'link', onclick: () => showTab('context') }, 'Перейти до вимог до нотації') : null,
      isEntry ? entryForm(card) : null);
  };
  const questionGap = (it) => el('div', { class: 'blocker' },
    el('strong', {}, it.title + '. '), it.text,
    it.impact ? el('div', { class: 'small' }, 'Чому важливо: ' + it.impact) : null,
    it.consequences.length ? el('div', { class: 'small' }, el('strong', {}, 'Наслідки для кроків: '),
      it.consequences.map((c) => el('div', {}, c.text + ' ', el('button', { class: 'link', onclick: () => showTab('steps') }, 'Показати крок ' + c.step_id)))) : null,
    it.question_id ? el('button', { class: 'link', onclick: () => goToQuestion(it.question_id) }, 'Перейти до питання ' + it.question_id) : null);
  const gapItem = (it) => (it.kind === 'question' || it.kind === 'question_with_transitions') ? questionGap(it) : gapLine({ code: it.codes[0], ref: it.ref, message: it.text });
  const gapsAndAction = el('div', { class: 'card blockers' + (card.gap_items.length ? '' : ' none'), id: 'gaps', 'data-block': 'gaps' },
    el('h2', {}, card.gap_items.length ? `Критичні прогалини: ${card.gap_items.length}` : 'Критичних прогалин немає'),
    card.gap_items.length ? el('p', { class: 'hint' }, 'Те, чого про процес ще не з’ясовано або де опис суперечить сам собі. Доки вони відкриті, AS-IS не можна погодити.') : null,
    card.gap_items.map(gapItem),
    card.other_open_questions_count ? el('div', { class: 'warnbox' }, `Некритичних відкритих питань: ${card.other_open_questions_count} (не блокують).`) : null,
    el('div', { class: 'nextaction' },
      el('h3', {}, 'Рекомендований наступний крок'),
      el('p', {}, na.hint),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', disabled: !na.enabled, onclick: () => nextAction(card) }, na.label),
        ['pending_approval', 'approved'].includes(card.case.state) ? el('button', { onclick: () => returnDialog(card) }, 'Повернути на доопрацювання') : null,
        aiButton(card)),
      aiNote(card),
      !na.enabled && na.disabledReason ? el('p', { class: 'small', style: 'color:var(--danger)' }, 'Недоступно: ' + na.disabledReason) : null,
      runBox(card)));

  // 4) Головні зміни від попередньої версії
  const item = (c) => el('li', {}, el('strong', {}, c.label + ': '), c.text);
  const top = card.changes.slice(0, 5), rest = card.changes.slice(5);
  const changes = el('div', { class: 'card', 'data-block': 'changes' }, el('h2', {}, 'Головні зміни від попередньої версії'),
    top.length ? el('ul', {}, top.map(item)) : el('p', { class: 'muted' }, 'Змін немає.'),
    rest.length ? el('details', {}, el('summary', {}, `Усі зміни (ще ${rest.length})`), el('ul', {}, rest.map(item))) : null);

  // 5) Перевірки готовності: короткий підсумок, деталі розгортаються
  const mark = { ok: '✔', fail: '✖', warn: '!' };
  const cnt = { ok: 0, fail: 0, warn: 0 };
  card.review.checks.forEach((c) => { cnt[c.status]++; });
  const SHORT = { accepted: 'прийняття версії аналітиком', sources: 'врахування джерел', reading: 'читання файлів', structure: 'структурна повнота',
    gaps: 'критичні прогалини', integrity: 'цілісність версії', conflicts: 'конфлікти правок', process_name: 'назва процесу', notation: 'пропозиції щодо нотації' };
  const failedNames = card.review.checks.filter((c) => c.status === 'fail').map((c) => SHORT[c.key] || c.key);
  const review = el('div', { class: 'card', 'data-block': 'review' },
    el('h2', {}, 'Перевірки готовності'),
    el('p', { class: 'review-sum' },
      el('strong', {}, card.review.ready_text + '. '),
      el('span', { class: 'muted' }, `Пройдено: ${cnt.ok} · не пройдено: ${cnt.fail} · увага: ${cnt.warn}`),
      failedNames.length ? el('span', { class: 'small', style: 'display:block;color:var(--danger)' }, 'Не пройдено: ' + failedNames.join('; ')) : null),
    el('details', {}, el('summary', {}, `Показати всі перевірки (${card.review.checks.length})`),
      el('table', {}, el('tbody', {}, card.review.checks.map((c) => el('tr', {},
        el('td', { style: 'width:9.5em;white-space:nowrap' }, el('span', { class: 'chip ' + (c.status === 'ok' ? 'ok' : ''), style: c.status === 'fail' ? 'color:var(--danger);border-color:var(--danger)' : c.status === 'warn' ? 'color:var(--warn)' : '' }, mark[c.status] + ' ' + c.status_text)),
        el('td', {}, c.label), el('td', { class: 'small muted' }, c.detail))))),
      warns.length ? el('div', { class: 'warnbox' }, `Попередження (не блокують): `, warns.slice(0, 3).map((w) => w.message).join(' · '), warns.length > 3 ? ' …' : '') : null));

  app.replaceChildren(header, ...(card.scenario ? [scenarioCard(card)] : []), essence, asis, gapsAndAction, changes, review);
  renderTabs();
  clearTimeout(state.poll);
  if (card.runs[0] && card.runs[0].technical_state === 'running') state.poll = setTimeout(() => { if (state.caseId === id) route(); }, 2000);
}

function costText(r) {
  if (r.mode !== 'real') return '';
  if (r.technical_state === 'running') return ` · зарезервовано до $${(r.reserved_usd || 0).toFixed(2)} (оцінка)`;
  if (r.cost_known === 0) return ` · вартість НЕВІДОМА, резерв $${(r.reserved_usd || 0).toFixed(2)} (не звільняється)`;
  return r.cost_usd != null ? ` · $${r.cost_usd.toFixed(3)}` : '';
}
const latestRun = (card) => card.runs[0] || null;
const isRunning = (card) => !!latestRun(card) && latestRun(card).technical_state === 'running';

function modeChip(card) {
  if (card.ai && card.ai.kind === 'real') return el('span', { class: 'chip real' }, 'Справжня модель: ' + card.ai.model);
  return el('span', { class: 'chip demo' }, 'ДЕМО — не AI');
}
function versionOrigin(card) {
  const h = card.head;
  if (h.created_by !== 'agent') return '';
  return h.mode === 'real' ? ' (відповідь справжньої моделі)' : ' (підставна відповідь тесту, не AI)';
}

function aiButton(card) {
  const ai = card.ai || { available: false };
  const wrongState = card.case.state !== 'research';
  const label = ai.kind === 'scripted_demo' ? 'Оновити аналіз (підставний клієнт, не AI)' : 'Оновити аналіз (AI)';
  return el('button', {
    disabled: !ai.available || wrongState || isRunning(card),
    title: !ai.available ? ai.reason : wrongState ? 'Спершу поверніть кейс на доопрацювання' : '',
    onclick: () => startAnalysis(card),
  }, isRunning(card) ? 'Аналіз виконується…' : label);
}
function aiNote(card) {
  const ai = card.ai || {};
  if (!ai.available) return el('p', { class: 'small', 'data-ai-note': 'unavailable' }, 'Аналіз моделлю недоступний. ' + (ai.reason || ''));
  const parts = [];
  if (ai.kind === 'real') {
    parts.push('Тексти джерел цього кейсу буде надіслано постачальнику моделі (' + ai.model + '). Матеріали з позначкою «реальні» не надсилаються.');
    if (ai.budget) parts.push(`Бюджет: витрачено й зарезервовано $${ai.budget.spent_usd.toFixed(2)} із $${ai.budget.total_usd.toFixed(2)} (резерв тримають активні запуски й запуски з невідомою вартістю${ai.budget.unknown_cost_runs ? ': ' + ai.budget.unknown_cost_runs : ''}); ліміт на запуск $${ai.budget.per_run_usd.toFixed(2)}. Вартість до запуску — оцінка, не гарантія.`);
  }
  parts.push('Результат не замінює вашу версію автоматично: його перевіряє програма, а ваші правки зберігаються.');
  return el('p', { class: 'small muted' }, parts.join(' '));
}
async function startAnalysis(card) {
  const r = await act(() => api('POST', `/api/cases/${card.case.id}/analyze`, {}), 'Аналіз запущено. Поточну версію не змінено, доки результат не пройде перевірки.');
  if (r) await refresh();
}
function runBox(card) {
  const r = latestRun(card);
  if (!r) return null;
  const usage = (() => { try { return JSON.parse(r.usage_json || '{}'); } catch { return {}; } })();
  const st = { running: 'виконується…', done: 'завершено', error: 'помилка', queued: 'у черзі' }[r.technical_state] || r.technical_state;
  const w = (() => { try { return JSON.parse(r.checks_json || '{}').warnings || []; } catch { return []; } })();
  const fa = (() => { try { return JSON.parse(r.checks_json || '{}').failed_attempts || []; } catch { return []; } })();
  return el('div', { class: 'runbox', 'data-block': 'lastrun' },
    el('div', { class: 'small' }, el('strong', {}, 'Останній запуск аналізу: '), st, ' · ', r.mode === 'real' ? r.model : 'підставний клієнт (не AI)', ' · інструкція ' + r.instruction_version,
      r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)} с` : '',
      usage.input_tokens != null ? ` · токени: ${usage.input_tokens} вх. / ${usage.output_tokens} вих.` : '',
      costText(r), r.attempts > 1 ? ` · спроб: ${r.attempts}` : ''),
    r.technical_state === 'running' ? el('div', { class: 'small' }, 'Поточну версію не змінено; результат з’явиться після перевірки.') : null,
    r.error ? el('div', { class: 'small', style: 'color:var(--danger)' }, 'Помилка: ' + r.error + ' Поточну версію не змінено.') : null,
    w.length ? el('details', {}, el('summary', { class: 'small' }, 'Попередження перевірки відповіді (' + w.length + ')'), el('ul', { class: 'small' }, w.map((x) => el('li', {}, x)))) : null,
    fa.length ? el('details', {}, el('summary', { class: 'small' }, 'Відхилені спроби та їхні причини (' + fa.length + ')'),
      el('ul', { class: 'small' }, fa.map((x) => el('li', {}, 'Спроба ' + x.attempt + ': ' + (x.message || x.kind))))) : null);
}

// ───────────── навчальний сценарій ─────────────
function scenarioCard(card) {
  const sc = card.scenario;
  const neg = sc.variant === 'negative';
  const added = card.sources.map((s) => s.ref).filter(Boolean);
  const body = [
    el('p', {}, `Етап ${sc.stage} з ${sc.total}. Додані матеріали: `, added.length ? added.join(', ') : 'ще немає', '. ',
      'Агент бачить лише додані матеріали й поточну версію.'),
  ];
  if (sc.next_stage) {
    body.push(el('p', { class: 'small' }, `Наступний етап ${sc.next_stage}: `, sc.next_sources.map((s) => s.ref + ' ' + s.title).join('; ')));
    body.push(el('div', { class: 'actions' }, el('button', { class: 'primary', disabled: !sc.can_advance, onclick: async () => {
      const r = await act(() => api('POST', `/api/cases/${card.case.id}/scenario/next`, {}), `Додано матеріали етапу ${sc.next_stage}. Кейс повернуто до дослідження.`);
      if (r) await refresh();
    } }, `Додати матеріали етапу ${sc.next_stage}`)));
    if (sc.blocked_reason) body.push(el('p', { class: 'small', style: 'color:var(--danger)' }, sc.blocked_reason));
  } else if (sc.clarification) {
    if (sc.clarification.available) {
      body.push(el('p', { class: 'small' }, 'Усі п’ять етапів додано. Якщо опис лишається чернеткою з відкритою гілкою, ви можете свідомо подати явне уточнення (синтетичне, вигадане для тесту). Це створить нове джерело; його треба буде опрацювати, прийняти нову версію й погодити її знову.'));
      body.push(el('div', { class: 'actions' }, el('button', { onclick: () => openDialog(el('h2', {}, 'Подати явне уточнення'),
        el('p', {}, 'Буде додано нове синтетичне джерело SRC-09 з відповіддю про перенесення або вилучення запуску. Кейс повернеться до дослідження; попередні версії не змінюються.'),
        el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: async () => { dlg.close(); const r = await act(() => api('POST', `/api/cases/${card.case.id}/scenario/clarify`, {}), 'Явне уточнення додано як нове джерело'); if (r) await refresh(); } }, 'Подати уточнення'), el('button', { onclick: () => dlg.close() }, 'Скасувати'))) }, 'Подати явне уточнення…')));
    } else body.push(el('p', { class: 'small' }, 'Явне уточнення подано (SRC-09).'));
  } else body.push(el('p', { class: 'small' }, 'Усі етапи додано.'));
  return el('div', { class: 'card', 'data-block': 'scenario' },
    el('h2', {}, 'Навчальний сценарій ' + (neg ? 'Б' : 'А') + ' (синтетичні джерела)'), ...body);
}

function showTab(tab) { state.tab = tab; renderTabs(); document.getElementById('details').scrollIntoView(); }

/** Явний вибір початкового кроку. Система ніколи не обирає його сама (D27). Для погоджених записів створюється нова версія. */
function entryForm(card) {
  const steps = card.head.content.steps;
  if (!steps.length) return el('p', { class: 'hint' }, 'Спершу додайте кроки на вкладці «Редагувати».');
  const sel = el('select', { id: 'entry-select', 'aria-label': 'Початковий крок' }, el('option', { value: '' }, '— оберіть початковий крок —'),
    steps.map((s) => el('option', { value: s.id }, `${s.id} — ${s.action}`)));
  const save = async () => {
    dlg.close();
    const r = await act(() => api('POST', `/api/cases/${card.case.id}/versions`, { base_version_id: card.head.id, fields: { entry_step_id: sel.value } }),
      'Початковий крок збережено як нову версію');
    if (r) await refresh();
  };
  const btn = el('button', { disabled: true, onclick: () => {
    if (card.case.state === 'research') { save(); return; }
    openDialog(el('h2', {}, 'Початковий крок: нова версія'),
      el('p', {}, `Версія ${card.head.number} не змінюється й лишається в історії. Буде створено версію ${card.head.number + 1} з початковим кроком ${sel.value}. `
        + 'Чинне погодження скасується (запис лишиться в історії): нову версію треба буде прийняти, передати на погодження й погодити.'),
      el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: save }, 'Створити нову версію'), el('button', { onclick: () => dlg.close() }, 'Скасувати')));
  } }, 'Зафіксувати початковий крок');
  sel.addEventListener('change', () => { btn.disabled = !sel.value; });
  return el('div', { class: 'entry-form' }, sel, btn);
}

function goToQuestion(qid) {
  state.tab = 'questions'; renderTabs();
  const n = document.getElementById('q-' + qid);
  if (n) { n.scrollIntoView({ block: 'center' }); n.style.outline = '3px solid var(--accent)'; setTimeout(() => { n.style.outline = ''; }, 2500); }
}

async function nextAction(card) {
  const k = card.next_action.key;
  if (k === 'resolve_blockers') {
    state.tab = card.critical_open_questions.length ? 'questions' : (card.blockers.some((b) => b.code.includes('SOURCE')) ? 'sources' : 'edit');
    renderTabs(); document.getElementById('tabs').scrollIntoView();
  } else if (k === 'accept') { await act(() => api('POST', `/api/cases/${card.case.id}/accept-draft`, { version_id: card.head.id }), 'Робочу версію прийнято'); await refresh(); }
  else if (k === 'submit') { await act(() => api('POST', `/api/cases/${card.case.id}/submit`, {}), 'Передано на погодження'); await refresh(); }
  else if (k === 'approve') approveDialog(card);
  else if (k === 'clarify_entry') { const sel = document.getElementById('entry-select'); if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); } else showTab('edit'); }
  else if (k === 'clarify_process_name') { showTab('edit'); setTimeout(() => { const i = document.getElementById('process-name-input'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 50); }
  else if (k === 'fix_flow') showTab('edit');
  else if (k === 'start_bpmn') {
    const r = await act(() => api('POST', `/api/cases/${card.case.id}/bpmn/start`, {}));
    if (r) toast('Сервер підтвердив дозвіл (запуск ' + r.run_id + '). Побудову BPMN буде додано у зрізі 3.', true);
    await refresh();
  }
}

const dlg = document.getElementById('dlg');
function openDialog(...children) { dlg.replaceChildren(...children.flat().filter(Boolean)); dlg.showModal(); }

function approveDialog(card) {
  const items = [
    'Межі, ролі та кроки процесу зрозумілі; умови й винятки описані.',
    'Проблеми та їхній вплив досліджено (або явно зазначено, що метрик немає).',
    'Немає відкритих питань про хід процесу.',
    'Я розумію, що погоджую саме версію ' + card.head.number + ', і зміна після цього потребує нового погодження.',
  ];
  const boxes = items.map(() => el('input', { type: 'checkbox' }));
  const btn = el('button', { class: 'primary', disabled: true, onclick: async () => {
    dlg.close();
    await act(() => api('POST', `/api/cases/${card.case.id}/approve`, { version_id: card.head.id, checklist_confirmed: true }), 'AS-IS погоджено');
    await refresh();
  } }, 'Погодити версію ' + card.head.number);
  boxes.forEach((b) => b.addEventListener('change', () => { btn.disabled = !boxes.every((x) => x.checked); }));
  const reqs = (card.notation_requirements || []).filter((r) => r.status !== 'rejected');
  openDialog(el('h2', {}, 'Погодження AS-IS: версія ' + card.head.number),
    el('p', {}, 'Це рішення людини. Агент не може його прийняти. Позначте кожен пункт:'),
    el('div', { class: 'warnbox', 'data-block': 'approve-facts' },
      el('div', {}, el('strong', {}, 'Назва процесу (напис на схемі): '), card.process_name.defined ? card.process_name.value : el('strong', { style: 'color:var(--danger)' }, 'не зазначено — схему без неї не побудувати')),
      el('div', {}, el('strong', {}, 'Вимоги до нотації: '), reqs.length ? reqs.map((r) => el('div', { class: 'small' }, `${r.id} · ${r.kind_label} · крок ${r.step_id} · ${r.status === 'confirmed' ? 'підтверджено' : 'ОЧІКУЄ РІШЕННЯ'}: ${r.detail}`)) : el('span', { class: 'notset' }, 'не зазначено (це не означає, що особливостей немає)'))),
    items.map((t, i) => el('label', { class: 'inline' }, boxes[i], t)),
    el('div', { class: 'actions' }, btn, el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

function returnDialog(card) {
  const reason = el('input', { type: 'text', placeholder: 'Причина повернення (обов’язково)' });
  openDialog(el('h2', {}, 'Повернути на доопрацювання'), el('p', { class: 'hint' }, 'Чинне погодження (якщо є) позначиться як скасоване; запис лишиться в історії.'), reason,
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: async () => { dlg.close(); await act(() => api('POST', `/api/cases/${card.case.id}/return`, { reason: reason.value }), 'Повернуто до дослідження'); await refresh(); } }, 'Повернути'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

// ───────────── вкладки деталей ─────────────
const TABS = [
  ['context', 'Бізнес-контекст і межі'], ['steps', 'Кроки процесу'], ['claims', 'Твердження й докази'], ['problems', 'Проблеми й вплив'], ['hypotheses', 'Гіпотези'],
  ['questions', 'Питання'], ['sources', 'Джерела'], ['edit', 'Редагувати'], ['history', 'Історія'],
];

function renderTabs() {
  const card = state.card; if (!card) return;
  const critQ = card.critical_open_questions.length;
  const tabs = document.getElementById('tabs');
  tabs.className = 'tabs'; tabs.setAttribute('role', 'tablist');
  tabs.replaceChildren(...TABS.map(([k, label]) => el('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => { state.tab = k; renderTabs(); } },
    label, k === 'questions' && critQ ? el('span', { class: 'n' }, ' ●' + critQ) : null,
    k === 'claims' && card.head.content.conflicts.length ? el('span', { class: 'n' }, ' ⚠') : null)));
  const panel = document.getElementById('panel');
  panel.replaceChildren(PANELS[state.tab](card));
}

function unknownView(card, step, n) {
  const u = card.unknown_transitions.find((x) => x.step_id === step.id && x.condition === n.condition);
  const qs = u ? u.questions : [];
  return el('div', { class: 'warnbox', style: 'margin:2px 0' },
    el('strong', {}, '❓ → НЕВІДОМО'), n.condition ? ' (' + n.condition + ')' : '', ' — ',
    qs.length ? qs.map((q) => el('span', {}, q.status === 'open' ? 'питання ' : 'питання (закрито) ', el('button', { class: 'link', onclick: () => goToQuestion(q.id) }, q.id), ' ')) : el('strong', {}, 'питання не вказано'),
    el('div', { class: 'small' }, 'Це не завершення й не крок: процес після цього моменту не з’ясовано.'));
}

function kv(label, value) { return el('tr', {}, el('th', {}, label), el('td', {}, value || el('span', { class: 'muted' }, 'не заповнено'))); }

const PANELS = {
  context: (card) => {
    const c = card.head.content;
    const row = (label, text, missing) => el('div', { class: 'kv' }, el('div', { class: 'k' }, label),
      el('div', { class: 'v' }, text && text.trim() ? text : el('span', { class: 'notset' }, missing || 'Не з’ясовано')));
    const entryStep = c.steps.find((x) => x.id === c.entry_step_id);
    return el('div', { class: 'ctx' },
      el('h3', {}, 'Назва процесу'),
      row('Назва процесу — напис на пулі схеми (входить у погодження; зміна створює нову версію)', card.process_name.value, 'Не зазначено. Потрібна перед побудовою схеми; назва кейсу «' + card.case.title + '» у схему не підставляється.'),
      el('h3', {}, 'Навіщо існує процес'),
      row('Бізнес-потреба: навіщо процес, хто отримує результат', c.business_context, 'Не з’ясовано: бізнес-контекст ще не заповнено.'),
      row('Результат процесу', c.boundaries.result),
      el('h3', {}, 'Межі процесу'),
      row('Тригер — що запускає процес', c.boundaries.trigger),
      row('Вхід', c.boundaries.input),
      row('Фактичне завершення', c.boundaries.completion),
      row('Початковий крок', entryStep ? `${entryStep.id} — ${entryStep.action}` : '',
        c.entry_step_id ? `Хибне посилання: крок ${c.entry_step_id} не існує` : 'Не задано (див. «Критичні прогалини»)'),
      el('h3', {}, 'Ролі'),
      c.roles.length ? el('div', { class: 'chips' }, c.roles.map((r) => el('span', { class: 'chip' }, r))) : el('p', { class: 'notset' }, 'Ролей ще не вказано.'),
      notationView(card));
  },
  steps: (card) => {
    const c = card.head.content; const steps = c.steps;
    if (!steps.length) return el('p', { class: 'muted' }, 'Кроків ще немає. Додайте їх на вкладці «Редагувати».');
    const entryLine = card.entry.defined
      ? el('p', { class: 'small' }, el('strong', {}, '▶ Початок: '), `${c.entry_step_id} — ${steps.find((x) => x.id === c.entry_step_id).action}`)
      : el('p', { class: 'warnbox' }, el('strong', {}, 'Початковий крок не задано. '), 'Оберіть його в блоці «Критичні прогалини» або на вкладці «Редагувати».');
    return el('div', {}, entryLine, proposalsView(card),
      el('table', {}, el('thead', {}, el('tr', {}, ['ID', 'Роль', 'Дія', 'Результат', 'Далі'].map((h) => el('th', {}, h)))),
        el('tbody', {}, steps.map((s) => el('tr', {}, el('td', {}, s.id === c.entry_step_id ? '▶ ' + s.id : s.id), el('td', {}, s.role), el('td', {}, s.action, s.details ? el('details', { class: 'small' }, el('summary', {}, 'Деталі'), s.details) : null), el('td', {}, s.result),
          el('td', {}, s.next.map((n) => n.to === 'UNKNOWN' ? unknownView(card, s, n) : el('div', {}, '→ ' + (n.to === 'END' ? 'кінець процесу' : n.to) + (n.condition ? ' (' + n.condition + ')' : '')))))))));
  },
  claims: (card) => {
    const c = card.head.content;
    return el('div', {},
      el('p', { class: 'hint' }, 'Програма перевіряє лише те, що цитата є в тексті джерела. Це не доводить, що вона підтверджує висновок.'),
      card.claims.length ? card.claims.map((cl) => el('div', { class: 'claim ' + cl.type },
        el('div', {}, el('span', { class: 'chip' }, cl.type_label), ' ', cl.text),
        el('div', { class: 'small muted' }, cl.scope),
        cl.source_id ? el('div', { class: 'small' }, 'Джерело: ' + (cl.source_title || cl.source_id) + ' · ',
          cl.quote_check === 'quote_found' ? (cl.quote_elided ? 'фрагмент знайдено зі скороченням «…» (перевірте пропущене) · ' : 'фрагмент знайдено · ') : cl.quote_check === 'quote_not_found' ? '⚠ фрагмент НЕ знайдено · ' : '',
          el('button', { class: 'link', onclick: () => showSource(cl.source_id, cl.quote) }, 'Показати фрагмент у джерелі')) : null))
        : el('p', { class: 'muted' }, 'Тверджень ще немає.'),
      c.conflicts.length ? el('div', {}, el('h3', {}, 'Конфлікти: правки аналітикині та агента'),
        c.conflicts.map((x) => el('div', { class: 'warnbox' }, el('strong', {}, x.key), ': ', x.note, el('div', {}, 'Збережено: ' + x.kept), el('div', {}, 'Запропоновано агентом: ' + x.proposed)))) : null);
  },
  problems: (card) => {
    const p = card.problems_view || card.head.content.problems;
    if (!p.length) return el('p', { class: 'muted' }, 'Проблем ще не описано.');
    const labels = card.cause_statuses || {};
    const causeCell = (x) => {
      // Підстава причини видима окремо від тексту: «не з'ясовано» не маскується формулюванням (D70).
      if (x.cause_status === 'not_established') return el('td', {}, el('span', { class: 'muted' }, labels.not_established || 'причину не з’ясовано'));
      if (!x.cause_status) return el('td', {}, x.cause || '—', x.cause ? el('div', { class: 'small muted' }, 'підставу не зазначено (запис до D70)') : null);
      return el('td', {}, x.cause || '—',
        el('div', { class: 'small' }, labels[x.cause_status] || x.cause_status,
          x.cause_status === 'source_stated' && x.cause_source_id
            ? el('span', {}, ' · ', x.cause_source_title || x.cause_source_id, ' · ',
                x.cause_quote_check === 'quote_not_found' ? '⚠ фрагмент НЕ знайдено · ' : 'фрагмент знайдено · ',
                el('button', { class: 'link', onclick: () => showSource(x.cause_source_id, x.cause_quote) }, 'Показати фрагмент у джерелі'))
            : null,
          x.cause_status === 'agent_hypothesis' && x.cause_hypothesis_id
            ? el('span', {}, ' · гіпотеза ' + x.cause_hypothesis_id + (x.cause_hypothesis_check === 'missing' ? ' ⚠ без способу перевірки' : ''))
            : null));
    };
    return el('table', {}, el('thead', {}, el('tr', {}, ['ID', 'Симптом', 'Можлива причина', 'Вплив'].map((h) => el('th', {}, h)))),
      el('tbody', {}, p.map((x) => el('tr', {}, el('td', {}, x.id), el('td', {}, x.symptom), causeCell(x), el('td', {}, x.impact + (x.impact_is_estimate ? ' (оцінка)' : ''))))));
  },
  hypotheses: (card) => {
    const h = card.head.content.hypotheses;
    if (!h.length) return el('p', { class: 'muted' }, 'Гіпотез ще немає.');
    return el('div', {}, h.map((x) => el('div', { class: 'claim' }, el('div', {}, el('span', { class: 'chip' }, 'Гіпотеза ' + x.id + ' · ' + ({ open: 'відкрита', supported: 'підтримана', refuted: 'спростована', confirmed: 'підтверджена' })[x.status]), ' ', x.text),
      el('div', { class: 'small muted' }, 'Автор: ' + (x.author === 'analyst' ? 'аналітикиня' : 'агент') + '. Перевірка: ' + (x.check_method || 'не визначено')))));
  },
  questions: (card) => {
    const qs = card.head.content.questions;
    const transitions = card.head.content.steps.flatMap((st) => st.next.map((n) => ({ step_id: st.id, condition: n.condition, to: n.to })));
    const add = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target;
      const t = f.transition.value === '' ? null : transitions[Number(f.transition.value)];
      const ok = await act(() => api('POST', `/api/cases/${card.case.id}/questions`, { base_version_id: card.head.id, text: f.text.value, impact: f.impact.value, critical: f.critical.checked, affects: t ? [{ step_id: t.step_id, condition: t.condition }] : [] }), 'Питання додано (нова версія)');
      if (ok) await refresh();
    } }, el('h3', {}, 'Поставити питання (вручну)'),
      el('p', { class: 'hint' }, 'Питання можуть ставити аналітикиня, сценарій демо та (якщо підключено модель) агент. Нічого не імітується.'),
      el('label', {}, 'Питання'), el('input', { type: 'text', name: 'text', required: true }),
      el('label', {}, 'Від чого залежить відповідь (вплив на опис)'), el('input', { type: 'text', name: 'impact' }),
      el('label', {}, 'Стосується переходу (необов’язково)'),
      el('select', { name: 'transition' }, el('option', { value: '' }, 'не стосується конкретного переходу'),
        transitions.map((t, i) => el('option', { value: String(i) }, `${t.step_id}${t.condition ? ' (' + t.condition + ')' : ''} → ${t.to === 'END' ? 'кінець' : t.to === 'UNKNOWN' ? 'невідомо' : t.to}`))),
      el('p', { class: 'hint' }, 'Якщо обрати перехід, він одразу стане «невідомо»: невідоме не записується в опис як факт.'),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'critical' }), 'Критичне (блокує погодження)'),
      el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Додати питання')));
    return el('div', {}, qs.length ? qs.map((q) => questionView(card, q)) : el('p', { class: 'muted' }, 'Питань немає.'), add);
  },
  sources: (card) => {
    const list = card.sources.length ? el('table', {}, el('thead', {}, el('tr', {}, ['Джерело', 'Тип', 'Походження', 'Читання', 'Враховано у версії'].map((h) => el('th', {}, h)))),
      el('tbody', {}, card.sources.map((s) => el('tr', {}, el('td', {}, s.read_status === 'ok' ? el('button', { class: 'link', onclick: () => showSource(s.id) }, s.title) : s.title, s.required ? ' (обов’язкове)' : ''),
        el('td', {}, KIND_LABEL[s.kind]), el('td', {}, ORIGIN_LABEL[s.origin]),
        el('td', {}, s.read_status === 'ok' ? 'прочитано' : el('span', { style: 'color:var(--danger)' }, '⚠ НЕ прочитано: ' + (s.read_error || ''))),
        el('td', {}, s.read_status !== 'ok' ? 'ні (не опрацьовано)' : s.covered ? 'так' : el('strong', { style: 'color:var(--danger)' }, 'ні — нове, не враховано')))))) : el('p', { class: 'muted' }, 'Джерел ще немає.');
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target;
      const ok = await act(() => api('POST', `/api/cases/${card.case.id}/sources`, { kind: f.kind.value, title: f.title.value, content: f.content.value, required: f.required.checked, origin: f.synthetic.checked ? 'synthetic' : 'real' }), 'Джерело додано');
      if (ok) await refresh();
    } }, el('h3', {}, 'Додати текстове джерело'),
      el('p', { class: 'hint' }, 'Для навчальних перевірок використовуйте лише синтетичні (вигадані) матеріали: під час справжнього AI-запуску тексти джерел передаються постачальнику моделі (матеріали з позначкою «реальні» не надсилаються). Нове джерело повертає кейс до дослідження.'),
      el('label', {}, 'Тип'), el('select', { name: 'kind' }, ['transcript', 'request', 'document', 'analyst_note'].map((k) => el('option', { value: k }, KIND_LABEL[k]))),
      el('label', {}, 'Назва'), el('input', { type: 'text', name: 'title', required: true }),
      el('label', {}, 'Текст'), el('textarea', { name: 'content', required: true }),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'synthetic', checked: true }), 'Синтетичний (навчальний) матеріал'),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'required' }), 'Обов’язкове джерело'),
      el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Додати джерело')));
    const fileForm = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target; const file = f.file.files[0]; if (!file) return;
      const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; buf.forEach((b) => { bin += String.fromCharCode(b); });
      const r = await act(() => api('POST', `/api/cases/${card.case.id}/sources/file`, { name: file.name, kind: 'document', content_base64: btoa(bin), required: f.required.checked, origin: 'synthetic' }));
      if (r) { toast(r.read_status === 'ok' ? 'Файл прочитано' : 'Файл НЕ прочитано: ' + r.read_error, r.read_status === 'ok'); await refresh(); }
    } }, el('h3', {}, 'Додати файл (.txt або .md)'), el('input', { type: 'file', name: 'file' }),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'required' }), 'Обов’язкове джерело'), el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Завантажити')));
    return el('div', {}, list, form, fileForm);
  },
  edit: (card) => {
    const e = card.editable; const uncovered = card.sources.some((s) => s.read_status === 'ok' && !s.covered);
    const form = el('form', { onsubmit: async (ev) => {
      ev.preventDefault(); const f = ev.target;
      const ok = await act(() => api('POST', `/api/cases/${card.case.id}/versions`, { base_version_id: card.head.id, cover_all_sources: f.cover.checked, fields: {
        summary: f.summary.value, business_context: f.business_context.value,
        boundaries: { trigger: f.trigger.value, input: f.input.value, completion: f.completion.value, result: f.result.value },
        roles_text: f.roles.value, steps_text: f.steps.value, problems_text: f.problems.value, entry_step_id: f.entry.value, process_name: f.process_name.value } }), 'Збережено як нова версія');
      if (ok) await refresh();
    } },
      el('p', { class: 'hint' }, 'Збереження створює НОВУ версію; попередні не змінюються. Після змін кейс повертається до стану «Дослідження», а погодження втрачає чинність.'),
      el('label', {}, 'Назва процесу'), el('p', { class: 'hint' }, 'Входить у погодження й стає написом на пулі схеми. Це не назва кейсу («' + card.case.title + '»): назву кейсу в схему не підставляємо. Зміна створює нову версію.'),
      el('input', { type: 'text', name: 'process_name', id: 'process-name-input', value: e.process_name }),
      el('label', {}, 'Суть'), el('textarea', { name: 'summary' }, e.summary),
      el('label', {}, 'Бізнес-контекст'), el('textarea', { name: 'business_context' }, e.business_context),
      ...[['trigger', 'Тригер'], ['input', 'Вхід'], ['completion', 'Фактичне завершення'], ['result', 'Результат']].flatMap(([k, l]) => [el('label', {}, l), el('input', { type: 'text', name: k, value: e.boundaries[k] })]),
      el('label', {}, 'Ролі (по одній у рядку)'), el('textarea', { name: 'roles' }, e.roles_text),
      el('label', {}, 'Кроки'), el('p', { class: 'hint' }, 'Формат рядка: ID | Роль | Дія | Результат | Наступні. Наступні: «S4 (погоджено); END (відхилено)». END — кінець процесу; «?» — невідомо (потребує питання на вкладці «Питання»).'), el('textarea', { name: 'steps', style: 'min-height:170px' }, e.steps_text),
      el('label', {}, 'Початковий крок'), el('p', { class: 'hint' }, 'Явний вибір: система не визначає початок за порядком рядків. Новий крок спершу збережіть, потім призначте його початковим.'),
      el('select', { name: 'entry' }, el('option', { value: '' }, 'не задано'),
        card.head.content.steps.map((st) => el('option', { value: st.id, selected: e.entry_step_id === st.id }, `${st.id} — ${st.action}`))),
      el('label', {}, 'Проблеми'), el('p', { class: 'hint' }, 'Формат: ID | Симптом | Вплив (метрики немає — так і напишіть).'), el('textarea', { name: 'problems' }, e.problems_text),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'cover', checked: uncovered }), 'Я врахувала нові джерела в цій версії' + (uncovered ? ' (є неврахований матеріал)' : '')),
      el('div', { class: 'actions' }, el('button', { class: 'primary', type: 'submit' }, 'Зберегти як нову версію')));
    return form;
  },
  history: (card) => el('div', {},
    el('h3', {}, 'Версії'), el('table', {}, el('thead', {}, el('tr', {}, ['№', 'Автор', 'Режим', 'Створено', 'Примітка', 'Статус'].map((h) => el('th', {}, h)))),
      el('tbody', {}, card.versions.map((v) => el('tr', {}, el('td', {}, v.number + (v.is_head ? ' (поточна)' : '')), el('td', {}, CREATED_BY[v.created_by]), el('td', {}, v.mode === 'demo' ? 'ДЕМО' : v.mode),
        el('td', {}, fmt(v.created_at)), el('td', {}, v.note), el('td', {}, (v.kind === 'proposal' ? 'пропозиція на застарілій основі; ' : '') + (v.accepted ? 'прийнята аналітиком' : '')))))),
    el('h3', {}, 'Погодження'), card.approvals_history.length ? el('ul', {}, card.approvals_history.map((a) => el('li', {},
      `Версія ${card.versions.find((v) => v.id === a.version_id)?.number ?? '?'} · ${a.approver} · ${fmt(a.created_at)} · `, a.revoked_reason ? `скасовано (${a.revoked_reason}, ${fmt(a.revoked_at)})` : 'чинне'))) : el('p', { class: 'muted' }, 'Погоджень ще не було.'),
    el('h3', {}, 'Запуски'), card.runs.length ? el('ul', {}, card.runs.map((r) => el('li', {}, `${r.agent} · ${r.mode === 'real' ? 'справжня модель ' + r.model : 'підставний клієнт (не AI)'} · інструкція ${r.instruction_version}${r.instruction_hash ? ' (' + r.instruction_hash.slice(0, 8) + ')' : ''} · ${r.technical_state}${r.duration_ms != null ? ' · ' + (r.duration_ms / 1000).toFixed(1) + ' с' : ''}${costText(r)}${r.attempts > 1 ? ' · спроб: ' + r.attempts : ''}${r.note ? ' · ' + r.note : ''}${r.error ? ' · помилка: ' + r.error : ''}`))) : el('p', { class: 'muted' }, 'Запусків ще не було.'),
    el('h3', {}, 'Журнал подій'), el('ul', { class: 'small' }, card.audit.slice(0, 15).map((a) => el('li', {}, `${fmt(a.at)} · ${a.actor} · ${a.action}`)))),
};

function notationView(card) {
  const rs = card.notation_requirements || [];
  const ST = { proposed: 'очікує рішення', confirmed: 'підтверджено', rejected: 'відхилено' };
  const steps = card.head.content.steps;
  const decide = (r, decision) => {
    const note = el('input', { type: 'text', placeholder: 'Примітка до рішення (необов’язково)' });
    openDialog(el('h2', {}, (decision === 'confirm' ? 'Підтвердити' : 'Відхилити') + ' пропозицію ' + r.id),
      decision === 'confirm' ? el('p', {}, 'Вимога стане встановленим фактом опису: схема для цього процесу не буде побудована (непідтримувана нотація), але погоджений AS-IS не змінюється. Буде створено нову версію; чинне погодження (якщо є) скасується.') : el('p', {}, 'Пропозицію буде позначено відхиленою; нова версія, чинне погодження (якщо є) скасується.'),
      note, el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: async () => { dlg.close(); const x = await act(() => api('POST', `/api/cases/${card.case.id}/notation/decide`, { base_version_id: card.head.id, requirement_id: r.id, decision, note: note.value }), 'Рішення збережено як нова версія'); if (x) await refresh(); } }, 'Підтвердити'),
        el('button', { onclick: () => dlg.close() }, 'Скасувати')));
  };
  const kind = el('select', { name: 'kind' }, Object.entries(card.notation_kinds).map(([k, l]) => el('option', { value: k }, l)));
  const step = el('select', { name: 'step' }, steps.map((x) => el('option', { value: x.id }, `${x.id} — ${x.action}`)));
  const detail = el('input', { type: 'text', name: 'detail', placeholder: 'Що саме в описі потребує цієї нотації (обов’язково)' });
  const src = el('select', { name: 'src' }, el('option', { value: '' }, '— без джерела —'), card.sources.filter((x) => x.read_status === 'ok').map((x) => el('option', { value: x.id }, x.title)));
  const quote = el('input', { type: 'text', name: 'quote', placeholder: 'Цитата з джерела (необов’язково)' });
  const add = el('form', { onsubmit: async (ev) => { ev.preventDefault();
      const x = await act(() => api('POST', `/api/cases/${card.case.id}/notation/add`, { base_version_id: card.head.id, kind: kind.value, step_id: step.value, detail: detail.value, evidence_source_id: src.value, evidence_quote: quote.value }), 'Вимогу додано як нову версію');
      if (x) await refresh(); } },
    el('h4', {}, 'Додати вимогу вручну'), kind, step, detail, src, quote,
    el('div', { class: 'actions' }, el('button', { type: 'submit', disabled: !steps.length }, 'Додати вимогу (нова версія)')));
  return el('div', { 'data-block': 'notation' },
    el('h3', {}, 'Вимоги до нотації'),
    el('p', { class: 'hint' }, 'Те, що проста схема процесу (v1) не вміє показати: паралельні гілки, таймер, повідомлення між учасниками, підпроцес тощо. Порожній список означає «не зазначено», а не «особливостей немає». Вимогу ставите ви (одразу підтверджена) або пропонує агент (з цитатою) — тоді підтверджуєте чи відхиляєте ви. Підтверджена вимога означає, що схему не буде побудовано, а погоджений опис лишається чинним.'),
    rs.length ? rs.map((r) => el('div', { class: 'claim' + (r.status === 'proposed' ? ' unknown' : '') },
      el('div', {}, el('span', { class: 'chip' }, r.id + ' · ' + ST[r.status] + ' · ' + (r.origin === 'agent' ? 'запропонував агент' : 'поставила аналітикиня')), ' ', r.kind_label, ` · крок ${r.step_id}`, r.step_action ? ` («${r.step_action}»)` : '', r.step_exists ? '' : el('strong', { style: 'color:var(--danger)' }, ' · ⚠ кроку немає в описі')),
      el('div', { class: 'small' }, r.detail),
      r.evidence_quote ? el('div', { class: 'small' }, 'Доказ: «' + r.evidence_quote + '» — ', r.evidence_title || r.evidence_source_id, r.evidence_check === 'quote_found' ? ' · цитату знайдено' : ' · ⚠ цитату НЕ знайдено', ' · ', el('button', { class: 'link', onclick: () => showSource(r.evidence_source_id, r.evidence_quote) }, 'Показати у джерелі')) : null,
      r.decision_note ? el('div', { class: 'small' }, `Рішення (${r.decided_by}): ${r.decision_note}`) : (r.decided_by ? el('div', { class: 'small' }, `Рішення: ${r.decided_by}`) : null),
      el('div', { class: 'actions' },
        r.status === 'proposed' ? el('button', { class: 'primary', onclick: () => decide(r, 'confirm') }, 'Підтвердити…') : null,
        r.status === 'proposed' ? el('button', { onclick: () => decide(r, 'reject') }, 'Відхилити…') : null,
        el('button', { onclick: async () => { if (!confirm('Прибрати вимогу ' + r.id + '? Буде створено нову версію; попередня лишиться в історії.')) return; const x = await act(() => api('POST', `/api/cases/${card.case.id}/notation/remove`, { base_version_id: card.head.id, requirement_id: r.id }), 'Вимогу прибрано (нова версія)'); if (x) await refresh(); } }, 'Прибрати…')))) : el('p', { class: 'notset' }, 'Не зазначено.'),
    add);
}

function previewBox(pv) {
  return el('div', { class: 'small', 'data-block': 'preview' }, el('strong', {}, 'Що зміниться, якщо прийняти: '),
    el('ul', {}, pv.lines.map((l) => el('li', {}, l))));
}

function proposalsView(card) {
  const ps = card.step_proposals || [];
  if (!ps.length) return null;
  const ST = { proposed: 'очікує рішення', accepted: 'прийнято', rejected: 'відхилено' };
  const prev = card.proposal_previews || { items: {}, bundles: [] };
  const bundleFor = (p) => (prev.items[p.id] && prev.items[p.id].better_with.length)
    ? prev.bundles.find((bd) => bd.ids.includes(p.id) && bd.ids.length === prev.items[p.id].better_with.length + 1) : null;
  return el('div', { class: 'warnbox', 'data-block': 'proposals' }, el('strong', {}, 'Пропозиції агента щодо кроків'),
    el('p', { class: 'small' }, 'Агент не вилучає кроків сам: крок лишається в описі, доки ви не приймете пропозицію. Перед прийняттям показано, що саме зміниться. Прийняття створює нову версію (стара збережеться) і потребує нового погодження.'),
    prev.bundles.map((bd) => el('div', { class: 'claim', 'data-block': 'bundle' },
      el('div', {}, el('span', { class: 'chip' }, 'Пов’язані пропозиції: ' + bd.ids.join(' + ')), ' Окремо кожна лишає проблеми потоку; прийняті разом вони дають узгоджений стан.'),
      previewBox(bd.preview),
      el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => acceptDialog(card, bd.ids, bd.preview) }, 'Прийняти разом: ' + bd.ids.join(' + ') + '…')))),
    ps.map((p) => {
      const pv = p.status === 'proposed' ? prev.items[p.id] : null;
      const bd = pv ? bundleFor(p) : null;
      return el('div', { class: 'claim' },
        el('div', {}, el('span', { class: 'chip' }, p.id + ' · ' + ST[p.status]), ' ',
          p.action === 'remove' ? `Вилучити крок ${p.step_id}` : `Замінити крок ${p.step_id} кроком ${p.replacement_step_id}`,
          p.step_action ? ` («${p.step_action}»)` : ''),
        el('div', { class: 'small' }, 'Причина: ' + p.reason),
        el('div', { class: 'small' }, 'Доказ: «' + p.evidence_quote + '» — ', p.evidence_title || p.evidence_source_id, p.evidence_check === 'quote_found' ? ' · цитату знайдено' : ' · ⚠ цитату НЕ знайдено в джерелі',
          el('button', { class: 'link', onclick: () => showSource(p.evidence_source_id, p.evidence_quote) }, 'Показати у джерелі')),
        p.step_analyst_edited ? el('div', { class: 'small', style: 'color:var(--danger)' }, '⚠ Цей крок редагувала аналітикиня.') : null,
        p.decision_note ? el('div', { class: 'small' }, `Рішення (${p.decided_by}): ${p.decision_note}`) : null,
        pv ? previewBox(pv) : null,
        pv && pv.better_with.length ? el('div', { class: 'small', style: 'color:var(--danger)' }, `Пов’язана з ${pv.better_with.join(', ')}: окремо після прийняття лишаться проблеми потоку.`) : null,
        p.status === 'proposed' ? el('div', { class: 'actions' },
          el('button', { class: bd ? '' : 'primary', onclick: () => acceptDialog(card, [p.id], pv) }, 'Прийняти лише цю…'),
          bd ? el('button', { class: 'primary', onclick: () => acceptDialog(card, bd.ids, bd.preview) }, 'Прийняти разом: ' + bd.ids.join(' + ') + '…') : null,
          el('button', { onclick: () => proposalDialog(card, p, 'reject') }, 'Відхилити…')) : null);
    }));
}

/** Прийняття однієї чи кількох пов'язаних пропозицій ОДНИМ явним рішенням; наслідки показано, за потреби — явне підтвердження. */
function acceptDialog(card, ids, pv) {
  const note = el('input', { type: 'text', placeholder: 'Примітка до рішення (необов’язково)' });
  const ack = el('input', { type: 'checkbox' });
  const btn = el('button', { class: 'primary', disabled: !!pv.needs_ack, onclick: async () => {
    dlg.close();
    const body = { base_version_id: card.head.id, decision: 'accept', note: note.value, preview_hash: pv.hash, acknowledge: pv.needs_ack ? ack.checked : false };
    if (ids.length > 1) body.proposal_ids = ids; else body.proposal_id = ids[0];
    const r = await act(() => api('POST', `/api/cases/${card.case.id}/step-proposals/decide`, body), ids.length > 1 ? 'Пов’язані пропозиції прийнято разом як одну нову версію' : 'Рішення збережено як нова версія');
    if (r) await refresh();
  } }, ids.length > 1 ? 'Прийняти разом: ' + ids.join(' + ') : 'Прийняти ' + ids[0]);
  ack.addEventListener('change', () => { btn.disabled = !!pv.needs_ack && !ack.checked; });
  openDialog(el('h2', {}, ids.length > 1 ? 'Прийняти разом пропозиції ' + ids.join(', ') : 'Прийняти пропозицію ' + ids[0]),
    previewBox(pv),
    pv.needs_ack ? el('label', { class: 'inline', 'data-block': 'ack' }, ack, 'Розумію, що після прийняття лишаться проблеми потоку, пов’язані з цією зміною, і підтверджую цей наслідок.') : null,
    el('p', { class: 'small' }, 'Чинне погодження (якщо є) скасується; нову версію потрібно буде прийняти й погодити заново. Інші пропозиції не змінюються.'),
    note, el('div', { class: 'actions' }, btn, el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

function proposalDialog(card, p, decision) {
  const note = el('input', { type: 'text', placeholder: 'Примітка до рішення (необов’язково)' });
  openDialog(el('h2', {}, (decision === 'accept' ? 'Прийняти' : 'Відхилити') + ' пропозицію ' + p.id),
    decision === 'accept' ? el('p', {}, 'Буде створено нову версію без кроку ' + p.step_id + '. Переходи, що вели до нього, ' + (p.action === 'replace' ? 'перейдуть на ' + p.replacement_step_id + '.' : 'стануть «невідомо» з критичним питанням.') + ' Чинне погодження (якщо є) скасується; нову версію треба буде прийняти й погодити знову.') : el('p', {}, 'Крок лишиться; пропозицію буде позначено відхиленою.'),
    note, el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: async () => { dlg.close(); const r = await act(() => api('POST', `/api/cases/${card.case.id}/step-proposals/decide`, { base_version_id: card.head.id, proposal_id: p.id, decision, note: note.value }), 'Рішення збережено як нова версія'); if (r) await refresh(); } }, 'Підтвердити'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

function questionView(card, q) {
  const open = q.status === 'open';
  const origin = q.origin === 'demo_script' ? ' · задано сценарієм демо (не виявлено AI)' : q.origin === 'agent' ? ' · запропоновано агентом' : ' · поставила аналітикиня';
  const ans = el('textarea', { placeholder: 'Текст уточнення (від кого, що саме). Буде збережено як окреме джерело.' });
  return el('div', { class: 'claim ' + (open && q.critical ? 'unknown' : ''), id: 'q-' + q.id },
    el('div', {}, el('span', { class: 'chip' }, q.id + ' · ' + (q.critical ? 'КРИТИЧНЕ' : 'некритичне') + ' · ' + (open ? 'відкрите' : 'закрите')), ' ', q.text),
    el('div', { class: 'small muted' }, 'Вплив: ' + (q.impact || '—') + (q.addressee ? ' · Кому: ' + q.addressee : '') + origin),
    (q.affects_transitions || []).map((a) => el('div', { class: 'small', 'data-block': 'link' },
      `Прив’язка: крок ${a.step_id}${a.condition ? ' («' + a.condition + '»)' : ''} — ${(card.link_kinds || {})[a.kind || 'direction']}.`,
      open ? el('button', { class: 'link', onclick: () => relinkDialog(card, q, a) }, 'Змінити вид прив’язки…') : null)),
    (q.link_history || []).map((h) => el('div', { class: 'small muted' }, `Прив’язку змінено (${h.by}): ${(card.link_kinds || {})[h.from]} → ${(card.link_kinds || {})[h.to]}. Причина: ${h.note}`)),
    q.criticality_note ? el('div', { class: 'small' }, 'Пояснення щодо критичності: ' + q.criticality_note) : null,
    open ? el('div', {}, ans, el('div', { class: 'actions' },
      el('button', { onclick: async () => { const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/answer`, { base_version_id: card.head.id, question_id: q.id, answer: ans.value }), 'Уточнення додано; створено нову версію'); if (r) await refresh(); } }, 'Закрити питання уточненням'),
      q.critical ? el('button', { onclick: () => critDialog(card, q) }, 'Зробити некритичним…') : null))
      : el('div', { class: 'small' }, 'Відповідь: ' + q.answer, ' · ', q.closed_by_source_id ? el('button', { class: 'link', onclick: () => showSource(q.closed_by_source_id) }, 'джерело відповіді') : ''));
}

function relinkDialog(card, q, a) {
  const cur = a.kind || 'direction';
  const sel = el('select', {}, Object.entries(card.link_kinds || {}).filter(([k]) => k !== cur).map(([k, t]) => el('option', { value: k }, t)));
  const note = el('input', { type: 'text', placeholder: 'Чому змінюєте прив’язку (обов’язково)' });
  openDialog(el('h2', {}, 'Вид прив’язки питання ' + q.id),
    el('p', {}, 'Зараз: ' + card.link_kinds[cur] + '. Питання лишається відкритим, його критичність не змінюється; змінюється лише вид цієї прив’язки. Буде створено нову версію; зміну збережено в історії.'),
    el('p', { class: 'hint' }, 'Справжній невідомий перехід так змінити не можна: спершу з’ясуйте напрямок.'),
    sel, note, el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: async () => { dlg.close(); const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/relink`, { base_version_id: card.head.id, question_id: q.id, step_id: a.step_id, condition: a.condition, to_kind: sel.value, note: note.value }), 'Прив’язку змінено; створено нову версію'); if (r) await refresh(); } }, 'Підтвердити'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

function critDialog(card, q) {
  const note = el('input', { type: 'text', placeholder: 'Чому це питання не критичне (обов’язково)' });
  openDialog(el('h2', {}, 'Змінити критичність ' + q.id), el('p', { class: 'hint' }, 'Це пояснення не замінює встановлення факту; воно зберігається у версії.'), note,
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: async () => { dlg.close(); const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/criticality`, { base_version_id: card.head.id, question_id: q.id, critical: false, note: note.value }), 'Критичність змінено (нова версія)'); if (r) await refresh(); } }, 'Зберегти'), el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

async function showSource(sourceId, quote) {
  const r = await act(() => api('GET', `/api/cases/${state.card.case.id}/sources/${sourceId}`));
  if (!r) return;
  const text = r.source.content; const idx = quote ? text.indexOf(quote) : -1;
  const box = el('div', { class: 'src-text' });
  if (idx >= 0) { const m = el('mark', {}, quote); box.append(text.slice(0, idx), m, text.slice(idx + quote.length)); setTimeout(() => m.scrollIntoView({ block: 'center' }), 50); }
  else box.textContent = text;
  openDialog(el('h2', {}, r.source.title), quote && idx < 0 ? el('p', { style: 'color:var(--danger)' }, '⚠ Фрагмент у джерелі не знайдено.') : null, box, el('div', { class: 'actions' }, el('button', { onclick: () => dlg.close() }, 'Закрити')));
}

// ───────────── запуск ─────────────
async function refresh() { await route(); }

async function route() {
  try {
    if (!state.config) {
      state.config = await api('GET', '/api/config');
      const b = document.getElementById('banner');
      if (state.config.banner) { b.textContent = state.config.banner; b.hidden = false; }
      else if (state.config.ai && state.config.ai.kind === 'real') {
        b.textContent = 'РЕЖИМ СПРАВЖНЬОЇ МОДЕЛІ (' + state.config.ai.model + '). Тексти джерел надсилаються постачальнику моделі; витрати обмежено. Використовуйте лише синтетичні матеріали.';
        b.className = 'banner real'; b.hidden = false;
      }
    }
    const m = /^#\/case\/([\w-]+)$/.exec(location.hash);
    if (m) await renderCase(m[1]); else await renderList();
  } catch (e) {
    if (e.status === 401) showLogin(); else app.replaceChildren(el('div', { class: 'card' }, el('h1', {}, 'Помилка'), el('p', {}, explain(e))));
  }
}
window.addEventListener('hashchange', route);
route();
