# Ministry Scheduler

Plan who serves each Sunday, and see the month's preaching by sermon series.

**Live:** https://thekidinside.github.io/ministry-scheduler/

## What it does

- **Schedule**: a month grid with one row per service and one column per role (Opening Prayer, Worship Leader, Worship Team, Tech, Preacher, and any roles you add). Open slots and clashes are flagged. Each service also has a **setlist**: songs in order with their key, suggested from songs you've sung before. **Auto-fill** fills empty slots with qualified, available people, giving each slot to whoever has served least that month. **Copy roster** gives you the month as text, ready to paste into a group chat.
- **Preaching**: the month as an arc of sermon series. A jewel-toned ribbon spans each series' Sundays, and under it every sermon shows its part ("Part 3 of 7"), title, scripture and preacher. Below that is a printable preaching plan.
- **Letting people know**: after you put someone on a service, one tap sends them a ready-written message (share sheet, text or email). Signed in, each minister whose email is on their profile gets a **bell** with their new assignments.
- **Ministers**: the people who serve, the roles each one can do, their away dates, how often they serve this month and their next assignment.
- **Series**: sermon series with dates, a colour and a description. Services in the date range pick up the series automatically.
- **Settings**: church name, usual service day and time, roles, light/dark theme, and backup export/import.

Signed out, data stays in the browser. Sign in to put your church online, then share the invite link: everyone on the team sees and edits the same schedule live, on any device ([how it works](docs/FIREBASE.md)).

## Run locally

```
start.cmd                          # http://localhost:8795/
node --test tests/model.test.mjs   # logic tests
py -3 tests\e2e.py                 # UI test via Playwright (server running)
```

No build step. Push to `main` and GitHub Pages deploys it.

How the code works: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).
