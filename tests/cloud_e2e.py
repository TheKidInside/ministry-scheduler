"""Cloud sync test against the local Firebase emulators, through the real UI.

Two people on two browsers: Pastor creates an account, puts the schedule online and
copies the invite link; Leader joins with it; an edit by one appears live for the other;
the security rules refuse an outsider. firebase-config.js is swapped (in the browser
only) for an emulator config, so no real project is touched.

Usage:
  firebase emulators:start --only auth,firestore --project demo-ministry   (from the app folder)
  py -3 tests\\cloud_e2e.py [base_url]
"""
import base64
import json
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8795/"
PROJECT = "demo-ministry"
CONFIG = ("export const firebaseConfig = { apiKey: 'demo-key', authDomain: 'localhost', projectId: '%s', appId: 'demo',"
          " emulator: { auth: 'http://127.0.0.1:9099', firestore: ['127.0.0.1', 8085] } };" % PROJECT)
errors = []
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==")
FORGE = """async ([cid, uid, field]) => { const C = await import('/js/cloud.js'); const { db, F } = await C.cloud();
  try { await F.updateDoc(F.doc(db, 'churches', cid), { [`${field}.${uid}`]: 'data:image/jpeg;base64,AAAA' }); return 'allowed'; }
  catch (e) { return e.code; } }"""
TRY = """async ([cid, col, id, fields]) => { const C = await import('/js/cloud.js'); const { db, F } = await C.cloud();
  try { await F.updateDoc(F.doc(db, 'churches', cid, col, id), fields); return 'allowed'; } catch (e) { return e.code; } }"""
SETTINGS = """async cid => { const C = await import('/js/cloud.js'); const { db, F } = await C.cloud();
  try { await F.updateDoc(F.doc(db, 'churches', cid), { 'settings.churchName': 'Hacked' }); return 'allowed'; } catch (e) { return e.code; } }"""
FIRST_DOC = """async ([cid, col]) => { const C = await import('/js/cloud.js'); const { db, F } = await C.cloud();
  const s = await F.getDocs(F.collection(db, 'churches', cid, col)); return s.docs[0].id; }"""
sys.stdout.reconfigure(encoding="utf-8")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def wipe():
    for url in (f"http://127.0.0.1:8085/emulator/v1/projects/{PROJECT}/databases/(default)/documents",
                f"http://127.0.0.1:9099/emulator/v1/projects/{PROJECT}/accounts"):
        urllib.request.urlopen(urllib.request.Request(url, method="DELETE")).read()


def browser_page(browser, phone=False):
    ctx = browser.new_context(**(p.devices["iPhone 13"] if phone else {"viewport": {"width": 1366, "height": 900}}))
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    ctx.route("**/js/firebase-config.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=CONFIG))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    return page


def sign_up(page, email):
    page.click("#account-btn")
    page.wait_for_selector("dialog[open] input[name=email]")
    page.fill("dialog input[name=email]", email)
    page.fill("dialog input[name=password]", "secret123")
    page.click('dialog button[value="create"]')
    page.wait_for_function("document.querySelector('#account-btn').dataset.state !== 'local'", timeout=15000)


wipe()
with sync_playwright() as p:
    browser = p.chromium.launch()

    # 1. Pastor signs up and puts the sample schedule online
    a = browser_page(browser)
    a.goto(BASE)
    a.wait_for_selector(".matrix tbody tr")
    a.wait_for_function("document.querySelector('#account-btn').textContent.includes('Sign in')", timeout=15000)  # cloud loads lazily
    check(True, "signed out, the app says it is saved in this browser")
    sign_up(a, "pastor@example.com")
    try:  # the app reopens the account dialog by itself after signing in; open it only if it didn't
        a.wait_for_selector('dialog[open] button[value="upload"]', timeout=4000)
    except Exception:
        a.click("#account-btn")
        a.wait_for_selector('dialog[open] button[value="upload"]')
    a.click('dialog button[value="upload"]')
    a.wait_for_selector("dialog[open] #invite-link", timeout=20000)
    invite = a.input_value("#invite-link")
    check("#join=" in invite, f"putting it online gives an invite link")
    check("admin" in a.inner_text("dialog .members").lower(), "the pastor is the church admin")
    a.click('dialog .dialog-actions button[value="cancel"]')
    check(a.get_attribute("#account-btn", "data-state") == "synced", "account button shows synced")
    rows_a = a.locator(".matrix tbody tr").count()

    # 2. Leader opens the invite link on a phone, signs up, and lands in the same church
    b = browser_page(browser, phone=True)
    b.goto(invite)
    b.wait_for_selector("dialog[open] input[name=email]", timeout=15000)
    check("accept your invite" in b.inner_text("dialog"), "an invite link asks you to sign in first")
    b.fill("dialog input[name=email]", "leader@example.com")
    b.fill("dialog input[name=password]", "secret123")
    b.click('dialog button[value="create"]')
    b.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=20000)
    b.wait_for_selector(".day-pill")
    check(b.locator(".day-pill").count() == rows_a, "the leader sees the same services as the pastor")

    # 3. A member who isn't an admin can look but has nothing to change
    check(b.locator("div.day-card").count() == 1 and b.locator("button.slot, .assign").count() == 0, "a member sees the service with nothing to edit")
    check(b.locator('[data-action="autofill-month"], [data-action="new-service"]').count() == 0, "a member has no schedule buttons")
    for tab, gone in [("preaching", ".folio[data-action]"), ("tasks", '[data-action="new-task"], [data-action="edit-task"]'),
                      ("ministers", '[data-action="new-person"], [data-action="edit-person"]'), ("series", '[data-action="new-series"], [data-action="edit-series"]'),
                      ("settings", "#settings-form, #roles-form, #import-file, [data-action='clear-all']")]:
        b.click(f'[data-tab="{tab}"]')
        check(b.locator(gone).count() == 0, f"{tab}: a member can't edit")
    b.click('[data-tab="schedule"]')

    # 3b. An admin's change shows up live on the phone
    a.locator(".matrix tbody .when").first.click()
    a.fill('dialog input[name="sermon-title"]', "Live From The Pastor")
    a.click('dialog .dialog-actions button[value="save"]')
    b.click('[data-tab="preaching"]')
    b.wait_for_selector(".folio:has-text('Live From The Pastor')", timeout=15000)
    check(True, "an edit on one device appears live on the other")

    # 4. ...and the pastor's edit reaches the phone
    a.click('[data-tab="ministers"]')
    a.click('[data-action="new-person"]')
    a.fill('dialog input[name="name"]', "Synced Person")
    check(a.locator("dialog [data-link-mode]").count() == 3 and a.locator('dialog input[name="email"]').count() == 0,
          "a minister with no email offers invite, registered user, or blank")
    a.click('dialog [data-link-mode="invite"]')
    a.fill('dialog input[name="email"]', "Leader@Example.com")
    a.click('dialog .dialog-actions button[value="save"]')
    a.wait_for_selector("dialog[open] .invite-preview")
    a.click('dialog .dialog-actions button[value="cancel"]')
    b.click('[data-tab="ministers"]')
    b.wait_for_selector(".person:has-text('Synced Person')", timeout=15000)
    check(True, "a new minister reaches the other device")

    # 4b. The pastor puts that minister (linked to the leader by email) on a service:
    #     the pastor is offered a message to send, and the leader's bell lights up live
    check(b.is_visible("#mine-btn") and not b.is_visible("#mine-btn .bell-count"), "signed in to a church, the bell shows with nothing new")
    a.click('[data-tab="schedule"]')
    a.click('[data-action="next"]')  # next month, so the service is still upcoming
    a.locator(".matrix tbody .when").first.click()
    a.wait_for_selector("dialog[open]")
    a.locator('dialog select[name="role:tech"]').first.select_option(label="Synced Person")
    a.click('dialog .dialog-actions button[value="save"]')
    a.wait_for_selector("dialog[open] .notify-list", timeout=5000)
    check("Synced Person" in a.inner_text("dialog .notify-list"), "saving offers to message the newly assigned minister")
    a.click('dialog .dialog-actions button[value="cancel"]')
    b.wait_for_selector("#mine-btn .bell-count:not([hidden])", timeout=15000)
    check(b.inner_text("#mine-btn .bell-count") == "1", "the assigned minister's bell shows 1 new, live")
    b.click("#mine-btn")
    b.wait_for_selector("dialog[open] .mine-list")
    check("Tech" in b.inner_text("dialog .mine-list") and b.locator("dialog .mine-list .is-new").count() == 1,
          "the bell lists the new assignment")
    b.click('dialog .dialog-actions button[value="cancel"]')
    b.wait_for_selector("#mine-btn .bell-count", state="hidden", timeout=5000)
    check(True, "opening the list clears the count")
    b.wait_for_timeout(1500)
    b.reload()
    b.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=20000)
    b.wait_for_timeout(1500)
    check(b.is_visible("#mine-btn") and not b.is_visible("#mine-btn .bell-count"), "seen assignments stay seen after a reload")

    # 4b2. The same for a weekly task: the bell lights up live, and ticking it syncs back
    a.click('[data-tab="tasks"]')  # still on next month, so the week is upcoming
    a.locator('[data-action="new-task"]').first.click()
    a.wait_for_selector("dialog[open]")
    a.fill('dialog input[name="title"]', "Bring the new cables")
    a.locator("dialog .assignees label.check", has_text="Synced Person").locator("input").check()
    a.click('dialog .dialog-actions button[value="save"]')
    a.wait_for_selector("dialog[open] .notify-list", timeout=5000)
    a.click('dialog .dialog-actions button[value="cancel"]')
    b.wait_for_selector("#mine-btn .bell-count:not([hidden])", timeout=15000)
    check(b.inner_text("#mine-btn .bell-count") == "1", "a new task lights up the minister's bell, live")
    b.click("#mine-btn")
    b.wait_for_selector("dialog[open] .mine-list")
    check("Bring the new cables" in b.inner_text("dialog") and b.locator("dialog .mine-list .is-new").count() == 1, "the bell lists the new task")
    b.click('dialog .dialog-actions button[value="cancel"]')
    b.wait_for_selector("#mine-btn .bell-count", state="hidden", timeout=5000)
    b.click('[data-tab="tasks"]')
    b.click('[data-action="next"]')
    check(b.locator(".task", has_text="Bring the new cables").locator(".task-check input").is_disabled(), "a member can't tick a task")
    a.locator(".task", has_text="Bring the new cables").locator(".task-check input").click()
    b.wait_for_selector(".task.done:has-text('Bring the new cables')", timeout=15000)
    check(True, "an admin ticking a task shows as done on the other device")
    b.click('[data-action="prev"]')

    # 4b3. A preacher edits the sermons they are assigned, and only those
    cid_now = invite.split("#join=")[1]
    a.click('[data-tab="schedule"]')
    a.locator(".matrix tbody .when").first.click()
    a.wait_for_selector("dialog[open]")
    a.select_option('dialog select[name="role:preacher"]', label="Synced Person")
    a.click('dialog .dialog-actions button[value="save"]')
    a.wait_for_selector("dialog[open] .notify-list", timeout=5000)
    a.click('dialog .dialog-actions button[value="cancel"]')
    a.click('[data-tab="preaching"]')
    b.click('[data-tab="preaching"]')
    b.click('[data-action="next"]')
    b.wait_for_selector(".folio[data-action='edit-sermon']", timeout=15000)
    check(b.locator(".folio[data-action]").count() == 1, "a preacher can open only the sermon assigned to them")
    b.locator(".folio[data-action='edit-sermon']").tap()
    b.wait_for_selector("dialog[open] input[name='sermon-title']")
    check(b.locator('dialog select[name^="role:"], dialog input[name="date"]').count() == 0, "the preacher's sheet has only the sermon")
    b.fill("dialog input[name='sermon-title']", "Live From The Phone")
    b.click('dialog .dialog-actions button[value="save"]')
    a.wait_for_selector(".folio:has-text('Live From The Phone')", timeout=15000)
    check(True, "a preacher's edit appears live")
    mine = b.evaluate("() => document.querySelector(\".folio[data-action='edit-sermon']\").dataset.id")
    sermon = {"title": "Forged", "scripture": "", "seriesId": ""}
    check(b.evaluate(TRY, [cid_now, "services", mine, {"sermon": sermon}]) == "allowed", "the rules let a preacher save their own sermon")
    check(b.evaluate(TRY, [cid_now, "services", mine, {"assignments": {}}]) == "permission-denied", "the rules refuse a preacher changing who serves")
    check(b.evaluate(TRY, [cid_now, "services", mine, {"sermon": sermon, "notes": "x"}]) == "permission-denied", "the rules refuse a preacher slipping in another field")
    someone_elses = a.evaluate("""async ([cid, mine]) => { const C = await import('/js/cloud.js'); const { db, F } = await C.cloud();
      const s = await F.getDocs(F.collection(db, 'churches', cid, 'services')); return s.docs.map(d => d.id).find(id => id !== mine); }""", [cid_now, mine])
    check(b.evaluate(TRY, [cid_now, "services", someone_elses, {"sermon": sermon}]) == "permission-denied", "the rules refuse a preacher editing someone else's sermon")
    for col in ("people", "series", "tasks", "roles"):
        doc = b.evaluate(FIRST_DOC, [cid_now, col])
        check(b.evaluate(TRY, [cid_now, col, doc, {"name": "Forged"}]) == "permission-denied", f"the rules refuse a member changing {col}")
    check(b.evaluate(SETTINGS, cid_now) == "permission-denied", "the rules refuse a member changing the church settings")
    check(b.get_attribute("#account-btn", "data-state") == "synced", "a refused save never drops you out of the church")
    b.click('[data-action="prev"]')
    a.click('[data-tab="schedule"]')
    a.click('[data-action="prev"]')

    # 4c. "Send an invite": the link carries the minister, and accepting it links their account
    a.click('[data-tab="ministers"]')
    a.click('[data-action="new-person"]')
    a.fill('dialog input[name="name"]', "Invited Person")
    a.click('dialog [data-link-mode="invite"]')
    a.click('dialog .dialog-actions button[value="save"]')
    a.wait_for_selector("dialog[open] .invite-preview")
    text = a.inner_text("dialog .invite-preview")
    personal = text[text.index("http"):].strip()
    check("&as=" in personal and "Invited" in text, "the invite is written for that minister")
    a.click('dialog .dialog-actions button[value="cancel"]')
    check("No sign-in" in a.locator(".person", has_text="Invited Person").inner_text(), "not linked until they accept")
    c = browser_page(browser, phone=True)
    c.goto(personal)
    c.wait_for_selector("dialog[open] input[name=email]", timeout=15000)
    c.fill("dialog input[name=email]", "invited@example.com")
    c.fill("dialog input[name=password]", "secret123")
    c.click('dialog button[value="create"]')
    c.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=20000)
    a.wait_for_function("[...document.querySelectorAll('.person')].find(p => p.textContent.includes('Invited Person')).querySelector('.person-link.on')", timeout=15000)
    check(True, "accepting a personal invite links the account to that minister")

    # 4c-2. Your profile: a new name and photo reach your minister, live
    c.click("#account-btn")
    c.wait_for_selector("dialog[open] input[name='profile-name']")
    check(c.input_value("dialog input[name='profile-name']") == "Invited Person", "your profile starts from your minister's name")
    c.wait_for_timeout(450)
    check(c.evaluate("(d => d.scrollWidth <= d.clientWidth)(document.querySelector('dialog .dialog-body'))"), "the profile fits a phone")
    c.set_input_files("#profile-photo", files=[{"name": "me.png", "mimeType": "image/png", "buffer": PNG}])
    c.wait_for_selector("dialog .profile-avatar img", timeout=5000)
    check(c.get_attribute("dialog .profile-avatar img", "src").startswith("data:image/jpeg"), "an uploaded picture is shrunk to a JPEG")
    c.fill("dialog input[name='profile-name']", "Renamed Person")
    c.click('dialog button[value="profile"]')
    a.wait_for_selector(".person:has-text('Renamed Person') img.mono", timeout=15000)
    check(a.locator(".person", has_text="Invited Person").count() == 0, "changing your name renames your minister, with the photo, live")
    c.wait_for_timeout(800)
    c.click("#account-btn")
    c.wait_for_selector("dialog[open] .members li", timeout=15000)
    c.wait_for_function("document.querySelector('dialog .members').textContent.includes('Renamed Person')", timeout=15000)
    check(True, "the members list shows the new name")
    c.click('dialog .dialog-actions button[value="cancel"]')
    pastor = a.evaluate("async () => { const C = await import('/js/cloud.js'); return (await C.cloud()).auth.currentUser.uid; }")
    for field in ("memberPhotos", "memberNames"):
        check(c.evaluate(FORGE, [cid_now, pastor, field]) == "permission-denied", f"a member can't change someone else's {field}")

    # 4d. "Registered user": pick someone who has already joined
    a.click('[data-action="new-person"]')
    a.fill('dialog input[name="name"]', "Picked Person")
    a.click('dialog [data-link-mode="member"]')
    a.wait_for_selector('dialog select[name="member"]')
    options = a.locator('dialog select[name="member"] option').all_inner_texts()
    check(not any("Renamed" in o for o in options) and any("leader" in o for o in options), f"the list leaves out accounts already linked {options}")
    a.click('dialog .dialog-actions button[value="save"]')
    check(a.locator("dialog[open]").count() == 1, "choosing nobody keeps the sheet open")
    a.select_option('dialog select[name="member"]', label="leader")
    a.click('dialog .dialog-actions button[value="save"]')
    a.locator(".person", has_text="Picked Person").locator(".person-link.on").wait_for(timeout=5000)
    a.locator(".person", has_text="Picked Person").click()
    a.wait_for_selector("dialog[open] .linked-row")
    check("leader" in a.inner_text("dialog .linked-row"), "a linked minister shows who they are linked to")
    a.click('dialog [data-link="unlink"]')
    check(a.locator("dialog [data-link-mode]").count() == 3, "unlinking brings the three options back")
    a.click('dialog .dialog-actions button[value="cancel"]')

    # 5. Members list shows both; leader is an editor
    a.click("#account-btn")
    a.wait_for_selector("dialog[open] .members li:nth-child(3)", timeout=15000)
    members = a.inner_text("dialog .members").lower()
    check("member" in members and "leader" in members, "the pastor sees the leader as a member")
    a.click('dialog .dialog-actions button[value="cancel"]')

    # 5b. The admin opening their own invite link stays admin
    a.goto(invite)
    a.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=20000)
    a.wait_for_timeout(1500)
    a.click("#account-btn")
    a.wait_for_selector("dialog[open] .members li:nth-child(2)", timeout=15000)
    check("admin" in a.locator("dialog .members li", has_text="(you)").inner_text().lower(),
          "the admin opening their own invite link is still admin")

    # 5c. The admin removes the leader: the leader's phone drops back to its own copy,
    #     and the same invite link can't bring them back
    a.locator("dialog .members li", has_text="leader").locator("[data-remove-member]").click()
    a.wait_for_function("document.querySelectorAll('dialog .members li').length === 2", timeout=15000)
    a.click('dialog .dialog-actions button[value="cancel"]')

    # 5d. Leaving a church takes your photo with you
    c.click("#account-btn")
    c.click('dialog button[value="leave"]')
    c.wait_for_function("document.querySelector('#account-btn').dataset.state !== 'synced'", timeout=20000)
    left = a.evaluate("async cid => { const C = await import('/js/cloud.js'); const i = await C.churchInfo(cid); return [Object.keys(i.members).length, Object.keys(i.memberPhotos).length]; }", cid_now)
    check(left == [1, 0], f"leaving removes your name and photo from the church {left}")
    c.context.close()
    b.wait_for_function("document.querySelector('#account-btn').dataset.state !== 'synced'", timeout=20000)
    check(True, "a removed member's app falls back to the browser's own copy")
    b.goto(invite)
    b.wait_for_timeout(4000)
    check(b.get_attribute("#account-btn", "data-state") != "synced", "a removed member can't rejoin with the old invite link")

    # 6. Data survives a reload (comes back from the cloud, not localStorage)
    a.reload()
    a.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=20000)
    a.click('[data-tab="ministers"]')
    check(a.locator(".person:has-text('Synced Person')").count() == 1, "the church reloads from the cloud")

    # 7. Signing out returns to this browser's own copy
    a.click("#account-btn")
    a.click('dialog button[value="signout"]')
    a.wait_for_function("document.querySelector('#account-btn').dataset.state === 'local'", timeout=15000)
    a.click('[data-tab="ministers"]')
    check(a.locator(".person:has-text('Synced Person')").count() == 0, "signed out, the browser shows its local copy again")

    browser.close()

# 8. Security rules: an outsider who knows the church id can't read it
req = urllib.request.Request(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key",
    data=json.dumps({"email": "outsider@example.com", "password": "secret123", "returnSecureToken": True}).encode(),
    headers={"Content-Type": "application/json"})
token = json.loads(urllib.request.urlopen(req).read())["idToken"]
cid = invite.split("#join=")[1]
bad = urllib.request.Request(f"http://127.0.0.1:8085/v1/projects/{PROJECT}/databases/(default)/documents/churches/{cid}/people",
                             headers={"Authorization": f"Bearer {token}"})
try:
    urllib.request.urlopen(bad)
    denied = False
except urllib.error.HTTPError as e:
    denied = e.code == 403
check(denied, "an outsider who is not a member is refused by the rules")

check(not errors, f"no page errors {errors}")
print("ALL PASSED")
