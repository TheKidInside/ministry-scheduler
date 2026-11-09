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

test('announcementBlocks: a column per service, a row per role, names only', () => {
  const s = base();
  s.services = [
    { ...M.newService({ date: '2026-11-08' }), assignments: { 'worship-team': ['a', 'b'], preacher: ['gone', 'c'] } },
    M.newService({ date: '2026-11-01' }),
    M.newService({ date: '2026-12-06' }),
  ];
  const [block, ...rest] = M.announcementBlocks(s, 2026, 11);
  assert.equal(rest.length, 0);
  assert.deepEqual(block.services.map(x => x.date), ['2026-11-01', '2026-11-08']);
  assert.deepEqual(block.rows.map(r => r.role.id), s.roles.map(r => r.id));
  const row = id => block.rows.find(r => r.role.id === id).cells;
  assert.deepEqual(row('worship-team'), [[], ['Ana', 'Ben']]);
  assert.deepEqual(row('preacher'), [[], ['Cy']], 'a removed person is not announced');
  assert.deepEqual(M.announcementBlocks(s, 2027, 1), [], 'an empty month has nothing to announce');
});

test('announcementBlocks keeps tables phone-sized by splitting busy months evenly', () => {
  const sizes = n => {
    const s = base();
    s.services = Array.from({ length: n }, (_, i) => M.newService({ date: M.toISO(2026, 11, i + 1) }));
    return M.announcementBlocks(s, 2026, 11).map(b => b.services.length);
  };
  assert.deepEqual(sizes(4), [4]);
  assert.deepEqual(sizes(5), [5]);
  assert.deepEqual(sizes(6), [3, 3]);
  assert.deepEqual(sizes(7), [4, 3]);
  assert.deepEqual(sizes(11), [4, 4, 3]);
  const s = base();
  s.services = Array.from({ length: 5 }, (_, i) => M.newService({ date: M.toISO(2026, 11, i + 1) }));
  assert.deepEqual(M.announcementBlocks(s, 2026, 11, 4).map(b => b.services.length), [3, 2], 'a phone takes 4 at most');
});

test('findPersonForUser prefers a direct link, then the sign-in email', () => {
  const people = [{ id: 'x', name: 'X', email: 'me@a.co' }, { id: 'y', name: 'Y', email: '', userId: 'u1' }];
  assert.equal(M.findPersonForUser(people, { uid: 'u1', email: 'me@a.co' }).id, 'y');
  assert.equal(M.findPersonForUser(people, { uid: 'u2', email: 'ME@a.co' }).id, 'x');
  assert.equal(M.findPersonForUser(people, { uid: 'u3', email: '' }), null);
  assert.equal(M.findPersonForUser(people, null), null);
});

test('parseInvite reads links and bare ids, with or without a minister', () => {
  const id = 'AbCdEfGhIj123';
  assert.deepEqual(M.parseInvite(id), { churchId: id, personId: '' });
  assert.deepEqual(M.parseInvite(` https://x.app/#join=${id} `), { churchId: id, personId: '' });
  assert.deepEqual(M.parseInvite(`https://x.app/#join=${id}&as=p_m3x9`), { churchId: id, personId: 'p_m3x9' });
  assert.equal(M.parseInvite('short'), null);
  assert.equal(M.parseInvite(`#join=${id}&as=p1&x=yyyyyyyyyyyy`), null);
  assert.equal(M.parseInvite(''), null);
});

test('normalizeState keeps a minister\'s account link', () => {
  const out = M.normalizeState({ people: [{ id: 'a', name: 'A', userId: 'u1' }, { id: 'b', name: 'B' }] });
  assert.deepEqual(out.people.map(p => p.userId), ['u1', '']);
});

test('only small JPEG profile photos are kept', () => {
  const ok = 'data:image/jpeg;base64,AAAA';
  assert.ok(M.isPhoto(ok));
  assert.ok(!M.isPhoto('https://evil.example/pixel.gif'));
  assert.ok(!M.isPhoto('data:image/svg+xml;base64,AAAA'));
  assert.ok(!M.isPhoto(`data:image/jpeg;base64,${'A'.repeat(40000)}`));
  const out = M.normalizeState({ people: [{ id: 'a', name: 'A', photo: ok }, { id: 'b', name: 'B', photo: 'javascript:1' }] });
  assert.deepEqual(out.people.map(p => p.photo), [ok, '']);
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

test('conflicts: unavailable, not qualified, twice in one role', () => {
  const s = base();
  const svc = { ...M.newService({ date: '2026-11-15' }), assignments: { 'worship-team': ['a', 'b', 'b'], preacher: ['a'] } };
  const types = M.serviceConflicts(s, svc).map(c => `${c.type}:${c.personId}:${c.roleId}`).sort();
  assert.deepEqual(types, [
    'double-booked:b:worship-team',
    'not-qualified:a:preacher',
    'unavailable:a:preacher',
    'unavailable:a:worship-team',
  ]);
  const twice = M.serviceConflicts(s, svc).find(c => c.type === 'double-booked');
  assert.equal(M.describeConflict(s, twice), 'Ben is on Worship Team twice');
});

test('ministerSync links the account and email and follows the chosen name', () => {
  const user = { uid: 'u1', email: 'Ana@Example.com' };
  const sync = (person, others = []) => M.ministerSync([person, ...others], person, user, 'Ana Reyes');
  assert.deepEqual(sync({ id: 'a', name: 'Ana', email: 'ana@example.com', userId: '' }), [{ userId: 'u1', email: 'ana@example.com' }, { name: 'Ana Reyes' }], 'matched by email');
  assert.deepEqual(sync({ id: 'a', name: 'Ana', contact: 'ana@example.com', email: '', userId: '' })[0], { userId: 'u1', email: 'ana@example.com' }, 'an older profile with the email in contact');
  assert.deepEqual(sync({ id: 'a', name: 'Ana Reyes', email: '', userId: 'u1' }), [{ userId: 'u1', email: 'ana@example.com' }], 'linked by account, no email yet');
  assert.deepEqual(sync({ id: 'a', name: 'Ana Reyes', email: 'ana@example.com', userId: 'u1' }), [], 'nothing to do');
  assert.deepEqual(sync({ id: 'a', name: 'Ana', email: '', userId: 'u1' }, [{ id: 'b', name: 'Other', email: 'ana@example.com' }]), [{ name: 'Ana Reyes' }], 'never takes an email another minister uses');
  assert.deepEqual(sync({ id: 'a', name: 'Ana', email: 'ana@example.com', userId: 'u2' }), [], 'someone else\'s minister is left alone');
});

test('songRole is for people set up as a Worship Leader or on Tech, however the role is named', () => {
  const s = { roles: [...M.DEFAULT_ROLES, { id: 'role_x', name: 'tech crew', slots: 1 }, { id: 'role_y', name: 'Technology-free zone?', slots: 1 }] };
  assert.equal(M.songRole(s, { roleIds: ['worship-leader'] }).id, 'worship-leader');
  assert.equal(M.songRole(s, { roleIds: ['preacher', 'tech'] }).id, 'tech');
  assert.equal(M.songRole(s, { roleIds: ['role_x'] }).id, 'role_x');
  assert.equal(M.songRole(s, { roleIds: ['worship-team', 'preacher'] }), null, 'the team and the preacher are not');
  assert.equal(M.songRole(s, { roleIds: [] }), null);
});

test('one person can hold several roles on a service without a clash', () => {
  const s = base();
  s.people.find(p => p.id === 'b').roleIds.push('tech');
  const svc = { ...M.newService({ date: '2026-11-15' }), assignments: { 'worship-team': ['b'], tech: ['b'] } };
  s.services = [svc];
  assert.deepEqual(M.serviceConflicts(s, svc), []);
  assert.equal(M.monthLoad(s.services, 'b', 2026, 11), 1, 'still one service');
  assert.deepEqual(M.personSchedule(s, 'b')[0].roles.map(r => r.id), ['worship-team', 'tech']);
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

test('a sign-in email finds its minister, including emails kept in the old contact field', () => {
  const people = [
    { id: 'a', name: 'Ana', email: 'Ana@Example.com', contact: '' },
    { id: 'b', name: 'Ben', contact: ' ben@example.com ' },
    { id: 'c', name: 'Cy', contact: '+63 917 555 0101' },
  ];
  assert.equal(M.findPersonByEmail(people, 'ana@example.COM').id, 'a');
  assert.equal(M.findPersonByEmail(people, 'BEN@example.com').id, 'b');
  assert.equal(M.findPersonByEmail(people, ''), null);
  assert.equal(M.personPhone(people[2]), '+639175550101');
  assert.equal(M.personPhone(people[1]), '');
  assert.equal(M.normalizeState({ people: [{ id: 'x', name: 'X', email: ' X@Y.com ' }] }).people[0].email, 'x@y.com');
});

test('addedAssignments reports only people newly put on a service', () => {
  const before = { ...M.newService({ date: '2026-11-01' }), assignments: { tech: ['b'], preacher: ['c'] } };
  const after = { ...before, assignments: { tech: ['b', 'a'], preacher: ['c'], 'worship-team': ['b'] } };
  const added = M.addedAssignments(before, after);
  assert.deepEqual([...added.entries()], [['a', ['tech']], ['b', ['worship-team']]]);
  assert.equal(M.addedAssignments(before, before).size, 0);
  assert.equal(M.addedAssignments(null, before).size, 2);
  assert.equal(M.addedAssignments(before, { ...before, date: '2026-11-08' }).size, 2, 'a new date is news for everyone');
});

test('upcoming assignments carry keys that change when the date moves', () => {
  const s = base();
  const svc = { ...M.newService({ date: '2026-11-08', time: '09:30' }), assignments: { tech: ['b'], 'worship-team': ['b'] } };
  s.services = [svc];
  const up = M.upcomingFor(s, 'b', '2026-11-01');
  assert.equal(up.length, 1);
  assert.deepEqual(up[0].keys, [`${svc.id}:worship-team:2026-11-08`, `${svc.id}:tech:2026-11-08`]);
  assert.equal(M.upcomingFor(s, 'b', '2026-11-09').length, 0);
  const msg = M.assignmentMessage(s, { name: 'Ben Cruz' }, svc, ['worship-team', 'tech'], 'https://x.test/');
  assert.match(msg, /^Hi Ben, you're on Worship Team and Tech \(Sound & Slides\) for Sunday Service on Sunday 8 November, 09:30\./);
  assert.match(msg, /Your schedule: https:\/\/x\.test\//);
});

test('setlists are cleaned on load, remembered as a library, and printed in the roster', () => {
  const s = M.normalizeState({ services: [
    { id: 'x1', date: '2026-11-01', setlist: [{ title: ' Amazing Grace ', key: 'G' }, { title: '' }, null, { title: 'Be Thou My Vision' }] },
    { id: 'x2', date: '2026-11-08', setlist: [{ title: 'amazing grace', key: 'A' }] },
    { id: 'x3', date: '2026-11-15' },
  ] });
  assert.deepEqual(s.services[0].setlist, [{ title: 'Amazing Grace', key: 'G' }, { title: 'Be Thou My Vision', key: '' }]);
  assert.deepEqual(s.services[2].setlist, []);
  const lib = M.songLibrary(s.services);
  assert.deepEqual(lib.map(x => [x.title, x.key, x.times]), [['amazing grace', 'A', 2], ['Be Thou My Vision', '', 1]]);
  assert.match(M.rosterText(s, 2026, 11), /Setlist: Amazing Grace \(G\), Be Thou My Vision/);
  assert.deepEqual(M.newService({ date: '2026-11-01' }).setlist, []);
});

test('a week runs up to the usual service day, and a month has one per service day', () => {
  assert.deepEqual(M.weeksInMonth(2026, 11, 0).map(w => w.end), ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
  assert.equal(M.weeksInMonth(2026, 11, 0)[0].start, '2026-10-26', 'a week can start in the month before');
  assert.equal(M.weekOfDate('2026-11-15', 0), '2026-11-15');
  assert.equal(M.weekOfDate('2026-11-15', 6), '2026-11-14', 'changing the usual day moves a task to the nearest one');
  assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
});

test('tasks are cleaned on load, and kept in the order they were added', () => {
  const s = M.normalizeState({ tasks: [
    { id: 't2', week: '2026-11-15', title: ' Later ', assignees: ['a', 'a', null], done: 'yes' },
    { id: 't1', week: '2026-11-15', title: 'First', assignees: 'a', notes: 5, done: true },
    { id: 't3', week: 'nope', title: 'Bad week' }, { id: 't4', week: '2026-11-15', title: '  ' }, null,
  ] });
  assert.deepEqual(s.tasks.map(t => t.id), ['t2', 't1']);
  assert.deepEqual(s.tasks[0], { id: 't2', week: '2026-11-15', title: 'Later', assignees: ['a'], notes: '', done: false });
  assert.deepEqual(s.tasks[1].assignees, []);
  assert.deepEqual(M.tasksInWeek(s.tasks, '2026-11-15').map(t => t.id), ['t1', 't2']);
  assert.deepEqual(M.normalizeState({}).tasks, [], 'an older backup has no tasks');
});

test('a person sees their unfinished tasks from this week on, and only new people are told', () => {
  const s = base();
  const t = id => ({ id, week: '2026-11-15', title: id, assignees: ['b'], notes: '', done: false });
  s.tasks = [t('open'), { ...t('finished'), done: true }, { ...t('past'), week: '2026-11-08' }, { ...t('other'), assignees: ['a'] }];
  const mine = M.tasksFor(s, 'b', '2026-11-10');
  assert.deepEqual(mine.map(x => x.task.id), ['open']);
  assert.deepEqual(mine[0].keys, ['task:open:2026-11-15']);
  assert.equal(M.tasksFor(s, 'b', '2026-11-15').length, 1, 'still due on the service day itself');
  const before = t('x');
  assert.deepEqual(M.addedTaskPeople(null, before), ['b']);
  assert.deepEqual(M.addedTaskPeople(before, { ...before, assignees: ['b', 'c'] }), ['c']);
  assert.deepEqual(M.addedTaskPeople(before, { ...before, week: '2026-11-22' }), ['b'], 'a new week is news');
  const msg = M.taskMessage(s, { name: 'Ben Cruz' }, { ...before, title: 'Print it', notes: 'A4 please' }, 'https://x.test/');
  assert.match(msg, /^Hi Ben, you have a task for the week of Sunday 15 November: Print it\.\nA4 please\n/);
});

test('deleting a person takes them off tasks and leaves other tasks untouched', () => {
  const kept = { id: 'k', week: '2026-11-15', title: 'k', assignees: ['a'], notes: '', done: false };
  const after = M.removePersonFromTasks([kept, { ...kept, id: 'c', assignees: ['a', 'b'] }], 'b');
  assert.equal(after[0], kept);
  assert.deepEqual(after[1].assignees, ['a']);
});

test('the sample church has weekly tasks that survive normalizing', () => {
  const s = sampleState(new Date(2026, 10, 10));
  assert.equal(M.normalizeState(s).tasks.length, s.tasks.length);
  assert.ok(s.tasks.length >= 12);
  assert.ok(s.tasks.every(t => t.assignees.every(id => s.people.some(p => p.id === id))));
  assert.ok(s.tasks.some(t => t.done) && s.tasks.some(t => !t.done));
});

const redesign = () => {
  const s = base();
  s.roles = [
    { id: 'preacher', name: 'Preacher', slots: 1 },
    { id: 'bible', name: 'Bible reading', slots: 1 },
    { id: 'keys', name: 'Keys', slots: 2 },
    { id: 'sound', name: 'Sound', slots: 1 },
    { id: 'kids', name: 'Kids church', slots: 1 },
  ];
  s.people = [
    { id: 'a', name: 'Ana R.', roleIds: ['bible', 'keys'], unavailable: ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2027-01-03'] },
    { id: 'b', name: 'Ben T.', roleIds: ['keys', 'kids'], unavailable: [] },
    { id: 'c', name: 'Cy L.', roleIds: ['preacher'], unavailable: [] },
  ];
  return s;
};

test('monthSummary counts slots, open places and one clash per person per role', () => {
  const s = redesign();
  s.services = [
    { ...M.newService({ date: '2026-11-08' }), assignments: { preacher: ['c'], keys: ['b', 'b'], kids: ['b'] } },
    { ...M.newService({ date: '2026-11-22' }), assignments: { bible: ['a'], sound: ['a'] } }, // away and not set up: one clash per role
    M.newService({ date: '2026-12-06' }),
  ];
  const sum = M.monthSummary(s, 2026, 11);
  assert.equal(sum.services, 2);
  assert.equal(sum.filled, 6);
  assert.equal(sum.total, 12);
  assert.equal(sum.open, 6);
  assert.equal(sum.clashes.length, 3);
  assert.equal(M.clashSentence(s, sum.clashes[0].service, sum.clashes[0].clash), 'Ben T. on keys, Sun 8 Nov: listed twice in this role.');
  assert.equal(M.clashSentence(s, sum.clashes[1].service, sum.clashes[1].clash), 'Ana R. on bible reading, Sun 22 Nov: away 20–23 Nov.');
});

test('awayRanges joins consecutive dates and drops the past', () => {
  const dates = ['2026-11-23', '2026-11-20', '2026-11-21', '2026-11-22', '2027-01-03', '2026-10-01'];
  assert.deepEqual(M.awayRanges(dates, '2026-11-09').map(M.formatRange), ['20–23 Nov', '3 Jan']);
  assert.equal(M.formatRange({ start: '2026-11-30', end: '2026-12-02' }).replace(/\s+/g, ' '), '30 Nov – 2 Dec');
});

test('autoFillMonth spreads the month, skips the past and leaves existing picks', () => {
  const s = redesign();
  s.services = [
    M.newService({ date: '2026-11-01' }),
    { ...M.newService({ date: '2026-11-08' }), assignments: { keys: ['b'] } },
    M.newService({ date: '2026-11-15' }),
  ];
  const { changed, filled } = M.autoFillMonth(s, 2026, 11, '2026-11-02');
  assert.deepEqual(changed.map(x => x.date), ['2026-11-08', '2026-11-15']);
  assert.deepEqual(changed[0].assignments, { preacher: ['c'], bible: ['a'], keys: ['b'] });
  assert.ok(filled >= 3);
  assert.equal(s.services[1].assignments.keys.length, 1, 'the original state is untouched');
  assert.equal(M.autoFillMonth({ ...s, people: [] }, 2026, 11).changed.length, 0);
});

test('assignOptions splits who can and cannot take a place', () => {
  const s = redesign();
  const target = { ...M.newService({ date: '2026-11-22' }), assignments: { keys: ['b'] } };
  s.services = [target, { ...M.newService({ date: '2026-11-08' }), assignments: { keys: ['b'] } }];
  s.people.push({ id: 'd', name: 'Dee', roleIds: ['keys'], unavailable: [] });
  const open = M.assignOptions(s, target, 'keys', 1);
  assert.deepEqual(open.available.map(x => [x.person.name, x.note]), [['Dee', 'Free this Sunday']]);
  assert.deepEqual(open.unavailable.map(x => [x.person.name, x.note]), [['Ana R.', 'Away 20–23 Nov'], ['Ben T.', 'Already on Keys']]);
  const filled = M.assignOptions(s, target, 'keys', 0);
  assert.equal(filled.current, 'b');
  assert.deepEqual(filled.available.map(x => [x.person.name, x.note]), [['Ben T.', 'Also rostered 8 Nov'], ['Dee', 'Free this Sunday']]);
});

test('assignOptions lets someone take a second role, after those with nothing that day', () => {
  const s = redesign();
  s.people.find(p => p.id === 'b').roleIds.push('bible');
  s.people.find(p => p.id === 'c').roleIds.push('bible');
  s.people.push({ id: 'd', name: 'Dee', roleIds: ['bible', 'keys'], unavailable: [] });
  const target = { ...M.newService({ date: '2026-11-08' }), assignments: { keys: ['b'], preacher: ['c'] } };
  s.services = [target];
  const { available, unavailable } = M.assignOptions(s, target, 'bible', 0);
  assert.deepEqual(available.map(x => [x.person.name, x.note]), [
    ['Ana R.', 'Free this Sunday'], ['Dee', 'Free this Sunday'],
    ['Ben T.', 'Also on Keys this service'], ['Cy L.', 'Also on Preacher this service'],
  ]);
  assert.deepEqual(unavailable, []);
});

test('ministerMonth lights a dot per service and calls three of four busy', () => {
  const list = ['01', '08', '15', '22'].map((d, i) => ({ ...M.newService({ date: `2026-11-${d}` }), assignments: i < 3 ? { keys: ['b'] } : {} }));
  assert.deepEqual(M.ministerMonth(list, 'b', 2026, 11), { dots: [true, true, true, false], load: 3, total: 4, busy: true });
  assert.equal(M.ministerMonth(list.slice(0, 2), 'b', 2026, 11).busy, false);
  assert.equal(M.ministerMonth([], 'b', 2026, 11).busy, false);
});

test('roleGroups sorts free-text roles into the phone sections', () => {
  const names = groups => groups.map(g => [g.name, g.roles.map(r => r.name)]);
  assert.deepEqual(names(M.roleGroups(M.DEFAULT_ROLES)), [
    ['Preaching', ['Preacher']], ['Worship', ['Worship Leader', 'Worship Team']], ['Tech', ['Tech (Sound & Slides)']], ['Welcome & care', ['Opening Prayer']],
  ]);
  assert.deepEqual(names(M.roleGroups(redesign().roles)).map(g => g[0]), ['Preaching', 'Worship', 'Tech', 'Welcome & care']);
  assert.equal(M.roleGroups([{ id: 'x', name: 'Closing Prayer' }])[0].name, 'Welcome & care');
  assert.equal(M.roleGroups([{ id: 'x', name: 'Singers' }])[0].name, 'Worship');
});

test('shortScripture only drops a repeated book name', () => {
  assert.equal(M.shortScripture('Romans', 'Romans 8:1-11'), '8:1-11');
  assert.equal(M.shortScripture('Advent', 'Isaiah 9:2-7'), 'Isaiah 9:2-7');
  assert.equal(M.shortScripture('', 'Romans 8'), 'Romans 8');
});

test('seriesStatuses and the timeline come from the dates', () => {
  const s = redesign();
  s.series = [
    { id: 'old', name: 'Old', start: '2026-01-01', end: '2026-02-01' },
    { id: 'now', name: 'Romans', start: '2026-09-27', end: '2026-11-22' },
    { id: 'soon', name: 'Advent', start: '2026-11-29', end: '2026-12-20' },
    { id: 'later', name: 'Psalms', start: '2027-01-03', end: '2027-02-07' },
    { id: 'booked', name: 'Acts', start: '2027-01-10', end: '2027-01-24' },
    { id: 'undated', name: 'Someday', start: '', end: '' },
  ];
  s.services = [{ ...M.newService({ date: '2027-01-10' }), sermon: { title: '', scripture: '', seriesId: 'booked' }, assignments: { preacher: ['c'] } }];
  assert.deepEqual([...M.seriesStatuses(s, '2026-11-09')], [['old', 'past'], ['now', 'current'], ['soon', 'next'], ['later', 'draft'], ['booked', 'planned'], ['undated', 'draft']]);
  const t = M.seriesTimeline(s.series, '2026-11-09');
  assert.deepEqual(t.heads.map(h => h.label), ['Sep', 'Oct', 'Nov', 'Dec', 'Jan 2027', 'Feb']);
  assert.deepEqual(t.rows.map(r => r.series.id), ['now', 'soon', 'later', 'booked']);
  assert.ok(t.today > 30 && t.today < 45);
  assert.ok(t.rows.every(r => r.width > 0 && r.left + r.width <= 100.001));
  const open = { ...s, series: [{ id: 'x', start: '2027-01-01', end: '' }, { id: 'y', start: '2027-02-01', end: '2027-03-01' }] };
  assert.deepEqual([...M.seriesStatuses(open, '2026-11-09')], [['x', 'draft'], ['y', 'next']], 'a series with no end date cannot be up next');
});
