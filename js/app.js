// UI: routing, rendering and event wiring. Data rules live in model.js, storage in store.js,
// Firebase sign-in and sync in cloud.js (loaded only when needed).

import * as M from './model.js';
import { createStore } from './store.js';
import { sampleState } from './sample.js';

const localStore = createStore();
let store = localStore;          // swapped for a FirebaseStore when you sign in to a church
let unsubscribe = () => {};
const TABS = ['schedule', 'preaching', 'tasks', 'ministers', 'series', 'settings'];
const MONTH_TABS = new Set(['schedule', 'preaching', 'tasks']);
const THEME_KEY = 'ministry-scheduler:theme';
const phoneWidth = matchMedia('(max-width: 760px)');

let state = M.emptyState();
const now = new Date();
const view = { tab: 'schedule', y: now.getFullYear(), m: now.getMonth() + 1, focus: '', announce: false, day: '', search: '', roleFilter: '' };

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

// Changes only these fields, here and in the store.
async function patchDoc(collection, id, fields) {
  const list = state[collection];
  const i = list.findIndex(d => d.id === id);
  if (i >= 0) list[i] = { ...list[i], ...fields };
  afterWrite(await store.patchDoc(collection, id, fields));
}

async function deleteDoc(collection, id) {
  state[collection] = state[collection].filter(d => d.id !== id);
  afterWrite(await store.deleteDoc(collection, id));
}

async function replaceAll(next) {
  afterWrite(await store.replaceAll(next));
  state = isCloud() ? M.normalizeState(structuredClone(next)) : await store.load();
}

// Write back only the docs a bulk change actually touched.
async function putChanged(collection, before, after) {
  const old = new Map(before.map(d => [d.id, d]));
  for (const d of after) if (old.get(d.id) !== d) await putDoc(collection, d);
}

// ---------- routing ----------

function readHash() {
  const [, tab, month, mode] = location.hash.split('/');
  if (TABS.includes(tab)) view.tab = tab;
  view.announce = mode === 'announce';
  if (/^\d{4}-\d{2}$/.test(month || '')) {
    const [y, m] = month.split('-').map(Number);
    if (m >= 1 && m <= 12) { view.y = y; view.m = m; }
  }
}

function writeHash() {
  const next = `#/${view.tab}/${M.toISO(view.y, view.m, 1).slice(0, 7)}${view.tab === 'schedule' && view.announce ? '/announce' : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

// ---------- render ----------

const TAB_NAMES = {
  schedule: 'Schedule', preaching: 'Preaching', tasks: 'Tasks', ministers: 'Ministers', series: 'Series', settings: 'Settings',
};

const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const ICONS = {
  copy: icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  print: icon('<path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2"/><rect x="6" y="14" width="12" height="7"/>'),
  spark: icon('<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  pencil: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  warn: icon('<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 17.5v.5"/>'),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  grip: icon('<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>'),
  back: icon('<path d="M15 6l-6 6 6 6"/>'),
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pageTitle() {
  if (MONTH_TABS.has(view.tab)) return `${M.MONTHS[view.m - 1]} ${view.y}`;
  if (view.tab === 'ministers') return state.people.length ? `${state.people.length} ${state.people.length === 1 ? 'person' : 'people'} serving` : 'Ministers';
  return view.tab === 'series' ? 'Sermon series' : 'Church settings';
}

// The buttons at the top right of a page. On a phone these shrink to icons in the navy header.
function pageActions() {
  const act = (action, ic, label, cls = '') => `<button class="btn act ${cls}" data-action="${action}" aria-label="${label}">${ICONS[ic]}<span>${label}</span></button>`;
  const hasServices = M.servicesInMonth(state.services, view.y, view.m).length > 0;
  switch (view.tab) {
    case 'schedule': return hasServices
      ? act('copy-roster', 'copy', 'Copy as text') + act('print', 'print', 'Print', 'hide-phone') + (canManage() ? act('autofill-month', 'spark', 'Auto-fill open slots', 'primary') : '') : '';
    case 'preaching': return hasServices ? act('print', 'print', 'Print preaching plan', 'primary') : '';
    case 'ministers': return canManage() ? act('new-person', 'plus', 'Add minister', 'primary gold') : '';
    case 'series': return canManage() ? act('new-series', 'plus', 'New series', 'primary gold') : '';
    default: return '';
  }
}

// A phone keeps what you navigate with in the navy header, which stays put as the page scrolls.
const phoneHeads = {
  schedule() {
    if (view.announce) return '';
    const list = M.servicesInMonth(state.services, view.y, view.m);
    if (!list.length) return '';
    const picked = pickedService(list);
    return `<div class="day-pills" style="--n:${Math.min(list.length, 6)}">${list.map(svc => {
      const s = M.serviceSummary(state, svc);
      const d = dayParts(svc.date);
      return `<button class="day-pill" data-action="pick-day" data-id="${esc(svc.id)}" aria-pressed="${svc.id === picked.id}" aria-label="${esc(M.shortDate(svc.date))}">
        <span class="dow">${esc(d.dow)}</span><span class="num">${d.num}</span><span class="dot${s.open || s.clashes.length ? ' on' : ''}"></span></button>`;
    }).join('')}</div>`;
  },
  preaching() {
    const list = M.servicesInMonth(state.services, view.y, view.m);
    const runs = seriesRuns(list).filter(run => seriesById(run.sid));
    return runs.length ? `<div class="arc-compact">${runs.map(run => {
      const series = seriesById(run.sid);
      const a = M.seriesPart(state.services, run.items[0].svc).n;
      const b = M.seriesPart(state.services, run.items[run.items.length - 1].svc).n;
      return `<span class="bar" style="--n:${run.items.length};--series:${esc(series.color)}">${esc(series.name)} · ${a === b ? a : `${a}–${b}`}</span>`;
    }).join('')}</div>` : '';
  },
  ministers: () => (state.people.length ? ministerFilters() : ''),
};

function render() {
  writeHash();
  if (!state.roles.some(r => r.id === view.roleFilter)) view.roleFilter = '';
  document.title = `${state.settings.churchName} · Ministry Scheduler`;
  $('#church-name').textContent = state.settings.churchName;
  const monthTab = MONTH_TABS.has(view.tab);
  const head = $('.page-head');
  head.dataset.page = view.tab;
  head.classList.toggle('off-month', monthTab && (view.y !== now.getFullYear() || view.m !== now.getMonth() + 1));
  $('#page-eyebrow').textContent = TAB_NAMES[view.tab];
  $('#month-label').textContent = pageTitle();
  $('#month-nav').hidden = !monthTab;
  const sub = $('#page-sub');
  sub.hidden = view.tab !== 'settings';
  sub.textContent = !canManage() ? 'Only an admin can change your church\'s settings.'
    : isCloud() ? 'Changes save automatically and are shared with your church.' : 'Changes save automatically in this browser.';
  $('#page-actions').innerHTML = pageActions();
  $('#head-extra').innerHTML = phoneWidth.matches ? phoneHeads[view.tab]?.() || '' : '';
  for (const a of $$('[data-tab]')) a.setAttribute('aria-current', a.dataset.tab === view.tab ? 'page' : 'false');
  const views = { schedule: renderSchedule, preaching: renderPreaching, tasks: renderTasks, ministers: renderMinisters, series: renderSeries, settings: renderSettings };
  const el = $('#view');
  el.innerHTML = views[view.tab]();
  if (el.dataset.view !== view.tab) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  el.dataset.view = view.tab;
  if (view.tab === 'ministers') applyMinisterFilter();
  renderAccountButton();
  renderMineButton();
}

function emptyState(title, body, action = '') {
  return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(body)}</p>${action}</div>`;
}

// Two-letter monogram: "Ana R." -> "AR", "Pastor Jon" -> "PJ".
function initials(name) {
  const parts = String(name).replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

// A minister's own photo, else the one on the account they're linked to.
const photoOf = person => person?.photo || cloudState.info?.memberPhotos?.[person?.userId] || '';
const personPhoto = id => photoOf(state.people.find(p => p.id === id));
const avatar = (name, photo = '') => (photo
  ? `<img class="mono" src="${esc(photo)}" alt="" aria-hidden="true">`
  : `<span class="mono" aria-hidden="true">${esc(initials(name))}</span>`);

const dayParts = iso => ({
  num: M.parseISO(iso).d,
  dow: M.formatDate(iso, { weekday: 'short' }),
  mon: M.formatDate(iso, { month: 'short' }),
});

const dateRange = (a, b) => {
  const start = { day: 'numeric', month: 'short' };
  if (a.slice(0, 4) !== b.slice(0, 4)) start.year = 'numeric';
  return `${M.formatDate(a, start)} – ${M.formatDate(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

function highlightField() {
  const options = state.people.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `<option value="${esc(p.id)}" ${p.id === view.focus ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<label class="inline-field">Highlight
        <select data-action="focus" aria-label="Highlight a minister"><option value="">Nobody</option>${options}</select>
      </label>`;
}

const assignButton = (svc, roleId, slot, label = 'Assign') => `<button class="assign" data-action="assign" data-id="${esc(svc.id)}" data-role="${esc(roleId)}" data-slot="${slot}">${ICONS.plus}${esc(label)}</button>`;

// What tapping a service does: admins edit all of it, its preacher edits the sermon, others just read.
function serviceAction(svc) {
  const action = canManage() ? 'edit-service' : preachesOn(svc) ? 'edit-sermon' : '';
  return action ? `data-action="${action}" data-id="${esc(svc.id)}" tabindex="0"` : '';
}

const openTag = '<span class="need">Open</span>';

const pickedService = list => list.find(s => s.id === view.day) || list.find(s => s.date >= M.todayISO()) || list[0];

// Schedule: one row per service, one column per role. A phone shows one service at a time.
function renderSchedule() {
  const modeBtn = (on, value, label) => `<button class="seg${on ? ' on' : ''}" data-action="schedule-mode" data-value="${value}" aria-pressed="${on}">${label}</button>`;
  const modes = `<div class="view-mode"><div class="segmented" role="group" aria-label="Schedule view">${modeBtn(!view.announce, 'manage', 'Manage')}${modeBtn(view.announce, 'announce', 'Announcement')}</div></div>`;
  if (view.announce) return `<div class="toolbar">${modes}</div>${renderAnnouncement()}`;
  const list = M.servicesInMonth(state.services, view.y, view.m);
  const day = M.WEEKDAYS[Number(state.settings.defaultDay) || 0];
  const admin = canManage();
  const addButtons = primary => (admin ? `<button class="btn${primary ? ' primary' : ''}" data-action="fill-month">Add every ${esc(day)}</button>
        <button class="btn" data-action="new-service">Add a service</button>` : '');
  if (!list.length) {
    return `<div class="toolbar">${modes}</div>` + (admin
      ? emptyState('No services this month', `Add every ${day} in one click, or add a single service for a special date.`, `<div class="row-actions">${addButtons(true)}</div>`)
      : emptyState('No services this month', 'Your admin hasn\'t added any services for this month yet.'));
  }
  if (phoneWidth.matches) return renderDay(pickedService(list), modes, addButtons(false));

  const summary = M.monthSummary(state, view.y, view.m);
  const stat = (label, value, tone = '', of = '') => `<div class="stat"><span class="stat-label">${label}</span>
    <span class="stat-value ${value ? tone : ''}">${value}${of ? `<small> / ${of}</small>` : ''}</span></div>`;
  const stats = `<section class="stats" aria-label="This month at a glance">
    ${stat('Services this month', summary.services)}${stat('Roles filled', summary.filled, '', summary.total)}${stat('Open slots', summary.open, 'amber')}${stat('Clashes', summary.clashes.length, 'red')}
  </section>`;
  const alert = admin && summary.clashes.length ? `<section class="alert">${ICONS.warn}<div>
      <strong>${summary.clashes.length === 1 ? '1 clash needs' : `${summary.clashes.length} clashes need`} sorting out</strong>
      <ul>${summary.clashes.map(({ service, clash }) => `<li><button class="alert-line" data-action="edit-service" data-id="${esc(service.id)}">${esc(M.clashSentence(state, service, clash))}</button></li>`).join('')}</ul>
    </div></section>` : '';
  const toolbar = `<div class="toolbar">${modes}
      <div class="toolbar-group">
        ${addButtons(false)}
        ${highlightField()}
      </div>
    </div>`;

  const today = M.todayISO();
  const thisWeekId = list.find(s => s.date >= today && s.date <= M.addDays(today, 6))?.id;
  const head = state.roles.map(r => `<th scope="col">${esc(r.name)}</th>`).join('');
  const rows = list.map(svc => {
    const clashes = M.serviceClashes(state, svc);
    const cells = state.roles.map(role => {
      const ids = M.assigned(svc, role.id).filter(Boolean);
      const open = Math.max(0, (role.slots || 1) - ids.length);
      const names = ids.map(id => {
        const clash = clashes.find(c => c.roleId === role.id && c.personId === id);
        if (clash) return `<span class="chip conflict${id === view.focus ? ' focus' : ''}">${esc(personName(id))}<small>${esc(M.clashNote(state, svc, clash))}</small></span>`;
        return `<span class="chip${id === view.focus ? ' focus' : ''}">${esc(personName(id))}</span>`;
      }).join('');
      return `<td data-label="${esc(role.name)}"><div class="cell">${names}${open ? (admin ? assignButton(svc, role.id, ids.length, open > 1 ? `Assign ${open}` : 'Assign') : openTag) : ''}</div></td>`;
    }).join('');
    const series = seriesById(svc.sermon?.seriesId);
    const passage = M.shortScripture(series?.name, svc.sermon?.scripture);
    const usual = svc.time === state.settings.defaultTime && svc.name === state.settings.serviceName;
    return `<tr class="${svc.id === thisWeekId ? 'this-week' : ''}" ${serviceAction(svc)}>
      <th scope="row" class="when"><div class="when-inner">
        <span class="when-date">${esc(M.shortDate(svc.date))}${svc.id === thisWeekId ? '<span class="week-pill">This week</span>' : ''}</span>
        ${series || passage ? `<span class="when-meta"><span class="series-tag" style="--series:${esc(series?.color || 'var(--line-strong)')}">${esc([series?.name, passage].filter(Boolean).join(' · '))}</span></span>` : ''}
        ${!usual || svc.setlist?.length ? `<span class="when-meta">${usual ? '' : `<span>${esc([svc.time, svc.name].filter(Boolean).join(' · '))}</span>`}
          ${svc.setlist?.length ? `<span class="songs-tag" title="${esc(svc.setlist.map(M.songLabel).join('\n'))}">${plural(svc.setlist.length, 'song')}</span>` : ''}</span>` : ''}
      </div></th>${cells}</tr>`;
  }).join('');
  return `${stats}${alert}${toolbar}<div class="table-wrap"><table class="matrix"><thead><tr><th scope="col">Service</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="legend"><span><i class="l-open"></i>Open slot</span><span><i class="l-clash"></i>Clash: rostered twice, away, or not set up for the role</span></div>`;
}

// One service on a phone, grouped the way the team thinks of it.
function renderDay(svc, modes, addButtons) {
  const { open, clashes } = M.serviceSummary(state, svc);
  const admin = canManage();
  const action = serviceAction(svc);
  const cardTag = action ? 'button' : 'div';
  const parts = [clashes.length && `${clashes.length} clash${clashes.length === 1 ? '' : 'es'}`, open && `${open} open`].filter(Boolean);
  const series = seriesById(svc.sermon?.seriesId);
  const preachers = M.assigned(svc, M.PREACHER_ROLE).filter(Boolean).map(personName).join(', ') || 'Not yet assigned';
  const title = svc.sermon?.title || svc.sermon?.scripture || series?.name || 'Sermon to come';
  const passage = svc.sermon?.title ? svc.sermon?.scripture : '';
  const groups = M.roleGroups(state.roles).map(group => `<section class="group">
      <h2 class="group-label">${esc(group.name)}</h2>
      <div class="group-card">${group.roles.map(role => {
        const ids = M.assigned(svc, role.id).filter(Boolean);
        return Array.from({ length: Math.max(role.slots || 1, ids.length) }, (_, i) => {
          const id = ids[i];
          const clash = id && clashes.find(c => c.roleId === role.id && c.personId === id);
          const who = id ? `<span class="slot-who"><span class="slot-name">${esc(personName(id))}${clash ? `<small>${esc(M.clashNote(state, svc, clash))}</small>` : ''}</span>${avatar(personName(id), personPhoto(id))}</span>`
            : admin ? `<span class="assign">${ICONS.plus}Assign</span>` : openTag;
          const inner = `<span class="slot-role">${i ? '' : esc(role.name)}</span>${who}`;
          if (!admin) return `<div class="slot${clash ? ' conflict' : ''}">${inner}</div>`;
          return `<button class="slot${clash ? ' conflict' : ''}" data-action="assign" data-id="${esc(svc.id)}" data-role="${esc(role.id)}" data-slot="${id ? i : ids.length}" aria-label="${esc(role.name)}: ${esc(id ? personName(id) : 'open')}">${inner}</button>`;
        }).join('');
      }).join('')}</div>
    </section>`).join('');
  const songs = svc.setlist?.length
    ? svc.setlist.map((song, i) => `<div class="song"><span class="song-n">${i + 1}</span><span class="song-title">${esc(song.title)}</span>${song.key ? `<span class="song-key">${esc(song.key)}</span>` : ''}</div>`).join('')
    : `<div class="no-songs"><span>No songs added yet</span>${admin ? `<button class="btn small" data-action="edit-service" data-id="${esc(svc.id)}">Add songs</button>` : ''}</div>`;
  const when = M.formatDate(svc.date, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  return `<div class="toolbar">${modes}</div>
    <div class="day-view">
      <${cardTag} class="day-card" ${action}${action ? ` aria-label="Edit ${esc(when)}"` : ''}>
        <span class="day-top"><span>${esc(when)}</span><span class="status${clashes.length ? ' bad' : open ? ' warn' : ''}">${esc(parts.join(' · ') || 'Fully rostered')}</span></span>
        <span><span class="day-title">${esc(title)}</span>
        <span class="day-sub">${passage ? `${esc(passage)} · ` : ''}Preacher: ${esc(preachers)}</span></span>
      </${cardTag}>
      ${groups}
      <section class="group"><h2 class="group-label">Setlist</h2><div class="group-card">${songs}</div></section>
      ${addButtons ? `<div class="day-foot">${addButtons}</div>` : ''}
    </div>`;
}

// Announcement: the month as one self-contained card to screenshot into group chats.
// Dates run across and roles down, so more roles make it taller, never too wide for a phone.
function renderAnnouncement() {
  const blocks = M.announcementBlocks(state, view.y, view.m, phoneWidth.matches ? 4 : 5); // 5 dates are too tight to read on a phone
  if (!blocks.length) return emptyState('No services this month', 'Add services under Manage, then share the month from here.');
  const { churchName, defaultTime, serviceName } = state.settings;
  const dateHead = svc => {
    const d = dayParts(svc.date);
    const special = [svc.time !== defaultTime && svc.time, svc.name !== serviceName && svc.name].filter(Boolean).join(' · ');
    return `<th scope="col"><span class="ann-dow">${esc(d.dow)}</span><span class="ann-date">${d.num} ${esc(d.mon)}</span>${special ? `<span class="ann-special">${esc(special)}</span>` : ''}</th>`;
  };
  const namesCell = names => `<td>${names.length ? names.map(n => `<span class="ann-name">${esc(n)}</span>`).join('') : '<span class="ann-tba">TBA</span>'}</td>`;
  const tables = blocks.map(b => `<table class="announce-table">
    <thead><tr><th scope="col">Role</th>${b.services.map(dateHead).join('')}</tr></thead>
    <tbody>${b.rows.map(r => `<tr><th scope="row">${esc(r.role.name)}</th>${r.cells.map(namesCell).join('')}</tr>`).join('')}</tbody>
  </table>`).join('');
  return `<section class="announce" aria-label="Roster to share">
      <header class="announce-head"><span class="announce-church">${esc(churchName)}</span>
        <h2>${esc(M.MONTHS[view.m - 1])} <span class="year">${view.y}</span> roster</h2></header>
      ${tables}
    </section>
    <p class="hint">Screenshot this card to send it to your group chats.</p>`;
}

// Consecutive services in the same series, each with its place in the month.
function seriesRuns(list) {
  const runs = [];
  list.forEach((svc, i) => {
    const sid = svc.sermon?.seriesId || '';
    const last = runs[runs.length - 1];
    if (last && last.sid === sid) last.items.push({ svc, i });
    else runs.push({ sid, items: [{ svc, i }] });
  });
  return runs;
}

// Preaching: the month's series as one ribbon, then a card for each sermon.
function renderPreaching() {
  const list = M.servicesInMonth(state.services, view.y, view.m);
  if (!list.length) return emptyState('No services this month', 'Add services on the Schedule tab, then plan the sermons here.');
  const today = M.todayISO();

  const folio = svc => {
    const series = seriesById(svc.sermon?.seriesId);
    const part = M.seriesPart(state.services, svc);
    const preachers = M.assigned(svc, M.PREACHER_ROLE).filter(Boolean);
    const who = preachers.map(id => `<span class="preacher">${avatar(personName(id), personPhoto(id))}${esc(personName(id))}</span>`).join('');
    const action = serviceAction(svc);
    return `<article class="folio${svc.date === today ? ' today' : ''}" ${action} style="--series:${esc(series?.color || 'var(--muted)')}">
      <header class="folio-top"><span class="folio-date">${esc(M.shortDate(svc.date))}</span>
        <span class="folio-part">${series ? `${esc(series.name)} · Part ${part.n}` : 'Stand-alone'}</span></header>
      <h3 class="folio-title">${esc(svc.sermon?.title) || '<em>Title to come</em>'}</h3>
      <p class="folio-scripture">${esc(svc.sermon?.scripture) || '<em>Scripture to come</em>'}</p>
      <footer class="folio-foot"><span class="folio-people">${who || (canManage() ? assignButton(svc, M.PREACHER_ROLE, 0, 'Assign preacher') : '<span class="need">Preacher open</span>')}</span>
        ${action ? `<button class="icon-btn" ${action} aria-label="Edit ${esc(M.shortDate(svc.date))}">${ICONS.pencil}</button>` : ''}</footer>
    </article>`;
  };

  const ribbons = seriesRuns(list).map(run => {
    const series = seriesById(run.sid);
    const first = run.items[0];
    const span = `grid-column:${first.i + 1} / span ${run.items.length}`;
    if (!series) return `<div class="ribbon none" style="${span}"><span class="ribbon-name">No series</span><span class="ribbon-meta">${plural(run.items.length, 'sermon')}</span></div>`;
    const a = M.seriesPart(state.services, first.svc);
    const b = M.seriesPart(state.services, run.items[run.items.length - 1].svc);
    const inner = `<span class="ribbon-name">${esc(series.name)}</span><span class="ribbon-meta">${a.n === b.n ? `Part ${a.n} of ${a.of}` : `Parts ${a.n}–${b.n} of ${b.of}`}</span>`;
    return canManage() ? `<button class="ribbon" data-action="edit-series" data-id="${esc(series.id)}" style="${span};--series:${esc(series.color)}">${inner}</button>`
      : `<div class="ribbon" style="${span};--series:${esc(series.color)}">${inner}</div>`;
  }).join('');
  const dates = list.map(s => `<span>${esc(M.formatDate(s.date, { day: 'numeric', month: 'short' }))}</span>`).join('');
  const arc = phoneWidth.matches ? '' : `<section class="arc" style="--n:${list.length}" aria-label="Sermons this month by series">
      <h2 class="panel-label">Series this month</h2>
      <div class="arc-bars">${ribbons}</div>
      <div class="arc-dates">${dates}</div>
    </section>`;
  return `${arc}<section class="folio-grid" aria-label="Sermons this month">${list.map(folio).join('')}</section>`;
}

// Tasks: a card for each week of the month, each week running up to the usual service day.
function renderTasks() {
  const day = state.settings.defaultDay;
  const today = M.todayISO();
  const short = iso => M.formatDate(iso, { day: 'numeric', month: 'short' });
  const weeks = M.weeksInMonth(view.y, view.m, day).map(w => ({ ...w, tasks: M.tasksInWeek(state.tasks, w.end, day) }));
  const all = weeks.flatMap(w => w.tasks);
  const unassigned = all.filter(t => !t.done && !t.assignees.length).length;
  const summary = all.length
    ? `${all.filter(t => t.done).length} of ${all.length} done${unassigned ? ` · ${unassigned} unassigned` : ''}`
    : 'No tasks yet this month';
  const admin = canManage();
  const row = t => {
    const who = t.assignees.map(id => `<span class="chip${id === view.focus ? ' focus' : ''}">${esc(personName(id))}</span>`).join('');
    return `<li class="task${t.done ? ' done' : ''}">
      <label class="task-check"><input type="checkbox" data-task-done="${esc(t.id)}" ${t.done ? 'checked' : ''} ${admin ? '' : 'disabled'} aria-label="${esc(t.title)}: done"></label>
      <${admin ? `button class="task-main" data-action="edit-task" data-id="${esc(t.id)}"` : 'div class="task-main"'}>
        <span class="task-title">${esc(t.title)}</span>
        ${t.notes ? `<span class="task-notes">${esc(t.notes)}</span>` : ''}
        <span class="cell">${who || (t.done ? '' : '<span class="need">Unassigned</span>')}</span>
      </${admin ? 'button' : 'div'}></li>`;
  };
  const cards = weeks.map(w => {
    const d = dayParts(w.end);
    const series = seriesById(state.services.find(s => s.date === w.end)?.sermon?.seriesId);
    const current = w.start <= today && today <= w.end;
    return `<section class="week${current ? ' current' : ''}" aria-label="Week ending ${esc(short(w.end))}">
      <header class="week-head">
        <span class="date-block"><span class="day-num">${d.num}</span><span class="day-dow">${esc(d.dow)}</span></span>
        <span class="when-meta">
          <span class="meta">${esc(short(w.start))} – ${esc(short(w.end))}${current ? ' <span class="week-pill">This week</span>' : ''}</span>
          ${series ? `<span class="series-tag" style="--series:${esc(series.color)}">${esc(series.name)}</span>` : ''}
        </span>
        ${w.tasks.length ? `<span class="week-count muted small">${w.tasks.filter(t => t.done).length} of ${w.tasks.length}</span>` : ''}
        ${admin ? `<button class="btn small week-add" data-action="new-task" data-week="${esc(w.end)}">Add a task</button>` : ''}
      </header>
      ${w.tasks.length ? `<ul class="task-list">${w.tasks.map(row).join('')}</ul>` : '<p class="week-empty muted">Nothing planned yet.</p>'}
    </section>`;
  }).join('');
  return `<div class="toolbar"><span class="muted">${esc(summary)}</span>${phoneWidth.matches ? '' : highlightField()}</div>
    <div class="week-grid">${cards}</div>
    <p class="hint">Each week runs up to its ${esc(M.WEEKDAYS[Number(day) || 0])}.${admin ? ' Select a task to change it or assign people.' : ''}</p>`;
}

function ministerFilters() {
  const options = state.roles.map(r => `<option value="${esc(r.id)}" ${r.id === view.roleFilter ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  return `<div class="filters">
    <label class="search-field"><span class="label-text">Search</span>
      <span class="search-box">${ICONS.search}<input id="minister-search" type="search" value="${esc(view.search)}" placeholder="${phoneWidth.matches ? 'Search name or role' : 'Name'}" autocomplete="off"></span></label>
    <label class="role-filter"><span class="label-text">Role</span>
      <select id="minister-role"><option value="">${phoneWidth.matches ? 'All' : 'All roles'}</option>${options}</select></label>
  </div>`;
}

// Filters by hiding rows, so typing in the search box never redraws it.
function applyMinisterFilter() {
  const q = view.search.trim().toLowerCase();
  const rows = $$('.person');
  let shown = 0;
  for (const row of rows) {
    const match = row.dataset.search.includes(q) && (!view.roleFilter || row.dataset.roles.split(' ').includes(view.roleFilter));
    row.hidden = !match;
    if (match) shown++;
  }
  const count = $('.list-count');
  if (count) count.textContent = shown === rows.length ? `Showing all ${rows.length}, sorted by role` : `Showing ${shown} of ${rows.length}`;
  const none = $('.no-match');
  if (none) none.hidden = shown > 0;
}

function renderMinisters() {
  const order = new Map(state.roles.map((r, i) => [r.id, i]));
  const rank = p => Math.min(state.roles.length, ...p.roleIds.map(id => order.get(id) ?? state.roles.length));
  const people = state.people.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (!people.length) return emptyState('No ministers yet', 'Add the people who serve, and the roles each one can do.');
  const today = M.todayISO();
  const { y, m } = M.parseISO(today);
  const rows = people.map(p => {
    const month = M.ministerMonth(state.services, p.id, y, m);
    const next = M.personSchedule(state, p.id, today)[0];
    const ranges = M.awayRanges(p.unavailable, today);
    const away = ranges.length ? `${M.formatRange(ranges[0])}${ranges.length > 1 ? ` +${ranges.length - 1}` : ''}` : '';
    const roles = state.roles.filter(r => M.canServe(p, r.id)).map(r => r.name);
    const linked = Boolean(p.userId || M.personEmail(p));
    const admin = canManage();
    return `<${admin ? `button class="person" data-action="edit-person" data-id="${esc(p.id)}"` : 'div class="person"'} data-search="${esc(`${p.name} ${roles.join(' ')}`.toLowerCase())}" data-roles="${esc(p.roleIds.join(' '))}">
      <span class="person-id">${avatar(p.name, photoOf(p))}<span class="person-text">
        <span class="person-name">${esc(p.name)}</span>
        ${isCloud() ? `<span class="person-link${linked ? ' on' : ''}">${linked ? 'Linked' : 'No sign-in'}</span>` : ''}
        <span class="person-sub">${esc(roles.join(' · ') || 'No roles yet')}</span>
        ${away ? `<span class="away-note">Away ${esc(away)}</span>` : ''}
      </span></span>
      <span class="person-roles">${roles.map(r => `<span class="role-pill">${esc(r)}</span>`).join('') || '<span class="muted">No roles yet</span>'}</span>
      <span class="person-away${away ? ' on' : ''}">${esc(away || 'None set')}</span>
      <span class="person-load" title="Services in ${esc(M.MONTHS[m - 1])}"><span class="dots${month.busy ? ' busy' : ''}" aria-hidden="true">${month.dots.map(on => `<i class="${on ? 'on' : ''}"></i>`).join('')}</span>
        <span>${month.total ? `${month.load} of ${plural(month.total, 'service')}${month.busy ? ' · busy' : ''}` : 'No services'}</span></span>
      <span class="person-next" title="${esc(next ? next.roles.map(r => r.name).join(', ') : '')}">${next ? esc(M.formatDate(next.service.date, { day: 'numeric', month: 'short' })) : '<span class="muted">None</span>'}</span>
      ${admin ? `<span class="icon-btn" aria-hidden="true">${ICONS.pencil}</span>` : '<span></span>'}
    </${admin ? 'button' : 'div'}>`;
  }).join('');
  return `${phoneWidth.matches ? '<p class="list-count"></p>' : ministerFilters()}
    <div class="directory"><div class="directory-head" aria-hidden="true"><span>Name</span><span>Roles</span><span>Away</span><span>This month</span><span>Next on</span><span></span></div>${rows}<p class="no-match" hidden>Nobody matches that search.</p></div>`;
}

function renderSeries() {
  if (!state.series.length) return emptyState('No sermon series yet', 'Create a series, give it dates and a colour, and the Preaching tab will show it.');
  const today = M.todayISO();
  const statuses = M.seriesStatuses(state, today);
  const rank = { current: 0, next: 1, planned: 2, draft: 2, past: 3 };
  const list = state.series.slice().sort((a, b) => rank[statuses.get(a.id)] - rank[statuses.get(b.id)]
    || (statuses.get(a.id) === 'past' ? (b.start || '').localeCompare(a.start || '') : (a.start || '9').localeCompare(b.start || '9')));
  const line = M.seriesTimeline(state.series, today);
  const timeline = phoneWidth.matches || !line.rows.length ? '' : `<section class="timeline" aria-label="Series timeline">
      <h2 class="panel-label">Timeline</h2>
      <div class="tl-heads">${line.heads.map(h => `<span style="left:${h.left.toFixed(2)}%">${esc(h.label)}</span>`).join('')}</div>
      <div class="tl-rows">
        ${line.rows.map(r => {
          const draft = statuses.get(r.series.id) === 'draft';
          const tag = canManage() ? `button data-action="edit-series" data-id="${esc(r.series.id)}"` : 'div';
          return `<div class="tl-row"><${tag} class="tl-bar${draft ? ' draft' : ''}" style="left:${r.left.toFixed(2)}%;width:${r.width.toFixed(2)}%;--series:${esc(r.series.color)}">${esc(r.series.name)}${draft ? ' · draft' : ''}</${canManage() ? 'button' : 'div'}></div>`;
        }).join('')}
        <div class="tl-today" style="left:${line.today.toFixed(2)}%"><span>Today</span></div>
      </div>
    </section>`;
  const cards = list.map(s => {
    const count = state.services.filter(x => x.sermon?.seriesId === s.id).length;
    const status = statuses.get(s.id);
    return `<article class="series-card${status === 'past' ? ' past' : ''}" style="--series:${esc(s.color)}">
      <div class="series-top"><span class="badge">${M.SERIES_STATUS[status]}</span><span>${plural(count, 'part')}</span></div>
      <h2>${esc(s.name)}</h2>
      <p class="series-range">${s.start && s.end ? esc(dateRange(s.start, s.end)) : 'No dates set'}</p>
      ${s.description ? `<p class="series-desc">${esc(s.description)}</p>` : ''}
      <footer class="series-foot"><span>${plural(count, 'service')} linked</span>${canManage() ? `<button class="btn" data-action="edit-series" data-id="${esc(s.id)}">Edit</button>` : ''}</footer>
    </article>`;
  }).join('');
  return `${timeline}<section class="series-grid" aria-label="All series">${cards}</section>`;
}

const roleRow = (r, isNew = false) => `<div class="role-row" data-role="${esc(r.id)}"${isNew ? ' data-new="1"' : ''}>
    <button type="button" class="drag-handle" aria-label="Move ${esc(r.name)}. Drag, or use the arrow keys.">${ICONS.grip}</button>
    <input name="role-name" value="${esc(r.name)}" aria-label="Role name" required maxlength="40">
    <label class="inline-field"><span class="label-text">People</span> <input name="role-slots" type="number" min="1" max="12" value="${Number(r.slots) || 1}" aria-label="People needed for ${esc(r.name)}"></label>
    ${r.id === M.PREACHER_ROLE ? '<span class="role-lock" title="Used by Preaching"></span>' : `<button type="button" class="role-remove" data-action="delete-role" data-id="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">${ICONS.close}</button>`}
  </div>`;

function renderSettings() {
  const s = state.settings;
  const days = M.WEEKDAYS.map((d, i) => `<option value="${i}" ${Number(s.defaultDay) === i ? 'selected' : ''}>${d}</option>`).join('');
  const theme = currentTheme();
  const themeCard = (v, label) => `<button type="button" class="theme-card" data-action="theme" data-value="${v}" aria-pressed="${theme === v}"><span class="swatch ${v}"></span>${label}</button>`;
  const themePanel = `<section class="panel">
      <h2>Theme</h2>
      <div class="theme-grid" role="group" aria-label="Appearance">${themeCard('light', 'Light')}${themeCard('dark', 'Dark')}${themeCard('system', 'Match device')}</div>
    </section>`;
  if (!canManage()) return `<div class="settings">${themePanel}</div>`;
  return `<div class="settings">
    <form class="panel" id="settings-form">
      <h2>Church</h2>
      <div class="row2">
        <label>Church name <input name="churchName" value="${esc(s.churchName)}" required maxlength="80"></label>
        <label>Service name <input name="serviceName" value="${esc(s.serviceName)}" maxlength="60"></label>
      </div>
      <div class="row2">
        <label>Usual service day <select name="defaultDay">${days}</select></label>
        <label>Usual service time <input name="defaultTime" type="time" value="${esc(s.defaultTime)}"></label>
      </div>
    </form>
    <form class="panel" id="roles-form">
      <div class="panel-head"><h2>Roles</h2><p class="muted">These become the columns on the Schedule. Drag to reorder. "People" is how many each service needs.</p></div>
      <div id="role-rows" class="row-list">${state.roles.map(r => roleRow(r)).join('')}</div>
      <div class="add-role">
        <label>Add a role <input id="new-role" placeholder="e.g. Communion" maxlength="40" autocomplete="off"></label>
        <button type="button" class="btn" data-action="add-role">Add role</button>
      </div>
    </form>
    ${themePanel}
    <section class="panel split">
      <div><h2>Backup</h2>
        <p>${isCloud()
          ? 'Synced online: everyone in this church sees the same schedule. A backup file is still worth exporting now and then.'
          : 'Everything is stored in this browser only. Export a backup file regularly, and import it to move to another computer. To share with your team, use the sync button.'}</p></div>
      <div class="row-actions">
        <label class="btn">Import backup<input type="file" accept="application/json,.json" id="import-file" hidden></label>
        <button type="button" class="btn primary" data-action="export">Export backup</button>
      </div>
    </section>
    <section class="panel split">
      <div><h2>Start over</h2><p>Try the app with a sample church, or clear everything out.</p></div>
      <div class="row-actions">
        <button type="button" class="btn" data-action="load-sample">Load sample data</button>
        <button type="button" class="btn danger" data-action="clear-all">Clear everything</button>
      </div>
    </section>
  </div>`;
}

// ---------- dialogs ----------

const dialog = () => $('#modal');

function openDialog(html, { onSubmit, onMount, wide = false, className = '' } = {}) {
  const d = dialog();
  d.className = `${wide ? 'wide ' : ''}${className}`.trim();
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

// Open a follow-up sheet once this one has closed. If it already closed (Esc during a slow
// save), wait a tick so the form's own close() runs first.
function whenClosed(fn) {
  if (dialog().open) dialog().addEventListener('close', fn, { once: true });
  else setTimeout(fn, 0);
}

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

function keySelect(value) {
  const keys = !value || M.SONG_KEYS.includes(value) ? M.SONG_KEYS : [value, ...M.SONG_KEYS];
  return `<select name="song-key" aria-label="Key"><option value="">Key</option>${keys.map(k => `<option ${k === value ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>`;
}

const songRow = (song = { title: '', key: '' }) => `<li class="song-row">
  <input name="song-title" value="${esc(song.title)}" list="song-library" maxlength="120" placeholder="Song title" aria-label="Song title" autocomplete="off">
  ${keySelect(song.key)}
  <button type="button" class="icon-btn small" data-song="up" aria-label="Move up"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button>
  <button type="button" class="icon-btn small" data-song="remove" aria-label="Remove song">&times;</button></li>`;

const MAX_SONGS = 30; // normalizeState keeps this many

function addSong(list) {
  if ($$('.song-row', list).length >= MAX_SONGS) { toast(`A setlist holds up to ${MAX_SONGS} songs.`, 'warn'); return; }
  list.insertAdjacentHTML('beforeend', songRow());
  $('.song-row:last-child [name="song-title"]', list).focus();
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
    <div class="when-fields">
      <label>Date <input name="date" type="date" value="${esc(svc.date)}" required></label>
      <label>Time <input name="time" type="time" value="${esc(svc.time)}"></label>
      <label>Service <input name="name" value="${esc(svc.name)}" maxlength="60"></label>
    </div>
    <section class="sheet-section" aria-label="Sermon">
      <h3>Sermon</h3>
      <label>Title <input name="sermon-title" value="${esc(svc.sermon.title)}" maxlength="120" placeholder="e.g. Rooted in Christ"></label>
      <div class="row2">
        <label>Scripture <input name="sermon-scripture" value="${esc(svc.sermon.scripture)}" maxlength="120" placeholder="e.g. Colossians 1:15-20"></label>
        <label>Series <select name="sermon-series"><option value="">No series</option>${series}</select></label>
      </div>
    </section>
    <section class="sheet-section" aria-label="Who is serving">
      <header class="sheet-section-head"><h3>Who is serving</h3><button type="button" class="link-btn" data-local="autofill">Auto-fill open slots</button></header>
      <div class="roles">${roles}</div>
      <div class="conflicts" aria-live="polite"></div>
    </section>
    <section class="sheet-section" aria-label="Setlist">
      <header class="sheet-section-head"><h3>Setlist</h3><button type="button" class="link-btn" data-song="add">Add a song</button></header>
      <ol class="setlist">${(svc.setlist || []).map(songRow).join('')}</ol>
      <datalist id="song-library">${M.songLibrary(state.services).map(s => `<option value="${esc(s.title)}">${s.key ? `Key of ${esc(s.key)}` : ''}</option>`).join('')}</datalist>
    </section>
    <section class="sheet-section"><label>Notes <textarea name="notes" rows="2" maxlength="500">${esc(svc.notes)}</textarea></label></section>`;
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
    setlist: $$('.song-row', form)
      .map(row => ({ title: $('[name="song-title"]', row).value.trim(), key: $('[name="song-key"]', row).value }))
      .filter(song => song.title),
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
    <span class="spacer"></span>
    <button class="btn" value="cancel" formnovalidate>Cancel</button>
    <button class="btn primary" value="save">Save</button>
  </footer>`;
  openDialog(dialogHead(title, isNew ? '' : [svc.time, svc.name].filter(Boolean).join(' · ')) + `<div class="dialog-body service-form">${serviceFormBody(svc)}</div>` + actions, {
    wide: true,
    onMount(form) {
      const refresh = () => showConflicts(form, readServiceForm(form, svc));
      refresh();
      form.addEventListener('change', e => {
        // A song sung before brings back the key it was last sung in.
        if (e.target.name === 'song-title') {
          const key = $('[name="song-key"]', e.target.closest('.song-row'));
          const known = M.songLibrary(state.services).find(s => s.title.toLowerCase() === e.target.value.trim().toLowerCase());
          if (known?.key && !key.value) key.value = known.key;
          return;
        }
        if (e.target.name === 'date' && e.target.value && !form.elements['sermon-series'].value) {
          const cover = M.seriesCoveringDate(state.series, e.target.value);
          if (cover) form.elements['sermon-series'].value = cover.id;
        }
        refresh();
      });
      // Enter in a song title moves to the next song (adding one at the end) instead of saving.
      form.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.target.name !== 'song-title' || e.isComposing) return;
        e.preventDefault();
        const next = e.target.closest('.song-row').nextElementSibling;
        if (next) $('[name="song-title"]', next).focus();
        else if (e.target.value.trim()) addSong($('.setlist', form));
      });
      form.addEventListener('click', e => {
        if (e.target.closest('[data-local="autofill"]')) return autofill();
        const btn = e.target.closest('[data-song]');
        if (!btn) return;
        const list = $('.setlist', form);
        const row = btn.closest('.song-row');
        if (btn.dataset.song === 'add') {
          addSong(list);
        } else if (btn.dataset.song === 'up' && row.previousElementSibling) {
          row.previousElementSibling.before(row);
          // At the top the up button hides, so keep focus on the row's title instead.
          $(row.previousElementSibling ? '[data-song="up"]' : '[name="song-title"]', row).focus();
        } else if (btn.dataset.song === 'remove') {
          row.remove();
        }
      });
      // Delegated above: this button is redrawn along with the rest of the sheet.
      const autofill = () => {
        const current = readServiceForm(form, svc);
        if (!current.date) { form.elements.date.reportValidity(); return; }
        svc = M.autoFill(state, current);
        $('.dialog-body', form).innerHTML = serviceFormBody(svc);
        refresh();
        toast('Open slots filled with available people who have served least this month.');
      };
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
      view.day = next.id;
      toast('Service saved.');
      // Offer to message whoever was just put on it.
      afterAssigning(isNew ? null : existing, next, true);
      return false;
    },
  });
}

// ----- a preacher's own sermon -----

function openSermonEditor(svc) {
  const series = state.series.slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''))
    .map(s => `<option value="${esc(s.id)}" ${s.id === svc.sermon.seriesId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  openDialog(dialogHead('Your sermon', M.formatDate(svc.date, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '')) + `<div class="dialog-body">
      <label>Title <input name="sermon-title" value="${esc(svc.sermon.title)}" maxlength="120" placeholder="e.g. Rooted in Christ"></label>
      <label>Scripture <input name="sermon-scripture" value="${esc(svc.sermon.scripture)}" maxlength="120" placeholder="e.g. Colossians 1:15-20"></label>
      <label>Series <select name="sermon-series"><option value="">No series</option>${series}</select></label>
    </div>
    <footer class="dialog-actions">
      <span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">Save</button>
    </footer>`, {
    async onSubmit(form) {
      await patchDoc('services', svc.id, { sermon: {
        title: form.elements['sermon-title'].value.trim(),
        scripture: form.elements['sermon-scripture'].value.trim(),
        seriesId: form.elements['sermon-series'].value,
      } });
      toast('Sermon saved.');
      return false;
    },
  });
}

// ----- assign one place on one service -----

function openAssign(serviceId, roleId, slot) {
  const svc = state.services.find(s => s.id === serviceId);
  const role = state.roles.find(r => r.id === roleId);
  if (!svc || !role) return;
  const { current, available, unavailable } = M.assignOptions(state, svc, roleId, slot);
  const weekdayName = M.formatDate(svc.date, { weekday: 'long' });
  const when = M.formatDate(svc.date, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  const row = ({ person, note }) => `<label class="pick" data-search="${esc(person.name.toLowerCase())}">
      <input type="radio" name="minister" value="${esc(person.id)}" ${person.id === current ? 'checked' : ''}>
      ${avatar(person.name, photoOf(person))}
      <span class="pick-text"><span class="pick-name">${esc(person.name)}</span><span class="pick-note">${esc(note)}</span></span></label>`;
  const off = ({ person, note }) => `<div class="pick off" data-search="${esc(person.name.toLowerCase())}">
      ${avatar(person.name, photoOf(person))}
      <span class="pick-text"><span class="pick-name">${esc(person.name)}</span><span class="pick-note">${esc(note)}</span></span></div>`;
  const head = `<header class="dialog-head back-head">
      <button type="button" class="icon-btn" onclick="this.closest('dialog').close()" aria-label="Back">${ICONS.back}</button>
      <div><h2>Assign ${esc(role.name.toLowerCase())}</h2><p class="muted">${esc(when)} · ${esc(M.roleGroups([role])[0].name)}</p></div>
    </header>
    <div class="assign-find"><label>Search ministers
      <span class="search-box">${ICONS.search}<input id="assign-search" type="search" placeholder="Name" autocomplete="off"></span></label></div>`;
  const body = `<div class="dialog-body">
      ${available.length ? `<section><h3 class="pick-title">Available · ${esc(role.name.toLowerCase())}</h3><div class="pick-list">${available.map(row).join('')}</div></section>`
        : '<p class="hint">Nobody is free for this role. Tick it on a profile under Ministers, or open the service to pick anyone.</p>'}
      ${unavailable.length ? `<section><h3 class="pick-title">Unavailable this ${esc(weekdayName)}</h3><div class="pick-list">${unavailable.map(off).join('')}</div></section>` : ''}
      <label class="check-row"><input type="checkbox" name="notify" checked>Let them know after saving</label>
    </div>`;
  const footer = `<footer class="dialog-actions">
      ${current ? '<button class="btn danger big-btn" style="flex:0 0 auto" value="delete" formnovalidate>Remove</button>' : ''}
      <button class="btn primary big-btn assign-go" value="save" disabled>Choose someone</button>
    </footer>`;
  openDialog(head + body + footer, {
    className: 'assign-sheet',
    onMount(form) {
      const go = $('.assign-go', form);
      const chosen = () => $('input[name="minister"]:checked', form)?.value || '';
      const refresh = () => {
        const id = chosen();
        go.disabled = !id || id === current;
        go.textContent = id && id !== current ? `Assign ${personName(id)}` : current ? 'Choose someone else' : 'Choose someone';
      };
      refresh();
      form.addEventListener('change', refresh);
      const find = $('#assign-search', form);
      find.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
      find.addEventListener('input', () => {
        const q = find.value.trim().toLowerCase();
        for (const el of $$('.pick', form)) el.hidden = !el.dataset.search.includes(q);
        for (const list of $$('.pick-list', form)) list.closest('section').hidden = !$$('.pick:not([hidden])', list).length;
      });
    },
    async onSubmit(form, action) {
      const id = $('input[name="minister"]:checked', form)?.value || '';
      if (action !== 'delete' && (!id || id === current)) return true;
      const fresh = state.services.find(s => s.id === serviceId);
      if (!fresh) return false;
      const list = [...M.assigned(fresh, roleId)];
      if (action === 'delete') list.splice(slot, 1);
      else list[slot] = id;
      const assignments = { ...fresh.assignments, [roleId]: list.filter(Boolean) };
      if (!assignments[roleId].length) delete assignments[roleId];
      const next = { ...fresh, assignments };
      await putDoc('services', next);
      toast(action === 'delete' ? `${personName(current)} removed.` : `${personName(id)} assigned.`);
      if (action !== 'delete') afterAssigning(fresh, next, form.elements.notify.checked);
      return false;
    },
  });
}

// Putting yourself on a service shouldn't also pop up "You're on…" over the save message.
function afterAssigning(before, next, offerMessage) {
  const added = M.addedAssignments(before, next);
  const self = me();
  if (self && added.has(self.id)) added.get(self.id).forEach(r => mine.announced.add(M.assignmentKey(next, r)));
  if (offerMessage && added.size) whenClosed(() => openNotify(next, added));
}

// ----- person editor -----

function openPersonEditor(existing) {
  const isNew = !existing;
  const person = existing ? structuredClone(existing) : { id: M.uid('p_'), name: '', contact: '', email: '', roleIds: [], unavailable: [] };
  // Older profiles kept an email in "Phone or email": show it in the Email box instead.
  if (!person.email && M.isEmail(person.contact)) { person.email = M.normEmail(person.contact); person.contact = ''; }
  const roles = state.roles.map(r => `<label class="check"><input type="checkbox" name="roles" value="${esc(r.id)}" ${M.canServe(person, r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('');
  const upcoming = isNew ? [] : M.personSchedule(state, person.id, M.todayISO()).slice(0, 8);
  const schedule = upcoming.length
    ? `<ul class="mini-list">${upcoming.map(x => `<li><span>${esc(M.formatDate(x.service.date))}</span> ${esc(x.roles.map(r => r.name).join(', '))}</li>`).join('')}</ul>`
    : '<p class="muted">Not on any upcoming service.</p>';
  const awayList = () => person.unavailable.slice().sort().map(d => `<li><span>${esc(M.formatDate(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span>
    <button type="button" class="icon-btn small" data-remove-date="${esc(d)}" aria-label="Remove ${esc(d)}">&times;</button></li>`).join('') || '<li class="muted">None</li>';
  // How this minister signs in. With no email yet, three ways forward: send an invite,
  // pick someone already registered in this church, or leave it blank.
  let linkMode = 'blank';
  let draftEmail = person.email;
  const memberChoices = () => {
    const taken = new Set(state.people.filter(p => p.id !== person.id && p.userId).map(p => p.userId));
    return Object.entries(cloudState.info?.memberNames || {}).filter(([uid]) => !taken.has(uid)).sort((a, b) => a[1].localeCompare(b[1]));
  };
  const emailBox = (label, hint) => `<label>${label} <input name="email" type="email" value="${esc(draftEmail)}" maxlength="120" autocomplete="off" inputmode="email"></label>
    <p class="hint">${hint}</p>`;
  const signInHtml = () => {
    if (person.userId && !person.email) {
      const name = cloudState.info?.memberNames?.[person.userId] || 'a registered user';
      return `<div class="linked-row"><span>Linked to <strong>${esc(name)}</strong></span><button type="button" class="link-btn" data-link="unlink">Unlink</button></div>`;
    }
    if (!isCloud()) return emailBox('Email', 'Put your church online (the sync button) to invite people or link them to an account.');
    if (person.email) return emailBox('Email', 'When they sign in with this email, the app shows them every service they\'re put on.');
    const seg = (mode, label) => `<button type="button" class="seg${linkMode === mode ? ' on' : ''}" data-link-mode="${mode}" aria-pressed="${linkMode === mode}">${label}</button>`;
    const members = memberChoices();
    const detail = {
      invite: emailBox('Their email (optional)', 'After you save, you can send them their invite link. Opening it links their account to this minister.'),
      member: members.length
        ? `<label>Registered user <select name="member" required><option value="">Choose someone</option>${members.map(([uid, name]) => `<option value="${esc(uid)}">${esc(name)}</option>`).join('')}</select></label>`
        : '<p class="hint">Everyone registered in this church is already linked. Send an invite instead.</p>',
      blank: '<p class="hint">They stay on the roster without a sign-in. You can link them any time.</p>',
    }[linkMode];
    return `<div class="segmented link-choice" role="group" aria-label="How this minister signs in">${seg('invite', 'Send an invite')}${seg('member', 'Registered user')}${seg('blank', 'Leave blank')}</div>${detail}`;
  };
  openDialog(dialogHead(isNew ? 'New minister' : person.name) + `<div class="dialog-body">
      <div class="row2">
        <label>Name <input name="name" value="${esc(person.name)}" required maxlength="60" autocomplete="off"></label>
        <label>Phone <input name="contact" type="tel" value="${esc(person.contact)}" maxlength="40" autocomplete="off" inputmode="tel"></label>
      </div>
      <fieldset><legend>Sign-in</legend><div class="signin-slot">${signInHtml()}</div></fieldset>
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
      const redrawSignIn = () => {
        draftEmail = form.elements.email?.value ?? draftEmail;
        $('.signin-slot', form).innerHTML = signInHtml();
      };
      form.addEventListener('input', e => { if (e.target.name === 'email') e.target.setCustomValidity(''); });
      form.addEventListener('click', e => {
        const mode = e.target.closest('[data-link-mode]')?.dataset.linkMode;
        if (mode) { linkMode = mode; redrawSignIn(); }
        if (e.target.closest('[data-link="unlink"]')) { person.userId = ''; redrawSignIn(); }
      });
      // Someone may have joined since the church opened: list the current members.
      if (isCloud()) {
        import('./cloud.js').then(C => C.churchInfo(cloudState.churchId)).then(fresh => {
          if (!fresh) return;
          cloudState.info = fresh;
          // Only the member list needs the fresh names; never redraw under someone's finger.
          if (form.isConnected && linkMode === 'member' && !form.elements.member?.value && !$('.signin-slot', form).contains(document.activeElement)) redrawSignIn();
        }).catch(() => {});
      }
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
        if (!confirm(`Delete ${person.name}? They will be removed from every service and task.`)) return true;
        const before = state.services;
        const after = M.removePersonEverywhere(before, person.id);
        await putChanged('services', before, after);
        state.services = after;
        const tasks = M.removePersonFromTasks(state.tasks, person.id);
        await putChanged('tasks', state.tasks, tasks);
        state.tasks = tasks;
        await deleteDoc('people', person.id);
        if (view.focus === person.id) view.focus = '';
        toast('Minister deleted.');
        return false;
      }
      const email = M.normEmail(form.elements.email?.value ?? person.email);
      const twin = email && state.people.find(p => p.id !== person.id && M.personEmail(p) === email);
      if (twin) {
        form.elements.email.setCustomValidity(`${twin.name} already uses this email.`);
        form.elements.email.reportValidity();
        return true;
      }
      // a date typed but not "added" still counts
      const pending = form.elements.away.value;
      if (M.isValidISO(pending) && !person.unavailable.includes(pending)) person.unavailable.push(pending);
      // Clearing the email box also clears the link it made.
      const userId = form.elements.member ? form.elements.member.value : form.elements.email && !email ? '' : person.userId || '';
      const saved = {
        ...person,
        userId,
        name: form.elements.name.value.trim(),
        contact: form.elements.contact.value.trim(),
        email,
        roleIds: $$('input[name="roles"]:checked', form).map(i => i.value),
        unavailable: person.unavailable.slice().sort(),
      };
      await putDoc('people', saved);
      toast(isNew ? 'Minister added.' : 'Minister saved.');
      if (form.querySelector('[data-link-mode="invite"].on')) whenClosed(() => openInvite(saved));
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
        await putChanged('services', before, after);
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

// ----- task editor -----

function openTaskEditor(existing, week) {
  const isNew = !existing;
  const day = state.settings.defaultDay;
  const task = existing ? structuredClone(existing) : M.newTask({ week });
  task.week = M.weekOfDate(task.week, day);
  // The task's own month and the ones either side, so it can move without hunting for a date.
  const { y, m } = M.parseISO(task.week);
  const weekOptions = [-1, 0, 1].flatMap(delta => { const mo = M.shiftMonth(y, m, delta); return M.weeksInMonth(mo.y, mo.m, day); })
    .map(w => `<option value="${w.end}" ${w.end === task.week ? 'selected' : ''}>${esc(M.formatDate(w.end))}</option>`).join('');
  const people = state.people.slice().sort((a, b) => a.name.localeCompare(b.name));
  // Same hints as the role dropdowns: who is away that service day, and who already has a lot on.
  const checks = (picked, weekEnd) => people.map(p => {
    const others = M.tasksInWeek(state.tasks, weekEnd, day).filter(t => t.id !== task.id && t.assignees.includes(p.id)).length;
    const notes = [];
    if (M.isUnavailable(p, weekEnd)) notes.push(`away ${M.formatDate(weekEnd, { weekday: 'short' })}`);
    if (others) notes.push(`${others} this week`);
    return `<label class="check"><input type="checkbox" name="assignees" value="${esc(p.id)}" ${picked.includes(p.id) ? 'checked' : ''}> ${esc(p.name)}${notes.length ? ` <span class="muted small">(${esc(notes.join(', '))})</span>` : ''}</label>`;
  }).join('') || '<p class="hint">Add ministers on the Ministers tab, then assign them here.</p>';
  openDialog(dialogHead(isNew ? 'New task' : task.title) + `<div class="dialog-body">
      <label>Task <input name="title" value="${esc(task.title)}" required pattern=".*\\S.*" title="Give the task a name" maxlength="120" placeholder="e.g. Send the slides to Tech" autocomplete="off"></label>
      <label>Week ending <select name="week">${weekOptions}</select></label>
      <fieldset><legend>Assigned to</legend><div class="assignees">${checks(task.assignees, task.week)}</div></fieldset>
      <label>Notes <textarea name="notes" rows="2" maxlength="500">${esc(task.notes)}</textarea></label>
    </div>
    <footer class="dialog-actions">
      ${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Delete</button>'}
      <span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">Save</button>
    </footer>`, {
    onMount(form) {
      form.addEventListener('change', e => {
        if (e.target.name !== 'week') return;
        const picked = $$('input[name="assignees"]:checked', form).map(i => i.value);
        $('.assignees', form).innerHTML = checks(picked, e.target.value);
      });
    },
    async onSubmit(form, action) {
      if (action === 'delete') {
        if (!confirm(`Delete the task "${task.title}"?`)) return true;
        await deleteDoc('tasks', task.id);
        toast('Task deleted.');
        return false;
      }
      // Left on the same week, the stored date stays as it was, so the bell doesn't call an edit new.
      const week = form.elements.week.value;
      const next = {
        ...task,
        title: form.elements.title.value.trim(),
        week: existing && week === task.week ? existing.week : week,
        assignees: $$('input[name="assignees"]:checked', form).map(i => i.value),
        notes: form.elements.notes.value.trim(),
      };
      const added = M.addedTaskPeople(isNew ? null : task, { ...next, week });
      await putDoc('tasks', next);
      ({ y: view.y, m: view.m } = M.parseISO(week));
      toast(isNew ? 'Task added.' : 'Task saved.');
      // Giving yourself a task shouldn't also pop up "You have a task" over "Task saved."
      const self = me();
      if (self && added.includes(self.id)) mine.announced.add(M.taskKey(next));
      if (added.length) whenClosed(() => openTaskNotify(next, added));
      return false;
    },
  });
}

async function setTaskDone(id, done) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  await putDoc('tasks', { ...task, done });
  render();
  $(`[data-task-done="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); // the redraw replaced the box just ticked
}

// ---------- settings actions ----------

function saveChurch(form) {
  const f = form.elements;
  const churchName = f.churchName.value.trim() || state.settings.churchName;
  f.churchName.value = churchName;
  state.settings = { ...state.settings, churchName, defaultDay: Number(f.defaultDay.value), defaultTime: f.defaultTime.value, serviceName: f.serviceName.value.trim() || 'Service' };
  $('#church-name').textContent = churchName;
  document.title = `${churchName} · Ministry Scheduler`;
  Promise.resolve(store.putSettings(state.settings)).then(ok => { afterWrite(ok); toast('Saved.'); })
    .catch(err => toast(`Not saved: ${err.message || err}`, 'warn'));
}

let rolesSaving = Promise.resolve();
const removedRoles = new Set();

// Saves in order, so a quick rename then a drag can't land the wrong way round.
function saveRoles() {
  rolesSaving = rolesSaving.then(writeRoles).catch(err => toast(`Not saved: ${err.message || err}`, 'warn'));
  return rolesSaving;
}

// Writes only the role documents that changed.
async function writeRoles() {
  const rows = $$('#role-rows .role-row');
  const roles = rows.map((row, order) => ({
    id: row.dataset.role,
    order,
    name: $('[name="role-name"]', row).value.trim(),
    slots: Math.min(12, Math.max(1, parseInt($('[name="role-slots"]', row).value, 10) || 1)),
  }));
  // These rows can be a moment behind another editor, so a role only counts as gone when it was
  // removed here, and only a row added here can create one.
  const gone = new Set(removedRoles);
  removedRoles.clear();
  const isGone = id => gone.has(id);
  const was = new Map(state.roles.map(r => [r.id, r]));
  if (gone.size) {
    let services = state.services;
    for (const id of gone) services = M.removeRoleEverywhere(services, id);
    await putChanged('services', state.services, services);
    state.services = services;
    const people = state.people.map(p => (p.roleIds.some(isGone) ? { ...p, roleIds: p.roleIds.filter(r => !isGone(r)) } : p));
    await putChanged('people', state.people, people);
    state.people = people;
    for (const id of gone) await deleteDoc('roles', id);
  }
  for (const [i, r] of roles.entries()) {
    const old = was.get(r.id);
    if (!r.name || (!old && !rows[i].dataset.new)) continue; // a blank name waits until it has one
    delete rows[i].dataset.new;
    if (!old || old.name !== r.name || old.slots !== r.slots || old.order !== r.order) await putDoc('roles', r);
  }
  state.roles = state.roles.filter(r => !isGone(r.id)).sort((a, b) => a.order - b.order);
  toast('Saved.');
}

function addRole() {
  const input = $('#new-role');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  $('#role-rows').insertAdjacentHTML('beforeend', roleRow({ id: M.uid('role_'), name, slots: 1 }, true));
  input.value = '';
  input.focus();
  saveRoles();
}

// Drag a role by its handle. Works with a mouse or a finger; the arrow keys do the same.
function wireRoleDrag() {
  document.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button) return;
    e.preventDefault();
    const row = handle.closest('.role-row');
    const list = row.parentElement;
    const before = row.nextElementSibling;
    row.classList.add('dragging');
    const move = ev => {
      const over = [...list.children].find(r => r !== row && ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
      if (!over) list.append(row);
      else if (row.nextElementSibling !== over) over.before(row);
    };
    const end = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      row.classList.remove('dragging');
      if (row.nextElementSibling !== before) saveRoles();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  });
  document.addEventListener('keydown', e => {
    const handle = e.target.closest?.('.drag-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const row = handle.closest('.role-row');
    const other = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!other) return;
    if (e.key === 'ArrowUp') other.before(row); else other.after(row);
    handle.focus();
    saveRoles();
  });
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
    if (!confirm(`Replace everything${isCloud() ? ' for everyone in this church' : ''} with this backup? (${next.services.length} services, ${next.tasks.length} tasks, ${next.people.length} ministers)`)) return;
    await replaceAll(next);
    toast('Backup imported.');
    render();
  } catch (err) {
    toast(`Could not import: ${err.message}`, 'warn');
  }
}

// ---------- cloud sync (Firebase) ----------

// What the account button and dialog show. `store` is LocalStore until you sign in
// to a church; then it is that church's FirebaseStore.
const cloudState = { ready: false, user: null, churchId: '', info: null, error: '', reopen: false };
const JOIN_KEY = 'ministry-scheduler:join';
const inviteLink = (id, personId = '') => `${location.origin}${location.pathname}#join=${id}${personId ? `&as=${personId}` : ''}`;
const isCloud = () => Boolean(cloudState.churchId);
// Only admins change a church's data; the rules enforce it, this just hides what they'd refuse.
// Signed out, it's your own browser's copy, so everything is yours to change.
const canManage = () => !isCloud() || (cloudState.info?.members || store.members)?.[cloudState.user?.uid] === 'admin';
// The first three preacher places, the same limit as firestore.rules.
const preachesOn = svc => Boolean(me()) && M.assigned(svc, M.PREACHER_ROLE).slice(0, 3).includes(me().id);
let loadSeq = 0;          // each store switch gets a number; a slower, older load is thrown away
let opening = '';         // church id being opened right now (auth can fire twice)
let removedNotice = false;

const session = {
  get: () => { try { return sessionStorage.getItem(JOIN_KEY) || ''; } catch { return ''; } },
  set: v => { try { sessionStorage.setItem(JOIN_KEY, v); } catch { /* private mode: invite kept in memory */ } session.mem = v; },
  clear: () => { try { sessionStorage.removeItem(JOIN_KEY); } catch { /* ignore */ } session.mem = ''; },
  mem: '',
};
const pendingInvite = () => session.get() || session.mem;

// Load first, switch second: a load that was overtaken (sign-out, another church) is discarded.
const isTyping = () => document.activeElement?.matches('.main input:not([type="checkbox"]):not([type="file"]), .main textarea, .main .drag-handle') ?? false;

async function useStore(next) {
  const seq = ++loadSeq;
  const loaded = await next.load();
  if (seq !== loadSeq) return false;
  unsubscribe();
  store = next;
  state = loaded;
  unsubscribe = store.subscribe(s => {
    state = s;
    if (store.members && cloudState.info) cloudState.info.members = store.members; // someone was made admin, live
    if (!dialog().open && !isTyping()) render();
  });
  render();
  return true;
}

async function useLocal() {
  cloudState.churchId = '';
  cloudState.info = null;
  resetMine();
  await useStore(localStore);
}

async function useChurch(churchId) {
  if (!churchId || churchId === cloudState.churchId || churchId === opening) return;
  opening = churchId;
  resetMine(); // the last church's "seen" list must not count against this one
  const C = await import('./cloud.js');
  try {
    if (await useStore(new C.FirebaseStore(churchId, { onError: cloudError }))) {
      cloudState.churchId = churchId;
      removedNotice = false;
      await loadSeen();
      cloudState.info = await C.churchInfo(churchId).catch(() => null);
    }
  } catch (err) {
    // Only a definite "you're not in this church" unlinks you; being offline must not.
    const gone = /permission-denied|not-found/.test(err.code || '');
    if (gone && cloudState.user) await C.leaveChurch(cloudState.user.uid).catch(() => {});
    toast(gone ? 'You are no longer in that church. Showing this browser\'s copy.' : `Could not open your church: ${err.message || err}`, 'warn');
  } finally {
    opening = '';
  }
  render();
}

async function cloudError(err, kind) {
  const denied = /permission-denied/.test(err.code || '');
  // A refused save only means this isn't yours to change. Being cut off from reading is what means you were removed.
  if (denied && kind === 'write') { toast('That wasn\'t saved: only an admin can change it.', 'warn'); return; }
  if (denied && isCloud()) {
    // Removed from the church while using it: drop back to this browser's copy, once.
    if (removedNotice) return;
    removedNotice = true;
    const C = await import('./cloud.js');
    if (cloudState.user) await C.leaveChurch(cloudState.user.uid).catch(() => {});
    await useLocal();
    toast('You are no longer a member of that church. Showing this browser\'s copy.', 'warn');
    return;
  }
  toast(`Not saved to the cloud: ${err.message || err}`, 'warn');
}

// The card at the foot of the menu: a headline, then what it means for you.
function accountLabel() {
  if (!cloudState.ready) return ['Saved in this browser', 'Export a backup from Settings before clearing your browser data.'];
  if (isCloud()) return ['Synced', state.settings.churchName];
  if (cloudState.user) return ['Signed in', 'This browser only. Tap to put your church online.'];
  return ['Saved in this browser', 'Sign in to sync with your team.'];
}

function renderAccountButton() {
  const btn = $('#account-btn');
  if (!btn) return;
  const [title, sub] = accountLabel();
  btn.querySelector('.account-text').textContent = title;
  btn.querySelector('.account-sub').textContent = sub;
  btn.setAttribute('aria-label', `Account and sync: ${title}. ${sub}`);
  btn.title = `${title}. ${sub}`;
  btn.dataset.state = isCloud() ? 'synced' : cloudState.user ? 'signed-in' : 'local';
}

async function initCloud() {
  const C = await import('./cloud.js');
  if (!C.cloudConfigured()) return;
  try {
    await C.onAuth(async user => {
      cloudState.user = user;
      cloudState.ready = true;
      if (!user) { if (isCloud()) await useLocal(); else loadSeq++; renderAccountButton(); return; }
      const current = await C.myChurchId(user.uid).catch(() => '');
      const invite = pendingInvite();
      if (invite) {
        session.clear();
        const joined = await acceptInvite(invite, current);
        if (joined) return;
      }
      if (current) await useChurch(current);
      renderAccountButton();
      // Just signed in from the dialog and not in a church yet: show the next step.
      if (cloudState.reopen) { cloudState.reopen = false; if (!isCloud() && !dialog().open) openAccount(); }
    });
  } catch (err) {
    cloudState.error = err.message || String(err);
  }
  renderAccountButton();
}

// An invite sent to one minister links that minister to whoever accepts it, unless they already
// have an account. Admins are skipped, so testing your own link doesn't make you that minister.
async function claimInvitedPerson(personId) {
  const { user } = cloudState;
  const person = state.people.find(p => p.id === personId);
  const already = M.findPersonForUser(state.people, user);
  if (!person || !user || !isCloud() || person.userId || (already && already.id !== person.id)) return;
  if (cloudState.info?.members?.[user.uid] === 'admin') return;
  try {
    await patchDoc('people', person.id, { userId: user.uid, email: person.email || M.normEmail(user.email) });
    render();
  } catch { toast('You joined, but your profile could not be linked. Ask an admin to link it.', 'warn'); }
}

// Returns true when you end up in the invited church.
async function acceptInvite(invite, currentId = cloudState.churchId) {
  const { churchId, personId } = M.parseInvite(invite);
  if (currentId === churchId) { await useChurch(churchId); await claimInvitedPerson(personId); return true; }
  if (currentId && !confirm('You are already in a church in this app. Leave it and join the one in this invite?')) return false;
  const C = await import('./cloud.js');
  try {
    await C.joinChurch(cloudState.user, churchId);
    cloudState.churchId = '';
    await useChurch(churchId);
    await claimInvitedPerson(personId);
    toast(`You joined ${state.settings.churchName}.`);
    return true;
  } catch (err) {
    toast(err.message || 'That invite link did not work.', 'warn');
    return false;
  }
}

// An invite link (#join=<churchId>) is kept until you have signed in.
function readInvite() {
  if (!location.hash.startsWith('#join=') || !M.parseInvite(location.hash)) return false;
  session.set(location.hash.slice('#join='.length));
  history.replaceState(null, '', location.pathname);
  return true;
}

// An invite opened in a tab that already has the app open.
async function onInviteHash() {
  if (!readInvite()) return false;
  if (!cloudState.ready) { toast('Cloud sync is not switched on here, so the invite cannot be used yet.', 'warn'); return true; }
  if (!cloudState.user) { openAccount(); return true; }
  const invite = pendingInvite();
  session.clear();
  await acceptInvite(invite);
  return true;
}

const isUntouchedSample = () => state.settings.churchName === 'Grace Community Church' && state.people.some(p => p.name === 'Pastor Jon');

function membersHtml(info) {
  const me = cloudState.user?.uid;
  if (!info) return '<li class="muted">Loading…</li>';
  const admin = info.members[me] === 'admin';
  return Object.entries(info.members).sort((a, b) => (a[1] === 'admin' ? -1 : 0) - (b[1] === 'admin' ? -1 : 0))
    .map(([uid, role]) => `<li>${avatar(info.memberNames[uid] || '?', info.memberPhotos?.[uid])}
      <span class="member-name">${esc(info.memberNames[uid] || 'Member')}${uid === me ? ' <span class="muted">(you)</span>' : ''}</span>
      <span class="member-role">${role === 'admin' ? 'Admin' : 'Member'}</span>
      ${admin && uid !== me && role !== 'admin' ? `<button type="button" class="btn small" data-promote-member="${esc(uid)}">Make admin</button>` : ''}
      ${admin && uid !== me ? `<button type="button" class="btn small danger" data-remove-member="${esc(uid)}">Remove</button>` : ''}</li>`).join('');
}

// A photo becomes a small square JPEG (a phone photo is megabytes; this is a few KB).
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // a transparent PNG would otherwise turn black
    ctx.fillRect(0, 0, 160, 160);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 160, 160);
    return canvas.toDataURL('image/jpeg', 0.75);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openAccount() {
  const { user } = cloudState;
  const myMinister = me();
  const profile = { photo: isCloud() ? photoOf(myMinister) || cloudState.info?.memberPhotos?.[user?.uid] || '' : '' };
  const profileName = myMinister?.name || cloudState.info?.memberNames?.[user?.uid] || user?.displayName || '';
  const profileAvatar = () => avatar(profileName || '?', profile.photo);
  const head = dialogHead(isCloud() ? state.settings.churchName : 'Sync across devices',
    user ? `Signed in as ${user.email || user.displayName}` : '');
  let body;
  let actions = '';
  if (!cloudState.ready) {
    body = `<p>${cloudState.error ? esc(cloudState.error) : 'Cloud sync is not switched on for this app yet.'} Your schedule is saved in this browser.</p>`;
  } else if (!user) {
    body = `
      <p class="lead">${pendingInvite() ? 'Sign in to accept your invite.' : 'Sign in so the pastor, worship leader and tech team all see and edit the same schedule, on any phone or computer.'}</p>
      <button type="submit" class="btn primary wide-btn" value="google">Continue with Google</button>
      ${location.hostname.endsWith('github.io') && /iPhone|iPad/.test(navigator.userAgent)
        ? '<p class="muted small">On iPhone, Google sign-in works best at <a href="https://ministry-sched-ph.web.app/">ministry-sched-ph.web.app</a>. Email sign-in works here too.</p>' : ''}
      <div class="or"><span>or use email</span></div>
      <label>Email <input name="email" type="email" autocomplete="email" inputmode="email"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" minlength="6"></label>
      <p class="form-error" aria-live="polite"></p>
      <div class="row-actions">
        <button type="submit" class="btn" value="signin">Sign in</button>
        <button type="submit" class="btn ghost" value="create">Create account</button>
        <button type="submit" class="btn ghost" value="reset">Forgot password</button>
      </div>`;
  } else if (!isCloud()) {
    const sample = isUntouchedSample();
    body = `
      <section class="choice">
        <h3>Start your church online</h3>
        <p class="muted">${sample
          ? 'This browser still holds the sample church. Start empty, or upload the sample to try things out.'
          : `Uploads what this browser has now (${state.services.length} services, ${state.tasks.length} tasks, ${state.people.length} ministers).`}
          You become the admin and can invite your team.</p>
        <div class="row-actions">
          <button type="submit" class="btn primary" value="${sample ? 'upload-empty' : 'upload'}">${sample ? 'Start empty' : 'Put it online'}</button>
          <button type="submit" class="btn ghost" value="${sample ? 'upload' : 'upload-empty'}">${sample ? 'Upload the sample' : 'Start empty instead'}</button>
        </div>
      </section>
      <section class="choice">
        <h3>Join a church</h3>
        <p class="muted">Paste the invite link someone sent you.</p>
        <input name="invite" placeholder="Invite link" autocomplete="off">
        <button type="submit" class="btn" value="join">Join</button>
      </section>
      <p class="form-error" aria-live="polite"></p>`;
    actions = '<button type="submit" class="btn ghost" value="signout">Sign out</button>';
  } else {
    const admin = cloudState.info?.members?.[user.uid] === 'admin';
    body = `
      <fieldset class="profile"><legend>Your profile</legend>
        <div class="profile-row">
          <span class="profile-avatar">${profileAvatar()}</span>
          <div class="profile-fields">
            <label>Your name <input name="profile-name" value="${esc(profileName)}" maxlength="60" autocomplete="name"></label>
            <div class="row-actions">
              <label class="btn small">Upload photo<input type="file" accept="image/*" id="profile-photo" hidden></label>
              <button type="button" class="btn small ghost" data-local="remove-photo" ${profile.photo ? '' : 'hidden'}>Remove</button>
              <span class="spacer"></span>
              <button type="submit" class="btn small primary" value="profile">Save profile</button>
            </div>
          </div>
        </div>
        ${myMinister ? `<p class="hint">Also updates ${esc(myMinister.name)} on the roster.</p>` : ''}
      </fieldset>
      <p class="lead">Every change is shared live with everyone in this church, and kept on this device for when you are offline.</p>
      <label>Invite link <span class="copy-row"><input id="invite-link" readonly value="${esc(inviteLink(cloudState.churchId))}"><button type="button" class="btn" data-local="copy-invite">Copy</button></span></label>
      <p class="muted small">Anyone with this link can join and see the schedule. Only admins can change it. Send it only to your ministry team. Someone you remove can't rejoin with it.</p>
      <fieldset><legend>Members</legend><ul class="members">${membersHtml(cloudState.info)}</ul></fieldset>
      <p class="form-error" aria-live="polite"></p>`;
    actions = `<button type="submit" class="btn ghost" value="signout">Sign out</button>
      ${admin ? '' : '<button type="submit" class="btn ghost danger" value="leave" formnovalidate>Leave church</button>'}`;
  }
  openDialog(head + `<div class="dialog-body account">${body}</div>
    <footer class="dialog-actions">${actions}<span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Close</button></footer>`, {
    onMount(form) {
      // Members change when someone joins: fetch the current list each time this opens.
      const refresh = () => import('./cloud.js').then(C => C.churchInfo(cloudState.churchId)).then(fresh => {
        if (!fresh) return;
        cloudState.info = fresh;
        const ul = $('.members', form);
        if (ul) ul.innerHTML = membersHtml(fresh);
      }).catch(() => {});
      if (isCloud()) refresh();
      const showPhoto = () => {
        $('.profile-avatar', form).innerHTML = profileAvatar();
        $('[data-local="remove-photo"]', form).hidden = !profile.photo;
      };
      $('#profile-photo', form)?.addEventListener('change', async e => {
        const [file] = e.target.files;
        e.target.value = ''; // so choosing the same picture again still counts
        if (!file) return;
        try {
          const photo = await shrinkPhoto(file);
          if (!M.isPhoto(photo)) throw new Error('too large');
          profile.photo = photo;
          showPhoto();
        } catch { toast('That picture could not be read. Try a JPEG or PNG.', 'warn'); }
      });
      form.addEventListener('click', e => {
        if (e.target.closest('[data-local="remove-photo"]')) { profile.photo = ''; showPhoto(); }
      });
      form.addEventListener('click', async e => {
        if (e.target.closest('[data-local="copy-invite"]')) {
          const input = $('#invite-link', form);
          try { await navigator.clipboard.writeText(input.value); toast('Invite link copied.'); } catch { input.select(); }
        }
        const names = cloudState.info?.memberNames || {};
        const remove = e.target.closest('[data-remove-member]')?.dataset.removeMember;
        const promote = e.target.closest('[data-promote-member]')?.dataset.promoteMember;
        if (!remove && !promote) return;
        const C = await import('./cloud.js');
        try {
          if (remove && confirm(`Remove ${names[remove] || 'this member'} from the church? They won't be able to rejoin with the invite link.`)) {
            await C.removeMember(cloudState.churchId, remove);
          } else if (promote && confirm(`Make ${names[promote] || 'this member'} an admin? Admins can change the schedule and add or remove members.`)) {
            await C.setRole(cloudState.churchId, promote, 'admin');
          } else return;
          await refresh();
        } catch (err) { toast(err.message, 'warn'); }
      });
    },
    async onSubmit(form, action) {
      const C = await import('./cloud.js');
      // Enter in a field presses the hidden default button: treat it as the form's main action.
      if (action === 'save') action = form.elements.email ? 'signin' : form.elements.invite?.value ? 'join' : form.elements['profile-name'] ? 'profile' : 'none';
      const error = msg => { const el = $('.form-error', form); if (el) el.textContent = msg; return true; };
      const busy = on => $$('button', form).forEach(b => { b.disabled = on; });
      const email = form.elements.email?.value.trim();
      const password = form.elements.password?.value;
      try {
        busy(true);
        switch (action) {
          case 'profile': {
            const name = form.elements['profile-name'].value.trim();
            if (!name) return error('Enter your name.');
            const person = me();
            if (person) await patchDoc('people', person.id, { name, photo: profile.photo });
            if (cloudState.info) {
              cloudState.info.memberNames[user.uid] = name;
              if (profile.photo) cloudState.info.memberPhotos[user.uid] = profile.photo;
              else delete cloudState.info.memberPhotos[user.uid];
            }
            // Not waited for: with no signal the write is queued and sent on reconnecting.
            C.saveProfile(cloudState.churchId, name, profile.photo).catch(err => toast(`Your profile was not saved online: ${err.message || err}`, 'warn'));
            toast('Profile saved.');
            return false;
          }
          case 'google':
            cloudState.reopen = true;
            await C.signInGoogle();
            toast('Signed in.');
            return false;
          case 'signin':
          case 'create':
            if (!email || !password) return error('Enter your email and a password.');
            cloudState.reopen = true;
            await C.signInEmail(email, password, action === 'create');
            toast(action === 'create' ? 'Account created.' : 'Signed in.');
            return false;
          case 'reset':
            if (!email) return error('Enter your email first.');
            await C.resetPassword(email);
            return error('Check your email for a link to set a new password.');
          case 'upload':
          case 'upload-empty': {
            const data = action === 'upload' ? state
              : { ...M.emptyState(), settings: { ...state.settings, churchName: isUntouchedSample() ? 'Our Church' : state.settings.churchName }, roles: state.roles };
            const cid = await C.createChurch(cloudState.user, data);
            await useChurch(cid);
            toast('Your church is online. Copy the invite link to add your team.');
            dialog().close();
            openAccount();
            return true;
          }
          case 'join': {
            const invite = (form.elements.invite.value || '').trim();
            if (!M.parseInvite(invite)) return error('Paste the whole invite link.');
            await acceptInvite(invite);
            return false;
          }
          case 'leave':
            if (!confirm('Leave this church? You will need a new invite to come back.')) return true;
            await C.leaveChurch(cloudState.user.uid, cloudState.churchId);
            await useLocal();
            toast('You left the church. Showing this browser\'s copy.');
            return false;
          case 'signout':
            await C.signOut();
            toast('Signed out. This browser now shows its own copy.');
            return false;
          default: return false;
        }
      } catch (err) {
        cloudState.reopen = false;
        return error(C.authMessage(err));
      } finally {
        busy(false);
      }
    },
  });
}

// ---------- your schedule (in-app notifications) ----------

// Signed in to a church, the minister whose email matches your sign-in is "you". The bell
// counts your upcoming assignments you haven't opened yet; `seen` lives on users/{uid}.
const mine = { loaded: false, seen: new Set(), announced: new Set() };

function me() {
  if (!isCloud()) return null;
  return M.findPersonForUser(state.people, cloudState.user);
}

function myUpcoming() {
  const person = me();
  return person ? M.upcomingFor(state, person.id, M.todayISO()) : [];
}

function myTasks() {
  const person = me();
  return person ? M.tasksFor(state, person.id, M.todayISO()) : [];
}

const isUnseen = item => item.keys.some(k => !mine.seen.has(k));

async function loadSeen() {
  mine.loaded = false;
  mine.seen = new Set();
  mine.announced = new Set();
  if (!cloudState.user) return;
  const C = await import('./cloud.js');
  try {
    mine.seen = new Set(await C.seenAssignments(cloudState.user.uid));
    mine.loaded = true;
  } catch { /* offline: the bell waits until the next time the church opens */ }
}

function resetMine() {
  mine.loaded = false;
  mine.seen = new Set();
  mine.announced = new Set();
}

function renderMineButton() {
  const btn = $('#mine-btn');
  if (!btn) return;
  btn.hidden = !isCloud();
  if (!isCloud()) return;
  const fresh = mine.loaded ? [...myUpcoming(), ...myTasks()].filter(isUnseen) : [];
  const count = $('.bell-count', btn);
  count.hidden = !fresh.length;
  count.textContent = fresh.length > 9 ? '9+' : String(fresh.length);
  const label = fresh.length ? `Your schedule: ${fresh.length} new` : 'Your schedule';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  // Tell you once about each assignment that arrives, whether on opening the app or live.
  const unannounced = fresh.filter(x => x.keys.some(k => !mine.announced.has(k)));
  if (!unannounced.length) return;
  unannounced.forEach(x => x.keys.forEach(k => mine.announced.add(k)));
  if (unannounced.length === 1) {
    const x = unannounced[0];
    toast(x.task ? `You have a new task: ${x.task.title}. Tap the bell to see it.` : `You're on ${x.roles.map(r => r.name).join(' and ')}, ${M.formatDate(x.service.date)}. Tap the bell to see it.`);
  } else {
    toast(`You have ${unannounced.length} new assignments. Tap the bell to see them.`);
  }
}

async function openMine() {
  // The seen list didn't load (offline at startup): try again now, so this list is right.
  if (!mine.loaded && isCloud()) await loadSeen();
  const person = me();
  const email = cloudState.user?.email || '';
  let body;
  if (!person) {
    body = `<p class="lead">Your sign-in isn't linked to a minister yet.</p>
      <p class="muted">Ask whoever runs the roster to open your profile on the Ministers tab and set its email to <strong>${esc(email)}</strong>. Then this bell tells you whenever you're put on a service.</p>`;
  } else {
    const list = myUpcoming();
    const tasks = myTasks();
    const taskList = tasks.length ? `<section class="sheet-section"><h3>Your tasks</h3><ul class="mine-list">${tasks.map(x => {
      const d = dayParts(x.week);
      return `<li class="${isUnseen(x) ? 'is-new' : ''}">
          <span class="date-block"><span class="day-num">${d.num}</span><span class="day-dow">${esc(d.dow)} ${esc(d.mon)}</span></span>
          <span class="mine-body"><span class="mine-roles">${esc(x.task.title)}</span>
            ${x.task.notes ? `<span class="muted">${esc(x.task.notes)}</span>` : ''}</span>
          ${isUnseen(x) ? '<span class="new-tag">New</span>' : ''}</li>`;
    }).join('')}</ul></section>` : '';
    body = (list.length
      ? `<ul class="mine-list">${list.map(x => {
        const d = dayParts(x.service.date);
        const sermon = x.service.sermon || {};
        return `<li class="${isUnseen(x) ? 'is-new' : ''}">
          <span class="date-block"><span class="day-num">${d.num}</span><span class="day-dow">${esc(d.dow)} ${esc(d.mon)}</span></span>
          <span class="mine-body"><span class="mine-roles">${esc(x.roles.map(r => r.name).join(', '))}</span>
            <span class="muted">${esc([x.service.time, x.service.name].filter(Boolean).join(' · '))}${sermon.title ? ` · ${esc(sermon.title)}` : ''}</span>
            ${x.service.setlist?.length ? `<span class="mine-songs">${esc(x.service.setlist.map(M.songLabel).join(' · '))}</span>` : ''}</span>
          ${isUnseen(x) ? '<span class="new-tag">New</span>' : ''}</li>`;
      }).join('')}</ul>`
      : tasks.length ? '' : '<p class="muted">You are not on any upcoming service.</p>') + taskList;
    // Opening the list counts as seeing it. Only upcoming keys are kept, so the doc stays small.
    const keys = [...list, ...tasks].flatMap(x => x.keys);
    if (mine.loaded && keys.some(k => !mine.seen.has(k))) {
      mine.seen = new Set(keys);
      renderMineButton();
      import('./cloud.js').then(C => C.markAssignmentsSeen(cloudState.user.uid, keys)).catch(() => {});
    }
  }
  openDialog(dialogHead('Your schedule', person ? person.name : email) + `<div class="dialog-body">${body}</div>
    <footer class="dialog-actions"><span class="spacer"></span><button class="btn" value="cancel" formnovalidate>Close</button></footer>`);
}

// Opens the phone's share sheet, or copies on a computer.
async function shareText(text, copied) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast(copied); } catch { toast(text); }
}

// After a minister is saved with "Send an invite": their link, ready to send.
function openInvite(person) {
  const text = M.inviteMessage(state, person, inviteLink(cloudState.churchId, person.id));
  const phone = M.personPhone(person);
  const email = M.personEmail(person);
  openDialog(dialogHead('Send the invite', person.name) + `<div class="dialog-body"><p class="invite-preview">${esc(text)}</p></div>
    <footer class="dialog-actions">
      ${phone ? `<a class="btn ghost" href="sms:${esc(phone)}?&body=${esc(encodeURIComponent(text))}">Text</a>` : ''}
      ${email ? `<a class="btn ghost" href="mailto:${esc(email)}?subject=${esc(encodeURIComponent(`Join ${state.settings.churchName}`))}&body=${esc(encodeURIComponent(text))}">Email</a>` : ''}
      <span class="spacer"></span>
      <button class="btn" value="cancel" formnovalidate>Done</button>
      <button type="button" class="btn primary" data-local="send-invite">${navigator.share ? 'Send' : 'Copy'}</button>
    </footer>`, {
    onMount(form) { $('[data-local="send-invite"]', form).addEventListener('click', () => shareText(text, 'Invite copied. Paste it into a chat.')); },
  });
}

// After a save puts people on a service: one tap each to message them.
function openNotify(service, added) {
  const link = notifyLink();
  const rows = [...added].map(([pid, roleIds]) => ({ person: state.people.find(p => p.id === pid), roleIds })).filter(r => r.person).map(({ person, roleIds }) => {
    const detail = roleIds.map(id => state.roles.find(x => x.id === id)?.name || id).join(', ');
    return { person, detail, text: M.assignmentMessage(state, person, service, roleIds, link), subject: `Serving ${M.formatDate(service.date)}: ${detail}` };
  });
  showNotify(`${rows.length} newly on ${M.formatDate(service.date, { weekday: 'long', day: 'numeric', month: 'long' })}`, rows);
}

// After a save gives people a task: the same one tap each.
function openTaskNotify(task, added) {
  const link = notifyLink();
  const when = M.formatDate(M.weekOfDate(task.week, state.settings.defaultDay), { day: 'numeric', month: 'short' });
  const rows = added.map(id => state.people.find(p => p.id === id)).filter(Boolean)
    .map(person => ({ person, detail: `Week ending ${when}`, text: M.taskMessage(state, person, task, link), subject: `Task for ${when}: ${task.title}` }));
  showNotify(task.title, rows);
}

// Signed out, the app only holds this browser's copy, so a link would show them nothing.
const notifyLink = () => (isCloud() ? `${location.origin}${location.pathname}` : '');

function showNotify(sub, rows) {
  if (!rows.length) return;
  const items = rows.map((r, i) => {
    const phone = M.personPhone(r.person);
    const email = M.personEmail(r.person);
    return `<li>
      ${avatar(r.person.name, photoOf(r.person))}
      <span class="notify-who"><span class="member-name">${esc(r.person.name)}</span>
        <span class="muted small">${esc(r.detail)}</span></span>
      <span class="notify-actions">
        <button type="button" class="btn small" data-notify="${i}">${navigator.share ? 'Send' : 'Copy'}</button>
        ${phone ? `<a class="btn small ghost" href="sms:${esc(phone)}?&body=${esc(encodeURIComponent(r.text))}">Text</a>` : ''}
        ${email ? `<a class="btn small ghost" href="mailto:${esc(email)}?subject=${esc(encodeURIComponent(r.subject))}&body=${esc(encodeURIComponent(r.text))}">Email</a>` : ''}
      </span></li>`;
  }).join('');
  openDialog(dialogHead('Let them know', sub) + `<div class="dialog-body">
      <ul class="members notify-list">${items}</ul>
      <p class="muted small">${navigator.share
        ? 'Send opens Messenger, Viber or any app on your phone with the message written for you.'
        : 'Copy puts the message on your clipboard, ready to paste into a chat.'} ${isCloud() ? 'Ministers with an email on their profile also see a new assignment in the app when they sign in.' : 'Sign in to sync, and ministers with an email on their profile also see it in the app.'}</p>
    </div>
    <footer class="dialog-actions"><span class="spacer"></span><button class="btn primary" value="cancel" formnovalidate>Done</button></footer>`, {
    onMount(form) {
      form.addEventListener('click', async e => {
        const i = e.target.closest('[data-notify]')?.dataset.notify;
        if (i === undefined) return;
        await shareText(rows[Number(i)].text, 'Message copied. Paste it into a chat.');
      });
    },
  });
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

const ADMIN_ACTIONS = new Set(['edit-service', 'new-service', 'fill-month', 'autofill-month', 'assign', 'edit-person', 'new-person',
  'edit-series', 'new-series', 'edit-task', 'new-task', 'add-role', 'delete-role', 'load-sample', 'clear-all']);

async function handleAction(el) {
  const { action, id } = el.dataset;
  if (ADMIN_ACTIONS.has(action) && !canManage()) return undefined;
  switch (action) {
    case 'edit-sermon': {
      const svc = state.services.find(s => s.id === id);
      return svc && preachesOn(svc) ? openSermonEditor(svc) : undefined;
    }
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
    case 'assign': return openAssign(id, el.dataset.role, Number(el.dataset.slot));
    case 'pick-day': view.day = id; render(); return $('.main').scrollTo(0, 0);
    case 'print': return window.print();
    case 'autofill-month': {
      const { changed, filled } = M.autoFillMonth(state, view.y, view.m, M.todayISO());
      if (!changed.length) return toast('No upcoming slots could be filled. Any still open need someone qualified and free that day.');
      if (!confirm(`Fill ${plural(filled, 'open slot')} across ${plural(changed.length, 'service')}${isCloud() ? ' for everyone in this church' : ''}?`)) return undefined;
      for (const s of changed) await putDoc('services', s);
      toast(`Filled ${plural(filled, 'open slot')}, starting with whoever has served least.`);
      return render();
    }
    case 'edit-person': return openPersonEditor(state.people.find(p => p.id === id));
    case 'new-person': return openPersonEditor(null);
    case 'edit-series': return openSeriesEditor(state.series.find(s => s.id === id));
    case 'new-series': return openSeriesEditor(null);
    case 'edit-task': return openTaskEditor(state.tasks.find(t => t.id === id));
    case 'new-task': return openTaskEditor(null, el.dataset.week);
    case 'add-role': return addRole();
    case 'delete-role': {
      const row = el.closest('.role-row');
      const used = state.services.some(s => M.assigned(s, row.dataset.role).length);
      if (used && !confirm('Remove this role? Its assignments on every service will be cleared.')) return;
      if (!row.dataset.new) removedRoles.add(row.dataset.role);
      row.remove();
      return saveRoles();
    }
    case 'theme': applyTheme(el.dataset.value); return render();
    case 'schedule-mode': view.announce = el.dataset.value === 'announce'; return render();
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
    case 'account': return openAccount();
    case 'mine': return openMine();
    case 'load-sample':
      if (!confirm(`Replace everything${isCloud() ? ' for everyone in this church' : ''} with the sample church? Export a backup first if you want to keep your data.`)) return;
      await replaceAll(sampleState());
      toast('Sample data loaded.');
      return render();
    case 'clear-all':
      if (!confirm(`Delete every service, task, minister and series${isCloud() ? ' for everyone in this church' : ''}? This cannot be undone.`)) return;
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
  // Nothing on a phone can be dragged away: a touch only scrolls the open sheet, or else the
  // page, and only if there is more to see. Above phone width the window scrolls as usual.
  const hasMore = el => Boolean(el) && el.scrollHeight > el.clientHeight;
  document.addEventListener('touchmove', e => {
    const open = dialog().open;
    if (!e.cancelable || (!open && !phoneWidth.matches)) return;
    if (!hasMore(e.target.closest(open ? '.dialog-body' : '.main')) && !hasMore(e.target.closest('textarea'))) e.preventDefault();
  }, { passive: false });
  phoneWidth.addEventListener('change', () => { if (!dialog().open) render(); });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-action], .folio[data-action]')) {
      e.preventDefault();
      handleAction(e.target);
    }
  });
  document.addEventListener('change', e => {
    if (e.target.matches('select[data-action="focus"]')) { view.focus = e.target.value; render(); }
    if (e.target.matches('input[data-task-done]')) setTaskDone(e.target.dataset.taskDone, e.target.checked);
    if (e.target.id === 'import-file' && e.target.files[0]) importBackup(e.target.files[0]);
    if (e.target.closest('#settings-form')) saveChurch(e.target.form);
    if (/^role-(name|slots)$/.test(e.target.name)) saveRoles();
    if (e.target.id === 'minister-role') { view.roleFilter = e.target.value; applyMinisterFilter(); }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'minister-search') { view.search = e.target.value; applyMinisterFilter(); }
  });
  // Both settings forms save as you go, so Enter has nothing left to submit.
  document.addEventListener('submit', e => {
    if (e.target.closest('.main')) e.preventDefault();
  });
  document.addEventListener('keydown', e => {
    if (e.target.id === 'new-role' && e.key === 'Enter') { e.preventDefault(); addRole(); }
  });
  wireRoleDrag();
  // Back online after the seen list failed to load: load it so the bell starts counting.
  window.addEventListener('online', async () => {
    if (isCloud() && !mine.loaded) { await loadSeen(); if (!dialog().open) render(); }
  });
  window.addEventListener('hashchange', async () => { if (await onInviteHash()) return; readHash(); render(); });
  // Every way a dialog closes (Save, Cancel, the X, Esc) redraws once, picking up any change.
  dialog().addEventListener('close', render);
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
  const invited = readInvite();
  readHash();
  wire();
  unsubscribe = store.subscribe(next => { state = next; if (!dialog().open && !isTyping()) render(); });
  render();
  await initCloud();
  if (invited && !cloudState.ready) toast('Cloud sync is not switched on here, so the invite cannot be used yet.', 'warn');
  else if (invited && !cloudState.user) openAccount();
}

init();
