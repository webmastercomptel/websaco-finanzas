// src/common/firebase/firebase.constants.ts

/** DI token for the shared Firebase Auth instance. */
export const FIREBASE_AUTH = 'FIREBASE_AUTH';

/**
 * DI token for the shared Firebase `App` itself — the thing every other
 * Firebase-backed service (Auth today, Storage from `common/storage/`) is
 * built from. Exposed separately from `FIREBASE_AUTH` so a second consumer
 * can share the same initialized app instead of re-running
 * `getApps()[0] ?? initializeApp(...)` a second time, which throws.
 */
export const FIREBASE_APP = 'FIREBASE_APP';
