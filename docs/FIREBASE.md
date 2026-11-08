# Firebase plan

The app already talks to storage only through the `Store` interface in
[js/store.js](../js/store.js). Adding Firebase means writing a `FirebaseStore` class
with the same methods and returning it from `createStore()`. The views don't change.

## 1. Firestore layout

```
churches/{churchId}                      settings fields + members: { uid: 'admin' | 'editor' | 'viewer' }
churches/{churchId}/roles/{roleId}       { name, slots, order }
churches/{churchId}/people/{personId}    { name, contact, roleIds[], unavailable[], uid? }
churches/{churchId}/series/{seriesId}    { name, color, start, end, description }
churches/{churchId}/services/{serviceId} { date, time, name, assignments{}, sermon{}, notes }
```

A church is the unit of sharing, so the pastor, worship leader and tech lead all
edit the same schedule. `people.uid` (optional) links a minister to a login, which
later enables a "My schedule" view and accept/decline.

## 2. Method mapping

| Store method | Firestore call |
|---|---|
| `load()` | `getDocs` on the 4 collections + `getDoc` on the church doc, sort roles by `order` |
| `putDoc(col, doc)` | `setDoc(doc(db, 'churches', id, col, doc.id), doc)` |
| `deleteDoc(col, id)` | `deleteDoc(...)` |
| `putSettings(s)` | `setDoc(churchRef, { settings: s }, { merge: true })` |
| `replaceAll(state)` | `writeBatch`: delete what's gone, set the rest (≤ 500 ops per batch) |
| `subscribe(cb)` | `onSnapshot` on each collection; rebuild state, call `cb(state)` |

Writes can fail when offline or when permission is denied. In `FirebaseStore`, catch
the error, return `false`, and let `afterWrite()` in app.js show the warning.
Firestore's offline persistence (`persistentLocalCache`) queues writes while
offline.

## 3. Security rules (starting point)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function role(churchId) {
      return get(/databases/$(db)/documents/churches/$(churchId)).data.members[request.auth.uid];
    }
    match /churches/{churchId} {
      allow read: if request.auth != null && role(churchId) != null;
      allow write: if request.auth != null && role(churchId) == 'admin';
      match /{col}/{docId} {
        allow read: if request.auth != null && role(churchId) != null;
        allow write: if request.auth != null && role(churchId) in ['admin', 'editor'];
      }
    }
  }
}
```

## 4. Steps

1. Create a Firebase project and add a Web app. Turn on Firestore and Google sign-in.
2. Add the GitHub Pages domain (`thekidinside.github.io`) under Auth → Authorized domains. For a better iOS sign-in experience, host on Firebase Hosting instead, so the app's origin matches `authDomain`.
3. Load the modular SDK from the CDN in `store.js` (no build step needed).
4. Write `FirebaseStore`, then switch `createStore()` to it when the user is signed in.
5. One-time migration: on first sign-in, if localStorage has data and the church has none, offer "Upload this browser's schedule" (call `replaceAll`).
6. Add a sign-in button and church picker to the header.

## 5. After Firebase

- Cloud Function reminders (email, or Messenger/Viber via a bot) a few days before someone serves.
- Accept/decline per assignment (`assignments` values become `{ personId, status }`).
- Blockout requests submitted by the ministers themselves.
