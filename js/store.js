// Storage layer. The app only ever talks to the Store interface below, so swapping
// localStorage for Firebase later means writing one new class, not touching the views.
//
// Store interface (all async):
//   load()                    -> full state { settings, roles, people, series, services, tasks }
//   putDoc(collection, doc)   -> insert or replace one doc by doc.id
//   deleteDoc(collection, id) -> remove one doc
//   putSettings(settings)     -> replace the settings object
//   replaceAll(state)         -> overwrite everything (import / reset)
//   subscribe(callback)       -> callback(state) when data changes elsewhere; returns unsubscribe
//
// Collections: roles, people, series, services, tasks. In Firestore these become
// churches/{churchId}/{collection}/{docId}, with settings at churches/{churchId}.
// See docs/FIREBASE.md.

import { emptyState, normalizeState } from './model.js';

export const COLLECTIONS = ['roles', 'people', 'series', 'services', 'tasks'];
const KEY = 'ministry-scheduler:v1';

export class LocalStore {
  constructor(storage = globalThis.localStorage, key = KEY) {
    this.storage = storage;
    this.key = key;
    this.state = null;
  }

  async load() {
    let raw = null;
    try { raw = this.storage.getItem(this.key); } catch { /* storage blocked: run in memory */ }
    if (raw) {
      try { this.state = normalizeState(JSON.parse(raw)); } catch { this.state = null; }
    }
    if (!this.state) this.state = emptyState();
    return structuredClone(this.state);
  }

  // Returns true if the browser kept the data. False = private window / storage full;
  // the app keeps working in memory and warns the user.
  _persist() {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.state));
      return true;
    } catch {
      return false;
    }
  }

  async putDoc(collection, doc) {
    this._check(collection);
    const list = this.state[collection];
    const i = list.findIndex(d => d.id === doc.id);
    if (i >= 0) list[i] = structuredClone(doc); else list.push(structuredClone(doc));
    return this._persist();
  }

  async deleteDoc(collection, id) {
    this._check(collection);
    this.state[collection] = this.state[collection].filter(d => d.id !== id);
    return this._persist();
  }

  async putSettings(settings) {
    this.state.settings = structuredClone(settings);
    return this._persist();
  }

  async replaceAll(state) {
    this.state = normalizeState(structuredClone(state));
    return this._persist();
  }

  // Another tab saved: hand the fresh state to the app.
  subscribe(callback) {
    const onStorage = e => {
      if (e.key !== this.key || !e.newValue) return;
      try {
        this.state = normalizeState(JSON.parse(e.newValue));
        callback(structuredClone(this.state));
      } catch { /* ignore a malformed write */ }
    };
    globalThis.addEventListener?.('storage', onStorage);
    return () => globalThis.removeEventListener?.('storage', onStorage);
  }

  _check(collection) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
  }
}

// Placeholder so the wiring point is obvious. Implement the same methods with the
// Firebase modular SDK (see docs/FIREBASE.md), then pick it in createStore().
export class FirebaseStore {
  constructor() {
    throw new Error('Firebase sync is not set up yet. See docs/FIREBASE.md.');
  }
}

export function createStore() {
  return new LocalStore();
}
