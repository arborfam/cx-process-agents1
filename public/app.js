'use strict';
// Простий інтерфейс без фреймворків. Уся логіка дозволів — на сервері; тут лише показ і введення.
// Дані завжди вставляються через textContent (без innerHTML), щоб текст джерел не міг виконатися як код.

const app = document.getElementById('app');
const state = { config: null, top: 'overview', tab: 'context', card: null, caseId: null, diagram: null, viewer: null, marked: [], diagramPoll: null, diagramSince: null, diagramLost: false };

/* ─────────── чернетки незавершеного введення (D98) ───────────
   Автоматичне оновлення стану не має стирати напівнабраний текст і кидати сторінку вгору.
   Значення перехоплюються ПІД ЧАС набору (делегованим слухачем), а не лише в момент перемальовування:
   інакше введене під час очікування відповіді сервера губиться.
   Чернетки належать конкретному кейсу й конкретному полю; між кейсами не переносяться
   й після успішного надсилання форми не відновлюються. */
const drafts = new Map();                       // caseId → Map(ключ → значення)
function draftsFor(caseId) {
  if (!drafts.has(caseId)) drafts.set(caseId, new Map());
  return drafts.get(caseId);
}
/** Стабільний ключ поля. `id` — найкращий; далі `name` (радіо — з урахуванням значення); інакше поле не зберігаємо. */
function draftKey(e) {
  if (e.dataset && e.dataset.draft) return 'd:' + e.dataset.draft;
  if (e.id) return 'i:' + e.id;
  if (e.name) return 'n:' + e.name;
  return null;
}
function rememberField(e) {
  if (!state.caseId || !e || !e.tagName) return;
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)) return;
  const k = draftKey(e); if (!k) return;
  const m = draftsFor(state.caseId);
  if (e.type === 'checkbox') m.set(k, e.checked);
  else if (e.type === 'radio') { if (e.checked) m.set(k, e.value); }
  else if (e.type === 'file') return;            // файл відновити не можна — і не вдаємо, що можна
  else m.set(k, e.value);
}
document.addEventListener('input', (ev) => rememberField(ev.target), true);
document.addEventListener('change', (ev) => rememberField(ev.target), true);

/** Прибрати чернетки після успішного надсилання: відновлювати вже надіслану форму не можна. */
function clearDrafts(caseId, keys) {
  const m = drafts.get(caseId); if (!m) return;
  for (const k of keys) { m.delete('i:' + k); m.delete('n:' + k); m.delete('d:' + k); }
}
function clearDraftsByPrefix(caseId, prefix) {
  const m = drafts.get(caseId); if (!m) return;
  for (const k of [...m.keys()]) if (k.slice(2).startsWith(prefix)) m.delete(k);
}

function captureUi() {
  const a = document.activeElement;
  return {
    y: window.scrollY,
    focus: a && a.id ? a.id : null,
    sel: a && a.id && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null,
    open: [...document.querySelectorAll('#app details[open]')].map((d) => (d.querySelector('summary') || {}).textContent || ''),
  };
}
function restoreUi(st) {
  const m = state.caseId ? drafts.get(state.caseId) : null;
  if (m) {
    document.querySelectorAll('#app input, #app textarea, #app select').forEach((e) => {
      const k = draftKey(e); if (!k || !m.has(k)) return;
      const v = m.get(k);
      // Відновлюємо навіть тоді, коли нове поле вже має значення: чернетка людини головніша.
      if (e.type === 'checkbox') e.checked = !!v;
      else if (e.type === 'radio') e.checked = e.value === v;
      else if (e.type !== 'file' && e.value !== v) e.value = v;
    });
  }
  if (!st) return;
  document.querySelectorAll('#app details').forEach((d) => {
    const t = (d.querySelector('summary') || {}).textContent || '';
    if (st.open.includes(t)) d.open = true;
  });
  if (st.focus) {
    const e = document.getElementById(st.focus);
    if (e) { e.focus(); if (st.sel && e.setSelectionRange) { try { e.setSelectionRange(st.sel[0], st.sel[1]); } catch (err) { /* не текстове поле */ } } }
  }
  window.scrollTo(0, st.y);
}

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
  // список кейсів має власну сторінку шириною контенту
  const { cases } = await api('GET', '/api/cases');
  const title = el('input', { type: 'text', id: 'newtitle', placeholder: 'Назва нового кейсу' });
  app.replaceChildren(el('div', { class: 'page' },
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
          'Завантажити демо-кейс (синтетичний)')))));
}

// ───────────── картка кейсу ─────────────
// Порядок блоків: шапка → Суть → Предметний опис AS-IS (вкладки) → Критичні прогалини й наступна дія → Головні зміни → Перевірки готовності.
async function renderCase(id) {
  const ui = state.caseId === id ? captureUi() : null;
  const card = await api('GET', '/api/cases/' + id);
  if (state.caseId !== id) { stopDiagram(); state.caseId = id; state.top = 'overview'; state.tab = 'context'; }
  state.card = card;

  const appbar = el('header', { class: 'appbar' }, el('div', { class: 'appbar-in' },
    el('a', { href: '#/', class: 'brand' }, '← усі кейси'),
    el('h1', {}, card.case.title),
    el('div', { class: 'chips' },
      el('span', { class: 'chip state' }, card.case.state_label),
      el('span', { class: 'chip' }, 'Версія ' + card.head.number + ' · ' + CREATED_BY[card.head.created_by] + versionOrigin(card)),
      card.approval
        ? el('span', { class: 'chip ok' }, 'Погоджено ' + fmt(card.approval.created_at))
        : el('span', { class: 'chip' }, 'Не погоджено'),
      modeChip(card),
      card.head.integrity_ok ? null : el('span', { class: 'chip err' }, 'Цілісність версії порушена')),
    el('nav', { class: 'tabs', id: 'toptabs', role: 'tablist' })));

  const main = el('main', { id: 'main' });
  app.replaceChildren(appbar, main);
  renderTop();
  clearTimeout(state.poll);
  if (card.runs[0] && card.runs[0].technical_state === 'running') {
    state.poll = setTimeout(() => { if (state.caseId === id) route(); }, 2000);
  }
  restoreUi(ui);
}

function renderTop() {
  const card = state.card; if (!card) return;
  const crit = card.gap_items.length;
  const openQ = card.other_open_questions_count + card.critical_open_questions.length;
  const bar = document.getElementById('toptabs');
  bar.replaceChildren(...TOP_TABS.map(([k, label]) => {
    const n = k === 'asis' && crit ? el('span', { class: 'n' }, String(crit))
      : k === 'asis' && openQ ? el('span', { class: 'n q' }, String(openQ))
      : k === 'sources' && card.sources.length ? el('span', { class: 'n plain' }, String(card.sources.length)) : null;
    return el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(state.top === k), 'data-top': k,
      onclick: () => { state.top = k; renderTop(); window.scrollTo(0, 0); },
    }, label, n);
  }));
  const main = document.getElementById('main');
  main.className = '';
  if (state.top === 'overview') main.replaceChildren(overviewPage(card));
  else if (state.top === 'asis') main.replaceChildren(asisPage(card));
  else if (state.top === 'sources') main.replaceChildren(el('div', { class: 'page' }, el('div', { class: 'cols' },
    el('div', { class: 'stack' }, el('div', { class: 'card lead' }, VIEWS.sources(card)), analysisCard(card)), railNext(card))));
  else if (state.top === 'diagram') main.replaceChildren(el('div', { class: 'page wide' }, el('div', { class: 'stack' }, el('div', { class: 'card' }, VIEWS.diagram(card)))));
  else main.replaceChildren(el('div', { class: 'page' }, el('div', { class: 'stack' }, el('div', { class: 'card' }, VIEWS.history(card)))));
}

/* ─────────────── Огляд ─────────────── */

/** Критичне бізнес-невідоме видно до будь-якого прокручування. */
function critLine(card) {
  const q = card.critical_open_questions[0];
  if (!q) return null;
  const n = card.critical_open_questions.length;
  const dup = state.top === 'asis' && state.tab === 'questions';
  return el('div', { class: 'note err critline' },
    el('strong', {}, n === 1 ? 'Критичне питання блокує погодження й побудову: ' : `${n} критичні питання блокують погодження й побудову: `),
    q.id + ' — ' + (q.text.length > 110 ? q.text.slice(0, 109) + '…' : q.text),
    dup ? null : el('button', { class: 'link', onclick: () => goToQuestion(q.id) }, 'Перейти до питання'));
}

function overviewPage(card) {
  const c = card.head.content;
  const ns = (t) => el('span', { class: 'notset' }, t || 'Ще не з’ясовано');
  const lead = el('section', { class: 'card lead' },
    el('h2', {}, 'Коротко'),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Що це за процес'), el('dd', {}, c.summary || ns()),
      el('dt', {}, 'Від'), el('dd', {}, c.boundaries.trigger ? clip(c.boundaries.trigger, 110) : ns()),
      el('dt', {}, 'До'), el('dd', {}, c.boundaries.completion || ns())),
    el('div', { class: 'actions' },
      el('button', { class: 'link', onclick: () => goTo('asis', 'context') }, 'Межі, ролі й бізнес-контекст →')));

  const item = (x) => el('li', {}, el('strong', {}, x.label + ': '), x.text);
  const top = card.changes.slice(0, 5), rest = card.changes.slice(5);
  const changes = el('section', { class: 'card' },
    el('h2', {}, 'Головні зміни від попередньої версії'),
    top.length ? el('ul', {}, top.map(item)) : el('p', { class: 'muted' }, 'Змін немає.'),
    rest.length ? el('details', {}, el('summary', {}, `Усі зміни (ще ${rest.length})`), el('ul', {}, rest.map(item))) : null);

  return el('div', { class: 'page' },
    critLine(card),
    el('div', { class: 'cols' },
      el('div', { class: 'stack' }, lead, runSection(card), changes),
      railNext(card, attentionCard(card))));
}

function clip(t, n) { return t.length > n ? t.slice(0, n - 1) + '…' : t; }

/** Стан тривалої операції — окремою карткою огляду. Автооновлення не стирає введення. */
function runSection(card) {
  const box = runBox(card);
  if (!box) return null;
  const r = latestRun(card);
  const running = r.technical_state === 'running';
  return el('section', { class: 'card' },
    el('h2', {}, running ? 'Запуск виконується' : 'Останній запуск'),
    running ? el('p', { class: 'small muted' }, 'Стан оновлюється сам. Введений текст і позиція на сторінці зберігаються.') : null,
    box);
}
function goTo(top, tab) {
  state.top = top; if (tab) state.tab = tab;
  renderTop(); window.scrollTo(0, 0);
}

/**
 * Видима дія аналізу після додавання джерел (D98). Раніше `aiButton` була визначена,
 * але в інтерфейс не потрапляла, тож запустити аналіз з екрана було неможливо.
 */
function analysisCard(card) {
  const n = card.sources.filter((s) => s.read_status === 'ok' && !s.covered).length;
  const ai = (card.ai && card.ai.analyst) || card.ai || {};
  return el('section', { class: 'card', 'data-block': 'analysis' },
    el('h2', {}, card.head.content.steps.length ? 'Оновити аналіз' : 'Запустити аналіз'),
    el('p', { class: 'small muted' }, n
      ? `Нових джерел, ще не врахованих у описі: ${n}. Аналіз виконується один раз на весь пакет.`
      : 'Усі додані джерела вже враховано в поточній версії. Новий запуск має сенс після нового джерела або уточнення.'),
    el('div', { class: 'actions' }, aiButton(card)),
    el('span', { class: 'paid' }, 'Платний етап: тексти джерел надсилаються постачальнику моделі.'),
    aiNote(card));
}

/** Одна картка «Наступна дія» для всіх вкладок: позначка витрат не змінюється від місця. */
function railNext(card, ...extra) {
  const na = card.next_action;
  const paid = na.key === 'start_bpmn' || na.key === 'update_analysis';
  return el('aside', { class: 'rail' },
    el('section', { class: 'card card-tight next' },
      el('h2', {}, 'Наступна дія'),
      el('p', { class: 'why' }, na.hint),
      !na.enabled && na.disabledReason ? el('div', { class: 'blocked' }, na.disabledReason) : null,
      el('button', { class: 'primary', disabled: !na.enabled, onclick: () => nextAction(card) }, na.label),
      paid ? el('span', { class: 'paid' }, 'Платний етап: звернення до моделі') : null,
      na.key === 'approve' ? el('span', { class: 'free' }, 'Погодження нічого не коштує й нічого не запускає.') : null,
      ['pending_approval', 'approved'].includes(card.case.state)
        ? el('button', { onclick: () => returnDialog(card) }, 'Повернути на доопрацювання') : null,
      aiNote(card)),
    ...extra.filter(Boolean));
}

/** Бізнес-питання, рішення й технічні проблеми розділені. */
function attentionCard(card) {
  const items = [];
  // Один маршрут до одного рішення: критичне питання вже стоїть рядком угорі.
  const shownAbove = card.critical_open_questions[0] ? card.critical_open_questions[0].id : null;
  for (const g of card.gap_items) {
    const business = g.kind === 'question' || g.kind === 'question_with_transitions';
    if (business && g.question_id && g.question_id === shownAbove) continue;
    items.push({
      tone: business ? 'err' : 'warn',
      label: business ? 'Критичне бізнес-невідоме' : 'Технічна прогалина опису',
      text: g.title ? g.title + '. ' + g.text : g.text,
      go: () => (g.question_id ? goToQuestion(g.question_id) : goTo('asis', 'steps')),
    });
  }
  if (card.other_open_questions_count) {
    items.push({ tone: '', label: 'Відкриті питання', text: `${card.other_open_questions_count} некритичних — не блокують`, go: () => goTo('asis', 'questions') });
  }
  const pend = (card.step_proposals || []).filter((p) => p.status === 'proposed').length;
  if (pend) items.push({ tone: 'warn', label: 'Рішення, якого очікують від вас', text: `Пропозицій агента без рішення: ${pend}`, go: () => goTo('asis', 'steps') });
  const failed = card.review.checks.filter((c) => c.status === 'fail').length;
  return el('section', { class: 'card card-tight' },
    el('h2', {}, 'Потребує уваги'),
    items.length ? el('div', { class: 'att' }, items.map((x) => el('div', { class: 'att-item' },
      el('div', {}, el('span', { class: 'chip ' + x.tone }, x.label)),
      el('div', { class: 'small' }, x.text),
      el('div', {}, el('button', { class: 'link', onclick: x.go }, 'Перейти →')))))
      : el('p', { class: 'small muted' }, 'Нічого не потребує уваги.'),
    el('details', {}, el('summary', {}, `Перевірки готовності (${card.review.checks.length}, не пройдено ${failed})`),
      reviewTable(card)));
}

function reviewTable(card) {
  const mark = { ok: '✔', fail: '✖', warn: '!' };
  return el('div', {},
    el('p', { class: 'small' }, el('strong', {}, card.review.ready_text)),
    el('table', {}, el('tbody', {}, card.review.checks.map((c) => el('tr', {},
      el('td', { style: 'width:2em' }, mark[c.status]),
      el('td', {}, c.label),
      el('td', { class: 'small muted' }, c.detail))))));
}

/* ─────────────── AS-IS ─────────────── */

/** Редагування біля відповідного змісту: окремої вкладки «Редагувати» немає (D98). */
function editBlock(card, focusField) {
  const empty = !card.head.content.steps.length && !card.head.content.boundaries.trigger;
  const d = el('details', { 'data-block': 'edit-inline', open: empty ? '' : undefined },
    el('summary', {}, 'Редагувати опис — створить нову версію'),
    VIEWS.edit(card));
  if (focusField) {
    setTimeout(() => {
      const f = d.querySelector(`[name="${focusField}"]`);
      if (f && d.open) f.focus();
    }, 60);
  }
  return d;
}

function asisPage(card) {
  const sub = el('nav', { class: 'subtabs', role: 'tablist' }, ...TABS.map(([k, label]) => {
    const n = k === 'questions' && card.critical_open_questions.length ? ' · ' + (card.critical_open_questions.length + card.other_open_questions_count) : '';
    return el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(state.tab === k),
      onclick: () => { state.tab = k; renderTop(); },
    }, label + n);
  }));
  const FOCUS = { context: 'trigger', steps: 'steps' };
  const panel = el('div', { id: 'panel' }, VIEWS[state.tab](card),
    ['context', 'steps'].includes(state.tab) ? editBlock(card, FOCUS[state.tab]) : null);
  return el('div', { class: 'page' }, critLine(card),
    el('div', { class: 'cols' },
      el('div', { class: 'stack' },
        el('section', { class: 'card lead' }, sub, panel)),
      railNext(card)));
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

function showTab(tab) { goTo(TOP_OF[tab] || 'asis', TOP_OF[tab] === 'asis' ? tab : null); }

/** Явний вибір початкового кроку. Система ніколи не обирає його сама (D27). Для погоджених записів створюється нова версія. */
function entryForm(card) {
  const steps = card.head.content.steps;
  if (!steps.length) return el('p', { class: 'hint' }, 'Спершу додайте кроки — форма «Редагувати опис» нижче на цій вкладці.');
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
  state.top = 'asis'; state.tab = 'questions'; renderTop();
  const n = document.getElementById('q-' + qid);
  if (n) { n.scrollIntoView({ block: 'center' }); n.style.outline = '3px solid var(--accent)'; setTimeout(() => { n.style.outline = ''; }, 2500); }
}

async function nextAction(card) {
  const k = card.next_action.key;
  if (k === 'resolve_blockers') {
    if (card.critical_open_questions.length) goToQuestion(card.critical_open_questions[0].id);
    else goTo(card.blockers.some((b) => b.code.includes('SOURCE')) ? 'sources' : 'asis', 'steps');
  } else if (k === 'accept' || k === 'submit' || k === 'approve') approveDialog(card);
  else if (k === 'clarify_entry') { const sel = document.getElementById('entry-select'); if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); } else goTo('asis', 'context'); }
  else if (k === 'clarify_process_name') { goTo('asis', 'context'); setTimeout(() => { const i = document.getElementById('process-name-input'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 50); }
  else if (k === 'fix_flow') goTo('asis', 'steps');
  else if (k === 'start_bpmn') goTo('diagram');
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
  // Одна фінальна дія: службові «Прийняти робочу версію» й «Передати на погодження»
  // для одного користувача виконує сервер в одній транзакції (D97). Перевірки ті самі.
  const btn = el('button', { class: 'primary', disabled: true, onclick: async () => {
    dlg.close();
    await act(() => api('POST', `/api/cases/${card.case.id}/approve/direct`, { version_id: card.head.id, checklist_confirmed: true }), 'AS-IS погоджено');
    await refresh();
  } }, 'Погодити версію ' + card.head.number);
  boxes.forEach((b) => b.addEventListener('change', () => { btn.disabled = !boxes.every((x) => x.checked); }));
  const reqs = (card.notation_requirements || []).filter((r) => r.status !== 'rejected');
  const c = card.head.content;
  openDialog(el('h2', {}, 'Погодити версію ' + card.head.number),
    el('p', { class: 'small muted' }, 'Перевірте, що саме погоджуєте. Це рішення людини; агент його ухвалити не може.'),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Початок процесу'), el('dd', { class: 'small' }, c.boundaries.trigger || '—'),
      el('dt', {}, 'Фактичне завершення'), el('dd', { class: 'small' }, c.boundaries.completion || '—')),
    card.other_open_questions_count
      ? el('div', { class: 'note info' }, `Після погодження лишаються відкритими ${card.other_open_questions_count} некритичних питань — вони не блокують побудову.`)
      : null,
    el('div', { class: 'note info' }, 'Погодження нічого не запускає: побудова схеми — окрема платна дія.'),
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
/** Верхній рівень — п'ять вкладок погодженого дизайну. */
const TOP_TABS = [['overview', 'Огляд'], ['asis', 'AS-IS'], ['sources', 'Джерела'], ['diagram', 'Схема'], ['history', 'Історія']];
/** Внутрішня навігація AS-IS. Редагування живе біля змісту, окремої вкладки немає. */
const TABS = [
  ['context', 'Бізнес-контекст і межі'], ['steps', 'Кроки'], ['claims', 'Твердження й докази'],
  ['questions', 'Питання'], ['problems', 'Проблеми й гіпотези'],
];
const TOP_OF = { context: 'asis', steps: 'asis', claims: 'asis', questions: 'asis', problems: 'asis', hypotheses: 'asis', edit: 'asis', sources: 'sources', diagram: 'diagram', history: 'history' };

// ───────────── вкладка «Схема»: смислова перевірка → рішення → побудова → перегляд (3b-3…3b-7) ─────────────
// Тут немає нічого предметного: ні ролей, ні назв кроків, ні термінів конкретного процесу.
// Три різні за природою речі показані окремо: зауваження агента, рішення людини, технічні помилки.

const REVIEW_STATE_LABEL = {
  none: 'перевірки ще не було', running: 'виконується…', failed: 'помилка запуску',
  unsupported: 'потрібна нотація, якої інструмент не будує', awaiting_analyst: 'чекає ваших рішень',
  clear: 'зауважень, що блокують, немає', stale: 'застаріла', untrusted: 'запису не довіряємо',
};
const ARTIFACT_STATUS_LABEL = {
  ok: 'схему побудовано й перевірено', blocked: 'не побудовано: структурні обмеження',
  unsupported: 'не побудовано: потрібна непідтримувана нотація', verification_failed: 'не побудовано: перевірка файлу не пройшла',
};
const FINDING_CODE_LABEL = {
  GATEWAY_SEMANTICS: 'сенс розгалуження', CONDITIONS_NOT_EXHAUSTIVE: 'умови не покривають усі випадки',
  TEXT_STRUCTURE_MISMATCH: 'текст не відповідає структурі', MULTIPLE_ACTORS: 'кілька виконавців в одному кроці',
  ENTRY_TRIGGER_MISMATCH: 'початок не відповідає тригеру', UNSUPPORTED_CANDIDATE: 'кандидат на непідтримувану нотацію',
};

let diagramReq = 0;
function stopDiagram() {
  clearTimeout(state.diagramPoll); state.diagramPoll = null;
  diagramReq++;                                   // запізнілі відповіді стають недійсними
  if (state.viewer) { try { state.viewer.destroy(); } catch (e) { /* уже знищено */ } state.viewer = null; }
  state.diagram = null; state.marked = [];
}

async function loadDiagram() {
  const id = state.caseId;
  const req = ++diagramReq;
  // `load_error`, а не `error`: у нормальній відповіді API поле `error` — це РЯДОК із причиною невдалого
  // запуску агента. Коли обидва випадки жили в одному полі, стан `failed` показувався як «undefined»,
  // а справжня причина, порушення й дії ховалися.
  const loadFail = (e) => ({ load_error: (e && e.message) ? e.message : String(e) });
  const [review, art] = await Promise.all([
    api('GET', `/api/cases/${id}/bpmn/review`).catch(loadFail),
    api('GET', `/api/cases/${id}/bpmn/artifact`).catch(loadFail),
  ]);
  // Відповідь кейсу А не має заміщати дані кейсу Б: і кейс, і номер запиту мають збігтися.
  if (req !== diagramReq || state.caseId !== id) return;
  state.diagram = { caseId: id, review, art };

  // ── Дефект 3: стан перевірки оновлюється сам до завершення або явної помилки ──
  const st = (review && review.state) || null;
  const transport = !!(review && review.load_error) || !!(art && art.load_error);
  clearTimeout(state.diagramPoll); state.diagramPoll = null;
  if (st === 'running' || transport) {
    state.diagramSince = state.diagramSince || Date.now();
    state.diagramLost = transport;
    // Читання стану моделі не викликає: це той самий GET, що й при відкритті вкладки.
    state.diagramPoll = setTimeout(() => { if (state.caseId === id) void loadDiagram(); }, transport ? 5000 : 2000);
  } else {
    state.diagramSince = null; state.diagramLost = false;
  }
  if (state.top === 'diagram') renderTop();   // схема тепер вкладка верхнього рівня
}

/**
 * Рішення людини щодо зауваження, яке блокує побудову. Для припущення про непідтримувану нотацію дія
 * називається «Відхилити припущення агента» (D84). Показуємо саму знахідку, цитату й місця її походження;
 * пояснення обов'язкове й НЕ підставляється автоматично — жодного готового тексту в полі немає.
 */
function rejectDialog(card, reviewId, view) {
  const f = view.finding;
  const candidate = f.code === 'UNSUPPORTED_CANDIDATE';
  const ta = el('textarea', { rows: '4', placeholder: candidate
    ? 'Чому ця конструкція не потрібна (не менше 10 символів): що саме в описі ви читаєте інакше, ніж агент. Пояснення зберігається незмінно й буде у звіті.'
    : 'Чому ви вважаєте опис однозначним (не менше 10 символів). Пояснення зберігається незмінно й буде у звіті.' });
  openDialog(
    el('h3', {}, candidate ? 'Відхилити припущення агента' : 'Відхилити зауваження з поясненням'),
    el('div', { class: 'small' }, el('strong', {}, (FINDING_CODE_LABEL[f.code] || f.code) + ' · кроки: ' + f.step_ids.join(', '))),
    el('div', {}, el('strong', {}, 'Питання агента: '), f.question),
    el('blockquote', {}, '«', f.quote, '»'),
    (view.quote_locations || []).length ? el('p', { class: 'small muted' }, 'Цитата з: ' + view.quote_locations.join('; ') + '.') : null,
    el('p', { class: 'small muted' }, candidate
      ? 'Рішення стосується лише цього припущення в цій перевірці погодженої версії. Воно НЕ означає, що непідтримувану конструкцію можна побудувати: підтверджені вимоги до нотації, структурні перевірки, інші зауваження й перевірка готових файлів діють як раніше. Нова версія опису чи нова перевірка це рішення не успадковують. Опис AS-IS і погодження не змінюються; запис незмінний, із вашим ім’ям і поясненням.'
      : 'Відхилення не скасовує програмних перевірок: їх буде виконано заново під час побудови. Опис AS-IS і погодження не змінюються.'),
    ta,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: async () => {
        if (ta.value.trim().length < 10) { toast('Потрібне пояснення (не менше 10 символів).'); return; }
        dlg.close();
        await act(() => api('POST', `/api/cases/${card.case.id}/bpmn/findings/reject`,
          { review_id: reviewId, finding_key: view.key, explanation: ta.value }), 'Рішення записано');
        await loadDiagram();
      } }, candidate ? 'Відхилити припущення' : 'Відхилити з поясненням'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

/**
 * Технічні обмеження генератора, видимі ДО платної перевірки (D86): їх знаходить програма без моделі.
 * Нічого не вирішує за людину — лише показує, що зупинить побудову, якщо лишити опис як є.
 */
function technicalLimitsBox(tl, card) {
  if (!tl) return null;
  if (!tl.available) return el('p', { class: 'small muted', 'data-block': 'tech-limits' }, 'Технічну перевірку опису поки не виконано: ' + (tl.reason || 'немає чинного погодження.'));
  const hard = [...(tl.blocking || []), ...(tl.unsupported || [])];
  const soft = tl.known_limits || [];
  if (!hard.length && !soft.length) {
    return el('p', { class: 'small muted', 'data-block': 'tech-limits' }, 'Технічних обмежень генератора в цьому описі не знайдено (перевірено без моделі, до запуску перевірки).');
  }
  const list = (items) => el('ul', { class: 'small' }, items.map((i) => el('li', {}, el('code', {}, i.code), ' ', i.message)));
  const label = tl.start_label && tl.start_label.needs_decision && card ? startLabelBox(card, tl.start_label) : null;
  return el('div', { class: hard.length ? 'warnbox' : 'infobox', 'data-block': 'tech-limits' },
    el('strong', {}, hard.length ? 'Технічні обмеження генератора (побудову зупинять)' : 'Відомі обмеження генератора (побудову не зупиняють)'),
    el('p', { class: 'small' }, 'Це перевірено ПРОГРАМОЮ без моделі — до платної смислової перевірки. Модель їх не виправить: ' +
      'або змініть опис (нова версія й нове погодження), або прийміть, що схему для цього місця не буде побудовано.'),
    hard.length ? list(hard) : null,
    label,
    soft.length ? el('details', {}, el('summary', { class: 'small' }, 'Обмеження, які побудову не зупиняють (' + soft.length + ')'), list(soft)) : null);
}

/**
 * Погодження короткого підпису початкової події (D88). Повний текст тригера НЕ змінюється: він лишається
 * в описі, у деталях події обох файлів і поряд зі схемою. Текст підпису пише людина — програма його не вигадує.
 */
function startLabelBox(card, info) {
  return el('div', { 'data-block': 'start-label' },
    el('p', { class: 'small' }, el('strong', {}, 'Підпис початкової події. '),
      'Тригер процесу має ' + info.trigger_chars + ' симв. — на схемі такий підпис нечитабельний. ' +
      'Скорочувати погоджений текст програма не буде. Ви можете погодити КОРОТКИЙ підпис саме для схеми: ' +
      'повний текст лишиться в описі, збережеться в деталях події у .bpmn і .drawio і буде видимий поруч зі схемою.'),
    el('button', { onclick: () => startLabelDialog(card) }, 'Погодити короткий підпис початкової події'));
}

async function startLabelDialog(card) {
  const r = await api('POST', `/api/cases/${card.case.id}/start-label/preview`, { label: '' });
  // Межа береться з чинного контракту сервера, а не зашита в інтерфейс.
  const max = r.preview.max_chars;
  const prop = r.preview.agent_proposal;
  const label = el('input', { type: 'text', maxlength: String(max), placeholder: 'Короткий підпис для схеми (пишете ви)', style: 'width:100%' });
  const left = el('div', { class: 'small muted' });
  const countLeft = () => { left.textContent = `${label.value.length} з ${max} символів`; };
  label.oninput = countLeft; countLeft();
  const reason = el('textarea', { rows: '3', placeholder: 'Чому саме такий підпис і що лишається в повному тексті (обов’язково)', style: 'width:100%' });
  openDialog(
    el('h3', {}, 'Короткий підпис початкової події'),
    el('p', { class: 'small' }, el('strong', {}, 'Повний текст тригера (не змінюється, ' + r.preview.trigger.length + ' симв.):')),
    el('blockquote', {}, r.preview.trigger),
    el('ul', { class: 'small' }, r.preview.consequences.map((x) => el('li', {}, x))),
    prop ? el('div', { class: 'warnbox' },
      el('div', {}, el('strong', {}, 'Варіант із аналізу (' + prop.chars + ' симв.): '), '«' + prop.text + '»'),
      el('div', { class: 'small' }, 'Його запропонував агент разом із повним описом — окремого запуску для цього не було. Перевірте текст: на схему він піде лише після вашого погодження.'),
      el('button', { class: 'link', onclick: () => { label.value = prop.text; countLeft(); label.focus(); } }, 'Підставити у поле й відредагувати')) : null,
    el('p', {}, el('strong', {}, 'Короткий підпис: ')), label, left,
    el('p', {}, el('strong', {}, 'Пояснення: ')), reason,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: async () => {
        if (!label.value.trim() || !reason.value.trim()) { toast('Потрібні підпис і пояснення.'); return; }
        dlg.close();
        await act(() => api('POST', `/api/cases/${card.case.id}/start-label/confirm`, { label: label.value, reason: reason.value }),
          'Підпис погоджено. Повний текст тригера не змінено.');
        await loadDiagram();
      } }, 'Погодити підпис'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

/**
 * Чому запуск агента 2 завершився помилкою. Показуємо справжню причину, порушення відповіді й журнал
 * КОЖНОЇ спроби — інакше людина бачить лише «помилка запуску» й не розуміє, що робити далі.
 * Сирих відповідей моделі тут немає: їх для невдалих запусків не зберігають.
 */
function reviewFailureBox(review) {
  const violations = review.violations || [];
  const attempts = review.failed_attempts || [];
  const vList = (items) => el('ul', { class: 'small' }, items.map((v) => el('li', {},
    el('code', {}, v.code), v.path ? ' ' + v.path : '', ': ', v.message)));
  return el('div', { class: 'warnbox', 'data-block': 'review-failed' },
    el('strong', {}, 'Смислова перевірка не завершилась. '),
    el('div', {}, review.error || 'Причину не записано.'),
    violations.length
      ? el('div', {}, el('p', { class: 'small' }, 'Що саме не так у відповіді агента:'), vList(violations))
      : null,
    attempts.length
      ? el('details', {}, el('summary', { class: 'small' }, `Журнал спроб (${attempts.length})`),
        ...attempts.map((a) => el('div', { class: 'small' },
          el('strong', {}, `Спроба ${a.attempt}: `), a.message || a.kind,
          (a.violations || []).length ? vList(a.violations) : null)))
      : null,
    el('p', { class: 'small' }, 'Опис, погодження й рішення не змінилися. Коли причину усунуто, перевірку можна запустити заново кнопкою нижче; ' +
      'якщо причина в самому описі — виправте опис і погодьте нову версію.'));
}

function findingBox(card, reviewId, view, canDecide) {
  const f = view.finding;
  const cls = view.resolution ? 'finding resolved' : view.blocking ? 'finding blocking' : 'finding info';
  return el('div', { class: cls },
    el('div', {},
      el('span', { class: 'chip' }, view.blocking ? 'блокує побудову' : 'зауваження'),
      ' ', el('strong', {}, FINDING_CODE_LABEL[f.code] || f.code),
      ' · кроки: ', f.step_ids.join(', ')),
    el('div', {}, el('strong', {}, 'Питання агента: '), f.question),
    el('blockquote', {}, '«', f.quote, '»'),
    // Звідки взято цитату. Підставою може бути будь-яке поле погодженого пакета (D85) — тому це довідка, а не
    // оцінка знахідки. Якщо доказ з одного поля, а названо крок, варто перевірити, чи поля не суперечать одне одному.
    (view.quote_locations || []).length
      ? el('div', { class: 'small' + (view.quote_from_step === false ? '' : ' muted') },
          'Цитата з: ' + view.quote_locations.join('; ') + '.',
          view.quote_from_step === false
            ? el('span', {}, ' Це не текст кроку ' + f.step_ids.join(', ') + ' — перевірте, чи опис кроку й цей текст узгоджені між собою: якщо вони описують різну поведінку, суперечність треба вирішити, а не ігнорувати.')
            : null)
      : null,
    (f.options || []).length ? el('div', { class: 'small' }, 'Варіанти від агента (не підставляються в опис автоматично): ' + f.options.join(' · ')) : null,
    view.resolution
      ? el('div', { class: 'decision' },
          el('strong', {}, 'Ваше рішення: відхилено. '), view.resolution.explanation,
          el('div', { class: 'small muted' }, `${view.resolution.decided_by}, ${view.resolution.decided_at}. Запис незмінний.`))
      : view.can_reject
        ? (canDecide ? el('div', { class: 'row' },
            el('button', { 'data-act': 'reject', onclick: () => rejectDialog(card, reviewId, view) },
              f.code === 'UNSUPPORTED_CANDIDATE' ? 'Відхилити припущення агента…' : 'Відхилити з поясненням'),
            el('button', { onclick: () => showTab('edit') }, 'Уточнити опис (нова версія)')) : null)
        : el('div', { class: 'small muted' }, view.reject_blocked_reason));
}

/**
 * Перехід до елемента схеми: центрує його, лишає робочий масштаб і підсвічує.
 * Нічого у файлі не змінює — це лише навігація.
 */
function goToElement(bpmnId) {
  const v = state.viewer; if (!v || !bpmnId) return false;
  try {
    const reg = v.get('elementRegistry');
    const shape = reg.get(bpmnId);
    if (!shape) { toast('Елемента ' + bpmnId + ' на цій схемі немає.'); return false; }
    const canvas = v.get('canvas');
    (state.marked || []).forEach((id) => { try { canvas.removeMarker(id, 'cx-selected'); } catch (e) { /* елемента вже немає */ } });
    state.marked = [bpmnId];
    canvas.addMarker(bpmnId, 'cx-selected');
    if (canvas.zoom() < 0.6) canvas.zoom(0.9);
    canvas.scrollToElement(shape, { top: 120, bottom: 120, left: 120, right: 120 });
    // Перехід до кроку має бути видимим: показуємо саме полотно, а не місце натискання.
    const host = v.get('canvas').getContainer().closest('.diagram') || v.get('canvas').getContainer();
    host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  } catch (e) { toast('Не вдалося перейти до елемента: ' + e.message); return false; }
}

/** Деталі кроку поруч зі схемою: повний текст дії й деталей із опису, а не з підпису на полотні. */
function stepDetails(card, row) {
  const step = (((card.head && card.head.content && card.head.content.steps) || [])).find((x) => x.id === row.step_id);
  openDialog(
    el('h3', {}, 'Крок ' + row.step_id + ' на схемі'),
    el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Роль'), el('div', { class: 'v' }, row.role)),
    el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Дія'), el('div', { class: 'v' }, row.action)),
    step && step.entry_condition ? el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Умова входу'), el('div', { class: 'v' }, step.entry_condition)) : null,
    step && step.result ? el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Результат'), el('div', { class: 'v' }, step.result)) : null,
    step && step.details ? el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Деталі опису'), el('div', { class: 'v' }, step.details)) : null,
    el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Елемент схеми'), el('div', { class: 'v' }, row.bpmn_task_id + (row.gateway_id ? ' · шлюз ' + row.gateway_id : ''))),
    el('div', { class: 'actions' },
      el('button', { onclick: () => { dlg.close(); goToElement(row.bpmn_task_id); } }, 'Показати на схемі'),
      row.gateway_id ? el('button', { onclick: () => { dlg.close(); goToElement(row.gateway_id); } }, 'Показати розгалуження') : null,
      el('button', { onclick: () => dlg.close() }, 'Закрити')));
}

function mountViewer(host, caseId, artifactId) {
  if (!window.BpmnJS) { host.replaceChildren(el('p', { class: 'muted' }, 'Переглядач не завантажився. Файл усе одно можна завантажити кнопкою нижче.')); return null; }
  host.replaceChildren();
  const viewer = new window.BpmnJS({ container: host });
  const q = artifactId ? `?artifact_id=${encodeURIComponent(artifactId)}` : '';
  fetch(`/api/cases/${caseId}/bpmn/file/bpmn${q}`, { headers: { 'x-requested-with': 'cx' } })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error('Сервер не віддав файл: ' + r.status))))
    .then((xml) => viewer.importXML(xml))
    .then(() => viewer.get('canvas').zoom('fit-viewport'))
    .catch((e) => host.replaceChildren(el('p', { class: 'warnbox' }, 'Схему не показано: ' + e.message)));
  return viewer;
}

function artifactBlock(card, a, isHistory) {
  const dl = (kind, label) => el('a', {
    class: 'btn', href: `/api/cases/${card.case.id}/bpmn/file/${kind}?artifact_id=${encodeURIComponent(a.id)}`, download: '',
  }, label);
  const host = el('div', { class: 'diagram' });
  const rows = a.map || [];
  return el('div', {},
    el('div', { class: 'artifact-state' },
      el('span', { class: 'chip' }, ARTIFACT_STATUS_LABEL[a.status] || a.status),
      a.current ? el('span', { class: 'chip ok' }, 'чинна') : el('span', { class: 'chip' }, a.label || 'не чинна'),
      el('span', { class: 'small muted' }, `${a.created_at} · ${a.generator}`)),
    el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Назва процесу'), el('div', { class: 'v' }, a.process_name || el('span', { class: 'notset' }, 'не зазначено'))),
    el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Версія опису'), el('div', { class: 'v' }, a.version_id + ' · хеш ' + a.content_hash.slice(0, 12) + '…')),
    !a.trusted ? el('div', { class: 'warnbox' }, 'Запису не довіряємо: ' + a.untrusted_reasons.join(' ')) : null,
    a.stale_reasons.length ? el('div', { class: 'stale' }, el('strong', {}, (a.label || 'Застаріла') + '. '), a.stale_reasons.join(' '),
      el('div', { class: 'small' }, 'Як чинний результат вона не видається й не завантажується. Щоб отримати схему для поточного опису, погодьте версію, виконайте смислову перевірку й побудуйте схему заново.')) : null,
    a.detail.explanation ? el('div', { class: 'warnbox' }, a.detail.explanation) : null,
    (a.detail.findings || []).length ? el('div', {}, el('h4', {}, 'Технічні обмеження, через які файл не створено'),
      el('ul', { class: 'small' }, a.detail.findings.map((f) => el('li', {}, `${f.code} (${f.class}): ${f.message}${f.refs && f.refs.length ? ' — ' + f.refs.join(', ') : ''}`)))) : null,
    (a.detail.issues || []).length ? el('div', {}, el('h4', {}, 'Помилки перевірки файлу' + (a.detail.stage ? ` (етап: ${a.detail.stage})` : '')),
      el('ul', { class: 'small' }, a.detail.issues.map((i) => el('li', {}, `${i.code}: ${i.message}`)))) : null,
    // Переглядач і завантаження показуємо лише для ЧИННОГО результату: для застарілого сервер файл не віддасть,
    // тож порожнє полотно з помилкою нічого не пояснює — пояснює позначка вище.
    a.status === 'ok' && a.current ? el('div', {},
      el('div', { class: 'diagram-bar' },
        el('button', { onclick: () => { if (state.viewer) { state.viewer.get('canvas').zoom('fit-viewport'); } } }, 'Показати всю схему'),
        el('button', { onclick: () => { if (state.viewer) { const c = state.viewer.get('canvas'); c.zoom(c.zoom() * 1.2); } } }, 'Збільшити'),
        el('button', { onclick: () => { if (state.viewer) { const c = state.viewer.get('canvas'); c.zoom(c.zoom() / 1.2); } } }, 'Зменшити'),
        a.downloads.bpmn ? dl('bpmn', 'Завантажити .bpmn') : el('span', { class: 'small muted' }, 'Файл .bpmn недоступний'),
        a.downloads.drawio ? dl('drawio', 'Завантажити .drawio') : el('span', { class: 'small muted' }, 'Перевірений .drawio недоступний'),
        a.has_csv ? dl('csv', 'Завантажити таблицю (.csv)') : null),
    // Повний текст тригера, коли на схемі стоїть погоджений короткий підпис (D88): людина бачить його поруч
    // зі схемою, а не лише у файлі.
    a.detail.start_full_trigger ? el('details', { 'data-block': 'full-trigger' },
      el('summary', { class: 'small' }, 'Повний текст тригера початкової події (на схемі — погоджений короткий підпис «' + (a.detail.start_label || '') + '»)'),
      el('blockquote', {}, a.detail.start_full_trigger)) : null,
      a.drawio_status === 'failed' ? el('div', { class: 'warnbox' },
        el('strong', {}, 'Експорт .drawio не пройшов власної звірки, тому не видається. '),
        'Файл .bpmn це не скасовує: він перевірений і чинний.',
        (a.detail.drawioIssues || []).length ? el('ul', { class: 'small' }, a.detail.drawioIssues.map((i) => el('li', {}, `${i.code}: ${i.message}`))) : null) : null,
      el('p', { class: 'small warnbox' }, 'Технічна перевірка доводить лише, що файл коректний і відповідає погодженому опису. Вона не доводить, що опис процесу правильний по суті: це вирішує людина.'),
      (!isHistory ? el('div', {}, host) : null),
      (a.detail.layoutWarnings || []).length ? el('details', {}, el('summary', { class: 'small' }, 'Попередження розкладки (' + a.detail.layoutWarnings.length + ')'),
        el('ul', { class: 'small' }, a.detail.layoutWarnings.map((w) => el('li', {}, w)))) : null,
      (a.detail.knownLimits || []).length ? el('details', {}, el('summary', { class: 'small' }, 'Відомі обмеження показу (' + a.detail.knownLimits.length + ')'),
        el('ul', { class: 'small' }, a.detail.knownLimits.map((f) => el('li', {}, `${f.code}: ${f.message}`)))) : null,
      rows.length ? el('details', { open: !isHistory }, el('summary', {}, 'Відповідність кроків опису елементам схеми (' + rows.length + ')'),
        el('table', {}, el('thead', {}, el('tr', {}, ['Крок', 'Роль', 'Дія', 'Елемент схеми', 'Доріжка', 'Шлюз', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, rows.map((r) => el('tr', { 'data-step-row': r.step_id },
            el('td', {}, r.step_id), el('td', {}, r.role),
            el('td', {}, el('button', { class: 'link', onclick: () => goToElement(r.bpmn_task_id) }, r.action)),
            el('td', {}, r.bpmn_task_id), el('td', {}, r.lane_id), el('td', {}, r.gateway_id || '—'),
            el('td', {}, el('button', { class: 'link', onclick: () => stepDetails(card, r) }, 'деталі'))))))) : null,
      (!isHistory ? el('div', { class: 'small muted' }, 'Полотно можна перетягувати; колесо — масштаб. Перехід до кроку — у таблиці нижче. Водяний знак bpmn.io є частиною ліцензії й не вилучається.') : null),
    ) : null,
    a.status === 'ok' && !a.current
      ? el('p', { class: 'small muted' }, 'Схему не показуємо: вона побудована за іншою версією опису. Нижче — відповідність кроків тієї версії елементам тієї схеми.')
      : null,
    (a.status === 'ok' && !a.current && (a.map || []).length
      ? el('details', {}, el('summary', {}, 'Відповідність кроків опису елементам схеми (' + a.map.length + ')'),
          el('table', {}, el('thead', {}, el('tr', {}, ['Крок', 'Роль', 'Дія', 'Елемент схеми', 'Доріжка', 'Шлюз'].map((h) => el('th', {}, h)))),
            el('tbody', {}, a.map.map((r) => el('tr', {}, el('td', {}, r.step_id), el('td', {}, r.role), el('td', {}, r.action),
              el('td', {}, r.bpmn_task_id), el('td', {}, r.lane_id), el('td', {}, r.gateway_id || '—'))))))
      : null),
    (!isHistory && a.status === 'ok' && a.current ? (() => { setTimeout(() => { state.viewer = mountViewer(host, card.case.id, a.id); }, 0); return null; })() : null));
}


function renderTabs() { renderTop(); }

function unknownView(card, step, n) {
  const u = card.unknown_transitions.find((x) => x.step_id === step.id && x.condition === n.condition);
  const qs = u ? u.questions : [];
  return el('div', { class: 'warnbox', style: 'margin:2px 0' },
    el('strong', {}, '❓ → НЕВІДОМО'), n.condition ? ' (' + n.condition + ')' : '', ' — ',
    qs.length ? qs.map((q) => el('span', {}, q.status === 'open' ? 'питання ' : 'питання (закрито) ', el('button', { class: 'link', onclick: () => goToQuestion(q.id) }, q.id), ' ')) : el('strong', {}, 'питання не вказано'),
    el('div', { class: 'small' }, 'Це не завершення й не крок: процес після цього моменту не з’ясовано.'));
}

function kv(label, value) { return el('tr', {}, el('th', {}, label), el('td', {}, value || el('span', { class: 'muted' }, 'не заповнено'))); }

const VIEWS = {
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
    if (!steps.length) return el('p', { class: 'muted' }, 'Кроків ще немає. Додайте їх у формі «Редагувати опис» нижче — або запустіть аналіз на вкладці «Джерела».');
    const entryLine = card.entry.defined
      ? el('p', { class: 'small' }, el('strong', {}, '▶ Початок: '), `${c.entry_step_id} — ${steps.find((x) => x.id === c.entry_step_id).action}`)
      : el('p', { class: 'warnbox' }, el('strong', {}, 'Початковий крок не задано. '), 'Оберіть його в блоці «Потребує уваги» або у формі «Редагувати опис» нижче.');
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
  problemsOnly: (card) => {
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
  hypothesesOnly: (card) => {
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
      if (ok) { clearDraftsByPrefix(card.case.id, 'q-new'); clearDrafts(card.case.id, ['critical']); await refresh(); }
    } }, el('h3', {}, 'Поставити питання (вручну)'),
      el('p', { class: 'hint' }, 'Питання можуть ставити аналітикиня, сценарій демо та (якщо підключено модель) агент. Нічого не імітується.'),
      el('label', {}, 'Питання'), el('input', { type: 'text', name: 'text', 'data-draft': 'q-new-text', required: true }),
      el('label', {}, 'Від чого залежить відповідь (вплив на опис)'), el('input', { type: 'text', name: 'impact', 'data-draft': 'q-new-impact' }),
      el('label', {}, 'Стосується переходу (необов’язково)'),
      el('select', { name: 'transition', 'data-draft': 'q-new-transition' }, el('option', { value: '' }, 'не стосується конкретного переходу'),
        transitions.map((t, i) => el('option', { value: String(i) }, `${t.step_id}${t.condition ? ' (' + t.condition + ')' : ''} → ${t.to === 'END' ? 'кінець' : t.to === 'UNKNOWN' ? 'невідомо' : t.to}`))),
      el('p', { class: 'hint' }, 'Якщо обрати перехід, він одразу стане «невідомо»: невідоме не записується в опис як факт.'),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'critical' }), 'Критичне (блокує погодження)'),
      el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Додати питання')));
    return el('div', {}, qs.length ? qs.map((q) => questionView(card, q)) : el('p', { class: 'muted' }, 'Питань немає.'), add);
  },
  sources: (card) => {
    const list = card.sources.length ? el('table', {}, el('thead', {}, el('tr', {}, ['Джерело', 'Тип', 'Походження', 'Читання', 'Враховано у версії'].map((h) => el('th', {}, h)))),
      el('tbody', {}, card.sources.map((s) => el('tr', {}, el('td', {}, s.read_status === 'ok' ? el('button', { class: 'link', onclick: () => showSource(s.id) }, s.title) : s.title, s.required ? ' (обов’язкове)' : ''),
        el('td', {}, KIND_LABEL[s.kind]),
        el('td', {}, ORIGIN_LABEL[s.origin], s.origin_corrected ? el('div', { class: 'small muted' }, 'походження виправлено аналітикинею') : null),
        el('td', {}, s.read_status === 'ok' ? 'прочитано' : el('span', { style: 'color:var(--danger)' }, '⚠ НЕ прочитано: ' + (s.read_error || ''))),
        el('td', {}, s.read_status !== 'ok' ? 'ні (не опрацьовано)' : s.covered ? 'так' : el('strong', { style: 'color:var(--danger)' }, 'ні — нове, не враховано')))))) : el('p', { class: 'muted' }, 'Джерел ще немає.');
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target;
      const ok = await act(() => api('POST', `/api/cases/${card.case.id}/sources`, { kind: f.kind.value, title: f.title.value, content: f.content.value, required: f.required.checked, origin: f.synthetic.checked ? 'synthetic' : 'real' }), 'Джерело додано');
      if (ok) { clearDraftsByPrefix(card.case.id, 'src-'); clearDrafts(card.case.id, ['kind', 'synthetic', 'required']); await refresh(); }
    } }, el('h3', {}, 'Додати текстове джерело'),
      el('p', { class: 'hint' }, 'Для навчальних перевірок використовуйте лише синтетичні (вигадані) матеріали: під час справжнього AI-запуску тексти джерел передаються постачальнику моделі (матеріали з позначкою «реальні» не надсилаються). Нове джерело повертає кейс до дослідження.'),
      el('label', {}, 'Тип'), el('select', { name: 'kind' }, ['transcript', 'request', 'document', 'analyst_note'].map((k) => el('option', { value: k }, KIND_LABEL[k]))),
      el('label', {}, 'Назва'), el('input', { type: 'text', name: 'title', 'data-draft': 'src-title', required: true }),
      el('label', {}, 'Текст'), el('textarea', { name: 'content', 'data-draft': 'src-content', required: true }),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'synthetic', checked: true }), 'Синтетичний (навчальний) матеріал'),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', name: 'required' }), 'Обов’язкове джерело'),
      el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Додати джерело')));
    const fileForm = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target; const file = f.file.files[0]; if (!file) return;
      const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; buf.forEach((b) => { bin += String.fromCharCode(b); });
      // Походження вказує людина. Ні назва файлу, ні розширення, ні режим роботи його не визначають (D98).
      const picked = f.querySelector('input[name="file-origin"]:checked');
      if (!picked) { toast('Оберіть походження файла: синтетичний приклад чи реальні дані.'); return; }
      const r = await act(() => api('POST', `/api/cases/${card.case.id}/sources/file`, { name: file.name, kind: 'document', content_base64: btoa(bin), required: f.required.checked, origin: picked.value }));
      if (r) { toast(r.read_status === 'ok' ? 'Файл прочитано' : 'Файл НЕ прочитано: ' + r.read_error, r.read_status === 'ok'); clearDrafts(card.case.id, ['file', 'file-origin', 'required']); await refresh(); }
    } }, el('h3', {}, 'Додати файл (.txt або .md)'), el('input', { type: 'file', name: 'file' }),
      el('fieldset', { class: 'origin-pick' },
        el('legend', { class: 'small' }, 'Походження файла (обов’язково)'),
        el('label', { class: 'inline' }, el('input', { type: 'radio', name: 'file-origin', value: 'synthetic' }), 'синтетичний приклад — вигаданий для навчання'),
        el('label', { class: 'inline' }, el('input', { type: 'radio', name: 'file-origin', value: 'real' }), 'реальні дані — з роботи з людьми'),
        el('div', { class: 'small muted' }, 'Матеріали з позначкою «реальні дані» моделі не надсилаються (D18).')),
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
  /** Проблеми, гіпотези й рішення — в одній вкладці, але розділені заголовками. */
  problems: (card) => el('div', {},
    el('h3', { class: 'group-h' }, 'Проблеми й вплив'), VIEWS.problemsOnly(card),
    el('h3', { class: 'group-h' }, 'Гіпотези'), VIEWS.hypothesesOnly(card),
    el('h3', { class: 'group-h' }, 'Рішення аналітикині'), decisionsBlock(card)),

  history: (card) => el('div', {},
    el('h3', {}, 'Версії'), el('table', {}, el('thead', {}, el('tr', {}, ['№', 'Автор', 'Режим', 'Створено', 'Примітка', 'Статус'].map((h) => el('th', {}, h)))),
      el('tbody', {}, card.versions.map((v) => el('tr', {}, el('td', {}, v.number + (v.is_head ? ' (поточна)' : '')), el('td', {}, CREATED_BY[v.created_by]), el('td', {}, v.mode === 'demo' ? 'ДЕМО' : v.mode),
        el('td', {}, fmt(v.created_at)), el('td', {}, v.note), el('td', {}, (v.kind === 'proposal' ? 'пропозиція на застарілій основі; ' : '') + (v.accepted ? 'прийнята аналітиком' : '')))))),
    el('h3', {}, 'Погодження'), card.approvals_history.length ? el('ul', {}, card.approvals_history.map((a) => el('li', {},
      `Версія ${card.versions.find((v) => v.id === a.version_id)?.number ?? '?'} · ${a.approver} · ${fmt(a.created_at)} · `, a.revoked_reason ? `скасовано (${a.revoked_reason}, ${fmt(a.revoked_at)})` : 'чинне'))) : el('p', { class: 'muted' }, 'Погоджень ще не було.'),
    el('h3', {}, 'Запуски'), card.runs.length ? el('ul', {}, card.runs.map((r) => el('li', {}, `${r.agent} · ${r.mode === 'real' ? 'справжня модель ' + r.model : 'підставний клієнт (не AI)'} · інструкція ${r.instruction_version}${r.instruction_hash ? ' (' + r.instruction_hash.slice(0, 8) + ')' : ''} · ${r.technical_state}${r.duration_ms != null ? ' · ' + (r.duration_ms / 1000).toFixed(1) + ' с' : ''}${costText(r)}${r.attempts > 1 ? ' · спроб: ' + r.attempts : ''}${r.note ? ' · ' + r.note : ''}${r.error ? ' · помилка: ' + r.error : ''}`))) : el('p', { class: 'muted' }, 'Запусків ще не було.'),
    el('h3', {}, 'Журнал подій'), el('ul', { class: 'small' }, card.audit.slice(0, 15).map((a) => el('li', {}, `${fmt(a.at)} · ${a.actor} · ${a.action}`)))),
};

// ───────────── рішення аналітикині та їхня актуальність (D96) ─────────────
const DEC_TONE = { valid: 'ok', needs_confirmation: 'warn', review: 'warn', void: 'danger' };
const CHECK_MARK = { ok: '✓', changed: '✗', unknown: '?' };

function decisionsBlock(card) {
  const host = el('div', { 'data-block': 'decisions' }, el('h3', {}, 'Рішення аналітикині'), el('p', { class: 'muted' }, 'Завантаження…'));
  loadDecisions(card, host);
  return host;
}

async function loadDecisions(card, host) {
  const r = await api('GET', `/api/cases/${card.case.id}/decisions`).catch(() => null);
  const items = r ? r.decisions : [];
  host.replaceChildren(
    el('h3', {}, 'Рішення аналітикині'),
    el('p', { class: 'small muted' }, 'Рішення щодо окремого питання не погоджує версію AS-IS.'),
    items.length ? el('div', {}, items.map((d) => decisionCard(card, d, host))) : el('p', { class: 'muted' }, 'Рішень ще немає.'),
    el('div', { class: 'actions' }, el('button', { onclick: () => newDecisionDialog(card, host) }, 'Записати рішення')));
}

function decisionCard(card, d, host) {
  const cur = d.currency;
  const chinne = cur.state === 'valid';
  return el('div', { class: 'finding' + (cur.state === 'void' ? ' blocking' : ''), 'data-decision': d.id },
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, d.id.slice(0, 10)),
      el('span', { class: 'chip ' + (DEC_TONE[cur.state] === 'ok' ? 'ok' : '') }, cur.state_label),
      el('span', { class: 'chip' }, d.author + ' · ' + fmt(d.created_at))),
    el('div', {}, el('strong', {}, d.subject)),
    el('blockquote', {}, d.explanation),
    el('div', { class: 'small muted' }, 'Застосовано до: '
      + [...(d.scope.question_ids || []).map((x) => 'питання ' + x), ...(d.scope.step_ids || []).map((x) => 'крок ' + x)].join(', ')),
    (d.evidence || []).length ? el('div', { class: 'small' }, 'Докази: ', (d.evidence || []).map((e) => {
      const src = (card.sources || []).find((x) => x.id === e.source_id);
      return el('span', {}, el('button', { class: 'link', onclick: () => showSource(e.source_id, e.quote || undefined) },
        (src && (src.ref || src.title)) || e.source_id), ' ');
    })) : null,
    (cur.diffs || []).length
      ? el('div', { class: 'small' }, 'Змінилося: ' + cur.diffs.map((d) => d.object + ' · ' + d.field).join('; '))
      : null,
    el('details', {}, el('summary', { class: 'small' }, 'Що саме звірено (' + cur.checks.length + ')'),
      el('ul', { class: 'small' }, cur.checks.map((c) => el('li', {},
        (CHECK_MARK[c.status] || '') + ' ' + c.label + ': ' + c.detail)))),
    chinne
      ? el('div', { class: 'small muted' }, 'Рішення діє — підтверджувати його не потрібно.')
      : el('div', { class: 'actions' },
          cur.state === 'void'
            ? el('span', { class: 'small' }, 'Підстава змінилася: перенести це рішення не можна. Запишіть нове — попереднє пояснення лишається в історії.')
            : el('button', { onclick: () => confirmDecisionDialog(card, d, host) }, 'Переглянути й підтвердити…')),
    (d.applications || []).length > 1
      ? el('details', {}, el('summary', { class: 'small' }, 'Застосування (' + d.applications.length + ')'),
          el('ul', { class: 'small' }, d.applications.map((a) => el('li', {}, `${fmt(a.at)} · ${a.actor} · ${a.kind} · ${a.note}`))))
      : null);
}

function confirmDecisionDialog(card, d, host) {
  const cur = d.currency;
  const text = el('textarea', { rows: '4', style: 'width:100%' });
  text.value = d.explanation;           // попереднє пояснення вже в полі: вводити заново не треба
  const note = el('input', { type: 'text', placeholder: 'Коротко: що саме ви перевірили (необов’язково)', style: 'width:100%' });
  openDialog(
    el('h3', {}, 'Рішення: ' + d.subject),
    el('p', { class: 'small' }, el('strong', {}, cur.state_label)),
    (cur.diffs || []).length
      ? el('div', {}, el('h4', {}, 'Що саме змінилося'),
          el('table', {}, el('thead', {}, el('tr', {}, ['Об’єкт', 'Поле', 'Було', 'Стало'].map((h) => el('th', {}, h)))),
            el('tbody', {}, cur.diffs.map((d) => el('tr', {},
              el('td', {}, d.object), el('td', {}, d.field),
              el('td', { class: 'small muted' }, d.was || '—'),
              el('td', { class: 'small' }, d.now || '—'))))))
      : cur.changed.length ? el('div', {}, el('h4', {}, 'Що змінилося'),
          el('ul', { class: 'small' }, cur.changed.map((x) => el('li', {}, x))),
          el('p', { class: 'small muted' }, 'Точного порівняння полів тут немає: порівнювати немає з чим.')) : null,
    cur.unknown.length ? el('div', {}, el('h4', {}, 'Чого перевірка не встановила'),
      el('ul', { class: 'small' }, cur.unknown.map((x) => el('li', {}, x))),
      el('p', { class: 'small warnbox' }, 'Це не означає «все гаразд»: названі місця програма перевірити не змогла.')) : null,
    el('p', {}, el('strong', {}, 'Ваше пояснення (можна залишити як є): ')), text,
    note,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: async () => {
        dlg.close();
        await act(() => api('POST', `/api/cases/${card.case.id}/decisions/confirm`,
          { decision_id: d.id, explanation: text.value, note: note.value }), 'Рішення підтверджено для поточної версії');
        await loadDecisions(card, host);
      } }, 'Підтвердити'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

function newDecisionDialog(card, host) {
  const subject = el('input', { type: 'text', style: 'width:100%', placeholder: 'Предмет рішення' });
  const explanation = el('textarea', { rows: '4', style: 'width:100%', placeholder: 'Чому саме так (обов’язково)' });
  const steps = card.head.content.steps.map((s) => el('label', { class: 'inline' },
    el('input', { type: 'checkbox', name: 'dec-step', value: s.id }), ' ' + s.id + ' — ' + s.action));
  const qs = card.head.content.questions.map((q) => el('label', { class: 'inline' },
    el('input', { type: 'checkbox', name: 'dec-q', value: q.id }), ' ' + q.id));
  const srcSel = el('select', {}, el('option', { value: '' }, '— без доказу —'),
    ...(card.sources || []).filter((x) => x.read_status === 'ok').map((x) => el('option', { value: x.id }, (x.ref ? x.ref + ' · ' : '') + x.title)));
  const quote = el('textarea', { rows: '2', style: 'width:100%', placeholder: 'Фрагмент джерела дослівно (необов’язково)' });
  openDialog(
    el('h3', {}, 'Записати рішення'),
    el('p', {}, el('strong', {}, 'Предмет: ')), subject,
    el('p', {}, el('strong', {}, 'Пояснення: ')), explanation,
    el('p', {}, el('strong', {}, 'До чого застосовується: ')),
    el('div', {}, qs), el('div', {}, steps),
    el('p', {}, el('strong', {}, 'Доказ: ')), srcSel, quote,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: async () => {
        const pick = (n) => [...document.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => x.value);
        const ev = srcSel.value ? [{ source_id: srcSel.value, quote: quote.value }] : [];
        dlg.close();
        await act(() => api('POST', `/api/cases/${card.case.id}/decisions`, {
          subject: subject.value, explanation: explanation.value,
          question_ids: pick('dec-q'), step_ids: pick('dec-step'), evidence: ev,
        }), 'Рішення записано');
        await loadDecisions(card, host);
      } }, 'Записати'),
      el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

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
  const ans = el('textarea', { id: 'answer-' + q.id, placeholder: 'Текст уточнення (від кого, що саме). Буде збережено як окреме джерело.' });
  return el('div', { class: 'claim ' + (open && q.critical ? 'unknown' : ''), id: 'q-' + q.id },
    el('div', {}, el('span', { class: 'chip' }, q.id + ' · ' + (q.critical ? 'КРИТИЧНЕ' : 'некритичне') + ' · ' + (open ? 'відкрите' : 'закрите')), ' ', q.text),
    el('div', { class: 'small muted' }, 'Вплив: ' + (q.impact || '—') + (q.addressee ? ' · Кому: ' + q.addressee : '') + origin),
    (q.affects_transitions || []).map((a) => {
      // Прив'язка до кроку, якого в описі немає (типово після прийнятого вилучення): вид прив'язки цього не лікує,
      // потрібне явне відкріплення людиною (D82).
      const stale = (card.stale_links || []).find((x) => x.question_id === q.id && x.step_id === a.step_id && x.condition === a.condition);
      return el('div', { class: 'small' + (stale ? ' unknown' : ''), 'data-block': 'link' },
        `Прив’язка: крок ${a.step_id}${a.condition ? ' («' + a.condition + '»)' : ''} — ${(card.link_kinds || {})[a.kind || 'direction']}.`,
        stale ? el('span', { style: 'color:var(--danger)' }, ' ⚠ Кроку ' + a.step_id + ' у описі немає (вилучено). Прив’язка неактуальна й блокує передачу на погодження як технічна прогалина.') : null,
        open && stale ? el('button', { class: 'link', 'data-act': 'unlink', onclick: () => unlinkDialog(card, q, stale) }, 'Відкріпити від вилученого кроку…') : null,
        open && !stale ? el('button', { class: 'link', onclick: () => relinkDialog(card, q, a) }, 'Змінити вид прив’язки…') : null);
    }),
    (q.link_history || []).map((h) => el('div', { class: 'small muted' }, h.to === undefined || h.to === null
      ? `Прив’язку знято (${h.by}): крок ${h.step_id}${h.condition ? ' («' + h.condition + '»)' : ''}, було «${(card.link_kinds || {})[h.from]}». Причина: ${h.note}`
      : `Прив’язку змінено (${h.by}): ${(card.link_kinds || {})[h.from]} → ${(card.link_kinds || {})[h.to]}. Причина: ${h.note}`)),
    q.criticality_note ? el('div', { class: 'small' }, 'Пояснення щодо критичності: ' + q.criticality_note) : null,
    open ? el('div', {}, el('label', { class: 'small', for: 'answer-' + q.id }, 'Текст уточнення'), ans) : null,
    open ? answerBasisBlock(card, q, ans) : null,
    open ? transitionBlock(card, q) : null,
    open ? el('div', { class: 'actions' },
      el('button', { onclick: () => submitAnswer(card, q, ans) }, 'Закрити питання уточненням'),
      q.critical ? el('button', { onclick: () => critDialog(card, q) }, 'Зробити некритичним…') : null)
      : closedAnswerBlock(card, q));
}

// ───────────── підстава відповіді на питання (D93) ─────────────
// Три ознаки зберігаються окремо: звідки факт, хто правив текст, чим є твердження.
// Редагування цитати НЕ перетворює відповідь на власний висновок.
const basisState = new Map();   // question_id → { kind, sourceId, quote }

/**
 * Відповісти на питання, спираючись на вже відкритий доказ (D97).
 * Джерело й фрагмент відомі — копіювати цитату вручну не потрібно; змінити їх можна в тій самій формі.
 */
function answerFromEvidence(qid, sourceId, quote) {
  basisState.set(qid, { kind: 'source', sourceId, quote: (quote || '').trim() });
  goToQuestion(qid);
  setTimeout(() => {
    const a = document.getElementById('answer-' + qid);
    if (a) { if (!a.value) a.value = (quote || '').trim(); a.focus(); }
  }, 60);
}

function answerBasisBlock(card, q, ans) {
  const st = basisState.get(q.id) || { kind: 'source', sourceId: '', quote: '' };
  basisState.set(q.id, st);
  const usable = (card.sources || []).filter((x) => x.read_status === 'ok' && x.kind !== 'clarification');
  const box = el('div', { class: 'origin-pick', 'data-block': 'basis' });
  const redraw = () => { const n = answerBasisBlock(card, q, ans); box.replaceWith(n); };

  const pick = (value, label) => el('label', {},
    el('input', {
      type: 'radio', name: 'basis-' + q.id, value, checked: st.kind === value ? '' : undefined,
      onchange: () => { st.kind = value; redraw(); },
    }), ' ' + label);

  // `append` вставив би порожні значення як текст «null» — тому відсіюємо їх
  const put = (...xs) => box.append(...xs.filter((x) => x !== null && x !== undefined && x !== false));
  put(
    el('legend', { class: 'small' }, 'На чому ґрунтується відповідь (обов’язково)'),
    pick('source', 'на фрагменті джерела'),
    pick('analyst_confirmed', 'на моєму підтвердженому висновку'));

  if (st.kind === 'source') {
    if (!usable.length) {
      put(el('div', { class: 'small unknown' }, 'Прочитаних джерел у кейсі ще немає — спирайтесь на власний висновок або додайте джерело.'));
      return box;
    }
    const sel = el('select', { onchange: (e) => { st.sourceId = e.target.value; redraw(); } },
      el('option', { value: '' }, '— оберіть джерело —'),
      ...usable.map((x) => el('option', { value: x.id, selected: st.sourceId === x.id ? '' : undefined },
        (x.ref ? x.ref + ' · ' : '') + x.title + ' (' + (ORIGIN_LABEL[x.origin] || x.origin) + ')')));
    const quote = el('textarea', { placeholder: 'Вставте фрагмент із джерела дослівно' }, st.quote);
    quote.value = st.quote;
    quote.oninput = () => { st.quote = quote.value; markEdit(); };
    const mark = el('div', { class: 'small muted' });
    const markEdit = () => {
      const edited = st.quote.trim() && ans.value.trim() !== st.quote.trim();
      mark.textContent = !st.quote.trim() ? ''
        : edited
          ? 'Текст відповіді відрізняється від цитати. Зв’язок із джерелом зберігається, редакцію буде записано на вас.'
          : 'Відповідь дослівно збігається з цитатою.';
    };
    ans.oninput = markEdit; markEdit();
    put(
      el('label', { class: 'small' }, 'Джерело'), sel,
      el('label', { class: 'small' }, 'Фрагмент джерела'), quote,
      st.sourceId ? el('button', { class: 'link', onclick: () => showSource(st.sourceId, st.quote || undefined) }, 'Показати фрагмент у джерелі') : null,
      mark,
      el('div', { class: 'small muted' }, 'Походження матеріалу береться з джерела. Якщо ви зміните текст синтетичної цитати, походження доведеться підтвердити.'),
      originPick(q, 'Походження відредагованого тексту (якщо текст змінено)'));
  } else {
    put(
      el('label', { class: 'small' }, 'На чому ґрунтується висновок (обов’язково)'),
      el('textarea', { id: 'basis-note-' + q.id, placeholder: 'Напр.: спостерігала особисто на двох кейсах у вересні' }),
      q.critical
        ? el('label', { class: 'small' },
            el('input', { type: 'checkbox', id: 'basis-fact-' + q.id }),
            ' підтверджую: це встановлений факт про фактичний процес, а не бажаний або запланований варіант')
        : null,
      originPick(q, 'Походження уточнення (обов’язково)'));
  }
  return box;
}

function originPick(q, legend) {
  return el('fieldset', { class: 'origin-pick' },
    el('legend', { class: 'small' }, legend),
    el('label', {}, el('input', { type: 'radio', name: 'origin-' + q.id, value: 'synthetic' }), ' синтетичне — вигадане для навчального прикладу'),
    el('label', {}, el('input', { type: 'radio', name: 'origin-' + q.id, value: 'real' }), ' реальні дані — з роботи з людьми'),
    el('div', { class: 'small muted' }, 'Реальні дані моделі не надсилаються (D18).'));
}

/** Переходи, які стануть визначеними разом із відповіддю. Прихованого обов'язку після відповіді не лишається. */
function transitionBlock(card, q) {
  const links = (q.affects_transitions || []).filter((l) => (l.kind || 'direction') === 'direction');
  const steps = card.head.content.steps;
  const pending = [];
  for (const l of links) {
    const st = steps.find((x) => x.id === l.step_id);
    if (st && st.next.some((n) => n.condition === l.condition && n.to === 'UNKNOWN')) pending.push(l);
  }
  if (!pending.length) return null;
  const opts = [...steps.map((x) => [x.id, x.id + ' — ' + x.action]), ['END', 'END — процес завершується']];
  return el('fieldset', { class: 'origin-pick', 'data-block': 'transitions' },
    el('legend', { class: 'small' }, 'Куди ведуть переходи, що залежали від цього питання'),
    el('div', { class: 'small muted' }, 'Вони стануть визначеними разом із відповіддю — окремо лагодити крок не доведеться.'),
    pending.map((l) => el('div', {},
      el('label', { class: 'small', for: `tr-${q.id}-${l.step_id}-${l.condition}` },
        `Крок ${l.step_id}` + (l.condition ? ` · умова «${l.condition}»` : ' · єдиний перехід')),
      el('select', { id: `tr-${q.id}-${l.step_id}-${l.condition}`, 'data-step': l.step_id, 'data-cond': l.condition },
        el('option', { value: '' }, '— лишити «невідомо» —'),
        ...opts.map(([v, t]) => el('option', { value: v }, t))))));
}

async function submitAnswer(card, q, ans) {
  const st = basisState.get(q.id) || { kind: 'source' };
  const picked = document.querySelector(`input[name="origin-${q.id}"]:checked`);
  let basis;
  if (st.kind === 'source') {
    if (!st.sourceId) { toast('Оберіть джерело, на яке спирається відповідь.'); return; }
    if (!(st.quote || '').trim()) { toast('Вставте фрагмент джерела, на який спирається відповідь.'); return; }
    basis = { kind: 'source', source_id: st.sourceId, quote: st.quote.trim(), edited: ans.value.trim() !== st.quote.trim() };
  } else {
    const note = (document.getElementById('basis-note-' + q.id) || {}).value || '';
    if (!note.trim()) { toast('Напишіть, на чому ґрунтується ваш висновок.'); return; }
    const fact = document.getElementById('basis-fact-' + q.id);
    basis = { kind: 'analyst_confirmed', note: note.trim(), acknowledged_factual: fact ? fact.checked : true };
    if (!picked) { toast('Оберіть походження уточнення: синтетичне чи реальні дані.'); return; }
  }
  const body = { base_version_id: card.head.id, question_id: q.id, answer: ans.value, basis };
  if (picked) body.origin = picked.value;
  const trs = [...document.querySelectorAll(`[data-block="transitions"] select[id^="tr-${q.id}-"]`)]
    .filter((e) => e.value)
    .map((e) => ({ step_id: e.dataset.step, condition: e.dataset.cond, to: e.value }));
  if (trs.length) body.transitions = trs;
  const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/answer`, body), 'Уточнення додано; створено нову версію');
  if (r) {
    basisState.delete(q.id);
    clearDraftsByPrefix(card.case.id, 'answer-' + q.id);
    clearDraftsByPrefix(card.case.id, 'basis-' + q.id);
    clearDraftsByPrefix(card.case.id, 'origin-' + q.id);
    clearDraftsByPrefix(card.case.id, 'tr-' + q.id);
    await refresh();
  }
}

function closedAnswerBlock(card, q) {
  const src = (card.sources || []).find((x) => x.id === q.closed_by_source_id);
  const from = src && src.derived_from_source_id
    ? (card.sources || []).find((x) => x.id === src.derived_from_source_id)
    : null;
  return el('div', { class: 'small' },
    el('div', {}, 'Відповідь: ' + q.answer),
    src ? el('div', { class: 'chips' },
      el('span', { class: 'chip' }, src.content_type_label || 'Уточнення'),
      from ? el('span', { class: 'chip' }, 'з ' + (from.ref || from.title)) : null,
      src.edited_by ? el('span', { class: 'chip' }, 'редакція: ' + src.edited_by) : null,
      el('span', { class: 'chip' }, ORIGIN_LABEL[src.origin] || src.origin)) : null,
    from && src.derived_quote
      ? el('div', {}, 'Фрагмент джерела: «' + src.derived_quote + '» ',
          el('button', { class: 'link', onclick: () => showSource(from.id, src.derived_quote) }, 'показати в джерелі'))
      : null,
    src && src.content_type === 'analyst_confirmed' && src.derived_quote
      ? el('div', {}, 'Підстава висновку: ' + src.derived_quote) : null,
    q.closed_by_source_id ? el('button', { class: 'link', onclick: () => showSource(q.closed_by_source_id) }, 'джерело відповіді') : null);
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

/**
 * Відкріплення питання від вилученого кроку: показуємо саме питання, стару прив'язку й наслідки (їх рахує
 * програма, не браузер), пояснення обов'язкове. Нічого не закривається й не змінює критичності (D82).
 */
function unlinkDialog(card, q, stale) {
  const pv = stale.preview || { lines: [], question: q, link: stale };
  const note = el('input', { type: 'text', placeholder: 'Чому ця прив’язка неактуальна (обов’язково)' });
  const btn = el('button', { class: 'primary', onclick: async () => {
    if (note.value.trim().length < 5) { toast('Поясніть, чому прив’язку знято (обов’язково).'); return; }
    dlg.close();
    const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/unlink`, {
      base_version_id: card.head.id, question_id: q.id, step_id: stale.step_id, condition: stale.condition, note: note.value,
    }), 'Прив’язку знято; створено нову версію');
    if (r) await refresh();
  } }, 'Відкріпити');
  openDialog(el('h2', {}, 'Відкріпити питання ' + q.id + ' від вилученого кроку ' + stale.step_id),
    el('p', {}, el('span', { class: 'chip' }, q.id + ' · ' + (q.critical ? 'КРИТИЧНЕ' : 'некритичне') + ' · відкрите'), ' ', q.text),
    el('p', { class: 'small' }, 'Стара прив’язка: крок ' + stale.step_id + (stale.condition ? ' («' + stale.condition + '»)' : ' (без умови)') + ' — ' + stale.kind_label + '.'),
    el('div', { class: 'small', 'data-block': 'preview' }, el('strong', {}, 'Що зміниться: '), el('ul', {}, pv.lines.map((l) => el('li', {}, l)))),
    el('p', { class: 'hint' }, 'Питання НЕ закривається й критичність не змінюється. Дія доступна лише для кроку, якого в описі немає: невизначений чи непідтверджений перехід чинного кроку так приховати не можна.'),
    note, el('div', { class: 'actions' }, btn, el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

function critDialog(card, q) {
  const note = el('input', { type: 'text', placeholder: 'Чому це питання не критичне (обов’язково)' });
  openDialog(el('h2', {}, 'Змінити критичність ' + q.id), el('p', { class: 'hint' }, 'Це пояснення не замінює встановлення факту; воно зберігається у версії.'), note,
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: async () => { dlg.close(); const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/criticality`, { base_version_id: card.head.id, question_id: q.id, critical: false, note: note.value }), 'Критичність змінено (нова версія)'); if (r) await refresh(); } }, 'Зберегти'), el('button', { onclick: () => dlg.close() }, 'Скасувати')));
}

async function showSource(sourceId, quote, answerQid) {
  const r = await act(() => api('GET', `/api/cases/${state.card.case.id}/sources/${sourceId}`));
  if (!r) return;
  const text = r.source.content; const idx = quote ? text.indexOf(quote) : -1;
  const box = el('div', { class: 'src-text' });
  if (idx >= 0) { const m = el('mark', {}, quote); box.append(text.slice(0, idx), m, text.slice(idx + quote.length)); setTimeout(() => m.scrollIntoView({ block: 'center' }), 50); }
  else box.textContent = text;
  openDialog(el('h2', {}, r.source.title), quote && idx < 0 ? el('p', { style: 'color:var(--danger)' }, '⚠ Фрагмент у джерелі не знайдено.') : null, box,
    el('div', { class: 'actions' },
      answerQid ? el('button', { class: 'primary', onclick: () => { dlg.close(); answerFromEvidence(answerQid, sourceId, quote); } }, 'Відповісти цим доказом') : null,
      el('button', { onclick: () => dlg.close() }, 'Закрити')));
}

// ───────────── запуск ─────────────
async function refresh() { stopDiagram(); await route(); }

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

VIEWS.diagram = (card) => {
  const out0 = [];
  const d = state.diagram && state.diagram.caseId === card.case.id ? state.diagram : null;
  if (!d) { void loadDiagram(); return el('p', { class: 'muted' }, 'Завантаження стану схеми…'); }
  const review = d.review || {};
  if (state.diagramPoll) {
    const secs = Math.round((Date.now() - (state.diagramSince || Date.now())) / 1000);
    out0.push(el('div', { class: state.diagramLost ? 'warnbox' : 'note info', 'data-block': 'auto-refresh' },
      state.diagramLost
        ? `Стан не надходить ${secs} с: зв’язок перервано. Операція могла тривати далі на сервері — читання стану її не перезапускає. Спроби тривають.`
        : `Перевірка виконується ${secs} с. Стан оновлюється сам; модель повторно не викликається.`));
  }
  const art = d.art || {};
  // Доступність саме агента 2: смислову перевірку виконує він, а не агент 1 (різні клієнти).
  const ai = (card.ai && card.ai.review) || { available: false, reason: 'Стан смислової перевірки невідомий.' };
  const out = [...out0];

  // 1) Зауваження агента й стан смислової перевірки
  out.push(el('h3', { class: 'group-h' }, 'Смислова перевірка опису'));
  if (review.load_error) {
    out.push(el('div', { class: 'warnbox' },
      el('strong', {}, 'Стан перевірки не вдалося завантажити. '),
      'Це збій зв’язку з сервером, а не результат перевірки: нічого не змінилось і нічого не оплачено. ',
      el('span', { class: 'small muted' }, review.load_error),
      el('div', {}, el('button', { onclick: loadDiagram }, 'Спробувати ще раз'))));
  } else {
    out.push(el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Стан'),
      el('div', { class: 'v' }, REVIEW_STATE_LABEL[review.state] || review.state,
        review.created_at ? el('span', { class: 'small muted' }, ' · ' + review.created_at) : null)));
    if (review.state === 'none' || review.state === 'stale' || review.state === 'failed' || review.state === 'untrusted') {
      if ((review.reasons || []).length) out.push(el('div', { class: 'warnbox' }, review.reasons.join(' ')));
      if (review.state === 'failed') out.push(reviewFailureBox(review));
      else if (review.error) out.push(el('div', { class: 'warnbox' }, String(review.error)));
      out.push(technicalLimitsBox(review.technical_limits, card));
      out.push(el('p', { class: 'small' }, ai.available
        ? 'Наступна дія: запустити смислову перевірку опису моделлю. Схему вона не будує — лише шукає неоднозначності.'
        : 'Наступна дія недоступна: смислову перевірку виконує модель, а вона не підключена. Демо-відповіді для цієї перевірки не вигадуються.'));
      out.push(el('button', { class: 'primary', disabled: !ai.available, onclick: async () => {
        const r = await act(() => api('POST', `/api/cases/${card.case.id}/bpmn/review`, {}), 'Перевірку запущено');
        if (r) { await loadDiagram(); setTimeout(loadDiagram, 1500); }
      } }, 'Запустити смислову перевірку'));
      if (!ai.available && ai.reason) out.push(el('p', { class: 'small muted' }, ai.reason));
    }
    if (review.state === 'running') out.push(el('div', {}, el('p', { class: 'small' }, 'Перевірка виконується. Опис і погодження не змінюються.'),
      el('button', { onclick: loadDiagram }, 'Оновити стан')));
    if (review.state === 'unsupported') {
      out.push(el('div', { class: 'warnbox' },
        el('strong', {}, 'Потрібна нотація, якої інструмент не будує. '),
        'Схему не створюємо й не спрощуємо; погодження опису лишається чинним.',
        el('ul', { class: 'small' }, (review.requirements || []).map((r) => el('li', {}, `${r.label} (крок ${r.step_id}): ${r.detail}`)))));
    }
    const views = review.findings_view || [];
    const blocking = views.filter((v) => v.blocking);
    const infos = views.filter((v) => !v.blocking);
    if (blocking.length) {
      out.push(el('h4', {}, `Зауваження, що блокують побудову (${blocking.length})`));
      out.push(...blocking.map((v) => findingBox(card, review.review_id, v, review.state === 'awaiting_analyst')));
    }
    if (infos.length) {
      out.push(el('details', {}, el('summary', {}, `Зауваження без блокування (${infos.length})`),
        ...infos.map((v) => findingBox(card, review.review_id, v, false))));
    }
    if (review.state === 'clear' && !blocking.length) out.push(el('p', { class: 'small' }, 'Зауважень, що блокують побудову, немає.'));
    if ((review.warnings || []).length) {
      out.push(el('details', {}, el('summary', { class: 'small' }, `Попередження перевірки цитат і відповіді (${review.warnings.length})`),
        el('ul', { class: 'small' }, review.warnings.map((w) => el('li', {}, w)))));
    }
    if ((review.invalid_resolutions || []).length) {
      // Технічна помилка, а не зауваження агента й не рішення людини: окремий блок.
      out.push(el('div', { class: 'warnbox' },
        el('strong', {}, `Записам рішень не довіряємо (${review.invalid_resolutions.length}). `),
        'Блокування вони не знімають. Такі записи не створюються застосунком — вони з’являються лише при прямому втручанні в базу.',
        el('ul', { class: 'small' }, review.invalid_resolutions.map((x) => el('li', {}, `${x.decided_at}: ${x.reasons.join(' ')}`)))));
    }
    if ((review.earlier_resolutions || []).length) {
      out.push(el('details', {}, el('summary', { class: 'small' }, `Ваші рішення з попередніх перевірок — лише контекст (${review.earlier_resolutions.length})`),
        el('ul', { class: 'small' }, review.earlier_resolutions.map((r) => el('li', {}, `${r.decided_at}: відхилено — ${r.explanation}`)))));
    }
  }

  // 2) Побудова схеми
  out.push(el('h3', { class: 'group-h' }, 'Побудова схеми'));
  if (art.load_error) out.push(el('div', { class: 'warnbox' },
    el('strong', {}, 'Стан схеми не вдалося завантажити. '),
    'Це збій зв’язку з сервером, а не результат побудови. ',
    el('span', { class: 'small muted' }, art.load_error),
    el('div', {}, el('button', { onclick: loadDiagram }, 'Спробувати ще раз'))));
  else {
    if (art.can_build) {
      out.push(el('p', { class: 'small' }, 'Усі перевірки пройдено. Побудова не звертається до моделі: схема створюється зі змісту погодженої версії.'));
      out.push(el('button', { class: 'primary', onclick: async (ev) => {
        ev.target.disabled = true;
        const r = await act(() => api('POST', `/api/cases/${card.case.id}/bpmn/build`, {}), 'Схему побудовано');
        ev.target.disabled = false;
        if (r) await loadDiagram();
      } }, 'Побудувати схему'));
    } else if (art.build_block) {
      out.push(el('div', { class: 'warnbox' }, el('strong', {}, 'Побудова зараз недоступна. '), art.build_block.message,
        (art.build_block.reasons || []).length ? el('ul', { class: 'small' }, art.build_block.reasons.map((x) => el('li', {}, x))) : null));
    }
    if (art.artifact) out.push(artifactBlock(card, art.artifact, false));
    else out.push(el('p', { class: 'muted' }, 'Схему для цього кейсу ще не будували.'));
    const hist = (art.history || []).filter((h) => !art.artifact || h.id !== art.artifact.id);
    if (hist.length) {
      out.push(el('h3', { class: 'group-h' }, `Історія схем (${hist.length})`));
      out.push(el('p', { class: 'small muted' }, 'Попередні побудови лишаються видимими. Як чинний результат вони не видаються.'));
      out.push(...hist.map((h) => el('details', {}, el('summary', {}, `${h.created_at} · ${ARTIFACT_STATUS_LABEL[h.status] || h.status} · ${h.label || 'чинна'}`), artifactBlock(card, h, true))));
    }
  }
  return el('div', {}, ...out);
};
