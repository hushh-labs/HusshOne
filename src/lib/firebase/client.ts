import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type Unsubscribe,
  type User,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseClientConfigured() {
  return Object.values(firebaseConfig).every((value) => typeof value === "string" && value.trim());
}

function getFirebaseApp(): FirebaseApp {
  if (!isFirebaseClientConfigured()) {
    throw new Error("Firebase client is not configured");
  }
  return getApps()[0] ?? initializeApp(firebaseConfig);
}

// Firebase already defaults to browserLocalPersistence, but we pin it
// explicitly (cached) so a signed-in session reliably survives a page refresh.
let persistenceReady: Promise<void> | null = null;
function ensurePersistence(auth: Auth): Promise<void> {
  if (!persistenceReady) {
    persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => undefined);
  }
  return persistenceReady;
}

/**
 * Subscribe to Firebase auth state. Fires once on load with the restored user
 * (or null) after Firebase reads its persisted session — this is how the app
 * rehydrates a signed-in user on refresh WITHOUT re-showing the Google popup.
 */
export function observeAuth(onChange: (user: User | null) => void): Unsubscribe {
  if (!isFirebaseClientConfigured()) {
    onChange(null);
    return () => undefined;
  }
  const auth = getAuth(getFirebaseApp());
  void ensurePersistence(auth);
  return onAuthStateChanged(auth, onChange);
}

// Mobile browsers handle the Firebase popup credential relay poorly — it can fail with
// auth/missing-or-invalid-nonce ("Duplicate credential received"). Firebase recommends
// the redirect flow on mobile, so we use it there (and as a fallback when a desktop
// popup fails for a storage/nonce/popup reason).
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
}

const POPUP_FALLBACK_CODES = new Set([
  "auth/missing-or-invalid-nonce",
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
  "auth/internal-error",
]);
function authErrorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
}

function googleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

/**
 * Start Google sign-in. On desktop this resolves with the signed-in user (popup). On
 * mobile — and as a fallback when the popup flow fails with a storage/nonce error — it
 * starts a full-page redirect and never resolves on this page (the browser navigates
 * away); the result is completed on the next load via completeGoogleRedirect().
 * Returns null when a redirect was started (no user is available on this page yet).
 */
export async function signInWithGoogle(): Promise<User | null> {
  const auth = getAuth(getFirebaseApp());
  await ensurePersistence(auth);

  if (isMobileBrowser()) {
    await signInWithRedirect(auth, googleProvider());
    return null;
  }
  try {
    const result = await signInWithPopup(auth, googleProvider());
    return result.user;
  } catch (error) {
    if (POPUP_FALLBACK_CODES.has(authErrorCode(error))) {
      await signInWithRedirect(auth, googleProvider());
      return null;
    }
    throw error;
  }
}

/**
 * Complete a pending mobile redirect sign-in. Call once on load: it processes the
 * returned OAuth credential (signing the user in, which fires onAuthStateChanged) and
 * surfaces any error (e.g. auth/missing-or-invalid-nonce). Returns the user when a
 * redirect just completed, or null when there was no pending redirect.
 */
export async function completeGoogleRedirect(): Promise<User | null> {
  if (!isFirebaseClientConfigured()) return null;
  const auth = getAuth(getFirebaseApp());
  await ensurePersistence(auth);
  const result = await getRedirectResult(auth);
  return result?.user ?? null;
}

export async function signOutOfGoogle() {
  if (!isFirebaseClientConfigured()) return;
  await signOut(getAuth(getFirebaseApp()));
}

export async function getFirebaseBearer(user: User | null) {
  if (!user) return "";
  const token = await user.getIdToken();
  return `Bearer ${token}`;
}

export function makeDevUser(): Pick<User, "uid" | "email" | "displayName" | "photoURL" | "getIdToken"> {
  return {
    uid: "dev-one-user",
    email: "dev.one@hushh.ai",
    displayName: "One Preview",
    photoURL: null,
    getIdToken: async () => "DEV_TOKEN",
  };
}
