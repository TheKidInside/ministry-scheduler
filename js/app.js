// UI: routing, rendering and event wiring. Data rules live in model.js, storage in store.js.

import * as M from './model.js';
import { createStore } from './store.js';
import { sampleState } from './sample.js';

const store = createStore();
const TABS = ['schedule', 'preaching', 'ministers', 'series', 'settings'];
const MONTH_TABS = new Set(['schedule', 'preaching', 'ministers']);
const THEME_KEY = 'ministry-scheduler:theme';

let state = M.emptyState();
const now = new Date();
const view = { tab: 'schedule', y: now.getFullYear(), m: now.getMonth() + 1, focus: '' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const personName = id => state.people.find(p => p.id === id)?.name || 'Removed';
const seriesById = id => state.series.find(s => s.id === id) || null;

// ---------- persistence ----------

let warnedStorage = false;
function afterWrite(ok) {
  if (ok === false && !warnedStorage) {
    warnedStorage = true;
    toast('This browser is not keeping your changes (private window or storage full). Export a backup from Settings.', 'warn');
  }
}

async function putDoc(collection, doc) {
  const list = state[collection];
  const i = list.findIndex(d => d.id === doc.id);
  if (i >= 0) list[i] = doc; else list.push(doc);
  afterWrite(await store.putDoc(collection, doc));
}

async function deleteDoc(collection, id) {
  state[collection] = state[collection].filter(d => d.id !== id);
  afterWrite(await store.deleteDoc(collection, id));
}

async function replaceAll(next) {
  afterWrite(await store.replaceAll(next));
  state = await store.load();
}

// Write back only the services a bulk change actually touched.
async function putChangedServices(before, after) {
  const old = new Map(before.map(s => [s.id, s]));
  for (const s of after) if (old.get(s.id) !== s) await putDoc('services', s);
}

// ---------- routing ----------

function readHash() {
  const [, tab, month] = location.hash.split('/');
  if (TABS.includes(tab)) view.tab = tab;
  if (/^\d{4}-\d{2}$/.test(month || '')) {
    const [y, m] = month.split('-').map(Number);
    if (m >= 1 && m <= 12) { view.y = y; view.m = m; }
  }
}

function writeHash() {
  const next = `#/${view.tab}/${M.toISO(view.y, view.m, 1).slice(0, 7)}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

// ---------- render ----------

const TAB_TITLES = {
  schedule: 'Schedule', preaching: 'Preaching', ministers: 'Ministers', series: 'Sermon series', settings: 'Settings',
};

function render() {
  writeHash();
  document.title = `${state.settings.churchName} · Ministry Scheduler`;
  $('#church-name').textContent = state.settings.churchName;
  const monthTab = MONTH_TABS.has(view.tab);
  $('#page-eyebrow').textContent = monthTab ? TAB_TITLES[view.tab] : state.settings.churchName;
  $('#month-label').innerHTML = monthTab
    ? `${esc(M.MONTHS[view.m - 1])} <span class="year">${view.y}</span>`
    : esc(TAB_TITLES[view.tab]);
  $('#month-nav').hidden = !monthTab;
  for (const a of $$('[data-tab]')) a.setAttribute('aria-current', a.dataset.tab === view.tab ? 'page' : 'false');
  const views = { schedule: renderSchedule, preaching: renderPreaching, ministers: renderMinisters, series: renderSeries, settings: renderSettings };
  const el = $('#view');
  el.innerHTML = views[view.tab]();
  if (el.dataset.view !== view.tab) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  el.dataset.view = view.tab;
}

function emptyState(title, body, action = '') {
  return `<div class="empty"><span class="ornament" aria-hidden="true"></span><h2>${esc(title)}</h2><p>${esc(body)}</p>${action}</div>`;
}

// Two-letter monogram: "Ana R." -> "AR", "Pastor Jon" -> "PJ".
function initials(name) {
  const parts = String(name).replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

const personTag = (name, cls = 'chip') => `<span class="${cls}"><span class="mono" aria-hidden="true">${esc(initials(name))}</span>${esc(name)}</span>`;

const dayParts = iso => ({
  num: M.parseISO(iso).d,
  dow: M.formatDate(iso, { weekday: 'short' }),
  mon: M.formatDate(iso, { month: 'short' }),
});

// Schedule: one row per service, one column per role.
function renderSchedule() {
  const list = M.servicesInMonth(state.services, view.y, view.m);
  const day = M.WEEKDAYS[Number(state.settings.defaultDay) || 0];
  const focusOptions = state.people.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `<option value="${esc(p.id)}" ${p.id === view.focus ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const toolbar = `
    <div class="toolbar">
      <div class="toolbar-group">
        <button class="btn primary" data-action="fill-month">Add every ${esc(day)}</button>
        <button class="btn" data-action="new-service">Add a service</button>
        ${list.length ? '<button class="btn ghost" data-action="copy-roster">Copy roster</button>' : ''}
      </div>
      <label class="inline-field">Highlight
        <select data-action="focus" aria-label="Highlight a minister"><option value="">Nobody</option>${focusOptions}</select>
      </label>
    </div>`;
  if (!list.length) {
    return toolbar + emptyState('No services this month',
      `Add every ${day} in one click, or add a single service for a special date.`);
  }
  const head = state.roles.map(r => `<th scope="col">${esc(r.name)}</th>`).join('');
  const rows = list.map(svc => {
    const conflicts = M.serviceConflicts(state, svc);
    const bad = new Set(conflicts.map(c => `${c.roleId}:${c.personId}`));
    const cells = state.roles.map(role => {
      const ids = M.assigned(svc, role.id).filter(Boolean);
      const open = Math.max(0, (role.slots || 1) - ids.length);
      const chips = ids.map(id => {
        const cls = ['chip'];
        if (id === view.focus) cls.push('focus');
        if (bad.has(`${role.id}:${id}`)) cls.push('conflict');
        return personTag(personName(id), cls.join(' '));
      }).join('');
      const need = open ? `<span class="need">${ids.length ? `${open} open` : 'Open'}</span>` : '';
      return `<td data-label="${esc(role.name)}"><div class="cell">${chips}${need}</div></td>`;
    }).join('');
    const series = seriesById(svc.sermon?.seriesId);
    const d = dayParts(svc.date);
    const flag = conflicts.length
      ? `<span class="flag" title="${esc(conflicts.map(c => M.describeConflict(state, c)).join('\n'))}">${conflicts.length} to check</span>` : '';
    return `<tr data-action="edit-service" data-id="${esc(svc.id)}" tabindex="0">
      <th scope="row" class="when"><div class="when-inner">
        <span class="date-block"><span class="day-num">${d.num}</span><span class="day-dow">${esc(d.dow)}</span></span>
        <span class="when-meta">
          <span class="meta">${esc([svc.time, svc.name].filter(Boolean).join(' · '))}</span>
          ${series ? `<span class="series-tag" style="--series:${esc(series.color)}">${esc(series.name)}</span>` : ''}
          ${flag}
        </span>
      </div></th>${cells}</tr>`;
  }).join('');
  return toolbar + `<div class="table-wrap"><table class="matrix"><thead><tr><th scope="col">Service</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">Select a service to assign people, write the sermon, or auto-fill open places.</p>`;
}

// Preaching: the month as an arc of series. Each series is a ribbon spanning its Sundays;
// each sermon is a folio beneath it. On phones the same DOM order reads top to bottom.
function renderPreaching() {
  const list = M.servicesInMonth(state.services, view.y, view.m);
  if (!list.length) return emptyState('No services this month', 'Add services on the Schedule tab, then plan the sermons here.');
  const preacherOf = svc => M.assigned(svc, M.PREACHER_ROLE).filter(Boolean).map(personName);

  // consecutive runs of the same series
  const runs = [];
  list.forEach((svc, i) => {
    const sid = svc.sermon?.seriesId || '';
    const last = runs[runs.length - 1];
    if (last && last.sid === sid) last.items.push({ svc, i });
    else runs.push({ sid, items: [{ svc, i }] });
  });

  const folio = ({ svc, i }) => {
    const series = seriesById(svc.sermon?.seriesId);
    const part = M.seriesPart(state.services, svc);
    const d = dayParts(svc.date);
    const preachers = preacherOf(svc);
    return `<button class="folio${svc.date === M.todayISO() ? ' today' : ''}" data-action="edit-service" data-id="${esc(svc.id)}"
      style="grid-column:${i + 1};grid-row:2;--series:${esc(series?.color || 'var(--muted)')}">
      <span class="folio-date"><span class="folio-num">${d.num}</span><span class="folio-dow">${esc(d.dow)} · ${esc(d.mon)}</span></span>
      <span class="folio-part">${part ? `Part ${part.n} of ${part.of}` : 'Stand-alone'}</span>
      <span class="folio-title">${esc(svc.sermon?.title) || '<em>Title to come</em>'}</span>
      <span class="folio-scripture">${esc(svc.sermon?.scripture) || '<em>Scripture to come</em>'}</span>
      <span class="folio-preacher">${preachers.length ? preachers.map(n => personTag(n, 'chip plain')).join('') : '<span class="need">Preacher open</span>'}</span>
    </button>`;
  };

  const arc = runs.map(run => {
    const series = seriesById(run.sid);
    const first = run.items[0];
    const lastItem = run.items[run.items.length - 1];
    let label = '<span class="ribbon-name">No series</span>';
    let meta = `${run.items.length} sermon${run.items.length > 1 ? 's' : ''}`;
    if (series) {
      const a = M.seriesPart(state.services, first.svc);
      const b = M.seriesPart(state.services, lastItem.svc);
      label = `<span class="ribbon-name">${esc(series.name)}</span>`;
      meta = a.n === b.n ? `Part ${a.n} of ${a.of}` : `Parts ${a.n}–${b.n} of ${b.of}`;
    }
    const tag = series ? 'button' : 'div';
    const attrs = series ? ` data-action="edit-series" data-id="${esc(series.id)}"` : '';
    return `<${tag} class="ribbon${series ? '' : ' none'}"${attrs} style="grid-column:${first.i + 1} / span ${run.items.length};grid-row:1;--series:${esc(series?.color || 'var(--muted)')}">
        ${label}<span class="ribbon-meta">${esc(meta)}</span></${tag}>${run.items.map(folio).join('')}`;
  }).join('');

  const rows = list.map(svc => {
    const series = seriesById(svc.sermon?.seriesId);
    const part = M.seriesPart(state.services, svc);
    return `<tr data-action="edit-service" data-id="${esc(svc.id)}" tabindex="0" style="--series:${esc(series?.color || 'var(--line-strong)')}">
      <td data-label="Date" class="nowrap">${esc(M.formatDate(svc.date))}</td>
      <td data-label="Series"><span class="series-tag">${series ? esc(series.name) : 'None'}${part ? ` <span class="muted">${part.n}/${part.of}</span>` : ''}</span></td>
      <td data-label="Title" class="plan-title">${esc(svc.sermon?.title) || '<span class="muted">To come</span>'}</td>
      <td data-label="Scripture" class="plan-scripture">${esc(svc.sermon?.scripture) || '<span class="muted">—</span>'}</td>
      <td data-label="Preacher">${esc(preacherOf(svc).join(', ')) || '<span class="need">Open</span>'}</td>
    </tr>`;
  }).join('');

  return `<div class="arc-wrap"><section class="arc" aria-label="Sermons this month by series" style="--n:${list.length}">${arc}</section></div>
    <div class="section-head"><h2 class="section-title">Preaching plan</h2><span class="muted">${list.length} sermon${list.length > 1 ? 's' : ''} in ${esc(M.MONTHS[view.m - 1])}</span></div>
    <div class="table-wrap"><table class="plan"><thead><tr><th>Date</th><th>Series</th><th>Title</th><th>Scripture</th><th>Preacher</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderMinisters() {
  const people = state.people.slice().sort((a, b) => a.name.localeCompare(b.name));
  const toolbar = `<div class="toolbar"><button class="btn primary" data-action="new-person">Add a minister</button>
    <span class="muted">${people.length} minister${people.length === 1 ? '' : 's'}</span></div>`;
  if (!people.length) return toolbar + emptyState('No ministers yet', 'Add the people who serve, and the roles each one can do.');
  const today = M.todayISO();
  const cards = people.map(p => {
    const load = M.monthLoad(state.services, p.id, view.y, view.m);
    const next = M.personSchedule(state, p.id, today)[0];
    const away = (p.unavailable || []).filter(d => d >= today).length;
    const roles = state.roles.filter(r => M.canServe(p, r.id)).map(r => esc(r.name)).join('<span class="dot" aria-hidden="true">·</span>')
      || 'No roles yet';
    return `<button class="person" data-action="edit-person" data-id="${esc(p.id)}">
      <span class="person-top">
        <span class="mono large" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="person-id"><span class="person-name">${esc(p.name)}</span><span class="person-roles">${roles}</span></span>
        <span class="load" title="Services in ${esc(M.MONTHS[view.m - 1])}"><strong>${load}</strong><small>${esc(M.MONTHS[view.m - 1].slice(0, 3))}</small></span>
      </span>
      <span class="person-meta">
        <span>${next ? `Next · ${esc(M.formatDate(next.service.date))}, ${esc(next.roles.map(r => r.name).join(', '))}` : 'Nothing coming up'}</span>
        ${away ? `<span class="away-note">${away} date${away > 1 ? 's' : ''} away</span>` : ''}
      </span>
    </button>`;
  }).join('');
  return toolbar + `<div class="cards">${cards}</div>`;
}

function renderSeries() {
  const list = state.series.slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const toolbar = `<div class="toolbar"><button class="btn primary" data-action="new-series">New series</button></div>`;
  if (!list.length) return toolbar + emptyState('No sermon series yet', 'Create a series, give it dates and a colour, and the Preaching tab will show it.');
  const cards = list.map(s => {
    const sermons = M.sortServices(state.services.filter(x => x.sermon?.seriesId === s.id));
    const range = s.start && s.end ? `${M.formatDate(s.start, { day: 'numeric', month: 'short', year: 'numeric' })} – ${M.formatDate(s.end, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'No dates set';
    const items = sermons.map((x, i) => `<li><span class="li-num">${i + 1}</span>
      <span class="li-body"><span class="li-title">${esc(x.sermon.title) || '<em>Title to come</em>'}</span>
      <span class="li-meta">${esc(M.formatDate(x.date, { day: 'numeric', month: 'short' }))}${x.sermon.scripture ? ` · ${esc(x.sermon.scripture)}` : ''}</span></span></li>`).join('');
    return `<article class="series-card" style="--series:${esc(s.color)}">
      <header class="cover">
        <span class="cover-eyebrow">${sermons.length} sermon${sermons.length === 1 ? '' : 's'}</span>
        <h2>${esc(s.name)}</h2>
        <span class="cover-range">${esc(range)}</span>
        <button class="btn small on-cover" data-action="edit-series" data-id="${esc(s.id)}">Edit</button>
      </header>
      <div class="series-body">
        ${s.description ? `<p class="series-desc">${esc(s.description)}</p>` : ''}
        ${items ? `<ol class="sermon-list">${items}</ol>` : '<p class="muted">No services tagged with this series yet.</p>'}
      </div>
    </article>`;
  }).join('');
  return toolbar + `<div class="series-grid">${cards}</div>`;
}

function renderSettings() {
  const s = state.settings;
  const days = M.WEEKDAYS.map((d, i) => `<option value="${i}" ${Number(s.defaultDay) === i ? 'selected' : ''}>${d}</option>`).join('');
  const roles = state.roles.map(r => `<div class="role-row" data-role="${esc(r.id)}">
      <input name="role-name" value="${esc(r.name)}" aria-label="Role name" required maxlength="40">
      <label class="inline-field">People <input name="role-slots" type="number" min="1" max="12" value="${Number(r.slots) || 1}" aria-label="People needed for ${esc(r.name)}"></label>
      ${r.id === M.PREACHER_ROLE ? '<span class="muted small">Used by Preaching</span>' : `<button type="button" class="btn small danger" data-action="delete-role" data-id="${esc(r.id)}">Remove</button>`}
    </div>`).join('');
  const theme = currentTheme();
  const themeBtn = (v, label) => `<button type="button" class="seg${theme === v ? ' on' : ''}" data-action="theme" data-value="${v}" aria-pressed="${theme === v}">${label}</button>`;
  return `<div class="settings">
    <form class="panel" id="settings-form">
      <h2>Church</h2>
      <label>Church name <input name="churchName" value="${esc(s.churchName)}" required maxlength="80"></label>
      <div class="row3">
        <label>Usual service day <select name="defaultDay">${days}</select></label>
        <label>Usual time <input name="defaultTime" type="time" value="${esc(s.defaultTime)}"></label>
        <label>Service name <input name="serviceName" value="${esc(s.serviceName)}" maxlength="60"></label>
      </div>
      <button class="btn primary">Save</button>
    </form>
    <form class="panel" id="roles-form">
      <h2>Roles</h2>
      <p class="muted">The columns on the Schedule. "People" is how many each service needs.</p>
      <div id="role-rows">${roles}</div>
      <div class="row-actions"><button type="button" class="btn" data-action="add-role">Add a role</button><button class="btn primary">Save roles</button></div>
    </form>
    <section class="panel">
      <h2>Appearance</h2>
      <div class="segmented" role="group" aria-label="Theme">${themeBtn('system', 'System')}${themeBtn('light', 'Light')}${themeBtn('dark', 'Dark')}</div>
    </section>
    <section class="panel">
      <h2>Your data</h2>
      <p class="muted">Everything is saved in this browser only. Export a backup now and then; Firebase sync across devices is planned.</p>
      <div class="row-actions">
        <button type="button" class="btn" data-action="export">Export backup</button>
        <label class="btn">Import backup<input type="file" accept="application/json,.json" id="import-file" hidden></label>
        <button type="button" class="btn" data-action="load-sample">Load sample data</button>
        <button type="button" class="btn danger" data-action="clear-all">Clear everything</button>
      </div>
    </section>
  </div>`;
}

// ---------- dialogs ----------

const dialog = () => $('#modal');

function openDialog(html, { onSubmit, onMount, wide = false } = {}) {
  const d = dialog();
  d.classList.toggle('wide', wide);
  // The first submit button is the one Enter presses, so a hidden Save goes first;
  // otherwise Enter in a text box would hit Close or Delete.
  d.innerHTML = `<form method="dialog" class="dialog-form"><button value="save" class="enter-saves" tabindex="-1" aria-hidden="true"></button>${html}</form>`;
  const form = $('form', d);
  form.addEventListener('submit', async e => {
    const action = e.submitter?.value || 'save';
    if (action === 'cancel') return; // native close
    e.preventDefault();
    if (action !== 'delete' && !form.reportValidity()) return;
    const keepOpen = await onSubmit?.(form, action);
    if (!keepOpen) d.close();
    render(); // now, not on the queued 'close' event, so the saved change shows at once
  });
  onMount?.(form);
  d.showModal();
  return form;
}

const dialogHead = (title, sub = '') => `<header class="dialog-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="muted">${esc(sub)}</p>` : ''}</div>
  <button type="button" class="icon-btn" onclick="this.closest('dialog').close()" aria-label="Close">&times;</button></header>`;

// ----- service editor -----

function roleSelect(role, svc, slotIndex, personId) {
  const { y, m } = M.parseISO(svc.date || M.toISO(view.y, view.m, 1));
  const others = state.services.filter(s => s.id !== svc.id);
  const option = p => {
    const notes = [];
    if (svc.date && M.isUnavailable(p, svc.date)) notes.push('away');
    const load = M.monthLoad(others, p.id, y, m);
    if (load) notes.push(`${load}× this month`);
    return `<option value="${esc(p.id)}" ${p.id === personId ? 'selected' : ''}>${esc(p.name)}${notes.length ? ` (${notes.join(', ')})` : ''}</option>`;
  };
  const sorted = state.people.slice().sort((a, b) => a.name.localeCompare(b.name));
  const can = sorted.filter(p => M.canServe(p, role.id)).map(option).join('');
  const rest = sorted.filter(p => !M.canServe(p, role.id)).map(option).join('');
  return `<select name="role:${esc(role.id)}" data-slot="${slotIndex}" aria-label="${esc(role.name)} ${slotIndex + 1}">
    <option value="">Open</option>
    ${can ? `<optgroup label="Can serve">${can}</optgroup>` : ''}
    ${rest ? `<optgroup label="Others">${rest}</optgroup>` : ''}
  </select>`;
}

function serviceFormBody(svc) {
  const roles = state.roles.map(role => {
    const ids = M.assigned(svc, role.id);
    const slots = Math.max(role.slots || 1, ids.length);
    const selects = Array.from({ length: slots }, (_, i) => roleSelect(role, svc, i, ids[i] || '')).join('');
    return `<div class="role-field${role.id === M.PREACHER_ROLE ? ' preacher' : ''}"><span class="role-label">${esc(role.name)}</span><div class="role-selects">${selects}</div></div>`;
  }).join('');
  const series = state.series.slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''))
    .map(s => `<option value="${esc(s.id)}" ${s.id === svc.sermon.seriesId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `
    <div class="row3">
      <label>Date <input name="date" type="date" value="${esc(svc.date)}" required></label>
      <label>Time <input name="time" type="time" value="${esc(svc.time)}"></label>
      <label>Service <input name="name" value="${esc(svc.name)}" maxlength="60"></label>
    </div>
    <fieldset class="sermon-fields">
      <legend>Sermon</legend>
      <label>Title <input name="sermon-title" value="${esc(svc.sermon.title)}" maxlength="120" placeholder="e.g. Rooted in Christ"></label>
      <div class="row2">
        <label>Scripture <input name="sermon-scripture" value="${esc(svc.sermon.scripture)}" maxlength="120" placeholder="e.g. Colossians 1:15-20"></label>
        <label>Series <select name="sermon-series"><option value="">No series</option>${series}</select></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>Who is serving</legend>
      <div class="roles">${roles}</div>
    </fieldset>
    <label>Notes <textarea name="notes" rows="2" maxlength="500">${esc(svc.notes)}</textarea></label>
    <div class="conflicts" aria-live="polite"></div>`;
}

function readServiceForm(form, base) {
  const assignments = {};
  for (const role of state.roles) {
    const picks = $$(`select[name="role:${CSS.escape(role.id)}"]`, form).map(s => s.value);
    if (picks.some(Boolean)) assignments[role.id] = picks.filter(Boolean);
  }
  return {
    ...base,
    date: form.elements.date.value,
    time: form.elements.time.value,
    name: form.elements.name.value.trim() || 'Service',
    assignments,
    sermon: {
      title: form.elements['sermon-title'].value.trim(),
      scripture: form.elements['sermon-scripture'].value.trim(),
      seriesId: form.elements['sermon-series'].value,
    },
    notes: form.elements.notes.value.trim(),
  };
}

function showConflicts(form, svc) {
  const list = svc.date ? M.serviceConflicts(state, svc) : [];
  $('.conflicts', form).innerHTML = list.length
    ? `<strong>Check before saving</strong><ul>${list.map(c => `<li>${esc(M.describeConflict(state, c))}</li>`).join('')}</ul>` : '';
}

function openServiceEditor(existing, date) {
  const isNew = !existing;
  let svc = existing ? structuredClone(existing) : M.newService({
    date: date || M.toISO(view.y, view.m, 1),
    time: state.settings.defaultTime,
    name: state.settings.serviceName,
  });
  if (isNew) svc.sermon.seriesId = M.seriesCoveringDate(state.series, svc.date)?.id || '';
  const title = isNew ? 'New service' : M.formatDate(svc.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const actions = `<footer class="dialog-actions">
    ${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Delete</button>'}
    <button type="button" class="btn" data-local="autofill">Auto-fill open slots</button>
    <span class="spacer"></span>
    <button class="btn" value="cancel" formnovalidate>Cancel</button>
    <button class="btn primary" value="save">Save</button>
  </footer>`;
  openDialog(dialogHead(title, isNew ? '' : [svc.time, svc.name].filter(Boolean).join(' · ')) + `<div class="dialog-body">${serviceFormBody(svc)}</div>` + actions, {
    wide: true,
    onMount(form) {
      const refresh = () => showConflicts(form, readServiceForm(form, svc));
      refresh();
      form.addEventListener('change', e => {
        if (e.target.name === 'date' && e.target.value && !form.elements['sermon-series'].value) {
          const cover = M.seriesCoveringDate(state.series, e.target.value);
          if (cover) form.elements['sermon-series'].value = cover.id;
        }
        refresh();
      });
      $('[data-local="autofill"]', form).addEventListener('click', () => {
        const current = readServiceForm(form, svc);
        if (!current.date) { form.elements.date.reportValidity(); return; }
        svc = M.autoFill(state, current);
        $('.dialog-body', form).innerHTML = serviceFormBody(svc);
        refresh();
        toast('Open slots filled with available people who have served least this month.');
      });
    },
    async onSubmit(form, action) {
      if (action === 'delete') {
        if (!confirm('Delete this service and its assignments?')) return true;
        await deleteDoc('services', svc.id);
        toast('Service deleted.');
        return false;
      }
      const next = readServiceForm(form, svc);
      await putDoc('services', next);
      const { y, m } = M.parseISO(next.date);
      if (y !== view.y || m !== view.m) { view.y = y; view.m = m; }
      toast('Service saved.');
      return false;
    },
  });
}

// ----- person editor -----

function openPersonEditor(existing) {
  const isNew = !existing;
  const person = existing ? structuredClone(existing) : { id: M.uid('p_'), name: '', contact: '', roleIds: [], unavailable: [] };
  const roles = state.roles.map(r => `<label class="check"><input type="checkbox" name="roles" value="${esc(r.id)}" ${M.canServe(person, r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('');
  const upcoming = isNew ? [] : M.personSchedule(state, person.id, M.todayISO()).slice(0, 8);
  const schedule = upcoming.length
    ? `<ul class="mini-list">${upcoming.map(x => `<li><span>${esc(M.formatDate(x.service.date))}</span> ${esc(x.roles.map(r => r.name).join(', '))}</li>`).join('')}</ul>`
    : '<p class="muted">Not on any upcoming service.</p>';
  const awayList = () => person.unavailable.slice().sort().map(d => `<li><span>${esc(M.formatDate(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span>
    <button type="button" class="icon-btn small" data-remove-date="${esc(d)}" aria-label="Remove ${esc(d)}">&times;</button></li>`).join('') || '<li class="muted">None</li>';
  openDialog(dialogHead(isNew ? 'New minister' : person.name) + `<div class="dialog-body">
      <div class="row2">
        <label>Name <input name="name" value="${esc(person.name)}" required maxlength="60" autocomplete="off"></label>
        <label>Phone or email <input name="contact" value="${esc(person.contact)}" maxlength="80" autocomplete="off"></label>
      </div>
      <fieldset><legend>Can serve as</legend><div class="checks">${roles}</div></fieldset>
      <fieldset><legend>Away dates</legend>
        <div class="add-date"><input type="date" name="away" aria-label="Date away"><button type="button" class="btn" data-local="add-date">Add date</button></div>
        <ul class="mini-list away">${awayList()}</ul>
      </fieldset>
      ${isNew ? '' : `<fieldset><legend>Coming up</legend>${schedule}</fieldset>`}
    </div>
    <footer class="dialog-actions">
      ${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Delete</button>'}
      <span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">Save</button>
    </footer>`, {
    onMount(form) {
      const redraw = () => { $('.away', form).innerHTML = awayList(); };
      $('[data-local="add-date"]', form).addEventListener('click', () => {
        const v = form.elements.away.value;
        if (!M.isValidISO(v)) { form.elements.away.focus(); return; }
        if (!person.unavailable.includes(v)) person.unavailable.push(v);
        form.elements.away.value = '';
        redraw();
      });
      $('.away', form).addEventListener('click', e => {
        const d = e.target.closest('[data-remove-date]')?.dataset.removeDate;
        if (!d) return;
        person.unavailable = person.unavailable.filter(x => x !== d);
        redraw();
      });
    },
    async onSubmit(form, action) {
      if (action === 'delete') {
        if (!confirm(`Delete ${person.name}? They will be removed from every service.`)) return true;
        const before = state.services;
        const after = M.removePersonEverywhere(before, person.id);
        await putChangedServices(before, after);
        state.services = after;
        await deleteDoc('people', person.id);
        if (view.focus === person.id) view.focus = '';
        toast('Minister deleted.');
        return false;
      }
      // a date typed but not "added" still counts
      const pending = form.elements.away.value;
      if (M.isValidISO(pending) && !person.unavailable.includes(pending)) person.unavailable.push(pending);
      await putDoc('people', {
        ...person,
        name: form.elements.name.value.trim(),
        contact: form.elements.contact.value.trim(),
        roleIds: $$('input[name="roles"]:checked', form).map(i => i.value),
        unavailable: person.unavailable.slice().sort(),
      });
      toast(isNew ? 'Minister added.' : 'Minister saved.');
      return false;
    },
  });
}

// ----- series editor -----

function openSeriesEditor(existing) {
  const isNew = !existing;
  const used = new Set(state.series.map(s => s.color));
  const series = existing ? structuredClone(existing) : {
    id: M.uid('ser_'), name: '', description: '', start: '', end: '',
    color: M.SERIES_COLORS.find(c => !used.has(c)) || M.SERIES_COLORS[state.series.length % M.SERIES_COLORS.length],
  };
  const swatches = M.SERIES_COLORS.map(c => `<button type="button" class="swatch-btn" style="--series:${c}" data-color="${c}" aria-label="Use colour ${c}"></button>`).join('');
  openDialog(dialogHead(isNew ? 'New series' : series.name) + `<div class="dialog-body">
      <label>Series name <input name="name" value="${esc(series.name)}" required maxlength="80" placeholder="e.g. Rooted: Colossians"></label>
      <div class="row2">
        <label>Starts <input name="start" type="date" value="${esc(series.start)}"></label>
        <label>Ends <input name="end" type="date" value="${esc(series.end)}"></label>
      </div>
      <label>Colour <span class="color-row"><input name="color" type="color" value="${esc(series.color)}">${swatches}</span></label>
      <label>Description <textarea name="description" rows="3" maxlength="400">${esc(series.description)}</textarea></label>
      <p class="hint">Services in these dates that don't have a series yet will be tagged with this one.</p>
    </div>
    <footer class="dialog-actions">
      ${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Delete</button>'}
      <span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">Save</button>
    </footer>`, {
    onMount(form) {
      form.addEventListener('click', e => {
        const c = e.target.closest('[data-color]')?.dataset.color;
        if (c) form.elements.color.value = c;
      });
      form.addEventListener('input', e => {
        if (e.target.name === 'start' || e.target.name === 'end') form.elements.end.setCustomValidity('');
      });
    },
    async onSubmit(form, action) {
      if (action === 'delete') {
        if (!confirm(`Delete the series "${series.name}"? Sermons keep their titles; they just lose the series tag.`)) return true;
        const before = state.services;
        const after = M.clearSeriesEverywhere(before, series.id);
        await putChangedServices(before, after);
        state.services = after;
        await deleteDoc('series', series.id);
        toast('Series deleted.');
        return false;
      }
      const start = form.elements.start.value;
      const end = form.elements.end.value;
      if (start && end && end < start) {
        form.elements.end.setCustomValidity('The end date is before the start date.');
        form.elements.end.reportValidity();
        return true;
      }
      const next = {
        ...series,
        name: form.elements.name.value.trim(),
        start, end,
        color: form.elements.color.value,
        description: form.elements.description.value.trim(),
      };
      await putDoc('series', next);
      let tagged = 0;
      if (start && end) {
        for (const svc of state.services) {
          if (svc.date >= start && svc.date <= end && !svc.sermon?.seriesId) {
            await putDoc('services', { ...svc, sermon: { ...svc.sermon, seriesId: next.id } });
            tagged++;
          }
        }
      }
      toast(tagged ? `Series saved and added to ${tagged} service${tagged > 1 ? 's' : ''}.` : 'Series saved.');
      return false;
    },
  });
}

// ---------- settings actions ----------

function newRoleRow() {
  const id = M.uid('role_');
  return `<div class="role-row" data-role="${id}" data-new="1">
    <input name="role-name" value="" placeholder="e.g. Ushers" aria-label="Role name" required maxlength="40">
    <label class="inline-field">People <input name="role-slots" type="number" min="1" max="12" value="1" aria-label="People needed"></label>
    <button type="button" class="btn small danger" data-action="delete-role" data-id="${id}">Remove</button></div>`;
}

async function saveRoles(form) {
  const rows = $$('.role-row', form);
  const roles = rows.map((row, order) => ({
    id: row.dataset.role,
    order,
    name: $('[name="role-name"]', row).value.trim(),
    slots: Math.min(12, Math.max(1, parseInt($('[name="role-slots"]', row).value, 10) || 1)),
  }));
  // Role order matters (it is the column order), so this saves the whole state in one go.
  const keep = new Set(roles.map(r => r.id));
  let services = state.services;
  for (const old of state.roles) if (!keep.has(old.id)) services = M.removeRoleEverywhere(services, old.id);
  const people = state.people.map(p => ({ ...p, roleIds: p.roleIds.filter(r => keep.has(r)) }));
  await replaceAll({ ...state, roles, services, people });
  toast('Roles saved.');
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ministry-schedule-${M.todayISO()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  try {
    const next = M.normalizeState(JSON.parse(await file.text()));
    if (!confirm(`Replace everything with this backup? (${next.services.length} services, ${next.people.length} ministers)`)) return;
    await replaceAll(next);
    toast('Backup imported.');
    render();
  } catch (err) {
    toast(`Could not import: ${err.message}`, 'warn');
  }
}

// ---------- theme ----------

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

function applyTheme(value) {
  if (value === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = value;
  try { localStorage.setItem(THEME_KEY, value); } catch { /* not kept */ }
}

// ---------- toast ----------

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'warn' ? 6000 : 2600);
}

// ---------- events ----------

async function handleAction(el) {
  const { action, id } = el.dataset;
  switch (action) {
    case 'edit-service': return openServiceEditor(state.services.find(s => s.id === id));
    case 'new-service': {
      const day = M.toISO(view.y, view.m, 1);
      return openServiceEditor(null, M.monthKey(M.todayISO()) === day.slice(0, 7) ? M.todayISO() : day);
    }
    case 'fill-month': {
      const created = M.generateMonthServices(state, view.y, view.m);
      for (const s of created) await putDoc('services', s);
      toast(created.length ? `Added ${created.length} service${created.length > 1 ? 's' : ''}.` : 'Every one of those days already has a service.');
      return render();
    }
    case 'edit-person': return openPersonEditor(state.people.find(p => p.id === id));
    case 'new-person': return openPersonEditor(null);
    case 'edit-series': return openSeriesEditor(state.series.find(s => s.id === id));
    case 'new-series': return openSeriesEditor(null);
    case 'add-role': return $('#role-rows').insertAdjacentHTML('beforeend', newRoleRow());
    case 'delete-role': {
      const row = el.closest('.role-row');
      const used = state.services.some(s => M.assigned(s, row.dataset.role).length);
      if (!row.dataset.new && used && !confirm('Remove this role? Its assignments on every service will be cleared when you save.')) return;
      return row.remove();
    }
    case 'theme': applyTheme(el.dataset.value); return render();
    case 'export': return exportBackup();
    case 'copy-roster': {
      const text = M.rosterText(state, view.y, view.m);
      try {
        await navigator.clipboard.writeText(text);
        toast('Roster copied. Paste it into your group chat.');
      } catch {
        openDialog(dialogHead('Copy the roster') + `<div class="dialog-body"><textarea rows="16" readonly>${esc(text)}</textarea></div>`,
          { onMount: f => $('textarea', f).select() });
      }
      return undefined;
    }
    case 'load-sample':
      if (!confirm('Replace everything with the sample church? Export a backup first if you want to keep your data.')) return;
      await replaceAll(sampleState());
      toast('Sample data loaded.');
      return render();
    case 'clear-all':
      if (!confirm('Delete every service, minister and series? This cannot be undone.')) return;
      await replaceAll({ ...M.emptyState(), settings: { ...state.settings, seeded: true }, roles: state.roles });
      view.focus = '';
      toast('Everything cleared.');
      return render();
    case 'prev': ({ y: view.y, m: view.m } = M.shiftMonth(view.y, view.m, -1)); return render();
    case 'next': ({ y: view.y, m: view.m } = M.shiftMonth(view.y, view.m, 1)); return render();
    case 'today': view.y = now.getFullYear(); view.m = now.getMonth() + 1; return render();
    default: return undefined;
  }
}

function wire() {
  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { e.preventDefault(); view.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); $('.main').scrollTo(0, 0); return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'SELECT' || dialog().contains(el)) return;
    handleAction(el);
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-action]')) {
      e.preventDefault();
      handleAction(e.target);
    }
  });
  document.addEventListener('change', e => {
    if (e.target.matches('select[data-action="focus"]')) { view.focus = e.target.value; render(); }
    if (e.target.id === 'import-file' && e.target.files[0]) importBackup(e.target.files[0]);
  });
  document.addEventListener('submit', async e => {
    if (e.target.id === 'settings-form') {
      e.preventDefault();
      const f = e.target.elements;
      state.settings = { ...state.settings, churchName: f.churchName.value.trim() || 'Our Church', defaultDay: Number(f.defaultDay.value), defaultTime: f.defaultTime.value, serviceName: f.serviceName.value.trim() || 'Service' };
      afterWrite(await store.putSettings(state.settings));
      toast('Settings saved.');
      render();
    }
    if (e.target.id === 'roles-form') {
      e.preventDefault();
      await saveRoles(e.target);
      render();
    }
  });
  window.addEventListener('hashchange', () => { readHash(); render(); });
  // Every way a dialog closes (Save, Cancel, the X, Esc) redraws once, picking up any change.
  dialog().addEventListener('close', render);
  store.subscribe(next => { state = next; if (!dialog().open) render(); });
}

async function init() {
  applyTheme(currentTheme());
  state = await store.load();
  // First visit: show a filled-in sample so the app explains itself. Never re-seeds after a clear.
  if (!state.settings.seeded && !state.people.length && !state.services.length) {
    const sample = sampleState();
    sample.settings.seeded = true;
    await replaceAll(sample);
  }
  readHash();
  wire();
  render();
}

init();
