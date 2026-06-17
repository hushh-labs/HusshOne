import { verifyFirebaseIdToken } from "@/lib/firebase/admin";

export interface VerifiedOneUser {
  uid: string;
  email: string;
  name: string | null;
  picture: string | null;
  provider?: string | null;
}

export type OneAuthProvider = "guest" | "dev" | "google";

function bearerToken(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) return "";
  return authHeader.slice("Bearer ".length).trim();
}

export async function verifyOneRequest(authHeader: string | null): Promise<VerifiedOneUser> {
  const token = bearerToken(authHeader);
  if (!token) {
    throw Object.assign(new Error("Missing authorization header"), { statusCode: 401 });
  }

  if (process.env.ONE_ENABLE_DEV_AUTH === "true" && token === "DEV_TOKEN") {
    return {
      uid: "dev-one-user",
      email: "dev.one@hushh.ai",
      name: "One Preview",
      picture: null,
      provider: "dev",
    };
  }

  try {
    const decoded = await verifyFirebaseIdToken(token);
    const email = typeof decoded.email === "string" ? decoded.email.toLowerCase() : "";
    if (!email) {
      throw Object.assign(new Error("Account did not return an email"), { statusCode: 400 });
    }
    return {
      uid: decoded.uid,
      email,
      name: typeof decoded.name === "string" ? decoded.name : null,
      picture: typeof decoded.picture === "string" ? decoded.picture : null,
      provider: typeof decoded.provider === "string" ? decoded.provider : null,
    };
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw Object.assign(new Error("Invalid Firebase session"), { statusCode: 401 });
  }
}

export function isGuestOneUser(user: Pick<VerifiedOneUser, "uid" | "provider">): boolean {
  return user.provider === "guest" || user.uid.startsWith("guest:");
}

export function oneUserProvider(user: Pick<VerifiedOneUser, "uid" | "provider">): OneAuthProvider {
  if (isGuestOneUser(user)) return "guest";
  if (user.provider === "dev" || user.uid === "dev-one-user") return "dev";
  return "google";
}
