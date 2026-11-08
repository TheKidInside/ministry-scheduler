"""Cloud sync test against the local Firebase emulators, through the real UI.

Two people on two browsers: Pastor creates an account, puts the schedule online and
copies the invite link; Leader joins with it; an edit by one appears live for the other;
the security rules refuse an outsider. firebase-config.js is swapped (in the browser
only) for an emulator config, so no real project is touched.

Usage:
  firebase emulators:start --only auth,firestore --project demo-ministry   (from the app folder)
  py -3 tests\\cloud_e2e.py [base_url]
"""
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
    b.wait_for_selector(".matrix tbody tr")
    check(b.locator(".matrix tbody tr").count() == rows_a, "the leader sees the same services as the pastor")

    # 3. A change on the phone shows up live on the pastor's screen
    b.locator(".matrix tbody tr").first.click()
    b.fill('dialog input[name="sermon-title"]', "Live From The Phone")
    b.click('dialog .dialog-actions button[value="save"]')
    a.click('[data-tab="preaching"]')
    a.wait_for_selector(".folio:has-text('Live From The Phone')", timeout=15000)
    check(True, "an edit on one device appears live on the other")

    # 4. ...and the pastor's edit reaches the phone
    a.click('[data-tab="ministers"]')
    a.click('[data-action="new-person"]')
    a.fill('dialog input[name="name"]', "Synced Person")
    a.fill('dialog input[name="email"]', "Leader@Example.com")
    a.click('dialog .dialog-actions button[value="save"]')
    b.click('[data-tab="ministers"]')
    b.wait_for_selector(".person:has-text('Synced Person')", timeout=15000)
    check(True, "a new minister reaches the other device")

    # 4b. The pastor puts that minister (linked to the leader by email) on a service:
    #     the pastor is offered a message to send, and the leader's bell lights up live
    check(b.is_visible("#mine-btn") and not b.is_visible("#mine-btn .bell-count"), "signed in to a church, the bell shows with nothing new")
    a.click('[data-tab="schedule"]')
    a.click('[data-action="next"]')  # next month, so the service is still upcoming
    a.locator(".matrix tbody tr").first.click()
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

    # 5. Members list shows both; leader is an editor
    a.click("#account-btn")
    a.wait_for_selector("dialog[open] .members li:nth-child(2)", timeout=15000)
    members = a.inner_text("dialog .members").lower()
    check("editor" in members and "leader" in members, "the pastor sees the leader as an editor")
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
    a.wait_for_function("document.querySelectorAll('dialog .members li').length === 1", timeout=15000)
    a.click('dialog .dialog-actions button[value="cancel"]')
    b.click('[data-tab="schedule"]')
    b.locator(".matrix tbody tr").first.click()
    b.fill('dialog input[name="sermon-title"]', "After Removal")
    b.click('dialog .dialog-actions button[value="save"]')
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
