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
