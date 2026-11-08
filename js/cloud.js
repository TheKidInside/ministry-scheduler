// Firebase: sign-in, the church a user belongs to, and FirebaseStore (the same Store
// interface as LocalStore in store.js). Loaded lazily so the app still works offline
// and signed out, exactly as before, from localStorage.
//
// Firestore layout (rules in firestore.rules):
//   users/{uid}                          { churchId }
//   churches/{churchId}                  { name, settings, members: {uid: 'admin'|'editor'}, memberNames: {uid: name} }
//   churches/{churchId}/{roles|people|series|services}/{docId}

import { firebaseConfig } from './firebase-config.js';
import { normalizeState } from './model.js';
import { COLLECTIONS } from './store.js';

const V = '10.12.2';
let fb = null;   // { app, auth, db, A: auth module, F: firestore module }

export const cloudConfigured = () => Boolean(firebaseConfig && firebaseConfig.apiKey);

export async function cloud() {
  if (fb) return fb;
  if (!cloudConfigured()) throw new Error('Firebase is not set up for this app yet.');
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  let db;
  try {
    // Offline cache: edits made with no signal are kept and sent when the phone reconnects.
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    db = F.getFirestore(app);
  }
  const auth = A.getAuth(app);
  if (firebaseConfig.emulator) { // tests only: the local Firebase emulators (see tests/cloud_e2e.py)
    A.connectAuthEmulator(auth, firebaseConfig.emulator.auth, { disableWarnings: true });
    F.connectFirestoreEmulator(db, ...firebaseConfig.emulator.firestore);
  }
  await A.setPersistence(auth, A.browserLocalPersistence).catch(() => {});
  fb = { app, auth, db, A, F };
  return fb;
}

// ---------- auth ----------

export async function onAuth(callback) {
  const { auth, A } = await cloud();
  try { await A.getRedirectResult(auth); } catch { /* a failed redirect just leaves you signed out */ }
  return A.onAuthStateChanged(auth, callback);
}

export async function signInGoogle() {
  const { auth, A } = await cloud();
  const provider = new A.GoogleAuthProvider();
  try {
    return (await A.signInWithPopup(auth, provider)).user;
  } catch (err) {
    // Popups are blocked in some in-app browsers and installed PWAs: fall back to a redirect.
    if (/popup-blocked|operation-not-supported|cancelled-popup/.test(err.code || '')) return A.signInWithRedirect(auth, provider);
    throw err;
  }
}

export async function signInEmail(email, password, create) {
  const { auth, A } = await cloud();
  const fn = create ? A.createUserWithEmailAndPassword : A.signInWithEmailAndPassword;
  return (await fn(auth, email, password)).user;
}

export async function resetPassword(email) {
  const { auth, A } = await cloud();
  return A.sendPasswordResetEmail(auth, email);
}

export async function signOut() {
  const { auth, A } = await cloud();
  return A.signOut(auth);
}

export function authMessage(err) {
  const code = (err && err.code) || '';
  const map = {
    'auth/invalid-credential': 'That email and password don\'t match an account.',
    'auth/wrong-password': 'That password is not right.',
    'auth/user-not-found': 'No account uses that email. Choose "Create account" instead.',
    'auth/email-already-in-use': 'An account already uses that email. Sign in instead.',
    'auth/weak-password': 'Use at least 6 characters for the password.',
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/popup-closed-by-user': 'The Google window was closed before signing in.',
    'auth/operation-not-allowed': 'This sign-in method is not switched on for the app yet.',
    'auth/network-request-failed': 'No connection. Try again when you are online.',
    'auth/unauthorized-domain': 'This web address is not allowed to sign in yet.',
  };
  return map[code] || (err && err.message) || 'Something went wrong signing in.';
}

const displayName = user => user.displayName || (user.email ? user.email.split('@')[0] : 'Member');

// ---------- churches ----------

export async function myChurchId(uid) {
  const { db, F } = await cloud();
  const snap = await F.getDoc(F.doc(db, 'users', uid));
  return snap.exists() ? snap.data().churchId || '' : '';
}

// Upload this browser's schedule as a new church, with you as its admin.
export async function createChurch(user, state) {
  const { db, F } = await cloud();
  const ref = F.doc(F.collection(db, 'churches'));
  await F.setDoc(ref, {
    name: state.settings.churchName,
    settings: state.settings,
    members: { [user.uid]: 'admin' },
    memberNames: { [user.uid]: displayName(user) },
    createdAt: F.serverTimestamp(),
  });
  await F.setDoc(F.doc(db, 'users', user.uid), { churchId: ref.id });
  const store = new FirebaseStore(ref.id);
  await store.replaceAll(state, { wait: true });
  return ref.id;
}

// Accept an invite link: add yourself as an editor. Rules only allow adding your own uid,
// and refuse anyone an admin removed.
export async function joinChurch(user, churchId) {
  const { db, F } = await cloud();
  const ref = F.doc(db, 'churches', churchId);
  // Only members can read the church, so a successful read means you're already in it.
  // Skipping the write matters for an admin: writing 'editor' would demote them.
  const already = await F.getDoc(ref).then(s => s.exists(), () => false);
  if (!already) {
    try {
      await F.updateDoc(ref, {
        [`members.${user.uid}`]: 'editor',
        [`memberNames.${user.uid}`]: displayName(user),
      });
    } catch (err) {
      if (/permission-denied|not-found/.test(err.code || '')) {
        throw new Error('That invite link is not valid, or you were removed from that church.');
      }
      throw err;
    }
  }
  await F.setDoc(F.doc(db, 'users', user.uid), { churchId });
  return churchId;
}

// Forget which church you're in; with a churchId, also take yourself off its member list.
export async function leaveChurch(uid, churchId = '') {
  const { db, F } = await cloud();
  if (churchId) {
    await F.updateDoc(F.doc(db, 'churches', churchId), {
      [`members.${uid}`]: F.deleteField(),
      [`memberNames.${uid}`]: F.deleteField(),
    });
  }
  await F.setDoc(F.doc(db, 'users', uid), { churchId: '' });
}

export async function churchInfo(churchId) {
  const { db, F } = await cloud();
  const snap = await F.getDoc(F.doc(db, 'churches', churchId));
  if (!snap.exists()) return null;
  const d = snap.data();
  return { id: churchId, name: d.name, members: d.members || {}, memberNames: d.memberNames || {} };
}

// Admin only (enforced by the rules). A removed person is also listed in `removed`,
// so the same invite link can't bring them back.
export async function removeMember(churchId, uid) {
  const { db, F } = await cloud();
  await F.updateDoc(F.doc(db, 'churches', churchId), {
    [`members.${uid}`]: F.deleteField(),
    [`memberNames.${uid}`]: F.deleteField(),
    [`removed.${uid}`]: true,
  });
}

export async function setRole(churchId, uid, role) {
  const { db, F } = await cloud();
  await F.updateDoc(F.doc(db, 'churches', churchId), { [`members.${uid}`]: role });
}

// ---------- the store ----------

// Writes are sent without waiting for the server: Firestore applies them locally at once
// and queues them while offline. A refused write (no permission, quota) is reported
// through onError so the app can tell you.
export class FirebaseStore {
  constructor(churchId, { onError } = {}) {
    this.churchId = churchId;
    this.onError = onError || (() => {});
    this.state = null;
  }

  _col(F, db, name) { return F.collection(db, 'churches', this.churchId, name); }

  _send(promise) {
    promise.catch(err => this.onError(err));
    return true;
  }

  async load() {
    const { db, F } = await cloud();
    const church = await F.getDoc(F.doc(db, 'churches', this.churchId));
    if (!church.exists()) throw Object.assign(new Error('This church no longer exists.'), { code: 'not-found' });
    const parts = await Promise.all(COLLECTIONS.map(c => F.getDocs(this._col(F, db, c))));
    const raw = { settings: church.data().settings || {} };
    COLLECTIONS.forEach((c, i) => { raw[c] = parts[i].docs.map(d => d.data()); });
    if (!raw.roles.length) delete raw.roles; // a brand-new church gets the default roles
    this.state = normalizeState(raw);
    return structuredClone(this.state);
  }

  async putDoc(collection, doc) {
    const { db, F } = await cloud();
    return this._send(F.setDoc(F.doc(this._col(F, db, collection), doc.id), doc));
  }

  async deleteDoc(collection, id) {
    const { db, F } = await cloud();
    return this._send(F.deleteDoc(F.doc(this._col(F, db, collection), id)));
  }

  async putSettings(settings) {
    const { db, F } = await cloud();
    return this._send(F.updateDoc(F.doc(db, 'churches', this.churchId), { settings, name: settings.churchName }));
  }

  // Make the cloud match `state` exactly: set every doc, delete the ones that are gone.
  async replaceAll(state, { wait = false } = {}) {
    const { db, F } = await cloud();
    const next = normalizeState(structuredClone(state));
    const ops = [];
    for (const c of COLLECTIONS) {
      const existing = await F.getDocs(this._col(F, db, c));
      const keep = new Set(next[c].map(d => d.id));
      existing.docs.forEach(d => { if (!keep.has(d.id)) ops.push(b => b.delete(d.ref)); });
      next[c].forEach(d => ops.push(b => b.set(F.doc(this._col(F, db, c), d.id), d)));
    }
    ops.push(b => b.update(F.doc(db, 'churches', this.churchId), { settings: next.settings, name: next.settings.churchName }));
    const commits = [];
    for (let i = 0; i < ops.length; i += 450) { // Firestore allows 500 writes per batch
      const batch = F.writeBatch(db);
      ops.slice(i, i + 450).forEach(op => op(batch));
      commits.push(batch.commit());
    }
    this.state = next;
    if (wait) { await Promise.all(commits); return true; }
    commits.forEach(p => this._send(p));
    return true;
  }

  // Live updates from every device signed in to this church.
  subscribe(callback) {
    let stop = [];
    let cancelled = false;
    cloud().then(({ db, F }) => {
      if (cancelled) return;
      const parts = { settings: null };
      const ready = new Set();
      const emit = () => {
        if (ready.size < COLLECTIONS.length + 1) return;
        const raw = { ...parts };
        if (!raw.roles.length) delete raw.roles;
        try {
          this.state = normalizeState(raw);
          callback(structuredClone(this.state));
        } catch (err) { this.onError(err); }
      };
      stop.push(F.onSnapshot(F.doc(db, 'churches', this.churchId), snap => {
        parts.settings = snap.exists() ? snap.data().settings || {} : {};
        ready.add('church');
        emit();
      }, err => this.onError(err)));
      for (const c of COLLECTIONS) {
        stop.push(F.onSnapshot(this._col(F, db, c), snap => {
          parts[c] = snap.docs.map(d => d.data());
          ready.add(c);
          emit();
        }, err => this.onError(err)));
      }
    });
    return () => { cancelled = true; stop.forEach(fn => fn()); stop = []; };
  }
}
