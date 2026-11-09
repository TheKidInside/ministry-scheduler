// Pure data logic: no DOM, no storage. Everything here is testable with `node --test`.
// Dates are always "YYYY-MM-DD" strings and are handled in UTC so DST never shifts a day.

export const DEFAULT_ROLES = [
  { id: 'opening-prayer', name: 'Opening Prayer', slots: 1 },
  { id: 'worship-leader', name: 'Worship Leader', slots: 1 },
  { id: 'worship-team', name: 'Worship Team', slots: 4 },
  { id: 'tech', name: 'Tech (Sound & Slides)', slots: 2 },
  { id: 'preacher', name: 'Preacher', slots: 1 },
];

export const PREACHER_ROLE = 'preacher';

// Jewel tones, like stained glass: amethyst, emerald, sapphire, garnet, ochre gold, teal, plum.
export const SERIES_COLORS = ['#6b4c9a', '#2e6f5e', '#2f5597', '#8e2f3c', '#a07a1f', '#2a6f7d', '#7a3b69'];

// Song keys for the setlist: majors, then minors, in the spellings worship charts use.
export const SONG_KEYS = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B',
  'Cm', 'C#m', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function uid(prefix = '') {
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix + Date.now().toString(36) + rand;
}

// ---------- dates ----------

export function toISO(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function isValidISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseISO(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function weekday(iso) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function todayISO(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function shiftMonth(y, m, delta) {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

export function formatDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { ...opts, timeZone: 'UTC' });
}

// Calendar grid for a month: array of weeks, each 7 cells (Sunday first); cells outside the month are null.
export function monthGrid(y, m) {
  const first = weekday(toISO(y, m, 1));
  const total = daysInMonth(y, m);
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(toISO(y, m, d));
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ---------- services ----------

export function sortServices(services) {
  return [...services].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

export function servicesInMonth(services, y, m) {
  const key = toISO(y, m, 1).slice(0, 7);
  return sortServices(services.filter(s => monthKey(s.date) === key));
}

export function newService({ date, time = '', name = 'Sunday Service', seriesId = '' }) {
  return {
    id: uid('svc_'),
    date,
    time,
    name,
    assignments: {},
    sermon: { title: '', scripture: '', seriesId },
    setlist: [],
    notes: '',
  };
}

// Every `day` (0=Sunday) of the month that has no service yet gets one.
// A new service defaults its series to whichever series' date range covers it.
export function generateMonthServices(state, y, m) {
  const { defaultDay = 0, defaultTime = '', serviceName = 'Sunday Service' } = state.settings || {};
  const taken = new Set(state.services.map(s => s.date));
  const created = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const iso = toISO(y, m, d);
    if (weekday(iso) !== Number(defaultDay) || taken.has(iso)) continue;
    const series = seriesCoveringDate(state.series, iso);
    created.push(newService({ date: iso, time: defaultTime, name: serviceName, seriesId: series ? series.id : '' }));
  }
  return created;
}

export function assigned(service, roleId) {
  const a = service.assignments;
  return a && Object.hasOwn(a, roleId) && Array.isArray(a[roleId]) ? a[roleId] : [];
}

export function peopleOnService(service) {
  const ids = new Set();
  for (const list of Object.values(service.assignments || {})) for (const id of list) if (id) ids.add(id);
  return ids;
}

// ---------- setlist ----------

// "Amazing Grace (G)", or just the title when no key is set.
export const songLabel = song => (song.key ? `${song.title} (${song.key})` : song.title);

// Every song sung so far, once each, with the key it was last sung in: the setlist's suggestions.
export function songLibrary(services) {
  const out = new Map();
  for (const svc of sortServices(services)) {
    for (const song of svc.setlist || []) {
      const id = song.title.trim().toLowerCase();
      if (!id) continue;
      const prev = out.get(id);
      out.set(id, { title: song.title, key: song.key || prev?.key || '', times: (prev?.times || 0) + 1, last: svc.date });
    }
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- weekly tasks ----------

export function addDays(iso, n) {
  const { y, m, d } = parseISO(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return toISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// A church week runs up to its service day, so a week is named by that day. A task saved
// before the usual day changed lands on the nearest new service day, at most three days away.
export function weekOfDate(iso, day = 0) {
  const ahead = (Number(day) - weekday(iso) + 7) % 7;
  return addDays(iso, ahead > 3 ? ahead - 7 : ahead);
}

// The weeks of a month: one for each usual service day that falls in it.
export function weeksInMonth(y, m, day = 0) {
  const out = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const end = toISO(y, m, d);
    if (weekday(end) === Number(day)) out.push({ end, start: addDays(end, -6) });
  }
  return out;
}

export function newTask({ week, title = '', assignees = [], notes = '' }) {
  return { id: uid('task_'), week, title, assignees, notes, done: false };
}

// In the order they were added: ids start with their creation time, and Firestore won't keep list order.
export function tasksInWeek(tasks, end, day = 0) {
  return tasks.filter(t => weekOfDate(t.week, day) === end).sort((a, b) => a.id.localeCompare(b.id));
}

// One key per task and week, so moving a task to another week counts as new.
export const taskKey = task => `task:${task.id}:${task.week}`;

// A person's unfinished tasks from this week onward, each with the key used to remember what they've seen.
export function tasksFor(state, personId, fromISO) {
  const day = state.settings.defaultDay;
  return state.tasks
    .map(task => ({ task, week: weekOfDate(task.week, day), keys: [taskKey(task)] }))
    .filter(x => !x.task.done && x.task.assignees.includes(personId) && x.week >= fromISO)
    .sort((a, b) => a.week.localeCompare(b.week) || a.task.id.localeCompare(b.task.id));
}

// Who an edit newly gave this task. Moving it to another week makes everyone on it new, as with a service.
export function addedTaskPeople(before, after) {
  const had = new Set(before && before.week === after.week ? before.assignees : []);
  return after.assignees.filter(id => !had.has(id));
}

// ---------- series ----------

export function seriesCoveringDate(series, iso) {
  return series.find(s => s.start && s.end && s.start <= iso && iso <= s.end) || null;
}

// Part N of M: position of this service among all services in the same series (by date).
export function seriesPart(services, service) {
  const id = service.sermon && service.sermon.seriesId;
  if (!id) return null;
  const same = sortServices(services.filter(s => s.sermon && s.sermon.seriesId === id));
  return { n: same.findIndex(s => s.id === service.id) + 1, of: same.length };
}

// Series that appear in a month, in order of first appearance, with that month's sermon count.
export function monthSeries(state, y, m) {
  const out = new Map();
  for (const svc of servicesInMonth(state.services, y, m)) {
    const id = svc.sermon && svc.sermon.seriesId;
    if (!id) continue;
    const s = state.series.find(x => x.id === id);
    if (!s) continue;
    if (!out.has(id)) out.set(id, { series: s, count: 0, first: svc.date, last: svc.date });
    const row = out.get(id);
    row.count++;
    row.last = svc.date;
  }
  return [...out.values()];
}

export function seriesStats(state, seriesId) {
  const list = sortServices(state.services.filter(s => s.sermon && s.sermon.seriesId === seriesId));
  return { count: list.length, first: list[0]?.date || '', last: list[list.length - 1]?.date || '' };
}

// ---------- people / conflicts ----------

export function isUnavailable(person, iso) {
  return (person.unavailable || []).includes(iso);
}

export function canServe(person, roleId) {
  return (person.roleIds || []).includes(roleId);
}

// Besides admins, the songs belong to anyone set up as a Worship Leader or on Tech. Matched on the
// role's name, because churches name their own roles. firestore.rules has the same test.
export function songRole(state, person) {
  return state.roles.find(r => /^(worship lead|tech)/i.test(r.name) && canServe(person, r.id)) || null;
}

// How many services a person is on in a month (a person on two roles in one service counts once).
export function monthLoad(services, personId, y, m) {
  return servicesInMonth(services, y, m).filter(s => peopleOnService(s).has(personId)).length;
}

// Every problem on one service. type: unavailable | not-qualified | double-booked | unknown-person
// Several roles on one service is fine; double-booked means the same person twice in one role.
export function serviceConflicts(state, service) {
  const people = new Map(state.people.map(p => [p.id, p]));
  const out = [];
  for (const role of state.roles) {
    const seen = new Set();
    for (const pid of assigned(service, role.id)) {
      if (!pid) continue;
      const person = people.get(pid);
      if (!person) { out.push({ type: 'unknown-person', roleId: role.id, personId: pid }); continue; }
      if (isUnavailable(person, service.date)) out.push({ type: 'unavailable', roleId: role.id, personId: pid });
      if (!canServe(person, role.id)) out.push({ type: 'not-qualified', roleId: role.id, personId: pid });
      if (seen.has(pid)) out.push({ type: 'double-booked', roleId: role.id, personId: pid });
      seen.add(pid);
    }
  }
  return out;
}

export function describeConflict(state, c) {
  const person = state.people.find(p => p.id === c.personId);
  const role = state.roles.find(r => r.id === c.roleId);
  const name = person ? person.name : 'Removed person';
  const roleName = role ? role.name : c.roleId;
  switch (c.type) {
    case 'unavailable': return `${name} is marked unavailable on this date`;
    case 'not-qualified': return `${name} is not set up to serve as ${roleName}`;
    case 'double-booked': return `${name} is on ${roleName} twice`;
    default: return `${roleName} has a person who no longer exists`;
  }
}

// Fill empty slots with qualified, available people who aren't already on this service,
// preferring whoever has served least this month. Existing picks are never changed.
export function autoFill(state, service) {
  const { y, m } = parseISO(service.date);
  const load = new Map(state.people.map(p => [p.id, monthLoad(state.services.filter(s => s.id !== service.id), p.id, y, m)]));
  const onService = peopleOnService(service);
  const assignments = {};
  for (const role of state.roles) {
    const current = assigned(service, role.id).filter(Boolean);
    const slots = Math.max(role.slots || 1, current.length);
    const picks = [...current];
    const pool = state.people
      .filter(p => canServe(p, role.id) && !isUnavailable(p, service.date) && !onService.has(p.id))
      .sort((a, b) => load.get(a.id) - load.get(b.id) || a.name.localeCompare(b.name));
    for (const p of pool) {
      if (picks.length >= slots) break;
      picks.push(p.id);
      onService.add(p.id);
    }
    if (picks.length) assignments[role.id] = picks;
  }
  return { ...service, assignments };
}

// ---------- what a month still needs ----------

// "Sun 8 Nov", however the browser's locale punctuates it.
export const shortDate = iso => formatDate(iso, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');

// One clash per person per role, even if someone is both away and not set up for it.
export function serviceClashes(state, service) {
  const seen = new Set();
  return serviceConflicts(state, service).filter(c => {
    const key = `${c.roleId}:${c.personId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function serviceSummary(state, service) {
  let filled = 0;
  let open = 0;
  for (const role of state.roles) {
    const count = assigned(service, role.id).filter(Boolean).length;
    filled += count;
    open += Math.max(0, (role.slots || 1) - count);
  }
  return { filled, open, total: filled + open, clashes: serviceClashes(state, service) };
}

export function monthSummary(state, y, m) {
  const services = servicesInMonth(state.services, y, m);
  const out = { services: services.length, filled: 0, open: 0, total: 0, clashes: [] };
  for (const service of services) {
    const s = serviceSummary(state, service);
    out.filled += s.filled;
    out.open += s.open;
    out.total += s.total;
    for (const clash of s.clashes) out.clashes.push({ service, clash });
  }
  return out;
}

// Consecutive away dates read better as one range: 20-23 Nov.
export function awayRanges(dates, fromISO = '') {
  const out = [];
  for (const d of [...new Set(dates || [])].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.end, 1) === d) last.end = d;
    else out.push({ start: d, end: d });
  }
  return out.filter(r => r.end >= fromISO);
}

export function formatRange({ start, end }) {
  const a = parseISO(start);
  const b = parseISO(end);
  const mon = iso => formatDate(iso, { month: 'short' });
  if (start === end) return `${a.d} ${mon(start)}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${mon(end)}`;
  return `${a.d} ${mon(start)} – ${b.d} ${mon(end)}`;
}

// The short reason shown beside a name.
export function clashNote(state, service, c) {
  const person = state.people.find(p => p.id === c.personId);
  switch (c.type) {
    case 'unavailable': {
      const range = awayRanges(person.unavailable).find(r => r.start <= service.date && service.date <= r.end);
      return `Away ${formatRange(range)}`;
    }
    case 'not-qualified': return 'Not set up for this role';
    case 'double-booked': return 'Listed twice in this role';
    default: return 'No longer on the team';
  }
}

// The full line in the month's alert: "Joel P. on keys, Sun 8 Nov: away 20–23 Nov."
export function clashSentence(state, service, c) {
  const name = state.people.find(p => p.id === c.personId)?.name || 'Someone';
  const role = (state.roles.find(r => r.id === c.roleId)?.name || c.roleId).toLowerCase();
  const note = clashNote(state, service, c);
  return `${name} on ${role}, ${shortDate(service.date)}: ${note[0].toLowerCase()}${note.slice(1)}.`;
}

const countPeople = service => Object.values(service.assignments || {}).flat().filter(Boolean).length;

// Auto-fill every service in a month from a date onward. Each filled service counts towards
// the next one's load, so the month spreads across the team.
export function autoFillMonth(state, y, m, fromISO = '') {
  let services = state.services;
  const changed = [];
  let filled = 0;
  for (const service of servicesInMonth(state.services, y, m)) {
    if (service.date < fromISO) continue;
    const next = autoFill({ ...state, services }, service);
    const added = countPeople(next) - countPeople(service);
    if (added <= 0) continue;
    filled += added;
    changed.push(next);
    services = services.map(s => (s.id === next.id ? next : s));
  }
  return { changed, filled };
}

// Who can take one slot on one service. Anyone away, or already in this role, can be seen but
// not picked. Someone on another role here can be picked, after those with nothing yet that day.
// The least busy come first.
export function assignOptions(state, service, roleId, slot = 0) {
  const { y, m } = parseISO(service.date);
  const others = servicesInMonth(state.services, y, m).filter(s => s.id !== service.id);
  const current = assigned(service, roleId)[slot] || '';
  const weekdayName = formatDate(service.date, { weekday: 'long' });
  const roleName = state.roles.find(r => r.id === roleId)?.name || roleId;
  const inThisRole = new Set(assigned(service, roleId).filter((id, i) => id && i !== slot));
  const otherRoles = new Map(); // personId -> names of the other roles they hold here
  for (const role of state.roles) {
    if (role.id === roleId) continue;
    for (const id of new Set(assigned(service, role.id).filter(Boolean))) otherRoles.set(id, [...(otherRoles.get(id) || []), role.name]);
  }
  const available = [];
  const unavailable = [];
  for (const person of state.people.filter(p => canServe(p, roleId))) {
    if (isUnavailable(person, service.date)) {
      unavailable.push({ person, note: clashNote(state, service, { type: 'unavailable', personId: person.id }) });
    } else if (inThisRole.has(person.id)) {
      unavailable.push({ person, note: `Already on ${roleName}` });
    } else {
      const dates = others.filter(s => peopleOnService(s).has(person.id)).map(s => s.date);
      const days = dates.map(d => parseISO(d).d);
      const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} & ${days[days.length - 1]}` : days[0];
      const also = otherRoles.get(person.id);
      const note = also ? `Also on ${also.join(', ')} this service`
        : dates.length ? `Also rostered ${list} ${formatDate(dates[0], { month: 'short' })}` : `Free this ${weekdayName}`;
      available.push({ person, note, load: dates.length, doubling: Boolean(also) });
    }
  }
  available.sort((a, b) => (b.person.id === current) - (a.person.id === current) || a.doubling - b.doubling || a.load - b.load || a.person.name.localeCompare(b.person.name));
  unavailable.sort((a, b) => a.person.name.localeCompare(b.person.name));
  return { current, available, unavailable };
}

// One dot per service this month, lit when this person is on it.
export function ministerMonth(services, personId, y, m) {
  const dots = servicesInMonth(services, y, m).map(s => peopleOnService(s).has(personId));
  const load = dots.filter(Boolean).length;
  return { dots, load, total: dots.length, busy: load >= 3 && load / dots.length >= 0.75 };
}

// Roles are free text, so the phone's sections come from their names.
const ROLE_GROUPS = [
  ['Preaching', /preach|bible|scripture|reading|sermon|homily/i],
  ['Worship', /worship|music|\bkeys?\b|keyboard|piano|guitar|\bbass\b|drum|vocal|\bsing|choir|\bband\b/i],
  ['Tech', /tech|sound|audio|slide|stream|media|projection|lighting|camera|video/i],
  ['Welcome & care', /./],
];

export function roleGroups(roles) {
  const out = ROLE_GROUPS.map(([name]) => ({ name, roles: [] }));
  for (const role of roles) {
    const i = role.id === PREACHER_ROLE ? 0 : ROLE_GROUPS.findIndex(([, re]) => re.test(role.name));
    out[i].roles.push(role);
  }
  return out.filter(g => g.roles.length);
}

// A passage inside a series of the same name drops the repeat: "Romans · 8:1-11".
export function shortScripture(seriesName, scripture) {
  const s = String(scripture ?? '').trim();
  const prefix = `${String(seriesName ?? '').trim()} `;
  return prefix.length > 1 && s.toLowerCase().startsWith(prefix.toLowerCase()) ? s.slice(prefix.length) : s;
}

const daysBetween = (a, b) => {
  const u = iso => { const { y, m, d } = parseISO(iso); return Date.UTC(y, m - 1, d); };
  return Math.round((u(b) - u(a)) / 86400000);
};

export const SERIES_STATUS = {
  current: 'Current', next: 'Up next', planned: 'Planned', draft: 'Draft', past: 'Finished',
};

// Worked out from the dates, so nothing extra is stored. A later series nobody is booked
// to preach yet is still a draft.
export function seriesStatuses(state, today) {
  const nextUp = state.series.filter(s => s.start > today && s.end).sort((a, b) => a.start.localeCompare(b.start))[0]?.id;
  const out = new Map();
  for (const s of state.series) {
    const booked = state.services.some(x => x.sermon?.seriesId === s.id && assigned(x, PREACHER_ROLE).some(Boolean));
    let status = 'draft';
    if (s.start && s.end) {
      if (s.end < today) status = 'past';
      else if (s.start <= today) status = 'current';
      else if (s.id === nextUp) status = 'next';
      else if (booked) status = 'planned';
    }
    out.set(s.id, status);
  }
  return out;
}

// Six months around today, every position a percentage of that span.
export function seriesTimeline(series, today, months = 6) {
  const { y, m } = parseISO(today);
  const first = shiftMonth(y, m, -2);
  const last = shiftMonth(first.y, first.m, months);
  const from = toISO(first.y, first.m, 1);
  const to = toISO(last.y, last.m, 1);
  const span = daysBetween(from, to);
  const pct = iso => Math.min(100, Math.max(0, (daysBetween(from, iso) / span) * 100));
  const heads = Array.from({ length: months }, (_, i) => {
    const mo = shiftMonth(first.y, first.m, i);
    return { left: pct(toISO(mo.y, mo.m, 1)), label: `${MONTHS[mo.m - 1].slice(0, 3)}${mo.m === 1 ? ` ${mo.y}` : ''}` };
  });
  const rows = series.filter(s => s.start && s.end && s.end >= from && s.start < to)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(s => ({ series: s, left: pct(s.start), width: pct(addDays(s.end, 1)) - pct(s.start) }));
  return { heads, rows, today: pct(today) };
}

// A person's assignments, soonest first, optionally from a date onward.
export function personSchedule(state, personId, fromISO = '') {
  const out = [];
  for (const svc of sortServices(state.services)) {
    if (fromISO && svc.date < fromISO) continue;
    const roles = state.roles.filter(r => assigned(svc, r.id).includes(personId));
    if (roles.length) out.push({ service: svc, roles });
  }
  return out;
}

// ---------- your assignments / letting people know ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = v => String(v ?? '').trim().toLowerCase();
export const isEmail = v => EMAIL_RE.test(normEmail(v));

// The email that links a minister to a sign-in. Older profiles kept it in "contact".
export function personEmail(person) {
  const e = normEmail(person.email);
  if (e) return e;
  const c = normEmail(person.contact);
  return EMAIL_RE.test(c) ? c : '';
}

export function personPhone(person) {
  const c = String(person.contact ?? '').trim();
  return /^\+?[\d\s().-]{7,}$/.test(c) ? c.replace(/[^\d+]/g, '') : '';
}

// Profile photos are small JPEGs kept as text on the document (Firebase Storage needs a paid
// plan). Anything else, from a hand-edited backup say, is dropped rather than shown.
export const isPhoto = v => typeof v === 'string' && v.length <= 40000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v);

const firstName = person => String(person.name).trim().split(/\s+/)[0] || person.name;

// Which minister a signed-in account is: linked directly, or matched by sign-in email.
export function findPersonForUser(people, user) {
  if (!user) return null;
  return people.find(p => p.userId && p.userId === user.uid) || findPersonByEmail(people, user.email);
}

// What signing in changes on your own minister: its link to your account and email, and the
// name you chose. Separate writes, because the rules allow each one only by itself.
export function ministerSync(people, person, user, name) {
  if (person.userId && person.userId !== user.uid) return [];
  const email = normEmail(user.email);
  const free = !people.some(p => p.id !== person.id && personEmail(p) === email);
  const link = person.userId ? !person.email && free : personEmail(person) === email;
  const out = [];
  if (email && link) out.push({ userId: user.uid, email });
  if (name && name !== person.name) out.push({ name });
  return out;
}

// A church invite, from a whole link or the bare id. "&as=" names the minister it was sent to.
export function parseInvite(text) {
  const m = String(text ?? '').trim().match(/^(?:.*#join=)?([A-Za-z0-9]{10,40})(?:&as=([\w-]{1,80}))?$/);
  return m ? { churchId: m[1], personId: m[2] || '' } : null;
}

export function inviteMessage(state, person, link) {
  const first = firstName(person);
  return `Hi ${first}, please join ${state.settings.churchName} on Ministry Scheduler so you can see when you're serving:\n${link}`;
}

export function findPersonByEmail(people, email) {
  const e = normEmail(email);
  return e ? people.find(p => personEmail(p) === e) || null : null;
}

// One key per service, role and date, so moving a service to another day counts as new.
export const assignmentKey = (service, roleId) => `${service.id}:${roleId}:${service.date}`;

// Upcoming assignments for one person, each with the keys used to remember what they've seen.
export function upcomingFor(state, personId, fromISO) {
  return personSchedule(state, personId, fromISO).map(x => ({ ...x, keys: x.roles.map(r => assignmentKey(x.service, r.id)) }));
}

// Who an edit put on a service: personId -> the role ids they were not on before.
// `before` is null for a new service. Moving the date makes everyone on it new.
export function addedAssignments(before, after) {
  const out = new Map();
  const sameDay = before && before.date === after.date;
  for (const [roleId, list] of Object.entries(after.assignments || {})) {
    const had = new Set(sameDay ? assigned(before, roleId) : []);
    for (const pid of list) {
      if (!pid || had.has(pid)) continue;
      if (!out.has(pid)) out.set(pid, []);
      if (!out.get(pid).includes(roleId)) out.get(pid).push(roleId);
    }
  }
  return out;
}

// The text sent to someone you've just put on the roster.
export function assignmentMessage(state, person, service, roleIds, link = '') {
  const roles = roleIds.map(id => state.roles.find(r => r.id === id)?.name || id);
  const roleText = roles.length > 1 ? `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}` : roles[0] || 'serving';
  const first = firstName(person);
  const when = formatDate(service.date, { weekday: 'long', day: 'numeric', month: 'long' }) + (service.time ? `, ${service.time}` : '');
  const lines = [`Hi ${first}, you're on ${roleText} for ${service.name} on ${when}.`];
  const sermon = service.sermon || {};
  if (sermon.title || sermon.scripture) lines.push(`Sermon: ${[sermon.title, sermon.scripture].filter(Boolean).join(' · ')}`);
  if (service.setlist?.length) lines.push(`Setlist: ${service.setlist.map(songLabel).join(', ')}`);
  lines.push(`${state.settings.churchName}`);
  if (link) lines.push(`Your schedule: ${link}`);
  return lines.join('\n');
}

// The text sent to someone you've just given a task.
export function taskMessage(state, person, task, link = '') {
  const week = formatDate(weekOfDate(task.week, state.settings.defaultDay), { weekday: 'long', day: 'numeric', month: 'long' });
  const lines = [`Hi ${firstName(person)}, you have a task for the week of ${week}: ${task.title}.`];
  if (task.notes) lines.push(task.notes);
  lines.push(`${state.settings.churchName}`);
  if (link) lines.push(`Your schedule: ${link}`);
  return lines.join('\n');
}

// Removing a role or person must not leave dangling ids behind on services.
export function removePersonEverywhere(services, personId) {
  return services.map(s => {
    const assignments = {};
    let changed = false;
    for (const [rid, list] of Object.entries(s.assignments || {})) {
      const kept = list.filter(id => id !== personId);
      if (kept.length !== list.length) changed = true;
      assignments[rid] = kept;
    }
    return changed ? { ...s, assignments } : s;
  });
}

export function removePersonFromTasks(tasks, personId) {
  return tasks.map(t => (t.assignees.includes(personId) ? { ...t, assignees: t.assignees.filter(id => id !== personId) } : t));
}

export function removeRoleEverywhere(services, roleId) {
  return services.map(s => {
    if (!s.assignments || !(roleId in s.assignments)) return s;
    const assignments = { ...s.assignments };
    delete assignments[roleId];
    return { ...s, assignments };
  });
}

export function clearSeriesEverywhere(services, seriesId) {
  return services.map(s => (s.sermon && s.sermon.seriesId === seriesId
    ? { ...s, sermon: { ...s.sermon, seriesId: '' } } : s));
}

// ---------- import validation ----------

export function emptyState() {
  return {
    version: 1,
    settings: { churchName: 'Our Church', defaultDay: 0, defaultTime: '09:30', serviceName: 'Sunday Service' },
    roles: DEFAULT_ROLES.map(r => ({ ...r })),
    people: [],
    series: [],
    services: [],
    tasks: [],
  };
}

// Accept a backup file only if it has the expected shape; fill any missing parts with defaults.
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a schedule backup file.');
  const base = emptyState();
  const arr = (v, name) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`"${name}" should be a list.`);
    return v;
  };
  // Every field is coerced to the type the app expects, so a hand-edited or hostile
  // backup can never be saved in a shape that crashes every later page load.
  const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const ids = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const roles = (raw.roles === undefined ? base.roles : arr(raw.roles, 'roles'))
    .filter(r => r && str(r.id) && str(r.name))
    .map((r, i) => ({
      id: str(r.id),
      name: str(r.name),
      slots: Math.min(12, Math.max(1, parseInt(r.slots, 10) || 1)),
      // Explicit order = the schedule's column order (Firestore won't keep list order for us).
      order: Number.isFinite(r.order) ? r.order : i,
    }))
    .sort((a, b) => a.order - b.order);
  const services = arr(raw.services, 'services').filter(s => s && isValidISO(s.date)).map(s => {
    const assignments = {};
    for (const [rid, list] of Object.entries(obj(s.assignments))) assignments[rid] = ids(list);
    const sermon = obj(s.sermon);
    return {
      id: str(s.id) || uid('svc_'),
      date: s.date,
      time: str(s.time),
      name: str(s.name) || 'Service',
      assignments,
      sermon: { title: str(sermon.title), scripture: str(sermon.scripture), seriesId: str(sermon.seriesId) },
      setlist: (Array.isArray(s.setlist) ? s.setlist : [])
        .filter(x => x && str(x.title).trim()).slice(0, 30)
        .map(x => ({ title: str(x.title).trim().slice(0, 120), key: str(x.key).trim().slice(0, 8) })),
      notes: str(s.notes),
    };
  });
  const s = obj(raw.settings);
  return {
    version: 1,
    settings: {
      ...base.settings,
      churchName: str(s.churchName) || base.settings.churchName,
      defaultDay: Number.isInteger(Number(s.defaultDay)) && s.defaultDay !== '' && s.defaultDay != null
        ? Math.min(6, Math.max(0, Number(s.defaultDay))) : base.settings.defaultDay,
      defaultTime: s.defaultTime === undefined ? base.settings.defaultTime : str(s.defaultTime),
      serviceName: str(s.serviceName) || base.settings.serviceName,
      seeded: true, // any saved state means the first-visit sample must never load over it
    },
    roles,
    people: arr(raw.people, 'people').filter(p => p && str(p.id) && str(p.name)).map(p => ({
      id: str(p.id), name: str(p.name), contact: str(p.contact), email: normEmail(p.email), userId: str(p.userId), photo: isPhoto(p.photo) ? p.photo : '',
      roleIds: ids(p.roleIds), unavailable: ids(p.unavailable).filter(isValidISO),
    })),
    series: arr(raw.series, 'series').filter(x => x && str(x.id) && str(x.name)).map(x => ({
      id: str(x.id), name: str(x.name), description: str(x.description),
      color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : SERIES_COLORS[0],
      start: isValidISO(x.start) ? x.start : '', end: isValidISO(x.end) ? x.end : '',
    })),
    services,
    tasks: arr(raw.tasks, 'tasks').filter(t => t && str(t.id) && str(t.title).trim() && isValidISO(t.week)).map(t => ({
      id: str(t.id), week: t.week, title: str(t.title).trim().slice(0, 120),
      assignees: [...new Set(ids(t.assignees))], notes: str(t.notes).slice(0, 500), done: t.done === true,
    })),
  };
}

// The month as tables to share: a column per service, a row per role, names only.
// A busier month than `maxColumns` services splits evenly into several tables.
// Anyone no longer on the team is left out rather than announced as "Removed".
export function announcementBlocks(state, y, m, maxColumns = 5) {
  const names = new Map(state.people.map(p => [p.id, p.name]));
  const services = servicesInMonth(state.services, y, m);
  const perBlock = services.length <= maxColumns ? services.length : Math.ceil(services.length / Math.ceil(services.length / maxColumns));
  const blocks = [];
  for (let i = 0; i < services.length; i += perBlock) {
    const part = services.slice(i, i + perBlock);
    blocks.push({
      services: part,
      rows: state.roles.map(role => ({
        role,
        cells: part.map(svc => assigned(svc, role.id).map(id => names.get(id)).filter(Boolean)),
      })),
    });
  }
  return blocks;
}

// Plain-text month roster, ready to paste into a group chat.
export function rosterText(state, y, m) {
  const name = id => state.people.find(p => p.id === id)?.name || '?';
  const lines = [`${state.settings.churchName}: ${MONTHS[m - 1]} ${y} roster`];
  for (const svc of servicesInMonth(state.services, y, m)) {
    lines.push('', `${formatDate(svc.date, { weekday: 'short', day: 'numeric', month: 'short' })}${svc.time ? ` ${svc.time}` : ''} · ${svc.name}`);
    const series = state.series.find(s => s.id === svc.sermon?.seriesId);
    const sermon = [svc.sermon?.title, svc.sermon?.scripture].filter(Boolean).join(' (') + (svc.sermon?.title && svc.sermon?.scripture ? ')' : '');
    if (sermon || series) lines.push(`Sermon: ${sermon || 'TBA'}${series ? ` [${series.name}]` : ''}`);
    if (svc.setlist?.length) lines.push(`Setlist: ${svc.setlist.map(songLabel).join(', ')}`);
    for (const role of state.roles) {
      const ids = assigned(svc, role.id).filter(Boolean);
      lines.push(`${role.name}: ${ids.length ? ids.map(name).join(', ') : 'OPEN'}`);
    }
  }
  return lines.join('\n');
}
