'use strict';
// Простий інтерфейс без фреймворків. Уся логіка дозволів — на сервері; тут лише показ і введення.
// Дані завжди вставляються через textContent (без innerHTML), щоб текст джерел не міг виконатися як код.

const app = document.getElementById('app');
const state = { config: null, tab: 'steps', card: null };

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
    el('div', { class: 'card' }, el('h2', {}, 'Новий кейс'), title,
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => act(async () => {
          const r = await api('POST', '/api/cases', { title: title.value }); location.hash = '#/case/' + r.case.id; }) }, 'Створити кейс'),
        el('button', { onclick: () => act(async () => { const r = await api('POST', '/api/demo/seed'); location.hash = '#/case/' + r.case_id; }) },
          'Завантажити демо-кейс (синтетичний)'))));
}

// ───────────── картка кейсу ─────────────
async function renderCase(id) {
  const card = await api('GET', '/api/cases/' + id);
  state.card = card;
  const { head, next_action: na } = card;
  const crit = card.blockers.filter((b) => b.severity === 'critical');
  const warns = card.blockers.filter((b) => b.severity === 'warning');
  const content = head.content;

  // 1) Шапка
  const header = el('div', { class: 'card' },
    el('a', { href: '#/', class: 'small' }, '← усі кейси'),
    el('h1', {}, card.case.title),
    el('div', { class: 'chips' },
      el('span', { class: 'chip state' }, 'Статус: ' + card.case.state_label),
      el('span', { class: 'chip' }, 'Версія ' + head.number + ' · ' + CREATED_BY[head.created_by]),
      head.accepted ? el('span', { class: 'chip ok' }, 'Прийнято аналітиком (це ще не погодження)') : el('span', { class: 'chip' }, 'Не прийнято аналітиком'),
      card.approval ? el('span', { class: 'chip ok' }, 'Погоджено: версія ' + (card.versions.find((v) => v.id === card.approval.version_id)?.number ?? '?') + ', ' + fmt(card.approval.created_at)) : null,
      el('span', { class: 'chip demo' }, 'ДЕМО — не AI'),
      head.integrity_ok ? null : el('span', { class: 'chip', style: 'color:var(--danger)' }, '⚠ Цілісність версії порушена')));

  // 2) Суть
  const summary = el('div', { class: 'card' }, el('h2', {}, 'Суть'),
    el('p', {}, content.summary || 'Суть процесу ще не сформульовано.'));

  // 3) Головні зміни
  const top = card.changes.slice(0, 5), rest = card.changes.slice(5);
  const changes = el('div', { class: 'card' }, el('h2', {}, 'Головні зміни відносно попередньої версії'),
    top.length ? el('ul', {}, top.map((c) => el('li', {}, c))) : el('p', { class: 'muted' }, 'Змін немає.'),
    rest.length ? el('details', {}, el('summary', {}, `Усі зміни (ще ${rest.length})`), el('ul', {}, rest.map((c) => el('li', {}, c)))) : null);

  // 4) Блокери — критичні завжди на екрані
  const blockers = el('div', { class: 'card blockers' + (crit.length ? '' : ' none') },
    el('h2', {}, crit.length ? `Блокери погодження: ${crit.length}` : 'Критичних блокерів немає'),
    crit.map((b) => el('div', { class: 'blocker' },
      b.code === 'CRITICAL_QUESTION' ? el('strong', {}, 'Критичне питання ') : null, b.message,
      b.code === 'CRITICAL_QUESTION' ? el('button', { class: 'link', onclick: () => { state.tab = 'questions'; renderTabs(); document.getElementById('tabs').scrollIntoView(); } }, 'Відповісти') : null)),
    warns.length ? el('div', { class: 'warnbox' }, `Попереджень: ${warns.length} (не блокують): `,
      warns.slice(0, 3).map((w) => w.message).join(' · '), warns.length > 3 ? ' …' : '') : null);

  // 5) Наступна дія
  const next = el('div', { class: 'card' }, el('h2', {}, 'Рекомендований наступний крок'),
    el('p', {}, na.hint),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', disabled: !na.enabled, onclick: () => nextAction(card) }, na.label),
      ['pending_approval', 'approved'].includes(card.case.state) ? el('button', { onclick: () => returnDialog(card) }, 'Повернути на доопрацювання') : null,
      el('button', { disabled: true, title: 'З’явиться у зрізі 2 і потребуватиме ключа моделі. У деморежимі AI-аналіз не імітується.' }, 'Оновити аналіз (AI) — недоступно'),
    ),
    !na.enabled && na.disabledReason ? el('p', { class: 'small', style: 'color:var(--danger)' }, 'Недоступно: ' + na.disabledReason) : null);

  app.replaceChildren(header, summary, changes, blockers, next, el('div', { class: 'card', id: 'details' }, el('div', { id: 'tabs' }), el('div', { id: 'panel' })));
  renderTabs();
}

async function nextAction(card) {
  const k = card.next_action.key;
  if (k === 'resolve_blockers') {
    state.tab = card.critical_open_questions.length ? 'questions' : (card.blockers.some((b) => b.code.includes('SOURCE')) ? 'sources' : 'edit');
    renderTabs(); document.getElementById('tabs').scrollIntoView();
  } else if (k === 'accept') { await act(() => api('POST', `/api/cases/${card.case.id}/accept-draft`, { version_id: card.head.id }), 'Робочу версію прийнято'); await refresh(); }
  else if (k === 'submit') { await act(() => api('POST', `/api/cases/${card.case.id}/submit`, {}), 'Передано на погодження'); await refresh(); }
  else if (k === 'approve') approveDialog(card);
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
  openDialog(el('h2', {}, 'Погодження AS-IS: версія ' + card.head.number),
    el('p', {}, 'Це рішення людини. Агент не може його прийняти. Позначте кожен пункт:'),
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
  ['steps', 'Кроки AS-IS'], ['context', 'Контекст і межі'], ['claims', 'Твердження й докази'], ['problems', 'Проблеми й вплив'], ['hypotheses', 'Гіпотези'],
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

function kv(label, value) { return el('tr', {}, el('th', {}, label), el('td', {}, value || el('span', { class: 'muted' }, 'не заповнено'))); }

const PANELS = {
  context: (card) => {
    const c = card.head.content;
    return el('div', {}, el('h3', {}, 'Бізнес-контекст'), el('p', {}, c.business_context || 'не заповнено'),
      el('h3', {}, 'Межі процесу'), el('table', {}, kv('Тригер', c.boundaries.trigger), kv('Вхід', c.boundaries.input), kv('Фактичне завершення', c.boundaries.completion), kv('Результат', c.boundaries.result)),
      el('h3', {}, 'Ролі'), c.roles.length ? el('ul', {}, c.roles.map((r) => el('li', {}, r))) : el('p', { class: 'muted' }, 'Ролей ще не вказано.'));
  },
  steps: (card) => {
    const steps = card.head.content.steps;
    if (!steps.length) return el('p', { class: 'muted' }, 'Кроків ще немає. Додайте їх на вкладці «Редагувати».');
    return el('table', {}, el('thead', {}, el('tr', {}, ['ID', 'Роль', 'Дія', 'Результат', 'Далі'].map((h) => el('th', {}, h)))),
      el('tbody', {}, steps.map((s) => el('tr', {}, el('td', {}, s.id), el('td', {}, s.role), el('td', {}, s.action), el('td', {}, s.result),
        el('td', {}, s.next.map((n) => el('div', {}, '→ ' + n.to + (n.condition ? ' (' + n.condition + ')' : ''))))))));
  },
  claims: (card) => {
    const c = card.head.content;
    return el('div', {},
      el('p', { class: 'hint' }, 'Програма перевіряє лише те, що цитата є в тексті джерела. Це не доводить, що вона підтверджує висновок.'),
      card.claims.length ? card.claims.map((cl) => el('div', { class: 'claim ' + cl.type },
        el('div', {}, el('span', { class: 'chip' }, cl.type_label), ' ', cl.text),
        el('div', { class: 'small muted' }, cl.scope),
        cl.source_id ? el('div', { class: 'small' }, 'Джерело: ' + (cl.source_title || cl.source_id) + ' · ',
          cl.quote_check === 'quote_found' ? 'фрагмент знайдено · ' : cl.quote_check === 'quote_not_found' ? '⚠ фрагмент НЕ знайдено · ' : '',
          el('button', { class: 'link', onclick: () => showSource(cl.source_id, cl.quote) }, 'Показати фрагмент у джерелі')) : null))
        : el('p', { class: 'muted' }, 'Тверджень ще немає.'),
      c.conflicts.length ? el('div', {}, el('h3', {}, 'Конфлікти: правки аналітикині та агента'),
        c.conflicts.map((x) => el('div', { class: 'warnbox' }, el('strong', {}, x.key), ': ', x.note, el('div', {}, 'Збережено: ' + x.kept), el('div', {}, 'Запропоновано агентом: ' + x.proposed)))) : null);
  },
  problems: (card) => {
    const p = card.head.content.problems;
    if (!p.length) return el('p', { class: 'muted' }, 'Проблем ще не описано.');
    return el('table', {}, el('thead', {}, el('tr', {}, ['ID', 'Симптом', 'Можлива причина', 'Вплив'].map((h) => el('th', {}, h)))),
      el('tbody', {}, p.map((x) => el('tr', {}, el('td', {}, x.id), el('td', {}, x.symptom), el('td', {}, x.cause || '—'), el('td', {}, x.impact + (x.impact_is_estimate ? ' (оцінка)' : ''))))));
  },
  hypotheses: (card) => {
    const h = card.head.content.hypotheses;
    if (!h.length) return el('p', { class: 'muted' }, 'Гіпотез ще немає.');
    return el('div', {}, h.map((x) => el('div', { class: 'claim' }, el('div', {}, el('span', { class: 'chip' }, 'Гіпотеза ' + x.id + ' · ' + ({ open: 'відкрита', supported: 'підтримана', refuted: 'спростована', confirmed: 'підтверджена' })[x.status]), ' ', x.text),
      el('div', { class: 'small muted' }, 'Автор: ' + (x.author === 'analyst' ? 'аналітикиня' : 'агент') + '. Перевірка: ' + (x.check_method || 'не визначено')))));
  },
  questions: (card) => {
    const qs = card.head.content.questions;
    const add = el('form', { onsubmit: async (e) => {
      e.preventDefault(); const f = e.target;
      const ok = await act(() => api('POST', `/api/cases/${card.case.id}/questions`, { base_version_id: card.head.id, text: f.text.value, impact: f.impact.value, critical: f.critical.checked }), 'Питання додано (нова версія)');
      if (ok) await refresh();
    } }, el('h3', {}, 'Поставити питання (вручну)'),
      el('p', { class: 'hint' }, 'У деморежимі питання задає людина або сценарій демо. AI не імітується.'),
      el('label', {}, 'Питання'), el('input', { type: 'text', name: 'text', required: true }),
      el('label', {}, 'Від чого залежить відповідь (вплив на опис)'), el('input', { type: 'text', name: 'impact' }),
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
      el('p', { class: 'hint' }, 'Для навчальних перевірок використовуйте лише синтетичні (вигадані) матеріали: під час справжнього AI-запуску (зріз 2) обрані дані передаватимуться провайдеру моделі. Нове джерело повертає кейс до дослідження.'),
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
        roles_text: f.roles.value, steps_text: f.steps.value, problems_text: f.problems.value } }), 'Збережено як нова версія');
      if (ok) await refresh();
    } },
      el('p', { class: 'hint' }, 'Збереження створює НОВУ версію; попередні не змінюються. Після змін кейс повертається до стану «Дослідження», а погодження втрачає чинність.'),
      el('label', {}, 'Суть'), el('textarea', { name: 'summary' }, e.summary),
      el('label', {}, 'Бізнес-контекст'), el('textarea', { name: 'business_context' }, e.business_context),
      ...[['trigger', 'Тригер'], ['input', 'Вхід'], ['completion', 'Фактичне завершення'], ['result', 'Результат']].flatMap(([k, l]) => [el('label', {}, l), el('input', { type: 'text', name: k, value: e.boundaries[k] })]),
      el('label', {}, 'Ролі (по одній у рядку)'), el('textarea', { name: 'roles' }, e.roles_text),
      el('label', {}, 'Кроки'), el('p', { class: 'hint' }, 'Формат рядка: ID | Роль | Дія | Результат | Наступні. Наступні: «S4 (погоджено); END (відхилено)». END — кінець процесу.'), el('textarea', { name: 'steps', style: 'min-height:170px' }, e.steps_text),
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
    el('h3', {}, 'Запуски'), card.runs.length ? el('ul', {}, card.runs.map((r) => el('li', {}, `${r.agent} · режим ${r.mode} · ${r.technical_state}${r.note ? ' · ' + r.note : ''}${r.error ? ' · помилка: ' + r.error : ''}`))) : el('p', { class: 'muted' }, 'Запусків ще не було.'),
    el('h3', {}, 'Журнал подій'), el('ul', { class: 'small' }, card.audit.slice(0, 15).map((a) => el('li', {}, `${fmt(a.at)} · ${a.actor} · ${a.action}`)))),
};

function questionView(card, q) {
  const open = q.status === 'open';
  const origin = q.origin === 'demo_script' ? ' · задано сценарієм демо (не виявлено AI)' : q.origin === 'agent' ? ' · запропоновано агентом' : ' · поставила аналітикиня';
  const ans = el('textarea', { placeholder: 'Текст уточнення (від кого, що саме). Буде збережено як окреме джерело.' });
  return el('div', { class: 'claim ' + (open && q.critical ? 'unknown' : '') },
    el('div', {}, el('span', { class: 'chip' }, q.id + ' · ' + (q.critical ? 'КРИТИЧНЕ' : 'некритичне') + ' · ' + (open ? 'відкрите' : 'закрите')), ' ', q.text),
    el('div', { class: 'small muted' }, 'Вплив: ' + (q.impact || '—') + (q.addressee ? ' · Кому: ' + q.addressee : '') + origin),
    q.criticality_note ? el('div', { class: 'small' }, 'Пояснення щодо критичності: ' + q.criticality_note) : null,
    open ? el('div', {}, ans, el('div', { class: 'actions' },
      el('button', { onclick: async () => { const r = await act(() => api('POST', `/api/cases/${card.case.id}/questions/answer`, { base_version_id: card.head.id, question_id: q.id, answer: ans.value }), 'Уточнення додано; створено нову версію'); if (r) await refresh(); } }, 'Закрити питання уточненням'),
      q.critical ? el('button', { onclick: () => critDialog(card, q) }, 'Зробити некритичним…') : null))
      : el('div', { class: 'small' }, 'Відповідь: ' + q.answer, ' · ', q.closed_by_source_id ? el('button', { class: 'link', onclick: () => showSource(q.closed_by_source_id) }, 'джерело відповіді') : ''));
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
    }
    const m = /^#\/case\/([\w-]+)$/.exec(location.hash);
    if (m) await renderCase(m[1]); else await renderList();
  } catch (e) {
    if (e.status === 401) showLogin(); else app.replaceChildren(el('div', { class: 'card' }, el('h1', {}, 'Помилка'), el('p', {}, explain(e))));
  }
}
window.addEventListener('hashchange', route);
route();
