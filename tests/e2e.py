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
    rows.first.click()
    page.wait_for_selector("dialog[open]")
    page.fill('input[name="sermon-title"]', "E2E Sermon Title")
    page.fill('input[name="sermon-scripture"]', "John 3:16-17")
    page.press('input[name="sermon-scripture"]', "Enter")
    check(not page.locator("dialog[open]").count(), "pressing Enter in a field saves and closes the dialog")

    # preaching view shows it on the calendar and in the plan
    page.click('[data-tab="preaching"]')
    page.wait_for_selector(".arc .folio")
    check(page.locator(".arc .ribbon").count() >= 1, "series ribbons span this month's sermons")
    check(page.locator(".arc .folio", has_text="E2E Sermon Title").count() == 1, "edited title shows on the calendar")
    check(page.locator(".plan", has_text="John 3:16-17").count() == 1, "scripture shows in the preaching plan")
    check(" of " in page.locator(".folio-part").first.inner_text().lower(), "sermons show their part in the series")
    shot(page, "2-preaching")

    # conflict warning: put an away person on a service via the select
    page.click('[data-tab="schedule"]')
    page.locator(".matrix tbody tr").first.click()
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
    page.locator(".matrix tbody tr").first.click()
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
    page.locator(".matrix tbody tr").first.click()
    page.wait_for_selector("dialog[open]")
    first = page.locator("dialog .song-row").first
    check(first.locator('input[name="song-title"]').input_value() == "E2E Hymn"
          and first.locator('select[name="song-key"]').input_value() == "Bb", "the song keeps its place and key")
    page.locator("dialog .song-row").nth(1).locator('[data-song="remove"]').click()
    page.click('dialog .dialog-actions button[value="save"]')
    check(tag.inner_text() == f"{songs} songs", "removing a song saves")
    page.click('[data-action="copy-roster"]')
    check("Setlist: E2E Hymn (Bb)" in page.evaluate("navigator.clipboard.readText()"), "the copied roster includes the setlist")

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
    page.click('[data-action="add-role"]')
    page.locator('#role-rows .role-row').last.locator('input[name="role-name"]').fill("Ushers")
    page.click('#roles-form button.primary')
    page.click('[data-tab="schedule"]')
    check(page.locator(".matrix thead th", has_text="Ushers").count() == 1, "a new role becomes a schedule column")

    # copy roster puts a plain-text month on the clipboard
    page.click('[data-action="copy-roster"]')
    roster = page.evaluate("navigator.clipboard.readText()")
    check("Preacher:" in roster and "Ushers: OPEN" in roster, "copy roster gives a pasteable month")

    # the X button closes without saving
    page.locator(".matrix tbody tr").first.click()
    page.fill('input[name="sermon-title"]', "SHOULD NOT SAVE")
    page.click('dialog .dialog-head .icon-btn')
    check(not page.locator("dialog[open]").count() and page.locator("text=SHOULD NOT SAVE").count() == 0, "the X closes without saving")

    # data survives a reload
    page.reload()
    page.wait_for_selector(".matrix tbody tr")
    check(page.locator(".matrix thead th", has_text="Ushers").count() == 1, "changes survive a reload")

    # mobile layout + dark theme
    page.set_viewport_size({"width": 390, "height": 844})
    page.click('[data-tab="preaching"]')
    check(page.evaluate("getComputedStyle(document.querySelector('.arc')).display") == "block", "phone width stacks the series arc top to bottom")
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

    browser.close()

check(not errors, f"no page errors {errors}")
print("ALL PASSED")
