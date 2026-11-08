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
 ├─ people     [{ id, name, contact, roleIds:[...], unavailable:['2026-11-15'] }]
 ├─ series     [{ id, name, color, start, end, description }]
 └─ services   [{ id, date:'2026-11-15', time, name,
                  assignments: { 'worship-team': ['p1','p3'], preacher: ['p10'] },
                  sermon: { title, scripture, seriesId },
                  notes }]
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
| Schedule | `renderSchedule` | services × roles table, open slots, conflict flags, "Highlight" one minister |
| Preaching | `renderPreaching` | the series arc (a coloured ribbon spans each series' Sundays, with a sermon folio under each) and the preaching plan table |
| Ministers | `renderMinisters` | each person, their roles, services this month, next assignment, away dates |
| Series | `renderSeries` | each series with dates, colour and its numbered sermon list |
| Settings | `renderSettings` | church name, usual day/time, roles, theme, backup/import |

Editors: `openServiceEditor`, `openPersonEditor`, `openSeriesEditor`. The service
editor recomputes conflicts on every change, so the warning box updates while you
pick people. In each role dropdown, people who can serve are listed first, with
"(away)" and "(2× this month)" hints.

The URL hash holds the tab and month (`#/preaching/2026-11`), so a link or
bookmark opens the same view.

### 3.5 [css/styles.css](../css/styles.css)

The look is called "Vestry": a deep ink rail with gold hairlines, cool porcelain pages,
Cormorant Garamond for headings and dates, Hanken Grotesk for working text. Series
colours are jewel tones (`SERIES_COLORS` in model.js), the only saturated colour on the page.
Colour tokens live on `:root`, with a dark set under `prefers-color-scheme` and a
`[data-theme]` override for the System/Light/Dark switch. Each series colour is passed
as a CSS variable (`style="--series:#6b4c9a"`), so one rule colours ribbons, covers,
numerals and diamonds. The arc is a CSS grid with explicit `grid-column` placement;
under 760px it switches to `display:block`, so the same DOM order (ribbon, its sermons,
next ribbon...) reads top to bottom. On phones the rail becomes a bottom tab bar and
editors open as bottom sheets; on desktop they slide in from the right.

---

## Part 4 — One click, end to end: saving a sermon title

1. You click the 15 Nov row → the delegated listener sees `data-action="edit-service"` → `openServiceEditor(service)`.
2. The editor clones the service (`structuredClone`), so typing doesn't change the real data until you save.
3. You type a title and press **Save** → `openDialog`'s submit handler validates → `onSubmit` → `readServiceForm` builds the new service object from the inputs.
4. `putDoc('services', next)` replaces it in `state` **and** calls `store.putDoc`, which writes localStorage.
5. The dialog closes, `render()` redraws, and the Preaching arc shows the new title under its series ribbon.

---

## Part 5 — Recipes

- **Add a default role**: add it to `DEFAULT_ROLES` in `model.js` (new churches only). Existing data: Settings → Roles → Add a role.
- **Change service day** (e.g. Saturday night): Settings → Usual service day. "Add every …" follows it.
- **New series colours**: edit `SERIES_COLORS` in `model.js`.
- **New field on a service** (e.g. "Communion Sunday"): add it to `newService`, `normalizeState`, `serviceFormBody` and `readServiceForm`, then show it in a render function.

---

## Part 6 — What's deliberately left out (and where it'd go)

- **Firebase sync / logins**: built. `FirebaseStore` lives in `js/cloud.js` and has the same methods as `LocalStore`. `app.js` swaps `store` when you sign in to a church (`useStore`/`useChurch`). How it works, the rules and the emulator test are in [FIREBASE.md](FIREBASE.md).
- **Notifications (email/SMS reminders, accept/decline)**: need a server. These come after Firebase, using Cloud Functions.
- **Offline install (service worker)**: left out so every push shows up straight away. Add one when the app settles.
