// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import { sampleState } from '../js/sample.js';

const base = () => {
  const s = M.emptyState();
  s.people = [
    { id: 'a', name: 'Ana', roleIds: ['worship-team', 'opening-prayer'], unavailable: ['2026-11-15'] },
    { id: 'b', name: 'Ben', roleIds: ['worship-team', 'tech'], unavailable: [] },
    { id: 'c', name: 'Cy', roleIds: ['preacher'], unavailable: [] },
  ];
  return s;
};

test('month grid starts on the right weekday and covers every day', () => {
  const g = M.monthGrid(2026, 11); // 1 Nov 2026 is a Sunday
  assert.equal(g[0][0], '2026-11-01');
  assert.equal(g.flat().filter(Boolean).length, 30);
  assert.ok(g.every(w => w.length === 7));
  assert.equal(M.monthGrid(2027, 2)[0].indexOf('2027-02-01'), 1); // Monday
});

test('shiftMonth wraps years both ways', () => {
  assert.deepEqual(M.shiftMonth(2026, 12, 1), { y: 2027, m: 1 });
  assert.deepEqual(M.shiftMonth(2026, 1, -1), { y: 2025, m: 12 });
});

test('isValidISO rejects impossible dates', () => {
  assert.ok(M.isValidISO('2028-02-29'));
  assert.ok(!M.isValidISO('2027-02-29'));
  assert.ok(!M.isValidISO('2026-13-01'));
  assert.ok(!M.isValidISO('nope'));
});

test('generateMonthServices adds each Sunday once and tags covering series', () => {
  const s = base();
  s.series = [{ id: 's1', name: 'Rooted', start: '2026-11-10', end: '2026-11-30', color: '#000' }];
  const made = M.generateMonthServices(s, 2026, 11);
  assert.deepEqual(made.map(x => x.date), ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
  assert.equal(made[0].sermon.seriesId, '');
  assert.equal(made[2].sermon.seriesId, 's1');
  s.services = made;
  assert.equal(M.generateMonthServices(s, 2026, 11).length, 0);
});

test('conflicts: unavailable, not qualified, double booked', () => {
  const s = base();
  const svc = { ...M.newService({ date: '2026-11-15' }), assignments: { 'worship-team': ['a', 'b'], tech: ['b'], preacher: ['a'] } };
  const types = M.serviceConflicts(s, svc).map(c => `${c.type}:${c.personId}:${c.roleId}`).sort();
  assert.deepEqual(types, [
    'double-booked:a:preacher',
    'double-booked:b:tech',
    'not-qualified:a:preacher',
    'unavailable:a:preacher',
    'unavailable:a:worship-team',
  ]);
});

test('autoFill keeps existing picks, skips away people, never double books', () => {
  const s = base();
  const svc = { ...M.newService({ date: '2026-11-15' }), assignments: { preacher: ['c'] } };
  const filled = M.autoFill(s, svc);
  assert.deepEqual(filled.assignments.preacher, ['c']);
  assert.ok(!M.peopleOnService(filled).has('a'), 'Ana is away on the 15th');
  assert.deepEqual(filled.assignments['worship-team'], ['b']);
  assert.equal(filled.assignments.tech, undefined, 'Ben is already on worship team');
  assert.equal(M.serviceConflicts(s, filled).length, 0);
});

test('autoFill balances load across the month', () => {
  const s = base();
  s.people.push({ id: 'd', name: 'Dee', roleIds: ['opening-prayer'], unavailable: [] });
  const first = M.autoFill(s, M.newService({ date: '2026-11-01' }));
  s.services = [first];
  const second = M.autoFill(s, M.newService({ date: '2026-11-08' }));
  assert.notDeepEqual(first.assignments['opening-prayer'], second.assignments['opening-prayer']);
});

test('series parts and month summary', () => {
  const s = base();
  s.series = [{ id: 's1', name: 'Rooted', start: '2026-10-01', end: '2026-11-30', color: '#000' }];
  s.services = ['2026-10-25', '2026-11-01', '2026-11-08'].map(d => M.newService({ date: d, seriesId: 's1' }));
  assert.deepEqual(M.seriesPart(s.services, s.services[2]), { n: 3, of: 3 });
  const nov = M.monthSeries(s, 2026, 11);
  assert.equal(nov.length, 1);
  assert.equal(nov[0].count, 2);
  assert.equal(M.seriesPart(s.services, M.newService({ date: '2026-11-01' })), null);
});

test('removing a person or role leaves no dangling ids', () => {
  const svc = { ...M.newService({ date: '2026-11-01' }), assignments: { tech: ['a', 'b'], preacher: ['c'] } };
  const [noA] = M.removePersonEverywhere([svc], 'a');
  assert.deepEqual(noA.assignments.tech, ['b']);
  const [noTech] = M.removeRoleEverywhere([svc], 'tech');
  assert.ok(!('tech' in noTech.assignments));
  const untouched = M.removePersonEverywhere([svc], 'zzz');
  assert.equal(untouched[0], svc, 'unchanged services keep identity so only real changes get saved');
});

test('normalizeState rejects junk and fills defaults', () => {
  assert.throws(() => M.normalizeState(null));
  assert.throws(() => M.normalizeState({ people: 'x' }));
  const s = M.normalizeState({ services: [{ date: '2026-11-01' }, { date: 'bad' }] });
  assert.equal(s.services.length, 1);
  assert.equal(s.roles.length, M.DEFAULT_ROLES.length);
  assert.equal(s.services[0].sermon.title, '');
});

test('sample data has no conflicts and every service has a preacher', () => {
  const s = sampleState(new Date(2026, 10, 8));
  assert.ok(s.services.length >= 12);
  for (const svc of s.services) {
    assert.equal(M.serviceConflicts(s, svc).length, 0, svc.date);
    assert.equal(M.assigned(svc, 'preacher').length, 1);
    assert.ok(svc.sermon.title && svc.sermon.seriesId);
  }
});

test('roles keep their order through normalizeState', () => {
  const s = M.normalizeState({ roles: [{ id: 'b', name: 'B', order: 1 }, { id: 'a', name: 'A', order: 0 }] });
  assert.deepEqual(s.roles.map(r => r.id), ['a', 'b']);
  assert.deepEqual(M.normalizeState({}).roles.map(r => r.order), [0, 1, 2, 3, 4]);
});

test('rosterText lists every role and marks gaps', () => {
  const s = base();
  s.services = [{ ...M.newService({ date: '2026-11-01', time: '09:30' }), assignments: { preacher: ['c'] }, sermon: { title: 'T', scripture: 'John 1:1', seriesId: '' } }];
  const text = M.rosterText(s, 2026, 11);
  assert.match(text, /Preacher: Cy/);
  assert.match(text, /Tech \(Sound & Slides\): OPEN/);
  assert.match(text, /Sermon: T \(John 1:1\)/);
});

test('normalizeState coerces hostile shapes instead of saving them', () => {
  const s = M.normalizeState({
    roles: [{ id: 'constructor', name: 'Odd', slots: 'x' }],
    people: [{ id: 'p1', name: 'Ann', roleIds: null, unavailable: [null, '2026-02-30', '2026-11-01'] }],
    series: [{ id: 's', name: 'S', color: 'red;background:url(x)' }],
    services: [{ date: '2026-11-01', assignments: { preacher: 'p1', constructor: null }, sermon: { title: 5 } }],
  });
  assert.deepEqual(s.people[0].roleIds, []);
  assert.deepEqual(s.people[0].unavailable, ['2026-11-01']);
  assert.equal(s.roles[0].slots, 1);
  assert.match(s.series[0].color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(s.services[0].assignments.preacher, []);
  assert.equal(s.services[0].sermon.title, '5');
  assert.deepEqual(M.assigned({ assignments: {} }, 'constructor'), []);
  assert.equal(s.settings.seeded, true);
  assert.doesNotThrow(() => M.serviceConflicts(s, s.services[0]));
});
