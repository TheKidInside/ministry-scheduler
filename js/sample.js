// Demo data so a first-time visitor sees a filled-in month. Fictional names only.
// Dates are built around the month you open the app in.

import {
  emptyState, generateMonthServices, autoFill, shiftMonth, toISO, daysInMonth, todayISO, weeksInMonth, newTask, SERIES_COLORS,
} from './model.js';

const PEOPLE = [
  ['Ana R.', ['opening-prayer', 'worship-team']],
  ['Ben C.', ['worship-leader', 'worship-team']],
  ['Carla M.', ['worship-team', 'opening-prayer']],
  ['Dan T.', ['tech']],
  ['Ella G.', ['tech', 'worship-team']],
  ['Felix S.', ['preacher', 'opening-prayer']],
  ['Grace L.', ['worship-leader', 'worship-team']],
  ['Hector V.', ['tech', 'opening-prayer']],
  ['Ivy D.', ['worship-team']],
  ['Pastor Jon', ['preacher']],
  ['Kim P.', ['opening-prayer', 'worship-team']],
];

const SERMONS_A = [
  ['Grace and Peace to You', 'Colossians 1:1-8'],
  ['The Supremacy of Christ', 'Colossians 1:15-20'],
  ['Rooted and Built Up', 'Colossians 2:6-15'],
  ['Set Your Minds Above', 'Colossians 3:1-4'],
  ['Put On Love', 'Colossians 3:12-17'],
  ['Devoted to Prayer', 'Colossians 4:2-6'],
  ['Faithful Friends', 'Colossians 4:7-18'],
];

const SERMONS_B = [
  ['The Lord Is My Shepherd', 'Psalm 23:1-6'],
  ['Wait for the Lord', 'Psalm 27:7-14'],
  ['Our Refuge and Strength', 'Psalm 46:1-11'],
  ['Why So Downcast?', 'Psalm 42:1-11'],
  ['From Where Comes My Help', 'Psalm 121:1-8'],
  ['Unshaken', 'Psalm 62:1-8'],
  ['Under His Wings', 'Psalm 91:1-16'],
];

// Public-domain hymns, with common keys.
const SONGS = [
  ['Holy, Holy, Holy', 'D'], ['Amazing Grace', 'G'], ['Be Thou My Vision', 'Eb'], ['It Is Well with My Soul', 'C'],
  ['Come Thou Fount', 'D'], ['Great Is Thy Faithfulness', 'D'], ['All Hail the Power of Jesus’ Name', 'G'],
  ['Crown Him with Many Crowns', 'D'], ['How Firm a Foundation', 'G'], ['Blessed Assurance', 'D'],
];

// The same few jobs every week; one is left unassigned so the Tasks tab shows what that looks like.
const WEEKLY_TASKS = [['Confirm the roster with the team', 'p7'], ['Send the slides to Tech', 'p2'], ['Print the bulletin', '']];

export function sampleState(now = new Date()) {
  const state = emptyState();
  state.settings.churchName = 'Grace Community Church';
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const prev = shiftMonth(y, m, -1);
  const next = shiftMonth(y, m, 1);

  state.people = PEOPLE.map(([name, roleIds], i) => ({
    id: `p${i + 1}`, name, roleIds, contact: '', unavailable: [],
  }));
  // One person away mid-month, so the conflict checker has something to protect.
  state.people[1].unavailable = [toISO(y, m, 15)];

  state.series = [
    {
      id: 'ser_a', name: 'Rooted', color: SERIES_COLORS[0],
      start: toISO(prev.y, prev.m, 1), end: toISO(y, m, 14),
      description: 'A walk through Colossians: who Christ is and what that changes.',
    },
    {
      id: 'ser_b', name: 'Unshaken: Psalms of Trust', color: SERIES_COLORS[1],
      start: toISO(y, m, 15), end: toISO(next.y, next.m, daysInMonth(next.y, next.m)),
      description: 'Six psalms for anxious seasons.',
    },
  ];

  for (const mo of [prev, { y, m }, next]) {
    state.services.push(...generateMonthServices(state, mo.y, mo.m));
  }

  const counters = { ser_a: 0, ser_b: 0 };
  const preachers = ['p10', 'p10', 'p6'];
  state.services = state.services.map((svc, i) => {
    const sid = svc.sermon.seriesId;
    const list = sid === 'ser_a' ? SERMONS_A : SERMONS_B;
    const [title, scripture] = list[counters[sid]++ % list.length] || ['', ''];
    const withPreacher = { ...svc, assignments: { preacher: [preachers[i % preachers.length]] }, sermon: { ...svc.sermon, title, scripture } };
    const filled = autoFill(state, withPreacher);
    filled.setlist = [0, 1, 2, 3].map(k => SONGS[(i * 3 + k) % SONGS.length]).map(([title, key]) => ({ title, key }));
    state.services[i] = filled; // later services see earlier loads when balancing
    return filled;
  });
  const today = todayISO(now);
  state.tasks = weeksInMonth(y, m, state.settings.defaultDay).flatMap(({ end }) => WEEKLY_TASKS.map(([title, person], i) => ({
    ...newTask({ week: end, title, assignees: person ? [person] : [] }), id: `task_${end}_${i}`, done: end < today,
  })));
  return state;
}
