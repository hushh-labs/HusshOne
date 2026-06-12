import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getConnectedProfile, linkedinErrorResponse } from "@/lib/linkedin/connection";

export const runtime = "nodejs";

/** The user's persisted LinkedIn profile (from the URL-paste enrichment). Used by
    hydrateFromUser to rehydrate a returning session and drive the connect gate.
    404 when the user hasn't enriched a profile yet. */
export async function GET(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const profile = await getConnectedProfile(verified.uid);
    if (!profile) return NextResponse.json({ ok: false, error: "LinkedIn is not connected." }, { status: 404 });
    return NextResponse.json({ ok: true, profile });
  } catch (error) {
    return linkedinErrorResponse(error);
  }
}
