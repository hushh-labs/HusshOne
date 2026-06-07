import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
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

export async function signInWithGoogle() {
  const auth = getAuth(getFirebaseApp());
  await ensurePersistence(auth);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user;
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
