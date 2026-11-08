"""Cloud sync test against the REAL Firebase project, through the deployed UI.

Same two-browser flow as cloud_e2e.py (desktop pastor + iPhone 13 worship leader), but with
no firebase-config override: the deployed app talks to project ministry-sched-ph. Every
account and church it creates is deleted at the end, pass or fail.

Test accounts are msched-<run_id>-<role>@example.com, so leftovers are easy to spot.
Cleanup uses the Firebase CLI login (firebase firestore:delete) and gapi.py (the CLI's
OAuth token) for the Auth admin API.

Usage:
  py -3 tests\\cloud_live.py <base_url> <run_id> [path_to_gapi_dir]
  e.g. py -3 tests\\cloud_live.py https://ministry-sched-ph.web.app/ r1108a-fh
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://ministry-sched-ph.web.app/"
RUN = sys.argv[2] if len(sys.argv) > 2 else "r1108a"
GAPI_DIR = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("GAPI_DIR", "")
PROJECT = "ministry-sched-ph"
APP_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "Live-test-%s-9x" % RUN
ORIGIN = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(BASE))
API_KEY = re.search(r"apiKey:\s*'([^']+)'", (APP_DIR / "js/firebase-config.js").read_text()).group(1)
FS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"

if GAPI_DIR:
    sys.path.insert(0, GAPI_DIR)
import gapi  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
errors = []
results = []
church_ids = set()


def email(role):
    return f"msched-{RUN}-{role}@example.com"


def check(cond, msg):
    results.append(("ok" if cond else "FAIL", msg))
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg, flush=True)


def browser_page(browser, phone=False):
    ctx = browser.new_context(**(p.devices["iPhone 13"] if phone else {"viewport": {"width": 1366, "height": 900}}))
    try:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
    except Exception:
        pass
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    return page


def sign_up(page, addr):
    page.click("#account-btn")
    page.wait_for_selector("dialog[open] input[name=email]")
    page.fill("dialog input[name=email]", addr)
    page.fill("dialog input[name=password]", PASSWORD)
    page.click('dialog button[value="create"]')
    page.wait_for_function("document.querySelector('#account-btn').dataset.state !== 'local'", timeout=25000)


def rest(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json", "Referer": BASE, **(headers or {})},
                                 method=method)
    try:
        return 200, json.loads(urllib.request.urlopen(req, timeout=30).read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


# ---------------- cleanup ----------------

def fs_delete(path):
    r = subprocess.run(f'firebase firestore:delete "{path}" --recursive --force --project {PROJECT}',
                       shell=True, cwd=str(APP_DIR), capture_output=True, text=True, timeout=180)
    print(f"  cleanup: firestore:delete {path} -> exit {r.returncode}", flush=True)
    return r.returncode == 0


def cleanup():
    print("cleanup ...", flush=True)
    emails = [email(r) for r in ("pastor", "leader", "outsider")]
    looked = gapi.call("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:lookup",
                       {"email": emails}, project=PROJECT)
    uids = [u["localId"] for u in looked.get("users", [])]
    # Churches: the invite's id plus whatever each test user's users/{uid} doc points at.
    for uid in uids:
        doc = gapi.call("GET", f"{FS}/users/{uid}", project=PROJECT)
        cid = doc.get("fields", {}).get("churchId", {}).get("stringValue") if isinstance(doc, dict) else None
        if cid:
            church_ids.add(cid)
    # Also any church that lists a test user as a member (e.g. created but users doc not written).
    listed = gapi.call("GET", f"{FS}/churches?pageSize=300&mask.fieldPaths=members", project=PROJECT)
    for d in listed.get("documents", []):
        members = d.get("fields", {}).get("members", {}).get("mapValue", {}).get("fields", {})
        if set(members) & set(uids):
            church_ids.add(d["name"].rsplit("/", 1)[1])
    for cid in sorted(church_ids):
        fs_delete(f"churches/{cid}")
    for uid in uids:
        fs_delete(f"users/{uid}")
    if uids:
        r = gapi.call("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:batchDelete",
                      {"localIds": uids, "force": True}, project=PROJECT)
        print(f"  cleanup: deleted {len(uids)} auth account(s); errors={r.get('errors') or r.get('error')}", flush=True)
    # Verify
    left = gapi.call("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:query",
                     {"returnUserInfo": True}, project=PROJECT)
    stray = [u.get("email") for u in left.get("userInfo", []) if f"msched-{RUN}" in (u.get("email") or "")]
    still = [cid for cid in church_ids
             if "error" not in gapi.call("GET", f"{FS}/churches/{cid}", project=PROJECT)]
    users_left = [uid for uid in uids if "error" not in gapi.call("GET", f"{FS}/users/{uid}", project=PROJECT)]
    print(f"  cleanup verify: auth accounts left={stray} churches left={still} users docs left={users_left}", flush=True)
    return not stray and not still and not users_left


# ---------------- the flow ----------------

invite = ""
passed = False
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            # 1. Pastor signs up and puts the sample schedule online
            a = browser_page(browser)
            a.goto(BASE)
            a.wait_for_selector(".matrix tbody tr", timeout=30000)
            # The button says "Saved in this browser" until Firebase has loaded, then adds "Sign in to sync".
            a.wait_for_function("document.querySelector('#account-btn').innerText.includes('Sign in')", timeout=30000)
            check("Sign in" in a.inner_text("#account-btn"), "signed out, the app says it is saved in this browser")
            sign_up(a, email("pastor"))
            a.click("#account-btn")
            a.wait_for_selector('dialog[open] button[value="upload"]', timeout=15000)
            a.click('dialog button[value="upload"]')
            a.wait_for_selector("dialog[open] #invite-link", timeout=30000)
            invite = a.input_value("#invite-link")
            church_ids.add(invite.split("#join=")[-1])
            check("#join=" in invite, "putting it online gives an invite link")
            check(invite.startswith(BASE.split("#")[0]), f"the invite link points at this deployment ({invite.split('#')[0]})")
            check("admin" in a.inner_text("dialog .members").lower(), "the pastor is the church admin")
            a.click('dialog .dialog-actions button[value="cancel"]')
            check(a.get_attribute("#account-btn", "data-state") == "synced", "account button shows synced")
            rows_a = a.locator(".matrix tbody tr").count()

            # 2. Leader opens the invite link on a phone, signs up, and lands in the same church
            b = browser_page(browser, phone=True)
            b.goto(invite)
            b.wait_for_selector("dialog[open] input[name=email]", timeout=20000)
            check("accept your invite" in b.inner_text("dialog"), "an invite link asks you to sign in first")
            b.fill("dialog input[name=email]", email("leader"))
            b.fill("dialog input[name=password]", PASSWORD)
            b.click('dialog button[value="create"]')
            b.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=30000)
            b.wait_for_selector(".day-pill")
            b.wait_for_function(f"document.querySelectorAll('.day-pill').length === {rows_a}", timeout=15000)
            check(b.locator(".day-pill").count() == rows_a, f"the leader sees the same services as the pastor ({rows_a})")

            # 3. A change on the phone shows up live on the pastor's screen
            b.locator(".day-card").tap()
            b.fill('dialog input[name="sermon-title"]', "Live From The Phone")
            b.click('dialog .dialog-actions button[value="save"]')
            a.click('[data-tab="preaching"]')
            a.wait_for_selector(".folio:has-text('Live From The Phone')", timeout=20000)
            check(True, "an edit on the phone appears live on the desktop")

            # 4. ...and the pastor's edit reaches the phone
            a.click('[data-tab="ministers"]')
            a.click('[data-action="new-person"]')
            a.fill('dialog input[name="name"]', "Synced Person")
            a.click('dialog .dialog-actions button[value="save"]')
            b.click('[data-tab="ministers"]')
            b.wait_for_selector(".person:has-text('Synced Person')", timeout=20000)
            check(True, "a new minister added on the desktop reaches the phone")

            # 5. Members list shows both; leader is an editor
            a.click("#account-btn")
            a.wait_for_selector("dialog[open] .members li:nth-child(2)", timeout=20000)
            members = a.inner_text("dialog .members").lower()
            check("editor" in members and "leader" in members, "the pastor sees the leader as an editor")
            a.click('dialog .dialog-actions button[value="cancel"]')

            # 5b. The admin opening their own invite link stays admin
            a.goto(invite)
            a.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=25000)
            a.wait_for_timeout(2500)
            a.click("#account-btn")
            a.wait_for_selector("dialog[open] .members li:nth-child(2)", timeout=20000)
            check("admin" in a.locator("dialog .members li", has_text="(you)").inner_text().lower(),
                  "the admin opening their own invite link is still admin")

            # 5c. The admin removes the leader: the phone drops back to its own copy,
            #     and the same invite link can't bring them back
            a.locator("dialog .members li", has_text="leader").locator("[data-remove-member]").click()
            a.wait_for_function("document.querySelectorAll('dialog .members li').length === 1", timeout=20000)
            a.click('dialog .dialog-actions button[value="cancel"]')
            b.click('[data-tab="schedule"]')
            b.locator(".day-card").tap()
            b.fill('dialog input[name="sermon-title"]', "After Removal")
            b.click('dialog .dialog-actions button[value="save"]')
            b.wait_for_function("document.querySelector('#account-btn').dataset.state !== 'synced'", timeout=25000)
            check(True, "a removed member's app falls back to the browser's own copy")
            b.goto(invite)
            b.wait_for_timeout(6000)
            check(b.get_attribute("#account-btn", "data-state") != "synced", "a removed member can't rejoin with the old invite link")

            # 6. Data survives a reload (comes back from the cloud, not localStorage)
            a.reload()
            a.wait_for_function("document.querySelector('#account-btn').dataset.state === 'synced'", timeout=25000)
            a.click('[data-tab="ministers"]')
            a.wait_for_selector(".person:has-text('Synced Person')", timeout=15000)
            check(a.locator(".person:has-text('Synced Person')").count() == 1, "the church reloads from the cloud")

            # 7. Signing out returns to this browser's own copy
            a.click("#account-btn")
            a.click('dialog button[value="signout"]')
            # The button says "Saved in this browser" until Firebase has loaded, then adds "Sign in to sync".
            a.wait_for_function("document.querySelector('#account-btn').innerText.includes('Sign in')", timeout=30000)
            a.click('[data-tab="ministers"]')
            check(a.locator(".person:has-text('Synced Person')").count() == 0, "signed out, the browser shows its local copy again")
        except Exception:
            import traceback; traceback.print_exc()
            try:
                a.screenshot(path=str(APP_DIR / f"tests/live-fail-{RUN}-desktop.png"))
                b.screenshot(path=str(APP_DIR / f"tests/live-fail-{RUN}-phone.png"))
            except Exception:
                pass
            raise
        finally:
            browser.close()

    # 8. Security rules: an outsider who knows the church id can't read it
    code, body = rest(f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}",
                      {"email": email("outsider"), "password": PASSWORD, "returnSecureToken": True})
    check(code == 200, f"outsider account created through the real Auth REST API (HTTP {code})")
    token = body["idToken"]
    cid = invite.split("#join=")[1]
    for path in (f"churches/{cid}", f"churches/{cid}/people"):
        c, _ = rest(f"{FS}/{path}", headers={"Authorization": f"Bearer {token}"})
        check(c == 403, f"an outsider reading {path.replace(cid, '<cid>')} is refused by the rules (HTTP {c})")

    check(not errors, f"no page errors {errors}")
    passed = True
    print("ALL PASSED", flush=True)
finally:
    clean = cleanup()
    print("CLEANUP", "OK" if clean else "INCOMPLETE", flush=True)
    print("RESULT", json.dumps({"base": BASE, "run": RUN, "passed": passed, "cleanup_ok": clean, "checks": results}))
    sys.exit(0 if passed and clean else 1)
