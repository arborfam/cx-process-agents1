/* Прототип «AS-IS → BPMN». Повністю локальний: жодного fetch, жодного продуктового API,
   жодного звернення до моделі. Усі стани симульовані на синтетичних даних. */
(() => {
'use strict';
const { STAGES, STATE_LABEL, CASES } = window.PROTO;

/* ---------------- стан ---------------- */
const S = {
  caseId: 'cx', stage: 0, protoOpen: false,
  tab: 'overview', sub: 'context',
  panel: null, dialog: null, focus: null,
  newSources: [], batchOrigin: '', pendingBatch: [],
  pkgApplied: false, pkgAnswer: null,
  shortLabel: null,
  decisionAction: {}, reused: null,
  approved: false,
  run: { t: 0, lastSync: 0, stale: false, timer: null },
  view: { zoom: 1, x: 0, y: 0, sel: null, full: false, historical: false, fitted: false },
  texts: {},          // введений текст не губиться між перемальовуваннями
};

/* ---------------- утиліти ---------------- */
const h = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => [...root.querySelectorAll(sel)];
const plural = (n, a, b, c) => { const m = n % 100; if (m >= 11 && m <= 14) return c; const k = n % 10; return k === 1 ? a : (k >= 2 && k <= 4 ? b : c); };

function resolve() {
  const c = CASES[S.caseId];
  const out = JSON.parse(JSON.stringify(c.base));
  for (let i = 0; i <= S.stage; i++) {
    const p = c.stages[STAGES[i].key] || {};
    for (const k of Object.keys(p)) out[k] = JSON.parse(JSON.stringify(p[k]));
  }
  out.$case = c;
  // локальні дії користувача поверх сценарію
  if (S.pkgApplied && out.package) { out.packageApplied = out.package; out.package = null; }
  if (S.approved && out.approval) {
    out.version.approved = true;
    out.version.label = out.version.label.replace('готова до погодження', 'погоджено');
    out.version.approvedBy = 'Аналітикиня';
    out.version.approvedAt = 'щойно';
    out.state = 'approved';
    out.approvedNow = true;
    out.attention = (out.attention || []).filter(a => a.kind !== 'critical');
    out.next = {
      title: 'Перейти до побудови схеми',
      why: 'AS-IS погоджено. Побудова — окрема дія на вкладці «Схема»; перехід туди нічого не запускає.',
      label: 'Відкрити вкладку «Схема»', go: { tab: 'diagram' },
    };
  }
  if (S.reused) out.reusedNow = S.reused;
  if (S.shortLabel) out.shortLabelSet = S.shortLabel;
  return out;
}

const CLAIM_LABEL = {
  source_fact: 'З джерела', analyst_confirmed: 'Рішення аналітика',
  hypothesis: 'Гіпотеза', improvement_proposal: 'Пропозиція агента', unknown: 'Не з’ясовано',
};
const CLAIM_TONE = { source_fact: 'acc', analyst_confirmed: 'ok', hypothesis: 'warn', improvement_proposal: 'syn', unknown: 'err' };

const PROBLEM_KIND = {
  business_unknown: 'Бізнес-невідоме',
  source_conflict: 'Суперечність між джерелами',
  analyst_decision: 'Рішення, якого очікують від аналітика',
  agent_proposal: 'Припущення або пропозиція агента',
  model_error: 'Помилка відповіді моделі',
  tech_failure: 'Технічний збій',
  generator_limit: 'Підтверджене обмеження генератора',
};
const SEVERITY = {
  critical: ['err', 'Критична: блокує погодження й побудову'],
  'blocking-tech': ['warn', 'Блокує побудову, але не є бізнес-питанням'],
  info: ['', 'Не блокує'],
};
const ATT = {
  critical: ['err', 'Критичне бізнес-невідоме'],
  conflict: ['warn', 'Суперечність між джерелами'],
  decide:   ['warn', 'Рішення, якого очікують від вас'],
  question: ['', 'Відкрите питання'],
  proposal: ['', 'Припущення агента'],
  tech:     ['warn', 'Технічне обмеження'],
  run:      ['acc', 'Виконується'],
  paid:     ['warn', 'Платний запуск — окреме рішення'],
  reuse:    ['ok', 'Рішення чинне'],
  review:   ['warn', 'Рішення потребує перегляду'],
  void:     ['err', 'Рішення не застосовується'],
};
const DEC_STATE = {
  valid:   ['ok',   'Діє — пов’язаний зміст не змінився'],
  confirm: ['warn', 'Потрібне ваше підтвердження'],
  review:  ['warn', 'Потрібно переглянути — змінилися пов’язані елементи'],
  void:    ['err',  'Попереднє рішення не застосовується'],
};

/* ---------------- каркас ---------------- */
function render(keepScroll = true) {
  const y = window.scrollY;
  const d = resolve();
  // прибираємо попередні накладки, щоб не лишались мертві перекриття
  els('.panel-layer').forEach(x => x.remove());
  els('body > dialog').forEach(x => { try { x.close(); } catch (e) {} x.remove(); });
  el('#root').innerHTML = shell(d);
  wire(d);
  if (keepScroll) window.scrollTo(0, y);
  if (S.panel) openPanel(d);
  if (S.dialog) openDialog(d);
  if (S.focus) { const t = el('#' + S.focus); if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); } S.focus = null; }
}

function shell(d) {
  const c = d.$case;
  const counts = {
    asis: (d.questions || []).filter(q => q.status === 'open' && q.critical).length,
    q: (d.questions || []).filter(q => q.status === 'open').length,
  };
  return `
  <button id="pbtn" class="proto-toggle" aria-expanded="${S.protoOpen ? 'true' : 'false'}" title="Керування прототипом">Прототип</button>
  <div class="proto-panel" ${S.protoOpen ? '' : 'hidden'} role="dialog" aria-label="Керування прототипом">
    <div class="proto-head"><strong>Керування прототипом</strong><button id="pclose" class="btn btn-ghost btn-sm">Сховати</button></div>
    <p class="small muted">Не частина продукту. Тут вибирають демонстраційний процес і стан маршруту.</p>
    <label class="lbl" for="pcase">Процес</label>
    <select id="pcase">${Object.values(CASES).map(x => `<option value="${x.id}" ${x.id === S.caseId ? 'selected' : ''}>${h(x.short)}</option>`).join('')}</select>
    <label class="lbl" for="pstage">Стан маршруту</label>
    <select id="pstage">${STAGES.map((x, i) => `<option value="${i}" ${i === S.stage ? 'selected' : ''}>${h(x.label)}</option>`).join('')}</select>
    <div class="btnrow" style="margin-top:var(--s3)">
      <button id="pprev" class="btn btn-sm" ${S.stage === 0 ? 'disabled' : ''}>← Назад</button>
      <button id="pnext" class="btn btn-sm" ${S.stage === STAGES.length - 1 ? 'disabled' : ''}>Далі →</button>
    </div>
    <p class="small muted" style="margin-top:var(--s3)">${h(c.syntheticNote)}</p>
  </div>

  <header class="appbar"><div class="appbar-in">
    <h1>${h(c.title)}</h1>
    <div class="meta">
      <span class="tag strong ${d.version.approved ? 'ok' : 'acc'}">${h(STATE_LABEL[d.state] || d.state)}</span>
      <span class="tag">${h(d.version.label)}</span>
      <span class="tag syn">Синтетичний приклад</span>
      ${d.version.approved ? `<span class="tag ok">Погоджено ${h(d.version.approvedAt || '')}</span>` : ''}
    </div>
    <nav class="tabs" role="tablist">
      ${tab('overview', 'Огляд')}
      ${tab('asis', 'AS-IS', counts.asis ? `<span class="count">${counts.asis}</span>` : (counts.q ? `<span class="count q">${counts.q}</span>` : ''))}
      ${tab('sources', 'Джерела', (d.sources || []).length ? `<span class="count plain">${d.sources.length}</span>` : '')}
      ${tab('diagram', 'Схема')}
      ${tab('history', 'Історія')}
    </nav>
  </div></header>

  <main id="main">${
    S.tab === 'overview' ? viewOverview(d) :
    S.tab === 'asis'     ? viewAsIs(d) :
    S.tab === 'sources'  ? viewSources(d) :
    S.tab === 'diagram'  ? viewDiagram(d) : viewHistory(d)
  }</main>`;
}
const tab = (id, label, extra = '') =>
  `<button role="tab" data-tab="${id}" aria-selected="${S.tab === id}">${h(label)}${extra}</button>`;

/* ---------------- Огляд ---------------- */
// Одна картка «Наступна дія» для всіх вкладок: позначка витрат не має зникати залежно від місця.
function nextCard(d, opts) {
  const dup = opts && opts.secondary;   // дія вже стоїть у картці змісту — не дублюємо її синьою
  return `<section class="card card-tight next">
    <h2>Наступна дія</h2>
    <p class="why">${h(d.next.why)}</p>
    ${d.next.blockedBy ? `<div class="blocked">${h(d.next.blockedBy)}</div>` : ''}
    <button class="btn ${dup ? '' : 'btn-primary'}" data-go='${h(JSON.stringify(d.next.go))}'>${h(d.next.label)}</button>
    ${d.next.paid ? `<div class="paid">Платний етап: звернення до моделі</div>` : ''}
    ${d.next.free ? `<div class="free">Безкоштовно: побудова зі збереженої таблиці, модель не викликається</div>` : ''}
    ${d.next.freeNote ? `<div class="free">${h(d.next.freeNote)}</div>` : ''}
  </section>`;
}

// Критичне бізнес-невідоме має бути видно до будь-якого прокручування, зокрема на вузькому екрані.
function critLine(d) {
  const crit = (d.questions || []).filter(q => q.status === 'open' && q.critical);
  if (!crit.length) return '';
  const q = crit[0];
  const go = { tab: 'asis', sub: 'questions', focus: q.id };
  // якщо головна дія вже веде сюди, другої кнопки не додаємо
  const dup = JSON.stringify(d.next.go) === JSON.stringify(go);
  return `<div class="note err critline">
    <strong>${crit.length === 1 ? 'Критичне питання блокує погодження й побудову' : `${crit.length} критичні питання блокують погодження й побудову`}:</strong>
    ${h(q.id)} — ${h(trunc(q.text, 110))}
    ${dup ? '' : `<button class="btn btn-ghost btn-sm" data-go='${h(JSON.stringify(go))}'>Перейти до питання</button>`}
  </div>`;
}

function viewOverview(d) {
  const ctx = d.context;
  const ns = '<span class="unknown">Ще не з’ясовано</span>';
  // один маршрут до одного рішення: не повторюємо те, куди вже ведуть критичний рядок і головна дія
  const hasCrit = (d.questions || []).some(q => q.status === 'open' && q.critical);
  const nextGo = JSON.stringify(d.next.go);
  const att = (d.attention || []).filter(a =>
    !(hasCrit && a.kind === 'critical') && JSON.stringify(a.go) !== nextGo);
  return `<div class="page">${critLine(d)}<div class="cols">
    <div class="stack">
      <section class="card lead" id="ctx">
        <h2>Коротко</h2>
        <dl class="kv">
          <dt>Навіщо існує процес</dt><dd>${ctx.processGoal ? h(ctx.processGoal) : ns}</dd>
          <dt>Від</dt><dd>${ctx.start ? h(trunc(ctx.start, 110)) : ns}</dd>
          <dt>До</dt><dd>${ctx.end ? h(ctx.end) : ns}</dd>
        </dl>
        <div class="btnrow" style="margin-top:var(--s4)">
          <button class="btn btn-ghost btn-sm" data-go='{"tab":"asis","sub":"context"}'>Межі, ролі й мета дослідження →</button>
        </div>
      </section>

      ${d.run ? runCard(d) : ''}
      ${d.failure ? failureCard(d) : ''}
      ${d.changes ? changesCard(d) : ''}
      ${d.packageApplied ? `<section class="card"><h2>Пакет змін застосовано</h2>
        <p class="small muted">${h(d.packageApplied.title)} · застосовано одним рішенням, часткових змін немає.</p>
        ${S.pkgAnswer ? `<div class="note info"><strong>Ваша відповідь на ${h(d.packageApplied.answerNeeded.q)}:</strong> ${h(S.pkgAnswer)}</div>` : ''}</section>` : ''}
    </div>

    <aside class="rail">
      ${nextCard(d, { secondary: !!d.failure })}

      <section class="card card-tight">
        <h2>Потребує уваги</h2>
        ${att.length ? `<div class="att">${att.map(a => {
          const [tone, label] = ATT[a.kind] || ['', a.kind];
          return `<div class="att-item">
            <div><span class="tag ${tone}">${h(label)}</span></div>
            <div class="t"><span class="n">${a.n}</span> · ${h(a.title)}</div>
            <div><button class="btn btn-ghost btn-sm" data-go='${h(JSON.stringify(a.go))}'>Перейти →</button></div>
          </div>`;
        }).join('')}</div>` : `<p class="small muted">Нічого іншого не потребує уваги.</p>`}
      </section>
    </aside>
  </div></div>`;
}

function longText(t, key) {
  if (t.length <= 160) return h(t);
  const open = S.texts['open_' + key];
  return `${h(open ? t : t.slice(0, 150) + '…')}
    <button class="btn btn-ghost btn-sm" data-toggle="open_${key}">${open ? 'Згорнути' : 'Показати повністю (' + t.length + ' симв.)'}</button>`;
}

function changesCard(d) {
  const ch = d.changes, n = (ch.added || []).length + (ch.changed || []).length + (ch.conflict || []).length + (ch.decide || []).length + (ch.removed || []).length;
  return `<section class="card" id="changes">
    <h2>Головні зміни після останнього оновлення</h2>
    <p class="small muted">${n} ${plural(n, 'зміна', 'зміни', 'змін')}. Редакційні правки окремого підтвердження не потребують.</p>
    ${block('Додано', ch.added, x => `<strong>${h(x.t)}</strong> — ${h(x.d)}${x.src ? ` <span class="tag">${h(x.src)}</span>` : ''}`)}
    ${block('Вилучено', ch.removed, x => `<strong>${h(x.t)}</strong> — ${h(x.d)}`)}
    ${block('Змінено', ch.changed, x => `<strong>${h(x.t)}</strong>
      <div class="ba"><div class="was"><span class="cap">Було</span>${h(x.was)}</div><div class="now"><span class="cap">Стало</span>${h(x.now)}</div></div>
      ${x.src ? `<div class="small muted" style="margin-top:var(--s2)">Джерело: ${h(x.src)}</div>` : ''}
      ${x.effect ? `<div class="small" style="margin-top:var(--s1)"><strong>Наслідок для процесу:</strong> ${h(x.effect)}</div>` : ''}`)}
    ${block('Суперечить попередньому', ch.conflict, x => `<strong>${h(x.t)}</strong>
      <div class="ba"><div class="was"><span class="cap">Джерело A</span>${h(x.a)}</div><div class="was"><span class="cap">Джерело B</span>${h(x.b)}</div></div>
      <div class="small" style="margin-top:var(--s2)">${h(x.note)}</div>`)}
    ${block('Потребує рішення', ch.decide, x => `<strong>${h(x.t)}</strong> — ${h(x.d)}`)}
  </section>`;
}
function block(title, arr, fn) {
  if (!arr || !arr.length) return '';
  return `<div class="sect"><h3>${h(title)} · ${arr.length}</h3><div class="rows">${arr.map(x => `<div class="row">${fn(x)}</div>`).join('')}</div></div>`;
}

/* ---------------- Запуск / помилка ---------------- */
function runCard(d) {
  const r = d.run, t = S.run.t, since = S.run.t - S.run.lastSync;
  const mm = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  const idx = r.stages.indexOf(r.stage.replace(/^Етап \d+ з \d+ — /, '')) ;
  return `<section class="card" id="run">
    <h2>Побудова схеми триває</h2>
    <div class="runbar">
      <div class="line"><span class="pulse"></span><b>${h(r.stage)}</b></div>
      <div class="line"><span class="muted">Час від початку:</span> <b>${mm(t)}</b>
        <span class="muted">Останній отриманий стан:</span> <b>${since < 5 ? 'щойно' : mm(since) + ' тому'}</b></div>
      ${S.run.stale ? `<div class="note warn"><strong>Оновлення стану не надходять ${mm(since)}.</strong>
        Операція могла тривати далі на сервері. Повторно запускати нічого не потрібно.
        <div class="btnrow" style="margin-top:var(--s3)"><button class="btn btn-sm" data-act="resync">Оновити стан вручну</button></div></div>`
      : `<div class="note info">Стан оновлюється автоматично. ${h(r.note)}</div>`}
      <ol class="small muted" style="margin:0;padding-left:20px">
        ${r.stages.map((s, i) => `<li ${i === idx ? 'style="color:var(--ink);font-weight:600"' : ''}>${h(s)}${i < idx ? ' — виконано' : ''}</li>`).join('')}
      </ol>
      <div class="paid">Платний етап уже розпочато: звернення до моделі (${h(r.model)}, інструкція ${h(r.instruction)})</div>
      <details class="diag"><summary>Технічна діагностика</summary><div class="in"><pre>run_id: ${h(r.id)}
instruction: ${h(r.instruction)}
version: ${h(d.version.hash)}
state: running</pre></div></details>
    </div>
  </section>`;
}

function failureCard(d) {
  const f = d.failure;
  return `<section class="card" id="fail">
    <h2>${h(f.title)}</h2>
    <div class="note err" style="margin-bottom:var(--s4)">${h(f.human)}</div>
    <div class="sect">
      <h3>Що збережено</h3>
      <ul class="prose">${f.saved.map(x => `<li>${h(x)}</li>`).join('')}</ul>
    </div>
    <div class="sect">
      <h3>Що не прийнято</h3>
      <ul class="prose">${f.notAccepted.map(x => `<li>${h(x)}</li>`).join('')}</ul>
    </div>
    <div class="sect">
      <h3>Витрати</h3><p class="prose">${h(f.cost)}</p>
    </div>
    <div class="sect">
      <h3>Наступна безпечна дія</h3>
      <p class="prose">${h(f.safeNext)}</p>
      <div class="btnrow">
        ${f.retryFree
          ? `<button class="btn btn-primary" data-act="rebuild">Побудувати зі збереженої таблиці</button><span class="free">${h(f.retryFreeWhy)}</span>`
          : `<button class="btn btn-primary" data-act="report">Зберегти діагностичний звіт</button>
             <button class="btn" data-act="retry-paid">Спробувати ще раз (платно)</button>`}
      </div>
      ${!f.retryFree ? `<p class="small muted" style="margin-top:var(--s3)">Безкоштовний повтор недоступний: придатної збереженої таблиці немає, тож повтор означає новий платний виклик. PowerShell, журнали чи ручні виправлення від вас не потрібні.</p>` : ''}
    </div>
    ${f.violations.length ? `<div class="sect"><h3>Що саме не пройшло перевірку</h3>
      <ul class="small muted">${f.violations.map(v => `<li class="mono">${h(v)}</li>`).join('')}</ul></div>` : ''}
    <div class="sect">
      <details class="diag"><summary>Журнал спроб і діагностика</summary><div class="in">
        <ol class="small">${f.attempts.map(a => `<li>Спроба ${a.n}: ${h(a.kind)} — <span class="mono">${h(a.msg)}</span></li>`).join('')}</ol>
        <pre>${h(f.report)}</pre>
      </div></details>
    </div>
  </section>`;
}

/* ---------------- AS-IS ---------------- */
const SUBS = [['context', 'Бізнес-контекст і межі'], ['steps', 'Кроки'], ['claims', 'Твердження й докази'], ['questions', 'Питання'], ['problems', 'Проблеми й гіпотези']];

function viewAsIs(d) {
  const open = (d.questions || []).filter(q => q.status === 'open');
  const crit = open.filter(q => q.critical).length;
  return `<div class="page">${S.sub === 'questions' ? '' : critLine(d)}
    <nav class="subtabs" role="tablist">${SUBS.map(([id, t]) => {
      let n = '';
      if (id === 'questions' && open.length) n = ` · ${open.length}`;
      if (id === 'problems' && (d.problems || []).length) n = ` · ${d.problems.length}`;
      return `<button role="tab" data-sub="${id}" aria-selected="${S.sub === id}">${h(t)}${n}</button>`;
    }).join('')}</nav>
    ${crit ? `<div class="note err" style="margin-bottom:var(--s5)"><strong>${crit} критичне ${plural(crit, 'питання', 'питання', 'питань')}.</strong> Доки воно відкрите, версію не можна погодити й схему не можна побудувати.</div>` : ''}
    ${S.sub === 'context' ? asisContext(d) : S.sub === 'steps' ? asisSteps(d) : S.sub === 'claims' ? asisClaims(d) : S.sub === 'questions' ? asisQuestions(d) : asisProblems(d)}
  </div>`;
}

function asisContext(d) {
  const c = d.context, ns = '<span class="unknown">Ще не з’ясовано</span>';
  const row = (k, v, field) => `<dt>${h(k)}</dt><dd>${v}
    <button class="btn btn-ghost btn-sm" data-edit="${field}">Редагувати</button></dd>`;
  return `<div class="cols"><div class="stack">
    <section class="card lead">
      <h2>Навіщо існує процес</h2>
      <dl class="kv">
        ${row('Мета процесу', c.processGoal ? h(c.processGoal) : ns, 'processGoal')}
        ${row('Мета дослідження', c.researchGoal ? h(c.researchGoal) : ns, 'researchGoal')}
        ${row('Результат процесу', c.result ? h(c.result) : ns, 'result')}
      </dl>
      <p class="small muted" style="margin-top:var(--s4)">Заповнювати все до початку дослідження не обов’язково.</p>
    </section>
    <section class="card">
      <h2>Межі процесу</h2>
      <dl class="kv">
        ${row('Тригер — що запускає', c.start ? longText(c.start, 'start2') : ns, 'start')}
        ${row('Фактичне завершення', c.end ? h(c.end) : ns, 'end')}
      </dl>
      <div class="sect"><h3>Ролі</h3>
        <div class="row-tags">${c.roles.length ? c.roles.map(r => `<span class="tag">${h(r)}</span>`).join('') : ns}</div></div>
      <div class="sect"><h3>Поза межами дослідження</h3>
        <div class="row-tags">${(c.outOfScope || []).length ? c.outOfScope.map(r => `<span class="tag">${h(r)}</span>`).join('') : ns}</div></div>
    </section>
  </div>${railShort(d)}</div>`;
}
// Коли головну дію вже видно в картці змісту, права панель її не дублює синьою.
function railShort(d, opts) { return `<aside class="rail">${nextCard(d, { secondary: !!d.failure || !!(opts && opts.secondary) })}</aside>`; }

function asisSteps(d) {
  if (!d.steps.length) return `<section class="card"><p class="muted">Кроків ще немає: аналіз не запускався.</p></section>`;
  return `<section class="card">
    <h2>Кроки процесу · ${d.steps.length}</h2>
    <p class="small muted">Натисніть на крок, щоб відкрити деталі й докази.</p>
    <div class="tbl-wrap"><table class="steps">
      <thead><tr><th>ID</th><th>Роль</th><th>Дія</th><th>Умова входу</th><th>Далі</th></tr></thead>
      <tbody>${d.steps.map(s => `<tr data-step="${h(s.id)}" aria-selected="${S.panel && S.panel.kind === 'step' && S.panel.id === s.id}">
        <td class="id">${h(s.id)}${s.added ? ' <span class="tag acc">нове</span>' : ''}</td>
        <td>${h(s.role)}</td>
        <td><button class="linkish" data-step="${h(s.id)}">${h(s.action)}</button></td>
        <td class="small muted">${h(s.cond)}</td>
        <td class="small muted">${s.next.map(h).join(', ')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

function asisClaims(d) {
  if (!d.claims.length) return `<section class="card"><p class="muted">Тверджень ще немає.</p></section>`;
  return `<section class="card">
    <h2>Твердження й докази · ${d.claims.length}</h2>
    <p class="small muted">Позначка показує походження твердження.</p>
    <div class="rows">${d.claims.map(c => `<div class="row">
      <div class="row-head">
        <div class="row-tags"><span class="tag ${CLAIM_TONE[c.type]}">${h(CLAIM_LABEL[c.type])}</span>
          ${c.source ? `<span class="tag">${h(c.source)}</span>` : ''}</div>
        ${c.quote ? `<button class="btn btn-ghost btn-sm" data-claim="${h(c.id)}">Показати доказ</button>` : ''}
      </div>
      <div class="prose">${h(c.text)}</div>
      <div class="small muted">Область застосування: ${h(c.scope)}</div>
    </div>`).join('')}</div>
  </section>`;
}

function asisQuestions(d) {
  const qs = d.questions || [];
  if (!qs.length) return `<section class="card"><p class="muted">Питань ще немає.</p></section>`;
  return `<section class="card">
    <h2>Питання · ${qs.length}</h2>
    <div class="rows">${qs.map(q => `<div class="row" id="${h(q.id)}">
      <div class="row-head">
        <div class="row-tags">
          <span class="tag">${h(q.id)}</span>
          <span class="tag ${q.critical ? 'err' : ''}">${q.critical ? 'Критичне' : 'Некритичне'}</span>
          <span class="tag ${q.status === 'closed' ? 'ok' : ''}">${q.status === 'closed' ? 'Закрите' : 'Відкрите'}</span>
          ${q.unlinked ? `<span class="tag warn">Відкріплене від вилученого кроку</span>` : ''}
        </div>
      </div>
      <div class="prose">${h(q.text)}</div>
      ${q.why ? `<div class="small muted">Чому важливо: ${h(q.why)}</div>` : ''}
      ${q.blocks && q.blocks.length ? `<div class="small" style="color:var(--err-ink)">Блокує: ${q.blocks.map(h).join(', ')}</div>` : ''}
      ${q.links && q.links.length ? `<div class="small muted">Прив’язано до: ${q.links.map(h).join(', ')}</div>` : ''}
      ${q.answer ? `<div class="note ok">Відповідь: ${h(q.answer)}</div>` : ''}
      ${q.status === 'open' && q.critical && d.package ? `<div class="btnrow"><button class="btn btn-primary btn-sm" data-dialog="package">Переглянути пакет змін, що закриває це питання</button></div>` : ''}
    </div>`).join('')}</div>
  </section>`;
}

function asisProblems(d) {
  const ps = d.problems || [];
  if (!ps.length) return `<section class="card"><p class="muted">Проблем не зафіксовано.</p></section>`;
  return `<section class="card">
    <h2>Проблеми й гіпотези · ${ps.length}</h2>
    <div class="rows">${ps.map(p => {
      const [tone, sevLabel] = SEVERITY[p.severity] || ['', ''];
      return `<div class="row" id="${h(p.id)}">
        <div class="row-head"><div class="row-tags">
          <span class="tag">${h(p.id)}</span>
          <span class="tag">${h(PROBLEM_KIND[p.kind] || p.kind)}</span>
          <span class="tag ${tone}">${h(sevLabel)}</span>
        </div></div>
        <h3>${h(p.title)}</h3>
        <dl class="kv">
          <dt>Що сталося</dt><dd>${h(p.what)}</dd>
          <dt>Чому важливо</dt><dd>${h(p.why)}</dd>
          <dt>Що блокується</dt><dd>${h(p.blocks)}</dd>
          <dt>Хто має діяти</dt><dd>${h(p.who)}</dd>
        </dl>
        <div class="btnrow">${problemAction(p)}</div>
      </div>`;
    }).join('')}</div>
  </section>`;
}
function problemAction(p) {
  if (!p.action) return '';
  if (p.action.kind === 'question') return `<button class="btn btn-sm" data-go='${h(JSON.stringify({ tab: 'asis', sub: 'questions', focus: p.action.id }))}'>${h(p.action.label)}</button>`;
  if (p.action.kind === 'shortlabel') return `<button class="btn btn-primary btn-sm" data-dialog="shortlabel">${h(p.action.label)}</button>`;
  return `<button class="btn btn-sm" data-dialog="proposal" data-id="${h(p.id)}">${h(p.action.label)}</button>`;
}

/* ---------------- Джерела ---------------- */
const ORIGIN_LABEL = { work: 'Робочі матеріали', synthetic: 'Синтетичний приклад' };
function viewSources(d) {
  const pend = S.pendingBatch;
  return `<div class="page"><div class="cols"><div class="stack">
    <section class="card">
      <h2>Додати пакет джерел</h2>
      <p class="small muted">Додайте все, що маєте, і зробіть одне оновлення.</p>
      <div class="sect">
        <label class="lbl" for="newsrc">Назва джерела</label>
        <input type="text" id="newsrc" placeholder="Напр.: Інтерв’ю 5 — керівник підрозділу" value="${h(S.texts.newsrc || '')}">
        <div class="btnrow" style="margin-top:var(--s3)"><button class="btn btn-sm" data-act="addsrc">Додати до пакета</button></div>
      </div>
      ${pend.length ? `<div class="sect">
        <h3>У пакеті · ${pend.length}</h3>
        <div class="rows">${pend.map((p, i) => `<div class="row"><div class="row-head">
          <div>${h(p.title)}</div>
          <div class="row-tags">${p.origin ? `<span class="tag ${p.origin === 'synthetic' ? 'syn' : 'acc'}">${h(ORIGIN_LABEL[p.origin])}</span>
            <button class="btn btn-ghost btn-sm" data-fixorigin="${i}">Виправити</button>` : '<span class="tag warn">Походження не вказано</span>'}
            <button class="btn btn-ghost btn-sm" data-rmsrc="${i}">Прибрати</button></div>
        </div></div>`).join('')}</div>
        <fieldset style="border:1px solid var(--line);border-radius:var(--r-ctl);padding:var(--s3) var(--s4);margin-top:var(--s4)">
          <legend class="small muted">Походження матеріалу вкажіть ви — програма його не вгадує</legend>
          <label class="radio"><input type="radio" name="origin" value="work" ${S.batchOrigin === 'work' ? 'checked' : ''}><span><strong>Робочі матеріали</strong><br><span class="small muted">Справжні документи й записи вашого кейсу</span></span></label>
          <label class="radio"><input type="radio" name="origin" value="synthetic" ${S.batchOrigin === 'synthetic' ? 'checked' : ''}><span><strong>Синтетичний приклад</strong><br><span class="small muted">Вигадані матеріали для навчання чи демонстрації</span></span></label>
          <div class="btnrow" style="margin-top:var(--s3)">
            <button class="btn btn-sm" data-act="applyorigin" ${S.batchOrigin ? '' : 'disabled'}>Застосувати до всього пакета (${pend.length})</button>
            <span class="small muted">Виправити можна будь-яке джерело окремо.</span>
          </div>
        </fieldset>
        <div class="btnrow" style="margin-top:var(--s4)">
          <button class="btn btn-primary" data-act="analyze" ${pend.every(p => p.origin) ? '' : 'disabled'}>Оновити аналіз одним запуском (${pend.length})</button>
        </div>
        ${pend.every(p => p.origin) ? `<div class="paid">Платний етап: звернення до моделі</div>`
          : `<div class="note warn" style="margin-top:var(--s3)">Укажіть походження для всіх джерел пакета — без цього оновлення не запуститься.</div>`}
      </div>` : ''}
    </section>

    <section class="card">
      <h2>Опрацьовані джерела · ${(d.sources || []).length}</h2>
      ${(d.sources || []).length ? `<div class="rows">${d.sources.map(s => `<div class="row">
        <div class="row-head">
          <div><strong>${h(s.title)}</strong>${s.fresh ? ' <span class="tag acc">нове</span>' : ''}</div>
          <div class="row-tags"><span class="tag">${h(s.kind)}</span>
            <span class="tag ${s.origin === 'synthetic' ? 'syn' : 'acc'}">${h(ORIGIN_LABEL[s.origin] || s.origin)}</span>
            <span class="tag">${h(s.date)}</span></div>
        </div>
        <div class="small muted">${h(s.id)} · прочитано повністю</div>
      </div>`).join('')}</div>` : `<p class="muted">Жодного джерела ще не додано.</p>`}
    </section>
  </div>${railShort(d)}</div></div>`;
}

/* ---------------- Історія ---------------- */
function viewHistory(d) {
  const decs = d.decisions || [];
  return `<div class="page"><div class="stack">
    <section class="card">
      <h2>Рішення аналітикині · ${decs.length}</h2>
      <p class="small muted">Рішення щодо окремого питання не погоджує версію AS-IS.</p>
      ${decs.length ? `<div class="rows">${decs.map(x => {
        const [tone, label] = DEC_STATE[x.status];
        return `<div class="row">
          <div class="row-head"><div class="row-tags">
            <span class="tag">${h(x.id)}</span><span class="tag ${tone}">${h(label)}</span>
            ${x.reused ? '<span class="tag ok">Застосовано повторно</span>' : ''}
            ${x.replaces ? `<span class="tag acc">Замінює ${h(x.replaces)}</span>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" data-dialog="decision" data-id="${h(x.id)}">Відкрити</button></div>
          <div class="prose"><strong>${h(x.subject)}</strong></div>
          <div class="small muted">${h(x.author)} · ${h(x.date)} · застосовано до: ${h(x.scope)}</div>
        </div>`;
      }).join('')}</div>` : `<p class="muted">Рішень ще немає.</p>`}
    </section>
    <section class="card">
      <h2>Версії та погодження</h2>
      ${d.reusedNow ? `<div class="note ${d.reusedNow.approved ? 'ok' : 'warn'}" style="margin-bottom:var(--s4)">
        <strong>Рішення ${h(d.reusedNow.id)} підтверджено для версії «${h(d.reusedNow.version)}».</strong>
        ${d.reusedNow.approved ? 'Версія вже погоджена.' : 'Версія <strong>не погоджена</strong>.'}
      </div>` : ''}
      <div class="rows">
        <div class="row"><div class="row-head"><div><strong>${h(d.version.label)}</strong></div>
          <div class="row-tags"><span class="tag ${d.version.approved ? 'ok' : ''}">${d.version.approved ? 'Погоджено' : 'Не погоджено'}</span></div></div>
          <div class="small muted mono">${h(d.version.hash)}</div>
          ${d.version.approved ? `<div class="small">Погодила: ${h(d.version.approvedBy)} · ${h(d.version.approvedAt)}. Погодження прив’язане саме до цього знімка версії.</div>` : ''}
        </div>
        ${S.stage >= 1 ? `<div class="row"><div class="row-head"><div>Попередні версії</div></div>
          <div class="small muted">Збережені чернетки й прийняті правки лишаються доступними. Оновлення не знищує історію.</div></div>` : ''}
      </div>
    </section>
    <section class="card">
      <details class="diag"><summary>Технічна діагностика кейсу</summary><div class="in"><pre>case: ${h(d.$case.id)}
state: ${h(d.state)}
version_hash: ${h(d.version.hash)}
stage(прототип): ${h(STAGES[S.stage].label)}</pre></div></details>
    </section>
  </div></div>`;
}

/* ---------------- Схема ---------------- */
function viewDiagram(d) {
  if (d.run) return `<div class="page"><div class="stack">${runCard(d)}</div></div>`;
  if (d.failure) return `<div class="page"><div class="stack">${failureCard(d)}</div></div>`;
  if (!d.diagram) {
    const bl = buildBlockers(d);
    // перелік блокувань сам є причиною й дією — права панель його не дублює
    return `<div class="page"><div class="${bl.length ? '' : 'cols'}"><div class="stack"><section class="card">
      <h2>Схеми ще немає</h2>
      ${bl.length ? `<p class="prose">${bl.length === 1 ? 'Побудову стримує одна причина.' : `Побудову стримують ${bl.length} ${plural(bl.length, 'причина', 'причини', 'причин')} — у цьому порядку.`}</p>
      <ol class="blockers">${bl.map((x, i) => `<li>
        <div class="row-tags"><span class="tag ${x.tone}">${h(x.kind)}</span>${i > 0 ? `<span class="tag">доступно після кроку ${i}</span>` : ''}</div>
        <div class="prose">${h(x.text)}</div>
        <div class="small muted">Хто має діяти: ${h(x.who)}</div>
        ${i === 0 && x.go ? `<div class="btnrow"><button class="btn btn-primary btn-sm" data-go='${h(JSON.stringify(x.go))}'>${h(x.label)}</button></div>` : ''}
      </li>`).join('')}</ol>`
      : `<p class="prose">Перевірки пройдено. Побудова звертається до моделі — це платна дія.</p>
         <div class="btnrow"><button class="btn btn-primary" data-act="build">Побудувати схему</button></div>
         <div class="paid">Орієнтовна вартість запуску — близько $0,3. Перед списанням буде підтвердження.</div>`}
    </section></div>${bl.length ? '' : railShort(d, { secondary: true })}</div></div>`;
  }
  const g = d.diagram, hist = S.view.historical;
  return `<div class="page wide"><div class="stack">
    ${hist ? `<div class="note warn"><strong>Ви дивитесь історичну схему версії ${g.historical.version}.</strong>
      Чинна версія опису — ${h(String(g.forVersion))}. Причина неактуальності: ${h(g.historical.reason)}</div>` : ''}
    ${g.demo && !hist ? `<div class="note info">Схема демонстраційна: побудована для прототипу, а не отримана з реального запуску пайплайна.</div>` : ''}
    ${!g.demo && !hist ? `<div class="note info">Топологія — реальний збережений результат версії 29: ${g.counts.actions} дій, ${g.counts.elements} елементів, ${g.counts.transitions} переходів. Для прототипу її не змінювано.</div>` : ''}
    <div class="canvas-shell" id="shell">
      <div class="canvas-bar">
        <button class="btn btn-sm" data-view="fit">Показати всю схему</button>
        <button class="btn btn-sm" data-view="100">Робочий масштаб 100 %</button>
        <button class="btn btn-sm" data-view="out">−</button>
        <span class="small muted" style="min-width:4ch;text-align:center">${Math.round(S.view.zoom * 100)} %</span>
        <button class="btn btn-sm" data-view="in">+</button>
        <button class="btn btn-sm" data-view="full">${S.view.full ? 'Вийти з повного екрана' : 'Повний екран'}</button>
        <span class="sep"></span>
        <span class="tag ${hist ? 'warn' : 'ok'}">${hist ? 'Схема версії ' + g.historical.version : 'Схема версії ' + g.forVersion}</span>
        <button class="btn btn-sm" data-view="hist">${hist ? 'Повернутись до чинної' : 'Переглянути історичну'}</button>
      </div>
      <div class="canvas" id="canvas">${svg(d, hist)}<div class="wm">BPMN.io</div></div>
    </div>
    <div class="cols even">
      <section class="card">
        <h2>Перехід до кроку</h2>
        <p class="small muted">Підписи на полотні короткі. Повний зміст — у деталях кроку.</p>
        <div class="row-tags">${d.steps.map(s => `<button class="btn btn-sm" data-goto="${h(s.id)}">${h(s.id)}</button>`).join('')}</div>
        ${S.view.sel ? `<div class="sect"><h3>Вибраний елемент</h3>
          <div class="prose">${h(S.view.sel.name || '(без підпису)')}</div>
          <div class="small muted mono">${h(S.view.sel.el)}</div>
          <div class="btnrow"><button class="btn btn-sm" data-step="${h((S.view.sel.el.match(/_(S\d+|Z\d+)$/) || [])[1] || '')}">Відкрити деталі кроку</button></div>
        </div>` : ''}
      </section>
      <section class="card">
        <h2>Файли й версія</h2>
        <dl class="kv">
          <dt>Схема для версії</dt><dd>${hist ? h(String(g.historical.version)) + ' (історична)' : h(String(g.forVersion))}</dd>
          <dt>Знімок версії</dt><dd class="mono small">${h(hist ? g.historical.hash : g.forHash)}</dd>
          <dt>Побудовано</dt><dd>${h(hist ? g.historical.builtAt : g.builtAt)}</dd>
        </dl>
        <div class="btnrow" style="margin-top:var(--s4)">
          <button class="btn" data-act="dl">Завантажити .bpmn — версія ${hist ? h(String(g.historical.version)) : h(String(g.forVersion))}</button>
          <button class="btn" data-act="dl">Завантажити .drawio — версія ${hist ? h(String(g.historical.version)) : h(String(g.forVersion))}</button>
        </div>
        ${hist ? `<div class="note warn" style="margin-top:var(--s3)">Завантаження історичного результату позначається версією схеми у назві файлу, щоб його не сплутали з чинним.</div>` : ''}
        ${g.shortLabel ? `<div class="sect"><h3>Повний текст тригера</h3>
          <p class="small muted">На полотні — погоджений короткий підпис «${h(g.shortLabel.text)}». Повний текст не зникає ніде:</p>
          <div class="quote small">${h(g.shortLabel.full)}</div></div>` : ''}
        <div class="sect"><h3>Відомі вади наявного пайплайна</h3>
          <ul class="small muted">${g.pipelineNotes.map(n => `<li>${h(n)}</li>`).join('')}</ul>
        </div>
      </section>
    </div>
  </div></div>`;
}

// Перелік того, що насправді стримує побудову. Його веде «серверна» перевірка прототипу,
// а не стан кнопки: жодне рішення людини й жодне відхилення припущення агента його не скорочує.
function buildBlockers(d) {
  const out = [];
  (d.questions || []).filter(q => q.status === 'open' && q.critical).forEach(q => {
    // Якщо нове джерело вже дає відповідь — ведемо до її перевірки; якщо ні — не обіцяємо, що пакет закриє питання.
    const pkg = d.package && d.package.answerNeeded && d.package.answerNeeded.q === q.id ? d.package : null;
    const hasAnswer = pkg && pkg.answerNeeded.prefill;
    out.push({
      tone: 'err', kind: 'Критичне бізнес-невідоме', text: `${q.id}: ${q.text}`,
      who: hasAnswer
        ? `Аналітикиня — перевірити відповідь, запропоновану з ${pkg.answerNeeded.source}`
        : 'Аналітикиня — отримати відповідь від людей, які знають процес',
      go: hasAnswer ? { dialog: 'package' } : { tab: 'asis', sub: 'questions', focus: q.id },
      label: hasAnswer ? 'Перевірити відповідь у пакеті змін' : `Відкрити ${q.id}`,
    });
  });
  (d.problems || []).filter(x => x.severity === 'blocking-tech').forEach(x => {
    if (x.kind === 'generator_limit' && S.shortLabel) return;
    out.push({
      tone: 'warn', kind: PROBLEM_KIND[x.kind] || x.kind, text: x.what,
      who: x.who, go: { dialog: 'shortlabel' }, label: (x.action && x.action.label) || 'Відкрити',
    });
  });
  if (!d.version.approved) out.push({
    tone: '', kind: 'Погодження версії', text: `${d.version.label} — побудова запускається лише з погодженої версії AS-IS.`,
    who: 'Аналітикиня — погодити конкретну версію',
    go: d.approval ? { dialog: 'approve' } : null,
    label: d.approval ? 'Погодити версію' : null,
  });
  return out;
}

function svg(d, hist) {
  const geo = d.$case.diagramKind === 'real-v29' ? window.DIAGRAM_V29 : window.DIAGRAM_PROC;
  const nodes = geo.shapes.filter(s => !['lane', 'participant'].includes(s.tag));
  const lanes = geo.shapes.filter(s => ['lane', 'participant'].includes(s.tag));
  const maxX = Math.max(...geo.shapes.map(s => s.x + s.w)) + 80;
  const maxY = Math.max(...geo.shapes.map(s => s.y + s.h)) + 80;
  const z = S.view.zoom, tx = S.view.x, ty = S.view.y;
  const dim = hist ? ' opacity="0.55"' : '';
  S.view.extent = { w: maxX, h: maxY };
  return `<svg viewBox="0 0 1200 600" preserveAspectRatio="none" id="svg">
    <g transform="translate(${tx} ${ty}) scale(${z})"${dim}>
      ${lanes.map(l => `<g><rect class="lane" x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}"/>
        <text class="lanelbl" transform="translate(${l.x + 16} ${l.y + l.h / 2}) rotate(-90)" text-anchor="middle">${h(trunc(l.name, 48))}</text></g>`).join('')}
      ${geo.edges.map(e => `<g><path class="flow" d="${e.pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ')}"/>
        <path class="flow" d="${arrow(e.pts)}"/>
        ${e.label && e.name ? wrapText(e.name, e.label.x, e.label.y + 10, e.label.w || 140, 'flowlbl') : ''}</g>`).join('')}
      ${nodes.map(n => {
        const sel = S.view.sel && S.view.sel.el === n.el;
        const g0 = `<g class="node${sel ? ' sel' : ''}" data-el="${h(n.el)}">`;
        if (n.tag === 'exclusiveGateway')
          return `${g0}<path class="gw" d="M ${n.x + n.w / 2} ${n.y} L ${n.x + n.w} ${n.y + n.h / 2} L ${n.x + n.w / 2} ${n.y + n.h} L ${n.x} ${n.y + n.h / 2} Z"/>
            <path class="gw" d="M ${n.x + 16} ${n.y + 16} L ${n.x + n.w - 16} ${n.y + n.h - 16} M ${n.x + n.w - 16} ${n.y + 16} L ${n.x + 16} ${n.y + n.h - 16}" fill="none"/></g>`;
        if (n.tag === 'startEvent' || n.tag === 'endEvent')
          return `${g0}<circle cx="${n.x + n.w / 2}" cy="${n.y + n.h / 2}" r="${n.w / 2}" stroke-width="${n.tag === 'endEvent' ? 3.5 : 1.5}"/>
            ${n.name ? wrapText(trunc(n.name, 90), n.x - 70, n.y + n.h + 16, 180, 'flowlbl', 'middle', n.x + n.w / 2) : ''}</g>`;
        return `${g0}<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8"/>
          ${wrapText(n.name, n.x + 8, n.y + 20, n.w - 16, '', 'middle', n.x + n.w / 2, n.h)}</g>`;
      }).join('')}
    </g></svg>`;
}
function trunc(t, n) { return t && t.length > n ? t.slice(0, n - 1) + '…' : (t || ''); }
function arrow(pts) {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, s = 8;
  return `M ${b.x} ${b.y} L ${b.x - ux * s - uy * 4} ${b.y - uy * s + ux * 4} M ${b.x} ${b.y} L ${b.x - ux * s + uy * 4} ${b.y - uy * s - ux * 4}`;
}
function wrapText(t, x, y, w, cls, anchor, cx, boxH) {
  if (!t) return '';
  const per = Math.max(8, Math.floor(w / 6.8));
  const words = String(t).split(/\s+/); const lines = []; let cur = '';
  for (const wd of words) { if ((cur + ' ' + wd).trim().length > per) { if (cur) lines.push(cur); cur = wd; } else cur = (cur ? cur + ' ' : '') + wd; }
  if (cur) lines.push(cur);
  const show = lines.slice(0, 5);
  if (lines.length > 5) show[4] = show[4].slice(0, per - 1) + '…';
  const y0 = boxH ? y + (boxH - 20 - show.length * 14) / 2 : y;
  const X = anchor === 'middle' ? (cx != null ? cx : x + w / 2) : x;
  return `<text class="${cls || ''}" x="${X}" y="${y0}" ${anchor === 'middle' ? 'text-anchor="middle"' : ''}>${show.map((l, i) => `<tspan x="${X}" dy="${i ? 14 : 0}">${h(l)}</tspan>`).join('')}</text>`;
}

/* ---------------- Бічна панель ---------------- */
function openPanel(d) {
  const p = S.panel;
  let title = '', body = '';
  if (p.kind === 'step') {
    const s = (d.steps || []).find(x => x.id === p.id);
    if (!s) { S.panel = null; return; }
    title = `Крок ${s.id}`;
    const srcClaims = (d.claims || []).filter(c => s.src.includes(c.source));
    body = `<div><h3>${h(s.action)}</h3><p class="small muted">${h(s.role)}</p></div>
      <dl class="kv">
        <dt>Умова входу</dt><dd>${h(s.cond)}</dd>
        <dt>Результат</dt><dd>${h(s.result)}</dd>
        <dt>Далі</dt><dd>${s.next.map(h).join(', ')}</dd>
        <dt>Джерела</dt><dd>${s.src.map(x => `<span class="tag">${h(x)}</span>`).join(' ')}</dd>
      </dl>
      ${srcClaims.length ? `<div><h3>Докази поруч із твердженням</h3>
        ${srcClaims.map(c => `<div style="margin-bottom:var(--s4)">
          <div class="row-tags" style="margin-bottom:var(--s2)"><span class="tag ${CLAIM_TONE[c.type]}">${h(CLAIM_LABEL[c.type])}</span><span class="tag">${h(c.source)}</span></div>
          <div class="small">${h(c.text)}</div>
          ${c.quote ? `<div class="quote small" style="margin-top:var(--s2)"><mark>${h(c.quote)}</mark></div>` : ''}
        </div>`).join('')}</div>` : `<p class="small muted">Окремих цитат для цього кроку в синтетичних даних немає.</p>`}
      <div class="btnrow"><button class="btn btn-sm" data-edit="step:${h(s.id)}">Редагувати крок</button></div>`;
  } else if (p.kind === 'claim') {
    const c = (d.claims || []).find(x => x.id === p.id);
    if (!c) { S.panel = null; return; }
    title = 'Доказ у джерелі';
    body = `<div class="row-tags"><span class="tag ${CLAIM_TONE[c.type]}">${h(CLAIM_LABEL[c.type])}</span><span class="tag">${h(c.source)}</span></div>
      <div class="prose">${h(c.text)}</div>
      <div><h3>Точний фрагмент джерела</h3><div class="quote"><mark>${h(c.quote)}</mark></div></div>
      <p class="small muted">Область застосування: ${h(c.scope)}.</p>`;
  }
  const wrap = document.createElement('div');
  wrap.className = 'panel-layer';
  wrap.innerHTML = `<div class="scrim" data-close-panel></div>
    <aside class="panel" role="dialog" aria-label="${h(title)}">
      <div class="panel-head"><h2>${h(title)}</h2><button class="btn btn-sm" data-close-panel>Закрити</button></div>
      <div class="panel-body">${body}</div></aside>`;
  document.body.appendChild(wrap);
  els('[data-close-panel]', wrap).forEach(b => b.onclick = () => { S.panel = null; wrap.remove(); render(); });
  els('[data-edit]', wrap).forEach(b => b.onclick = () => { S.dialog = { kind: 'edit', field: b.dataset.edit }; render(); });
}

/* ---------------- Діалоги ---------------- */
function openDialog(d) {
  const k = S.dialog.kind;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = k === 'package' ? dlgPackage(d)
    : k === 'decision' ? dlgDecision(d)
    : k === 'approve' ? dlgApprove(d)
    : k === 'shortlabel' ? dlgShortLabel(d)
    : k === 'proposal' ? dlgProposal(d)
    : dlgEdit(d);
  document.body.appendChild(dlg);
  dlg.showModal();
  const close = () => { S.dialog = null; dlg.close(); dlg.remove(); render(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  els('[data-close]', dlg).forEach(b => b.onclick = close);
  const confirm = el('[data-confirm]', dlg);
  if (confirm) confirm.onclick = () => { applyDialog(d, dlg); close(); };
  // не фокусуємо поле автоматично: інакше діалог прокрутився б повз прев'ю наслідків
  const ta = el('textarea', dlg) || el('input[type="text"]', dlg);
  const need = el('[data-confirm][data-needtext]', dlg);
  if (need) {
    const vals = () => els('textarea, input[type="text"]', dlg).every(x => x.value.trim());
    need.disabled = !vals();
    els('textarea, input[type="text"]', dlg).forEach(x => x.oninput = () => { need.disabled = !vals(); });
  }
  const pk = el('#pkgans', dlg), orig = el('#ans-origin', dlg);
  if (pk && orig) {
    const base = pk.dataset.prefill, src = orig.textContent;
    pk.addEventListener('input', () => {
      const own = pk.value.trim() !== base.trim();
      orig.textContent = own ? 'Рішення аналітика' : src;
      orig.className = own ? 'tag ok' : 'tag acc';
    });
  }
  const body = el('.dlg-body', dlg); if (body) body.scrollTop = 0;
}

function dlgPackage(d) {
  const p = d.package;
  if (!p) return `<div class="dlg-head"><h2>Пакет недоступний</h2></div><div class="dlg-foot"><button class="btn" data-close>Закрити</button></div>`;
  return `<div class="dlg-head"><h2>${h(p.title)}</h2>
    <p class="small muted">${h(p.reason)}</p></div>
  <div class="dlg-body">
    <div class="note warn"><strong>Пакет застосовується цілком або не застосовується.</strong> Частково змінений опис не виникне.</div>
    <div><h3>Додається · ${p.add.length}</h3><ul class="small">${p.add.map(x => `<li><span class="mono">${h(x.id)}</span> — ${h(x.t)}</li>`).join('')}</ul></div>
    <div><h3>Вилучається · ${p.remove.length}</h3><ul class="small">${p.remove.map(x => `<li><span class="mono">${h(x.id)}</span> — ${h(x.t)}</li>`).join('')}</ul></div>
    <div><h3>Як зміняться переходи</h3><ul class="small">${p.transitions.map(x => `<li>${h(x)}</li>`).join('')}</ul></div>
    <div><h3>Що втратить прив’язку</h3>${p.losingLinks.map(x => `<div class="note warn small"><strong>${h(x.q)}</strong> — ${h(x.t)}<br>${h(x.was)}. ${h(x.effect)}</div>`).join('')}</div>
    <div><h3>Що лишиться відкритим</h3><ul class="small">${p.stillOpen.map(x => `<li>${h(x)}</li>`).join('')}</ul></div>
    <div><h3>${h(p.answerNeeded.label)}</h3>
      <div class="quote small" style="margin-bottom:var(--s3)"><strong>${h(p.answerNeeded.q)}.</strong> ${h(p.answerNeeded.questionText || '')}</div>
      <div class="row-tags" style="margin-bottom:var(--s2)">
        <span class="tag acc" id="ans-origin">${h(p.answerNeeded.prefill ? 'З джерела ' + p.answerNeeded.source : 'Рішення аналітика')}</span>
        <span class="tag">${h(p.answerNeeded.sourceOrigin || 'Синтетичний приклад')}</span>
      </div>
      ${p.answerNeeded.prefill
        ? `<p class="small muted">Текст нижче взято з ${h(p.answerNeeded.source)} — перевірте його перед застосуванням. Щойно ви його зміните, відповідь стане вашим рішенням.</p>`
        : `<p class="small muted">Відповіді в джерелах немає. Напишіть її самі — без неї пакет не застосовується.</p>`}
      <textarea id="pkgans" data-prefill="${h(p.answerNeeded.prefill || '')}" placeholder="${h(p.answerNeeded.placeholder)}">${h(S.texts.pkgans != null ? S.texts.pkgans : (p.answerNeeded.prefill || ''))}</textarea></div>
  </div>
  <div class="dlg-foot"><button class="btn" data-close>Скасувати</button>
    <button class="btn btn-primary" data-confirm data-needtext="1">Застосувати пакет повністю</button></div>`;
}

function dlgDecision(d) {
  const x = (d.decisions || []).find(y => y.id === S.dialog.id);
  if (!x) return `<div class="dlg-head"><h2>Рішення не знайдено</h2></div><div class="dlg-foot"><button class="btn" data-close>Закрити</button></div>`;
  const [tone, label] = DEC_STATE[x.status];
  const editable = x.status === 'confirm' || x.status === 'review' || x.status === 'void';
  return `<div class="dlg-head">
    <div class="row-tags" style="margin-bottom:var(--s2)"><span class="tag">${h(x.id)}</span><span class="tag ${tone}">${h(label)}</span></div>
    <h2>${h(x.subject)}</h2></div>
  <div class="dlg-body">
    ${x.status === 'valid' ? `<div class="note ok"><strong>Рішення вже діє — робити нічого не потрібно.</strong>
      Воно застосоване до цієї версії, і це записано в історії.</div>` : ''}
    <div><h3>Ваше пояснення</h3><div class="quote">${h(x.explain)}</div>
      <p class="small muted" style="margin-top:var(--s2)">${h(x.author)} · ${h(x.date)} · застосовано до: ${h(x.scope)}</p>
      <p class="small muted">Докази: ${x.evidence.map(h).join('; ')}</p></div>
    ${x.status === 'valid' ? `<div><h3>Що звірено</h3>
      <ul class="small">${x.checked.map(c => `<li>${h(c)}</li>`).join('')}</ul></div>` : ''}
    ${x.status === 'confirm' ? `<div class="note warn"><strong>Чому потрібне підтвердження.</strong> ${h(x.whyConfirm)}</div>` : ''}
    ${x.status !== 'valid' ? `<div><h3>Що саме змінилося</h3>
      <ul class="small">${(x.changedSince || []).map(c => `<li>${h(c)}</li>`).join('')}</ul></div>` : ''}
    ${x.status === 'void' ? `<div class="note err"><strong>Попереднє рішення не застосовується.</strong> ${h(x.whatToDo)}
      ${x.voidNote ? `<p class="small" style="margin:var(--s2) 0 0">${h(x.voidNote)}</p>` : ''}</div>` : ''}
    ${x.status === 'review' ? `<div class="note warn">${h(x.whatToDo)}</div>` : ''}
    ${x.unrelated && x.unrelated.length ? `<div><h3>Змінилося інше — рішення це не зачіпає</h3>
      <ul class="small">${x.unrelated.map(c => `<li>${h(c)}</li>`).join('')}</ul></div>` : ''}
    ${x.noBypass ? `<div class="note warn"><strong>Що це рішення не робить.</strong> ${h(x.noBypass)}</div>` : ''}
    ${editable && x.status !== 'void' ? `<div><label class="lbl" for="decedit">Пояснення — можна залишити як є</label>
      <textarea id="decedit">${h(S.texts.decedit != null ? S.texts.decedit : x.explain)}</textarea></div>` : ''}
    ${x.status === 'void' ? `<div><label class="lbl" for="decedit">Нове рішення</label>
      <textarea id="decedit" placeholder="Попереднє пояснення лишається в історії.">${h(S.texts.decedit || '')}</textarea></div>` : ''}
    ${d.version.approved ? '' : `<div class="note info small">${h(d.version.label)} ще не погоджена. Рішення щодо окремого питання погодження версії не замінює.</div>`}
  </div>
  <div class="dlg-foot"><button class="btn" data-close>${x.status === 'valid' ? 'Закрити' : 'Скасувати'}</button>
    ${x.status === 'valid' ? ''
      : x.status === 'void' ? `<button class="btn btn-primary" data-confirm data-needtext="1">Записати нове рішення</button>`
      : `<button class="btn btn-primary" data-confirm>Підтвердити пояснення</button>`}</div>`;
}

function dlgApprove(d) {
  const a = d.approval;
  const acc = a.version.replace(/^Версія/, 'версію');   // «Погодити версію 29», а не «Погодити Версія 29»
  return `<div class="dlg-head"><h2>Погодити ${h(acc)}</h2>
    <p class="small muted">Перевірте, що саме погоджуєте.</p></div>
  <div class="dlg-body">
    <div><h3>Точна версія</h3><p class="mono small">${h(a.hash)}</p>
      <p class="small muted">Погодження прив’язується саме до цього незмінного знімка. Зміна змісту створить нову версію, яка потребуватиме нового погодження.</p></div>
    <div><h3>Межі процесу</h3>
      <dl class="kv"><dt>Початок</dt><dd class="small">${h(a.bounds.start)}</dd><dt>Фактичне завершення</dt><dd class="small">${h(a.bounds.end)}</dd></dl></div>
    ${a.shortLabel ? `<div><h3>Короткий підпис початкової події</h3>
      <div class="quote small">${h(a.shortLabel.text)}</div>
      <p class="small muted">Повний текст тригера зберігається в описі й у файлах схеми без скорочення.</p></div>` : ''}
    <div><h3>Суттєві зміни цієї версії</h3><ul class="small">${a.material.map(m => `<li>${h(m)}</li>`).join('')}</ul></div>
    <div><h3>Залишкові некритичні питання</h3><ul class="small">${a.openNonCritical.map(m => `<li>${h(m)}</li>`).join('')}</ul>
      <p class="small muted">Вони лишаються відкритими після погодження й не блокують побудову.</p></div>
    <div class="note info"><strong>Погодження й платний запуск — окремі рішення.</strong> Після погодження побудова схеми не запускається сама.</div>
  </div>
  <div class="dlg-foot"><button class="btn" data-close>Скасувати</button>
    <button class="btn btn-primary" data-confirm>Погодити ${h(acc)}</button></div>`;
}

function dlgShortLabel(d) {
  const full = d.context.start || '';
  return `<div class="dlg-head"><h2>Короткий підпис початкової події</h2>
    <p class="small muted">Текст тригера — ${full.length} символів. Межа зовнішнього підпису події — 240.</p></div>
  <div class="dlg-body">
    <div><h3>Повний текст тригера</h3><div class="quote small">${h(full)}</div>
      <p class="small muted">Повний текст не зникає ніде: лишається в погодженому описі, у деталях події в .bpmn і .drawio та поруч зі схемою.</p></div>
    <div class="note warn">Підпис пишете ви: програма погоджений текст не скорочує.</div>
    <div><label class="lbl" for="sl">Короткий підпис (до 240 символів)</label>
      <input type="text" id="sl" value="${h(S.texts.sl || '')}" placeholder="Напр.: Підрозділ повідомив про потребу поза складом">
      <label class="lbl" for="slwhy" style="margin-top:var(--s3)">Пояснення (обов’язкове)</label>
      <textarea id="slwhy" placeholder="Чому саме такий підпис">${h(S.texts.slwhy || '')}</textarea></div>
    <div class="note info small">Підпис потрібен до побудови: саме він піде на схему.</div>
  </div>
  <div class="dlg-foot"><button class="btn" data-close>Скасувати</button>
    <button class="btn btn-primary" data-confirm data-needtext="1">Зберегти підпис</button></div>`;
}

function dlgProposal(d) {
  const p = (d.problems || []).find(x => x.id === S.dialog.id) || {};
  return `<div class="dlg-head"><h2>${h(p.title || 'Пропозиція агента')}</h2></div>
  <div class="dlg-body">
    <dl class="kv"><dt>Що сталося</dt><dd>${h(p.what)}</dd><dt>Чому важливо</dt><dd>${h(p.why)}</dd></dl>
    <div class="note warn">Відхилення пропозиції агента не знімає обмежень побудови.</div>
    <div><label class="lbl" for="propwhy">Пояснення рішення (обов’язкове)</label>
      <textarea id="propwhy" placeholder="Чому приймаєте або відхиляєте">${h(S.texts.propwhy || '')}</textarea></div>
  </div>
  <div class="dlg-foot"><button class="btn" data-close>Скасувати</button>
    <button class="btn" data-confirm data-needtext="1">Відхилити з поясненням</button></div>`;
}

function dlgEdit(d) {
  const f = S.dialog.field;
  const names = { processGoal: 'Мета процесу', researchGoal: 'Мета дослідження', result: 'Результат процесу', start: 'Тригер процесу', end: 'Фактичне завершення' };
  const title = f.startsWith('step:') ? 'Редагувати крок ' + f.slice(5) : (names[f] || 'Редагувати');
  const cur = f.startsWith('step:') ? ((d.steps || []).find(s => s.id === f.slice(5)) || {}).action : d.context[f];
  return `<div class="dlg-head"><h2>${h(title)}</h2>
    <p class="small muted">Редакційна правка окремого підтвердження не потребує.</p></div>
  <div class="dlg-body"><textarea id="edit">${h(S.texts.edit != null ? S.texts.edit : (cur || ''))}</textarea>
  </div>
  <div class="dlg-foot"><button class="btn" data-close>Скасувати</button><button class="btn btn-primary" data-confirm>Зберегти</button></div>`;
}

function applyDialog(d, dlg) {
  const k = S.dialog.kind;
  if (k === 'package') { S.pkgApplied = true; S.pkgAnswer = el('#pkgans', dlg).value.trim(); toast('Пакет застосовано повністю: кроки, переходи й відповідь на питання — однією операцією.'); }
  else if (k === 'approve') { S.approved = true; toast('Версію погоджено. Платний запуск побудови — окреме рішення.'); }
  else if (k === 'shortlabel') { S.shortLabel = el('#sl', dlg).value.trim(); toast('Короткий підпис збережено. Повний текст тригера лишився без змін.'); }
  else if (k === 'decision') {
    const x = (d.decisions || []).find(y => y.id === S.dialog.id) || {};
    S.reused = { id: x.id, subject: x.subject, status: x.status, version: d.version.label, approved: !!d.version.approved };
    toast(`Рішення ${x.id} підтверджено. Версію це не погоджує.`);
  }
  else if (k === 'proposal') { toast('Пропозицію відхилено з поясненням. Програмні перевірки лишаються чинними.'); }
  else toast('Правку збережено.');
  S.texts = {};
}

let toastT;
function toast(msg) {
  let t = el('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'note ok';
  t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,92vw);z-index:60;box-shadow:var(--shadow);border:1px solid #CDE7DA';
  t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 5200);
}

/* ---------------- Обробники ---------------- */
function wire(d) {
  // смуга прототипу
  el('#pbtn').onclick = () => { S.protoOpen = !S.protoOpen; render(); };
  const pcl = el('#pclose'); if (pcl) pcl.onclick = () => { S.protoOpen = false; render(); };
  el('#pcase').onchange = (e) => { S.caseId = e.target.value; reset(); render(false); window.scrollTo(0, 0); };
  el('#pstage').onchange = (e) => { S.stage = +e.target.value; reset(); render(false); window.scrollTo(0, 0); };
  el('#pprev').onclick = () => { S.stage = Math.max(0, S.stage - 1); reset(); render(false); window.scrollTo(0, 0); };
  el('#pnext').onclick = () => { S.stage = Math.min(STAGES.length - 1, S.stage + 1); reset(); render(false); window.scrollTo(0, 0); };

  els('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(false); window.scrollTo(0, 0); });
  els('[data-sub]').forEach(b => b.onclick = () => { S.sub = b.dataset.sub; render(false); });
  els('[data-go]').forEach(b => b.onclick = () => go(JSON.parse(b.dataset.go)));
  els('[data-step]').forEach(b => b.onclick = (e) => { e.stopPropagation(); if (b.dataset.step) { S.panel = { kind: 'step', id: b.dataset.step }; render(); } });
  els('[data-claim]').forEach(b => b.onclick = () => { S.panel = { kind: 'claim', id: b.dataset.claim }; render(); });
  els('[data-dialog]').forEach(b => b.onclick = () => { S.dialog = { kind: b.dataset.dialog, id: b.dataset.id }; render(); });
  els('[data-edit]').forEach(b => b.onclick = () => { S.dialog = { kind: 'edit', field: b.dataset.edit }; render(); });
  els('[data-toggle]').forEach(b => b.onclick = () => { const k = b.dataset.toggle; S.texts[k] = !S.texts[k]; render(); });
  els('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act, d));
  els('[data-fixorigin]').forEach(b => b.onclick = () => { S.pendingBatch[+b.dataset.fixorigin].origin = null; render(); });
  els('[data-rmsrc]').forEach(b => b.onclick = () => { S.pendingBatch.splice(+b.dataset.rmsrc, 1); render(); });
  els('input[name="origin"]').forEach(r => r.onchange = () => { S.batchOrigin = r.value; render(); });
  const ns = el('#newsrc'); if (ns) ns.oninput = () => { S.texts.newsrc = ns.value; };

  // схема
  els('[data-view]').forEach(b => b.onclick = () => viewAct(b.dataset.view, d));
  els('[data-goto]').forEach(b => b.onclick = () => gotoEl(b.dataset.goto, d));
  const cv = el('#canvas');
  if (cv) {
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: S.view.x, oy: S.view.y }; cv.classList.add('grabbing'); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; S.view.x = drag.ox + (e.clientX - drag.x); S.view.y = drag.oy + (e.clientY - drag.y); applyTransform(); });
    cv.addEventListener('pointerup', () => { drag = null; cv.classList.remove('grabbing'); });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    els('g.node', cv).forEach(g => g.addEventListener('click', () => {
      const geo = d.$case.diagramKind === 'real-v29' ? window.DIAGRAM_V29 : window.DIAGRAM_PROC;
      S.view.sel = geo.shapes.find(s => s.el === g.dataset.el) || null; render();
    }));
  }
}
function reset() { S.panel = null; S.dialog = null; S.pkgApplied = false; S.approved = false; S.reused = null; S.shortLabel = null; S.texts = {}; S.view = { zoom: 1, x: 0, y: 0, sel: null, full: false, historical: false, fitted: false }; stopRun(); }

function go(g) {
  if (g.dialog) { S.dialog = { kind: g.dialog, id: g.id }; render(); return; }
  if (g.tab) S.tab = g.tab;
  if (g.sub) S.sub = g.sub;
  if (g.focus) S.focus = g.focus;
  render(false);
  if (!g.focus) window.scrollTo(0, 0);
}

function act(a, d) {
  if (a === 'addsrc') {
    const v = (S.texts.newsrc || '').trim(); if (!v) { toast('Напишіть назву джерела.'); return; }
    S.pendingBatch.push({ title: v, origin: null }); S.texts.newsrc = ''; render();
  } else if (a === 'applyorigin') {
    S.pendingBatch.forEach(p => p.origin = S.batchOrigin); render();
    toast('Походження застосовано до всього пакета. Для кожного джерела його збережено окремо.');
  } else if (a === 'analyze') {
    toast('Один запуск на весь пакет. Аналіз після кожного документа не запускається.');
  } else if (a === 'resync') {
    S.run.lastSync = S.run.t; S.run.stale = false; render();
    toast('Стан оновлено. Дубля запуску не створено.');
  } else if (a === 'rebuild') {
    toast('Побудова зі збереженої таблиці. Модель не викликається, витрат немає.');
    S.stage = STAGES.findIndex(s => s.key === 'diagram'); reset(); render(false); window.scrollTo(0, 0);
  } else if (a === 'retry-paid') {
    toast('Це буде новий платний виклик моделі. Доки інструкція не виправлена, результат очікується той самий.');
  } else if (a === 'report') {
    toast('Діагностичний звіт збережено. PowerShell і ручні виправлення не потрібні — це робота розробника.');
  } else if (a === 'build') {
    toast('Тут був би запит підтвердження з точною сумою перед зверненням до моделі.');
  } else if (a === 'dl') {
    toast('У прототипі завантаження симульоване. У продукті файл має версію в назві.');
  }
}

/* ---------------- Схема: масштаб і переміщення ---------------- */
function geoOf(d) { return d.$case.diagramKind === 'real-v29' ? window.DIAGRAM_V29 : window.DIAGRAM_PROC; }
// одиниці viewBox = пікселі полотна, тому scale(1) — справжній масштаб 1:1
function sizeCanvas() {
  const cv = el('#canvas'), svgEl = el('#svg'); if (!cv || !svgEl) return null;
  const r = cv.getBoundingClientRect();
  const w = Math.max(100, Math.round(r.width)), hh = Math.max(100, Math.round(r.height));
  svgEl.setAttribute('viewBox', `0 0 ${w} ${hh}`);
  return { w, h: hh };
}
function fitView() {
  const box = sizeCanvas(); const e = S.view.extent; if (!box || !e) return;
  S.view.zoom = Math.min(box.w / e.w, box.h / e.h) * 0.96;
  S.view.x = (box.w - e.w * S.view.zoom) / 2;
  S.view.y = (box.h - e.h * S.view.zoom) / 2;
  applyTransform();
}
function workView() {
  const box = sizeCanvas(); if (!box) return;
  S.view.zoom = 1; S.view.x = 24; S.view.y = 24; applyTransform();
}
function scaleFactor() { return 1; }
function applyTransform() {
  const g = el('#svg > g'); if (g) g.setAttribute('transform', `translate(${S.view.x} ${S.view.y}) scale(${S.view.zoom})`);
  const lbl = el('.canvas-bar span.small'); if (lbl) lbl.textContent = Math.round(S.view.zoom * 100) + ' %';
}
function zoomBy(f) { S.view.zoom = Math.min(6, Math.max(0.15, S.view.zoom * f)); applyTransform(); }
function viewAct(a, d) {
  if (a === 'in') return zoomBy(1.25);
  if (a === 'out') return zoomBy(1 / 1.25);
  if (a === '100') return workView();
  if (a === 'fit') return fitView();
  if (a === 'full') { S.view.full = !S.view.full; render(); el('#shell').classList.toggle('full', S.view.full); requestAnimationFrame(fitView); return; }
  if (a === 'hist') { S.view.historical = !S.view.historical; S.view.sel = null; return render(); }
}
function gotoEl(stepId, d) {
  const geo = geoOf(d);
  const n = geo.shapes.find(s => s.el === 'Task_' + stepId);
  if (!n) { toast('Елемент для цього кроку на схемі не знайдено.'); return; }
  S.view.sel = n;
  S.view.zoom = 1.4;
  render();
  const box = sizeCanvas(); if (!box) return;
  S.view.x = box.w / 2 - (n.x + n.w / 2) * S.view.zoom;
  S.view.y = box.h / 2 - (n.y + n.h / 2) * S.view.zoom;
  applyTransform();
}

/* ---------------- Таймер тривалої операції ---------------- */
function stopRun() { if (S.run.timer) clearInterval(S.run.timer); S.run = { t: 0, lastSync: 0, stale: false, timer: null }; }
function startRunIfNeeded() {
  const d = resolve();
  if (!d.run) { if (S.run.timer) stopRun(); return; }
  if (S.run.timer) return;
  S.run.t = 0; S.run.lastSync = 0; S.run.stale = false;
  S.run.timer = setInterval(() => {
    S.run.t++;
    if (S.run.t < 18) S.run.lastSync = S.run.t;      // стан надходить
    else if (!S.run.stale && S.run.t >= 24) S.run.stale = true;  // зв’язок із оновленнями втрачено
    if (S.tab === 'overview' || S.tab === 'diagram') {
      const card = el('#run');
      if (card) { const y = window.scrollY; card.outerHTML = runCard(resolve()); wire(resolve()); window.scrollTo(0, y); }
    }
  }, 1000);
}

/* ---------------- Старт ---------------- */
const style = document.createElement('style');
style.textContent = '.flash{animation:fl 1.6s ease-out}@keyframes fl{0%,40%{background:var(--selected)}100%{background:transparent}}';
document.head.appendChild(style);

const _render = render;
render = function (k) {
  _render(k);
  startRunIfNeeded();
  if (el('#canvas')) {
    if (!S.view.fitted) { S.view.fitted = true; fitView(); }
    else { sizeCanvas(); applyTransform(); }
  }
};
window.addEventListener('resize', () => { if (el('#canvas')) { sizeCanvas(); applyTransform(); } });
render(false);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.panel) { S.panel = null; render(); } });
})();
