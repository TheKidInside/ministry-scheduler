# Firebase sync

Signed out, the app works as it always did: everything is saved in this browser
(`LocalStore`). Signed in to a church, the same screens read and write Firestore
(`FirebaseStore` in [js/cloud.js](../js/cloud.js)) and every device in that church
sees changes live. The views don't know which store they're using.

## How people use it

1. **The first person** (say the pastor) taps the account button at the bottom of the
   sidebar (on a phone, the round button at the top right) and signs in with Google or
   email. They then choose **Put it online**, which uploads what their browser holds
   and makes them the church's **admin**.
2. They **copy the invite link** (`…#join=<churchId>`) from the same dialog and send it to
   the team.
3. **Each team member** opens the link, signs in, and lands in the same church as an
   **member** (stored as `editor`). Members can see everything. Only **admins** can change
   the schedule, ministers, series, tasks, roles and settings, or remove members. An admin
   can make someone else an admin from the account sheet. A member assigned to preach a
   service can edit that service's sermon: title, scripture and series. Anyone set up as
   a Worship Leader or on Tech can edit any service's songs. The first sign-in asks for your name, and from then on your
   minister's name follows it.
4. **Signing out** returns that browser to its own local copy. The church stays online.

Anyone holding the invite link can join, so it should only go to the ministry team.

## Firestore layout

```
users/{uid}                              { churchId, seen[], name }         your church (one per account); the assignments you've opened; the name you chose
churches/{churchId}                      { name, settings, members: {uid: 'admin'|'editor'}, memberNames: {uid: name} }
churches/{churchId}/roles/{roleId}       { name, slots, order }
churches/{churchId}/people/{personId}    { name, contact, email, roleIds[], unavailable[] }
churches/{churchId}/series/{seriesId}    { name, color, start, end, description }
churches/{churchId}/services/{serviceId} { date, time, name, assignments{}, sermon{}, setlist[], notes }
churches/{churchId}/tasks/{taskId}       { week, title, assignees[], notes, done }
```

**A new collection's rule goes live before its code.** The app reads every collection when a church opens, and treats a refused *read* as "you were removed", which signs that person out of their church. So run `firebase deploy --only firestore:rules` first, then push. Pushing to `main` deploys GitHub Pages straight away.

**Tightening who can write goes the other way: code first, then rules.** A refused *write* now only shows a message, but versions before this change treated it as "you were removed" too. A browser still running one would be dropped from the church.

## Store methods → Firestore

| Store method | Firestore |
|---|---|
| `load()` | `getDoc` on the church + `getDocs` on the 4 collections |
| `putDoc(col, doc)` | `setDoc`, without waiting for the server |
| `patchDoc(col, id, fields)` | `updateDoc` on only those fields, without waiting |
| `deleteDoc(col, id)` | `deleteDoc`, without waiting |
| `putSettings(s)` | `updateDoc(church, { settings, name })` |
| `replaceAll(state)` | `writeBatch` (450 ops a batch): set everything, delete what's gone |
| `subscribe(cb)` | `onSnapshot` on the church + 4 collections; calls back once all 5 have arrived |

Writes are not awaited. Firestore shows them on screen at once and queues them while
offline (persistent cache). A refused write goes to `onError` marked `'write'`, which shows a toast.
Only a refused read means you were removed.

## Security rules

[firestore.rules](../firestore.rules):
- **Members** read the church's five collections.
- **Admins** are the only ones who write them, or change the settings or `members`.
- **A Worship Leader or Tech** may change only `setlist` (up to 30 songs) on any service. The save names their minister and role in `setlistBy` and `setlistRole`. The rules confirm that minister is them, holds that role, and that the role's name starts with "Worship Lead" or "Tech".
- **A preacher** may change only `sermon` on a service where `assignments.preacher` (its first three places) is them.
- **Your own minister**: you may change its `name` and `photo`. An invite or your sign-in email can link you to a minister nobody has claimed, unless someone else's email is on it, and you can add your own email to a minister already linked to you.
- **A non-member** may make one change only: adding *their own* uid as `editor`. That is the invite join.
- **`users/{uid}`** is readable and writable only by that user.

Members can't forge their way past this, with one known limit: being "them" is judged by the linked account or the sign-in email, and email sign-ups aren't verified. Someone already in the church could sign up with a preacher's email, or claim an unlinked minister with no email on file, and edit that minister's sermons, name and photo. It goes no further than that.

`tests/cloud_e2e.py` checks that an outsider is refused, and tries each of these writes as a plain member and as a preacher.

## Testing without touching the real project

```
firebase emulators:start --only auth,firestore --project demo-ministry
py -3 tests\cloud_e2e.py http://localhost:8795/
```

The test swaps `js/firebase-config.js` (in the browser only) for an emulator config. It
then drives two browsers, one of them an iPhone profile, through these steps: sign up,
put the schedule online, invite, join, live edits both ways, members list, reload,
sign out, and an outsider being refused.

## The live project

- **Project:** `ministry-sched-ph` (console: https://console.firebase.google.com/project/ministry-sched-ph). Firestore is in `asia-southeast1` (Singapore), the closest region to the Philippines. The region cannot be changed.
- **App URLs:** https://ministry-sched-ph.web.app (Firebase Hosting, recommended for phones because its origin matches `authDomain`, so Google sign-in works on iPhones) and https://thekidinside.github.io/ministry-scheduler/ (GitHub Pages, push = deploy).
- **Sign-in:** email/password and Google, both switched on by `firebase deploy --only auth` (the `auth.providers` block in `firebase.json`). Authorised domains: the two Firebase domains plus `thekidinside.github.io`. `localhost` is not authorised, so test real sign-in on a deployed URL, or use the emulators.
- **Deploy:** `firebase deploy --only hosting,firestore:rules,auth` from this folder (`.firebaserc` points at the project). GitHub Pages updates on push.
- `js/firebase-config.js` holds the public web config. Setting it back to `null` switches sync off.

## Later

- Cloud Function reminders (push, email, or Messenger/Viber via a bot) a few days before someone serves. Needs the Blaze plan. Today, the bell in the app and the "Let them know" share buttons cover notifications with no server.
- Accept/decline per assignment: `assignments` values become `{ personId, status }`.
- Ministers submitting their own away dates.
