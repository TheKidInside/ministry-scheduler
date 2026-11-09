"""End-to-end smoke test, driven through the real UI (clicks, typing, rendered DOM).

Usage:  py -3 tests\\e2e.py [base_url] [screenshot_dir]
        (serve the app first: start.cmd, or py -3 -m http.server 8795)
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8795/"
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
errors = []
sys.stdout.reconfigure(encoding="utf-8")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.wait_for_timeout(700)  # let the view's entrance animation finish
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1366, "height": 900})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts" not in m.text else None)
    page.on("dialog", lambda d: d.accept())  # confirm() prompts

    page.goto(BASE)
    page.wait_for_selector(".matrix tbody tr")
    rows = page.locator(".matrix tbody tr")
    check(rows.count() >= 4, f"first visit seeds a sample month ({rows.count()} services)")
    headers = page.locator(".matrix thead th").all_inner_texts()
    check(headers[1:] == ["OPENING PRAYER", "WORSHIP LEADER", "WORSHIP TEAM", "TECH (SOUND & SLIDES)", "PREACHER"]
          or [h.upper() for h in headers[1:]] == ["OPENING PRAYER", "WORSHIP LEADER", "WORSHIP TEAM", "TECH (SOUND & SLIDES)", "PREACHER"],
          "schedule has a column per role")
    shot(page, "1-schedule")

    # highlight one minister
    page.select_option('select[data-action="focus"]', label="Dan T.")
    check(page.locator(".chip.focus").count() >= 1, "highlighting a minister marks their chips")

    # edit the first service's sermon through the dialog
    page.locator(".matrix tbody .when").first.click()
    page.wait_for_selector("dialog[open]")
    page.fill('input[name="sermon-title"]', "E2E Sermon Title")
    page.fill('input[name="sermon-scripture"]', "John 3:16-17")
    page.press('input[name="sermon-scripture"]', "Enter")
    check(not page.locator("dialog[open]").count(), "pressing Enter in a field saves and closes the dialog")

    # preaching view shows it on the calendar and in the plan
    page.click('[data-tab="preaching"]')
    page.wait_for_selector(".folio-grid .folio")
    check(page.locator(".arc .ribbon").count() >= 1, "series ribbons span this month's sermons")
    check(page.locator(".folio", has_text="E2E Sermon Title").count() == 1, "edited title shows on its card")
    check(page.locator(".folio", has_text="John 3:16-17").count() == 1, "scripture shows on the card")
    check("part" in page.locator(".folio-part").first.inner_text().lower(), "sermons show their part in the series")
    shot(page, "2-preaching")

    # conflict warning: put an away person on a service via the select
    page.click('[data-tab="schedule"]')
    page.locator(".matrix tbody .when").first.click()
    page.wait_for_selector("dialog[open]")
    page.select_option('select[name="role:preacher"]', value="p1")  # Ana R., not a preacher
    check("not set up to serve as Preacher" in page.inner_text(".conflicts"), "picking an unqualified person warns live")
    page.click('dialog button[value="cancel"]')

    # auto-fill a brand-new service
    before = page.locator(".matrix tbody tr").count()
    page.click('[data-action="new-service"]')
    page.wait_for_selector("dialog[open]")
    page.fill('input[name="date"]', page.evaluate("location.hash.split('/')[2]") + "-03")
    page.click('[data-local="autofill"]')
    filled = page.eval_on_selector_all('dialog select[name^="role:"]', "els => els.filter(e => e.value).length")
    check(filled >= 5, f"auto-fill picks people for open slots ({filled})")
    page.click('dialog .dialog-actions button[value="save"]')
    page.wait_for_selector("dialog[open] .notify-list")
    check(page.locator("dialog .notify-list li").count() >= 5, "saving new assignments offers to message each person")
    page.locator("dialog [data-notify]").first.click()
    check("you're on" in page.evaluate("navigator.clipboard.readText()"), "the message names their role and the date")
    page.click('dialog .dialog-actions button[value="cancel"]')
    check(page.locator(".matrix tbody tr").count() == before + 1, "new service appears in the month")
    check(not page.is_visible("#mine-btn"), "signed out, there is no bell")

    # setlist: add a song with a key, move it to the top, and it shows on the schedule
    page.locator(".matrix tbody .when").first.click()
    page.wait_for_selector("dialog[open]")
    songs = page.locator("dialog .song-row").count()
    page.click('dialog [data-song="add"]')
    page.locator("dialog .song-row").last.locator('input[name="song-title"]').fill("E2E Hymn")
    page.locator("dialog .song-row").last.locator('select[name="song-key"]').select_option("Bb")
    page.locator("dialog .song-row").last.locator('input[name="song-title"]').press("Enter")
    check(page.locator("dialog[open]").count() == 1 and page.locator("dialog .song-row").count() == songs + 2,
          "Enter in a song title starts the next song instead of saving")
    for i in range(songs, 0, -1):  # the new song moves up one place per tap
        page.locator("dialog .song-row").nth(i).locator('[data-song="up"]').click()
    page.click('dialog .dialog-actions button[value="save"]')
    check(not page.locator("dialog[open]").count(), "a setlist-only change saves without asking to message anyone")
    tag = page.locator(".matrix tbody tr").first.locator(".songs-tag")
    check(tag.inner_text() == f"{songs + 1} songs", f"the schedule shows the song count ({tag.inner_text()})")
    page.locator(".matrix tbody .when").first.click()
    page.wait_for_selector("dialog[open]")
    first = page.locator("dialog .song-row").first
    check(first.locator('input[name="song-title"]').input_value() == "E2E Hymn"
          and first.locator('select[name="song-key"]').input_value() == "Bb", "the song keeps its place and key")
    page.locator("dialog .song-row").nth(1).locator('[data-song="remove"]').click()
    page.click('dialog .dialog-actions button[value="save"]')
    check(tag.inner_text() == f"{songs} songs", "removing a song saves")
    page.click('[data-action="copy-roster"]')
    check("Setlist: E2E Hymn (Bb)" in page.evaluate("navigator.clipboard.readText()"), "the copied roster includes the setlist")

    # weekly tasks: a card per week; add one, assign it, tick it off, move it
    page.click('[data-tab="tasks"]')
    weeks = page.locator(".week")
    check(weeks.count() >= 4 and page.locator(".task").count() >= 12, f"the Tasks tab has a card per week ({weeks.count()})")
    shot(page, "10-tasks")
    count = weeks.first.locator(".task").count()
    weeks.first.locator('[data-action="new-task"]').click()
    page.wait_for_selector("dialog[open]")
    page.fill('dialog input[name="title"]', "   ")
    page.click('dialog .dialog-actions button[value="save"]')
    check(page.locator("dialog[open]").count() == 1, "a task needs a name")
    page.fill('dialog input[name="title"]', "E2E Task")
    page.fill('dialog textarea[name="notes"]', "Bring spares")
    page.locator("dialog .assignees label.check", has_text="Dan T.").locator("input").check()
    shot(page, "11-task-sheet")
    page.press('dialog input[name="title"]', "Enter")
    page.wait_for_selector("dialog[open] .notify-list")
    page.locator("dialog [data-notify]").first.click()
    message = page.evaluate("navigator.clipboard.readText()")
    check("E2E Task" in message and "Bring spares" in message, "assigning a task offers a message that names it")
    page.click('dialog .dialog-actions button[value="cancel"]')
    task = weeks.first.locator(".task", has_text="E2E Task")
    check(weeks.first.locator(".task").count() == count + 1 and "Dan T." in task.inner_text(), "the task shows in its week with who has it")
    page.select_option('select[data-action="focus"]', label="Dan T.")
    check(task.locator(".chip.focus").count() == 1, "highlight works on tasks")
    page.select_option('select[data-action="focus"]', label="Nobody")
    task.locator(".task-check input").click()
    check("done" in task.get_attribute("class") and page.evaluate("document.activeElement.type") == "checkbox", "ticking a task marks it done and keeps your place")
    task.locator(".task-main").click()
    page.wait_for_selector("dialog[open]")
    page.fill('dialog input[name="title"]', "E2E Task Edited")
    page.click('dialog .dialog-actions button[value="save"]')
    check(not page.locator("dialog[open]").count(), "editing a task without changing who has it asks nothing")
    next_week = weeks.nth(1).locator('[data-action="new-task"]').get_attribute("data-week")
    weeks.first.locator(".task", has_text="E2E Task Edited").locator(".task-main").click()
    page.select_option('dialog select[name="week"]', next_week)
    check(page.locator("dialog .assignees input:checked").count() == 1, "changing the week keeps who is picked")
    page.click('dialog .dialog-actions button[value="save"]')
    page.wait_for_selector("dialog[open] .notify-list")
    page.click('dialog .dialog-actions button[value="cancel"]')
    check(weeks.nth(1).locator(".task", has_text="E2E Task Edited").count() == 1 and weeks.first.locator(".task").count() == count, "a task moves to another week")
    page.reload()
    page.wait_for_selector(".week")
    check("done" in page.locator(".task", has_text="E2E Task Edited").get_attribute("class"), "tasks survive a reload")
    page.click('[data-tab="schedule"]')

    # add a minister
    page.click('[data-tab="ministers"]')
    page.click('[data-action="new-person"]')
    page.fill('dialog input[name="name"]', "Zed Tester")
    page.fill('dialog input[name="email"]', "zed@example.com")
    page.check('dialog input[name="roles"][value="tech"]')
    page.fill('dialog input[name="away"]', "2030-01-05")
    page.click('dialog [data-local="add-date"]')
    check(page.locator("dialog .away li", has_text="2030").count() == 1, "away date is listed in the dialog")
    page.click('dialog .dialog-actions button[value="save"]')
    card = page.locator(".person", has_text="Zed Tester")
    check(card.count() == 1 and "Tech" in card.inner_text(), "new minister shows with their role")
    page.click('[data-action="new-person"]')
    page.fill('dialog input[name="name"]', "Zed Twin")
    page.fill('dialog input[name="email"]', "ZED@example.com")
    page.click('dialog .dialog-actions button[value="save"]')
    check(page.locator("dialog[open]").count() == 1, "two ministers can't share one email")
    page.click('dialog button[value="cancel"]')

    # deleting a minister takes them off their tasks
    page.click('[data-tab="tasks"]')
    page.locator(".task", has_text="E2E Task Edited").locator(".task-main").click()
    page.locator("dialog .assignees label.check", has_text="Zed Tester").locator("input").check()
    page.click('dialog .dialog-actions button[value="save"]')
    page.wait_for_selector("dialog[open] .notify-list")
    page.click('dialog .dialog-actions button[value="cancel"]')
    check("Zed Tester" in page.locator(".task", has_text="E2E Task Edited").inner_text(), "a second person can share a task")
    page.click('[data-tab="ministers"]')
    page.locator(".person", has_text="Zed Tester").click()
    page.click('dialog .dialog-actions button[value="delete"]')
    page.click('[data-tab="tasks"]')
    row = page.locator(".task", has_text="E2E Task Edited").inner_text()
    check("Zed Tester" not in row and "Removed" not in row and "Dan T." in row, "deleting a minister takes them off their tasks")
    page.click('[data-tab="ministers"]')

    # a new series tags untagged services in its range
    page.click('[data-tab="series"]')
    page.click('[data-action="new-series"]')
    page.fill('dialog input[name="name"]', "Far Future Series")
    page.fill('dialog input[name="start"]', "2030-01-01")
    page.fill('dialog input[name="end"]', "2029-01-01")
    page.click('dialog .dialog-actions button[value="save"]')
    check(page.locator("dialog[open]").count() == 1, "end before start keeps the dialog open")
    page.fill('dialog input[name="end"]', "2030-03-01")
    page.click('dialog .dialog-actions button[value="save"]')
    check(page.locator(".series-card", has_text="Far Future Series").count() == 1, "series card appears")
    shot(page, "3-series")

    # settings: add a role -> new column
    page.click('[data-tab="settings"]')
    page.fill('#new-role', "Ushers")
    page.press('#new-role', "Enter")
    check(page.locator('#role-rows .role-row').last.locator('input[name="role-name"]').input_value() == "Ushers", "Enter adds the role")
    page.wait_for_timeout(100)
    first_role = page.locator('#role-rows .role-row').first.locator('input[name="role-name"]').input_value()
    handle = page.locator('#role-rows .drag-handle').first.bounding_box()
    target = page.locator('#role-rows .role-row').nth(2).bounding_box()
    page.mouse.move(handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2)
    page.mouse.down()
    page.mouse.move(handle["x"] + 10, target["y"] + target["height"] - 2, steps=8)
    page.mouse.up()
    check(page.locator('#role-rows .role-row').first.locator('input[name="role-name"]').input_value() != first_role, "a role can be dragged to a new place")
    page.wait_for_timeout(150)
    page.reload()
    page.wait_for_selector('#role-rows .role-row')
    check(page.locator('#role-rows .role-row').nth(2).locator('input[name="role-name"]').input_value() == first_role, "the new order saved itself")
    page.fill('input[name="churchName"]', "Autosave Church")
    page.press('input[name="churchName"]', "Tab")
    page.wait_for_timeout(100)
    check(page.inner_text("#church-name") == "Autosave Church", "church settings save themselves")
    page.fill('#new-role', "Temp")
    page.press('#new-role', "Enter")
    page.wait_for_timeout(150)
    page.reload()
    page.wait_for_selector('#role-rows .role-row')
    names = lambda: page.eval_on_selector_all('#role-rows input[name="role-name"]', "els => els.map(e => e.value)")
    kept = names()[0]
    page.locator('#role-rows input[name="role-name"]').first.fill("")
    page.locator('#role-rows input[name="role-name"]').first.press("Tab")
    page.locator('#role-rows .role-row').last.locator('.role-remove').click()
    page.wait_for_timeout(150)
    page.reload()
    page.wait_for_selector('#role-rows .role-row')
    check("Temp" not in names() and names()[0] == kept, "removing a role saves even while another role's name is blank, and the blank is not saved")
    page.click('[data-tab="schedule"]')
    check(page.locator(".matrix thead th", has_text="Ushers").count() == 1, "a new role becomes a schedule column")

    # copy roster puts a plain-text month on the clipboard
    page.click('[data-action="copy-roster"]')
    roster = page.evaluate("navigator.clipboard.readText()")
    check("Preacher:" in roster and "Ushers: OPEN" in roster, "copy roster gives a pasteable month")

    # the X button closes without saving
    page.locator(".matrix tbody .when").first.click()
    page.fill('input[name="sermon-title"]', "SHOULD NOT SAVE")
    page.click('dialog .dialog-head .icon-btn')
    check(not page.locator("dialog[open]").count() and page.locator("text=SHOULD NOT SAVE").count() == 0, "the X closes without saving")

    # data survives a reload
    page.reload()
    page.wait_for_selector(".matrix tbody tr")
    check(page.locator(".matrix thead th", has_text="Ushers").count() == 1, "changes survive a reload")

    # announcement view: the whole month as one table to screenshot
    columns = page.locator(".matrix tbody tr").count()
    roles = page.locator(".matrix thead th").count() - 1
    month = page.inner_text("#month-label")
    page.click('[data-action="schedule-mode"][data-value="announce"]')
    card = page.locator(".announce")
    check(month in card.locator("h2").inner_text(), "the card names its own month")
    blocks = page.locator(".announce-table")
    dates = page.locator(".announce-table thead .ann-date").count()
    check(dates == columns, f"announcement has a column per service ({dates})")
    check(page.locator(".announce-table tbody tr").count() == roles * blocks.count(), "announcement has a row per role")
    check(page.locator(".announce .ann-name", has_text="Dan T.").count() >= 1, "announcement shows the names")
    check(page.locator(".announce-table tbody tr", has_text="Ushers").locator(".ann-tba").count() >= 1, "an unfilled role reads TBA")
    check(page.locator(".announce button, .announce [data-action]").count() == 0, "nothing on the card is a control")
    shot(page, "7-announcement")
    page.click('[data-action="next"]')
    check("announce" in page.evaluate("location.hash"), "changing month stays on the announcement")
    page.click('[data-action="prev"]')
    page.reload()
    page.wait_for_selector(".announce")
    check(page.locator(".matrix").count() == 0, "the announcement survives a reload")

    page.set_viewport_size({"width": 390, "height": 844})
    check(page.evaluate("getComputedStyle(document.querySelector('.announce-table')).display") == "table"
          and page.evaluate("getComputedStyle(document.querySelector('.announce-table td')).display") == "table-cell",
          "the announcement stays a table on a phone")
    table_right = page.evaluate("Math.max(...[...document.querySelectorAll('.announce-table')].map(t => t.getBoundingClientRect().right))")
    card_right = page.evaluate("document.querySelector('.announce').getBoundingClientRect().right")
    check(table_right <= card_right and page.evaluate("document.documentElement.scrollWidth") <= 390, "the announcement fits a phone without sideways scrolling")
    shot(page, "8-announcement-phone")
    page.set_viewport_size({"width": 1366, "height": 900})
    page.click('[data-action="schedule-mode"][data-value="manage"]')
    check(page.locator(".matrix").count() == 1 and page.locator(".announce").count() == 0, "the toggle returns to the working table")

    # the month at a glance, and filling one place without opening the whole service
    page.click('[data-action="schedule-mode"][data-value="manage"]') if page.locator(".announce").count() else None
    page.locator(".matrix tbody .when").first.click()
    page.wait_for_selector("dialog[open]")
    page.select_option('select[name="role:worship-leader"]', value="")
    page.select_option('select[name="role:opening-prayer"]', value="")
    page.click('dialog .dialog-actions button[value="save"]')
    stats = page.locator(".stat-value").all_inner_texts()
    check(len(stats) == 4 and "/" in stats[1], f"the month shows its numbers {stats}")
    open_before = int(stats[2])
    assign = page.locator('.matrix td[data-label="Worship Leader"] .assign').first
    assign.click()
    page.wait_for_selector("dialog.assign-sheet[open]")
    check(page.locator("dialog .assign-go").is_disabled(), "nobody is picked until you choose")
    picks = page.locator("dialog .pick:has(input)")
    check(picks.count() >= 1, f"qualified people are offered ({picks.count()})")
    name = picks.first.locator(".pick-name").inner_text()
    page.fill("#assign-search", "zzzz")
    check(not picks.first.is_visible(), "search narrows the list")
    page.fill("#assign-search", "")
    picks.first.locator("input").check()
    check(page.locator("dialog .assign-go").inner_text() == f"Assign {name}", "the button names who you picked")
    shot(page, "12-assign")
    page.click("dialog .assign-go")
    page.wait_for_selector("dialog[open] .notify-list")
    page.click('dialog .dialog-actions button[value="cancel"]')
    check(int(page.locator(".stat-value").nth(2).inner_text()) == open_before - 1, "assigning takes one off the open count")
    check(page.locator('.matrix td[data-label="Worship Leader"]', has_text=name).count() >= 1, "the name lands in the table")

    # one person can take a second role on a service through the assign sheet, with no clash
    first = page.locator(".matrix tbody tr").first
    first.locator(".when").click()
    page.wait_for_selector("dialog[open]")
    team = page.locator('select[name="role:worship-team"]')
    for i in range(team.count()):
        team.nth(i).select_option(value="")
    page.select_option('select[name="role:opening-prayer"]', value="p1")  # Ana R. can do both
    page.click('dialog .dialog-actions button[value="save"]')
    page.wait_for_selector("dialog[open] .notify-list")
    page.click('dialog .dialog-actions button[value="cancel"]')
    first.locator('td[data-label="Worship Team"] .assign').click()
    page.wait_for_selector("dialog.assign-sheet[open]")
    ana = page.locator("dialog .pick:has(input)", has_text="Ana R.")
    check("Also on Opening Prayer" in ana.inner_text(), "someone on another role can be picked and says so")
    ana.locator("input").check()
    page.click("dialog .assign-go")
    page.wait_for_selector("dialog[open] .notify-list")
    page.click('dialog .dialog-actions button[value="cancel"]')
    check(first.locator('td[data-label="Opening Prayer"]', has_text="Ana R.").count() == 1
          and first.locator('td[data-label="Worship Team"]', has_text="Ana R.").count() == 1, "the name lands in both roles")
    check(first.locator(".chip.conflict").count() == 0, "two roles on one service is not a clash")

    # the same person twice in one role is a clash: it shows in the alert and on the name; the alert line opens that service
    first.locator(".when").click()
    page.wait_for_selector("dialog[open]")
    page.locator('select[name="role:worship-team"]').nth(1).select_option(value="p1")
    check("Ana R. is on Worship Team twice" in page.inner_text(".conflicts"), "listing someone twice in a role warns live")
    page.click('dialog .dialog-actions button[value="save"]')
    page.wait_for_selector(".alert")
    check(page.locator(".alert").count() == 1 and page.locator(".matrix .chip.conflict").count() >= 1, "a clash shows in the alert and on the name")
    page.locator(".alert-line").first.click()
    page.wait_for_selector("dialog[open] .service-form")
    page.click('dialog button[value="cancel"]')

    # auto-fill the rest of the month in one go
    page.click('[data-action="next"]')  # next month, because auto-fill skips services already past
    page.locator(".matrix tbody .when").last.click()
    page.wait_for_selector("dialog[open]")
    page.select_option('select[name="role:opening-prayer"]', value="")
    page.click('dialog .dialog-actions button[value="save"]')
    open_now = int(page.locator(".stat-value").nth(2).inner_text())
    page.click('[data-action="autofill-month"]')
    page.wait_for_timeout(200)
    filled = page.locator(".stat-value").nth(2).inner_text()
    check(int(filled) < open_now, f"auto-fill fills what it can across the month ({filled} left of {open_now})")
    page.click('[data-action="prev"]')

    # ministers: search and role filter hide rows without redrawing the box
    page.click('[data-tab="ministers"]')
    total = page.locator(".person:visible").count()
    page.fill("#minister-search", "dan")
    check(page.locator(".person:visible").count() == 1 and page.evaluate("document.activeElement.id") == "minister-search", "search narrows the list and keeps your cursor")
    page.fill("#minister-search", "preacher")
    check(page.locator(".person:visible").count() >= 2, "search also matches roles")
    page.fill("#minister-search", "")
    page.select_option("#minister-role", "tech")
    check(0 < page.locator(".person:visible").count() < total, "the role filter narrows the list")
    page.select_option("#minister-role", "")
    check(page.locator(".person .dots i").count() > 0, "each minister shows this month's services")

    # series: the timeline and status badges
    page.click('[data-tab="series"]')
    check(page.locator(".timeline .tl-bar").count() >= 1 and page.locator(".tl-today").count() == 1, "the timeline shows series and today")
    check(page.locator(".series-card .badge", has_text="Current").count() + page.locator(".series-card .badge", has_text="Up next").count() >= 1, "series are labelled by their dates")
    page.click('[data-tab="schedule"]')

    # mobile layout + dark theme
    page.set_viewport_size({"width": 390, "height": 844})
    page.click('[data-tab="preaching"]')
    check(len(page.evaluate("getComputedStyle(document.querySelector('.folio-grid')).gridTemplateColumns").split()) == 1, "phone width stacks the sermons in one column")
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(sw <= 390, f"no horizontal scroll on a phone ({sw}px)")
    shot(page, "4-preaching-phone")
    page.click('[data-tab="settings"]')
    page.click('[data-action="theme"][data-value="dark"]')
    check(page.evaluate("document.documentElement.dataset.theme") == "dark", "dark theme applies")
    page.click('[data-tab="schedule"]')
    shot(page, "5-schedule-phone-dark")
    page.set_viewport_size({"width": 1366, "height": 900})
    page.click('[data-tab="preaching"]')
    shot(page, "6-preaching-dark")

    # clear everything; a reload must not bring the sample back
    page.click('[data-tab="settings"]')
    page.click('[data-action="clear-all"]')
    page.click('[data-tab="schedule"]')
    check(page.locator(".empty").count() == 1, "clear everything empties the month")
    page.reload()
    page.wait_for_selector("#view .toolbar")
    check(page.locator(".matrix").count() == 0, "a cleared app is not re-seeded on reload")

    # a malformed backup is cleaned up on import, not saved in a shape that crashes every load
    page.click('[data-tab="settings"]')
    bad = ('{"roles":[{"id":"constructor","name":"Odd"},{"id":"preacher","name":"Preacher","slots":"x"}],'
           '"people":[{"id":"p1","name":"Ann","roleIds":null,"unavailable":null}],'
           '"services":[{"id":"s1","date":"' + page.evaluate("location.hash.split('/')[2]") + '-10",'
           '"assignments":{"preacher":"p1","constructor":null}}]}')
    page.set_input_files("#import-file", files=[{"name": "bad.json", "mimeType": "application/json", "buffer": bad.encode()}])
    page.wait_for_timeout(300)
    page.click('[data-tab="schedule"]')
    page.reload()
    page.wait_for_selector(".matrix tbody tr")
    check(page.locator(".matrix tbody tr").count() == 1, "a malformed backup imports and still renders after reload")

    # phone audit: every page and every sheet stays put and fits the screen
    audit = browser.new_context(**p.devices["iPhone 13"])
    page = audit.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".day-card")
    DRAG = '''sel => { const el = document.querySelector(sel); const t = new Touch({ identifier: 1, target: el, clientY: 200 });
      const ev = new TouchEvent('touchmove', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
      el.dispatchEvent(ev); return ev.defaultPrevented; }'''
    WIDE = '''root => [...document.querySelectorAll(root + ' *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + .5 || r.left < -.5); }).map(e => e.tagName + '.' + e.className).slice(0, 5)'''

    def audit_sheet(name):
        page.wait_for_selector("dialog[open]")
        page.wait_for_timeout(450)
        wide = page.evaluate(WIDE, "dialog")
        box = page.evaluate("(r => [r.left, r.right, innerWidth])(document.querySelector('dialog').getBoundingClientRect())")
        check(not wide and box[0] == 0 and box[1] == box[2], f"{name}: the sheet fits the screen {wide}")
        check(page.evaluate(DRAG, "dialog .dialog-head"), f"{name}: dragging the sheet moves nothing")
        shot(page, "audit-" + name.lower().replace(" ", "-"))
        page.locator("dialog .dialog-head .icon-btn").tap()

    # one service at a time: the date pills switch it, a row opens the person picker full screen
    pills = page.locator(".day-pill")
    check(pills.count() >= 4 and page.locator('.day-pill[aria-pressed="true"]').count() == 1, f"a pill per service ({pills.count()})")
    pills.nth(1).tap()
    check(pills.nth(1).get_attribute("aria-pressed") == "true", "tapping a pill picks that service")
    check(page.locator(".group-label").count() >= 3, "roles are grouped")
    page.locator(".slot").first.tap()
    page.wait_for_selector("dialog.assign-sheet[open]")
    page.wait_for_timeout(450)
    box = page.evaluate("(r => [r.left, r.top, r.right - innerWidth, r.bottom - innerHeight])(document.querySelector('dialog').getBoundingClientRect())")
    check(box == [0, 0, 0, 0], f"choosing a person takes the whole screen {box}")
    page.locator("dialog .dialog-head .icon-btn").tap()
    head_top = page.evaluate("document.querySelector('.page-head').getBoundingClientRect().top")
    page.evaluate("document.querySelector('.main').scrollTo(0, 400)")
    check(page.evaluate("document.querySelector('.page-head').getBoundingClientRect().top") == head_top, "the navy header stays put as the page scrolls")

    for tab in ["schedule", "preaching", "tasks", "ministers", "series", "settings"]:
        page.locator(f'[data-tab="{tab}"]').tap()
        page.wait_for_timeout(250)
        wide = page.evaluate(WIDE, ".main")
        check(not wide and page.evaluate("document.documentElement.scrollWidth") <= page.evaluate("innerWidth"), f"{tab}: fits a phone {wide}")
        check(page.evaluate(DRAG, ".rail") and page.evaluate(DRAG, ".tabs"), f"{tab}: the header and tab bar can't be dragged")
        more = page.evaluate("(m => m.scrollHeight > m.clientHeight)(document.querySelector('.main'))")
        check(page.evaluate(DRAG, ".view") != more, f"{tab}: the page scrolls only when there is more to see")
        cut = page.evaluate('''() => { const m = document.querySelector('.main'); m.scrollTo(0, 1e6);
          const last = Math.max(...[...document.querySelectorAll('.view *')].map(e => e.getBoundingClientRect().bottom));
          const top = document.querySelector('.tabs').getBoundingClientRect().top; m.scrollTo(0, 0); return last - top; }''')
        check(cut <= 0 and page.evaluate("getComputedStyle(document.body).minHeight") == "0px", f"{tab}: the tab bar never covers the end of the page ({cut:.0f}px)")
        shot(page, f"audit-{tab}")
    page.locator('[data-tab="tasks"]').tap()
    page.locator('[data-action="new-task"]').first.tap()
    audit_sheet("New task")
    page.locator(".task-main").first.tap()
    audit_sheet("Task")
    box = page.evaluate("(r => r.height)(document.querySelector('.task-check').getBoundingClientRect())")
    check(box >= 40 and page.evaluate("document.querySelector('.task-check').getBoundingClientRect().width") >= 44, f"the tick box is easy to hit on a phone ({box}px)")
    page.set_viewport_size({"width": 320, "height": 640})
    check(page.evaluate("[...document.querySelectorAll('.tabs a')].every(a => a.scrollWidth <= a.clientWidth && a.getBoundingClientRect().right <= innerWidth)"), "six tabs fit the narrowest phone")
    shot(page, "audit-tasks-320")
    check(not page.evaluate(WIDE, ".main"), "the task cards fit the narrowest phone")
    page.set_viewport_size({"width": 390, "height": 664})
    page.locator('[data-tab="ministers"]').tap()
    page.locator('[data-action="new-person"]').tap()
    audit_sheet("New minister")
    page.locator(".person").first.tap()
    audit_sheet("Minister")
    page.locator('[data-tab="series"]').tap()
    page.locator('[data-action="edit-series"]').first.tap()
    audit_sheet("Series")
    page.locator("#account-btn").tap()
    audit_sheet("Account")
    audit.close()

    # the week's details on a phone: the sheet can't be dragged, only its content scrolls
    phone = browser.new_context(**p.devices["iPhone 13"])
    page = phone.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.locator(".day-card").tap()
    page.wait_for_selector("dialog[open] .service-form")
    page.wait_for_timeout(500)
    TOUCH = '''sel => { const el = document.querySelector(sel); const t = new Touch({ identifier: 1, target: el, clientY: 200 });
      const ev = new TouchEvent('touchmove', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
      el.dispatchEvent(ev); return ev.defaultPrevented; }'''
    check(page.evaluate(TOUCH, "dialog .dialog-head"), "dragging the sheet's header moves nothing")
    check(page.evaluate(TOUCH, "dialog .dialog-actions"), "dragging the sheet's footer moves nothing")
    overflows = page.evaluate("(b => b.scrollHeight > b.clientHeight)(document.querySelector('.dialog-body'))")
    check(page.evaluate(TOUCH, "dialog .sheet-section") != overflows, "the sheet's content scrolls only when there is more to see")
    sizes = page.evaluate('''() => { const d = document.querySelector('dialog'), b = d.querySelector('.dialog-body');
      return { dw: d.scrollWidth - d.clientWidth, dh: d.scrollHeight - d.clientHeight, bw: b.scrollWidth - b.clientWidth,
               left: d.getBoundingClientRect().left, right: d.getBoundingClientRect().right, vw: innerWidth,
               over: overflowing() };
      function overflowing() { return [...b.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > b.getBoundingClientRect().right + .5).map(e => e.className || e.tagName); } }''')
    check(sizes["dw"] <= 0 and sizes["dh"] <= 0 and sizes["bw"] <= 0 and not sizes["over"], f"the sheet has nowhere to slide {sizes}")
    check(sizes["left"] == 0 and sizes["right"] == sizes["vw"], "the sheet sits exactly on the screen")
    shot(page, "9-week-details-phone")
    page.locator('[data-local="autofill"]').tap()
    page.locator('[data-local="autofill"]').tap()
    check(page.locator("dialog[open] .service-form").count() == 1, "auto-fill still works after the sheet redraws")
    tops = page.evaluate("[...document.querySelectorAll('.dialog-actions .btn')].map(b => b.getBoundingClientRect().top)")
    check(len(set(tops)) == 1, "the sheet's buttons sit on one line")
    phone.close()

    browser.close()

check(not errors, f"no page errors {errors}")
print("ALL PASSED")
