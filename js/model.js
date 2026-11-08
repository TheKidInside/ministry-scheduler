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

// How many services a person is on in a month (a person on two roles in one service counts once).
export function monthLoad(services, personId, y, m) {
  return servicesInMonth(services, y, m).filter(s => peopleOnService(s).has(personId)).length;
}

// Every problem on one service. type: unavailable | not-qualified | double-booked | unknown-person
export function serviceConflicts(state, service) {
  const people = new Map(state.people.map(p => [p.id, p]));
  const seen = new Map(); // personId -> first roleId
  const out = [];
  for (const role of state.roles) {
    for (const pid of assigned(service, role.id)) {
      if (!pid) continue;
      const person = people.get(pid);
      if (!person) { out.push({ type: 'unknown-person', roleId: role.id, personId: pid }); continue; }
      if (isUnavailable(person, service.date)) out.push({ type: 'unavailable', roleId: role.id, personId: pid });
      if (!canServe(person, role.id)) out.push({ type: 'not-qualified', roleId: role.id, personId: pid });
      if (seen.has(pid)) out.push({ type: 'double-booked', roleId: role.id, personId: pid, otherRoleId: seen.get(pid) });
      else seen.set(pid, role.id);
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
    case 'double-booked': {
      const other = state.roles.find(r => r.id === c.otherRoleId);
      return `${name} is on both ${other ? other.name : 'another role'} and ${roleName}`;
    }
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
      id: str(p.id), name: str(p.name), contact: str(p.contact),
      roleIds: ids(p.roleIds), unavailable: ids(p.unavailable).filter(isValidISO),
    })),
    series: arr(raw.series, 'series').filter(x => x && str(x.id) && str(x.name)).map(x => ({
      id: str(x.id), name: str(x.name), description: str(x.description),
      color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : SERIES_COLORS[0],
      start: isValidISO(x.start) ? x.start : '', end: isValidISO(x.end) ? x.end : '',
    })),
    services,
  };
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
    for (const role of state.roles) {
      const ids = assigned(svc, role.id).filter(Boolean);
      lines.push(`${role.name}: ${ids.length ? ids.map(name).join(', ') : 'OPEN'}`);
    }
  }
  return lines.join('\n');
}
