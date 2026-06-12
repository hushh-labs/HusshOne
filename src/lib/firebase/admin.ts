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

/**
 * Mint a Firebase custom token so a LinkedIn-OAuth'd member becomes a normal
 * Firebase session — the rest of the app (verifyOneRequest, the 6 authed routes,
 * the firebaseUid DB key, recovery) keeps working unchanged. `uid` is "linkedin:<sub>".
 * The `email` is attached as a CUSTOM CLAIM because an ID token minted from a custom
 * token has no `email` by default, and the research route checks email === verifiedEmail.
 * Requires the service account to have the "Service Account Token Creator" role.
 */
export async function createOneCustomToken(uid: string, claims: { email?: string; name?: string }): Promise<string> {
  const app = initializeFirebaseAdmin();
  const developerClaims: Record<string, string> = {};
  if (claims.email) developerClaims.email = claims.email;
  if (claims.name) developerClaims.name = claims.name;
  return getAuth(app).createCustomToken(uid, developerClaims);
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
