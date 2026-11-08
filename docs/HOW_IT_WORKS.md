# Ministry Scheduler — How It Works (a learning walkthrough)

This doc explains **how the app is built and why**, then walks file by file through
the logic. Read it next to the code; every section links to the file it describes.

> How to read it: skim **Part 1** (the mental model), then **Part 2** (the few
> techniques that repeat everywhere). **Part 3** goes file by file. **Part 4** traces
> one click (saving a sermon) through every layer. **Part 5** has recipes for common
> changes, and **Part 6** covers the Firebase step.

---

## Part 0 — Run it

```
start.cmd                         # serves on http://localhost:8795/ and opens the browser
node --test tests/model.test.mjs  # logic tests (no browser)
py -3 tests\cloud_e2e.py          # two-device sync test against the Firebase emulators (see FIREBASE.md)
py -3 tests\e2e.py                # clicks through the real UI in headless Chromium (server must be running)
```

No install and no build step. It is plain HTML, CSS and JavaScript modules. It has to
be served over `http://` (not opened as a `file://`) because browsers block ES module
imports from files.

---

## Part 1 — The big picture

### 1.1 Three layers, one rule

```
  LOGIC     js/model.js     the church's rules: dates, conflicts, auto-fill, series parts
    │
  STORAGE   js/store.js     where data lives: localStorage (LocalStore)
            js/cloud.js     ...or Firestore when signed in to a church (FirebaseStore)
    │
  UI        js/app.js       draws the screens, handles clicks, opens the editors
            index.html, css/styles.css
```

**The rule: `model.js` never touches the page or the storage.** It takes plain data
in and gives plain data back. That's why `tests/model.test.mjs` can check
"Ana is away on the 15th, so auto-fill must skip her" in milliseconds without a
browser.

**The second rule: `app.js` never touches `localStorage` for schedule data.** It only
calls the store's methods (`putDoc`, `deleteDoc`, `replaceAll`...). Think of the store
as a power socket: signed out, the localStorage plug is in it; sign in to a church
and the Firebase plug goes in instead, without rewiring the house.

### 1.2 The data, in one picture

```
state
 ├─ settings   { churchName, defaultDay, defaultTime, serviceName }
 ├─ roles      [{ id:'preacher', name:'Preacher', slots:1 }, ...]   ← the schedule columns
 ├─ people     [{ id, name, contact (phone), email, roleIds:[...], unavailable:['2026-11-15'] }]
 ├─ series     [{ id, name, color, start, end, description }]
 ├─ services   [{ id, date:'2026-11-15', time, name,
                  assignments: { 'worship-team': ['p1','p3'], preacher: ['p10'] },
                  sermon: { title, scripture, seriesId },
                  setlist: [{ title:'Amazing Grace', key:'G' }, ...],
                  notes }]
 └─ tasks      [{ id, week:'2026-11-15', title, assignees:['p1'], notes, done }]
```

A **service** is one gathering. `assignments` maps a role to the people on it. The
sermon lives on the service (not on the preacher), so the title and scripture stay
put even if you swap the preacher.

A sermon's **series** is chosen per service. When you create a service, or save a
series with dates, any untagged service in that date range picks up the series
automatically, and you can still override it by hand.

### 1.3 Why vanilla JS and no framework

The app is a handful of screens that redraw from data. A framework like React would
add a build step and a `node_modules` folder for little gain. GitHub Pages can serve
these files as they are, so pushing to `main` is the whole deploy.

---

## Part 2 — The techniques that repeat everywhere

### 2.1 Render = data → HTML string → swap it in

Every screen is a function that returns a string of HTML (`renderSchedule`,
`renderPreaching`...). `render()` picks the one for the current tab and does
`#view.innerHTML = ...`. No screen keeps its own state; after any change you call
`render()` and the whole view is rebuilt from `state`. It's like a whiteboard you
wipe and redraw, simple and impossible to get "out of sync".

### 2.2 Always escape user text: `esc()`

Anything a person typed (names, titles, scripture) goes through `esc()` before it
goes into HTML. Without it, a sermon titled `<img onerror=...>` would run as code.
Rule of thumb: if it came from a person or a file, wrap it in `esc()`.

### 2.3 One click listener for the whole page (event delegation)

Instead of attaching a listener to every button, `wire()` puts one `click`
listener on `document`. Buttons carry `data-action="edit-service" data-id="..."`.
The listener finds the nearest element with `data-action` and hands it to
`handleAction()`. Since screens are rebuilt with `innerHTML` all the time, this
is the only approach that doesn't need re-wiring after every render.

### 2.4 Dates are strings, maths is UTC

Dates are stored as `"2026-11-15"`. Whenever the code needs a weekday or a month
length it builds a `Date.UTC(...)`, so daylight-saving changes can never shift a
Sunday to a Saturday. Sorting is just string comparison, because `YYYY-MM-DD`
sorts correctly as text.

### 2.5 The `<dialog>` editor

All editors (service, minister, series) reuse one native `<dialog>`.
`openDialog(html, { onSubmit, onMount })` fills it, and the buttons say what they
mean through their `value`: `cancel` closes natively, `delete` skips validation,
and `save` validates then calls `onSubmit`. `onSubmit` returns `true` to keep the
dialog open (for example when the series end date is before its start).

---

## Part 3 — File by file

### 3.1 [js/model.js](../js/model.js) — the rules

- **Date helpers**: `toISO`, `parseISO`, `weekday`, `monthGrid` (a month as weeks of 7 cells, Sunday first), `shiftMonth`.
- **`generateMonthServices`**: one service for every usual service day in the month that doesn't have one yet, with the series pre-filled from date ranges.
- **`serviceConflicts`**: walks every role on a service and flags four problems: the person is *unavailable* that day, *not qualified* for the role, *double-booked* in two roles, or *no longer exists*.
- **`autoFill`**: fills empty slots only, never changes a pick you made. For each role it takes people who can serve, aren't away and aren't already on this service, sorted by **how often they've served this month**. That spreads the load.
- **`seriesPart` / `monthSeries`**: the "Part 3 of 6" numbering and the month legend on the Preaching tab.
- **`remove…Everywhere`**: deleting a person, role or series also cleans every service, so no ghost IDs are left. Services that didn't change keep the same object, so only real changes get saved.
- **`normalizeState`**: checks an imported backup file and fills in anything missing.
- **Setlist**: `SONG_KEYS` (the key dropdown), `songLabel` ("Amazing Grace (G)"), and `songLibrary`, every song sung so far with the key it was last sung in. The library feeds the title suggestions and fills in the key when you pick a song you've sung before.
- **Letting people know**: `addedAssignments(before, after)` finds who a save put on a service (moving the date counts everyone as new). `assignmentMessage` writes the text sent to them. `findPersonByEmail` links a sign-in to a minister (it also reads an email left in the old "Phone or email" field). `upcomingFor` gives your upcoming assignments, each with keys like `svc_x:tech:2026-11-15`, which is how the bell remembers what you've seen.

- **Weekly tasks**: a week is named by its service day, because the work is getting ready for that gathering. `weeksInMonth` lists a month's weeks, `tasksInWeek` fills one, and `weekOfDate` snaps a stored date to the nearest usual service day, so changing that day in Settings moves each task at most three days rather than losing it. `tasksFor` feeds the bell, and `addedTaskPeople` and `taskMessage` do for tasks what `addedAssignments` and `assignmentMessage` do for services.

### 3.2 [js/store.js](../js/store.js) — the socket

`LocalStore` keeps the full state under one localStorage key. Its methods are
async on purpose, even though localStorage is instant, because Firestore isn't, and
the app is already written to `await` them. Each write returns `true`/`false` so the
app can warn you when the browser isn't keeping data (private windows).
`subscribe()` listens for saves from another tab. The Firebase store uses the same
hook for live updates from other devices.

### 3.3 [js/sample.js](../js/sample.js) — the demo church

On first visit the app loads a fictional church (11 people, two series across
three months) so the screens explain themselves. It sets `settings.seeded`, so
**Clear everything** never brings the sample back.

### 3.4 [js/app.js](../js/app.js) — the screens

| Tab | Function | What it shows |
|---|---|---|
| Schedule | `renderSchedule`, `renderDay` | desktop: the month's numbers, a clash alert and the services × roles table. Phone: `renderDay` shows one service at a time, roles grouped by `M.roleGroups`. The Manage / Announcement toggle swaps in `renderAnnouncement` |
| Preaching | `renderPreaching` | a ribbon spanning each series' Sundays, then a card per sermon |
| Tasks | `renderTasks` | a card per week of the month: who has each task, a tick box, progress, and "This week" marked in gold |
| Ministers | `renderMinisters` | searchable directory sorted by role: away dates as ranges, a dot per service this month, next assignment. Filtering hides rows (`applyMinisterFilter`), so the search box is never redrawn under your fingers |
| Series | `renderSeries` | a six-month timeline (`M.seriesTimeline`) and a card per series, with Current / Up next / Planned / Draft / Finished worked out from its dates (`M.seriesStatuses`) |
| Settings | `renderSettings` | church name, usual day/time, roles (drag to reorder), theme, backup/import. Everything saves as you go |

**Assigning one place.** An amber Assign button (or any row on the phone) opens `openAssign`, a single-purpose sheet. `M.assignOptions` sorts the team into who can take it, least busy first, and who can't and why. Think of a substitute list rather than the whole staff file: the full service editor is still there for overrides, such as putting on someone not set up for the role.

**Who can change what.** Signed out, it's your own browser's copy and everything is editable. In a church, `canManage()` is true only for admins, and `preachesOn(svc)` for a service's own preacher. Every screen asks those two questions before drawing a button. That only tidies the page: the lock itself is in `firestore.rules`, as a shop's price tags don't stop anyone, the till does. A preacher's save goes through `patchDoc`, which touches only `sermon`, so it fits the one exception the rules allow.

**Roles save one document at a time.** `writeRoles` writes only what changed instead of `replaceAll`, which rewrites the whole church. Another editor's change can arrive while these rows are on screen, so absence proves nothing: a role only counts as deleted if its X was pressed here (`removedRoles`), and only a row added here can create one. Without that, renaming a role could silently delete one a colleague had just added.

Editors: `openServiceEditor`, `openPersonEditor`, `openSeriesEditor`, `openTaskEditor`, and `openSermonEditor` for a preacher. The service
editor recomputes conflicts on every change, so the warning box updates while you
pick people. In each role dropdown, people who can serve are listed first, with
"(away)" and "(2× this month)" hints. Its **Setlist** section has a row per song
(title, key, move up, remove); the rows are read back in order by `readServiceForm`.

**Your profile.** Signed in to a church, the account sheet edits your name and photo. Saving updates
`memberNames`/`memberPhotos` on the church (the rules allow only your own entry) and, if you are on the
roster, your minister's `name` and `photo`, which sync live. `shrinkPhoto` turns any picture into a
160px JPEG of a few KB stored as text on the document, like a passport photo stapled to the form
rather than a file kept in a separate cabinet: Firebase Storage needs a paid plan.

**Nothing gets dragged away.** On a phone every editor is a bottom sheet. The frame (`dialog`)
cannot scroll or slide, and a `touchmove` listener in `wire()` cancels any drag that isn't scrolling
`.dialog-body`, `.main` or a long textarea, on every page and sheet. Think of a clipboard held still
while only the page under the clip moves.

**How a minister signs in.** With no email, the minister editor offers three choices. *Send an
invite* saves them, then `openInvite` writes a link ending `#join=<church>&as=<minister>`;
`claimInvitedPerson` links whoever accepts it. *Registered user* lists this church's members and
stores their uid as `person.userId`. *Leave blank* does nothing. `M.findPersonForUser` decides who
"you" are: the `userId` link first, then the sign-in email. Firestore only records member names, not
emails, and a browser can't list every Firebase account, so "registered" means members of this church.

**Announcement view, for screenshots.** `renderAnnouncement` draws the month as one card that
carries its own church name and month, so a snip makes sense on its own in a group chat. It turns
the working table sideways: dates across, roles down. A phone screen can take many rows but few
columns, like a noticeboard that can grow downward but not past the wall. `M.announcementBlocks`
builds the data and splits a month of more than 5 services into several even tables. 

**Notifications, with no server.** Two halves:
1. *The person assigning.* When a save puts someone new on a service, `openNotify` opens "Let them know": one row per person with **Send** (the phone's share sheet, so Messenger, Viber, SMS and the rest), **Text** (when the profile has a phone) and **Email** (when it has an email). On a computer, Send becomes **Copy**.
2. *The person assigned.* Signed in to a church, the bell (`#mine-btn`) finds the minister whose email matches your sign-in (`me()`) and counts upcoming assignments you haven't opened (`renderMineButton`). A new one arriving live also shows a toast. Opening the list (`openMine`) marks them seen in `users/{uid}.seen`, so the count is the same on every device.

Neither half can reach a phone while the app is closed. That needs a server (see Part 6).

**Weekly tasks.** Think of a parish noticeboard with one column per Sunday: each job is pinned under the Sunday it serves. A task can go to several people. Saving one that gives someone new a task opens the same "Let them know" sheet as a service (`showNotify`), and it appears in their bell, with a key like `task:<id>:2026-11-15`, until it is ticked off. Tasks live in their own Firestore collection, so ticking one never rewrites a whole service.

The URL hash holds the tab and month (`#/preaching/2026-11`), plus `/announce` on the
Schedule's announcement view, so a link or bookmark opens the same view.

### 3.5 [css/styles.css](../css/styles.css)

The look is chapel navy, candle gold and linen, with Source Serif 4 for titles and Inter for the
working text. Colour carries a fixed meaning, like the lights on a dashboard: amber is always
"someone is needed", red is always "something clashes", and series colours are the only other
hue on the page. Tokens live on `:root`, with a dark set under `prefers-color-scheme` and a
`[data-theme]` override for the Light / Dark / Match device cards. Each series colour is passed
as a CSS variable (`style="--series:#6b4c9a"`); one rule tints ribbons, badges, stripes and
timeline bars with `color-mix`.

At 760px and under, the same app becomes a phone app rather than a squeezed page. The rail's
tabs turn into a white bottom bar. The header (`.page-head`) goes navy and sticks to the top of
`.main`, carrying whatever you navigate with: date pills on Schedule, series bars on Preaching,
search on Ministers (`phoneHeads` in app.js). Editors open as bottom sheets, and picking a
person takes the full screen. On a desktop they slide in from the right.

---

## Part 4 — One click, end to end: saving a sermon title

1. You click the 15 Nov row → the delegated listener sees `data-action="edit-service"` → `openServiceEditor(service)`.
2. The editor clones the service (`structuredClone`), so typing doesn't change the real data until you save.
3. You type a title and press **Save** → `openDialog`'s submit handler validates → `onSubmit` → `readServiceForm` builds the new service object from the inputs.
4. `putDoc('services', next)` replaces it in `state` **and** calls `store.putDoc`, which writes localStorage.
5. The dialog closes, `render()` redraws, and the sermon's card on Preaching shows the new title.

---

## Part 5 — Recipes

- **Add a default role**: add it to `DEFAULT_ROLES` in `model.js` (new churches only). Existing data: Settings → Roles → Add a role.
- **Change service day** (e.g. Saturday night): Settings → Usual service day. "Add every …" follows it.
- **New series colours**: edit `SERIES_COLORS` in `model.js`.
- **New collection** (like `tasks`): add it to `COLLECTIONS`, `emptyState` and `normalizeState`, and to the list in `firestore.rules`. Deploy the rules before the code, see [FIREBASE.md](FIREBASE.md).
- **New field on a service** (e.g. "Communion Sunday"): add it to `newService`, `normalizeState`, `serviceFormBody` and `readServiceForm`, then show it in a render function.

---

## Part 6 — What's deliberately left out (and where it'd go)

- **Firebase sync / logins**: built. `FirebaseStore` lives in `js/cloud.js` and has the same methods as `LocalStore`. `app.js` swaps `store` when you sign in to a church (`useStore`/`useChurch`). How it works, the rules and the emulator test are in [FIREBASE.md](FIREBASE.md).
- **Notifications**: in-app (the bell) and share-to-message are built and need no server. **Push notifications and automatic email/SMS reminders** (including accept/decline) reach people while the app is closed, so they need a Cloud Function, and that needs the Firebase Blaze plan.
- **Offline install (service worker)**: left out so every push shows up straight away. Add one when the app settles.
