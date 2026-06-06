import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
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

export async function signInWithGoogle() {
  const auth = getAuth(getFirebaseApp());
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
