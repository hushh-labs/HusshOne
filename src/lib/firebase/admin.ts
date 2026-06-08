import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function initializeFirebaseAdmin() {
  const existing = getApps()[0];
  if (existing) return existing;

  const rawCredentials = process.env.FIREBASE_ADMIN_CREDENTIALS_JSON?.trim();
  if (rawCredentials) {
    const credentials = JSON.parse(rawCredentials) as {
      project_id: string;
      client_email: string;
      private_key: string;
    };
    return initializeApp({
      credential: cert({
        projectId: credentials.project_id,
        clientEmail: credentials.client_email,
        privateKey: credentials.private_key,
      }),
    });
  }

  return initializeApp({ credential: applicationDefault() });
}

export async function verifyFirebaseIdToken(idToken: string) {
  const app = initializeFirebaseAdmin();
  return getAuth(app).verifyIdToken(idToken, true);
}

// Invalidate every existing session for this user (so a deleted account can't
// keep acting on an already-issued ID token). Best-effort: a missing user is fine.
export async function revokeFirebaseTokens(uid: string): Promise<void> {
  try {
    await getAuth(initializeFirebaseAdmin()).revokeRefreshTokens(uid);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") return;
    throw error;
  }
}

// Remove the Firebase Auth user entirely (full account deletion). Idempotent:
// deleting an already-gone user resolves silently.
export async function deleteFirebaseUser(uid: string): Promise<void> {
  try {
    await getAuth(initializeFirebaseAdmin()).deleteUser(uid);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") return;
    throw error;
  }
}
