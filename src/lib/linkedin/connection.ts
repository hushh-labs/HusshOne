/** Persistence helpers for the user's connected LinkedIn profile (the URL-paste scraper
    flow). Neutral home — replaces the retired mcp-route.ts. */
import { NextResponse } from "next/server";
import type { VerifiedOneUser } from "@/lib/auth/verify";
import type { LinkedInProfileFull } from "./profile";
import { upsertOneUser, upsertLinkedInConnection, getLinkedInConnection } from "@/lib/db/scan-store";

/** Map a thrown error (verifyOneRequest attaches statusCode) to a JSON error response. */
export function linkedinErrorResponse(error: unknown) {
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "LinkedIn request failed";
  return NextResponse.json({ ok: false, error: message }, { status });
}

/** Persist a freshly mapped profile: ensure the OneUser row exists (stamping the LinkedIn
    photo) and upsert the 1:1 LinkedInConnection. Best-effort — DB failures (incl. an
    unmigrated table) must never fail the enrich call, so each write swallows its own errors. */
export async function persistConnectedProfile(verified: VerifiedOneUser, mapped: LinkedInProfileFull) {
  await upsertOneUser({
    firebaseUid: verified.uid,
    email: verified.email,
    name: mapped.name || verified.name,
    photoUrl: mapped.pictureUrl ?? verified.picture,
  }).catch(() => null);
  await upsertLinkedInConnection(verified.uid, mapped).catch(() => null);
}

/** The user's persisted connected profile (from the LinkedInConnection table), or null. */
export async function getConnectedProfile(firebaseUid: string): Promise<LinkedInProfileFull | null> {
  return getLinkedInConnection(firebaseUid);
}
