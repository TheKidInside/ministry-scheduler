# Ministry Scheduler

Plan who serves each Sunday, and see the month's preaching by sermon series.

**Live:** https://thekidinside.github.io/ministry-scheduler/

## What it does

- **Schedule**: a month grid with one row per service and one column per role (Opening Prayer, Worship Leader, Worship Team, Tech, Preacher, and any roles you add). Open slots and clashes are flagged. Each service also has a **setlist**: songs in order with their key, suggested from songs you've sung before. The month's numbers and any clashes sit above the grid, and an amber **Assign** button fills one place without opening the whole service. **Auto-fill** fills empty slots for one service or the rest of the month, giving each slot to whoever has served least. **Copy as text** gives you the month, ready to paste into a group chat. On a phone you get one service at a time, grouped by team.
- **Preaching**: a ribbon spans each series' Sundays, and each sermon gets a card with its part, title, scripture and preacher. Printable.
- **Tasks**: a card for each week of the month. Add jobs to a week, assign them to one or more ministers, and tick them off. Whoever you assign gets the same one-tap message and bell as a service.
- **Letting people know**: after you put someone on a service, one tap sends them a ready-written message (share sheet, text or email). Signed in, each minister whose email is on their profile gets a **bell** with their new assignments.
- **Ministers**: search or filter by role; each person's roles, away dates, how often they serve this month and their next assignment.
- **Series**: a timeline plus a card for each series, labelled Current, Up next or Draft from its dates. Services in the date range pick up the series automatically.
- **Settings**: church name, usual service day and time, roles (drag to reorder), light/dark theme, and backup export/import. Changes save as you go.

Signed out, data stays in the browser. Sign in to put your church online, then share the invite link: everyone on the team sees and edits the same schedule live, on any device ([how it works](docs/FIREBASE.md)).

## Run locally

```
start.cmd                          # http://localhost:8795/
node --test tests/model.test.mjs   # logic tests
py -3 tests\e2e.py                 # UI test via Playwright (server running)
```

No build step. Push to `main` and GitHub Pages deploys it.

How the code works: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).
